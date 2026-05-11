/**
 * ENRICH COMPLIANCE VIOLATORS
 *
 * Iterates compliance_issues with discrepancy_type='needs_initial_adv_filing'
 * that don't yet have an entry in enriched_managers, and runs the standard
 * enrichment engine on each.
 *
 * Per docs/ANALYSIS_COMPLIANCE_ENRICHMENT_FIXES.md Enrichment Issue #2 (P1).
 *
 * Usage:
 *   node enrichment/enrich_compliance_violators.js [limit]
 *
 * Respects the shared Brave/Google/Serper rate limits via enrichment_engine_v2.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { enrichManager, saveEnrichment } = require('./enrichment_engine_v2');
const { checkAdvDatabase } = require('../lib/adv_lookup');

const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';
const ADV_URL = process.env.ADV_URL || 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = process.env.ADV_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

const formdClient = createClient(FORMD_URL, FORMD_KEY);
const advClient = createClient(ADV_URL, ADV_KEY);

const LIMIT = parseInt(process.argv[2]) || 50;
const DELAY_MS = 2000;

async function getViolatorsNeedingEnrichment(limit) {
  console.log(`[Fetch] Loading needs_initial_adv_filing compliance issues (limit ${limit})...`);
  const { data: issues, error } = await formdClient
    .from('compliance_issues')
    .select('id, metadata, severity, detected_date')
    .eq('discrepancy_type', 'needs_initial_adv_filing')
    .order('detected_date', { ascending: false })
    .limit(limit * 2); // overfetch in case some are already enriched
  if (error) throw error;

  if (!issues || issues.length === 0) {
    console.log('[Fetch] No active needs_initial_adv_filing issues found.');
    return [];
  }
  console.log(`[Fetch] Fetched ${issues.length} compliance issues`);

  // Extract unique manager names
  const seen = new Set();
  const managers = [];
  for (const issue of issues) {
    const mgrName = issue.metadata?.manager_name || issue.metadata?.entity_name;
    if (!mgrName || mgrName.length < 4) continue;
    if (seen.has(mgrName.toLowerCase())) continue;
    seen.add(mgrName.toLowerCase());
    managers.push({
      series_master_llc: mgrName,
      severity: issue.severity,
      issue_id: issue.id,
      filing_date: issue.metadata?.earliest_filing_date || null,
    });
    if (managers.length >= limit * 2) break;
  }
  console.log(`[Fetch] ${managers.length} unique manager candidates`);

  // Filter out ones already enriched
  const { data: enriched } = await formdClient
    .from('enriched_managers')
    .select('series_master_llc');
  const enrichedSet = new Set((enriched || []).map(e => (e.series_master_llc || '').toLowerCase()));
  let needsEnrichment = managers.filter(m => !enrichedSet.has(m.series_master_llc.toLowerCase()));
  console.log(`[Fetch] ${needsEnrichment.length} not yet enriched`);

  // Final filter: also skip managers that ARE in advisers_enriched
  // (race condition: detector flagged them but matching has since improved.)
  const final = [];
  let skippedRegistered = 0;
  for (const m of needsEnrichment) {
    const advHit = await checkAdvDatabase(advClient, m.series_master_llc);
    if (advHit.found) {
      skippedRegistered++;
      console.log(`  ⏭️  Skipping (now registered): ${m.series_master_llc} → ${advHit.adviser_name} (CRD ${advHit.crd})`);
      continue;
    }
    final.push(m);
    if (final.length >= limit) break;
  }
  if (skippedRegistered > 0) {
    console.log(`[Fetch] Skipped ${skippedRegistered} compliance violators who have since been registered in ADV`);
  }

  return final;
}

async function main() {
  console.log('='.repeat(80));
  console.log(`ENRICHING COMPLIANCE VIOLATORS (needs_initial_adv_filing, limit ${LIMIT})`);
  console.log('='.repeat(80));

  const toEnrich = await getViolatorsNeedingEnrichment(LIMIT);
  if (toEnrich.length === 0) {
    console.log('\nNo violators need enrichment.');
    return;
  }

  console.log(`\nProcessing ${toEnrich.length} compliance violators...`);
  console.log(`Estimated time: ~${Math.ceil(toEnrich.length * DELAY_MS / 1000 / 60)} minutes\n`);

  const results = { auto_enriched: 0, needs_review: 0, no_data: 0, platform_spv: 0, errors: 0 };
  for (let i = 0; i < toEnrich.length; i++) {
    const m = toEnrich[i];
    const progress = `[${i + 1}/${toEnrich.length}]`;
    try {
      console.log(`${progress} Enriching: ${m.series_master_llc} (issue ${m.issue_id}, sev ${m.severity})`);
      const data = await enrichManager(m.series_master_llc);
      await saveEnrichment(data);
      const status = data.enrichment_status || data.enrichmentStatus;
      switch (status) {
        case 'auto_enriched': results.auto_enriched++; console.log(`  ✅ Auto-enriched`); break;
        case 'needs_manual_review': results.needs_review++; console.log(`  ⏳ Needs review`); break;
        case 'platform_spv': results.platform_spv++; console.log(`  🔖 Platform SPV`); break;
        case 'no_data_found': results.no_data++; console.log(`  ❌ No data`); break;
      }
      if (i < toEnrich.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
    } catch (e) {
      console.error(`  ❌ Error: ${e.message}`);
      results.errors++;
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('COMPLIANCE-VIOLATOR ENRICHMENT COMPLETE');
  console.log('='.repeat(80));
  console.log(`  ✅ Auto-enriched: ${results.auto_enriched}`);
  console.log(`  ⏳ Needs review: ${results.needs_review}`);
  console.log(`  🔖 Platform SPVs: ${results.platform_spv}`);
  console.log(`  ❌ No data: ${results.no_data}`);
  console.log(`  ⚠️  Errors: ${results.errors}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Fatal:', err); process.exit(1); });
