/**
 * gate.test.js — Unit tests for the stricter SEC-CRD-match gate added 2026-05-18.
 *
 * Tests are pure-function unit tests (no DB calls) — exercise passesStricterCrdGate()
 * with synthetic adviser-match results and various manager names + corroboration inputs.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const assert = require('node:assert');

// We need to import the gate function. It's not exported from identity.js
// directly, so we exercise it via the public resolveIdentity flow OR by
// re-implementing the same logic here. Simpler: temporarily export it from
// identity.js for testing. We'll require it via the module's internals.
const identityModule = require('../../enrichment/v3/identity');
const { passesStricterCrdGate } = identityModule;

if (typeof passesStricterCrdGate !== 'function') {
  console.error('FAIL: passesStricterCrdGate is not exported from identity.js. Add it to module.exports.');
  process.exit(1);
}

function mkHit(adviser_name, crd = '999999') {
  return { found: true, source: 'database_basename', crd, adviser_name, registration_type: 'ERA' };
}

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('=== gate.test.js ===\n');
console.log('── passesStricterCrdGate ────────────────────────────────────');

t('Hash3 Capital Opportunity vs HASH3 LLC → PASS (single long distinctive "hash3")', () => {
  const r = passesStricterCrdGate(mkHit('HASH3 LLC'), 'Hash3 Capital Opportunity', {
    matchedVariant: 'Hash3',
  });
  assert.strictEqual(r.pass, true);
  assert.match(r.reason, /single_long_distinctive:hash3/);
});

t('Type One LP vs TYPE ONE MANAGEMENT LLC → PASS (2 shared tokens)', () => {
  const r = passesStricterCrdGate(mkHit('TYPE ONE MANAGEMENT LLC'), 'Type One LP', {});
  assert.strictEqual(r.pass, true);
  assert.match(r.reason, /shares_2_distinctive_tokens/);
});

t('TMS Angels Opportunity Fund vs TMS Capital Mgmt + no related → REJECT', () => {
  const r = passesStricterCrdGate(mkHit('TMS Capital Management Ltd'), 'TMS Angels Opportunity Fund, LP', {
    matchedVariant: 'TMS',
    relatedNames: '',
  });
  assert.strictEqual(r.pass, false);
  assert.match(r.reason, /acronym_tms_no_corroboration/);
});

t('TMS Angels with non-platform related person → DOWNGRADE (pass=false, downgrade=true)', () => {
  const r = passesStricterCrdGate(mkHit('TMS Capital Management Ltd'), 'TMS Angels Opportunity Fund, LP', {
    matchedVariant: 'TMS',
    relatedNames: 'Jane Doe | John Smith',
  });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.downgrade, true);
  assert.match(r.reason, /weak_corroboration_2_persons/);
});

t('TMS Angels with ONLY platform-admin related (AngelList) → REJECT (no real corroboration)', () => {
  const r = passesStricterCrdGate(mkHit('TMS Capital Management Ltd'), 'TMS Angels Opportunity Fund, LP', {
    matchedVariant: 'TMS',
    relatedNames: 'AngelList Funds LLC | Belltower Fund Group',
  });
  assert.strictEqual(r.pass, false);
  assert.match(r.reason, /no_corroboration/);
});

t('DAS Holdings SPV vs DAS-WFI INC → REJECT (zero shared distinctive)', () => {
  // "das" and "daswfi" don't share tokens after stem/normalize
  const r = passesStricterCrdGate(mkHit('DAS-WFI INC.'), 'DAS Holdings SPV Master LP', {});
  assert.strictEqual(r.pass, false);
  // Could be zero_shared or acronym depending on exact tokenization — accept either
  assert.match(r.reason, /zero_shared_distinctive_tokens|acronym_das_no_corroboration/);
});

t('Locus Ventures II vs LOCUS CAPITAL INC → PASS (single long distinctive "locus")', () => {
  const r = passesStricterCrdGate(mkHit('LOCUS CAPITAL, INC.'), 'Locus Ventures II, LP', {});
  assert.strictEqual(r.pass, true);
  assert.match(r.reason, /single_long_distinctive:locus/);
});

t('Base Case Capital Venture Funds vs BASE CASE MANAGEMENT LLC → PASS (2 shared)', () => {
  const r = passesStricterCrdGate(mkHit('BASE CASE MANAGEMENT, LLC'), 'Base Case Capital Venture Funds', {});
  assert.strictEqual(r.pass, true);
  assert.match(r.reason, /shares_2_distinctive_tokens/);
});

t('Empty adviser-match (no SEC hit) → PASS (gate is a no-op)', () => {
  const r = passesStricterCrdGate({ found: false }, 'Anything LP', {});
  assert.strictEqual(r.pass, true);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
