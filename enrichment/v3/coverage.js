/**
 * coverage.js — Print the current enrichment_status breakdown for
 * enriched_managers. Read-only. Used by run_retry_overnight.sh to show
 * before/after movement, but handy standalone too.
 *
 * Usage:  node enrichment/v3/coverage.js
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');

const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY;
if (!FORMD_KEY) {
  console.error('FATAL: FORMD_SERVICE_KEY required (load it from .env)');
  process.exit(2);
}
const db = createClient(FORMD_URL, FORMD_KEY);

async function countWhere(apply) {
  let q = db.from('enriched_managers').select('*', { count: 'exact', head: true });
  if (apply) q = apply(q);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

(async () => {
  const total = await countWhere(null);
  const statuses = [
    'auto_enriched', 'manually_verified', 'needs_manual_review',
    'candidates_only', 'no_data_found', 'platform_spv', 'not_a_fund', 'pending',
  ];
  const rows = [];
  for (const s of statuses) {
    const n = await countWhere(q => q.eq('enrichment_status', s));
    if (n > 0) rows.push([s, n]);
  }
  const hasWebsite = await countWhere(q => q.not('website_url', 'is', null));
  const dueNow = await countWhere(q => q.not('next_retry_at', 'is', null).lte('next_retry_at', new Date().toISOString()));

  const pct = n => `${((n / total) * 100).toFixed(1)}%`;
  console.log(`\n=== enriched_managers coverage (${total} rows) ===`);
  for (const [s, n] of rows) console.log(`  ${s.padEnd(20)} ${String(n).padStart(6)}  ${pct(n)}`);
  console.log(`  ${'— has website'.padEnd(20)} ${String(hasWebsite).padStart(6)}  ${pct(hasWebsite)}`);
  console.log(`  ${'— due for retry now'.padEnd(20)} ${String(dueNow).padStart(6)}`);
  console.log('');
})().catch(e => { console.error('coverage error:', e.message); process.exit(1); });
