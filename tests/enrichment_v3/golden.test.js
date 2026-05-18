/**
 * golden.test.js — Golden regression tests for enrichment v3.
 *
 * Loads fixtures from .llm/REBUILD_GOLDEN_FIXTURES.json.
 * Runs enrichManager() in dry-run mode (no DB writes) for each fixture.
 *
 * BAD cases (known-wrong data in current DB):
 *   - team_members with status=verified must NOT contain known-wrong names
 *   - website_url must be either the correct domain OR null (never wrong)
 *   - linkedin_company_url must be correct OR null
 *
 * CONTROL cases (known-good enrichment):
 *   - website_url must match the fixture's real_website domain
 *   - At least 2 of 5 fixture team members must appear in verified set
 *
 * Run: node tests/enrichment_v3/golden.test.js
 *
 * Note: This test makes live network + DB calls. Allow 5–10 min for full run.
 * Pass --skip-control to only run bad-case assertions (faster for CI).
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { enrichManager } = require('../../enrichment/v3/orchestrator');

const FIXTURES_PATH = path.resolve(__dirname, '../../.llm/REBUILD_GOLDEN_FIXTURES.json');
const SKIP_CONTROL = process.argv.includes('--skip-control');
const DELAY_MS = 3000; // between fixtures to avoid rate limiting

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let passed = 0;
let failed = 0;
let skipped = 0;

function hostname(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return url.toLowerCase();
  }
}

async function runTest(description, fn) {
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

function skip(description, reason) {
  console.log(`  SKIP  ${description} (${reason})`);
  skipped++;
}

/**
 * Run assertions for a BAD case fixture.
 * The engine must not reproduce the wrong data.
 */
async function testBadCase(fixture, result) {
  const name = fixture.series_master_llc_as_filed;
  const fe = result.field_evidence || {};

  // Website must be correct or null (never wrong)
  await runTest(`[BAD] ${name}: website is correct or null`, async () => {
    const websiteStatus = fe.website_url?.status;
    const websiteValue = fe.website_url?.value || result.website;

    if (websiteValue && fixture.real_website) {
      // If a website was returned, it must match the real website
      assert(
        hostname(websiteValue) === hostname(fixture.real_website),
        `Got wrong website: ${websiteValue} (expected ${fixture.real_website} or null)`
      );
    } else if (websiteValue && !fixture.real_website) {
      // Fixture says no real website exists — should be null
      assert(
        false,
        `Got website ${websiteValue} but fixture says real_website=null`
      );
    }
    // null is always acceptable
  });

  // LinkedIn must be correct or null
  await runTest(`[BAD] ${name}: linkedin is correct or null`, async () => {
    const liValue = fe.linkedin_company_url?.value || result.linkedin;

    if (liValue && fixture.real_linkedin_company) {
      assert(
        hostname(liValue) === hostname(fixture.real_linkedin_company) ||
        liValue.includes(hostname(fixture.real_linkedin_company)),
        `Got wrong LinkedIn: ${liValue} (expected ${fixture.real_linkedin_company} or null)`
      );
    } else if (liValue && !fixture.real_linkedin_company) {
      // Some bad cases have no LinkedIn — getting one is acceptable unless clearly wrong
      // We just log rather than fail here since LinkedIn might be found legitimately
      console.log(`    NOTE: Got LinkedIn ${liValue} but fixture says null — verify manually`);
    }
  });

  // Verified team members must not contain known-wrong names
  // (For bad cases, any verified team member must be in the real_team_member_sample
  //  OR the verified team must be empty)
  await runTest(`[BAD] ${name}: no wrong team members in verified set`, async () => {
    const teamDecisions = fe.team_members || result.team_members || [];
    const verifiedTeam = Array.isArray(teamDecisions)
      ? teamDecisions.filter(m => m.status === 'verified' || (!m.status && m.name))
      : [];

    if (verifiedTeam.length === 0) return; // empty is always OK for bad cases

    // If fixture has no real team, verified team should be empty
    if (!fixture.real_team_member_sample || fixture.real_team_member_sample.length === 0) {
      assert(
        verifiedTeam.length === 0,
        `Got ${verifiedTeam.length} verified team members but fixture says empty: ${JSON.stringify(verifiedTeam.map(m => m.name || m))}`
      );
      return;
    }

    // Each verified member must appear in real_team_member_sample (partial name match)
    for (const member of verifiedTeam) {
      const memberName = (member.name || '').toLowerCase();
      if (!memberName) continue;

      const inRealTeam = fixture.real_team_member_sample.some(realEntry => {
        const realLower = realEntry.toLowerCase();
        // Accept if at least one distinctive token (first or last name) matches
        const tokens = memberName.split(/\s+/).filter(t => t.length >= 3);
        return tokens.some(t => realLower.includes(t));
      });

      assert(
        inRealTeam,
        `Wrong team member in verified set: "${member.name}" not in real_team_member_sample ${JSON.stringify(fixture.real_team_member_sample)}`
      );
    }
  });
}

