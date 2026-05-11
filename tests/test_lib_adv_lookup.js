/**
 * Unit tests for lib/adv_lookup.js + lib/platform_detection.js helpers.
 * Pure-function tests — no DB calls, no network.
 *
 * Run with: node tests/test_lib_adv_lookup.js
 */

const assert = require('node:assert');
const {
  extractBaseName,
  nameTokens,
  namesMatch,
  parseRelatedPersons,
  MANAGEMENT_OWNER_TITLES,
} = require('../lib/adv_lookup');
const { detectPlatform, PLATFORM_PATTERNS } = require('../lib/platform_detection');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

console.log('\nextractBaseName — strips legal suffix + management noun + "Master":');
t('KIG GP, LLC → KIG', () => assert.strictEqual(extractBaseName('KIG GP, LLC'), 'KIG'));
t('Akahi Capital Management, LLC → Akahi Capital', () => assert.strictEqual(extractBaseName('Akahi Capital Management, LLC'), 'Akahi Capital'));
t('HighVista GP LLC → HighVista', () => assert.strictEqual(extractBaseName('HighVista GP LLC'), 'HighVista'));
t('Canyon Capital Advisors LLC → Canyon Capital', () => assert.strictEqual(extractBaseName('Canyon Capital Advisors LLC'), 'Canyon Capital'));
t('Millstreet Capital Management LLC → Millstreet Capital', () => assert.strictEqual(extractBaseName('Millstreet Capital Management LLC'), 'Millstreet Capital'));
t('Patricof Co. Master, LLC → Patricof Co.  (A7 fix)', () => assert.strictEqual(extractBaseName('Patricof Co. Master, LLC'), 'Patricof Co.'));
t('Hohimer Wealth Management → Hohimer Wealth', () => assert.strictEqual(extractBaseName('Hohimer Wealth Management'), 'Hohimer Wealth'));
t('Lighthouse Asset Management → Lighthouse Asset', () => assert.strictEqual(extractBaseName('Lighthouse Asset Management'), 'Lighthouse Asset'));
t('empty string → empty', () => assert.strictEqual(extractBaseName(''), ''));
t('null → empty', () => assert.strictEqual(extractBaseName(null), ''));

console.log('\nnameTokens — first/last extraction (per signatory FP defense):');
t('DAVID S. BLOCK → first=DAVID last=BLOCK', () => {
  const t1 = nameTokens('DAVID S. BLOCK');
  assert.strictEqual(t1.first, 'DAVID');
  assert.strictEqual(t1.last, 'BLOCK');
});
t('"BLOCK, DAVID S." (last-first comma form) → first=DAVID last=BLOCK', () => {
  const t1 = nameTokens('BLOCK, DAVID S.');
  assert.strictEqual(t1.first, 'DAVID');
  assert.strictEqual(t1.last, 'BLOCK');
});
t('"ABBOTT, TRACY, KATE" (last-first-middle) → first=TRACY last=ABBOTT', () => {
  const t1 = nameTokens('ABBOTT, TRACY, KATE');
  assert.strictEqual(t1.first, 'TRACY');
  assert.strictEqual(t1.last, 'ABBOTT');
});
t('initials filtered out', () => {
  const t1 = nameTokens('J. R. R. TOLKIEN');
  assert.strictEqual(t1.last, 'TOLKIEN');
});

console.log('\nnamesMatch — requires first+last token agreement (no single-name FP):');
t('"DAVID BLOCK" matches "DAVID S. BLOCK"', () => assert.strictEqual(namesMatch('DAVID BLOCK', 'DAVID S. BLOCK'), true));
t('"DAVID BLOCK" matches "BLOCK, DAVID"', () => assert.strictEqual(namesMatch('DAVID BLOCK', 'BLOCK, DAVID'), true));
t('"DAVID BLOCK" does NOT match "DAVID SMITH"', () => assert.strictEqual(namesMatch('DAVID BLOCK', 'DAVID SMITH'), false));
t('"DAVID BLOCK" does NOT match "JOHN BLOCK"', () => assert.strictEqual(namesMatch('DAVID BLOCK', 'JOHN BLOCK'), false));
t('"BARRY BREEN" does NOT match "BARRY JONES" (signatory FP test)', () => assert.strictEqual(namesMatch('BARRY BREEN', 'BARRY JONES'), false));

