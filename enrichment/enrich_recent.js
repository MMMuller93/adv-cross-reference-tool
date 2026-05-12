/**
 * RECENT MANAGERS ENRICHMENT
 * Enriches the N most recent new managers (by filing date)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
// USE V2 ENGINE - has Twitter, email extraction, and AI team extraction
const { enrichManager, saveEnrichment } = require('./enrichment_engine_v2');
// A11.1: shared ADV lookup so we can skip enriching managers who ARE already registered
const { checkAdvDatabase } = require('../lib/adv_lookup');

// Form D database - use environment variables for GitHub Actions, fallback to defaults for local dev
const SUPABASE_FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const SUPABASE_FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

// ADV database (separate from Form D)
const ADV_URL = process.env.ADV_URL || 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = process.env.ADV_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

console.log(`[Config] Form D URL: ${SUPABASE_FORMD_URL.substring(0, 30)}...`);
console.log(`[Config] ADV URL:    ${ADV_URL.substring(0, 30)}...`);
console.log(`[Config] Using ${process.env.FORMD_SERVICE_KEY ? 'environment' : 'default'} credentials`);

const formdClient = createClient(SUPABASE_FORMD_URL, SUPABASE_FORMD_KEY);
const enrichedClient = createClient(SUPABASE_FORMD_URL, SUPABASE_FORMD_KEY);
const advClient = createClient(ADV_URL, ADV_KEY);

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

  // Production bug 2026-05-11: this used to gate on `entityname ILIKE '%a series of%'`,
  // which excluded 72.5% of recent unmatched pooled-fund filings (any fund whose
  // entityname didn't use the series-of platform naming convention). Funds like
  // "Vaark Syndicate I LLC" appeared on the New Managers tab but were NEVER
  // enriched — no website, no team. A 10-second Google for "Vaark Syndicate"
  // returned vaark.vc immediately.
  //
  // New gate: industrygrouptype='Pooled Investment Fund' AND non-amendment.
  // This aligns the enrichment input with the detector's scope.
  const allFilings = [];
  const BATCH_SIZE = 1000;
  let lastId = 999999999;

  while (allFilings.length < 2000) {
    const { data: batch, error } = await formdClient
      .from('form_d_filings')
      .select('id, entityname, filing_date, related_names, related_roles, stateorcountry, nameofsigner, industrygrouptype, isamendment')
      .eq('industrygrouptype', 'Pooled Investment Fund')
      .neq('isamendment', 'true')
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
    console.log(`[Fetch] Fetched ${allFilings.length} pooled-fund filings so far (latest: ${batch[0]?.filing_date})...`);

    if (batch.length < BATCH_SIZE) break;
  }

  const sortedFilings = allFilings.sort((a, b) => {
    const dateA = parseFilingDate(a.filing_date);
    const dateB = parseFilingDate(b.filing_date);
    return dateB - dateA;
  });

  console.log(`[Fetch] Total pooled-fund filings: ${sortedFilings.length}`);
  if (sortedFilings.length > 0) {
    console.log(`[Fetch] Most recent: ${sortedFilings[0].filing_date} - ${sortedFilings[0].entityname?.substring(0, 50)}...`);
  }

  // Extract manager identity using the SAME logic the detector uses.
  // For "a series of X" filings, uses the series master.
  // For non-series filings (e.g., "Vaark Syndicate I LLC"), uses entityname prefix.
  // Platform-admin'd filings (Sydecar, AngelList admin-only, Assure, etc.) route
  // to the real GP via related_names.
  const { detectPlatform } = require('../lib/platform_detection');
  const seriesPattern = /,?\s+a\s+series\s+of\s+(.+?)(?:\s*,?\s*$|$)/i;
  const seen = new Set();
  const managers = [];

  for (const filing of sortedFilings) {
    const en = filing.entityname || '';
    const platform = detectPlatform(filing);
    let candidate;
    const seriesMatch = en.match(seriesPattern);
    if (seriesMatch) {
      candidate = seriesMatch[1].trim();
      // If the series-master IS the platform (Sydecar/CGF2021/Roll Up Vehicles/etc.),
      // skip — the platform isn't the GP; the real manager-identity needs deeper work
      // that the enrichment engine isn't equipped to do for these. They show on the
      // tab as platform-routed; not enriched here.
      if (platform.is_platform) continue;
    } else {
      // Non-series: strip suffixes to get firm-name prefix
      candidate = en
        .replace(/,?\s*(LP|LLC|L\.P\.|L\.L\.C\.|Ltd|Limited|Inc|Incorporated)\.?\s*$/i, '')
        .replace(/\s+(Fund\s+)?[IVX]+$/i, '')
        .replace(/\s+Fund\s+\d+$/i, '')
        .trim();
      // Require at least 4 chars and 2 alphabetic tokens to avoid spurious "Fund I" etc.
      const tokens = candidate.split(/\s+/).filter(t => /[a-zA-Z]/.test(t));
      if (candidate.length < 4 || tokens.length < 2) continue;
    }
    if (!candidate) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    managers.push({
      series_master_llc: candidate,
      filing_date: filing.filing_date,
    });
    if (managers.length >= limit) break;
  }

  console.log(`[Fetch] Found ${managers.length} unique managers (pooled-fund, non-platform; series + non-series)`);
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
  const notInEnrichedTable = managers.filter(m => !enrichedNames.has(m.series_master_llc.toLowerCase()));
  console.log(`[Filter] ${enriched?.length || 0} in enriched_managers, ${notInEnrichedTable.length} not yet enriched`);

  // A11.1: also check advisers_enriched (ADV DB). If a manager is already a
  // registered RIA or ERA, we don't need to web-enrich them — their website,
  // phone, and CCO email are already in Form ADV. Skip and pull from ADV instead.
  // Per docs/ANALYSIS_COMPLIANCE_ENRICHMENT_FIXES.md Enrichment Issue #1
  // (documented Jan 8, 2026, never previously shipped).
  console.log('[Filter] Cross-checking advisers_enriched to skip already-registered managers...');
  const trulyUnenriched = [];
  let skippedRegistered = 0;
  for (const m of notInEnrichedTable) {
    const advHit = await checkAdvDatabase(advClient, m.series_master_llc);
    if (advHit.found) {
      skippedRegistered++;
      console.log(`  ⏭️  Skipping ${m.series_master_llc} (already registered: ${advHit.adviser_name}, CRD ${advHit.crd}, via ${advHit.source})`);
      // Optionally pre-seed enriched_managers from ADV here in the future
      continue;
    }
    trulyUnenriched.push(m);
  }
  console.log(`[Filter] Skipped ${skippedRegistered} already-registered managers; ${trulyUnenriched.length} truly need web enrichment`);
  return trulyUnenriched;
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
