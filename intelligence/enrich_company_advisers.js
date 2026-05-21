/**
 * Run PFR's enrichment_engine_v2 against every adviser CRD that shows up
 * as a holder of a tracked private company.
 *
 * Why this exists: the existing PFR enrichment pipeline runs against
 * Form D series-master LLCs discovered from filer names. It DOESN'T run
 * against registered investment advisers from advisers_enriched. As a
 * result, firms like Manhattan West / Coatue / AUGUREY don't have rows
 * in enriched_managers, and the intel API's JOIN returns no
 * team_members / website / linkedin_company_url / etc. for them.
 *
 * Fix: pull the adviser CRDs surfaced by /api/intel/companies/:slug/holders,
 * look up their firm names in advisers_enriched, run enrichManager() on
 * each, and upsert into enriched_managers with linked_crd set so the
 * intel API's existing JOIN picks them up.
 *
 * Usage:
 *   node intelligence/enrich_company_advisers.js --company anthropic
 *   node intelligence/enrich_company_advisers.js --company anthropic --delay 4000
 *   node intelligence/enrich_company_advisers.js --company anthropic --limit 5  # smoke test
 */

// Env loaded by the caller (source /path/to/.env before running). We do NOT
// require('dotenv') here so this script works from either PFR root or the
// intel worktree without depending on whose node_modules has dotenv.
const path = require('path');

const { createClient } = require('@supabase/supabase-js');
const { enrichManager } = require('/Users/Miles/projects/PrivateFundsRadar/enrichment/enrichment_engine_v2');

const NPORT_URL = process.env.SUPABASE_URL_NPORT;
const NPORT_KEY = process.env.SUPABASE_SERVICE_KEY_NPORT;
const ADV_URL = process.env.SUPABASE_URL_ADV || process.env.ADV_SUPABASE_URL || 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = process.env.SUPABASE_ANON_KEY_ADV || process.env.ADV_SUPABASE_ANON_KEY;
const FORMD_URL = process.env.SUPABASE_URL_FORMD || process.env.FORMD_SUPABASE_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || process.env.SUPABASE_ANON_KEY_FORMD || process.env.FORMD_SUPABASE_ANON_KEY;

if (!NPORT_URL || !NPORT_KEY) {
  console.error('Missing SUPABASE_URL_NPORT / SUPABASE_SERVICE_KEY_NPORT');
  process.exit(1);
}
if (!ADV_KEY) {
  console.error('Missing SUPABASE_ANON_KEY_ADV');
  process.exit(1);
}
if (!FORMD_KEY) {
  console.error('Missing FORMD_SERVICE_KEY / SUPABASE_ANON_KEY_FORMD');
  process.exit(1);
}

const nport = createClient(NPORT_URL, NPORT_KEY);
const adv = createClient(ADV_URL, ADV_KEY);
const formd = createClient(FORMD_URL, FORMD_KEY);

