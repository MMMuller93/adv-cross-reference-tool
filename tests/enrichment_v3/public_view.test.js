/**
 * public_view.test.js — Unit tests for buildPublicView().
 *
 * Covers both v3 rows (field_evidence JSONB present) and v2 legacy rows
 * (flat columns, no field_evidence).
 *
 * Run: node tests/enrichment_v3/public_view.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const { buildPublicView } = require('../../enrichment/v3/publish/public_view');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// V3 tests (field_evidence present)
// ---------------------------------------------------------------------------

console.log('\nv3 rows (field_evidence present)');

test('1. verified website_url is emitted', () => {
  const record = {
    enrichment_status: 'auto_enriched',
    field_evidence: {
      website_url: { status: 'verified', value: 'https://example.com' },
    },
  };
  const view = buildPublicView(record);
  assert.equal(view.suppressed, false);
  assert.equal(view.website, 'https://example.com');
});

test('2. candidate website_url is NOT emitted', () => {
  const record = {
    enrichment_status: 'candidates_only',
    field_evidence: {
      website_url: { status: 'candidate', value: 'https://example.com' },
    },
  };
  const view = buildPublicView(record);
  // Suppressed rows have no website key (absent = not published)
  assert.ok(!view.website, 'website should be absent or falsy when suppressed');
});

test('3. all fields candidate/rejected → suppressed:true', () => {
  const record = {
    enrichment_status: 'candidates_only',
    field_evidence: {
      website_url: { status: 'candidate', value: 'https://example.com' },
      linkedin_company_url: { status: 'rejected', value: null },
    },
  };
  const view = buildPublicView(record);
  assert.equal(view.suppressed, true);
  assert.ok(view.suppressed_reason, 'suppressed_reason should be set');
});

// ---------------------------------------------------------------------------
// V2 tests (no field_evidence — legacy flat columns)
// ---------------------------------------------------------------------------

console.log('\nv2 rows (legacy flat columns)');

test('4. valid https website_url emitted (v2 fallback)', () => {
  const record = {
    enrichment_status: 'auto_enriched',
    website_url: 'https://example.com',
  };
  const view = buildPublicView(record);
  assert.equal(view.suppressed, false);
  assert.equal(view.website, 'https://example.com');
});

test('5. garbage website_url (not http) NOT emitted (v2 fallback)', () => {
  const record = {
    enrichment_status: 'auto_enriched',
    website_url: 'garbage not a url',
  };
  const view = buildPublicView(record);
  // Invalid URL → suppressed:true, no website field in output
  assert.ok(!view.website, 'website should be absent or falsy for invalid URL');
});

test('6. valid linkedin_company_url emitted (v2 fallback)', () => {
  const record = {
    enrichment_status: 'auto_enriched',
    linkedin_company_url: 'https://www.linkedin.com/company/foo',
  };
  const view = buildPublicView(record);
  assert.equal(view.suppressed, false);
  assert.equal(view.linkedin, 'https://www.linkedin.com/company/foo');
});

test('7. no populated fields → suppressed:true, suppressed_reason:no_publishable_fields (v2)', () => {
  const record = {
    enrichment_status: 'no_data_found',
    website_url: null,
    linkedin_company_url: null,
    primary_contact_email: null,
    twitter_handle: null,
    team_members: [],
  };
  const view = buildPublicView(record);
  assert.equal(view.suppressed, true);
  assert.equal(view.suppressed_reason, 'no_publishable_fields');
});

test('8. linkedin_search-sourced team members defensively dropped (v2)', () => {
  const record = {
    enrichment_status: 'auto_enriched',
    linkedin_company_url: 'https://www.linkedin.com/company/foo',
    team_members: [
      { name: 'Alice', source: 'linkedin_search' },
      { name: 'Bob',   source: 'website' },
    ],
  };
  const view = buildPublicView(record);
  assert.equal(view.team_members.length, 1);
  assert.equal(view.team_members[0].name, 'Bob');
});

test('9. website-sourced team members published (v2)', () => {
  const record = {
    enrichment_status: 'auto_enriched',
    website_url: 'https://example.com',
    team_members: [{ name: 'Alice', title: 'GP', source: 'website' }],
  };
  const view = buildPublicView(record);
  assert.equal(view.suppressed, false);
  assert.equal(view.team_members.length, 1);
  assert.equal(view.team_members[0].name, 'Alice');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
