/**
 * backup_below_bar.js — Snapshot the below-bar enriched_managers rows to a
 * guard-shaped JSON backup before an accelerated retry pass.
 *
 * v3 writes are promote-only (never null verified data) and anchor-gated, so a
 * retry can only ADD/improve — but per ETL hygiene we snapshot the affected
 * rows first anyway. Keyset-paginated by id (O(1) per page).
 *
 * Usage:  node enrichment/v3/backup_below_bar.js <outfile.json>
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY;
if (!FORMD_KEY) {
  console.error('FATAL: FORMD_SERVICE_KEY required (load it from .env)');
  process.exit(2);
}
const db = createClient(FORMD_URL, FORMD_KEY);

const BELOW_BAR = ['no_data_found', 'candidates_only', 'needs_manual_review'];
const out = process.argv[2];
if (!out) { console.error('Usage: node backup_below_bar.js <outfile.json>'); process.exit(2); }

(async () => {
  const rows = [];
  // enriched_managers.id is a uuid — keyset-paginate from the zero-uuid
  // (uuid ordering is well-defined in Postgres).
  let last = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { data, error } = await db
      .from('enriched_managers')
      .select('*')
      .in('enrichment_status', BELOW_BAR)
      .gt('id', last)
      .order('id', { ascending: true })
      .limit(1000);
    if (error) { console.error('backup error:', error.message); process.exit(1); }
    if (!data || !data.length) break;
    rows.push(...data);
    last = data[data.length - 1].id;
    process.stderr.write(`  backed up ${rows.length} rows...\r`);
  }
  fs.writeFileSync(out, JSON.stringify({
    table: 'enriched_managers',
    created_at: new Date().toISOString(),
    filter: `enrichment_status in (${BELOW_BAR.join(', ')})`,
    row_count: rows.length,
    rows,
  }));
  process.stderr.write(`\nbackup written: ${out} (${rows.length} rows)\n`);
})().catch(e => { console.error('backup error:', e.message); process.exit(1); });
