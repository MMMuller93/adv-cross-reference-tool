/**
 * retry_queue.js — Track and schedule auto-retries for below-bar managers.
 *
 * Schedule:
 *   - First retry: 7 days after initial enrichment
 *   - Subsequent: exponential backoff (7d → 14d → 30d → 60d → 90d)
 *   - After 5 retries with no improvement: give up (next_retry_at = null)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { createClient } = require('@supabase/supabase-js');

const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY;
if (!FORMD_KEY) throw new Error('Missing required env var: FORMD_SERVICE_KEY');

const formdDb = createClient(FORMD_URL, FORMD_KEY);

// Retry interval schedule in days
const RETRY_SCHEDULE_DAYS = [7, 14, 30, 60, 90];
const MAX_RETRIES = 5;

/**
 * Calculate next retry date based on attempt number (0-indexed).
 * Returns null if max retries exceeded.
 */
function nextRetryDate(attemptNumber) {
  if (attemptNumber >= MAX_RETRIES) return null;
  const days = RETRY_SCHEDULE_DAYS[Math.min(attemptNumber, RETRY_SCHEDULE_DAYS.length - 1)];
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

/**
 * Schedule a retry for a manager that produced below-bar results.
 * Called after enrichment completes with status candidates_only or partial.
 *
 * @param {string} seriesMasterLlc
 * @param {string} currentStatus - enrichment_status value
 * @param {number} retryCount - How many retries have already run (default 0)
 */
async function scheduleRetry(seriesMasterLlc, currentStatus, retryCount = 0) {
  const retryableStatuses = ['candidates_only', 'partial', 'no_data'];
  if (!retryableStatuses.includes(currentStatus)) return;

  const nextAt = nextRetryDate(retryCount);

  try {
    const { error } = await formdDb
      .from('enriched_managers')
      .update({
        next_retry_at: nextAt,
        retry_count: retryCount + 1,
      })
      .eq('series_master_llc', seriesMasterLlc);

    if (error) {
      console.error('[retry_queue] scheduleRetry error:', error.message);
    } else {
      console.log(`[retry_queue] Scheduled retry #${retryCount + 1} for "${seriesMasterLlc}" at ${nextAt || 'never (max retries)'}`);
    }
  } catch (err) {
    console.error('[retry_queue] scheduleRetry error:', err.message);
  }
}

/**
 * Fetch managers due for retry (next_retry_at <= now).
 *
 * Uses next_retry_at timestamp-keyset pagination because enriched_managers.id
 * is a UUID — integer keyset (.gt('id', 0)) does not work on UUID columns.
 *
 * @param {number} limit - Max managers to return
 * @returns {Promise<object[]>} Array of enriched_managers rows
 */
async function getDueForRetry(limit = 200) {
  const now = new Date().toISOString();
  const results = [];
  let lastTimestamp = null;

  while (results.length < limit) {
    const batchSize = Math.min(100, limit - results.length);
    let q = formdDb
      .from('enriched_managers')
      .select('id, series_master_llc, enrichment_status, field_evidence, candidates, last_retry_at, next_retry_at, retry_count')
      .not('next_retry_at', 'is', null)
      .lte('next_retry_at', now)
      .order('next_retry_at', { ascending: true })
      .limit(batchSize);

    if (lastTimestamp) {
      q = q.gt('next_retry_at', lastTimestamp);
    }

    const { data, error } = await q;

    if (error) {
      console.error('[retry_queue] getDueForRetry error:', error.message);
      break;
    }
    if (!data || data.length === 0) break;

    results.push(...data);
    lastTimestamp = data[data.length - 1].next_retry_at;
    if (data.length < batchSize) break;
  }

  return results;
}

/**
 * Return the retry count for a manager row.
 * Uses the retry_count column if present (added in migration); falls back
 * to 0 so existing rows without the column still work.
 */
function estimateRetryCount(row) {
  if (typeof row.retry_count === 'number') return row.retry_count;
  // Legacy fallback for rows without the retry_count column
  return 0;
}

module.exports = { scheduleRetry, getDueForRetry, nextRetryDate, estimateRetryCount };
