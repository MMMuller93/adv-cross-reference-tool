/**
 * linkedin_rules.js — Decide verified/candidate/rejected for linkedin_company_url.
 *
 * Decision rules (any → verified):
 *   1. Verified website's HTML links to this LinkedIn URL
 *   2. This was found on the verified website directly (anchor = website_links_to_linkedin)
 *
 * candidate: returned by site:linkedin.com/company search but no anchor confirms
 * rejected: slug shares no distinctive token with firm name
 */

'use strict';

const { hostname, distinctiveTokens } = require('./website_rules');

/**
 * Extract the company slug from a LinkedIn company URL.
 */
function linkedInSlug(url) {
  if (!url) return '';
  const m = url.match(/linkedin\.com\/company\/([^\/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Decide the linkedin_company_url field status.
 *
 * @param {Evidence[]} allEvidence - All evidence items
 * @param {object} identity - resolveIdentity() result
 * @param {Decision} websiteDecision - Result from website_rules.decide()
 * @returns {Decision}
 */
function decide(allEvidence, identity, websiteDecision) {
  const linkedInEvidence = allEvidence.filter(e => e.type === 'linkedin_company_url');
  if (linkedInEvidence.length === 0) {
    return { status: 'no_data', value: null, anchors: [], evidence: [], reason: 'no_candidates' };
  }

  const capturedAt = new Date().toISOString();
  const tokens = distinctiveTokens(identity.adviser_name || identity.matched_variant || '');

  // Prefer evidence that already has an anchor (found on website HTML)
  const anchored = linkedInEvidence.find(e => e.anchor === 'website_links_to_linkedin');
  if (anchored) {
    return {
      status: 'verified',
      value: anchored.value,
      anchors: ['website_links_to_linkedin'],
      evidence: [{ source: anchored.source, field: anchored.field, captured_at: anchored.captured_at }],
      decided_at: capturedAt,
      reason: 'found_on_verified_website',
    };
  }

  // If we have a verified website, check if any LinkedIn candidate shares slug tokens
  // with distinctive firm tokens — that's a reasonable candidate promotion
  if (websiteDecision && websiteDecision.status === 'verified') {
    for (const ev of linkedInEvidence) {
      const slug = linkedInSlug(ev.value);
      if (!slug) continue;

      // Check if slug contains a distinctive token of the firm name
      const slugMatches = tokens.length > 0 && tokens.some(t => slug.includes(t));
      if (slugMatches) {
        return {
          status: 'candidate',
          value: ev.value,
          anchors: [],
          evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
          decided_at: capturedAt,
          reason: 'slug_token_match_with_verified_website',
        };
      }
    }
  }

  // Without a verified website, all LinkedIn company results are candidates
  for (const ev of linkedInEvidence) {
    const slug = linkedInSlug(ev.value);
    if (!slug) continue;

    // Reject if slug shares no distinctive token with firm name
    if (tokens.length > 0 && !tokens.some(t => slug.includes(t))) {
      continue; // try next
    }

    return {
      status: 'candidate',
      value: ev.value,
      anchors: [],
      evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
      decided_at: capturedAt,
      reason: 'search_result_candidate',
    };
  }

  return {
    status: 'rejected',
    value: null,
    anchors: [],
    evidence: linkedInEvidence.map(e => ({ source: e.source, value: e.value, captured_at: e.captured_at })),
    decided_at: capturedAt,
    reason: 'slug_no_distinctive_token',
  };
}

module.exports = { decide, linkedInSlug };