// --- args -------------------------------------------------------------
function parseArgs() {
  const args = { company: null, limit: null, delay: 3000, force: false, dryRun: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--company') args.company = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--delay') args.delay = parseInt(argv[++i], 10);
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

// --- core -------------------------------------------------------------
async function getCrdsForCompany(company) {
  // Pull every distinct adviser_crd that appears in v_intel_company_holders
  const allRows = [];
  let lastId = 0;
  while (true) {
    const { data, error } = await nport
      .from('v_intel_company_holders')
      .select('adviser_crd,evidence_id')
      .eq('company_slug', company)
      .not('adviser_crd', 'is', null)
      .gt('evidence_id', lastId)
      .order('evidence_id')
      .limit(1000);
    if (error) throw error;
    if (!data || !data.length) break;
    allRows.push(...data);
    lastId = parseInt(data[data.length - 1].evidence_id, 10);
    if (data.length < 1000) break;
  }
  return [...new Set(allRows.map(r => String(r.adviser_crd)))].sort();
}

async function getFirmNamesByCrd(crds) {
  const out = {};
  for (let i = 0; i < crds.length; i += 100) {
    const chunk = crds.slice(i, i + 100);
    const { data, error } = await adv
      .from('advisers_enriched')
      .select('crd,adviser_name')
      .in('crd', chunk);
    if (error) throw error;
    for (const row of (data || [])) out[String(row.crd)] = row.adviser_name;
  }
  return out;
}

async function alreadyEnrichedCrds(crds) {
  const out = new Set();
  for (let i = 0; i < crds.length; i += 100) {
    const chunk = crds.slice(i, i + 100);
    const { data } = await formd
      .from('enriched_managers')
      .select('linked_crd,website_url,linkedin_company_url')
      .in('linked_crd', chunk);
    for (const row of (data || [])) {
      // Consider "enriched" only if we got at least one useful field.
      if (row.website_url || row.linkedin_company_url) {
        out.add(String(row.linked_crd));
      }
    }
  }
  return out;
}

async function upsertEnrichment(crd, firmName, enrichmentData) {
  // Map enrichmentData (engine output) to enriched_managers columns. Set
  // linked_crd so the intel API JOIN picks it up.
  const row = {
    series_master_llc: firmName,
    linked_crd: crd,
    website_url: enrichmentData.website_url,
    linkedin_company_url: enrichmentData.linkedin_company_url,
    twitter_handle: enrichmentData.twitter_handle,
    primary_contact_email: enrichmentData.primary_contact_email,
    team_members: enrichmentData.team_members && enrichmentData.team_members.length
      ? enrichmentData.team_members
      : null,
    fund_type: enrichmentData.fund_type,
    investment_stage: enrichmentData.investment_stage,
    confidence_score: enrichmentData.confidence_score,
    enrichment_status: enrichmentData.enrichment_status || 'auto_enriched',
    enrichment_source: 'intel_company_advisers',
    enrichment_date: new Date().toISOString(),
  };

  // Find existing by linked_crd first (preferred), fall back to firm name.
  const { data: existing } = await formd
    .from('enriched_managers')
    .select('id,enrichment_status')
    .eq('linked_crd', crd)
    .limit(1);

  if (existing && existing.length) {
    const exid = existing[0].id;
    if (existing[0].enrichment_status === 'manually_verified') {
      console.log(`  · skipping update — manually_verified row exists for CRD ${crd}`);
      return;
    }
    const { error } = await formd
      .from('enriched_managers')
      .update(row)
      .eq('id', exid);
    if (error) throw error;
  } else {
    const { error } = await formd.from('enriched_managers').insert(row);
    if (error) throw error;
  }
}

function summary(d) {
  const bits = [];
  if (d.website_url) bits.push(`web=${d.website_url.replace(/^https?:\/\//, '').slice(0, 30)}`);
  if (d.linkedin_company_url) bits.push('LI');
  if (d.team_members && d.team_members.length) bits.push(`team=${d.team_members.length}`);
  if (d.primary_contact_email) bits.push(`email=${d.primary_contact_email.slice(0, 30)}`);
  if (d.twitter_handle) bits.push(`tw=${d.twitter_handle}`);
  return bits.length ? bits.join(' ') : '(no signals)';
}

async function main() {
  const args = parseArgs();
  if (!args.company) {
    console.error('Usage: node enrich_company_advisers.js --company SLUG [--limit N] [--delay MS] [--force] [--dry-run]');
    process.exit(2);
  }

  console.log(`Pulling adviser CRDs for company '${args.company}'…`);
  const crds = await getCrdsForCompany(args.company);
  console.log(`  ${crds.length} distinct CRDs hold this company`);

  const names = await getFirmNamesByCrd(crds);
  console.log(`  Resolved ${Object.keys(names).length} firm names from advisers_enriched`);

  let toEnrich = crds.filter(c => names[c]);
  if (!args.force) {
    const skipSet = await alreadyEnrichedCrds(toEnrich);
    const before = toEnrich.length;
    toEnrich = toEnrich.filter(c => !skipSet.has(c));
    console.log(`  Skipping ${before - toEnrich.length} already-enriched CRDs (use --force to override)`);
  }
  if (args.limit) toEnrich = toEnrich.slice(0, args.limit);
  console.log(`  Will enrich ${toEnrich.length} firms with ${args.delay}ms between calls`);

  let succeeded = 0, failed = 0, empty = 0;
  for (let i = 0; i < toEnrich.length; i++) {
    const crd = toEnrich[i];
    const firmName = names[crd];
    console.log(`\n[${i + 1}/${toEnrich.length}] CRD ${crd}: ${firmName}`);
    try {
      const enrichmentData = await enrichManager(firmName, { skipValidation: false });
      console.log(`  -> ${summary(enrichmentData)} (confidence=${enrichmentData.confidence_score})`);
      if (!enrichmentData.website_url && !enrichmentData.linkedin_company_url
          && !(enrichmentData.team_members || []).length) {
        empty++;
      }
      if (!args.dryRun) {
        await upsertEnrichment(crd, firmName, enrichmentData);
      }
      succeeded++;
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      failed++;
    }
    if (i < toEnrich.length - 1) await new Promise(r => setTimeout(r, args.delay));
  }
  console.log(`\nDone. succeeded=${succeeded} (empty=${empty}) failed=${failed}`);

  // Always run the Python validator over the rows we just wrote. PFR's
  // enrichment_engine_v2 sometimes returns wrong data even when its own AI
  // validation flagged a mismatch (Codex 2026-05-20 review). The validator
  // nulls fields that fail plausibility checks (discord.gg primary_website,
  // unrelated Twitter handles, etc.) so the live UI never shows them.
  if (!args.dryRun && succeeded > 0) {
    console.log('\nRunning plausibility validator on rows just written…');
    const { spawnSync } = require('child_process');
    const venvPython = '/Users/Miles/projects/PrivateFundsRadar-fund-holders-intel/.venv/bin/python';
    const result = spawnSync(venvPython, [
      path.join(__dirname, 'cleanup_enriched_managers.py'),
      '--source', 'intel_company_advisers',
      '--execute',
    ], {
      env: { ...process.env },
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.warn('  validator exited non-zero — manual cleanup may be needed.');
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
