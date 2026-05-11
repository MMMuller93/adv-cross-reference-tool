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
  getCrossSourceCompanyView: crossSource.getCrossSourceCompanyView,
};
router.deps = deps;

// ============================================================================
// Helpers
// ============================================================================

const READ_PAGE_DEFAULT = 100;
const READ_PAGE_MAX = 1000;

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
    const { sector, lifecycleStatus, hasRecentMarkup } = req.query;

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

    const { data: company, error: companyErr } = await deps.nportClient
      .from('private_companies')
      .select('slug')
      .eq('slug', slug)
      .maybeSingle();
    if (companyErr) throw companyErr;
    if (!company) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');

    const { data, error, count } = await deps.nportClient
      .from('nport_company_positions_mv')
      .select('*', { count: 'exact' })
      .eq('company_slug', slug)
      .order('report_period_end', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) throw error;

    return res.json({
      total: count || 0,
      page,
      pageSize,
      positions: data || [],
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * GET /api/nport/companies/:slug/holders
 * Current-period holder rollup. We compute the latest report_period_end
 * for this company on the fly (no nport_company_holders_current_mv exists).
 */
router.get('/companies/:slug/holders', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;

    const { data: company, error: companyErr } = await deps.nportClient
      .from('private_companies')
      .select('slug')
      .eq('slug', slug)
      .maybeSingle();
    if (companyErr) throw companyErr;
    if (!company) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');

    // Find latest period for this slug.
    const { data: latest, error: latestErr } = await deps.nportClient
      .from('nport_company_positions_mv')
      .select('report_period_end')
      .eq('company_slug', slug)
      .order('report_period_end', { ascending: false })
      .limit(1);
    if (latestErr) throw latestErr;
    const periodEnd =
      latest && latest.length > 0 && latest[0]
        ? latest[0].report_period_end
        : null;

    if (!periodEnd) {
      return res.json({
        company_slug: slug,
        period_end: null,
        holders: [],
      });
    }

    const { data: positions, error: posErr } = await deps.nportClient
      .from('nport_company_positions_mv')
      .select('*')
      .eq('company_slug', slug)
      .eq('report_period_end', periodEnd)
      .order('currency_value_usd', { ascending: false, nullsFirst: false });
    if (posErr) throw posErr;

    return res.json({
      company_slug: slug,
      period_end: periodEnd,
      holders: positions || [],
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
 * report_period_end. (No nport_company_timeseries_mv view exists in the
 * schema.)
 */
router.get('/companies/:slug/timeseries', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;

    const { data: company, error: companyErr } = await deps.nportClient
      .from('private_companies')
      .select('slug')
      .eq('slug', slug)
      .maybeSingle();
    if (companyErr) throw companyErr;
    if (!company) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');

    const { data: positions, error: posErr } = await deps.nportClient
      .from('nport_company_positions_mv')
      .select('report_period_end,currency_value_usd,balance,registrant_cik')
      .eq('company_slug', slug)
      .order('report_period_end', { ascending: true });
    if (posErr) throw posErr;

    // Group by period_end: total value, total balance, distinct holder count.
    const byPeriod = new Map();
    for (const row of positions || []) {
      const k = row.report_period_end;
      if (!k) continue;
      const bucket = byPeriod.get(k) || {
        report_period_end: k,
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
        total_value_usd: b.total_value_usd,
        total_balance: b.total_balance,
        holder_count: b.holder_count.size,
      }))
      .sort((a, b) =>
        a.report_period_end < b.report_period_end ? -1 : 1
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
      .select('series_id, series_name, fund_type, report_period_end')
      .in('cik', variants)
      .order('report_period_end', { ascending: false });
    if (filErr) throw filErr;

    const seriesBySid = new Map();
    for (const f of filings || []) {
      const sid = f.series_id || '';
      if (!seriesBySid.has(sid)) {
        seriesBySid.set(sid, {
          series_id: f.series_id,
          series_name: f.series_name,
          fund_type: f.fund_type,
          latest_period_end: f.report_period_end,
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
        'cik, series_id, series_name, fund_type, is_interval_fund, is_variable_insurance, report_period_end, net_assets_usd, total_assets_usd, accession_number, filing_date'
      )
      .in('cik', variants)
      .eq('series_id', seriesId)
      .order('report_period_end', { ascending: false })
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
      .order('report_period_end', { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;

    return res.json({
      total: count || 0,
      page,
      pageSize,
      cik,
      series_id: seriesId,
      positions: data || [],
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
 * Source of CRD: fund_ncen_records (investment_adviser_crd column). The
 * schema has no per-series adviser_crd column on filings; we look up
 * the most recent N-CEN for this CIK+series.
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

    // Look up the most recent N-CEN row for adviser CRD.
    const { data: ncen, error: ncenErr } = await deps.nportClient
      .from('fund_ncen_records')
      .select(
        'investment_adviser_name, investment_adviser_crd, subadviser_name, subadviser_crd, filing_date'
      )
      .in('registrant_cik', variants)
      .eq('series_id', seriesId)
      .order('filing_date', { ascending: false })
      .limit(1);
    if (ncenErr) throw ncenErr;

    const adviserCrd =
      ncen && ncen.length > 0 ? ncen[0].investment_adviser_crd : null;
    if (!adviserCrd) {
      return res.json({
        cik,
        series_id: seriesId,
        adviser_crd: null,
        adviser: null,
        note: 'No ADV cross-link resolved for this series',
      });
    }

    const { data: adviser, error: advErr } = await deps.advClient
      .from('advisers_enriched')
      .select('*')
      .eq('crd', adviserCrd)
      .maybeSingle();
    if (advErr) throw advErr;

    return res.json({
      cik,
      series_id: seriesId,
      adviser_crd: adviserCrd,
      adviser: adviser || null,
    });
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
  try {
    const { page, pageSize, offset } = parsePagination(req);

    const { data, error } = await deps.nportClient
      .from('nport_holdings')
      .select(
        'id, issuer_name, issuer_title, issuer_lei, issuer_cusip, asset_cat, resolution_source, source_bulk_quarter, ingested_at',
        { count: 'exact' }
      )
      .or('resolution_source.is.null,resolution_source.eq.unresolved')
      .order('ingested_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) throw error;

    return res.json({
      total: (data && data.length) || 0,
      page,
      pageSize,
      unresolved: data || [],
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
  try {
    const { rawName, canonicalSlug, source, notes, patternType } = req.body || {};
    if (!rawName || typeof rawName !== 'string') {
      return badRequest(res, 'rawName (string) required', 'MISSING_RAW_NAME');
    }
    if (!canonicalSlug || typeof canonicalSlug !== 'string') {
      return badRequest(
        res,
        'canonicalSlug (string) required',
        'MISSING_CANONICAL_SLUG'
      );
    }

    // Resolve the slug to a company id.
    const { data: company, error: cErr } = await deps.nportClient
      .from('private_companies')
      .select('id')
      .eq('slug', canonicalSlug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!company) {
      return notFound(
        res,
        `Unknown canonical slug: ${canonicalSlug}`,
        'UNKNOWN_SLUG'
      );
    }

    const row = {
      company_id: company.id,
      pattern_type: patternType || 'exact_normalized',
      pattern: rawName.trim().toUpperCase(),
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
        canonical_slug: canonicalSlug,
        raw_name: rawName,
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
  try {
    const { ids, limit } = req.body || {};
    if (ids !== undefined && !Array.isArray(ids)) {
      return badRequest(res, 'ids must be an array of integers', 'INVALID_IDS');
    }

    let targetIds = Array.isArray(ids) && ids.length > 0 ? ids : null;
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
