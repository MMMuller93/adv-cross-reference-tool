/**
 * RECENT MANAGERS ENRICHMENT
 * Enriches the N most recent new managers (by filing date)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
// USE V2 ENGINE - has Twitter, email extraction, and AI team extraction
const { enrichManager, saveEnrichment } = require('./enrichment_engine_v2');

// Form D database - use environment variables for GitHub Actions, fallback to defaults for local dev
const SUPABASE_FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const SUPABASE_FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

console.log(`[Config] Form D URL: ${SUPABASE_FORMD_URL.substring(0, 30)}...`);
console.log(`[Config] Using ${process.env.FORMD_SERVICE_KEY ? 'environment' : 'default'} credentials`);

const formdClient = createClient(SUPABASE_FORMD_URL, SUPABASE_FORMD_KEY);
const enrichedClient = createClient(SUPABASE_FORMD_URL, SUPABASE_FORMD_KEY);

const LIMIT = parseInt(process.argv[2]) || 100;
const DELAY_MS = 2000; // 2 seconds between requests

/**
 * Parse filing_date which can be in multiple formats:
 * - "DD-MMM-YYYY" (e.g., "31-OCT-2024") - old format
 * - "YYYY-MM-DD" (e.g., "2025-12-09") - new format
 */
function parseFilingDate(dateStr) {
  if (!dateStr) return new Date(0);

  // Try YYYY-MM-DD format first (new format)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }

  // Try DD-MMM-YYYY format (old format)
  const months = {
    'JAN': 0, 'FEB': 1, 'MAR': 2, 'APR': 3, 'MAY': 4, 'JUN': 5,
    'JUL': 6, 'AUG': 7, 'SEP': 8, 'OCT': 9, 'NOV': 10, 'DEC': 11
  };
  const match = dateStr.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/i);
  if (match) {
    const day = parseInt(match[1]);
    const month = months[match[2].toUpperCase()];
    const year = parseInt(match[3]);
    if (month !== undefined) {
      return new Date(year, month, day);
    }
  }

  // Fallback
  return new Date(dateStr);
}

async function getRecentManagers(limit) {
  console.log(`[Fetch] Getting ${limit} most recent new managers...`);

  // Fetch filings with 'a series of' pattern using keyset pagination
  // Fetch from HIGHEST ID (newest) first, then paginate downward
  const allFilings = [];
  const BATCH_SIZE = 1000;
  let lastId = 999999999; // Start from highest possible

  // We only need ~2000 recent filings to get enough unique managers
  while (allFilings.length < 2000) {
    const { data: batch, error } = await formdClient
      .from('form_d_filings')
      .select('id, entityname, filing_date')
      .ilike('entityname', '%a series of%')
      .lt('id', lastId)
      .order('id', { ascending: false })
      .limit(BATCH_SIZE);

    if (error) {
      console.error('[Fetch] Error:', error.message);
      break;
    }
    if (!batch || batch.length === 0) break;

    allFilings.push(...batch);
    lastId = batch[batch.length - 1].id;
    console.log(`[Fetch] Fetched ${allFilings.length} filings so far (latest: ${batch[0]?.filing_date})...`);

    if (batch.length < BATCH_SIZE) break;
  }

  // Sort by parsed date descending (newest first)
  const sortedFilings = allFilings.sort((a, b) => {
    const dateA = parseFilingDate(a.filing_date);
    const dateB = parseFilingDate(b.filing_date);
    return dateB - dateA; // Descending
  });

  console.log(`[Fetch] Total filings: ${sortedFilings.length}`);
  if (sortedFilings.length > 0) {
    console.log(`[Fetch] Most recent: ${sortedFilings[0].filing_date} - ${sortedFilings[0].entityname?.substring(0, 50)}...`);
  }

  // Extract unique series masters
  const seriesPattern = /,?\s+a\s+series\s+of\s+(.+?)(?:\s*,?\s*$|$)/i;
  const adminUmbrellas = ['roll up vehicles', 'angellist funds', 'multimodal ventures', 'mv funds', 'cgf2021 llc', 'sydecar'];
  const seen = new Set();
  const managers = [];

  for (const filing of sortedFilings) {
    const match = (filing.entityname || '').match(seriesPattern);
    if (match) {
      const masterLlc = match[1].trim();
      const isAdmin = adminUmbrellas.some(p => masterLlc.toLowerCase().includes(p));
      if (!isAdmin && !seen.has(masterLlc.toLowerCase())) {
        seen.add(masterLlc.toLowerCase());
        managers.push({
          series_master_llc: masterLlc,
          filing_date: filing.filing_date
        });
      }
    }
    if (managers.length >= limit) break;
  }

  console.log(`[Fetch] Found ${managers.length} unique managers`);
  return managers;
}

