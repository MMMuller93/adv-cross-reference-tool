/**
 * Cross-source consolidator
 *
 * Implements the cross-DB join pattern from PLAN_NPORT_HOLDINGS.md §7.2 used by
 * GET /api/nport/companies/:slug/cross.
 *
 * The three Supabase clients are built using the same URLs/anon keys as the
 * existing pattern in server.js. Keeping the credentials inline (not in env)
 * matches the existing convention in this codebase — see server.js lines
 * 188-196. N-PORT credentials come from env vars per the assignment.
 *
 * All three lookups fire in parallel via Promise.all.
 */

const { createClient } = require('@supabase/supabase-js');
const { nportClient } = require('./nport_client');

// Same ADV + Form D credentials used in server.js (anon read-only keys).
const ADV_SUPABASE_URL = 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

const FORMD_SUPABASE_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const advClient = createClient(ADV_SUPABASE_URL, ADV_SUPABASE_KEY);
const formdClient = createClient(FORMD_SUPABASE_URL, FORMD_SUPABASE_KEY);

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

/**
 * Build the consolidated company view across N-PORT, Form D, and ADV.
 *
 * @param {string} slug — private_companies.slug
 * @param {object} [deps] — optional injected clients (used by tests)
 * @returns {Promise<object|null>} consolidated view, or null if company not found
 */
async function getCrossSourceCompanyView(slug, deps = {}) {
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
    .order('report_period_end', { ascending: false });

  // Use ilike for permissive name match against Form D entity columns.
  const safeName = String(company.display_name || '').replace(/[%,]/g, ' ').trim();
  const formdPromise = safeName
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
  const crdList = uniqueAdvCrds(nportPositions);
  let advAdvisers = [];
  if (crdList.length > 0) {
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
  getCrossSourceCompanyView,
};
