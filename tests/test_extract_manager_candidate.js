/**
 * Fixture tests for extractManagerCandidate (A3+A4 in
 * detect_compliance_issues.js). Pure function — no DB calls.
 *
 * Run: node tests/test_extract_manager_candidate.js
 */

const assert = require('node:assert');
const { extractManagerCandidate, classifyExemptions } = require('../detect_compliance_issues');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

console.log('\nextractManagerCandidate — platform routing:');

// Sydecar — series-master is "CGF2021 LLC" (the platform admin). Real GP comes
// before "a series of" — here the prefix is the fund-code-prefixed fund name.
t('Sydecar: entityname routes to non-master path', () => {
  const c = extractManagerCandidate({
    entityname: 'GE-0616 Gaingels Fund II, a series of CGF2021 LLC',
    related_names: 'Brett Sagan',
    related_roles: 'Manager',
  });
  assert.strictEqual(c.is_platform, true);
  assert.strictEqual(c.platform_name, 'Sydecar');
  // Should NOT pick the CGF2021 platform master as the manager
  assert.ok(!c.primary.toUpperCase().includes('CGF2021'), `primary should not contain CGF2021, got: ${c.primary}`);
});

// AngelList — series-master would be "Angellist-GP-Funds-I, LP".
t('AngelList "angellist-gp-funds" series → not used as manager', () => {
  const c = extractManagerCandidate({
    entityname: 'GE-0616 Gaingels Fund II, a series of Angellist-GP-Funds-I, LP',
    related_names: 'Belltower Fund Services|Cathy Bui',
    related_roles: 'Manager|Officer',
  });
  assert.strictEqual(c.is_platform, true);
  assert.strictEqual(c.platform_name, 'AngelList');
  assert.ok(!c.primary.toLowerCase().includes('angellist'), `primary should not be the AngelList master, got: ${c.primary}`);
});

// AngelList — Roll Up Vehicles pattern
t('AngelList "Roll Up Vehicles" detected', () => {
  const c = extractManagerCandidate({
    entityname: 'FO-0611 Fund I, a series of Roll Up Vehicles, LP',
    related_names: '',
    related_roles: '',
  });
  assert.strictEqual(c.is_platform, true);
});

// Decile platform
t('Decile "Decile Start" routes properly', () => {
  const c = extractManagerCandidate({
    entityname: 'Roadster Capital, a series of Decile Start Fund, LP',
    related_names: 'Long Pham',
    related_roles: 'Manager',
  });
  assert.strictEqual(c.is_platform, true);
  assert.strictEqual(c.platform_name, 'Decile');
  // The prefix "Roadster Capital" is the real fund name and should be picked
  assert.ok(c.primary.toLowerCase().includes('roadster'), `expected "Roadster" in primary, got: ${c.primary}`);
});

console.log('\nextractManagerCandidate — non-platform paths:');

// Standard "a series of" — real master
t('Non-platform series: master extracted', () => {
  const c = extractManagerCandidate({
    entityname: 'Fund VI, a series of Acme Capital Partners LLC',
    related_names: '',
    related_roles: '',
  });
  assert.strictEqual(c.is_platform, false);
  assert.strictEqual(c.source, 'series_master');
  assert.ok(c.primary.includes('Acme Capital Partners'), `expected master "Acme Capital Partners LLC", got: ${c.primary}`);
});

// Non-series filing (traditional LP) — prefix-extracted firm name
t('Non-series, non-platform: entityname prefix used', () => {
  const c = extractManagerCandidate({
    entityname: 'March Capital Partners Fund V, L.P.',
    related_names: 'Jamie Montgomery',
    related_roles: 'Director',
  });
  assert.strictEqual(c.is_platform, false);
  assert.strictEqual(c.source, 'entity_prefix');
  // Suffix " Fund V, L.P." should be stripped (or at least the legal suffix)
  assert.ok(c.primary.startsWith('March Capital Partners'), `expected prefix "March Capital Partners", got: ${c.primary}`);
});

console.log('\nclassifyExemptions:');

t('Foreign jurisdiction → likely_foreign_private_adviser', () => {
  const tags = classifyExemptions({ stateorcountry: 'CAYMAN ISLANDS', related_names: 'Smith, John' });
  assert.ok(tags.some(t => t.tag === 'likely_foreign_private_adviser'), 'expected foreign tag');
});

t('US state (DE) → NO foreign tag', () => {
  const tags = classifyExemptions({ stateorcountry: 'DE', related_names: 'Smith, John' });
  assert.ok(!tags.some(t => t.tag === 'likely_foreign_private_adviser'), 'should not tag foreign for DE');
});

t('Shared surname among small related-persons list → likely_family_office', () => {
  const tags = classifyExemptions({ stateorcountry: 'CA', related_names: 'John Smith|Jane Smith|Bob Smith' });
  assert.ok(tags.some(t => t.tag === 'likely_family_office'), 'expected family-office tag for surname clustering');
});

t('Large related-persons list → NO family-office tag', () => {
  const tags = classifyExemptions({ stateorcountry: 'CA', related_names: 'A B|C D|E F|G H|I J|K L|M N|O P|Q R|S T' });
  assert.ok(!tags.some(t => t.tag === 'likely_family_office'), 'should not tag family-office on 10-person list');
});

t('Entity related_names ending in LLC → NO family-office FP (prod bug 2026-05-11)', () => {
  // Form D's "related_names" list often includes ENTITY owners ending in LLC/LP.
  // The old code took "LLC" as the surname and falsely clustered them.
  const tags = classifyExemptions({ stateorcountry: 'NY', related_names: 'Acme Holdings LLC|Beta Capital LLC|Gamma Group LLC' });
  assert.ok(!tags.some(t => t.tag === 'likely_family_office'), `entity suffixes must not count as shared surname; got: ${JSON.stringify(tags)}`);
});

t('Mixed entities and one person with shared surname → still no family-office on entities', () => {
  const tags = classifyExemptions({ stateorcountry: 'NY', related_names: 'Acme Holdings LLC|John Doe' });
  assert.ok(!tags.some(t => t.tag === 'likely_family_office'), 'one person + one entity should not match');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