async function getUnenrichedManagers(managers) {
  console.log('[Filter] Checking which need enrichment...');

  const { data: enriched, error } = await enrichedClient
    .from('enriched_managers')
    .select('series_master_llc');

  if (error) {
    console.error('[Filter] Error:', error.message);
    return managers;
  }

  const enrichedNames = new Set((enriched || []).map(e => e.series_master_llc.toLowerCase()));
  const unenriched = managers.filter(m => !enrichedNames.has(m.series_master_llc.toLowerCase()));

  console.log(`[Filter] ${enriched?.length || 0} already enriched, ${unenriched.length} need enrichment`);
  return unenriched;
}

async function main() {
  console.log('='.repeat(80));
  console.log(`ENRICHING ${LIMIT} MOST RECENT NEW MANAGERS`);
  console.log('='.repeat(80));
  console.log();

  // Get recent managers
  const recentManagers = await getRecentManagers(LIMIT);
  if (recentManagers.length === 0) {
    console.log('No managers found. Exiting.');
    return;
  }

  // Filter to unenriched only
  const toEnrich = await getUnenrichedManagers(recentManagers);
  if (toEnrich.length === 0) {
    console.log('All recent managers already enriched!');
    return;
  }

  console.log(`\nProcessing ${toEnrich.length} managers...`);
  console.log(`Estimated time: ~${Math.ceil(toEnrich.length * DELAY_MS / 1000 / 60)} minutes\n`);

  const results = {
    auto_enriched: 0,
    needs_review: 0,
    no_data: 0,
    platform_spv: 0,
    errors: 0
  };

  for (let i = 0; i < toEnrich.length; i++) {
    const manager = toEnrich[i];
    const progress = `[${i + 1}/${toEnrich.length}]`;

    try {
      console.log(`${progress} Enriching: ${manager.series_master_llc}`);
      console.log(`           Filed: ${manager.filing_date}`);

      const enrichmentData = await enrichManager(manager.series_master_llc);
      await saveEnrichment(enrichmentData);

      // Log results - v2 uses enrichment_status, v1 used enrichmentStatus
      const status = enrichmentData.enrichment_status || enrichmentData.enrichmentStatus;
      switch (status) {
        case 'auto_enriched':
          results.auto_enriched++;
          console.log(`  ✅ Auto-enriched (confidence: ${enrichmentData.confidence_score?.toFixed(2) || enrichmentData.confidence?.toFixed(2)})`);
          if (enrichmentData.website_url) console.log(`     Website: ${enrichmentData.website_url}`);
          if (enrichmentData.linkedin_company_url) console.log(`     LinkedIn: ${enrichmentData.linkedin_company_url}`);
          if (enrichmentData.twitter_handle) console.log(`     Twitter: ${enrichmentData.twitter_handle}`);
          if (enrichmentData.primary_contact_email) console.log(`     Email: ${enrichmentData.primary_contact_email}`);
          if (enrichmentData.team_members?.length) console.log(`     Team: ${enrichmentData.team_members.length} members`);
          break;
        case 'needs_manual_review':
          results.needs_review++;
          console.log(`  ⏳ Needs review (confidence: ${enrichmentData.confidence_score?.toFixed(2) || 'N/A'})`);
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
      if (i < toEnrich.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }

    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      results.errors++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('ENRICHMENT COMPLETE');
  console.log('='.repeat(80));
  console.log(`\n  ✅ Auto-enriched: ${results.auto_enriched}`);
  console.log(`  ⏳ Needs review: ${results.needs_review}`);
  console.log(`  🔖 Platform SPVs: ${results.platform_spv}`);
  console.log(`  ❌ No data: ${results.no_data}`);
  console.log(`  ⚠️  Errors: ${results.errors}`);
  console.log(`\nTotal: ${toEnrich.length}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
