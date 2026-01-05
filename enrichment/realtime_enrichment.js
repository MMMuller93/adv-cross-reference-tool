/**
 * REAL-TIME ENRICHMENT TRIGGER
 * 
 * Monitors for new Form D filings and triggers enrichment automatically.
 * Can be run as:
 * 1. Standalone daemon process
 * 2. Cron job
 * 3. Called from server.js on new filing detection
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { enrichAndSaveManager, getUnenrichedManagers, batchEnrich, isAdminUmbrella } = require('./enrichment_engine_v2');

// Database connection
const FORMD_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const formdClient = createClient(FORMD_URL, FORMD_KEY);

// Configuration
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENRICHMENTS_PER_POLL = 10;
const ENRICHMENT_DELAY_MS = 3000; // 3 seconds between enrichments

// Track last processed timestamp
let lastProcessedTimestamp = null;

/**
 * Get new managers detected since last poll
 */
async function getNewManagersSinceLastPoll() {
  const query = formdClient
    .from('form_d_filings')
    .select('series_master_llc, first_time_detected_date, entityname')
    .eq('potential_new_manager', true)
    .not('series_master_llc', 'is', null)
    .order('first_time_detected_date', { ascending: false })
    .limit(100);
  
  if (lastProcessedTimestamp) {
    query.gt('first_time_detected_date', lastProcessedTimestamp);
  } else {
    // First run - get last 24 hours
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    query.gte('first_time_detected_date', yesterday.toISOString());
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.error('[RealTime] Error fetching new managers:', error.message);
    return [];
  }
  
  // Get unique series masters
  const uniqueManagers = [...new Set((data || []).map(f => f.series_master_llc))];
  
  // Filter out admin umbrellas
  const filteredManagers = uniqueManagers.filter(m => !isAdminUmbrella(m));
  
  // Check which are not yet enriched
  const { data: enriched } = await formdClient
    .from('enriched_managers')
    .select('series_master_llc')
    .in('series_master_llc', filteredManagers);
  
  const enrichedSet = new Set((enriched || []).map(e => e.series_master_llc));
  const unenriched = filteredManagers.filter(m => !enrichedSet.has(m));
  
  return unenriched;
}

/**
 * Process new managers - enrich and save
 */
async function processNewManagers() {
  console.log(`\n[RealTime] Checking for new managers at ${new Date().toISOString()}`);
  
  const newManagers = await getNewManagersSinceLastPoll();
  
  if (newManagers.length === 0) {
    console.log('[RealTime] No new managers to process');
    return { processed: 0, results: [] };
  }
  
  console.log(`[RealTime] Found ${newManagers.length} new managers to enrich`);
  
  // Limit per poll to avoid API exhaustion
  const toProcess = newManagers.slice(0, MAX_ENRICHMENTS_PER_POLL);
  const results = [];
  
  for (let i = 0; i < toProcess.length; i++) {
    const manager = toProcess[i];
    console.log(`[RealTime] Processing ${i + 1}/${toProcess.length}: ${manager}`);
    
    try {
      const result = await enrichAndSaveManager(manager);
      results.push({
        manager,
        status: result.enrichment_status,
        confidence: result.confidence_score
      });
    } catch (error) {
      console.error(`[RealTime] Error enriching ${manager}:`, error.message);
      results.push({
        manager,
        status: 'error',
        error: error.message
      });
    }
    
    // Rate limiting
    if (i < toProcess.length - 1) {
      await new Promise(resolve => setTimeout(resolve, ENRICHMENT_DELAY_MS));
    }
  }
  
  // Update last processed timestamp
  lastProcessedTimestamp = new Date().toISOString();
  
  // Summary
  const success = results.filter(r => r.status === 'auto_enriched').length;
  const review = results.filter(r => r.status === 'needs_manual_review').length;
  const failed = results.filter(r => r.status === 'no_data_found' || r.status === 'error').length;
  
  console.log(`[RealTime] Complete: ${success} auto-enriched, ${review} need review, ${failed} failed`);
  
  return {
    processed: results.length,
    remaining: newManagers.length - toProcess.length,
    results,
    summary: { success, review, failed }
  };
}

