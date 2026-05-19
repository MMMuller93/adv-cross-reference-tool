#!/usr/bin/env node
/**
 * setup_railway_v3.js — One-shot Railway env-var sync for v3 enablement.
 *
 * Reads local .env. Sets these vars on Railway (project: charming-unity,
 * service: adv-cross-reference-tool, environment: production) via the
 * railway CLI. Never prints values to stdout — only key NAMES + "ok" or "skip".
 *
 * Required local env vars to read from .env:
 *   ADV_SERVICE_KEY, FORMD_SERVICE_KEY, BRAVE_SEARCH_API_KEY, OPENAI_API_KEY
 * Optional (Brave fallback chain):
 *   GOOGLE_API_KEY, GOOGLE_CX, SERPER_API_KEY
 *
 * Always sets:
 *   ENRICHMENT_V3_ENABLED=true
 *
 * Prereq: RAILWAY_API_TOKEN must be set in this shell (paste the token before
 * running). Run: RAILWAY_API_TOKEN=<token> node scripts/setup_railway_v3.js
 *
 * Safe to re-run. Idempotent.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const REQUIRED = ['ADV_SERVICE_KEY', 'FORMD_SERVICE_KEY', 'BRAVE_SEARCH_API_KEY', 'OPENAI_API_KEY'];
const OPTIONAL = ['GOOGLE_API_KEY', 'GOOGLE_CX', 'SERPER_API_KEY'];
const HARDCODED = { ENRICHMENT_V3_ENABLED: 'true' };

if (!process.env.RAILWAY_API_TOKEN) {
  console.error('FAIL: RAILWAY_API_TOKEN not set in this shell. Re-run as:');
  console.error('  RAILWAY_API_TOKEN=<your-token> node scripts/setup_railway_v3.js');
  process.exit(1);
}

// Verify all required keys are present locally before touching Railway
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`FAIL: missing required vars in local .env: ${missing.join(', ')}`);
  console.error('Aborting — fix .env first so we don\'t partially-configure Railway.');
  process.exit(1);
}

// Build the full set to push
const toSet = {};
for (const k of REQUIRED) toSet[k] = process.env[k];
for (const k of OPTIONAL) if (process.env[k]) toSet[k] = process.env[k];
for (const [k, v] of Object.entries(HARDCODED)) toSet[k] = v;

console.log('Will set on Railway (charming-unity / production / adv-cross-reference-tool):');
for (const k of Object.keys(toSet)) {
  const v = toSet[k];
  // Print only the masked tail so user can verify which version is being set
  const masked = v.length > 8 ? `••• (len=${v.length}, ends "${v.slice(-4)}")` : '••• (short)';
  console.log(`  ${k.padEnd(28)} = ${k === 'ENRICHMENT_V3_ENABLED' ? v : masked}`);
}

console.log('\nPushing to Railway...');
let okCount = 0, failCount = 0;
const failures = [];

// Use a single railway invocation with multiple --set flags for atomicity
const args = ['variables'];
for (const [k, v] of Object.entries(toSet)) {
  args.push('--set', `${k}=${v}`);
}
// Use --skip-deploys for all but the last; we want exactly one redeploy.
// Since we're doing a single batch invocation, no need for --skip-deploys.
// Let railway batch them.

try {
  const out = execFileSync('railway', args, {
    encoding: 'utf8',
    env: process.env,
    cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Don't echo out — it may contain values. Just count keys we asked for.
  okCount = Object.keys(toSet).length;
  console.log(`\nOK: ${okCount} variables set, redeploy triggered automatically.`);
} catch (err) {
  console.error('\nFAIL: railway variables command errored.');
  console.error('  exit code:', err.status);
  // Only show stderr (won't leak values; railway prints names + status only on error)
  if (err.stderr) console.error('  stderr:', err.stderr.toString().slice(0, 500));
  process.exit(2);
}

console.log('\nNext steps:');
console.log('  1. Railway redeploys automatically (~60-90s)');
console.log('  2. Verify: curl https://www.privatefundradar.com/api/health');
console.log('  3. Confirm v3 is running on new managers (check enrichment_source on recent rows)');
