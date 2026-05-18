/**
 * identity.test.js — Unit tests for identity resolution.
 *
 * Tests that resolveIdentity() correctly maps known fund names to their CRDs
 * and correctly handles state-registered / unknown firms.
 *
 * Run: node tests/enrichment_v3/identity.test.js
 */

'use strict';

const assert = require('assert');
const { resolveIdentity, generateVariants } = require('../../enrichment/v3/identity');

let passed = 0;
let failed = 0;

async function test(description, fn) {
  try {
    await fn();
    console.log(`  PASS  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${description}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ── generateVariants unit tests (synchronous, no network) ────────────────────

function testVariants() {
  console.log('\n── generateVariants ─────────────────────────────────────────');

  // Hash3 Capital Opportunity, LP → should include "Hash3 Capital", "Hash3"
  const hash3 = generateVariants('Hash3 Capital Opportunity, LP');
  assert(hash3.some(v => v.toLowerCase() === 'hash3 capital'), `Missing "Hash3 Capital" in ${JSON.stringify(hash3)}`);
  assert(hash3.some(v => v.toLowerCase() === 'hash3'), `Missing "Hash3" in ${JSON.stringify(hash3)}`);
  console.log('  PASS  Hash3 Capital Opportunity variants include "Hash3 Capital" and "Hash3"');
  passed++;

  // Base Case Capital Venture Funds → should include "Base Case Capital"
  const baseCase = generateVariants('Base Case Capital Venture Funds');
  assert(baseCase.some(v => /base case/i.test(v)), `Missing "Base Case" variant in ${JSON.stringify(baseCase)}`);
  console.log('  PASS  Base Case Capital Venture Funds variants include a "Base Case" variant');
  passed++;

  // Moringa Capital Master → should include "Moringa Capital", "Moringa"
  const moringa = generateVariants('Moringa Capital Master');
  assert(moringa.some(v => /moringa/i.test(v)), `Missing "Moringa" in ${JSON.stringify(moringa)}`);
  console.log('  PASS  Moringa Capital Master variants include "Moringa"');
  passed++;
}

// ── resolveIdentity integration tests (need network + DB) ───────────────────

async function runIdentityTests() {
  console.log('\n── resolveIdentity (live DB) ────────────────────────────────');

  await test('Hash3 Capital Opportunity → CRD 326205 + sec_adv_crd anchor', async () => {
    const result = await resolveIdentity('Hash3 Capital Opportunity, LP');
    assert(result.resolved === true, `Expected resolved=true, got ${JSON.stringify(result)}`);
    assert(
      result.crd === '326205',
      `Expected CRD 326205, got ${result.crd}. Full result: ${JSON.stringify(result)}`
    );
    assert(result.anchor === 'sec_adv_crd', `Expected anchor=sec_adv_crd, got ${result.anchor}`);
  });

  await test('Base Case Capital Venture Funds → CRD 323761', async () => {
    const result = await resolveIdentity('Base Case Capital Venture Funds');
    assert(result.resolved === true, `Expected resolved=true, got ${JSON.stringify(result)}`);
    assert(
      result.crd === '323761',
      `Expected CRD 323761, got ${result.crd}. Full result: ${JSON.stringify(result)}`
    );
    assert(result.anchor === 'sec_adv_crd', `Expected anchor=sec_adv_crd, got ${result.anchor}`);
  });

  await test('Moringa Capital Master → CRD 311835', async () => {
    const result = await resolveIdentity('Moringa Capital Master');
    assert(result.resolved === true, `Expected resolved=true, got ${JSON.stringify(result)}`);
    assert(
      result.crd === '311835',
      `Expected CRD 311835, got ${result.crd}. Full result: ${JSON.stringify(result)}`
    );
    assert(result.anchor === 'sec_adv_crd', `Expected anchor=sec_adv_crd, got ${result.anchor}`);
  });

  await test('Astro Funds LLC → resolved=false (state-registered, no SEC CRD)', async () => {
    const result = await resolveIdentity('Astro Funds LLC');
    // Astro Capital is state-registered in CA; SEC search returns ASTROP ADVISORY (wrong entity).
    // We expect either resolved=false OR if it resolves, it must NOT return CRD for ASTROP ADVISORY.
    if (result.resolved) {
      // If it resolved, it must not be the wrong firm (ASTROP ADVISORY = CRD 106738)
      assert(
        result.crd !== '106738',
        `Resolved to wrong firm ASTROP ADVISORY (CRD 106738). variants_tried: ${JSON.stringify(result.variants_tried)}`
      );
      console.log(`  NOTE  Astro resolved to CRD ${result.crd} (${result.adviser_name}) — verify this is not ASTROP ADVISORY`);
    } else {
      assert(result.resolved === false, 'Expected resolved=false');
      assert(Array.isArray(result.variants_tried) && result.variants_tried.length > 0,
        'Expected variants_tried to be a non-empty array');
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== identity.test.js ===');

  // Synchronous variant tests
  try {
    testVariants();
  } catch (err) {
    console.error('  FAIL  generateVariants suite:', err.message);
    failed++;
  }

  // Async identity tests
  await runIdentityTests();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
