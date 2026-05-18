/**
 * team_rules.js — Decide verified/candidate/rejected for each team member.
 *
 * Decision rules for "verified":
 *   1. Found on verified website's About/Team page (anchor = found_on_verified_website)
 *   2. Listed as related person on SEC Form ADV with management role
 *
 * "candidate": found via LinkedIn search AND profile title mentions distinctive firm token
 *              AND we have a verified website or LinkedIn anchor
 *
 * "rejected": no anchor exists, OR firm-name match is only on generic tokens
 */

'use strict';

const { distinctiveTokens, identityName } = require('./website_rules');

const PLATFORM_STAFF = [
  'belltower', 'fund gp', 'angellist', 'avlok kohli',
  'brett sagan', 'sydecar', 'nik talreja',
  'assure', 'jeremy johnson',
  'carta', 'finally', 'decile', 'long pham', 'adeo ressi',
  'forge', 'allocations', 'kingsley advani',
];

function isPlatformStaff(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return PLATFORM_STAFF.some(p => lower.includes(p));
}

function isCompanyNotPerson(name) {
  if (!name) return false;
  return /\b(LLC|LP|Inc|Corp|Ltd|Fund|Trust|Foundation)\b/i.test(name);
}

/**
 * Decide status for all team member evidence items.
 *
 * @param {Evidence[]} allEvidence - All evidence items
 * @param {object} identity - resolveIdentity() result
 * @param {Decision} websiteDecision - From website_rules
 * @param {Decision} linkedInDecision - From linkedin_rules
 * @returns {Decision[]} Array of per-member decisions
 */
function decide(allEvidence, identity, websiteDecision, linkedInDecision) {
  const teamEvidence = allEvidence.filter(e => e.type === 'team_member');
  if (teamEvidence.length === 0) return [];

  const capturedAt = new Date().toISOString();
  const hasVerifiedWebsite = websiteDecision && websiteDecision.status === 'verified';
  const hasVerifiedLinkedIn = linkedInDecision && linkedInDecision.status === 'verified';
  // Use identityName helper so unresolved identities still produce a non-empty
  // token set. Same fix as website_rules / linkedin_rules — without this, team
  // members from state-only firms fail the distinctive-token gate.
  const tokens = distinctiveTokens(identityName(identity));

  const decisions = [];
  const seenNames = new Set();

  for (const ev of teamEvidence) {
    const member = ev.value;
    if (!member || !member.name) continue;
    if (isPlatformStaff(member.name)) continue;
    if (isCompanyNotPerson(member.name)) continue;

    const nameKey = member.name.toLowerCase().trim();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    // Rule 1: found on website fetch (anchor = found_on_candidate_website).
    // Status depends on whether the website itself was independently verified.
    if (ev.anchor === 'found_on_candidate_website') {
      if (hasVerifiedWebsite) {
        decisions.push({
          status: 'verified',
          value: member,
          anchors: ['found_on_verified_website'],
          evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
          decided_at: capturedAt,
          reason: 'on_verified_website',
        });
      } else if (websiteDecision && websiteDecision.status === 'candidate') {
        decisions.push({
          status: 'candidate',
          value: member,
          anchors: [],
          evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
          decided_at: capturedAt,
          reason: 'on_candidate_website_only',
        });
      } else {
        decisions.push({
          status: 'rejected',
          value: member,
          anchors: [],
          evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
          decided_at: capturedAt,
          reason: 'website_not_verified',
        });
      }
      continue;
    }

    // Rule 2: from LinkedIn search AND we have a verified anchor
    if (ev.source && ev.source.includes('linkedin_search')) {
      const titleMatchesFirm = ev.search_title
        ? tokens.some(t => (ev.search_title || '').toLowerCase().includes(t))
        : false;

      if ((hasVerifiedWebsite || hasVerifiedLinkedIn) && titleMatchesFirm) {
        decisions.push({
          status: 'candidate',
          value: member,
          anchors: [],
          evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
          decided_at: capturedAt,
          reason: 'linkedin_search_with_anchor',
        });
        continue;
      }

      // LinkedIn search without anchor → rejected (the core bug fix)
      decisions.push({
        status: 'rejected',
        value: member,
        anchors: [],
        evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
        decided_at: capturedAt,
        reason: 'unanchored_linkedin_search_no_firm_match',
      });
      continue;
    }

    // Rule 3: from external DB — weak candidate
    if (ev.source && ev.source.startsWith('external_db:')) {
      decisions.push({
        status: 'candidate',
        value: member,
        anchors: [],
        evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
        decided_at: capturedAt,
        reason: 'external_db_contact',
      });
      continue;
    }

    // Default: unanchored — candidate only if we have some website/linkedin anchor
    if (hasVerifiedWebsite || hasVerifiedLinkedIn) {
      decisions.push({
        status: 'candidate',
        value: member,
        anchors: [],
        evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
        decided_at: capturedAt,
        reason: 'unanchored_with_context',
      });
    } else {
      decisions.push({
        status: 'rejected',
        value: member,
        anchors: [],
        evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
        decided_at: capturedAt,
        reason: 'no_anchor_available',
      });
    }
  }

  return decisions;
}

module.exports = { decide };