/**
 * Start the real-time enrichment daemon
 */
function startDaemon() {
  console.log('[RealTime] Starting enrichment daemon...');
  console.log(`[RealTime] Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`[RealTime] Max per poll: ${MAX_ENRICHMENTS_PER_POLL}`);
  
  // Initial run
  processNewManagers();
  
  // Schedule recurring polls
  setInterval(processNewManagers, POLL_INTERVAL_MS);
  
  console.log('[RealTime] Daemon started. Press Ctrl+C to stop.');
}

/**
 * Trigger enrichment for a specific manager (called from API)
 */
async function triggerEnrichment(managerName) {
  console.log(`[RealTime] Manual trigger for: ${managerName}`);
  
  if (isAdminUmbrella(managerName)) {
    return {
      success: false,
      error: 'Manager is an admin umbrella/platform SPV'
    };
  }
  
  try {
    const result = await enrichAndSaveManager(managerName);
    return {
      success: true,
      result
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get enrichment status for a manager
 */
async function getEnrichmentStatus(managerName) {
  const { data, error } = await formdClient
    .from('enriched_managers')
    .select('*')
    .eq('series_master_llc', managerName)
    .single();
  
  if (error || !data) {
    return {
      exists: false,
      status: 'not_enriched'
    };
  }
  
  return {
    exists: true,
    status: data.enrichment_status,
    confidence: data.confidence_score,
    website: data.website_url,
    linkedin: data.linkedin_company_url,
    twitter: data.twitter_handle,
    email: data.primary_contact_email,
    team_count: (data.team_members || []).length,
    enrichment_date: data.enrichment_date
  };
}

/**
 * Get enrichment queue status
 */
async function getQueueStatus() {
  const unenriched = await getUnenrichedManagers(1000, 30);
  
  const { data: enriched } = await formdClient
    .from('enriched_managers')
    .select('enrichment_status')
    .limit(10000);
  
  const statusCounts = {};
  for (const e of (enriched || [])) {
    statusCounts[e.enrichment_status] = (statusCounts[e.enrichment_status] || 0) + 1;
  }
  
  return {
    pending: unenriched.length,
    enriched: (enriched || []).length,
    by_status: statusCounts,
    last_poll: lastProcessedTimestamp
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  processNewManagers,
  triggerEnrichment,
  getEnrichmentStatus,
  getQueueStatus,
  startDaemon
};

// ============================================================================
// CLI EXECUTION
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args[0] === 'daemon') {
    startDaemon();
  } else if (args[0] === 'once') {
    processNewManagers()
      .then(results => {
        console.log('\nResults:', JSON.stringify(results, null, 2));
        process.exit(0);
      })
      .catch(error => {
        console.error('Error:', error);
        process.exit(1);
      });
  } else if (args[0] === 'status') {
    getQueueStatus()
      .then(status => {
        console.log('Queue Status:', JSON.stringify(status, null, 2));
        process.exit(0);
      })
      .catch(error => {
        console.error('Error:', error);
        process.exit(1);
      });
  } else if (args[0]) {
    // Enrich specific manager
    const managerName = args.join(' ');
    triggerEnrichment(managerName)
      .then(result => {
        console.log('Result:', JSON.stringify(result, null, 2));
        process.exit(0);
      })
      .catch(error => {
        console.error('Error:', error);
        process.exit(1);
      });
  } else {
    console.log('Usage:');
    console.log('  node realtime_enrichment.js daemon     - Start daemon process');
    console.log('  node realtime_enrichment.js once       - Run once and exit');
    console.log('  node realtime_enrichment.js status     - Show queue status');
    console.log('  node realtime_enrichment.js "Name"     - Enrich specific manager');
    process.exit(0);
  }
}
