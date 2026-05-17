/**
 * N-PORT API ROUTES (PLAN_NPORT_HOLDINGS.md §7.1)
 *
 * Mounted by nport/api/server.js as:
 *   const nportRoutes = require('./routes/nport');
 *   app.use('/api/nport', nportRoutes);
 *
 * Conventions:
 *   - async/await + try/catch
 *   - errors return { error: string, code: string }
 *   - snake_case DB columns, snake_case in JSON (mirrors DB exactly)
 *
 * Bug 5 fix — every query in this file targets a table/view that ACTUALLY
 * exists per migrations/001_create_schema.sql. The previous version
 * referenced six views that were never created (nport_company_holders_current_mv,
 * nport_company_timeseries_mv, nport_company_markups_mv, nport_filers,
 * nport_series, nport_positions) and two tables with wrong names
 * (n1a_portfolio_managers, nport_issuer_aliases, nport_unresolved_issuers).
 *
 * Where a route needs aggregation that no view supports directly, we run
 * the aggregation in JS (Promise.all + in-memory rollup) over the
 * row-level tables. For 'current holders' that means filtering positions_mv
 * to the latest report_period_end per company; for the timeseries view we
 * group by report_period_end; for markups we read from position_deltas.
 *
 * Dependency injection: the underlying clients hang off router.deps so
 * tests can swap them for fixtures without touching env vars.
 */

const express = require('express');
const router = express.Router();

const nportClientModule = require('../db/nport_client');
const crossSource = require('../db/cross_source');

const deps = {
  nportClient: nportClientModule.nportClient,
  advClient: crossSource.advClient,
  formdClient: crossSource.formdClient,
  isConfigured: nportClientModule.isConfigured,
  getAdminToken: () => process.env.NPORT_ADMIN_TOKEN || '',
  getCrossSourceCompanyView: crossSource.getCrossSourceCompanyView,
};
router.deps = deps;

// ============================================================================
// Helpers
// ============================================================================

const READ_PAGE_DEFAULT = 100;
const READ_PAGE_MAX = 1000;
const BASE_TABLE_READ_PAGE_SIZE = 1000;
const COMPANY_STATS_MAX_ROWS = 100000;
const TRIAGE_CANDIDATE_LIMIT = 5;

const TRIAGE_VENDOR_NOISE = [
  /\(PHYSICAL\)/gi,
  /\(NOT LISTED OR TRADING\)/gi,
  /\bCVT\s+PFD\b/gi,
  /\bPP\b/gi,
  /\bPC\b/gi,
];

const TRIAGE_LEGAL_SUFFIXES = new Set([
  'LLC',
  'INC',
  'PBC',
  'CORP',
  'CO',
  'LP',
  'LLP',
  'LTD',
  'PLC',
  'TRUST',
  'FUND',
  'HOLDINGS',
  'HLDGS',
  'PTY',
  'PTE',
  'GMBH',
  'AG',
  'SA',
  'SAS',
  'SRL',
  'SPA',
  'BV',
  'NV',
  'SE',
  'AB',
  'OY',
  'AS',
  'APS',
  'KK',
  'GK',
]);

let companyStatsCache = {
  loadedAt: 0,
  value: null,
};

function configGuard(res) {
  if (!deps.isConfigured()) {
    res.status(503).json({
      error: 'N-PORT Supabase project not configured',
      code: 'NPORT_NOT_CONFIGURED',
    });
    return false;
  }
  return true;
}

function adminGuard(req, res) {
  const expected = typeof deps.getAdminToken === 'function' ? deps.getAdminToken() : '';
  if (!expected) {
    res.status(403).json({
      error: 'N-PORT admin token is not configured',
      code: 'NPORT_ADMIN_NOT_CONFIGURED',
    });
    return false;
  }
  const provided = req.get('x-admin-token') || '';
  if (provided !== expected) {
    res.status(403).json({
      error: 'N-PORT admin token is missing or invalid',
      code: 'NPORT_ADMIN_FORBIDDEN',
    });
    return false;
  }
  return true;
}

