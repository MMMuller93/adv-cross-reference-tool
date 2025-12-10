/**
 * BULK ENRICHMENT SCRIPT
 * Enriches all new managers from the existing Form D database
 */

const { createClient } = require('@supabase/supabase-js');
const { enrichManager, saveEnrichment } = require('./enrichment_engine');

// ============================================================================
// CONFIGURATION
// ============================================================================

const SUPABASE_ADV_URL = 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const SUPABASE_ADV_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

const SUPABASE_FORMD_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const SUPABASE_FORMD_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

// Where enriched data will be stored (same as Form D for now)
const enrichedClient = createClient(SUPABASE_FORMD_URL, SUPABASE_FORMD_KEY);
const formdClient = createClient(SUPABASE_FORMD_URL, SUPABASE_FORMD_KEY);

const BATCH_SIZE = 10; // Process 10 at a time
const DELAY_BETWEEN_REQUESTS_MS = 1500; // 1.5s delay - faster with fallback search providers

// ============================================================================
// FETCH NEW MANAGERS FROM EXISTING DATABASE
// ============================================================================

/**
 * Get all new managers from Form D database
 * (Same logic as /api/funds/new-managers endpoint)
 * Uses keyset pagination to get all results (Supabase has 1000 row limit)
 */
async function getNewManagers() {
  console.log('[Fetch] Fetching new managers from Form D database...');

  try {
    // Fetch all Form D filings with "a series of" pattern using keyset pagination
    const allFilings = [];
    const BATCH_SIZE = 1000;
    let lastId = 0;

    while (true) {
      const { data: batch, error } = await formdClient
        .from('form_d_filings')
        .select('*')
        .ilike('entityname', '%a series of%')
        .gt('id', lastId)
        .order('id', { ascending: true })
        .limit(BATCH_SIZE);

      if (error) throw error;
      if (!batch || batch.length === 0) break;

      allFilings.push(...batch);
      lastId = batch[batch.length - 1].id;
      console.log(`[Fetch] Fetched ${allFilings.length} filings so far...`);

      if (batch.length < BATCH_SIZE) break;
    }

    // Sort by filing_date descending for processing order
    const filings = allFilings.sort((a, b) =>
      new Date(b.filing_date) - new Date(a.filing_date)
    );

    console.log(`[Fetch] Found ${filings.length} Form D filings with series pattern`);

    // Group by series master
    const seriesPattern = /,?\s+a\s+series\s+of\s+(.+?)(?:\s*,?\s*$|$)/i;
    const adminUmbrellas = ['roll up vehicles', 'angellist funds', 'multimodal ventures', 'mv funds', 'cgf2021 llc', 'sydecar'];
    const managers = {};

    filings.forEach(filing => {
      const match = (filing.entityname || '').match(seriesPattern);
      if (match) {
        const masterLlc = match[1].trim();
        const isAdmin = adminUmbrellas.some(p => masterLlc.toLowerCase().includes(p));

        if (!isAdmin) {
          if (!managers[masterLlc]) {
            managers[masterLlc] = {
              series_master_llc: masterLlc,
              first_filing_date: filing.filing_date,
              funds: [],
              total_offering_amount: 0,
              fund_count: 0
            };
          }

          managers[masterLlc].funds.push(filing);
          managers[masterLlc].fund_count++;
          managers[masterLlc].total_offering_amount += parseFloat(filing.totalofferingamount) || 0;

          // Update first filing date if earlier
          if (filing.filing_date < managers[masterLlc].first_filing_date) {
            managers[masterLlc].first_filing_date = filing.filing_date;
          }
        }
      }
    });

    const result = Object.values(managers);
    console.log(`[Fetch] Identified ${result.length} unique new managers`);

    return result;

  } catch (error) {
    console.error('[Fetch] Error fetching new managers:', error.message);
    return [];
  }
}

/**
 * Get managers that have NOT been enriched yet
 */