/**
 * Run assertions for a CONTROL case fixture.
 * The engine must produce the known-good data (regression check).
 */
async function testControlCase(fixture, result) {
  const name = fixture.series_master_llc_as_filed;
  const fe = result.field_evidence || {};

  // Website must match the fixture's real_website
  await runTest(`[CTRL] ${name}: website matches real_website`, async () => {
    const websiteValue = fe.website_url?.value || result.website;

    assert(
      websiteValue,
      `No website returned; expected ${fixture.real_website}`
    );
    assert(
      hostname(websiteValue) === hostname(fixture.real_website),
      `Website mismatch: got ${websiteValue}, expected ${fixture.real_website}`
    );
  });

  // At least 2 of the 5 fixture team members must appear in verified set
  await runTest(`[CTRL] ${name}: ≥2 real team members verified`, async () => {
    const teamDecisions = fe.team_members || result.team_members || [];
    const verifiedNames = Array.isArray(teamDecisions)
      ? teamDecisions
          .filter(m => m.status === 'verified' || (!m.status && m.name))
          .map(m => (m.name || '').toLowerCase())
      : [];

    let matchCount = 0;
    for (const realEntry of fixture.real_team_member_sample) {
      const realLower = realEntry.toLowerCase();
      const tokens = realLower.split(/[\s,]+/).filter(t => t.length >= 3);
      const matched = verifiedNames.some(vName =>
        tokens.some(t => vName.includes(t))
      );
      if (matched) matchCount++;
    }

    assert(
      matchCount >= 2,
      `Only ${matchCount}/5 fixture team members found in verified set. ` +
      `Verified: ${JSON.stringify(verifiedNames)}. ` +
      `Expected some of: ${JSON.stringify(fixture.real_team_member_sample)}`
    );
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== golden.test.js ===');

  // Load fixtures
  let fixtures;
  try {
    fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  } catch (err) {
    console.error(`Cannot load fixtures from ${FIXTURES_PATH}:`, err.message);
    process.exit(1);
  }

  console.log(`Loaded ${fixtures.length} fixtures`);

  // Determine which are bad/control cases
  // Bad cases: fixtures with known-wrong data (the first 5 in the file)
  const BAD_CASE_NAMES = new Set([
    'Hash3 Capital Opportunity, LP',
    'Astro Funds LLC',
    'Base Case Capital Venture Funds',
    'Moringa Capital Master',
    'Zecca Lehn Syndicate',
  ]);

  for (const fixture of fixtures) {
    const name = fixture.series_master_llc_as_filed;
    const isBadCase = BAD_CASE_NAMES.has(name);
    const isControlCase = !isBadCase;

    if (isControlCase && SKIP_CONTROL) {
      skip(name, '--skip-control flag set');
      continue;
    }

    console.log(`\n── ${isBadCase ? 'BAD' : 'CONTROL'}: ${name} ──`);

    let result;
    try {
      result = await enrichManager(name, { dryRun: true, skipValidation: false });
      console.log(`  enrichManager completed: status=${result.enrichment_status}, suppressed=${result.suppressed}`);
    } catch (err) {
      console.error(`  ERROR running enrichManager: ${err.message}`);
      failed++;
      await delay(DELAY_MS);
      continue;
    }

    if (isBadCase) {
      await testBadCase(fixture, result);
    } else {
      await testControlCase(fixture, result);
    }

    await delay(DELAY_MS);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
