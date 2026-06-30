/**
 * Fund Holders Intel API
 *
 * Mounted at /api/intel by nport/api/server.js. Returns the lifecycle-
 * aware holder report for a single tracked company in one response,
 * suitable for direct rendering by the React SPA at /intel/:slug.
 *
 * Pulls from:
 *   - v_intel_company_holders (lifecycle + holder evidence union)
 *   - company_lifecycle_events  (transition history)
 *   - advisers_enriched         (firm contact, owners, AUM)
 *   - enriched_managers         (LinkedIn, team_members; sparse)
 *
 * Response shape documented inline below.
 */

const express = require('express');
const router = express.Router();

const nportClientModule = require('../db/nport_client');
const crossSource = require('../db/cross_source');
const { normalizeName, normalizeOwnersList } = require('../lib/name_normalizer');

const deps = {
  nportClient: nportClientModule.nportClient,
  advClient: crossSource.advClient,
  formdClient: crossSource.formdClient,
  isConfigured: nportClientModule.isConfigured,
};
router.deps = deps;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

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

function notFound(res, message = 'Not found', code = 'NOT_FOUND') {
  return res.status(404).json({ error: message, code });
}

function serverError(res, err, code = 'INTERNAL_ERROR') {
  console.error('[INTEL]', err && err.message ? err.message : err);
  return res.status(500).json({ error: err && err.message ? err.message : 'Internal error', code });
}

// Domain skip-list for canonical-website selection (matches POC3's selector).
// Codex 2026-05-20 — added discord.gg/discord.com (firms file these as
// 'primary_website' on Form ADV; SEC data is dirty). Also pinterest,
// vimeo, slideshare, glassdoor — same class of issue.
const SOCIAL_HOSTS = new Set([
  'facebook.com', 'fb.com', 'instagram.com', 'linkedin.com',
  'twitter.com', 'x.com',
  'youtube.com', 'youtu.be', 'vimeo.com',
  'reddit.com', 'threads.net', 'tiktok.com', 'mastodon.social',
  'bsky.app', 'pinterest.com', 'slideshare.net',
  'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com',
  'wix.com', 'squarespace.com',
  'github.com', 'github.io', 'gitlab.com',
  'glassdoor.com', 'indeed.com',
  'crunchbase.com', 'pitchbook.com', 'tracxn.com', 'cbinsights.com',
  'sec.gov', 'edgar.gov', 'secinfo.com', 'adviserinfo.sec.gov',
  'discord.gg', 'discord.com',
  'plynk.com',
]);

function hostOf(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url).trim().toLowerCase());
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isSocial(url) {
  const h = hostOf(url);
  if (!h) return false;
  for (const skip of SOCIAL_HOSTS) {
    if (h === skip || h.endsWith('.' + skip)) return true;
  }
  return false;
}

// Normalize a URL for display: lowercase scheme + host, preserve path/query.
// Drops 'www.' and trailing slash on bare-host URLs for tidiness.
function normalizeUrlForDisplay(url) {
  if (!url) return url;
  try {
    const u = new URL(String(url).trim());
    const scheme = u.protocol.toLowerCase().replace(':', '');
    const host = u.hostname.toLowerCase();
    let path = u.pathname || '';
    if (path === '/') path = '';
    const tail = (u.search || '') + (u.hash || '');
    return `${scheme}://${host}${path}${tail}`;
  } catch {
    return url;
  }
}

/**
 * Pick the best website for an adviser, in order:
 *   1. enriched_managers.website_url (validator-cleaned; preferred)
 *   2. advisers_enriched.primary_website (if not in SOCIAL_HOSTS)
 *   3. first non-social entry in advisers_enriched.other_websites
 *   4. null
 *
 * Returns null instead of a social/aggregator URL — better to show
 * nothing than to point users at a Discord invite.
 */
function pickCanonicalDomain(primary, others, enrichedWebsite) {
  if (enrichedWebsite && !isSocial(enrichedWebsite)) {
    return normalizeUrlForDisplay(enrichedWebsite);
  }
  if (primary && !isSocial(primary)) return normalizeUrlForDisplay(primary);
  const list = [];
  if (Array.isArray(others)) {
    list.push(...others);
  } else if (typeof others === 'string') {
    // Split by ; or , as PFR stores other_websites inconsistently
    if (others.includes(';')) list.push(...others.split(';').map(s => s.trim()));
    else if (others.includes(',')) list.push(...others.split(',').map(s => s.trim()));
    else if (others.trim()) list.push(others.trim());
  }
  for (const url of list) {
    if (url && !isSocial(url)) return normalizeUrlForDisplay(url);
  }
  // Everything is social — return null rather than a Discord invite.
  return null;
}

// Keyset-paginated fetch from v_intel_company_holders for one source_type.
async function paginateHolders(nportClient, companySlug, sourceType) {
  const rows = [];
  let lastId = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await nportClient
      .from('v_intel_company_holders')
      .select('*')
      .eq('company_slug', companySlug)
      .eq('source_type', sourceType)
      .gt('evidence_id', lastId)
      .order('evidence_id')
      .limit(pageSize);
    if (error) throw error;
    const batch = data || [];
    if (!batch.length) break;
    rows.push(...batch);
    lastId = parseInt(batch[batch.length - 1].evidence_id, 10);
    if (batch.length < pageSize) break;
  }
  return rows;
}

// Chunked .in_() helper — Supabase URL length caps the in-list size.
async function fetchAdviserDetails(advClient, crds) {
  if (!crds || crds.length === 0) return {};
  const unique = Array.from(new Set(crds.map(c => String(c).trim()).filter(Boolean)));
  const cols = [
    'crd', 'adviser_name', 'total_aum', 'phone_number', 'primary_website',
    'other_websites', 'cco_name', 'cco_email', 'signatory_name',
    'signatory_title', 'form_adv_url',
    'owner_full_legal_name', 'owner_title_or_status', 'ownership_amount',
    'direct_or_indirect_owner',
    'control_person_name', 'regulatory_contact_name', 'regulatory_contact_email',
  ].join(',');
  const out = {};
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data, error } = await advClient
      .from('advisers_enriched')
      .select(cols)
      .in('crd', chunk);
    if (error) throw error;
    for (const row of (data || [])) out[String(row.crd)] = row;
  }
  return out;
}

/**
 * Build an owners-with-titles array from the parallel semicolon-separated
 * Form ADV columns. Mirrors PFR's AdviserDetailView logic.
 *
 * Input fields (all may have ';' delimiters):
 *   owner_full_legal_name      'OESTREICHER, DAVID, NMN;Sharps, Robert, W;...'
 *   owner_title_or_status      'CHIEF LEGAL OFFICER;PRESIDENT;...'
 *   ownership_amount           '5% or less;10% to 25%;...'
 *   direct_or_indirect_owner   'D;D;I;...'
 *
 * Returns [{name, title, ownership_amount, owner_type}, ...]. Names are
 * normalized via normalizeName so 'OESTREICHER, DAVID, NMN' becomes
 * 'David Oestreicher'.
 */
function parseOwnersWithDetails(adv) {
  if (!adv) return [];
  const split = (s) => (s ? String(s).split(';').map(t => t.trim()) : []);
  const names = split(adv.owner_full_legal_name || adv.owner_legal_name);
  const titles = split(adv.owner_title_or_status);
  const amounts = split(adv.ownership_amount);
  const types = split(adv.direct_or_indirect_owner);
  // Use the longest array so we don't accidentally truncate
  const n = Math.max(names.length, titles.length, amounts.length, types.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const rawName = names[i] || '';
    if (!rawName) continue;
    const normalized = normalizeName(rawName) || rawName;
    out.push({
      name: normalized,
      title: titles[i] || null,
      ownership_amount: amounts[i] || null,
      owner_type: types[i] === 'D' ? 'Direct' : (types[i] === 'I' ? 'Indirect' : (types[i] || null)),
    });
  }
  return out;
}


/**
 * Aggregate service providers across an adviser's funds. Mirrors PFR's
 * AdviserDetailView serviceProviders memo: walks funds_enriched rows for
 * the CRD, splits each provider field on ';', dedupes case-insensitively.
 *
 * Returns: { auditors: [...], administrators: [...], custodians: [...],
 *            prime_brokers: [...] }
 */
async function fetchServiceProviders(advClient, crd) {
  if (!crd) return null;
  // Real funds_enriched column names (verified 2026-05-21):
  //   auditing_firm_name, administrator_name, custodians, prime_broker_name
  const cols = 'auditing_firm_name,administrator_name,custodians,prime_broker_name';
  // Pull funds for this CRD. Keyset-paginate in case the firm has >1000 funds.
  const sets = {
    auditors: new Map(),
    administrators: new Map(),
    custodians: new Map(),
    prime_brokers: new Map(),
  };
  let lastRef = 0;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await advClient
      .from('funds_enriched')
      .select('reference_id,' + cols)
      .eq('adviser_entity_crd', crd)
      .gt('reference_id', lastRef)
      .order('reference_id')
      .limit(1000);
    if (error) {
      console.warn('[INTEL] funds_enriched fetch failed:', error.message);
      return null;
    }
    if (!data || data.length === 0) break;
    const splitSemi = (s) => (s ? String(s).split(';').map(t => t.trim()).filter(Boolean) : []);
    for (const row of data) {
      for (const name of splitSemi(row.auditing_firm_name)) {
        sets.auditors.set(name.toLowerCase(), name);
      }
      for (const name of splitSemi(row.administrator_name)) {
        sets.administrators.set(name.toLowerCase(), name);
      }
      for (const name of splitSemi(row.custodians)) {
        // Skip boolean-flag escapes that occasionally land in this column
        if (name && name.length > 1 && !'YyNn'.includes(name)) {
          sets.custodians.set(name.toLowerCase(), name);
        }
      }
      for (const name of splitSemi(row.prime_broker_name)) {
        if (name && name.length > 1 && !'YyNn'.includes(name)) {
          sets.prime_brokers.set(name.toLowerCase(), name);
        }
      }
    }
    if (data.length < 1000) break;
    lastRef = data[data.length - 1].reference_id;
  }
  return {
    auditors: [...sets.auditors.values()],
    administrators: [...sets.administrators.values()],
    custodians: [...sets.custodians.values()],
    prime_brokers: [...sets.prime_brokers.values()],
  };
}


async function fetchPersonEnrichment(nportClient, crds) {
  // Returns { [crd]: { [normalized_name]: { linkedin_url, inferred_title, confidence } } }
  // Reads v_intel_person_enrichment (migration 007). Returns {} if the table/
  // view doesn't exist yet — the migration may not be applied.
  if (!crds || crds.length === 0) return {};
  const unique = Array.from(new Set(crds.map(c => String(c).trim()).filter(Boolean)));
  const out = {};
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data, error } = await nportClient
      .from('v_intel_person_enrichment')
      .select('adviser_crd,normalized_name,linkedin_url,inferred_title,confidence,role_hint')
      .in('adviser_crd', chunk);
    if (error) {
      // Pre-migration: log once and bail. Don't fail the whole intel request.
      console.warn('[INTEL] v_intel_person_enrichment unavailable:', error.message);
      return out;
    }
    for (const row of (data || [])) {
      const crd = String(row.adviser_crd);
      if (!out[crd]) out[crd] = {};
      out[crd][row.normalized_name] = {
        linkedin_url: row.linkedin_url,
        inferred_title: row.inferred_title,
        confidence: row.confidence,
        role_hint: row.role_hint,
      };
    }
  }
  return out;
}

async function fetchEnrichedExtras(formdClient, crds) {
  if (!formdClient || !crds || crds.length === 0) return {};
  const unique = Array.from(new Set(crds.map(c => String(c).trim()).filter(Boolean)));
  const out = {};
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data, error } = await formdClient
      .from('enriched_managers')
      .select('linked_crd,website_url,linkedin_company_url,team_members,primary_contact_email,twitter_handle')
      .in('linked_crd', chunk);
    if (error) {
      // enriched_managers is optional; log and continue
      console.warn('[INTEL] enriched_managers fetch failed:', error.message);
      return out;
    }
    for (const row of (data || [])) {
      const k = String(row.linked_crd || '');
      if (k && !out[k]) out[k] = row;
    }
  }
  return out;
}

/**
 * Normalize PFR's enrichment_engine_v2 team_members payload into a
 * structured array the frontend can render person-by-person.
 *
 * Each element: { name, title, linkedin, email }. Drops empty entries
 * and entries whose name was rejected by the same heuristics the
 * Python enrichment_validator uses (corporate strings, header-style
 * all-caps blobs, etc.).
 *
 * Returns null if no usable members remain.
 */