console.log('\nparseRelatedPersons — filters to management roles:');
t('Director / Promoter / Officer kept', () => {
  const r = parseRelatedPersons('Alice Smith|Bob Jones|Carol White', 'Director|Promoter|Executive Officer');
  assert.strictEqual(r.length, 3);
});
t('Limited Partner / Member filtered out', () => {
  const r = parseRelatedPersons('Alice Smith|Bob Jones|Carol White', 'Limited Partner|Member|Director');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, 'Carol White');
});
t('Missing roles → kept (assume management)', () => {
  const r = parseRelatedPersons('Alice Smith|Bob Jones', '');
  assert.strictEqual(r.length, 2);
});
t('Comma-delimited roles in one slot ("Executive Officer,Director") → kept', () => {
  const r = parseRelatedPersons('Alice Smith', 'Executive Officer,Director');
  assert.strictEqual(r.length, 1);
});

console.log('\ndetectPlatform — Sydecar, AngelList, etc.:');
t('Sydecar entityname pattern → detected', () => {
  const p = detectPlatform({ entityname: 'GE-0616 Gaingels Fund II, a series of CGF2021 LLC', related_names: '' });
  assert.strictEqual(p.is_platform, true);
  assert.strictEqual(p.platform_name, 'Sydecar');
});
t('AngelList "a series of angellist-gp-funds" → detected', () => {
  const p = detectPlatform({ entityname: 'GE-0616 Gaingels Fund II, a series of Angellist-GP-Funds-I, LP', related_names: '' });
  assert.strictEqual(p.is_platform, true);
  assert.strictEqual(p.platform_name, 'AngelList');
});
t('AngelList "Roll Up Vehicles" → detected', () => {
  const p = detectPlatform({ entityname: 'FO-0611 Fund I, a series of Roll Up Vehicles, LP', related_names: '' });
  assert.strictEqual(p.is_platform, true);
});
t('Decile "decile start" → detected', () => {
  const p = detectPlatform({ entityname: 'Roadster Capital, a series of Decile Start Fund, LP', related_names: '' });
  assert.strictEqual(p.is_platform, true);
  assert.strictEqual(p.platform_name, 'Decile');
});
t('Regular fund "Acme Capital Partners Fund V, L.P." → NOT detected', () => {
  const p = detectPlatform({ entityname: 'Acme Capital Partners Fund V, L.P.', related_names: 'Alice Smith' });
  assert.strictEqual(p.is_platform, false);
});
t('Sydecar via signer name (Brett Sagan) → detected', () => {
  const p = detectPlatform({ entityname: 'Random Fund LLC', related_names: '', nameofsigner: 'Brett Sagan' });
  assert.strictEqual(p.is_platform, true);
  assert.strictEqual(p.platform_name, 'Sydecar');
});

console.log('\nMeaningful-base-name guard (prevents substring-collision FPs):');
// These tests document Strategy 1's gating behavior. Strategy 1 should run on
// names that have a distinctive token, and should NOT run on names that reduce
// to generic vocabulary alone.
const advLookup = require('../lib/adv_lookup');
function shouldRunStrategy1(name) {
  const base = advLookup.extractBaseName(name);
  const ROMAN_RE = /^[ivx]+$/i;
  const meaningful = base.split(/\s+/).filter(tok =>
    tok.length >= 3 && !advLookup.NAME_STOPWORDS.has(tok.toLowerCase()) && !ROMAN_RE.test(tok)
  );
  return Boolean(base && base.length >= 3 && meaningful.length >= 1);
}
t('"Fund I, LP" → strategy 1 skipped (would FP-match Fund II)', () => assert.strictEqual(shouldRunStrategy1('Fund I, LP'), false));
t('"Capital LP" → strategy 1 skipped', () => assert.strictEqual(shouldRunStrategy1('Capital LP'), false));
t('"The Fund" → strategy 1 skipped', () => assert.strictEqual(shouldRunStrategy1('The Fund'), false));
t('"Patricof Co. Master, LLC" → strategy 1 runs', () => assert.strictEqual(shouldRunStrategy1('Patricof Co. Master, LLC'), true));
t('"KIG GP, LLC" → strategy 1 runs', () => assert.strictEqual(shouldRunStrategy1('KIG GP, LLC'), true));
t('"Sequoia Capital" → strategy 1 runs (distinctive Sequoia)', () => assert.strictEqual(shouldRunStrategy1('Sequoia Capital'), true));

console.log('\nManagement title allowlist sanity:');
t('MANAGING MEMBER present', () => assert.ok(MANAGEMENT_OWNER_TITLES.includes('MANAGING MEMBER')));
t('CHIEF COMPLIANCE OFFICER NOT present (service title)', () => assert.ok(!MANAGEMENT_OWNER_TITLES.includes('CHIEF COMPLIANCE OFFICER')));
t('AUTHORIZED SIGNATORY NOT present (service title)', () => assert.ok(!MANAGEMENT_OWNER_TITLES.includes('AUTHORIZED SIGNATORY')));
t('GENERAL COUNSEL NOT present (service title)', () => assert.ok(!MANAGEMENT_OWNER_TITLES.includes('GENERAL COUNSEL')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
