/**
 * Cross-source consolidator
 *
 * Implements the cross-DB join pattern from PLAN_NPORT_HOLDINGS.md §7.2 used by
 * GET /api/nport/companies/:slug/cross.
 *
 * The three Supabase clients are built from environment variables. Do not
 * hardcode JWTs here; even anon keys should be centrally managed and rotated
 * like other deployment config.
 *
 * All three lookups fire in parallel via Promise.all.
 */

const { createClient } = require('@supabase/supabase-js');
const { nportClient } = require('./nport_client');

const ADV_SUPABASE_URL =
  process.env.ADV_SUPABASE_URL || 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_SUPABASE_KEY = process.env.ADV_SUPABASE_ANON_KEY || '';

const FORMD_SUPABASE_URL =
  process.env.FORMD_SUPABASE_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_SUPABASE_KEY = process.env.FORMD_SUPABASE_ANON_KEY || '';

const advClient = createClient(ADV_SUPABASE_URL, ADV_SUPABASE_KEY || 'placeholder-key');
const formdClient = createClient(FORMD_SUPABASE_URL, FORMD_SUPABASE_KEY || 'placeholder-key');

/**
 * Extract unique ADV CRDs referenced from a list of nport position rows.
 * The nport_company_positions_mv view is expected to carry an adv_crd column
 * once entity resolution wires it through. Rows without it are skipped.
 */
function uniqueAdvCrds(positions = []) {
  const seen = new Set();
  for (const p of positions || []) {
    if (p && p.adv_crd != null && p.adv_crd !== '') seen.add(p.adv_crd);
  }
  return [...seen];
}

function uniqueRegistrantCiks(positions = []) {
  const seen = new Set();
  for (const p of positions || []) {
    if (p && p.registrant_cik != null && p.registrant_cik !== '') {
      seen.add(String(p.registrant_cik));
    }
  }
  return [...seen];
}

async function fetchAdvCrdsFromRegistrants(nport, positions = []) {
  const ciks = uniqueRegistrantCiks(positions);
  if (ciks.length === 0) return [];
  const out = new Set();
  for (let i = 0; i < ciks.length; i += 100) {
    const chunk = ciks.slice(i, i + 100);
    const { data, error } = await nport
      .from('nport_registrants')
      .select('cik, adv_crd')
      .in('cik', chunk);
    if (error) throw error;
    for (const row of data || []) {
      if (row.adv_crd != null && row.adv_crd !== '') out.add(String(row.adv_crd));
    }
  }
  return [...out];
}

/**
 * Build the consolidated company view across N-PORT, Form D, and ADV.
 *
 * @param {string} slug — private_companies.slug
 * @param {object} [deps] — optional injected clients (used by tests)
 * @returns {Promise<object|null>} consolidated view, or null if company not found
 */
async function getCrossSourceCompanyView(slug, deps = {}) {
  const hasInjectedAdv = Boolean(deps.advClient && deps.advClient !== advClient);
  const hasInjectedFormd = Boolean(deps.formdClient && deps.formdClient !== formdClient);
  const nport = deps.nportClient || nportClient;
  const adv = deps.advClient || advClient;
  const formd = deps.formdClient || formdClient;

  const { data: company, error: companyErr } = await nport
    .from('private_companies')
    .select('*')
    .eq('slug', slug)
    .single();

  if (companyErr || !company) return null;

  // Run the three downstream lookups in parallel.
  const positionsPromise = nport
    .from('nport_company_positions_mv')
    .select('*')
    .eq('company_slug', slug)
    .order('report_period_date', { ascending: false });

  // Use ilike for permissive name match against Form D entity columns.
  const safeName = String(company.display_name || '').replace(/[%,]/g, ' ').trim();
  const formdPromise = safeName && (hasInjectedFormd || FORMD_SUPABASE_KEY)
    ? formd
        .from('form_d_filings')
        .select('*')
        .or(
          `entityname.ilike.%${safeName}%,series_master_llc.ilike.%${safeName}%`
        )
    : Promise.resolve({ data: [], error: null });

  const [positionsRes, formdRes] = await Promise.all([
    positionsPromise,
    formdPromise,
  ]);

  if (positionsRes.error) throw positionsRes.error;
  if (formdRes.error) throw formdRes.error;

  const nportPositions = positionsRes.data || [];
  const formDFilings = formdRes.data || [];

  // Second-stage lookup: ADV advisers referenced by the position rows.
  let crdList = uniqueAdvCrds(nportPositions);
  if (crdList.length === 0) {
    crdList = await fetchAdvCrdsFromRegistrants(nport, nportPositions);
  }
  let advAdvisers = [];
  if (crdList.length > 0 && (hasInjectedAdv || ADV_SUPABASE_KEY)) {
    const { data: advData, error: advErr } = await adv
      .from('advisers_enriched')
      .select('*')
      .in('crd', crdList);
    if (advErr) throw advErr;
    advAdvisers = advData || [];
  }

  return {
    company,
    nportPositions,
    formDFilings,
    relatedAdvisers: advAdvisers,
  };
}

module.exports = {
  advClient,
  formdClient,
  nportClient,
  uniqueAdvCrds,
  uniqueRegistrantCiks,
  fetchAdvCrdsFromRegistrants,
  getCrossSourceCompanyView,
};