function teamMembersToStructured(value, firmName) {
  if (!value) return null;
  let arr;
  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === 'string') {
    // Legacy stringified form — try to JSON.parse, otherwise split on ';'
    try {
      const parsed = JSON.parse(value);
      arr = Array.isArray(parsed) ? parsed : null;
    } catch {
      arr = value.split(';').map(s => ({ name: s.trim() }));
    }
  }
  if (!Array.isArray(arr)) return null;

  // Reject blatantly-corporate name strings the engine sometimes emits
  // (e.g., 'Capital Research Management (...long description...)').
  const isLikelyCorporate = (name) => {
    if (!name) return true;
    const upper = name.toUpperCase();
    const corp = /\b(INC|INC\.|LLC|LP|L\.P\.|CORP|CORPORATION|HOLDINGS|TRUST|FUND|FUNDS|MANAGEMENT|ADVISORS|ADVISERS|PARTNERS|ASSOCIATES|GROUP|COMPANY|CO\.?|LTD|LIMITED)\b/;
    if (corp.test(upper) && name.split(' ').length >= 3) return true;
    // 4+ token ALL CAPS without lower → looks like a header
    if (name.split(' ').length >= 4 && !/[a-z]/.test(name)) return true;
    return false;
  };

  const out = [];
  const seenNames = new Set();
  for (const m of arr) {
    if (!m || typeof m !== 'object') continue;
    const name = (m.name || '').trim();
    if (!name) continue;
    if (isLikelyCorporate(name)) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    out.push({
      name,
      title: (m.role || m.title || '').trim() || null,
      linkedin: m.linkedin || m.linkedin_url || null,
      email: m.email || null,
    });
  }
  return out.length ? out : null;
}

// Kept for callers that want the legacy joined-string form.
function teamMembersToText(value) {
  const structured = teamMembersToStructured(value);
  if (!structured) return null;
  return structured.map(m => m.title ? `${m.name} (${m.title})` : m.name).join('; ');
}

// ============================================================================
// Cross-cutting routes (added 2026-05-26, Direction B Phase 3)
//
// These power the rail's Modules section:
//   - /api/intel/companies               → AllCompaniesPage
//   - /api/intel/dashboard               → DashboardPage (recent activity)
//   - /api/intel/managers-rollup         → AllManagersPage
//   - /api/intel/spvs-rollup             → AllSpvsPage
//   - /api/intel/funds-rollup            → AllFundsPage
// ============================================================================

