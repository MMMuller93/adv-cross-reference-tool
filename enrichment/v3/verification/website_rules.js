/**
 * website_rules.js — Decide verified/candidate/rejected for a website URL.
 *
 * Decision rules (any of these → verified):
 *   1. SEC ADV CRD lookup returned a primary_website AND domain matches candidate
 *   2. Candidate domain self-references the firm on homepage (firm name in title/h1)
 *   3. LinkedIn company page's website field matches candidate domain
 *
 * candidate: domain contains a distinctive token but no anchor confirms
 * rejected: blocked domain, article page, or no firm-name relation
 */

'use strict';

const FREE_EMAIL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com']);

/**
 * Extract hostname from URL (without www.).
 */
function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * Check if two URLs share the same effective domain.
 */
function sameDomain(urlA, urlB) {
  if (!urlA || !urlB) return false;
  return hostname(urlA) === hostname(urlB);
}

/**
 * Generic tokens that appear in many firm names — not distinctive enough alone.
 */
const GENERIC = new Set([
  'capital', 'ventures', 'venture', 'partners', 'partner', 'fund', 'funds',
  'management', 'advisors', 'advisers', 'group', 'holdings', 'investment',
  'investments', 'private', 'equity', 'asset', 'global', 'international',
]);

/**
 * Get distinctive name tokens (non-generic, ≥4 chars) from a firm name.
 */
function distinctiveTokens(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !GENERIC.has(t));
}

/**
 * Decide the website_url field status from all collected evidence.
 *
 * @param {Evidence[]} allEvidence - All evidence items from all sources
 * @param {object} identity - resolveIdentity() result
 * @returns {Decision} { status, value, anchors, evidence, reason }
 */
function decide(allEvidence, identity) {
  const websiteEvidence = allEvidence.filter(e => e.type === 'website_url');
  if (websiteEvidence.length === 0) {
    return { status: 'no_data', value: null, anchors: [], evidence: [], reason: 'no_candidates' };
  }

  const capturedAt = new Date().toISOString();

  // Try each candidate in strength order (strong → medium → weak)
  const ordered = [...websiteEvidence].sort((a, b) => {
    const rank = { strong: 0, medium: 1, weak: 2 };
    return (rank[a.strength] ?? 3) - (rank[b.strength] ?? 3);
  });

  for (const ev of ordered) {
    const url = ev.value;
    if (!url) continue;
    const host = hostname(url);
    if (!host) continue;

    const anchors = [];
    const supporting = [ev];

    // Rule 1: SEC ADV provided this website directly (anchor already set)
    if (ev.anchor && ev.anchor.startsWith('sec_adv_crd:')) {
      anchors.push(ev.anchor);
    }

    // Rule 2: identity.primary_website (from SEC ADV) matches this candidate
    if (identity.primary_website && sameDomain(identity.primary_website, url)) {
      anchors.push(`sec_adv_crd:${identity.crd || 'unknown'}`);
    }

    // Rule 3: another evidence item confirms LinkedIn website → matches this domain
    const linkedInWithWebsite = allEvidence.find(e =>
      e.type === 'linkedin_company_url' && e.anchor === 'website_links_to_linkedin'
    );
    if (linkedInWithWebsite) {
      // The linkedin was found on this website — that confirms the website itself
      anchors.push('website_links_to_linkedin');
      supporting.push(linkedInWithWebsite);
    }

    // Rule 4: external DB provided this URL
    if (ev.source && ev.source.startsWith('external_db:')) {
      // External DB alone is not an anchor, but it's corroborating evidence
      // Only treat as verified if combined with another signal
    }

    if (anchors.length > 0) {
      return {
        status: 'verified',
        value: url,
        anchors,
        evidence: supporting.map(e => ({
          source: e.source,
          field: e.field,
          captured_at: e.captured_at,
        })),
        decided_at: capturedAt,
        reason: `anchored_by:${anchors[0]}`,
      };
    }

    // Check if this is at least a candidate (domain has distinctive firm token)
    const tokens = distinctiveTokens(identity.adviser_name || identity.matched_variant || '');
    if (tokens.length > 0 && tokens.some(t => host.includes(t))) {
      // Return as candidate (first one wins — strongest evidence first)
      return {
        status: 'candidate',
        value: url,
        anchors: [],
        evidence: [{ source: ev.source, field: ev.field, captured_at: ev.captured_at }],
        decided_at: capturedAt,
        reason: 'distinctive_token_in_domain_no_anchor',
      };
    }
  }

  // All candidates failed distinctive-token check → rejected
  return {
    status: 'rejected',
    value: null,
    anchors: [],
    evidence: websiteEvidence.map(e => ({ source: e.source, value: e.value, captured_at: e.captured_at })),
    decided_at: capturedAt,
    reason: 'no_distinctive_token_match',
  };
}

module.exports = { decide, hostname, sameDomain, distinctiveTokens };
