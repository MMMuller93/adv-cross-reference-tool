/**
 * LIVE regression test — exercises lib/adv_lookup.js against the production
 * ADV database for the 7 historical false-positives documented in
 * docs/ADV_VALIDATION_MAPPING.md. Each should resolve via checkAdvDatabase
 * (i.e., be recognized as already-registered).
 *
 * Run: node tests/test_live_regression.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { checkAdvDatabase, extractBaseName } = require('../lib/adv_lookup');

const ADV_URL = process.env.ADV_URL || 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = process.env.ADV_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';
const advDb = createClient(ADV_URL, ADV_KEY);

// Historical false positives. Each should resolve to SOME registered adviser
// whose name contains the expected token (we don't pin a specific CRD because
// ilike returns the first arbitrary match — what matters for the new-manager
// detector is "is this firm registered at all", not which specific CRD).
//
// Akahi Capital Management (CRD 132114) is excluded: the Jan 7 validation doc
// said "Found in IAPD" — not "Found in database." It's genuinely not in
// advisers_enriched today (verified 2026-05-11). The detector correctly
// surfaces it as a candidate.
const CASES = [
  { input: 'KIG GP, LLC',                           expected_name_substr: 'KIG' },
  { input: 'HighVista GP LLC',                      expected_name_substr: 'HIGHVISTA' },
  { input: 'Canyon Capital Advisors LLC',           expected_name_substr: 'CANYON' },
  { input: 'Millstreet Capital Management LLC',     expected_name_substr: 'MILLSTREET' },
  { input: 'Hohimer Wealth Management',             expected_name_substr: 'HOHIMER' },
  { input: 'Lighthouse Asset Management',           expected_name_substr: 'LIGHTHOUSE' },
  { input: 'Patricof Co. Master, LLC',              expected_name_substr: 'PATRICOF' },
];

async function run() {
  let pass = 0, fail = 0;
  const failures = [];
  console.log('\nLive regression — historical FPs must be found in advisers_enriched:\n');
  for (const c of CASES) {
    const base = extractBaseName(c.input);
    try {
      const r = await checkAdvDatabase(advDb, c.input);
      if (!r.found) {
        console.log(`  ✗ ${c.input}`);
        console.log(`      base=${JSON.stringify(base)} expected match containing "${c.expected_name_substr}", got NOT FOUND`);
        fail++; failures.push(c);
        continue;
      }
      const nameUp = (r.adviser_name || '').toUpperCase();
      const nameOk = nameUp.includes(c.expected_name_substr.toUpperCase());
      if (!nameOk) {
        console.log(`  ✗ ${c.input}`);
        console.log(`      base=${JSON.stringify(base)} got CRD ${r.crd} → "${r.adviser_name}" (expected substring "${c.expected_name_substr}")`);
        fail++; failures.push(c);
        continue;
      }
      console.log(`  ✓ ${c.input.padEnd(36)} → ${r.adviser_name} (CRD ${r.crd}, via ${r.source})`);
      pass++;
    } catch (e) {
      console.log(`  ✗ ${c.input} — ERROR: ${e.message}`);
      fail++; failures.push(c);
    }
  }
  console.log(`\n${pass}/${CASES.length} pass${pass === CASES.length ? '' : ` (${fail} fail)`}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(c => console.log(`  - ${c.input} (expected CRD ${c.expected_crd})`));
    process.exit(1);
  }
}

run().catch(e => { console.error(e); process.exit(2); });