async function getUnenrichedManagers(allManagers) {
  console.log('[Filter] Checking which managers are already enriched...');

  try {
    // Get all enriched manager names
    const { data: enriched, error } = await enrichedClient
      .from('enriched_managers')
      .select('series_master_llc');

    if (error) throw error;

    const enrichedNames = new Set((enriched || []).map(e => e.series_master_llc.toLowerCase()));

    const unenriched = allManagers.filter(m =>
      !enrichedNames.has(m.series_master_llc.toLowerCase())
    );

    console.log(`[Filter] ${enriched?.length || 0} already enriched, ${unenriched.length} need enrichment`);

    return unenriched;

  } catch (error) {
    console.error('[Filter] Error checking enrichment status:', error.message);
    // If error, assume none are enriched and process all
    return allManagers;
  }
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

/**
 * Process managers in batches
 */
async function processBatch(managers, batchNumber) {
  console.log(`\n[Batch ${batchNumber}] Processing ${managers.length} managers...`);

  const results = {
    auto_enriched: 0,
    needs_review: 0,
    no_data: 0,
    platform_spv: 0,
    errors: 0
  };

  for (let i = 0; i < managers.length; i++) {
    const manager = managers[i];
    const progress = `${i + 1}/${managers.length}`;

    try {
      console.log(`[${progress}] Enriching: ${manager.series_master_llc}`);

      const enrichmentData = await enrichManager(manager.series_master_llc);

      // Save to database
      await saveEnrichment(enrichmentData);

      // Update counters
      switch (enrichmentData.enrichmentStatus) {
        case 'auto_enriched':
          results.auto_enriched++;
          console.log(`  ✅ Auto-enriched (confidence: ${enrichmentData.confidence.toFixed(2)})`);
          break;
        case 'needs_manual_review':
          results.needs_review++;
          console.log(`  ⏳ Needs review (confidence: ${enrichmentData.confidence.toFixed(2)})`);
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
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS_MS));
      }

    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      results.errors++;
    }
  }

  console.log(`\n[Batch ${batchNumber}] Complete:`, results);
  return results;
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('='.repeat(80));
  console.log('BULK ENRICHMENT - NEW MANAGERS');
  console.log('='.repeat(80));
  console.log();

  // Step 1: Fetch all new managers
  const allManagers = await getNewManagers();

  if (allManagers.length === 0) {
    console.log('No managers found. Exiting.');
    return;
  }

  // Step 2: Filter to only unenriched
  const unenrichedManagers = await getUnenrichedManagers(allManagers);

  if (unenrichedManagers.length === 0) {
    console.log('All managers already enriched! ✅');
    return;
  }

  // Step 3: Process in batches
  console.log(`\nProcessing ${unenrichedManagers.length} managers in batches of ${BATCH_SIZE}...`);
  console.log(`Estimated time: ~${Math.ceil(unenrichedManagers.length * DELAY_BETWEEN_REQUESTS_MS / 1000 / 60)} minutes`);
  console.log();

  const totalResults = {
    auto_enriched: 0,
    needs_review: 0,
    no_data: 0,
    platform_spv: 0,
    errors: 0
  };

  for (let i = 0; i < unenrichedManagers.length; i += BATCH_SIZE) {
    const batch = unenrichedManagers.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(unenrichedManagers.length / BATCH_SIZE);

    console.log(`\n${'='.repeat(80)}`);
    console.log(`BATCH ${batchNumber}/${totalBatches}`);
    console.log('='.repeat(80));

    const batchResults = await processBatch(batch, batchNumber);

    // Aggregate results
    Object.keys(batchResults).forEach(key => {
      totalResults[key] += batchResults[key];
    });

    // Progress update
    const processed = Math.min(i + BATCH_SIZE, unenrichedManagers.length);
    const percent = (processed / unenrichedManagers.length * 100).toFixed(1);
    console.log(`\nProgress: ${processed}/${unenrichedManagers.length} (${percent}%)`);
  }

  // Final summary
  console.log('\n' + '='.repeat(80));
  console.log('ENRICHMENT COMPLETE!');
  console.log('='.repeat(80));
  console.log('\nResults:');
  console.log(`  ✅ Auto-enriched (published): ${totalResults.auto_enriched}`);
  console.log(`  ⏳ Needs manual review: ${totalResults.needs_review}`);
  console.log(`  🔖 Platform SPVs (flagged): ${totalResults.platform_spv}`);
  console.log(`  ❌ No data found: ${totalResults.no_data}`);
  console.log(`  ⚠️  Errors: ${totalResults.errors}`);
  console.log(`\nTotal processed: ${unenrichedManagers.length}`);
  console.log();
}

// ============================================================================
// RUN
// ============================================================================

if (require.main === module) {
  main()
    .then(() => {
      console.log('Done!');
      process.exit(0);
    })
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { getNewManagers, getUnenrichedManagers, processBatch };
