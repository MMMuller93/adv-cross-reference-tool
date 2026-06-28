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
  const num = (flag, dflt) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? (parseInt(args[idx + 1]) || dflt) : dflt;
  };
  const limit = num('--limit', DEFAULT_LIMIT);
  // Opt-in parallelism. concurrency=1 (default) reproduces the original
  // sequential behavior exactly — the nightly cron is unaffected. Work is
  // I/O-bound (web search / website fetch / OpenAI), so concurrency scales
  // throughput until an upstream API rate-limits. --delay throttles per worker
  // (default 2s, the legacy buffer); pass --delay 0 for max throughput.
  const concurrency = Math.max(1, num('--concurrency', 1));
  const delayMs = num('--delay', DELAY_MS);
  const dryRun = args.includes('--dry-run');
  return { limit, dryRun, concurrency, delayMs };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const { limit, dryRun, concurrency, delayMs } = parseArgs();

  console.log(`[retry_runner] Starting — limit=${limit}, concurrency=${concurrency}, delay=${delayMs}ms, dryRun=${dryRun}`);

  const dueManagers = await getDueForRetry(limit);
  console.log(`[retry_runner] Found ${dueManagers.length} managers due for retry`);

  if (dueManagers.length === 0) {
    console.log('[retry_runner] Nothing to do. Exiting.');
    return;
  }

  let improved = 0;
  let unchanged = 0;
  let failed = 0;
  let rateLimited = 0;
  let done = 0;
  const startedAt = Date.now();

  async function processOne(row) {
    const name = row.series_master_llc;
    const priorStatus = row.enrichment_status;
    const retryCount = estimateRetryCount(row);

    console.log(`[retry_runner] Retrying: "${name}" (prior=${priorStatus}, attempt=${retryCount + 1})`);

    try {
      const result = await enrichManager(name, { dryRun });

      const newStatus = result.enrichment_status;
      if (newStatus === 'verified' || newStatus === 'partial') {
        improved++;
        console.log(`[retry_runner] Improved: ${priorStatus} → ${newStatus} ("${name}")`);
      } else {
        // Schedule next retry (unless max retries exceeded)
        if (!dryRun) {
          await scheduleRetry(name, newStatus, retryCount + 1);
        }
        unchanged++;
        console.log(`[retry_runner] No improvement: ${newStatus} ("${name}")`);
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (/\b429\b|rate.?limit|too many requests|quota/i.test(msg)) rateLimited++;
      console.error(`[retry_runner] Error processing "${name}":`, msg);
      failed++;
    }
  }

  // Worker pool. `concurrency` workers pull from a shared cursor; each waits
  // `delayMs` between its own tasks. concurrency=1 + delayMs=2000 is identical
  // to the original sequential loop (nightly cron behavior is unchanged).
  let cursor = 0;
  async function worker() {
    while (cursor < dueManagers.length) {
      const row = dueManagers[cursor++];
      await processOne(row);
      done++;
      if (done % 20 === 0) {
        const mins = (Date.now() - startedAt) / 60000;
        const rate = mins > 0 ? (done / mins).toFixed(1) : '—';
        console.log(`[retry_runner] progress: ${done}/${dueManagers.length} | ${improved} improved, ${unchanged} unchanged, ${failed} failed (${rateLimited} rate-limited) | ${mins.toFixed(1)}m @ ${rate}/min`);
      }
      if (delayMs > 0) await delay(delayMs);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const totalMins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\n[retry_runner] Complete: ${improved} improved, ${unchanged} unchanged, ${failed} failed (${rateLimited} rate-limited) in ${totalMins}m`);
}

run().catch(err => {
  console.error('[retry_runner] Fatal error:', err);
  process.exit(1);
});
