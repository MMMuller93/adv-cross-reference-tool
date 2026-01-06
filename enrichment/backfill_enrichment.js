/**
 * BACKFILL ENRICHMENT SCRIPT
 *
 * Processes ALL unenriched managers in the database, not just recent ones.
 * Use this to catch up on the backlog of managers that haven't been enriched yet.
 *
 * Usage:
 *   node backfill_enrichment.js              # Process all unenriched (default 500 limit)
 *   node backfill_enrichment.js 1000         # Process up to 1000 managers
 *   node backfill_enrichment.js --continue   # Resume from where we left off
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { enrichManager, saveEnrichment } = require('./enrichment_engine_v2');

// Database connections
const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const formdClient = createClient(FORMD_URL, FORMD_KEY);

const LIMIT = parseInt(process.argv[2]) || 500;
const DELAY_MS = 2500; // 2.5 seconds between requests to avoid rate limits

// Admin umbrellas to skip
const ADMIN_UMBRELLAS = [
  'roll up vehicles', 'angellist funds', 'angellist-gp-funds',
  'multimodal ventures', 'mv funds', 'cgf2021 llc', 'sydecar',
  'assure spv', 'carta spv', 'allocations.com'
];

function isAdminUmbrella(name) {
  if (!name) return false;
  const lowerName = name.toLowerCase();
  return ADMIN_UMBRELLAS.some(umbrella => lowerName.includes(umbrella));
}

/**
 * Get ALL unique series masters from Form D filings that haven't been enriched
 */
async function getAllUnenrichedManagers(limit) {
  console.log(`[Backfill] Finding up to ${limit} unenriched managers...`);

  // Get all enriched manager names first
  const { data: enriched, error: enrichedError } = await formdClient
    .from('enriched_managers')
    .select('series_master_llc');

  if (enrichedError) {
    console.error('[Backfill] Error fetching enriched managers:', enrichedError.message);
    return [];
  }

  const enrichedNames = new Set((enriched || []).map(e => e.series_master_llc?.toLowerCase()));
  console.log(`[Backfill] Found ${enrichedNames.size} already enriched managers`);

  // Get all Form D filings with series pattern using keyset pagination
  const seriesPattern = /,?\s+a\s+series\s+of\s+(.+?)(?:\s*,?\s*$|$)/i;
  const seen = new Set();
  const managers = [];

  let lastId = 0;
  const BATCH_SIZE = 1000;
  let totalFilings = 0;

  while (managers.length < limit) {
    const { data: batch, error } = await formdClient
      .from('form_d_filings')
      .select('id, entityname')
      .ilike('entityname', '%a series of%')
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      console.error('[Backfill] Error fetching filings:', error.message);
      break;
    }
    if (!batch || batch.length === 0) break;

    totalFilings += batch.length;
    lastId = batch[batch.length - 1].id;

    // Extract unique series masters
    for (const filing of batch) {
      const match = (filing.entityname || '').match(seriesPattern);
      if (match) {
        const masterLlc = match[1].trim();
        const key = masterLlc.toLowerCase();

        // Skip if already enriched, already seen, or admin umbrella
        if (enrichedNames.has(key) || seen.has(key) || isAdminUmbrella(masterLlc)) {
          continue;
        }

        seen.add(key);
        managers.push({ series_master_llc: masterLlc });

        if (managers.length >= limit) break;
      }
    }

    if (batch.length < BATCH_SIZE) break;

    console.log(`[Backfill] Scanned ${totalFilings} filings, found ${managers.length} unenriched...`);
  }

  console.log(`[Backfill] Total unenriched managers found: ${managers.length}`);
  return managers;
}

async function main() {
  console.log('='.repeat(80));
  console.log('BACKFILL ENRICHMENT - Processing All Unenriched Managers');
  console.log('='.repeat(80));
  console.log();
  console.log(`Target: ${LIMIT} managers`);
  console.log(`Delay: ${DELAY_MS}ms between requests`);
  console.log(`Estimated time: ~${Math.ceil(LIMIT * DELAY_MS / 1000 / 60)} minutes`);
  console.log();

  const managers = await getAllUnenrichedManagers(LIMIT);

  if (managers.length === 0) {
    console.log('No unenriched managers found! Database is fully enriched.');
    return;
  }

  console.log(`\nProcessing ${managers.length} managers...\n`);

  const results = {
    auto_enriched: 0,
    needs_review: 0,
    no_data: 0,
    platform_spv: 0,
    errors: 0
  };

  const startTime = Date.now();

  for (let i = 0; i < managers.length; i++) {
    const manager = managers[i];
    const progress = `[${i + 1}/${managers.length}]`;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.round((managers.length - i - 1) * DELAY_MS / 1000);

    try {
      console.log(`${progress} Enriching: ${manager.series_master_llc}`);
      console.log(`           Elapsed: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s | Remaining: ~${Math.floor(remaining / 60)}m`);

      const enrichmentData = await enrichManager(manager.series_master_llc);
      await saveEnrichment(enrichmentData);

      const status = enrichmentData.enrichment_status;
      switch (status) {
        case 'auto_enriched':
          results.auto_enriched++;
          console.log(`  ✅ Auto-enriched`);
          if (enrichmentData.website_url) console.log(`     Website: ${enrichmentData.website_url}`);
          if (enrichmentData.twitter_handle) console.log(`     Twitter: ${enrichmentData.twitter_handle}`);
          if (enrichmentData.primary_contact_email) console.log(`     Email: ${enrichmentData.primary_contact_email}`);
          if (enrichmentData.team_members?.length) console.log(`     Team: ${enrichmentData.team_members.length} members`);
          break;
        case 'needs_manual_review':
          results.needs_review++;
          console.log(`  ⏳ Needs review`);
          break;
        case 'platform_spv':
          results.platform_spv++;
          console.log(`  🔖 Platform SPV`);
          break;
        case 'no_data_found':
          results.no_data++;
          console.log(`  ❌ No data found`);
          break;
      }

      // Rate limiting
      if (i < managers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }

    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      results.errors++;
    }

    // Progress update every 25 managers
    if ((i + 1) % 25 === 0) {
      console.log('\n--- PROGRESS UPDATE ---');
      console.log(`  Processed: ${i + 1}/${managers.length}`);
      console.log(`  ✅ Auto-enriched: ${results.auto_enriched}`);
      console.log(`  ⏳ Needs review: ${results.needs_review}`);
      console.log(`  ❌ No data: ${results.no_data}`);
      console.log('------------------------\n');
    }
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);

  console.log('\n' + '='.repeat(80));
  console.log('BACKFILL COMPLETE');
  console.log('='.repeat(80));
  console.log(`\nTotal time: ${Math.floor(totalTime / 60)}m ${totalTime % 60}s`);
  console.log(`\n  ✅ Auto-enriched: ${results.auto_enriched}`);
  console.log(`  ⏳ Needs review: ${results.needs_review}`);
  console.log(`  🔖 Platform SPVs: ${results.platform_spv}`);
  console.log(`  ❌ No data: ${results.no_data}`);
  console.log(`  ⚠️  Errors: ${results.errors}`);
  console.log(`\nTotal: ${managers.length}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
