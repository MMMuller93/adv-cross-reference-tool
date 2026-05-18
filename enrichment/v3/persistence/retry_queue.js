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
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

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
      .update({ next_retry_at: nextAt })
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
 * Uses keyset pagination.
 *
 * @param {number} limit - Max managers to return
 * @returns {Promise<object[]>} Array of enriched_managers rows
 */
async function getDueForRetry(limit = 200) {
  const now = new Date().toISOString();
  const results = [];
  let lastId = 0;

  while (results.length < limit) {
    const batchSize = Math.min(100, limit - results.length);
    const { data, error } = await formdDb
      .from('enriched_managers')
      .select('id, series_master_llc, enrichment_status, field_evidence, candidates, last_retry_at, next_retry_at')
      .not('next_retry_at', 'is', null)
      .lte('next_retry_at', now)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(batchSize);

    if (error) {
      console.error('[retry_queue] getDueForRetry error:', error.message);
      break;
    }
    if (!data || data.length === 0) break;

    results.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < batchSize) break;
  }

  return results;
}

/**
 * Count how many retries have been run for a manager.
 * Derived from last_retry_at vs enrichment_date (approximation).
 * A proper implementation would track retry_count in a column.
 */
function estimateRetryCount(row) {
  // If we had a retry_count column, we'd use it. For now, estimate from dates.
  // This is a best-effort approximation until the column is added in a future migration.
  if (!row.last_retry_at || !row.next_retry_at) return 0;
  const lastMs = new Date(row.last_retry_at).getTime();
  const nextMs = new Date(row.next_retry_at).getTime();
  const diffDays = (nextMs - lastMs) / (1000 * 60 * 60 * 24);
  const idx = RETRY_SCHEDULE_DAYS.findIndex(d => Math.abs(d - diffDays) < 2);
  return idx >= 0 ? idx : 0;
}

module.exports = { scheduleRetry, getDueForRetry, nextRetryDate, estimateRetryCount };
