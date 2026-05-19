#!/usr/bin/env node
/**
 * Thin shim around enrichment_engine_v2.enrichManager() that:
 *   - takes a manager/adviser name (single CLI arg, OR JSON {names:[...]} on stdin)
 *   - calls enrichManager(name) on each
 *   - prints the resulting enrichment object(s) as JSON on stdout
 *   - DOES NOT write to enriched_managers (we never invoke enrichAndSaveManager
 *     here). The downstream pipeline owns that table.
 *
 * Reads the PFR enrichment engine directly from its installed path so we
 * inherit Brave/Google/Serper API keys from PFR's .env. No new deps.
 */

const path = require('path');
const fs = require('fs');

// The PFR enrichment engine console.logs verbosely. That noise corrupts stdout
// (we want stdout to be ONE JSON document for the Python caller). Redirect all
// console.* to stderr before requiring the engine.
const _origLog = console.log;
const _origInfo = console.info;
const _origWarn = console.warn;
const _origErr = console.error;
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
console.info = console.log;
console.warn = console.log;
console.error = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

const PFR_ENGINE = '/Users/Miles/projects/PrivateFundsRadar/enrichment/enrichment_engine_v2.js';

if (!fs.existsSync(PFR_ENGINE)) {
  console.error(`FATAL: enrichment_engine_v2.js not found at ${PFR_ENGINE}`);
  process.exit(2);
}

const { enrichManager } = require(PFR_ENGINE);

async function main() {
  const argv = process.argv.slice(2);
  let names = [];

  if (argv[0] === '--stdin') {
    const raw = fs.readFileSync(0, 'utf8');
    const payload = JSON.parse(raw);
    names = (payload.names || []).filter((n) => typeof n === 'string' && n.trim());
  } else if (argv.length) {
    names = [argv.join(' ')];
  } else {
    console.error(
      'Usage: node enrich_manager_shim.js "Firm Name"\n       echo \'{"names":["A","B"]}\' | node enrich_manager_shim.js --stdin',
    );
    process.exit(2);
  }

  const results = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    process.stderr.write(`[${i + 1}/${names.length}] enriching ${name}\n`);
    try {
      const data = await enrichManager(name);
      results.push({ name, ok: true, data });
    } catch (e) {
      results.push({ name, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  process.stdout.write(JSON.stringify({ results }, null, 2));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