function parsePagination(req) {
  const rawPage = parseInt(req.query.page, 10);
  const rawSize = parseInt(req.query.pageSize, 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Math.min(
    Number.isFinite(rawSize) && rawSize > 0 ? rawSize : READ_PAGE_DEFAULT,
    READ_PAGE_MAX
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function badRequest(res, message, code = 'BAD_REQUEST') {
  return res.status(400).json({ error: message, code });
}

function notFound(res, message = 'Not found', code = 'NOT_FOUND') {
  return res.status(404).json({ error: message, code });
}

function serverError(res, err, code = 'INTERNAL_ERROR') {
  console.error('[N-PORT]', err && err.message ? err.message : err);
  return res
    .status(500)
    .json({ error: err && err.message ? err.message : 'Internal error', code });
}

/**
 * CIK normalization helper.
 *
 * SEC uses CIK as a variable-width integer string. The bulk TSVs and
 * EDGAR URLs tend to use the unpadded form ("24238"); some sources
 * (and the user-facing URL convention here) zero-pad to 10 digits
 * ("0000024238"). To keep the API tolerant, we look up both forms.
 */
function cikVariants(cik) {
  const s = String(cik || '').trim();
  if (!s) return [];
  const padded = s.padStart(10, '0');
  const trimmed = s.replace(/^0+/, '') || '0';
  // Return both, deduped, in stable order.
  return Array.from(new Set([s, padded, trimmed]));
}

function crdVariants(crd) {
  const s = String(crd || '').trim();
  if (!s) return [];
  const stripped = s.replace(/^0+/, '') || '0';
  const padded = /^\d+$/.test(stripped) ? stripped.padStart(9, '0') : s;
  const numeric = /^\d+$/.test(stripped) ? Number(stripped) : null;
  return Array.from(
    new Set([s, stripped, padded, numeric].filter((value) => value !== null && value !== ''))
  );
}

function normalizeCrd(crd) {
  const s = String(crd || '').trim();
  if (!s || s.toUpperCase() === 'N/A') return null;
  return /^\d+$/.test(s) ? s.replace(/^0+/, '') || '0' : s;
}

function isMissingRelationError(err) {
  const text = `${(err && err.code) || ''} ${(err && err.message) || ''}`;
  return /PGRST205|does not exist|Could not find.*table|fund_ncen_adviser_links/i.test(text);
}

function uniqueAdviserIdentity(row) {
  if (!row) return null;
  return (
    normalizeCrd(row.adviser_crd_normalized || row.adviser_crd_raw) ||
    String(row.adviser_lei || '').trim() ||
    String(row.adviser_name || '').trim()
  ) || null;
}

function pickUnambiguousNcenRow(rows) {
  const candidates = rows || [];
  if (candidates.length === 0) {
    return { row: null, ambiguous: false, candidate_count: 0 };
  }
  const latestDate = candidates
    .map((row) => row.filing_date)
    .filter(Boolean)
    .sort()
    .pop();
  const latestRows = latestDate
    ? candidates.filter((row) => row.filing_date === latestDate)
    : candidates;
  const identities = new Set(latestRows.map(uniqueAdviserIdentity).filter(Boolean));
  if (identities.size > 1) {
    return {
      row: null,
      ambiguous: true,
      candidate_count: latestRows.length,
      identities: [...identities],
    };
  }
  return {
    row: latestRows[0] || null,
    ambiguous: false,
    candidate_count: latestRows.length,
    identities: [...identities],
  };
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIssuerForTriage(value) {
  if (!value) return '';
  let text = String(value).toUpperCase();
  for (const pattern of TRIAGE_VENDOR_NOISE) {
    text = text.replace(pattern, ' ');
  }
  text = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^A-Z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  while (text) {
    const parts = text.split(' ');
    const last = parts[parts.length - 1];
    if (!TRIAGE_LEGAL_SUFFIXES.has(last)) break;
    parts.pop();
    text = parts.join(' ');
  }
  return text;
}

function compactName(value) {
  return normalizeIssuerForTriage(value).replace(/[^A-Z0-9]/g, '');
}

function tokenSet(value) {
  return new Set(
    normalizeIssuerForTriage(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token && token.length > 1)
  );
}

function jaccardScore(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union > 0 ? intersection / union : 0;
}

function slugifyCompanyName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function companySearchScore(company) {
  const valuation = toNumber(company.latest_known_valuation_usd) || 0;
  const disclosed = toNumber(company.nport_latest_value_usd) || 0;
  const holders = toNumber(company.nport_latest_holder_count) || 0;
  const valuationScore = valuation > 0 ? Math.log10(valuation + 1) * 7 : 0;
  const disclosedScore = disclosed > 0 ? Math.log10(disclosed + 1) * 10 : 0;
  return Number((valuationScore + disclosedScore + holders * 2).toFixed(4));
}

function decorateCompaniesForSearch(companies, statsBySlug = new Map()) {
  return (companies || []).map((company) => {
    const stats = statsBySlug.get(company.slug) || {};
    const decorated = {
      ...company,
      nport_latest_period_date: stats.latest_period_date || null,
      nport_latest_value_usd: stats.latest_value_usd || 0,
      nport_latest_holder_count: stats.latest_holder_count || 0,
      nport_position_count: stats.position_count || 0,
      nport_period_count: stats.period_count || 0,
    };
    decorated.search_rank_score = companySearchScore(decorated);
    return decorated;
  });
}

async function fetchCompanyStatsFromPositionsMv(deps, { maxRows = COMPANY_STATS_MAX_ROWS } = {}) {
  const now = Date.now();
  if (
    companyStatsCache.value &&
    now - companyStatsCache.loadedAt < 5 * 60 * 1000
  ) {
    return companyStatsCache.value;
  }

  const bySlugPeriod = new Map();
  let lastHoldingId = 0;
  let scanned = 0;

  while (scanned < maxRows) {
    const pageSize = Math.min(BASE_TABLE_READ_PAGE_SIZE, maxRows - scanned);
    let query = deps.nportClient
      .from('nport_company_positions_mv')
      .select('holding_id_internal, company_slug, report_period_date, report_period_end, registrant_cik, currency_value_usd')
      .order('holding_id_internal', { ascending: true })
      .limit(pageSize);
    if (lastHoldingId > 0) query = query.gt('holding_id_internal', lastHoldingId);

    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    for (const row of page) {
      const slug = row.company_slug;
      const period = positionPeriod(row);
      if (!slug || !period) continue;
      const key = `${slug}|${period}`;
      const bucket = bySlugPeriod.get(key) || {
        slug,
        period,
        total_value: 0,
        holders: new Set(),
        position_count: 0,
      };
      bucket.total_value += toNumber(row.currency_value_usd) || 0;
      if (row.registrant_cik) bucket.holders.add(String(row.registrant_cik));
      bucket.position_count += 1;
      bySlugPeriod.set(key, bucket);
    }
    scanned += page.length;
    if (page.length < pageSize) break;
    const nextHoldingId = Number(page[page.length - 1].holding_id_internal);
    if (!Number.isFinite(nextHoldingId) || nextHoldingId <= lastHoldingId) break;
    lastHoldingId = nextHoldingId;
  }

  const statsBySlug = new Map();
  for (const bucket of bySlugPeriod.values()) {
    const current = statsBySlug.get(bucket.slug);
    if (!current || bucket.period > current.latest_period_date) {
      statsBySlug.set(bucket.slug, {
        latest_period_date: bucket.period,
        latest_value_usd: bucket.total_value,
        latest_holder_count: bucket.holders.size,
        position_count: bucket.position_count,
        period_count: 1,
      });
    } else if (bucket.period === current.latest_period_date) {
      current.latest_value_usd += bucket.total_value;
      current.latest_holder_count += bucket.holders.size;
      current.position_count += bucket.position_count;
    }
  }

  const periodsSeen = new Map();
  for (const bucket of bySlugPeriod.values()) {
    const set = periodsSeen.get(bucket.slug) || new Set();
    set.add(bucket.period);
    periodsSeen.set(bucket.slug, set);
  }
  for (const [slug, set] of periodsSeen.entries()) {
    const stats = statsBySlug.get(slug);
    if (stats) stats.period_count = set.size;
  }

  companyStatsCache = { loadedAt: now, value: statsBySlug };
  return statsBySlug;
}

function positionPeriod(row) {
  return row && (row.report_period_date || row.report_period_end || null);
}

function holderSecurityKey(row) {
  return [
    row && row.registrant_cik,
    row && (row.series_id || row.series_name),
    row && (row.share_class_normalized || row.raw_issuer_title || row.issuer_title),
    row && row.asset_cat,
    row && row.exposure_type,
  ]
    .map((value) => String(value || '').trim().toUpperCase())
    .join('|');
}

function addFirstSeenMetadata(allPositions, currentPositions) {
  const firstByKey = new Map();
  for (const row of allPositions || []) {
    const key = holderSecurityKey(row);
    const period = positionPeriod(row);
    if (!key || !period) continue;
    const existing = firstByKey.get(key);
    if (!existing || period < existing.period) {
      firstByKey.set(key, {
        period,
        accession_number: row.accession_number || null,
      });
    }
  }

  return (currentPositions || []).map((row) => {
    const firstSeen = firstByKey.get(holderSecurityKey(row));
    return {
      ...row,
      first_seen_report_date: (firstSeen && firstSeen.period) || positionPeriod(row),
      first_seen_accession_number: (firstSeen && firstSeen.accession_number) || row.accession_number || null,
    };
  });
}

function latestPositionsByHolderSecurity(positions) {
  const latestByKey = new Map();
  for (const row of positions || []) {
    const key = holderSecurityKey(row);
    const period = positionPeriod(row);
    if (!key || !period) continue;
    const existing = latestByKey.get(key);
    const existingPeriod = existing ? positionPeriod(existing) : null;
    const rowValue = toNumber(row.currency_value_usd) || 0;
    const existingValue = existing ? toNumber(existing.currency_value_usd) || 0 : 0;
    if (!existing || period > existingPeriod || (period === existingPeriod && rowValue > existingValue)) {
      latestByKey.set(key, row);
    }
  }
  return sortPositions(Array.from(latestByKey.values()));
}

function sortPositions(rows) {
  return [...(rows || [])].sort((a, b) => {
    const ap = positionPeriod(a) || '';
    const bp = positionPeriod(b) || '';
    if (ap !== bp) return ap < bp ? 1 : -1;
    const av = toNumber(a.currency_value_usd) || 0;
    const bv = toNumber(b.currency_value_usd) || 0;
    return bv - av;
  });
}

async function enrichPositionsWithFilingMetadata(deps, rows) {
  const positions = rows || [];
  if (positions.length === 0) return positions;
  const filings = await fetchRowsByIn(
    deps.nportClient,
    'nport_filings',
    'accession_number, filing_date, net_assets_usd, total_assets_usd, source_bulk_quarter, source_url, is_amendment, is_final_filing',
    'accession_number',
    positions.map((row) => row.accession_number)
  );
  const byAccession = new Map((filings || []).map((row) => [row.accession_number, row]));
  const holdingFacts = await fetchRowsByIn(
    deps.nportClient,
    'nport_holdings',
    [
      'id',
      'holding_id',
      'issuer_lei',
      'issuer_cusip',
      'unit',
      'other_unit_desc',
      'currency_code',
      'exchange_rate',
      'payoff_profile',
      'other_asset',
      'issuer_type',
      'other_issuer',
      'investment_country',
      'is_restricted_security',
      'fair_value_level',
      'derivative_cat',
      'resolution_source',
      'resolution_confidence',
      'underlier_issuer_name',
    ].join(', '),
    'id',
    positions.map((row) => row.holding_id_internal)
  );
  const byHoldingId = new Map(
    (holdingFacts || []).map((row) => [Number(row.id), row])
  );
  return positions.map((row) => ({
    ...(byHoldingId.get(Number(row.holding_id_internal)) || {}),
    ...row,
    ...(byAccession.get(row.accession_number) || {}),
  }));
}

async function fetchRowsByIn(client, table, columns, key, values, chunkSize = 100) {
  const unique = Array.from(new Set((values || []).filter(Boolean).map(String)));
  const out = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await client.from(table).select(columns).in(key, chunk);
    if (error) throw error;
    out.push(...(data || []));
  }
  return out;
}

async function fetchAdvAdviserByCrd(adviserCrd) {
  const variants = crdVariants(adviserCrd);
  if (variants.length === 0 || !deps.advClient) return null;
  const { data, error } = await deps.advClient
    .from('advisers_enriched')
    .select('*')
    .in('crd', variants)
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

async function fetchNcenAdviserLink(variants, seriesId, { allowRegistrantFallback = !seriesId } = {}) {
  try {
    if (seriesId) {
      const exactRes = await deps.nportClient
        .from('fund_ncen_adviser_links')
        .select('*')
        .in('registrant_cik', variants)
        .eq('series_id', seriesId)
        .eq('adviser_role', 'investment_adviser')
        .order('filing_date', { ascending: false })
        .limit(50);
      if (exactRes.error) throw exactRes.error;
      const exact = pickUnambiguousNcenRow(exactRes.data || []);
      if (exact.row || exact.ambiguous) {
        return { ...exact, source: 'fund_ncen_adviser_links' };
      }
      if (!allowRegistrantFallback) {
        return {
          row: null,
          source: 'fund_ncen_adviser_links',
          ambiguous: false,
          candidate_count: 0,
          exact_series_match: false,
        };
      }
    }

    const fallbackRes = await deps.nportClient
      .from('fund_ncen_adviser_links')
      .select('*')
      .in('registrant_cik', variants)
      .eq('adviser_role', 'investment_adviser')
      .order('filing_date', { ascending: false })
      .limit(1000);
    if (fallbackRes.error) throw fallbackRes.error;
    const fallback = pickUnambiguousNcenRow(fallbackRes.data || []);
    return {
      ...fallback,
      source: fallback.row || fallback.ambiguous ? 'fund_ncen_adviser_links' : null,
    };
  } catch (err) {
    if (isMissingRelationError(err)) {
      return { row: null, source: null, ambiguous: false, candidate_count: 0 };
    }
    throw err;
  }
}

async function fetchLegacyNcenRecord(variants, seriesId, { allowRegistrantFallback = !seriesId } = {}) {
  let exact = [];
  if (seriesId) {
    const exactRes = await deps.nportClient
      .from('fund_ncen_records')
      .select(
        'investment_adviser_name, investment_adviser_crd, investment_adviser_lei, subadviser_name, subadviser_crd, filing_date, accession_number, fiscal_year_end, fund_type, series_id'
      )
      .in('registrant_cik', variants)
      .eq('series_id', seriesId)
      .order('filing_date', { ascending: false })
      .limit(1);
    if (exactRes.error) throw exactRes.error;
    exact = exactRes.data || [];
  }
  if (exact.length > 0) return { row: exact[0], source: 'fund_ncen_records' };
  if (!allowRegistrantFallback) {
    return { row: null, source: null, exact_series_match: false };
  }

  const fallbackRes = await deps.nportClient
    .from('fund_ncen_records')
    .select(
      'investment_adviser_name, investment_adviser_crd, investment_adviser_lei, subadviser_name, subadviser_crd, filing_date, accession_number, fiscal_year_end, fund_type, series_id'
    )
    .in('registrant_cik', variants)
    .order('filing_date', { ascending: false })
    .limit(1);
  if (fallbackRes.error) throw fallbackRes.error;
  const fallback = fallbackRes.data || [];
  return {
    row: fallback[0] || null,
    source: fallback[0] ? 'fund_ncen_records' : null,
  };
}

function adviserCrdFromNcen(row) {
  if (!row) return null;
  return normalizeCrd(row.adviser_crd_normalized || row.investment_adviser_crd);
}

async function resolveFundAdviser(cik, seriesId = null) {
  const variants = cikVariants(cik);
  let { row: ncenRow, source, ambiguous, candidate_count, exact_series_match } = await fetchNcenAdviserLink(
    variants,
    seriesId,
    { allowRegistrantFallback: !seriesId }
  );
  if (ambiguous) {
    return {
      cik,
      series_id: seriesId,
      adviser_crd: null,
      adviser: null,
      ncen_link: null,
      ncen_source: source,
      candidate_count,
      note: seriesId
        ? 'Multiple N-CEN investment advisers matched this series'
        : 'Multiple N-CEN investment advisers matched this registrant; open a specific series to resolve the adviser',
    };
  }
  if (!ncenRow) {
    const legacy = await fetchLegacyNcenRecord(variants, seriesId, {
      allowRegistrantFallback: !seriesId,
    });
    ncenRow = legacy.row;
    source = legacy.source;
    if (legacy.exact_series_match === false) exact_series_match = false;
  }

  const adviserCrd = adviserCrdFromNcen(ncenRow);
  if (!adviserCrd) {
    return {
      cik,
      series_id: seriesId,
      adviser_crd: null,
      adviser: null,
      ncen_link: ncenRow || null,
      ncen_source: source,
      exact_series_match,
      note: seriesId
        ? 'No exact N-CEN adviser link has been resolved for this series'
        : 'No ADV cross-link resolved for this registrant',
    };
  }
  const adviser = await fetchAdvAdviserByCrd(adviserCrd);
  return {
    cik,
    series_id: seriesId,
    adviser_crd: adviserCrd,
    adviser,
    ncen_link: ncenRow || null,
    ncen_source: source,
  };
}

async function fetchCompanyHoldingsByKeyset(deps, companyId, { maxRows = 10000 } = {}) {
  const out = [];
  let lastId = 0;
  while (out.length < maxRows) {
    const pageSize = Math.min(BASE_TABLE_READ_PAGE_SIZE, maxRows - out.length);
    let query = deps.nportClient
      .from('nport_holdings')
      .select(
        'id, accession_number, issuer_name, issuer_title, balance, currency_value_usd, pct_of_nav, asset_cat, exposure_type, share_class_normalized, resolved_company_id'
      )
      .eq('resolved_company_id', companyId)
      .order('id', { ascending: true })
      .limit(pageSize);
    if (lastId > 0) query = query.gt('id', lastId);

    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    out.push(...page);
    if (page.length < pageSize) break;
    lastId = page[page.length - 1].id;
  }
  return out;
}

function composePositionRows({ company, holdings, filings, registrants }) {
  const filingsByAccession = new Map(
    (filings || []).map((row) => [row.accession_number, row])
  );
  const registrantsByCik = new Map(
    (registrants || []).map((row) => [String(row.cik), row])
  );

  return sortPositions(
    (holdings || [])
      .map((holding) => {
        const filing = filingsByAccession.get(holding.accession_number);
        if (!filing) return null;
        const registrant = registrantsByCik.get(String(filing.cik)) || {};
        return {
          company_id: company.id,
          company_slug: company.slug,
          company_name: company.display_name,
          sector: company.sector,
          exposure_type: holding.exposure_type,
          share_class_normalized: holding.share_class_normalized,
          asset_cat: holding.asset_cat,
          report_period_end: filing.report_period_end,
          report_period_date: filing.report_period_date,
          registrant_id: registrant.id || null,
          registrant_cik: filing.cik,
          registrant_name: registrant.name || filing.registrant_name,
          series_id: filing.series_id,
          series_name: filing.series_name,
          fund_type: filing.fund_type,
          is_interval_fund: filing.is_interval_fund,
          is_variable_insurance: filing.is_variable_insurance,
          parent_registrant_id: filing.parent_registrant_id,
          balance: holding.balance,
          currency_value_usd: holding.currency_value_usd,
          pct_of_nav: holding.pct_of_nav,
          raw_issuer_name: holding.issuer_name,
          raw_issuer_title: holding.issuer_title,
          accession_number: holding.accession_number,
          holding_id_internal: holding.id,
        };
      })
      .filter(Boolean)
  );
}

async function fetchCompanyPositionsFromBase(deps, company, { maxRows = 5000 } = {}) {
  const holdings = await fetchCompanyHoldingsByKeyset(deps, company.id, { maxRows });
  if (!holdings || holdings.length === 0) return [];

  const accessions = holdings.map((row) => row.accession_number);
  const filings = await fetchRowsByIn(
    deps.nportClient,
    'nport_filings',
    'accession_number, cik, registrant_name, series_id, series_name, report_period_end, report_period_date, fund_type, is_interval_fund, is_variable_insurance, parent_registrant_id',
    'accession_number',
    accessions
  );
  const registrants = await fetchRowsByIn(
    deps.nportClient,
    'nport_registrants',
    'id, cik, name',
    'cik',
    filings.map((row) => row.cik)
  );
  return composePositionRows({ company, holdings, filings, registrants });
}

async function fetchCompanyPositions(deps, slug, { page, pageSize, offset, maxRows } = {}) {
  const { data: company, error: companyErr } = await deps.nportClient
    .from('private_companies')
    .select('id, slug, display_name, sector')
    .eq('slug', slug)
    .maybeSingle();
  if (companyErr) throw companyErr;
  if (!company) return { company: null, positions: [], total: 0, source: null };

  let mvQuery = deps.nportClient
    .from('nport_company_positions_mv')
    .select('*', { count: 'exact' })
    .eq('company_slug', slug)
    .order('report_period_date', { ascending: false })
    .order('currency_value_usd', { ascending: false, nullsFirst: false });
  if (pageSize !== undefined && offset !== undefined) {
    mvQuery = mvQuery.range(offset, offset + pageSize - 1);
  }
  const { data: mvRows, error: mvErr, count } = await mvQuery;
  if (mvErr) throw mvErr;
  if ((mvRows || []).length > 0 || (count || 0) > 0) {
    return {
      company,
      positions: sortPositions(mvRows || []),
      total: count || (mvRows || []).length,
      source: 'materialized_view',
    };
  }

  const baseRows = await fetchCompanyPositionsFromBase(deps, company, { maxRows });
  const sliced =
    pageSize !== undefined && offset !== undefined
      ? baseRows.slice(offset, offset + pageSize)
      : baseRows;
  return {
    company,
    positions: sliced,
    total: baseRows.length,
    source: 'base_tables',
  };
}

async function fetchFundPositionsFromBase(deps, variants, seriesId, { maxRows = 5000 } = {}) {
  let filingQuery = deps.nportClient
    .from('nport_filings')
    .select(
      'accession_number, cik, registrant_name, series_id, series_name, report_period_end, report_period_date, fund_type, is_interval_fund, is_variable_insurance, parent_registrant_id'
    )
    .in('cik', variants)
    .order('report_period_date', { ascending: false })
    .limit(Math.min(BASE_TABLE_READ_PAGE_SIZE, maxRows));
  if (seriesId !== null && seriesId !== undefined) {
    filingQuery = filingQuery.eq('series_id', seriesId);
  }
  const { data: filings, error: filingErr } = await filingQuery;
  if (filingErr) throw filingErr;
  if (!filings || filings.length === 0) return [];

  const holdings = await fetchRowsByIn(
    deps.nportClient,
    'nport_holdings',
    'id, accession_number, issuer_name, issuer_title, balance, currency_value_usd, pct_of_nav, asset_cat, exposure_type, share_class_normalized, resolved_company_id',
    'accession_number',
    filings.map((row) => row.accession_number)
  );
  const resolvedHoldings = (holdings || []).filter((row) => row.resolved_company_id);
  const companies = await fetchRowsByIn(
    deps.nportClient,
    'private_companies',
    'id, slug, display_name, sector',
    'id',
    resolvedHoldings.map((row) => row.resolved_company_id)
  );
  const companiesById = new Map((companies || []).map((row) => [row.id, row]));
  const registrants = await fetchRowsByIn(
    deps.nportClient,
    'nport_registrants',
    'id, cik, name',
    'cik',
    filings.map((row) => row.cik)
  );

  return sortPositions(
    resolvedHoldings.flatMap((holding) => {
      const company = companiesById.get(holding.resolved_company_id);
      if (!company) return [];
      return composePositionRows({
        company,
        holdings: [holding],
        filings,
        registrants,
      });
    })
  );
}

// ============================================================================
// 7.1 Company endpoints
// ============================================================================

/**
 * GET /api/nport/companies
 * Filters: sector, lifecycleStatus (lifecycle_status), page, pageSize
 *
 * Note: PLAN_NPORT_HOLDINGS.md mentions a `hasRecentMarkup` filter but
 * `private_companies` doesn't carry that column. We resolve it on the fly
 * by joining against `position_deltas` (is_pure_markup=true within the
 * last 12 months).
 */
router.get('/companies', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { sector, lifecycleStatus, hasRecentMarkup, includeStats } = req.query;

    if (
      hasRecentMarkup !== undefined &&
      !['true', 'false'].includes(String(hasRecentMarkup))
    ) {
      return badRequest(res, 'hasRecentMarkup must be true or false', 'INVALID_PARAM');
    }

    const { page, pageSize, offset } = parsePagination(req);

    let q = deps.nportClient
      .from('private_companies')
      .select('*', { count: 'exact' });

    if (sector) q = q.eq('sector', sector);
    if (lifecycleStatus) q = q.eq('lifecycle_status', lifecycleStatus);

    q = q.order('display_name', { ascending: true }).range(offset, offset + pageSize - 1);

    const { data, error, count } = await q;
    if (error) throw error;

    let companies = data || [];
    if (includeStats === 'true' || includeStats === '1') {
      const statsBySlug = await fetchCompanyStatsFromPositionsMv(deps);
      companies = decorateCompaniesForSearch(companies, statsBySlug).sort((a, b) => {
        const scoreDelta = (toNumber(b.search_rank_score) || 0) - (toNumber(a.search_rank_score) || 0);
        if (scoreDelta !== 0) return scoreDelta;
        return String(a.display_name || a.slug).localeCompare(String(b.display_name || b.slug));
      });
    }

    // hasRecentMarkup filter applied in JS — derived from position_deltas
    // because private_companies has no `has_recent_markup` column.
    if (hasRecentMarkup === 'true' || hasRecentMarkup === 'false') {
      const slugs = companies.map((c) => c.slug).filter(Boolean);
      const slugToHasMarkup = await fetchHasRecentMarkupBySlug(deps, slugs);
      companies = companies.filter((c) => {
        const flag = slugToHasMarkup.get(c.slug) || false;
        return hasRecentMarkup === 'true' ? flag : !flag;
      });
    }

    return res.json({
      total: count || 0,
      page,
      pageSize,
      companies,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * Helper: for a list of company slugs, return a Map(slug -> boolean) of
 * whether that company has any pure-markup delta in the last 12 months.
 */
async function fetchHasRecentMarkupBySlug(deps, slugs) {
  const out = new Map();
  if (!slugs || slugs.length === 0) return out;
  const twelveMonthsAgoIso = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  // Resolve slugs -> ids
  const { data: companies, error } = await deps.nportClient
    .from('private_companies')
    .select('id, slug')
    .in('slug', slugs);
  if (error) throw error;
  const idToSlug = new Map((companies || []).map((c) => [c.id, c.slug]));
  if (idToSlug.size === 0) return out;
  const { data: deltas, error: dErr } = await deps.nportClient
    .from('position_deltas')
    .select('company_id, is_pure_markup, current_period_end')
    .in('company_id', Array.from(idToSlug.keys()))
    .gte('current_period_end', twelveMonthsAgoIso)
    .eq('is_pure_markup', true);
  if (dErr) throw dErr;
  for (const d of deltas || []) {
    const slug = idToSlug.get(d.company_id);
    if (slug) out.set(slug, true);
  }
  return out;
}

async function fetchTriageDirectory(deps) {
  const [{ data: companies, error: companyErr }, { data: aliases, error: aliasErr }] =
    await Promise.all([
      deps.nportClient
        .from('private_companies')
        .select('id, slug, display_name, sector, primary_domain, latest_known_valuation_usd'),
      deps.nportClient
        .from('private_company_aliases')
        .select('company_id, pattern_type, pattern, source, confidence'),
    ]);
  if (companyErr) throw companyErr;
  if (aliasErr) throw aliasErr;

  const byId = new Map((companies || []).map((company) => [company.id, company]));
  const aliasRows = (aliases || [])
    .map((alias) => ({
      ...alias,
      company: byId.get(alias.company_id) || null,
      normalized_pattern: normalizeIssuerForTriage(alias.pattern),
      compact_pattern: compactName(alias.pattern),
    }))
    .filter((alias) => alias.company);
  return {
    companies: companies || [],
    aliases: aliasRows,
  };
}

function candidateForCompany(groupName, company) {
  const normalizedDisplay = normalizeIssuerForTriage(company.display_name || company.slug);
  const normalizedGroup = normalizeIssuerForTriage(groupName);
  if (!normalizedDisplay || !normalizedGroup) return null;
  if (normalizedDisplay === normalizedGroup) {
    return { score: 100, reason: 'Exact company-name match', source_type: 'company_name' };
  }
  const groupCompact = compactName(groupName);
  const displayCompact = compactName(company.display_name || company.slug);
  if (groupCompact && groupCompact === displayCompact) {
    return { score: 92, reason: 'Exact compact-name match', source_type: 'company_name' };
  }
  if (
    normalizedGroup.length >= 8 &&
    (normalizedGroup.startsWith(`${normalizedDisplay} `) || normalizedDisplay.startsWith(`${normalizedGroup} `))
  ) {
    return { score: 84, reason: 'Prefix match on company name', source_type: 'company_name' };
  }
  const overlap = jaccardScore(groupName, company.display_name || company.slug);
  if (overlap >= 0.5) {
    return {
      score: Math.round(50 + overlap * 30),
      reason: `Token overlap ${(overlap * 100).toFixed(0)}%`,
      source_type: 'company_name',
    };
  }
  return null;
}

function candidateForAlias(groupName, alias) {
  const normalizedGroup = normalizeIssuerForTriage(groupName);
  const normalizedAlias = alias.normalized_pattern;
  if (!normalizedGroup || !normalizedAlias) return null;
  if (normalizedGroup === normalizedAlias) {
    return {
      score: alias.pattern_type === 'exact_normalized' ? 98 : 90,
      reason: `Exact ${alias.pattern_type || 'alias'} match`,
      source_type: 'alias',
      matched_pattern: alias.pattern,
      alias_source: alias.source || null,
    };
  }
  if (
    normalizedGroup.length >= 8 &&
    normalizedAlias.length >= 8 &&
    (normalizedGroup.startsWith(`${normalizedAlias} `) || normalizedAlias.startsWith(`${normalizedGroup} `))
  ) {
    return {
      score: 86,
      reason: `Prefix ${alias.pattern_type || 'alias'} match`,
      source_type: 'alias',
      matched_pattern: alias.pattern,
      alias_source: alias.source || null,
    };
  }
  if (compactName(groupName) && compactName(groupName) === alias.compact_pattern) {
    return {
      score: 83,
      reason: 'Compact alias match',
      source_type: 'alias',
      matched_pattern: alias.pattern,
      alias_source: alias.source || null,
    };
  }
  return null;
}

function buildTriageCandidates(groupName, directory) {
  const candidatesBySlug = new Map();
  for (const company of directory.companies || []) {
    const candidate = candidateForCompany(groupName, company);
    if (!candidate) continue;
    candidatesBySlug.set(company.slug, {
      company_slug: company.slug,
      display_name: company.display_name,
      sector: company.sector,
      primary_domain: company.primary_domain,
      ...candidate,
    });
  }
  for (const alias of directory.aliases || []) {
    const candidate = candidateForAlias(groupName, alias);
    if (!candidate || !alias.company) continue;
    const existing = candidatesBySlug.get(alias.company.slug);
    if (!existing || candidate.score > existing.score) {
      candidatesBySlug.set(alias.company.slug, {
        company_slug: alias.company.slug,
        display_name: alias.company.display_name,
        sector: alias.company.sector,
        primary_domain: alias.company.primary_domain,
        ...candidate,
      });
    }
  }
  return Array.from(candidatesBySlug.values())
    .sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name))
    .slice(0, TRIAGE_CANDIDATE_LIMIT);
}

function suggestedTriageAction(groupName, candidates) {
  const normalized = normalizeIssuerForTriage(groupName);
  if (/SPV|EXPOSURE|ECONOMIC EXPOSURE|INVESTED IN/.test(normalized)) return 'review_spv';
  if ((candidates || [])[0] && candidates[0].score >= 90) return 'match_candidate';
  return 'manual_review';
}

/**
 * GET /api/nport/companies/:slug
 */
router.get('/companies/:slug', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;
    if (!slug) return badRequest(res, 'slug required', 'MISSING_SLUG');

    const { data, error } = await deps.nportClient
      .from('private_companies')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (error) throw error;
    if (!data) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');

    return res.json({ company: data });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/companies/:slug/positions
 * All positions across funds + periods, paginated.
 *
 * Reads from `nport_company_positions_mv` (which EXISTS per
 * 001_create_schema.sql).
 */
router.get('/companies/:slug/positions', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;
    const { page, pageSize, offset } = parsePagination(req);

    const { company, positions, total, source } = await fetchCompanyPositions(deps, slug, {
      page,
      pageSize,
      offset,
    });
    if (!company) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');

    return res.json({
      total,
      page,
      pageSize,
      source,
      positions,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/companies/:slug/holders
 * Current holder rollup. We use the latest available row per fund/security
 * because N-PORT filers do not all publish the same month-end snapshot at
 * the same time.
 */
router.get('/companies/:slug/holders', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;

    const { company, positions } = await fetchCompanyPositions(deps, slug, {
      maxRows: 5000,
    });
    if (!company) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');

    const periodDate = positions && positions.length > 0 ? positionPeriod(positions[0]) : null;

    if (!periodDate) {
      return res.json({
        company_slug: slug,
        period_date: null,
        period_end: null,
        holders: [],
      });
    }

    const currentPositions = latestPositionsByHolderSecurity(positions || []);
    const currentWithFirstSeen = addFirstSeenMetadata(positions || [], currentPositions);

    return res.json({
      company_slug: slug,
      period_date: periodDate,
      period_end: periodDate,
      holders: await enrichPositionsWithFilingMetadata(deps, currentWithFirstSeen),
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/companies/:slug/timeseries
 * Quarterly position values rolled up across all holders.
 *
 * Computed on the fly from nport_company_positions_mv by grouping on
 * the holdings snapshot date. (No nport_company_timeseries_mv view exists in the
 * schema.)
 */
router.get('/companies/:slug/timeseries', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;

    const { company, positions } = await fetchCompanyPositions(deps, slug, {
      maxRows: 5000,
    });
    if (!company) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');

    // Group by holdings snapshot date. In SEC bulk data, REPORT_ENDING_PERIOD
    // is the fund fiscal year-end; REPORT_DATE is the portfolio date.
    const byPeriod = new Map();
    for (const row of positions || []) {
      const k = positionPeriod(row);
      if (!k) continue;
      const bucket = byPeriod.get(k) || {
        report_period_end: k,
        report_period_date: k,
        total_value_usd: 0,
        total_balance: 0,
        holder_count: new Set(),
      };
      if (typeof row.currency_value_usd === 'number') {
        bucket.total_value_usd += row.currency_value_usd;
      } else if (row.currency_value_usd != null) {
        bucket.total_value_usd += Number(row.currency_value_usd) || 0;
      }
      if (typeof row.balance === 'number') {
        bucket.total_balance += row.balance;
      } else if (row.balance != null) {
        bucket.total_balance += Number(row.balance) || 0;
      }
      if (row.registrant_cik) bucket.holder_count.add(row.registrant_cik);
      byPeriod.set(k, bucket);
    }
    const series = Array.from(byPeriod.values())
      .map((b) => ({
        report_period_end: b.report_period_end,
        report_period_date: b.report_period_date,
        total_value_usd: b.total_value_usd,
        total_balance: b.total_balance,
        holder_count: b.holder_count.size,
      }))
      .sort((a, b) =>
        positionPeriod(a) < positionPeriod(b) ? -1 : 1
      );

    return res.json({
      company_slug: slug,
      series,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/companies/:slug/markups
 * Largest QoQ pure markups across holders, sourced from position_deltas.
 * (No nport_company_markups_mv view exists.)
 */
router.get('/companies/:slug/markups', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 25, 200);

    const { data: company, error: companyErr } = await deps.nportClient
      .from('private_companies')
      .select('id, slug')
      .eq('slug', slug)
      .maybeSingle();
    if (companyErr) throw companyErr;
    if (!company) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');

    const { data, error } = await deps.nportClient
      .from('position_deltas')
      .select('*')
      .eq('company_id', company.id)
      .eq('is_pure_markup', true)
      .order('markup_pct', { ascending: false, nullsFirst: false })
      .limit(limit);

    if (error) throw error;

    return res.json({
      company_slug: slug,
      markups: data || [],
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/companies/:slug/cross
 * Cross-DB consolidated view (N-PORT + Form D + ADV) — see §7.2.
 */
router.get('/companies/:slug/cross', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;
    const result = await deps.getCrossSourceCompanyView(slug, {
      nportClient: deps.nportClient,
      advClient: deps.advClient,
      formdClient: deps.formdClient,
    });
    if (!result) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');
    return res.json(result);
  } catch (err) {
    return serverError(res, err);
  }
});

// ============================================================================
// 7.1 Fund endpoints
// ============================================================================

/**
 * GET /api/nport/funds/:cik — fund family overview
 *
 * Reads from `nport_registrants` (one row per CIK) and lists distinct
 * series from `nport_filings` (the schema does NOT have a separate
 * nport_series table).
 */
router.get('/funds/:cik', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { cik } = req.params;
    if (!/^\d+$/.test(cik)) {
      return badRequest(res, 'cik must be numeric', 'INVALID_CIK');
    }

    const variants = cikVariants(cik);
    const { data: regRows, error: regErr } = await deps.nportClient
      .from('nport_registrants')
      .select('*')
      .in('cik', variants)
      .limit(1);
    if (regErr) throw regErr;
    const registrant = Array.isArray(regRows) ? regRows[0] : regRows;
    if (!registrant) {
      return notFound(res, `Filer not found: ${cik}`, 'FILER_NOT_FOUND');
    }

    // Pull every filing for this CIK and reduce to distinct series.
    const { data: filings, error: filErr } = await deps.nportClient
      .from('nport_filings')
      .select('series_id, series_name, fund_type, report_period_end, report_period_date')
      .in('cik', variants)
      .order('report_period_date', { ascending: false });
    if (filErr) throw filErr;

    const seriesBySid = new Map();
    for (const f of filings || []) {
      const sid = f.series_id || '';
      if (!seriesBySid.has(sid)) {
        seriesBySid.set(sid, {
          series_id: f.series_id,
          series_name: f.series_name,
          fund_type: f.fund_type,
          latest_period_end: f.report_period_date || f.report_period_end,
          latest_report_period_date: f.report_period_date,
          fiscal_year_end: f.report_period_end,
        });
      }
    }

    return res.json({
      filer: registrant,
      series: Array.from(seriesBySid.values()),
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/funds/:cik/positions
 * All private-company positions held by this fund family, optionally narrowed
 * to one company via ?company=slug. This supports CIK-only drilldowns when SEC
 * bulk data does not carry a series_id for a holder row.
 */
router.get('/funds/:cik/positions', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { cik } = req.params;
    if (!/^\d+$/.test(cik)) {
      return badRequest(res, 'cik must be numeric', 'INVALID_CIK');
    }
    const { company } = req.query;
    const { page, pageSize, offset } = parsePagination(req);
    const variants = cikVariants(cik);

    let query = deps.nportClient
      .from('nport_company_positions_mv')
      .select('*', { count: 'exact' })
      .in('registrant_cik', variants)
      .order('report_period_date', { ascending: false })
      .order('currency_value_usd', { ascending: false, nullsFirst: false })
      .range(offset, offset + pageSize - 1);
    if (company) query = query.eq('company_slug', String(company));

    const { data, error, count } = await query;
    if (error) throw error;
    let positions = data || [];
    let total = count || 0;
    let source = 'materialized_view';

    if (positions.length === 0 && total === 0 && !company) {
      const baseRows = await fetchFundPositionsFromBase(deps, variants, null);
      positions = baseRows.slice(offset, offset + pageSize);
      total = baseRows.length;
      source = 'base_tables';
    }

    return res.json({
      total,
      page,
      pageSize,
      cik,
      source,
      positions: await enrichPositionsWithFilingMetadata(deps, positions),
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/funds/:cik/adviser
 * Registrant-level N-CEN -> ADV adviser link.
 */
router.get('/funds/:cik/adviser', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { cik } = req.params;
    if (!/^\d+$/.test(cik)) {
      return badRequest(res, 'cik must be numeric', 'INVALID_CIK');
    }

    const variants = cikVariants(cik);
    const { data: filer, error: filerErr } = await deps.nportClient
      .from('nport_registrants')
      .select('cik')
      .in('cik', variants)
      .limit(1);
    if (filerErr) throw filerErr;
    if (!filer || filer.length === 0) {
      return notFound(res, `Filer not found: ${cik}`, 'FILER_NOT_FOUND');
    }

    const payload = await resolveFundAdviser(cik, null);
    return res.json(payload);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/funds/:cik/:series_id — single fund series detail
 */
router.get('/funds/:cik/:series_id', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { cik, series_id: seriesId } = req.params;
    if (!/^\d+$/.test(cik)) {
      return badRequest(res, 'cik must be numeric', 'INVALID_CIK');
    }

    const variants = cikVariants(cik);
    const { data, error } = await deps.nportClient
      .from('nport_filings')
      .select(
        'cik, series_id, series_name, fund_type, is_interval_fund, is_variable_insurance, report_period_end, report_period_date, net_assets_usd, total_assets_usd, accession_number, filing_date'
      )
      .in('cik', variants)
      .eq('series_id', seriesId)
      .order('report_period_date', { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) {
      return notFound(
        res,
        `Series not found: ${cik}/${seriesId}`,
        'SERIES_NOT_FOUND'
      );
    }

    return res.json({ series: data[0] });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/funds/:cik/:series_id/positions
 * All private-company positions held by this fund series across periods.
 *
 * Filters nport_company_positions_mv by registrant_cik + series_id.
 * (No nport_positions table exists.)
 */
router.get('/funds/:cik/:series_id/positions', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { cik, series_id: seriesId } = req.params;
    if (!/^\d+$/.test(cik)) {
      return badRequest(res, 'cik must be numeric', 'INVALID_CIK');
    }
    const { page, pageSize, offset } = parsePagination(req);

    const variants = cikVariants(cik);
    const { data, error, count } = await deps.nportClient
      .from('nport_company_positions_mv')
      .select('*', { count: 'exact' })
      .in('registrant_cik', variants)
      .eq('series_id', seriesId)
      .order('report_period_date', { ascending: false })
      .order('currency_value_usd', { ascending: false, nullsFirst: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    let positions = data || [];
    let total = count || 0;
    let source = 'materialized_view';
    if (positions.length === 0 && total === 0) {
      const baseRows = await fetchFundPositionsFromBase(deps, variants, seriesId);
      positions = baseRows.slice(offset, offset + pageSize);
      total = baseRows.length;
      source = 'base_tables';
    }

    return res.json({
      total,
      page,
      pageSize,
      cik,
      series_id: seriesId,
      source,
      positions,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/funds/:cik/:series_id/managers
 * Portfolio managers from N-1A enrichment (table name is
 * fund_portfolio_managers per schema, not n1a_portfolio_managers).
 */
router.get('/funds/:cik/:series_id/managers', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { cik, series_id: seriesId } = req.params;
    if (!/^\d+$/.test(cik)) {
      return badRequest(res, 'cik must be numeric', 'INVALID_CIK');
    }

    const variants = cikVariants(cik);
    const { data, error } = await deps.nportClient
      .from('fund_portfolio_managers')
      .select('*')
      .in('registrant_cik', variants)
      .eq('series_id', seriesId)
      .eq('is_currently_active', true)
      .order('pm_name', { ascending: true });
    if (error) throw error;

    return res.json({
      cik,
      series_id: seriesId,
      managers: data || [],
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/funds/:cik/:series_id/adviser
 * Cross-link to ADV adviser record.
 *
 * Source of CRD: normalized fund_ncen_adviser_links by CIK + SEC series ID,
 * with legacy fund_ncen_records used only as a fallback for older databases.
 */
router.get('/funds/:cik/:series_id/adviser', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { cik, series_id: seriesId } = req.params;
    if (!/^\d+$/.test(cik)) {
      return badRequest(res, 'cik must be numeric', 'INVALID_CIK');
    }

    const variants = cikVariants(cik);
    // Confirm the series exists first (so we can 404 properly).
    const { data: anyFiling, error: fErr } = await deps.nportClient
      .from('nport_filings')
      .select('cik, series_id')
      .in('cik', variants)
      .eq('series_id', seriesId)
      .limit(1);
    if (fErr) throw fErr;
    if (!anyFiling || anyFiling.length === 0) {
      return notFound(
        res,
        `Series not found: ${cik}/${seriesId}`,
        'SERIES_NOT_FOUND'
      );
    }

    const payload = await resolveFundAdviser(cik, seriesId);
    return res.json(payload);
  } catch (err) {
    return serverError(res, err);
  }
});

// ============================================================================
// 7.1 Admin endpoints
// ============================================================================

/**
 * GET /api/nport/admin/unresolved
 * Triage list of unresolved holdings — rows with
 * resolution_source = 'unresolved' (or NULL) in nport_holdings.
 *
 * Bug 5 fix: there is no `nport_unresolved_issuers` view in the schema.
 * We query the base table and group by issuer_name in JS.
 */
router.get('/admin/unresolved', async (req, res) => {
  if (!configGuard(res)) return;
  if (!adminGuard(req, res)) return;
  try {
    const { page, pageSize, offset } = parsePagination(req);

    const { data, error } = await deps.nportClient
      .from('nport_holdings')
      .select(
        'id, accession_number, issuer_name, issuer_title, issuer_lei, issuer_cusip, balance, currency_value_usd, asset_cat, exposure_type, resolution_source, resolution_confidence, source_bulk_quarter, ingested_at',
        { count: 'exact' }
      )
      .or('resolution_source.is.null,resolution_source.eq.unresolved')
      .order('ingested_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) throw error;

    const filings = await fetchRowsByIn(
      deps.nportClient,
      'nport_filings',
      'accession_number, cik, registrant_name, series_id, series_name, report_period_date',
      'accession_number',
      (data || []).map((row) => row.accession_number)
    );
    const filingByAccession = new Map((filings || []).map((row) => [row.accession_number, row]));
    const directory = await fetchTriageDirectory(deps);
    const groupsByName = new Map();
    for (const row of data || []) {
      const normalizedName = normalizeIssuerForTriage(row.issuer_name || row.issuer_title);
      if (!normalizedName) continue;
      const filing = filingByAccession.get(row.accession_number) || {};
      const group = groupsByName.get(normalizedName) || {
        normalized_name: normalizedName,
        raw_names: new Set(),
        filer_ciks: new Set(),
        accession_numbers: new Set(),
        total_value_usd: 0,
        total_balance: 0,
        row_count: 0,
        sample_rows: [],
      };
      if (row.issuer_name) group.raw_names.add(row.issuer_name);
      if (filing.cik) group.filer_ciks.add(String(filing.cik));
      if (row.accession_number) group.accession_numbers.add(row.accession_number);
      group.total_value_usd += toNumber(row.currency_value_usd) || 0;
      group.total_balance += toNumber(row.balance) || 0;
      group.row_count += 1;
      if (group.sample_rows.length < 5) {
        group.sample_rows.push({
          id: row.id,
          accession_number: row.accession_number,
          issuer_name: row.issuer_name,
          issuer_title: row.issuer_title,
          registrant_name: filing.registrant_name || '—',
          registrant_cik: filing.cik || null,
          series_name: filing.series_name || null,
          series_id: filing.series_id || null,
          report_period_date: filing.report_period_date || null,
          value_usd: row.currency_value_usd,
          asset_cat: row.asset_cat,
          exposure_type: row.exposure_type,
          source_bulk_quarter: row.source_bulk_quarter,
        });
      }
      groupsByName.set(normalizedName, group);
    }

    const unresolved = Array.from(groupsByName.values())
      .map((group) => {
        const candidates = buildTriageCandidates(group.normalized_name, directory);
        return {
          normalized_name: group.normalized_name,
          raw_names: Array.from(group.raw_names).slice(0, 8),
          filer_count: group.filer_ciks.size || group.accession_numbers.size,
          accession_count: group.accession_numbers.size,
          row_count: group.row_count,
          total_value_usd: group.total_value_usd,
          total_balance: group.total_balance,
          sample_rows: group.sample_rows,
          candidates,
          suggested_action: suggestedTriageAction(group.normalized_name, candidates),
        };
      })
      .sort((a, b) => (toNumber(b.total_value_usd) || 0) - (toNumber(a.total_value_usd) || 0));

    return res.json({
      total: (data && data.length) || 0,
      page,
      pageSize,
      unresolved,
      company_directory: (directory.companies || []).map((company) => ({
        slug: company.slug,
        display_name: company.display_name,
        sector: company.sector,
        primary_domain: company.primary_domain,
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * POST /api/nport/admin/aliases
 * Body: { rawName, canonicalSlug, source?, notes?, patternType? }
 *
 * Bug 5 fix: writes to `private_company_aliases` (the actual schema
 * table), not the nonexistent `nport_issuer_aliases`. Resolves the
 * canonical slug to a private_companies.id before insert.
 */
router.post('/admin/aliases', async (req, res) => {
  if (!configGuard(res)) return;
  if (!adminGuard(req, res)) return;
  try {
    const {
      rawName,
      canonicalSlug,
      normalized_name: normalizedName,
      company_slug: companySlug,
      newCompanyName,
      new_company_name: newCompanyNameSnake,
      mark_as: markAs,
      source,
      notes,
      patternType,
      pattern_type: patternTypeSnake,
    } = req.body || {};
    if (markAs) {
      const rawPattern = rawName || normalizedName;
      if (!rawPattern || typeof rawPattern !== 'string') {
        return badRequest(res, 'rawName (string) required', 'MISSING_RAW_NAME');
      }
      if (markAs === 'sanctioned') {
        const { data, error } = await deps.nportClient
          .from('sanctioned_securities')
          .insert({ pattern: rawPattern.trim().toUpperCase(), reason: 'admin_triage' })
          .select()
          .maybeSingle();
        if (error) throw error;
        return res.status(201).json({ action: 'sanctioned', row: data });
      }
      return res.status(202).json({
        action: markAs,
        persisted: false,
        note: 'This triage action is recorded only in the UI until a durable junk/SPV review table is added.',
      });
    }
    const aliasRawName = rawName || normalizedName;
    const createName = newCompanyName || newCompanyNameSnake;
    const aliasCanonicalSlug = canonicalSlug || companySlug || slugifyCompanyName(createName);
    if (!aliasRawName || typeof aliasRawName !== 'string') {
      return badRequest(res, 'rawName (string) required', 'MISSING_RAW_NAME');
    }
    if (!aliasCanonicalSlug || typeof aliasCanonicalSlug !== 'string') {
      return badRequest(
        res,
        'canonicalSlug (string) required',
        'MISSING_CANONICAL_SLUG'
      );
    }

    // Resolve the slug to a company id.
    let company = null;
    if (createName) {
      const { data: created, error: createErr } = await deps.nportClient
        .from('private_companies')
        .insert({
          slug: aliasCanonicalSlug,
          display_name: String(createName).trim(),
          seed_source: 'manual',
          lifecycle_status: 'private',
        })
        .select('id')
        .maybeSingle();
      if (createErr) throw createErr;
      company = created;
    } else {
      const { data: existing, error: cErr } = await deps.nportClient
        .from('private_companies')
        .select('id')
        .eq('slug', aliasCanonicalSlug)
        .maybeSingle();
      if (cErr) throw cErr;
      company = existing;
    }
    if (!company) {
      return notFound(
        res,
        `Unknown canonical slug: ${aliasCanonicalSlug}`,
        'UNKNOWN_SLUG'
      );
    }

    const row = {
      company_id: company.id,
      pattern_type: patternType || patternTypeSnake || 'exact_normalized',
      pattern: aliasRawName.trim().toUpperCase(),
      source: source || 'curator',
      notes: notes || null,
    };

    const { data, error } = await deps.nportClient
      .from('private_company_aliases')
      .insert(row)
      .select()
      .maybeSingle();
    if (error) throw error;

    // Echo a friendlier shape including canonical_slug for the UI.
    return res.status(201).json({
      alias: {
        ...(data || row),
        canonical_slug: aliasCanonicalSlug,
        raw_name: aliasRawName,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * POST /api/nport/admin/refresh_resolution
 * Body: { ids?: number[], limit?: number }
 *
 * "Marks unresolved rows for re-resolution by the §5 pipeline."
 * With the actual schema we just clear `resolution_source` on the
 * targeted nport_holdings rows so the next scraper run will re-resolve
 * them. There is no needs_recheck column on this table.
 */
router.post('/admin/refresh_resolution', async (req, res) => {
  if (!configGuard(res)) return;
  if (!adminGuard(req, res)) return;
  try {
    const { ids, limit } = req.body || {};
    if (ids !== undefined && !Array.isArray(ids)) {
      return badRequest(res, 'ids must be an array of integers', 'INVALID_IDS');
    }

    let targetIds = Array.isArray(ids) && ids.length > 0
      ? Array.from(new Set(ids.map((id) => Number(id))))
      : null;
    if (targetIds) {
      if (
        targetIds.length > 500 ||
        targetIds.some((id) => !Number.isInteger(id) || id <= 0)
      ) {
        return badRequest(
          res,
          'ids must contain 1-500 positive integers',
          'INVALID_IDS'
        );
      }
    }
    if (!targetIds) {
      const cap = Number.isFinite(parseInt(limit, 10))
        ? Math.min(parseInt(limit, 10), 500)
        : null;
      if (!cap) {
        return badRequest(res, 'must provide ids[] or limit', 'MISSING_TARGET');
      }
      const { data: candidates, error: selErr } = await deps.nportClient
        .from('nport_holdings')
        .select('id')
        .or('resolution_source.is.null,resolution_source.eq.unresolved')
        .order('ingested_at', { ascending: true })
        .limit(cap);
      if (selErr) throw selErr;
      targetIds = (candidates || []).map((c) => c.id);
      if (targetIds.length === 0) {
        return res.json({ queued: 0 });
      }
    }

    const { data, error } = await deps.nportClient
      .from('nport_holdings')
      .update({
        resolution_source: null,
        resolved_company_id: null,
        resolution_confidence: null,
      })
      .in('id', targetIds)
      .select('id');
    if (error) throw error;

    return res.json({ queued: (data || []).length });
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
