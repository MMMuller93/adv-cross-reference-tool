/**
 * retry_runner.js — Nightly CLI for auto-retry of below-bar managers.
 *
 * Processes up to 200 managers per run (limited by external API quotas).
 * Triggered via GitHub Actions cron: '0 6 * * *' (06:00 UTC daily).
 *
 * Usage:
 *   node enrichment/v3/retry_runner.js
 *   node enrichment/v3/retry_runner.js --limit 50
 *   node enrichment/v3/retry_runner.js --dry-run
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { enrichManager } = require('./orchestrator');
const { getDueForRetry, scheduleRetry, estimateRetryCount } = require('./persistence/retry_queue');

const DELAY_MS = 2000; // 2 seconds between requests (rate limit buffer)
const DEFAULT_LIMIT = 200;

function parseArgs() {
  const args = process.argv.slice(2);
  const limit = (() => {
    const idx = args.indexOf('--limit');
    return idx >= 0 ? parseInt(args[idx + 1]) || DEFAULT_LIMIT : DEFAULT_LIMIT;
  })();
  const dryRun = args.includes('--dry-run');
  return { limit, dryRun };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const { limit, dryRun } = parseArgs();

  console.log(`[retry_runner] Starting — limit=${limit}, dryRun=${dryRun}`);

  const dueManagers = await getDueForRetry(limit);
  console.log(`[retry_runner] Found ${dueManagers.length} managers due for retry`);

  if (dueManagers.length === 0) {
    console.log('[retry_runner] Nothing to do. Exiting.');
    return;
  }

  let improved = 0;
  let unchanged = 0;
  let failed = 0;

  for (const row of dueManagers) {
    const name = row.series_master_llc;
    const priorStatus = row.enrichment_status;
    const retryCount = estimateRetryCount(row);

    console.log(`\n[retry_runner] Retrying: "${name}" (prior=${priorStatus}, attempt=${retryCount + 1})`);

    try {
      const result = await enrichManager(name, { dryRun });

      const newStatus = result.enrichment_status;
      if (newStatus === 'verified' || newStatus === 'partial') {
        improved++;
        console.log(`[retry_runner] Improved: ${priorStatus} → ${newStatus}`);
      } else {
        // Schedule next retry (unless max retries exceeded)
        if (!dryRun) {
          await scheduleRetry(name, newStatus, retryCount + 1);
        }
        unchanged++;
        console.log(`[retry_runner] No improvement: ${newStatus}`);
      }
    } catch (err) {
      console.error(`[retry_runner] Error processing "${name}":`, err.message);
      failed++;
    }

    // Rate limit buffer between requests
    await delay(DELAY_MS);
  }

  console.log(`\n[retry_runner] Complete: ${improved} improved, ${unchanged} unchanged, ${failed} failed`);
}

run().catch(err => {
  console.error('[retry_runner] Fatal error:', err);
  process.exit(1);
});