// --- GET /api/intel/companies — all tracked companies + holder counts ------
router.get('/companies', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    // 1. All companies, paginated. 843 rows; keyset by created_at to be safe.
    const companies = [];
    let lastId = '';
    while (true) {
      let q = deps.nportClient.from('private_companies')
        .select('slug,display_name,sector,founded_year,primary_domain,latest_known_valuation_usd,latest_known_valuation_date,most_recent_round,most_recent_round_date,lifecycle_status,is_public,is_acquired,hq_country,hq_state,total_funding_usd')
        .order('slug')
        .limit(1000);
      if (lastId) q = q.gt('slug', lastId);
      const { data, error } = await q;
      if (error) throw error;
      const batch = data || [];
      if (!batch.length) break;
      companies.push(...batch);
      lastId = batch[batch.length - 1].slug;
      if (batch.length < 1000) break;
    }

    // 2. Aggregate holder counts per company from v_intel_company_holders.
    //    Single pass; cheap because the view is already indexed by company_slug.
    const counts = {}; // slug → { nport, formd, distinctAdvisers (set), totalHeldUsd }
    let pageStart = 0;
    while (true) {
      const { data, error } = await deps.nportClient
        .from('v_intel_company_holders')
        .select('company_slug,source_type,value_usd,adviser_crd,discovered_manager_id,evidence_id,status_at_evidence_date')
        .gt('evidence_id', pageStart)
        .order('evidence_id')
        .limit(1000);
      if (error) throw error;
      const batch = data || [];
      if (!batch.length) break;
      for (const r of batch) {
        // Default: count only when company was private at evidence date,
        // mirroring the per-company holders endpoint's audit-off default.
        if (r.status_at_evidence_date && r.status_at_evidence_date !== 'private' && r.status_at_evidence_date !== 'unknown') continue;
        const slug = r.company_slug;
        if (!counts[slug]) counts[slug] = { nport: 0, formd: 0, advisers: new Set(), totalHeldUsd: 0 };
        if (r.source_type === 'nport') counts[slug].nport++;
        if (r.source_type === 'formd_pooled_vehicle') counts[slug].formd++;
        if (r.adviser_crd) counts[slug].advisers.add(r.adviser_crd);
        if (r.discovered_manager_id) counts[slug].advisers.add('d:' + r.discovered_manager_id);
        if (r.value_usd) counts[slug].totalHeldUsd += parseFloat(r.value_usd);
      }
      pageStart = parseInt(batch[batch.length - 1].evidence_id, 10);
      if (batch.length < 1000) break;
    }

    // 3. Annotate companies with their counts (0 if no evidence yet).
    const rows = companies.map(c => {
      const k = counts[c.slug] || null;
      return {
        ...c,
        latest_known_valuation_usd: c.latest_known_valuation_usd ? parseFloat(c.latest_known_valuation_usd) : null,
        nport_count: k ? k.nport : 0,
        formd_count: k ? k.formd : 0,
        distinct_advisers: k ? k.advisers.size : 0,
        total_held_usd: k ? k.totalHeldUsd : 0,
      };
    });

    return res.json({
      total: rows.length,
      total_with_evidence: rows.filter(r => r.distinct_advisers > 0).length,
      companies: rows,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/dashboard — recent activity feed -----------------------
router.get('/dashboard', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

    // Recent Form D pooled-vehicle offerings across all companies.
    const { data: recentFormd, error: e1 } = await deps.nportClient
      .from('intel_formd_pooled_vehicle_offering')
      .select('company_slug,filer_entityname,filing_date,total_offering_amount,accession_number,filer_cik')
      .order('filing_date', { ascending: false })
      .limit(limit);
    if (e1) throw e1;

    // Recent lifecycle events.
    const { data: recentEvents, error: e2 } = await deps.nportClient
      .from('company_lifecycle_events')
      .select('company_slug,event_date,event_type,status_after,source_name,source_url,notes')
      .order('event_date', { ascending: false })
      .limit(limit);
    if (e2) throw e2;

    // Look up display names for the slugs referenced.
    const allSlugs = Array.from(new Set([
      ...(recentFormd || []).map(r => r.company_slug),
      ...(recentEvents || []).map(r => r.company_slug),
    ]));
    const companyMeta = {};
    if (allSlugs.length) {
      for (let i = 0; i < allSlugs.length; i += 200) {
        const chunk = allSlugs.slice(i, i + 200);
        const { data, error } = await deps.nportClient
          .from('private_companies')
          .select('slug,display_name,sector')
          .in('slug', chunk);
        if (error) throw error;
        for (const row of (data || [])) companyMeta[row.slug] = row;
      }
    }

    // Merge into a single activity stream sorted by date.
    const activity = [
      ...(recentFormd || []).map(r => ({
        kind: 'form_d',
        date: r.filing_date,
        company_slug: r.company_slug,
        company_name: (companyMeta[r.company_slug] || {}).display_name || r.company_slug,
        title: r.filer_entityname,
        value_usd: r.total_offering_amount ? parseFloat(r.total_offering_amount) : null,
        accession_number: r.accession_number,
      })),
      ...(recentEvents || []).map(r => ({
        kind: 'lifecycle',
        date: r.event_date,
        company_slug: r.company_slug,
        company_name: (companyMeta[r.company_slug] || {}).display_name || r.company_slug,
        title: r.event_type,
        status_after: r.status_after,
        source_name: r.source_name,
        source_url: r.source_url,
        notes: r.notes,
      })),
    ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    return res.json({
      activity: activity.slice(0, limit),
      counts: {
        total_companies: Object.keys(companyMeta).length,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/managers-rollup — all managers across all companies ---
router.get('/managers-rollup', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    // Aggregate intel_adviser_resolution + v_intel_company_holders to build
    // a per-CRD rollup: total exposure $, # companies, # filings, top company.
    const rollup = {}; // crd → { name, totalUsd, companies (set), filings, topCompany, topUsd }
    let pageStart = 0;
    while (true) {
      const { data, error } = await deps.nportClient
        .from('v_intel_company_holders')
        .select('company_slug,adviser_crd,value_usd,evidence_id,status_at_evidence_date')
        .not('adviser_crd', 'is', null)
        .gt('evidence_id', pageStart)
        .order('evidence_id')
        .limit(1000);
      if (error) throw error;
      const batch = data || [];
      if (!batch.length) break;
      for (const r of batch) {
        if (r.status_at_evidence_date && r.status_at_evidence_date !== 'private' && r.status_at_evidence_date !== 'unknown') continue;
        const crd = String(r.adviser_crd);
        if (!rollup[crd]) rollup[crd] = { crd, totalUsd: 0, companies: new Set(), filings: 0, perCompany: {} };
        const v = r.value_usd ? parseFloat(r.value_usd) : 0;
        rollup[crd].totalUsd += v;
        rollup[crd].companies.add(r.company_slug);
        rollup[crd].filings++;
        rollup[crd].perCompany[r.company_slug] = (rollup[crd].perCompany[r.company_slug] || 0) + v;
      }
      pageStart = parseInt(batch[batch.length - 1].evidence_id, 10);
      if (batch.length < 1000) break;
    }

    // Resolve adviser names + AUM via ADV.
    const crds = Object.keys(rollup);
    const adviserDetails = await fetchAdviserDetails(deps.advClient, crds);
    const companyMeta = {};
    const allCompanySlugs = Array.from(new Set(Object.values(rollup).flatMap(r => Array.from(r.companies))));
    for (let i = 0; i < allCompanySlugs.length; i += 200) {
      const chunk = allCompanySlugs.slice(i, i + 200);
      const { data, error } = await deps.nportClient
        .from('private_companies').select('slug,display_name').in('slug', chunk);
      if (error) throw error;
      for (const row of (data || [])) companyMeta[row.slug] = row;
    }

    const rows = crds.map(crd => {
      const r = rollup[crd];
      const adv = adviserDetails[crd] || {};
      const topEntry = Object.entries(r.perCompany).sort((a, b) => b[1] - a[1])[0] || [null, 0];
      return {
        crd,
        name: adv.adviser_name || `(CRD ${crd})`,
        total_aum: adv.total_aum ? parseFloat(adv.total_aum) : null,
        total_held_usd: r.totalUsd,
        company_count: r.companies.size,
        filing_count: r.filings,
        top_company_slug: topEntry[0],
        top_company_name: topEntry[0] ? ((companyMeta[topEntry[0]] || {}).display_name || topEntry[0]) : null,
        top_company_usd: topEntry[1],
      };
    }).sort((a, b) => b.total_held_usd - a.total_held_usd);

    return res.json({ total: rows.length, managers: rows });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/spvs-rollup — all Form D SPVs across all companies ----
router.get('/spvs-rollup', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const all = [];
    let pageStart = 0;
    while (true) {
      const { data, error } = await deps.nportClient
        .from('intel_formd_pooled_vehicle_offering')
        .select('offering_id,company_slug,filer_entityname,filing_date,total_offering_amount,filer_cik,accession_number,match_method')
        .gt('offering_id', pageStart)
        .order('offering_id')
        .limit(1000);
      if (error) throw error;
      const batch = data || [];
      if (!batch.length) break;
      all.push(...batch);
      pageStart = parseInt(batch[batch.length - 1].offering_id, 10);
      if (batch.length < 1000) break;
    }

    const slugs = Array.from(new Set(all.map(r => r.company_slug)));
    const companyMeta = {};
    for (let i = 0; i < slugs.length; i += 200) {
      const { data } = await deps.nportClient.from('private_companies').select('slug,display_name').in('slug', slugs.slice(i, i + 200));
      for (const row of (data || [])) companyMeta[row.slug] = row;
    }

    // Apply the same self-fund filter we do on the per-company holders route.
    const SELF_FUND_PATTERNS = { openai: [/openai\s+startup\s+fund/i] };
    const filtered = all.filter(r => {
      const pats = SELF_FUND_PATTERNS[String(r.company_slug || '').toLowerCase()] || [];
      const label = r.filer_entityname || '';
      return !pats.some(re => re.test(label));
    });

    return res.json({
      total: filtered.length,
      spvs: filtered.map(r => ({
        offering_id: r.offering_id,
        company_slug: r.company_slug,
        company_name: (companyMeta[r.company_slug] || {}).display_name || r.company_slug,
        filer_entityname: r.filer_entityname,
        filer_cik: r.filer_cik,
        accession_number: r.accession_number,
        filing_date: r.filing_date,
        offering_usd: r.total_offering_amount ? parseFloat(r.total_offering_amount) : null,
        match_method: r.match_method,
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/funds-rollup — N-PORT funds across all companies ------
router.get('/funds-rollup', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    // Aggregate by (registrant_cik, series_id) — each unique fund.
    const fundRollup = {}; // key → { cik, series_id, label, companies, totalUsd, positions }
    let pageStart = 0;
    while (true) {
      const { data, error } = await deps.nportClient
        .from('intel_nport_position')
        .select('position_id,company_slug,registrant_cik,series_id,issuer_title,value_usd,as_of_date')
        .gt('position_id', pageStart)
        .order('position_id')
        .limit(1000);
      if (error) throw error;
      const batch = data || [];
      if (!batch.length) break;
      for (const r of batch) {
        const key = `${r.registrant_cik}|${r.series_id || ''}`;
        if (!fundRollup[key]) {
          fundRollup[key] = {
            cik: r.registrant_cik,
            series_id: r.series_id,
            companies: new Set(),
            totalUsd: 0,
            positions: 0,
            adviser_crd: null,
          };
        }
        fundRollup[key].companies.add(r.company_slug);
        fundRollup[key].totalUsd += r.value_usd ? parseFloat(r.value_usd) : 0;
        fundRollup[key].positions++;
      }
      pageStart = parseInt(batch[batch.length - 1].position_id, 10);
      if (batch.length < 1000) break;
    }

    // Note: adviser CRD for each fund comes from a join through
    // intel_adviser_resolution (one row per position bridged to a CRD).
    // For v1 we skip that join; adviser_name will come from a follow-up
    // batch query in a later iteration. Funds rollup currently shows fund
    // identity + reach (positions, companies, held $).

    const rows = Object.entries(fundRollup).map(([key, f]) => ({
      key,
      cik: f.cik,
      series_id: f.series_id,
      total_held_usd: f.totalUsd,
      position_count: f.positions,
      company_count: f.companies.size,
      adviser_crd: null,
      adviser_name: null,
    })).sort((a, b) => b.total_held_usd - a.total_held_usd);

    return res.json({ total: rows.length, funds: rows });
  } catch (err) {
    return serverError(res, err);
  }
});

// ----------------------------------------------------------------------------
// GET /api/intel/companies/:slug/holders
// ----------------------------------------------------------------------------

// --- GET /api/intel/timeline — recent company lifecycle events --------------
router.get('/timeline', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { data: events, error } = await deps.nportClient
      .from('company_lifecycle_events')
      .select('event_date,event_type,status_after,company_slug,source_name,source_url')
      .order('event_date', { ascending: false })
      .limit(500);
    if (error) throw error;
    const slugs = Array.from(new Set((events || []).map(e => e.company_slug).filter(Boolean)));
    const nameBySlug = {};
    for (let i = 0; i < slugs.length; i += 200) {
      const { data } = await deps.nportClient
        .from('private_companies').select('slug,display_name').in('slug', slugs.slice(i, i + 200));
      for (const c of (data || [])) nameBySlug[c.slug] = c.display_name;
    }
    const rows = (events || []).map(e => ({ ...e, company_name: nameBySlug[e.company_slug] || e.company_slug }));
    return res.json({ total: rows.length, events: rows });
  } catch (err) { return serverError(res, err); }
});

// --- GET /api/intel/people — CCOs/signatories at firms holding tracked cos --
router.get('/people', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const crdSet = new Set();
    let pageStart = 0;
    while (true) {
      const { data, error } = await deps.nportClient
        .from('v_intel_company_holders')
        .select('adviser_crd,evidence_id')
        .not('adviser_crd', 'is', null)
        .gt('evidence_id', pageStart)
        .order('evidence_id')
        .limit(1000);
      if (error) throw error;
      const batch = data || [];
      if (!batch.length) break;
      for (const r of batch) crdSet.add(String(r.adviser_crd));
      pageStart = parseInt(batch[batch.length - 1].evidence_id, 10);
      if (batch.length < 1000) break;
    }
    const crds = Array.from(crdSet);
    const details = await fetchAdviserDetails(deps.advClient, crds);
    const people = [];
    const seen = new Set();
    for (const crd of crds) {
      const adv = details[crd] || {};
      const firm = adv.adviser_name || `(CRD ${crd})`;
      const cco = normalizeName(adv.cco_name);
      const sig = normalizeName(adv.signatory_name);
      if (cco) { const k = `${cco}|${crd}|CCO`; if (!seen.has(k)) { seen.add(k); people.push({ name: cco, role: 'CCO', firm, crd, email: adv.cco_email || null, title: 'Chief Compliance Officer' }); } }
      if (sig && sig !== cco) { const k = `${sig}|${crd}|SIG`; if (!seen.has(k)) { seen.add(k); people.push({ name: sig, role: 'Signatory', firm, crd, email: null, title: adv.signatory_title || null }); } }
    }
    people.sort((a, b) => String(a.firm).localeCompare(String(b.firm)) || String(a.name).localeCompare(String(b.name)));
    return res.json({ total: people.length, people });
  } catch (err) { return serverError(res, err); }
});

router.get('/companies/:slug/holders', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: 'slug required', code: 'MISSING_SLUG' });
    const audit = req.query.audit === '1' || req.query.audit === 'true';

    // 1. Company metadata
    const { data: companyRow, error: compErr } = await deps.nportClient
      .from('private_companies')
      .select('slug,display_name,lifecycle_status,is_public,is_acquired,primary_domain,legal_entities,sector,founded_year,latest_known_valuation_usd,latest_known_valuation_date,most_recent_round,most_recent_round_date,description')
      .eq('slug', slug)
      .maybeSingle();
    if (compErr) throw compErr;
    if (!companyRow) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');

    // 2. Lifecycle events for this company
    const { data: eventRows, error: evErr } = await deps.nportClient
      .from('company_lifecycle_events')
      .select('event_date,event_type,status_after,source_name,source_url,confidence,notes')
      .eq('company_slug', slug)
      .order('event_date');
    if (evErr) throw evErr;

    // 3. Current status (most-recent event's status_after, falls back to seed flag)
    const { data: currentRow } = await deps.nportClient
      .from('v_company_current_lifecycle')
      .select('current_status,last_event_date,last_event_type')
      .eq('company_slug', slug)
      .maybeSingle();
    const currentStatus = (currentRow && currentRow.current_status)
      || (companyRow.is_public ? 'public' : (companyRow.is_acquired ? 'acquired' : 'private'));

    // 4. Holder evidence (filtered by lifecycle eligibility unless ?audit=1)
    let nportRows = await paginateHolders(deps.nportClient, slug, 'nport');
    let formdRows = await paginateHolders(deps.nportClient, slug, 'formd_pooled_vehicle');

    // Self-fund exclusion: drop filings BY a fund-of vehicle owned by the
    // tracked company itself. E.g. "OpenAI Startup Fund SPV N, L.P." is
    // OpenAI's own VC arm that invests IN startups — NOT a holder OF
    // OpenAI. Same pattern likely applies to any company that operates
    // a strategic-investment subsidiary. Hardcoded per company; mirror of
    // intelligence/materialize_holders.py NEGATIVE_PATTERNS_BY_COMPANY.
    // Filter at source so both `annotatedFormd` and the adviser rollup
    // see the filtered set.
    const SELF_FUND_PATTERNS = {
      openai: [/openai\s+startup\s+fund/i],
      // anthropic: [/anthropic\s+capital\s+fund/i],  // already in materializer denylist
    };
    const selfFundRegexes = SELF_FUND_PATTERNS[slug.toLowerCase()] || [];
    if (selfFundRegexes.length) {
      const beforeFormd = formdRows.length;
      const beforeNport = nportRows.length;
      const isSelf = (r) => {
        const label = r.evidence_label || '';
        return selfFundRegexes.some(re => re.test(label));
      };
      formdRows = formdRows.filter(r => !isSelf(r));
      nportRows = nportRows.filter(r => !isSelf(r));
      const removed = (beforeFormd - formdRows.length) + (beforeNport - nportRows.length);
      if (removed > 0) {
        console.log(`[INTEL holders] ${slug}: filtered ${removed} self-fund rows (e.g. OpenAI Startup Fund SPVs invest IN startups, not held BY external)`);
      }
    }

    let allRows = [...nportRows, ...formdRows];
    if (!audit) {
      allRows = allRows.filter(r => r.status_at_evidence_date === 'private' || r.status_at_evidence_date === 'unknown');
    }

    // 5. Adviser details (one call covering both N-PORT + Form D resolved advisers)
    const crds = Array.from(new Set(allRows.map(r => r.adviser_crd).filter(Boolean)));
    const adviserDetails = await fetchAdviserDetails(deps.advClient, crds);
    const enrichedExtras = await fetchEnrichedExtras(deps.formdClient, crds);
    const personEnrichment = await fetchPersonEnrichment(deps.nportClient, crds);

    // 6. Build adviser rollup: one entry per distinct CRD, with total $ value
    //    and evidence count across both source types
    const adviserRollup = {};
    for (const row of allRows) {
      const crd = row.adviser_crd;
      if (!crd) continue;
      const key = String(crd);
      if (!adviserRollup[key]) {
        const adv = adviserDetails[key] || {};
        const extras = enrichedExtras[key] || {};
        adviserRollup[key] = {
          crd: key,
          name: adv.adviser_name || null,
          total_aum: adv.total_aum || null,
          phone: adv.phone_number || null,
          website: pickCanonicalDomain(adv.primary_website, adv.other_websites, extras.website_url),
          cco_name: normalizeName(adv.cco_name),
          cco_email: adv.cco_email || null,
          signatory_name: normalizeName(adv.signatory_name),
          signatory_title: adv.signatory_title || null,
          // Raw owner blob kept for backwards-compat; new `owners` array is
          // the parsed/normalized list the frontend should use.
          owner_full_legal_name: adv.owner_full_legal_name || null,
          owners: normalizeOwnersList(adv.owner_full_legal_name),
          owner_title_or_status: adv.owner_title_or_status || null,
          ownership_amount: adv.ownership_amount || null,
          control_person_name: normalizeName(adv.control_person_name),
          regulatory_contact_name: normalizeName(adv.regulatory_contact_name),
          regulatory_contact_email: adv.regulatory_contact_email || null,
          // Per-person LinkedIn / title enrichment, keyed by normalized name.
          // Populated by intelligence/enrich_people.py; empty {} when the
          // table is unmigrated or no rows exist for this firm yet.
          person_enrichment: personEnrichment[key] || {},
          form_adv_url: adv.form_adv_url || null,
          linkedin_company_url: extras.linkedin_company_url || null,
          // Structured: array of {name, title, linkedin, email}. The frontend
          // renders per-person LinkedIn icons + emails from this. Kept the
          // back-compat text form on team_members_text for older consumers.
          team_members: teamMembersToStructured(extras.team_members),
          team_members_text: teamMembersToText(extras.team_members) || null,
          alt_contact_email: extras.primary_contact_email || null,
          twitter_handle: extras.twitter_handle || null,
          evidence_count: 0,
          total_value_usd: 0,
        };
      }
      adviserRollup[key].evidence_count += 1;
      const v = row.value_usd ? parseFloat(row.value_usd) : 0;
      if (Number.isFinite(v)) adviserRollup[key].total_value_usd += v;
    }
    const advisers = Object.values(adviserRollup).sort(
      (a, b) => (b.total_value_usd || 0) - (a.total_value_usd || 0)
    );

    // 7. Split returned rows into N-PORT vs Form D buckets for the UI tables
    const annotatedNport = nportRows
      .filter(r => audit || r.status_at_evidence_date === 'private' || r.status_at_evidence_date === 'unknown')
      .map(r => {
        const crdName = (adviserRollup[r.adviser_crd] || {}).name || null;
        return {
          evidence_id: r.evidence_id,
          registrant_cik: r.evidence_cik,
          series_id: r.evidence_series_id,
          issuer_title: r.evidence_label,
          value_usd: r.value_usd ? parseFloat(r.value_usd) : null,
          evidence_date: r.evidence_date,
          accession_number: r.accession_number,
          adviser_crd: r.adviser_crd || null,
          adviser_name: crdName,
          adviser_method: r.adviser_resolution_method,
          status_at_evidence_date: r.status_at_evidence_date,
          was_private_at_evidence_date: r.was_private_at_evidence_date,
          // Structured manager object. N-PORT rows always resolve via CRD.
          manager: r.adviser_crd
            ? { kind: 'crd', name: crdName, crd: r.adviser_crd, discovered_manager_id: null, url: `/intel/adviser/${encodeURIComponent(r.adviser_crd)}`, confidence: null }
            : { kind: 'unknown', name: null, crd: null, discovered_manager_id: null, url: null, confidence: null },
        };
      })
      .sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0));

    const annotatedFormd = formdRows
      .filter(r => audit || r.status_at_evidence_date === 'private' || r.status_at_evidence_date === 'unknown')
      .map(r => {
        const crdName = (adviserRollup[r.adviser_crd] || {}).name || null;
        // For discovered-manager rows, populate adviser_name from the discovered
        // manager so legacy callers that read only adviser_name get a display name.
        const adviserName = r.adviser_crd ? crdName : (r.discovered_manager_id ? r.discovered_manager_name : null);
        return {
          evidence_id: r.evidence_id,
          filer_cik: r.evidence_cik,
          filer_entityname: r.evidence_label,
          value_usd: r.value_usd ? parseFloat(r.value_usd) : null,
          filing_date: r.evidence_date,
          accession_number: r.accession_number,
          adviser_crd: r.adviser_crd || null,
          adviser_name: adviserName,
          adviser_method: r.adviser_resolution_method,
          status_at_evidence_date: r.status_at_evidence_date,
          was_private_at_evidence_date: r.was_private_at_evidence_date,
          // Structured manager object — one of three kinds:
          //   'crd'        — resolved to a registered adviser (adviser_crd set)
          //   'discovered' — matched to enriched_managers (non-CRD VC/PE firm)
          //   'unknown'    — no resolution found for this filing
          manager: r.adviser_crd
            ? { kind: 'crd', name: crdName, crd: r.adviser_crd, discovered_manager_id: null, url: `/intel/adviser/${encodeURIComponent(r.adviser_crd)}`, confidence: null }
            : r.discovered_manager_id
            ? { kind: 'discovered', name: r.discovered_manager_name, crd: null, discovered_manager_id: r.discovered_manager_id, url: `/intel/discovered/${encodeURIComponent(r.discovered_manager_id)}`, confidence: r.adviser_resolution_method || null }
            : { kind: 'unknown', name: null, crd: null, discovered_manager_id: null, url: null, confidence: null },
        };
      })
      .sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0));

    return res.json({
      company: {
        slug: companyRow.slug,
        display_name: companyRow.display_name,
        sector: companyRow.sector,
        founded_year: companyRow.founded_year,
        primary_domain: companyRow.primary_domain,
        latest_known_valuation_usd: companyRow.latest_known_valuation_usd,
        most_recent_round: companyRow.most_recent_round,
        most_recent_round_date: companyRow.most_recent_round_date,
        legal_entities: companyRow.legal_entities,
        description: companyRow.description,
      },
      lifecycle: {
        seed_status: companyRow.lifecycle_status,
        is_public_seed: companyRow.is_public,
        is_acquired_seed: companyRow.is_acquired,
        current_status: currentStatus,
        last_event_date: currentRow ? currentRow.last_event_date : null,
        last_event_type: currentRow ? currentRow.last_event_type : null,
        events: eventRows || [],
      },
      summary: {
        total_nport: nportRows.length,
        total_formd: formdRows.length,
        eligible_nport: annotatedNport.length,
        eligible_formd: annotatedFormd.length,
        distinct_advisers: advisers.length,
        audit_mode: audit,
      },
      nport_holders: annotatedNport,
      formd_holders: annotatedFormd,
      advisers,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// ----------------------------------------------------------------------------
// Discovered-manager endpoint — non-CRD VC/PE firm from enriched_managers.
// Mirrors /advisers/:crd in shape. Uses deps.formdClient (Form D project).
// ----------------------------------------------------------------------------

router.get('/discovered/:id', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = String(req.params.id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'invalid id', code: 'INVALID_ID' });
    }

    // 1. Fetch the enriched_managers row from the Form D Supabase project.
    //    `team_members` is JSONB on the table — surface it so the
    //    DiscoveredPage React component can render the Team section.
    //    `linked_crd` lets the UI offer "View linked adviser" navigation.
    const { data: mgr, error: mgrErr } = await deps.formdClient
      .from('enriched_managers')
      .select('id,series_master_llc,website_url,linkedin_company_url,twitter_handle,fund_type,investment_stage,enrichment_status,primary_contact_email,phone_number,headquarters_city,headquarters_state,headquarters_country,last_updated,team_members,linked_crd,portfolio_companies,notable_portfolio_companies')
      .eq('id', id)
      .maybeSingle();
    if (mgrErr) throw mgrErr;
    if (!mgr) return notFound(res, `Discovered manager ${id} not found`, 'MANAGER_NOT_FOUND');

    // 2. All holder evidence rows that resolved to this discovered manager.
    //    Keyset-paginate v_intel_company_holders on evidence_id.
    const allRows = [];
    let lastId = 0;
    while (true) {
      const { data, error } = await deps.nportClient
        .from('v_intel_company_holders')
        .select('company_slug,evidence_id,evidence_cik,evidence_label,value_usd,evidence_date,accession_number,adviser_resolution_method,status_at_evidence_date')
        .eq('discovered_manager_id', id)
        .gt('evidence_id', lastId)
        .order('evidence_id')
        .limit(1000);
      if (error) throw error;
      const batch = data || [];
      if (!batch.length) break;
      allRows.push(...batch);
      lastId = parseInt(batch[batch.length - 1].evidence_id, 10);
      if (batch.length < 1000) break;
    }

    // 3. Fetch display names for each company that appears in the holdings.
    const companySlugs = Array.from(new Set(allRows.map(r => r.company_slug).filter(Boolean)));
    const companyMeta = {};
    if (companySlugs.length) {
      for (let i = 0; i < companySlugs.length; i += 200) {
        const chunk = companySlugs.slice(i, i + 200);
        const { data, error } = await deps.nportClient
          .from('private_companies')
          .select('slug,display_name')
          .in('slug', chunk);
        if (error) throw error;
        for (const row of (data || [])) companyMeta[row.slug] = row;
      }
    }

    // 4. Shape holder rows for the response.
    const holders = allRows.map(r => ({
      company_slug: r.company_slug,
      company_name: (companyMeta[r.company_slug] || {}).display_name || r.company_slug,
      accession_number: r.accession_number,
      filer_entityname: r.evidence_label,
      filing_date: r.evidence_date,
      value_usd: r.value_usd ? parseFloat(r.value_usd) : null,
    })).sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0));

    // Parse team_members JSONB if it arrived as a string (Supabase
    // sometimes returns JSONB as a string depending on PostgREST settings).
    let teamMembers = mgr.team_members;
    if (typeof teamMembers === 'string') {
      try { teamMembers = JSON.parse(teamMembers); } catch (_) { teamMembers = null; }
    }
    let portfolio = mgr.portfolio_companies;
    if (typeof portfolio === 'string') {
      try { portfolio = JSON.parse(portfolio); } catch (_) { portfolio = null; }
    }

    return res.json({
      manager: {
        id: mgr.id,
        name: mgr.series_master_llc,
        website_url: mgr.website_url || null,
        linkedin_company_url: mgr.linkedin_company_url || null,
        twitter_handle: mgr.twitter_handle || null,
        fund_type: mgr.fund_type || null,
        investment_stage: mgr.investment_stage || null,
        enrichment_status: mgr.enrichment_status || null,
        primary_contact_email: mgr.primary_contact_email || null,
        phone_number: mgr.phone_number || null,
        headquarters_city: mgr.headquarters_city || null,
        headquarters_state: mgr.headquarters_state || null,
        headquarters_country: mgr.headquarters_country || null,
        last_updated: mgr.last_updated || null,
        team_members: Array.isArray(teamMembers) ? teamMembers : null,
        linked_crd: mgr.linked_crd || null,
        portfolio_companies: Array.isArray(portfolio) ? portfolio : null,
        notable_portfolio_companies: mgr.notable_portfolio_companies || null,
      },
      summary: {
        total_holdings: holders.length,
        total_value_usd: holders.reduce((acc, h) => acc + (h.value_usd || 0), 0),
      },
      holders_using_this_manager: holders,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// ----------------------------------------------------------------------------
// Fund detail endpoint — one Form D filing (pooled-vehicle SPV) by accession.
// Returns the filing row + parsed related parties + resolved adviser detail
// + which tracked companies this fund holds.
// ----------------------------------------------------------------------------

router.get('/funds/:accession', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const accession = String(req.params.accession || '').trim();
    if (!accession) {
      return res.status(400).json({ error: 'accession required', code: 'MISSING_ACCESSION' });
    }

    // 1. Form D filing row (Form D supabase). Could match either dashed or
    // un-dashed accession in case the URL strips dashes.
    const accessionVariants = accession.includes('-')
      ? [accession]
      : [accession, `${accession.slice(0, 10)}-${accession.slice(10, 12)}-${accession.slice(12)}`];
    let filing = null;
    for (const variant of accessionVariants) {
      const { data } = await deps.formdClient
        .from('form_d_filings')
        .select('*')
        .eq('accessionnumber', variant)
        .limit(1);
      if (data && data.length) { filing = data[0]; break; }
    }
    if (!filing) {
      return notFound(res, `Form D filing not found: ${accession}`, 'FUND_NOT_FOUND');
    }

    // 2. Cross-reference: what adviser CRD is this bridged to?
    const { data: xref } = await deps.formdClient
      .from('cross_reference_matches')
      .select('adviser_entity_crd')
      .eq('formd_accession', filing.accessionnumber)
      .not('adviser_entity_crd', 'is', null)
      .limit(1);
    let resolvedCrd = (xref && xref.length) ? String(xref[0].adviser_entity_crd) : null;

    // 3. Also check our intel layer (the materialized resolution table)
    if (!resolvedCrd) {
      const { data: intelRows } = await deps.nportClient
        .from('intel_formd_pooled_vehicle_offering')
        .select('offering_id')
        .eq('accession_number', filing.accessionnumber)
        .limit(1);
      if (intelRows && intelRows.length) {
        const { data: resRows } = await deps.nportClient
          .from('intel_adviser_resolution')
          .select('crd,method')
          .eq('source_table', 'intel_formd_pooled_vehicle_offering')
          .eq('source_id', intelRows[0].offering_id)
          .limit(1);
        if (resRows && resRows.length) {
          resolvedCrd = String(resRows[0].crd);
        }
      }
    }

    // 4. Adviser detail if we have a CRD
    let adviser = null;
    if (resolvedCrd) {
      const details = await fetchAdviserDetails(deps.advClient, [resolvedCrd]);
      const advDetail = details[resolvedCrd];
      const extras = await fetchEnrichedExtras(deps.formdClient, [resolvedCrd]);
      const extra = extras[resolvedCrd] || {};
      const personEnrichmentMap = await fetchPersonEnrichment(deps.nportClient, [resolvedCrd]);
      if (advDetail) {
        adviser = {
          crd: resolvedCrd,
          name: advDetail.adviser_name || null,
          total_aum: advDetail.total_aum || null,
          phone: advDetail.phone_number || null,
          website: pickCanonicalDomain(advDetail.primary_website, advDetail.other_websites, extra.website_url),
          cco_name: normalizeName(advDetail.cco_name),
          cco_email: advDetail.cco_email || null,
          signatory_name: normalizeName(advDetail.signatory_name),
          signatory_title: advDetail.signatory_title || null,
          owners: normalizeOwnersList(advDetail.owner_full_legal_name),
          form_adv_url: advDetail.form_adv_url || null,
          linkedin_company_url: extra.linkedin_company_url || null,
          team_members: teamMembersToStructured(extra.team_members),
          twitter_handle: extra.twitter_handle || null,
          person_enrichment: personEnrichmentMap[resolvedCrd] || {},
        };
      }
    }

    // 5. Parse related parties from the filing (pipe-separated columns)
    const splitPipe = (s) => (s ? String(s).split('|').map(t => t.trim()).filter(Boolean) : []);
    const relatedNames = splitPipe(filing.related_names);
    const relatedRoles = splitPipe(filing.related_roles);
    const relatedParties = relatedNames.map((name, i) => ({
      name: normalizeName(name) || name,
      role: relatedRoles[i] || null,
    }));

    // 6. Which tracked companies does this fund hold?
    const { data: intelOfferings } = await deps.nportClient
      .from('intel_formd_pooled_vehicle_offering')
      .select('company_slug,total_offering_amount,filing_date')
      .eq('accession_number', filing.accessionnumber);
    const trackedCompanies = (intelOfferings || []).map(o => ({
      slug: o.company_slug,
      total_offering_amount: o.total_offering_amount,
      filing_date: o.filing_date,
    }));

    res.json({
      filing: {
        accession_number: filing.accessionnumber,
        entityname: filing.entityname,
        cik: filing.cik,
        filing_date: filing.filing_date,
        sale_date: filing.sale_date,
        signature_date: filing.signaturedate,
        is_amendment: filing.isamendment === 'true' || filing.isamendment === true,
        submission_type: filing.submissiontype,
        previous_accession: filing.previousaccessionnumber,
        // Offering economics
        total_offering_amount: filing.totalofferingamount,
        total_amount_sold: filing.totalamountsold,
        total_remaining: filing.totalremaining,
        minimum_investment: filing.minimuminvestmentaccepted,
        total_investors: filing.totalnumberalreadyinvested,
        revenue_range: filing.revenuerange,
        // Exemptions + type
        industry_group_type: filing.industrygrouptype,
        investment_fund_type: filing.investmentfundtype,
        federal_exemptions: filing.federalexemptions_items_list,
        is_pooled_fund: filing.ispooledinvestmentfundtype === 'true' || filing.ispooledinvestmentfundtype === true,
        // Issuer location
        entity_type: filing.entitytype,
        jurisdiction: filing.jurisdictionofinc,
        year_of_inc: filing.yearofinc_value_entered,
        city: filing.city,
        state_or_country: filing.stateorcountry,
        street1: filing.street1,
        zipcode: filing.zipcode,
        issuer_phone: filing.issuerphonenumber,
        // Signature
        name_of_signer: filing.nameofsigner,
        signature_title: filing.signaturetitle,
        // Series
        series_master_llc: filing.series_master_llc,
      },
      related_parties: relatedParties,
      adviser,
      tracked_companies: trackedCompanies,
      edgar_url: filing.cik && filing.accessionnumber
        ? `https://www.sec.gov/Archives/edgar/data/${String(filing.cik).replace(/^0+/, '')}/${String(filing.accessionnumber).replace(/-/g, '')}/`
        : null,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// ----------------------------------------------------------------------------
// Global search across tracked companies + advisers + ADV funds + Form D
// filings. Returns a unified, ranked result list.
// ----------------------------------------------------------------------------

router.get('/search', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ query: q, total: 0, results: [], note: 'min 2 chars' });
    }
    // Limits per source; concatenate at the end.
    const PER_SOURCE = parseInt(req.query.limit, 10) || 25;
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;

    // 1. Tracked private companies (highest priority — top of results)
    const companiesP = deps.nportClient
      .from('private_companies')
      .select('slug,display_name,sector,lifecycle_status,is_public,is_acquired')
      .ilike('display_name', like)
      .limit(PER_SOURCE);

    // 2. Advisers (advisers_enriched by adviser_name)
    const advisersP = deps.advClient
      .from('advisers_enriched')
      .select('crd,adviser_name,total_aum,phone_number')
      .ilike('adviser_name', like)
      .limit(PER_SOURCE);

    // 3. ADV registered funds (funds_enriched by fund_name)
    const fundsP = deps.advClient
      .from('funds_enriched')
      .select('reference_id,fund_name,fund_type,adviser_crd,gross_asset_value')
      .ilike('fund_name', like)
      .limit(PER_SOURCE);

    // 4. Form D filings by entityname (filter to non-amendments)
    const formdP = deps.formdClient
      .from('form_d_filings')
      .select('accessionnumber,entityname,cik,filing_date,totalofferingamount')
      .ilike('entityname', like)
      .neq('isamendment', 'true')
      .order('filing_date', { ascending: false })
      .limit(PER_SOURCE);

    // 5. CRM people (lets the Cmd-K palette / search jump straight to a contact)
    const crmPeopleP = deps.nportClient
      .from('crm_person')
      .select('person_id,full_name,email,title')
      .ilike('full_name', like)
      .limit(PER_SOURCE);

    const [companiesRes, advisersRes, fundsRes, formdRes, crmPeopleRes] = await Promise.all([
      companiesP, advisersP, fundsP, formdP, crmPeopleP,
    ]);

    const results = [];

    // Score helper: exact-prefix match ranks higher than substring.
    const qLower = q.toLowerCase();
    const score = (text) => {
      if (!text) return 0;
      const t = text.toLowerCase();
      if (t === qLower) return 100;
      if (t.startsWith(qLower)) return 50;
      return 10;
    };

    for (const row of (companiesRes.data || [])) {
      const status = row.lifecycle_status || (row.is_public ? 'public' : 'private');
      results.push({
        type: 'company',
        id: row.slug,
        label: row.display_name,
        sublabel: `${row.sector ? row.sector + ' • ' : ''}${status}`,
        url: `/intel/${encodeURIComponent(row.slug)}`,
        rank: score(row.display_name) + 30, // companies prioritized
      });
    }
    for (const row of (advisersRes.data || [])) {
      const aum = row.total_aum
        ? '$' + Number(row.total_aum).toLocaleString(undefined, { maximumFractionDigits: 0 })
        : 'AUM —';
      results.push({
        type: 'adviser',
        id: String(row.crd),
        label: row.adviser_name,
        sublabel: `CRD ${row.crd} • ${aum}`,
        url: `/intel/adviser/${encodeURIComponent(row.crd)}`,
        rank: score(row.adviser_name) + 20,
      });
    }
    for (const row of (fundsRes.data || [])) {
      const gav = row.gross_asset_value
        ? '$' + Number(row.gross_asset_value).toLocaleString(undefined, { maximumFractionDigits: 0 })
        : null;
      const advLink = row.adviser_crd ? ` • adv CRD ${row.adviser_crd}` : '';
      results.push({
        type: 'adv_fund',
        id: String(row.reference_id || row.fund_name),
        label: row.fund_name,
        sublabel: `${row.fund_type || 'ADV fund'}${advLink}${gav ? ' • ' + gav : ''}`,
        url: row.adviser_crd ? `/intel/adviser/${encodeURIComponent(row.adviser_crd)}` : null,
        rank: score(row.fund_name) + 10,
      });
    }
    for (const row of (formdRes.data || [])) {
      const amt = row.totalofferingamount
        ? '$' + Number(row.totalofferingamount).toLocaleString(undefined, { maximumFractionDigits: 0 })
        : null;
      results.push({
        type: 'formd_filing',
        id: row.accessionnumber,
        label: row.entityname,
        sublabel: `Form D • ${row.filing_date || ''}${amt ? ' • ' + amt : ''}`,
        url: edgarFilingUrlServer(row.cik, row.accessionnumber),
        external: true,
        rank: score(row.entityname),
      });
    }
    for (const row of (crmPeopleRes.data || [])) {
      results.push({
        type: 'crm_person',
        id: String(row.person_id),
        label: row.full_name || row.email || `Person ${row.person_id}`,
        sublabel: `CRM contact${row.title ? ' • ' + row.title : ''}`,
        url: `/intel/crm/person/${encodeURIComponent(row.person_id)}`,
        rank: score(row.full_name) + 25,
      });
    }

    // Rank desc then label asc as tiebreaker
    results.sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label));

    res.json({
      query: q,
      total: results.length,
      by_source: {
        companies: (companiesRes.data || []).length,
        advisers: (advisersRes.data || []).length,
        adv_funds: (fundsRes.data || []).length,
        formd_filings: (formdRes.data || []).length,
      },
      results,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// Same shape as frontend's edgarFilingUrl helper — duplicated server-side
// for the search response (avoids the frontend having to know CIK semantics).
function edgarFilingUrlServer(cik, accession) {
  if (!cik || !accession) return null;
  const cikInt = String(cik).replace(/^0+/, '') || '0';
  const accNoDashes = String(accession).replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/`;
}

// ----------------------------------------------------------------------------
// Adviser-centric endpoint — "all the funds adviser CRD X holds across every
// tracked private company, plus firm metadata."
// ----------------------------------------------------------------------------

router.get('/advisers/:crd', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const crdParam = String(req.params.crd || '').trim();
    if (!crdParam) {
      return res.status(400).json({ error: 'crd required', code: 'MISSING_CRD' });
    }

    // 1. Adviser firm metadata (advisers_enriched). We may not have the firm
    //    in advisers_enriched if it's pure-Form-D — handle that with a 404.
    const details = await fetchAdviserDetails(deps.advClient, [crdParam]);
    const advDetail = details[crdParam];
    const extras = await fetchEnrichedExtras(deps.formdClient, [crdParam]);
    const extra = extras[crdParam] || {};
    const personEnrichmentMap = await fetchPersonEnrichment(deps.nportClient, [crdParam]);
    const personEnrichmentForCrd = personEnrichmentMap[crdParam] || {};
    // PFR-parity: owners with titles + amounts + direct/indirect, and
    // service providers aggregated across this firm's funds. Both
    // computed in parallel — fast and independent.
    const [ownersWithDetails, serviceProviders] = await Promise.all([
      Promise.resolve(parseOwnersWithDetails(advDetail || {})),
      fetchServiceProviders(deps.advClient, crdParam),
    ]);
    if (!advDetail && !extra) {
      return notFound(res, `Adviser CRD ${crdParam} not found`, 'ADVISER_NOT_FOUND');
    }

    // 2. All holdings for this CRD across every tracked company.
    //    Keyset-paginate the view.
    const allRows = [];
    let lastId = 0;
    while (true) {
      const { data, error } = await deps.nportClient
        .from('v_intel_company_holders')
        .select('*')
        .eq('adviser_crd', crdParam)
        .gt('evidence_id', lastId)
        .order('evidence_id')
        .limit(1000);
      if (error) throw error;
      const batch = data || [];
      if (!batch.length) break;
      allRows.push(...batch);
      lastId = parseInt(batch[batch.length - 1].evidence_id, 10);
      if (batch.length < 1000) break;
    }

    // 3. Look up display names + lifecycle for every company that appears
    //    in this adviser's holdings.
    const companySlugs = Array.from(new Set(allRows.map(r => r.company_slug).filter(Boolean)));
    const companyMeta = {};
    if (companySlugs.length) {
      for (let i = 0; i < companySlugs.length; i += 200) {
        const chunk = companySlugs.slice(i, i + 200);
        const { data, error } = await deps.nportClient
          .from('private_companies')
          .select('slug,display_name,sector,lifecycle_status,is_public,is_acquired,primary_domain,latest_known_valuation_usd')
          .in('slug', chunk);
        if (error) throw error;
        for (const row of (data || [])) companyMeta[row.slug] = row;
      }
    }

    // 4. Bucket holdings by company + source type. Filter to private/unknown
    //    rows unless ?audit=1.
    const audit = req.query.audit === '1' || req.query.audit === 'true';
    const byCompany = {};
    for (const r of allRows) {
      if (!audit && !(r.status_at_evidence_date === 'private' || r.status_at_evidence_date === 'unknown')) {
        continue;
      }
      const slug = r.company_slug;
      if (!byCompany[slug]) {
        const c = companyMeta[slug] || {};
        byCompany[slug] = {
          slug,
          display_name: c.display_name || slug,
          sector: c.sector || null,
          lifecycle_status: c.lifecycle_status || null,
          is_public: c.is_public || false,
          is_acquired: c.is_acquired || false,
          primary_domain: c.primary_domain || null,
          latest_known_valuation_usd: c.latest_known_valuation_usd || null,
          total_value_usd: 0,
          evidence_count: 0,
          nport_holdings: [],
          formd_holdings: [],
        };
      }
      const v = r.value_usd ? parseFloat(r.value_usd) : 0;
      byCompany[slug].evidence_count += 1;
      if (Number.isFinite(v)) byCompany[slug].total_value_usd += v;

      const evidence = {
        evidence_id: r.evidence_id,
        registrant_or_filer_cik: r.evidence_cik,
        series_id: r.evidence_series_id,
        label: r.evidence_label,
        value_usd: Number.isFinite(v) ? v : null,
        evidence_date: r.evidence_date,
        accession_number: r.accession_number,
        adviser_method: r.adviser_resolution_method,
        status_at_evidence_date: r.status_at_evidence_date,
        was_private_at_evidence_date: r.was_private_at_evidence_date,
      };
      if (r.source_type === 'nport') {
        byCompany[slug].nport_holdings.push(evidence);
      } else if (r.source_type === 'formd_pooled_vehicle') {
        byCompany[slug].formd_holdings.push(evidence);
      }
    }

    const companies = Object.values(byCompany)
      .sort((a, b) => b.total_value_usd - a.total_value_usd);

    // 5. Roll up summary
    const summary = {
      distinct_companies: companies.length,
      total_value_usd: companies.reduce((acc, c) => acc + c.total_value_usd, 0),
      total_evidence_count: companies.reduce((acc, c) => acc + c.evidence_count, 0),
      audit_mode: audit,
    };

    // 6. Adviser block (normalized names mirror /companies/:slug/holders)
    const adviser = advDetail ? {
      crd: crdParam,
      name: advDetail.adviser_name || null,
      total_aum: advDetail.total_aum || null,
      phone: advDetail.phone_number || null,
      website: pickCanonicalDomain(advDetail.primary_website, advDetail.other_websites, extra.website_url),
      cco_name: normalizeName(advDetail.cco_name),
      cco_email: advDetail.cco_email || null,
      signatory_name: normalizeName(advDetail.signatory_name),
      signatory_title: advDetail.signatory_title || null,
      owner_full_legal_name: advDetail.owner_full_legal_name || null,
      owners: normalizeOwnersList(advDetail.owner_full_legal_name),
      // Detailed owners: each with name + title + ownership_amount + direct/indirect
      owners_detail: ownersWithDetails,
      owner_title_or_status: advDetail.owner_title_or_status || null,
      ownership_amount: advDetail.ownership_amount || null,
      control_person_name: normalizeName(advDetail.control_person_name),
      regulatory_contact_name: normalizeName(advDetail.regulatory_contact_name),
      regulatory_contact_email: advDetail.regulatory_contact_email || null,
      form_adv_url: advDetail.form_adv_url || null,
      linkedin_company_url: extra.linkedin_company_url || null,
      team_members: teamMembersToStructured(extra.team_members),
      team_members_text: teamMembersToText(extra.team_members) || null,
      alt_contact_email: extra.primary_contact_email || null,
      twitter_handle: extra.twitter_handle || null,
      person_enrichment: personEnrichmentForCrd,
    } : {
      crd: crdParam,
      name: null,
      total_aum: null,
      phone: null,
      website: null,
      cco_name: null,
      cco_email: null,
      signatory_name: null,
      owners: [],
      form_adv_url: null,
      linkedin_company_url: extra.linkedin_company_url || null,
      team_members: teamMembersToStructured(extra.team_members),
      team_members_text: teamMembersToText(extra.team_members) || null,
      alt_contact_email: extra.primary_contact_email || null,
      twitter_handle: extra.twitter_handle || null,
      person_enrichment: personEnrichmentForCrd,
      not_in_advisers_enriched: true,
    };

    res.json({ adviser, summary, companies, service_providers: serviceProviders });
  } catch (err) {
    return serverError(res, err);
  }
});

// ----------------------------------------------------------------------------
// CSV download endpoints
// ----------------------------------------------------------------------------

/**
 * Escape a single value for inclusion in CSV. Wraps in double-quotes when the
 * value contains a delimiter, quote, or newline, and doubles any internal
 * quotes per RFC 4180. Nulls/undefineds become empty cells.
 */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function rowsToCsv(headers, rows, accessors) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(accessors.map(fn => csvEscape(fn(row))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

async function fetchHolderRowsForCsv(slug, evidenceType, { audit }) {
  const rows = await paginateHolders(deps.nportClient, slug, evidenceType);
  const crds = Array.from(new Set(rows.map(r => r.adviser_crd).filter(Boolean)));
  const adviserDetails = await fetchAdviserDetails(deps.advClient, crds);
  const filtered = audit
    ? rows
    : rows.filter(r => r.status_at_evidence_date === 'private' || r.status_at_evidence_date === 'unknown');
  return { rows: filtered, adviserDetails };
}

router.get('/companies/:slug/holders/nport.csv', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;
    const audit = req.query.audit === '1' || req.query.audit === 'true';
    const { rows, adviserDetails } = await fetchHolderRowsForCsv(slug, 'nport', { audit });
    const sorted = rows.slice().sort((a, b) => {
      const av = a.value_usd ? parseFloat(a.value_usd) : 0;
      const bv = b.value_usd ? parseFloat(b.value_usd) : 0;
      return bv - av;
    });
    const headers = [
      'evidence_id', 'registrant_cik', 'series_id', 'issuer_title',
      'value_usd', 'evidence_date', 'accession_number',
      'adviser_crd', 'adviser_name', 'adviser_method',
      'status_at_evidence_date', 'was_private_at_evidence_date',
    ];
    const accessors = [
      r => r.evidence_id,
      r => r.evidence_cik,
      r => r.evidence_series_id,
      r => r.evidence_label,
      r => r.value_usd ? parseFloat(r.value_usd) : '',
      r => r.evidence_date,
      r => r.accession_number,
      r => r.adviser_crd || '',
      r => (adviserDetails[r.adviser_crd] || {}).adviser_name || '',
      r => r.adviser_resolution_method || '',
      r => r.status_at_evidence_date,
      r => r.was_private_at_evidence_date,
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-nport-holders.csv"`);
    res.send(rowsToCsv(headers, sorted, accessors));
  } catch (err) {
    return serverError(res, err);
  }
});

router.get('/companies/:slug/holders/formd.csv', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;
    const audit = req.query.audit === '1' || req.query.audit === 'true';
    const { rows, adviserDetails } = await fetchHolderRowsForCsv(slug, 'formd_pooled_vehicle', { audit });
    const sorted = rows.slice().sort((a, b) => {
      const av = a.value_usd ? parseFloat(a.value_usd) : 0;
      const bv = b.value_usd ? parseFloat(b.value_usd) : 0;
      return bv - av;
    });
    const headers = [
      'evidence_id', 'filer_cik', 'filer_entityname', 'value_usd',
      'filing_date', 'accession_number',
      'adviser_crd', 'adviser_name', 'adviser_method',
      'status_at_evidence_date', 'was_private_at_evidence_date',
    ];
    const accessors = [
      r => r.evidence_id,
      r => r.evidence_cik,
      r => r.evidence_label,
      r => r.value_usd ? parseFloat(r.value_usd) : '',
      r => r.evidence_date,
      r => r.accession_number,
      r => r.adviser_crd || '',
      r => (adviserDetails[r.adviser_crd] || {}).adviser_name || '',
      r => r.adviser_resolution_method || '',
      r => r.status_at_evidence_date,
      r => r.was_private_at_evidence_date,
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-formd-holders.csv"`);
    res.send(rowsToCsv(headers, sorted, accessors));
  } catch (err) {
    return serverError(res, err);
  }
});

// ============================================================================
// CRM ROUTES (added 2026-05-31)
// Personal CRM for tracking outreach to fund managers.
// Spec: intelligence/CRM_SPEC.md on fund-holders-intel branch.
// Schema: nport/migrations/010_crm_schema.sql
// All routes under /api/intel/crm/*
// ============================================================================

// Whitelist of fields a PATCH /people/:id is allowed to update
// (prevents overwriting source-derived fields like full_name, source_evidence)
const CRM_PERSON_PATCHABLE = new Set([
  'engagement_status', 'priority', 'tags', 'do_not_contact',
  'do_not_contact_reason', 'needs_compliance_review', 'restriction_notes',
  'notes', 'title', 'role', 'email', 'linkedin_url', 'twitter_handle', 'phone',
]);

// Fields safe to SET across MANY people at once. Deliberately NARROW — never
// reuse CRM_PERSON_PATCHABLE here, or a bulk call could fan one email/phone/
// name across hundreds of rows. Matches what the bulk UI actually exposes.
const CRM_PERSON_BULK_SETTABLE = new Set(['engagement_status', 'priority']);

// Enum validation sets (must mirror migration 010_crm_schema.sql CHECK constraints).
// Used to reject invalid values at the API layer with 400, instead of letting
// the DB throw a CHECK violation that becomes a 500. (Verifier bug A7/E5)
const CRM_INTERACTION_DIRECTIONS = new Set(['outbound','inbound','internal_note']);
const CRM_INTERACTION_CHANNELS   = new Set(['email','linkedin_msg','twitter_dm','phone','meeting','sms','event','referral','note']);
const CRM_INTERACTION_TYPES      = new Set(['intro','followup','deal_pitch','response','meeting','call_summary','internal_note']);
const CRM_INTERACTION_SENTIMENTS = new Set(['positive','neutral','negative','no_signal']);
const CRM_INTERACTION_OUTCOMES   = new Set(['sent','replied','no_reply','meeting_booked','interested','not_interested','out_of_scope','wrong_person']);
const CRM_DEAL_SIDES             = new Set(['buy','sell','either']);
const CRM_DEAL_STATES            = new Set(['open','soft','firm','matched','negotiating','passed','stale','expired','retracted','compliance_review']);
const CRM_FOLLOWUP_STATUSES      = new Set(['open','done','snoozed','cancelled']);
const CRM_ENGAGEMENT_STATUSES    = new Set(['cold','researching','outreach_sent','responded','engaged','dormant']);

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

const CRM_DEAL_PATCHABLE = new Set([
  'state', 'security_type', 'share_class', 'structure', 'currency',
  'price_per_share_min', 'price_per_share_max',
  'implied_valuation_min', 'implied_valuation_max',
  'size_shares', 'size_usd', 'conditions', 'expires_at', 'notes',
]);

const CRM_FOLLOWUP_PATCHABLE = new Set([
  'status', 'due_at', 'reason', 'completed_at', 'snoozed_until',
  'cancelled_reason', 'related_deal_interest_id',
]);

function pickAllowedFields(body, allowSet) {
  const out = {};
  for (const k of Object.keys(body || {})) {
    if (allowSet.has(k)) out[k] = body[k];
  }
  return out;
}

// --- GET /api/intel/crm/people ---------------------------------------------
router.get('/crm/people', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const status = req.query.status;       // filter
    const priorityMax = req.query.priority_max;
    const tag = req.query.tag;
    const hasEmail = req.query.has_email === '1';
    const view = req.query.view;           // 'stale' | 'replied' — Today chips
    const company = req.query.company;     // filter: people whose firm holds this tracked company

    // Resolve the Today-chip views to the EXACT person-id set behind their
    // count, so clicking a chip returns the same population the number reflects.
    let viewIds = null;
    if (view === 'stale' || view === 'replied') {
      const fn = view === 'stale' ? 'crm_stale_person_ids' : 'crm_replied_person_ids';
      const { data: idRows, error: viewErr } = await deps.nportClient.rpc(fn);
      if (viewErr) throw viewErr;
      viewIds = (idRows || []).map(r => r.person_id);
      if (!viewIds.length) return res.json({ total: 0, limit, offset, rows: [] });
    }

    // Company-exposure filter: restrict to people whose firm holds `company`
    // (reuses crm_company_holder_firms — the same firms shown on the portco view).
    let companyFirmIds = null;
    if (company) {
      const { data: cf, error: cfErr } = await deps.nportClient
        .rpc('crm_company_holder_firms', { p_slug: company });
      if (cfErr) throw cfErr;
      companyFirmIds = (cf || []).map(f => f.firm_id);
      if (!companyFirmIds.length) return res.json({ total: 0, limit, offset, rows: [] });
    }

    let q = deps.nportClient.from('crm_person')
      .select('person_id,firm_id,full_name,title,role,email,linkedin_url,twitter_handle,phone,engagement_status,priority,tags,do_not_contact,added_via,added_for_companies,updated_at,created_at', { count: 'exact' })
      .order('priority', { ascending: true })
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) q = q.eq('engagement_status', status);
    if (priorityMax) q = q.lte('priority', parseInt(priorityMax, 10));
    if (tag) q = q.contains('tags', [tag]);
    if (hasEmail) q = q.not('email', 'is', null);
    if (viewIds) q = q.in('person_id', viewIds);
    if (companyFirmIds) q = q.in('firm_id', companyFirmIds);

    const { data: people, count, error } = await q;
    if (error) throw error;

    // Fetch firm rows for the people in this page
    const firmIds = Array.from(new Set((people || []).map(p => p.firm_id).filter(Boolean)));
    let firmsById = {};
    if (firmIds.length) {
      const { data: firms } = await deps.nportClient
        .from('crm_firm')
        .select('firm_id,display_name,website_url,linkedin_company_url,exposure_company_count,exposure_total_nport_usd,exposure_total_formd_usd')
        .in('firm_id', firmIds);
      firmsById = Object.fromEntries((firms || []).map(f => [f.firm_id, f]));
    }

    // last_contacted_at = MAX(interaction.occurred_at) per person, via RPC.
    // Grouped aggregate returns one row per person, so it is immune to the
    // ~1000-row PostgREST cap a client-side reduce over crm_interaction would
    // silently hit for high-volume contacts.
    const personIds = (people || []).map(p => p.person_id);
    let lastById = {};
    if (personIds.length) {
      const { data: lc, error: lcErr } = await deps.nportClient
        .rpc('crm_last_contacted', { p_ids: personIds });
      if (!lcErr) lastById = Object.fromEntries((lc || []).map(r => [r.person_id, r.last_contacted_at]));
    }

    const rows = (people || []).map(p => ({
      ...p,
      firm: p.firm_id ? firmsById[p.firm_id] : null,
      last_contacted_at: lastById[p.person_id] || null,
    }));
    return res.json({ total: count, limit, offset, rows });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/today -----------------------------------------------
// Daily-use summary card: overdue followups, recent inbound replies, and
// truly-stale outreach. Counts computed in SQL (crm_today_summary RPC) so
// "stale" reflects real contact recency, not crm_person.updated_at edits.
router.get('/crm/today', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { data, error } = await deps.nportClient.rpc('crm_today_summary');
    if (error) throw error;
    return res.json(data || { overdue_followups: 0, recent_replies: 0, stale_contacts: 0 });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/people/:id ------------------------------------------
router.get('/crm/people/:id', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const { data: person, error: e1 } = await deps.nportClient
      .from('crm_person').select('*').eq('person_id', id).maybeSingle();
    if (e1) throw e1;
    if (!person) return notFound(res, 'person not found', 'CRM_PERSON_NOT_FOUND');

    let firm = null;
    if (person.firm_id) {
      const { data: f } = await deps.nportClient
        .from('crm_firm').select('*').eq('firm_id', person.firm_id).maybeSingle();
      firm = f;
    }
    const { data: interactions } = await deps.nportClient
      .from('crm_interaction').select('*').eq('person_id', id)
      .order('occurred_at', { ascending: false }).limit(100);
    const { data: deals } = await deps.nportClient
      .from('crm_deal_interest').select('*').eq('person_id', id)
      .order('updated_at', { ascending: false });
    const { data: followups } = await deps.nportClient
      .from('crm_followup').select('*').eq('person_id', id)
      .order('due_at', { ascending: true });

    return res.json({ person, firm, interactions: interactions || [], deal_interests: deals || [], followups: followups || [] });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- POST /api/intel/crm/people --------------------------------------------
router.post('/crm/people', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const b = req.body || {};
    if (!b.full_name && !b.email) {
      return res.status(400).json({ error: 'full_name or email required' });
    }
    const payload = {
      firm_id: b.firm_id || null,
      full_name: b.full_name || null,
      first_name: b.first_name || null,
      last_name: b.last_name || null,
      title: b.title || null,
      role: b.role || 'manual',
      email: b.email ? b.email.toLowerCase().trim() : null,
      linkedin_url: b.linkedin_url || null,
      twitter_handle: b.twitter_handle || null,
      phone: b.phone || null,
      source_tag: 'manual',
      source_evidence: [{ from: 'api_manual_add', at: new Date().toISOString() }],
      added_via: 'manual',
      notes: b.notes || null,
    };
    // Dedup on email BEFORE insert. The partial unique index
    // (firm_id, lower(email)) treats NULL firm_id as distinct, so it can't
    // catch a new no-firm contact added twice — enforce it here.
    if (payload.email) {
      const { data: dupe } = await deps.nportClient
        .from('crm_person').select('person_id,full_name').eq('email', payload.email).limit(1);
      if (dupe && dupe.length) {
        return res.status(409).json({ error: 'a person with this email already exists', person_id: dupe[0].person_id, full_name: dupe[0].full_name });
      }
    }
    const { data, error } = await deps.nportClient
      .from('crm_person').insert(payload).select().maybeSingle();
    if (error) throw error;
    return res.status(201).json({ person: data });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- PATCH /api/intel/crm/people/:id ---------------------------------------
router.patch('/crm/people/:id', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const updates = pickAllowedFields(req.body, CRM_PERSON_PATCHABLE);
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no allowed fields in body' });
    if (updates.engagement_status && !CRM_ENGAGEMENT_STATUSES.has(updates.engagement_status))
      return badRequest(res, `invalid engagement_status: ${updates.engagement_status}`);
    if (updates.priority !== undefined) {
      const p = parseInt(updates.priority, 10);
      if (!Number.isInteger(p) || p < 1 || p > 5)
        return badRequest(res, `priority must be 1..5`);
      updates.priority = p;
    }
    if (updates.email) updates.email = updates.email.toLowerCase().trim();
    const { data, error } = await deps.nportClient
      .from('crm_person').update(updates).eq('person_id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) return notFound(res, 'person not found', 'CRM_PERSON_NOT_FOUND');
    return res.json({ person: data });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- POST /api/intel/crm/people/bulk ---------------------------------------
// Multi-select bulk actions: scalar SET (engagement_status, priority,
// do_not_contact, ...) applied to all ids, plus add_tag which APPENDS one tag
// to each person's existing tags (dedup). Writes run through the server's
// service client.
router.post('/crm/people/bulk', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    if (ids.length > 500) return res.status(400).json({ error: 'too many ids (max 500)' });
    const updates = pickAllowedFields(b.updates || {}, CRM_PERSON_BULK_SETTABLE);
    if (updates.engagement_status && !CRM_ENGAGEMENT_STATUSES.has(updates.engagement_status))
      return badRequest(res, `invalid engagement_status: ${updates.engagement_status}`);
    if (updates.priority !== undefined) {
      const p = parseInt(updates.priority, 10);
      if (!Number.isInteger(p) || p < 1 || p > 5) return badRequest(res, 'priority must be 1..5');
      updates.priority = p;
    }
    let updated = 0;
    if (Object.keys(updates).length) {
      const { data, error } = await deps.nportClient
        .from('crm_person').update(updates).in('person_id', ids).select('person_id');
      if (error) throw error;
      updated = (data || []).length;
    }
    const addTag = String(b.add_tag || '').trim();
    let tagged = 0;
    const failed = [];
    if (addTag) {
      const { data: cur } = await deps.nportClient
        .from('crm_person').select('person_id,tags').in('person_id', ids);
      for (const p of (cur || [])) {
        const tags = Array.isArray(p.tags) ? p.tags : [];
        if (tags.includes(addTag)) continue;
        const { error: e } = await deps.nportClient
          .from('crm_person').update({ tags: [...tags, addTag] }).eq('person_id', p.person_id);
        if (e) failed.push(p.person_id); else tagged++;
      }
    }
    if (failed.length) {
      return res.status(500).json({ error: 'some tag writes failed', updated, tagged, failed });
    }
    return res.json({ updated, tagged });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- DELETE /api/intel/crm/people/:id --------------------------------------
router.delete('/crm/people/:id', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const { error } = await deps.nportClient
      .from('crm_person').delete().eq('person_id', id);
    if (error) throw error;
    return res.status(204).end();
  } catch (err) {
    return serverError(res, err);
  }
});

// --- POST /api/intel/crm/people/:id/interactions ----------------------------
router.post('/crm/people/:id/interactions', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const b = req.body || {};
    const required = ['occurred_at', 'direction', 'channel', 'type'];
    for (const k of required) {
      if (!b[k]) return res.status(400).json({ error: `${k} required` });
    }
    // Pre-INSERT enum validation (verifier bug A7) — avoid DB CHECK -> 500.
    if (!CRM_INTERACTION_DIRECTIONS.has(b.direction))
      return badRequest(res, `invalid direction: ${b.direction}`);
    if (!CRM_INTERACTION_CHANNELS.has(b.channel))
      return badRequest(res, `invalid channel: ${b.channel}`);
    if (!CRM_INTERACTION_TYPES.has(b.type))
      return badRequest(res, `invalid type: ${b.type}`);
    if (b.sentiment && !CRM_INTERACTION_SENTIMENTS.has(b.sentiment))
      return badRequest(res, `invalid sentiment: ${b.sentiment}`);
    if (b.outcome && !CRM_INTERACTION_OUTCOMES.has(b.outcome))
      return badRequest(res, `invalid outcome: ${b.outcome}`);
    // Validate related_company_slug exists in private_companies (verifier bug E5)
    if (b.related_company_slug) {
      const { data: co } = await deps.nportClient
        .from('private_companies').select('slug').eq('slug', b.related_company_slug).maybeSingle();
      if (!co) return badRequest(res, `unknown company_slug: ${b.related_company_slug}`);
    }
    // Look up firm_id from person for denormalization
    const { data: person } = await deps.nportClient
      .from('crm_person').select('firm_id').eq('person_id', id).maybeSingle();

    const payload = {
      person_id: id,
      firm_id: person ? person.firm_id : null,
      occurred_at: b.occurred_at,
      direction: b.direction,
      channel: b.channel,
      type: b.type,
      subject: b.subject || null,
      body: b.body || null,
      body_url: b.body_url || null,
      is_sensitive: !!b.is_sensitive,
      sentiment: b.sentiment || null,
      outcome: b.outcome || null,
      related_company_slug: b.related_company_slug || null,
      related_deal_interest_id: b.related_deal_interest_id || null,
    };
    const { data, error } = await deps.nportClient
      .from('crm_interaction').insert(payload).select().maybeSingle();
    if (error) throw error;
    return res.status(201).json({ interaction: data });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/people/:id/interactions ----------------------------
router.get('/crm/people/:id/interactions', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { data, error } = await deps.nportClient
      .from('crm_interaction').select('*').eq('person_id', id)
      .order('occurred_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return res.json({ rows: data || [] });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- POST /api/intel/crm/people/:id/deal-interests --------------------------
router.post('/crm/people/:id/deal-interests', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const b = req.body || {};
    if (!b.company_slug) return res.status(400).json({ error: 'company_slug required' });
    if (!b.side) return res.status(400).json({ error: 'side required' });
    // Enum validation (verifier bug A7) + FK validation (verifier bug E5)
    if (!CRM_DEAL_SIDES.has(b.side))
      return badRequest(res, `invalid side: ${b.side}`);
    if (b.state && !CRM_DEAL_STATES.has(b.state))
      return badRequest(res, `invalid state: ${b.state}`);
    {
      const { data: co } = await deps.nportClient
        .from('private_companies').select('slug').eq('slug', b.company_slug).maybeSingle();
      if (!co) return badRequest(res, `unknown company_slug: ${b.company_slug}`);
    }

    const { data: person } = await deps.nportClient
      .from('crm_person').select('firm_id').eq('person_id', id).maybeSingle();
    const payload = {
      person_id: id,
      firm_id: person ? person.firm_id : null,
      company_slug: b.company_slug,
      side: b.side,
      state: b.state || 'open',
      security_type: b.security_type || null,
      share_class: b.share_class || null,
      structure: b.structure || null,
      currency: b.currency || 'USD',
      price_per_share_min: b.price_per_share_min || null,
      price_per_share_max: b.price_per_share_max || null,
      implied_valuation_min: b.implied_valuation_min || null,
      implied_valuation_max: b.implied_valuation_max || null,
      size_shares: b.size_shares || null,
      size_usd: b.size_usd || null,
      conditions: b.conditions || null,
      expires_at: b.expires_at || null,
      source_interaction_id: b.source_interaction_id || null,
      notes: b.notes || null,
    };
    const { data, error } = await deps.nportClient
      .from('crm_deal_interest').insert(payload).select().maybeSingle();
    if (error) throw error;
    return res.status(201).json({ deal_interest: data });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- PATCH /api/intel/crm/deal-interests/:id --------------------------------
router.patch('/crm/deal-interests/:id', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const updates = pickAllowedFields(req.body, CRM_DEAL_PATCHABLE);
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no allowed fields' });
    if (updates.state && !CRM_DEAL_STATES.has(updates.state))
      return badRequest(res, `invalid state: ${updates.state}`);
    const { data, error } = await deps.nportClient
      .from('crm_deal_interest').update(updates).eq('deal_interest_id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) return notFound(res, 'deal interest not found', 'CRM_DEAL_NOT_FOUND');
    return res.json({ deal_interest: data });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/deal-interests?company=... --------------------------
router.get('/crm/deal-interests', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const company = req.query.company;
    const state = req.query.state;
    const allStates = req.query.all_states === '1';  // kanban wants closed cols too
    let q = deps.nportClient.from('crm_deal_interest')
      .select('*,crm_person(person_id,full_name,email,linkedin_url,firm_id),crm_firm:firm_id(display_name)')
      .order('side').order('price_per_share_max', { ascending: false });
    if (company) q = q.eq('company_slug', company);
    if (state) q = q.eq('state', state);
    else if (!allStates) q = q.in('state', ['open', 'soft', 'firm', 'negotiating']);

    const { data, error } = await q.limit(500);
    if (error) throw error;
    return res.json({ rows: data || [] });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- POST /api/intel/crm/people/:id/followups -------------------------------
router.post('/crm/people/:id/followups', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    if (!b.due_at || !b.reason) return res.status(400).json({ error: 'due_at + reason required' });
    const payload = {
      person_id: id,
      due_at: b.due_at,
      reason: b.reason,
      related_deal_interest_id: b.related_deal_interest_id || null,
      triggered_by_interaction_id: b.triggered_by_interaction_id || null,
    };
    const { data, error } = await deps.nportClient
      .from('crm_followup').insert(payload).select().maybeSingle();
    if (error) throw error;
    return res.status(201).json({ followup: data });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- PATCH /api/intel/crm/followups/:id -------------------------------------
router.patch('/crm/followups/:id', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const updates = pickAllowedFields(req.body, CRM_FOLLOWUP_PATCHABLE);
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no allowed fields' });
    if (updates.status && !CRM_FOLLOWUP_STATUSES.has(updates.status))
      return badRequest(res, `invalid status: ${updates.status}`);
    const { data, error } = await deps.nportClient
      .from('crm_followup').update(updates).eq('followup_id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) return notFound(res, 'followup not found', 'CRM_FOLLOWUP_NOT_FOUND');
    return res.json({ followup: data });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/followups?due_before=... ----------------------------
router.get('/crm/followups', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const dueBefore = req.query.due_before || new Date().toISOString();
    const status = req.query.status || 'open';
    const { data, error } = await deps.nportClient
      .from('crm_followup')
      .select('*,crm_person(person_id,full_name,firm_id)')
      .lte('due_at', dueBefore)
      .eq('status', status)
      .order('due_at', { ascending: true })
      .limit(200);
    if (error) throw error;
    return res.json({ rows: data || [] });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/firms/search?q= -------------------------------------
// MUST be declared before /crm/firms/:id so 'search' isn't captured as :id.
// Firm autocomplete source for the Add-person modal.
router.get('/crm/firms/search', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ rows: [] });
    const like = `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`;
    const { data, error } = await deps.nportClient
      .from('crm_firm')
      .select('firm_id,display_name,website_url')
      .ilike('display_name', like)
      .order('display_name', { ascending: true })
      .limit(10);
    if (error) throw error;
    return res.json({ rows: data || [] });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/firms/:id -------------------------------------------
router.get('/crm/firms/:id', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const { data: firm } = await deps.nportClient
      .from('crm_firm').select('*').eq('firm_id', id).maybeSingle();
    if (!firm) return notFound(res, 'firm not found', 'CRM_FIRM_NOT_FOUND');
    const { data: identities } = await deps.nportClient
      .from('crm_firm_identity').select('*').eq('firm_id', id);
    const { data: people } = await deps.nportClient
      .from('crm_person').select('person_id,full_name,title,role,email,engagement_status,priority')
      .eq('firm_id', id)
      .order('priority').order('full_name');
    const { data: summary } = await deps.nportClient
      .from('crm_firm_exposure_summary').select('*').eq('firm_id', id).maybeSingle();

    // Auto-enriched intel from the manager-enrichment corpus (web search /
    // LinkedIn). UNVERIFIED — v2 is known to mis-attribute some LinkedIn rows
    // (e.g. Starbridge→linkedin/wix-com), so the UI surfaces this clearly
    // labeled with its confidence, never as ground truth. Picks the
    // highest-confidence row (with a site/LinkedIn) for any of the firm's CRDs.
    // Team is deliberately NOT surfaced yet: the v2-era team_members column
    // contains known hallucinations (literal "John Doe / Jane Smith"
    // placeholders) that v3's anchor gate hasn't scrubbed on partial rows.
    // Re-enable team once the v3 cron has rebuilt it from verified sources.
    let enriched = null;
    const crds = Array.from(new Set((identities || []).map(i => i.adviser_crd).filter(Boolean)));
    if (crds.length && deps.formdClient) {
      const { data: em } = await deps.formdClient
        .from('enriched_managers')
        .select('linked_crd,website_url,linkedin_company_url,twitter_handle,primary_contact_email,enrichment_status,v3_status,confidence_score')
        .in('linked_crd', crds)
        .order('confidence_score', { ascending: false });
      const best = (em || []).find(r => r.website_url || r.linkedin_company_url) || (em || [])[0];
      if (best && (best.website_url || best.linkedin_company_url)) {
        enriched = {
          website_url: best.website_url || null,
          linkedin_company_url: best.linkedin_company_url || null,
          twitter_handle: best.twitter_handle || null,
          primary_contact_email: best.primary_contact_email || null,
          confidence: best.confidence_score != null ? Number(best.confidence_score) : null,
          status: best.v3_status || best.enrichment_status || null,
        };
      }
    }
    return res.json({ firm, identities: identities || [], people: people || [], exposure: summary || null, enriched });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- POST /api/intel/crm/firms/:id/refresh-exposure -------------------------
router.post('/crm/firms/:id/refresh-exposure', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    // Triggers a full MV refresh — cheap with ~thousands of firms.
    const { error } = await deps.nportClient.rpc('refresh_crm_firm_exposure');
    if (error) {
      // RPC may not exist yet; fall back to manual REFRESH via a separate
      // privileged path. For now just signal that the MV refresh failed and
      // the caller should run it server-side.
      return res.status(501).json({
        error: 'MV refresh RPC not configured; run REFRESH MATERIALIZED VIEW CONCURRENTLY crm_firm_exposure_summary server-side',
      });
    }
    return res.json({ refreshed: true });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/firms/:id/exposure ----------------------------------
// Per-company exposure drill-down for a firm (which tracked companies it holds
// and how much). Distinct path from /crm/firms/:id (extra segment).
router.get('/crm/firms/:id/exposure', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const { data, error } = await deps.nportClient.rpc('crm_firm_company_exposure', { p_firm_id: id });
    if (error) throw error;
    return res.json({ rows: data || [] });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/firms/:id/company/:slug/vehicles --------------------
// Drill-down: the individual SPV/fund vehicles a firm holds a company through
// (the "15×" detail). Reads per-evidence rows from crm_holder_exposure_v1 via
// the firm's identities (adviser CRD and/or discovered manager).
router.get('/crm/firms/:id/company/:slug/vehicles', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const slug = String(req.params.slug || '').trim();
    if (!Number.isFinite(id) || !slug) return res.status(400).json({ error: 'firm id + slug required' });
    const { data: idents } = await deps.nportClient
      .from('crm_firm_identity').select('adviser_crd,enriched_manager_id').eq('firm_id', id);
    const crds = Array.from(new Set((idents || []).map(i => i.adviser_crd).filter(Boolean)));
    const mgrs = Array.from(new Set((idents || []).map(i => i.enriched_manager_id).filter(Boolean)));
    if (!crds.length && !mgrs.length) return res.json({ firm_id: id, company_slug: slug, vehicles: [] });

    const cols = 'evidence_id,evidence_label,source_type,nport_value_usd,formd_offering_amount,evidence_date,accession_number';
    const byId = new Map();
    // evidence_id is source-LOCAL (position_id for N-PORT, offering_id for Form D),
    // so dedup on a composite key — otherwise an N-PORT id and a Form D id that
    // happen to be equal would collide and drop a real vehicle.
    const collect = (rows) => { for (const r of (rows || [])) byId.set(`${r.source_type}:${r.evidence_id}`, r); };
    if (crds.length) {
      const { data, error } = await deps.nportClient.from('crm_holder_exposure_v1')
        .select(cols).eq('company_slug', slug).in('adviser_crd', crds);
      if (error) throw error;
      collect(data);
    }
    if (mgrs.length) {
      const { data, error } = await deps.nportClient.from('crm_holder_exposure_v1')
        .select(cols).eq('company_slug', slug).in('discovered_manager_id', mgrs);
      if (error) throw error;
      collect(data);
    }
    const vehicles = Array.from(byId.values()).map(r => {
      const isFormd = r.source_type === 'formd_pooled_vehicle';
      return {
      vehicle: r.evidence_label,
      is_formd: isFormd,
      // N-PORT value is a holding fair-value MARK; Form D is the vehicle's OFFERING
      // size — not comparable. Labeled by kind; sorted within source, never mixed.
      amount_kind: isFormd ? 'formd_offering' : 'nport_mark',
      amount_usd: r.nport_value_usd != null ? Number(r.nport_value_usd)
        : (r.formd_offering_amount != null ? Number(r.formd_offering_amount) : null),
      evidence_date: r.evidence_date,
      accession_number: r.accession_number,
      };
    }).sort((a, b) => (Number(a.is_formd) - Number(b.is_formd)) || (b.amount_usd || 0) - (a.amount_usd || 0));
    return res.json({ firm_id: id, company_slug: slug, count: vehicles.length, vehicles });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/companies/search?q= ---------------------------------
// Picker source: tracked companies by slug/display_name (replaces free text).
router.get('/crm/companies/search', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 1) return res.json({ rows: [] });
    const like = `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`;
    const { data, error } = await deps.nportClient
      .from('private_companies')
      .select('slug,display_name,sector,lifecycle_status')
      .or(`display_name.ilike.${like},slug.ilike.${like}`)
      .order('display_name', { ascending: true })
      .limit(12);
    if (error) throw error;
    return res.json({ rows: data || [] });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/company/:slug/holders -------------------------------
// Portco view: which CRM firms (and their people) hold this tracked company.
router.get('/crm/company/:slug/holders', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const { data: firms, error } = await deps.nportClient
      .rpc('crm_company_holder_firms', { p_slug: slug });
    if (error) throw error;
    const firmIds = (firms || []).map(f => f.firm_id);
    let peopleByFirm = {};
    if (firmIds.length) {
      const { data: people } = await deps.nportClient
        .from('crm_person')
        .select('person_id,firm_id,full_name,title,email,linkedin_url,engagement_status,priority')
        .in('firm_id', firmIds)
        .order('priority').order('full_name');
      for (const p of (people || [])) {
        (peopleByFirm[p.firm_id] = peopleByFirm[p.firm_id] || []).push(p);
      }
    }
    const { data: company } = await deps.nportClient
      .from('private_companies').select('slug,display_name,sector,lifecycle_status').eq('slug', slug).maybeSingle();
    const rows = (firms || []).map(f => ({ ...f, people: peopleByFirm[f.firm_id] || [] }));
    return res.json({ company: company || { slug }, firms: rows });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- POST /api/intel/crm/add-by-company ------------------------------------
// Triggers the Python seed script in fund-holders-intel worktree.
// Default dry-run (preview); pass execute=true to write.
const { spawn } = require('child_process');
const fs = require('fs');

const INTEL_WORKTREE = '/Users/Miles/projects/PrivateFundsRadar-fund-holders-intel';
const VENV_PYTHON = `${INTEL_WORKTREE}/.venv/bin/python`;

function runSeedScript(scriptArgs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(VENV_PYTHON, scriptArgs, {
      cwd: INTEL_WORKTREE,
      timeout: 180000,  // 3min cap
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => resolve({ code, stdout, stderr }));
  });
}

router.post('/crm/add-by-company', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const b = req.body || {};
    if (!b.company_slug) return badRequest(res, 'company_slug required');
    if (!/^[a-z0-9-]+$/.test(b.company_slug)) return badRequest(res, 'invalid company_slug format');
    const dryRun = b.execute !== true;  // default to dry-run for safety

    const args = ['intelligence/crm/add_by_tracked_company.py', '--company', b.company_slug];
    if (!dryRun) args.push('--execute');
    if (b.filter) {
      if (!['has_contact','email_only','none'].includes(b.filter)) {
        return badRequest(res, 'invalid filter');
      }
      args.push('--filter', b.filter);
    }
    if (b.include_owners) args.push('--include-owners');

    const { code, stdout, stderr } = await runSeedScript(args);
    if (code !== 0) {
      return res.status(500).json({ error: 'seed failed', code, stderr: stderr.slice(0, 500) });
    }
    // Read audit report
    const reportPath = `${INTEL_WORKTREE}/intelligence/out/crm_add_by_tracked_company_${b.company_slug}.json`;
    let audit = null;
    if (fs.existsSync(reportPath)) {
      try {
        audit = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      } catch (e) { /* skip */ }
    }
    return res.json({ dry_run: dryRun, exit_code: code, audit, stdout_tail: stdout.split('\n').slice(-20).join('\n') });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- POST /api/intel/crm/add-by-firm ---------------------------------------
router.post('/crm/add-by-firm', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const b = req.body || {};
    if (!b.crd && !b.enriched_manager_id) {
      return badRequest(res, 'crd or enriched_manager_id required');
    }
    if (b.crd && b.enriched_manager_id) {
      return badRequest(res, 'pass crd OR enriched_manager_id, not both');
    }
    const dryRun = b.execute !== true;
    const args = ['intelligence/crm/add_by_firm.py'];
    if (b.crd) {
      if (!/^[0-9]+$/.test(String(b.crd))) return badRequest(res, 'crd must be numeric');
      args.push('--crd', String(b.crd));
    } else {
      if (!/^[0-9a-f-]{36}$/i.test(String(b.enriched_manager_id))) return badRequest(res, 'invalid uuid');
      args.push('--enriched-manager-id', b.enriched_manager_id);
    }
    if (!dryRun) args.push('--execute');
    if (b.filter && ['has_contact','email_only','none'].includes(b.filter)) {
      args.push('--filter', b.filter);
    }
    if (b.include_owners) args.push('--include-owners');

    const { code, stdout, stderr } = await runSeedScript(args);
    if (code !== 0) {
      return res.status(500).json({ error: 'seed failed', code, stderr: stderr.slice(0, 500) });
    }
    return res.json({ dry_run: dryRun, exit_code: code, stdout_tail: stdout.split('\n').slice(-30).join('\n') });
  } catch (err) {
    return serverError(res, err);
  }
});

// --- GET /api/intel/crm/export.csv ------------------------------------------
router.get('/crm/export.csv', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const rows = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await deps.nportClient
        .from('crm_person')
        .select('person_id,firm_id,full_name,title,role,email,linkedin_url,twitter_handle,engagement_status,priority,tags,do_not_contact,added_via,added_for_companies,created_at,updated_at')
        .order('person_id')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      rows.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    const headers = ['person_id','firm_id','full_name','title','role','email','linkedin_url','twitter_handle','engagement_status','priority','tags','do_not_contact','added_via','added_for_companies','created_at','updated_at'];
    const accessors = headers.map(h => (r) => r[h]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="crm-people.csv"`);
    res.send(rowsToCsv(headers, rows, accessors));
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
