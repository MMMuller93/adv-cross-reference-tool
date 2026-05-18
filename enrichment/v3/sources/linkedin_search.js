/**
 * linkedin_search.js — site:linkedin.com queries for company page and team members.
 *
 * Results are always candidates — never verified without a website anchor.
 * Reuses isValidLinkedInMatch logic from enrichment_engine_v2.js.
 */

'use strict';

const { search } = require('./web_search');

const FORMER_INDICATORS = /\b(ex|former|past|formerly|previously|prior|retired|alumni|alumnus|alumna)\b/i;
const GENERIC_WORDS = new Set(['ventures', 'capital', 'partners', 'fund', 'investment',
  'management', 'holdings', 'group', 'equity', 'global', 'advisors']);

/**
 * Validate if a LinkedIn profile title indicates current association with the firm.
 * Reject "ex-", "former", "advisor-only" titles.
 */
function isValidLinkedInMatch(firmName, profileTitle) {
  const lowerTitle = profileTitle.toLowerCase();
  const lowerName = firmName.toLowerCase();

  if (FORMER_INDICATORS.test(lowerTitle)) return false;

  if (/\b(advisor|advisory|board member|board observer)\b/i.test(lowerTitle) &&
      !/\b(managing|founder|principal|partner|director|officer)\b/i.test(lowerTitle)) {
    return false;
  }

  if (lowerTitle.includes(lowerName)) return true;

  const nameParts = lowerName.split(' ').filter(w => w.length > 2);

  // Bigram check
  for (let i = 0; i < nameParts.length - 1; i++) {
    if (lowerTitle.includes(`${nameParts[i]} ${nameParts[i + 1]}`)) return true;
  }

  // Single distinctive word with word boundary
  const distinctiveWords = nameParts.filter(w => !GENERIC_WORDS.has(w));
  if (distinctiveWords.length === 1) {
    return new RegExp(`\\b${distinctiveWords[0]}\\b`, 'i').test(lowerTitle);
  }

  // All-generic name: require all words present
  if (distinctiveWords.length === 0 && nameParts.length >= 2) {
    return nameParts.every(w => lowerTitle.includes(w));
  }

  return false;
}

/**
 * Find LinkedIn company page candidates.
 *
 * @param {object} identity - Result from resolveIdentity()
 * @returns {Promise<Evidence[]>}
 */
async function findCompanyCandidates(identity) {
  const name = identity.adviser_name
    || identity.matched_variant
    || (Array.isArray(identity.variants_tried) && identity.variants_tried[0])
    || identity.input_name
    || '';
  if (!name) return [];

  const capturedAt = new Date().toISOString();
  const query = `site:linkedin.com/company "${name}"`;
  const results = await search(query);

  if (!results?.web?.results) return [];

  const candidates = [];
  for (const item of results.web.results) {
    const url = item.url || '';
    if (!url.includes('linkedin.com/company/')) continue;
    candidates.push({
      type: 'linkedin_company_url',
      value: url.split('?')[0],
      source: 'linkedin_search:company',
      anchor: null, // candidate only — needs website corroboration
      strength: 'weak',
      captured_at: capturedAt,
      search_title: item.title,
      search_query: query,
    });
  }

  return candidates;
}

/**
 * Find team member candidates via LinkedIn people search.
 *
 * @param {object} identity - Result from resolveIdentity()
 * @returns {Promise<Evidence[]>}
 */
async function findTeamCandidates(identity) {
  const name = identity.adviser_name
    || identity.matched_variant
    || (Array.isArray(identity.variants_tried) && identity.variants_tried[0])
    || identity.input_name
    || '';
  if (!name) return [];

  const capturedAt = new Date().toISOString();
  const candidates = [];
  const seen = new Set();

  const queries = [
    `site:linkedin.com/in "${name}" founder OR partner OR managing`,
    `site:linkedin.com/in "${name}" principal OR director`,
  ];

  for (const query of queries) {
    const results = await search(query);
    if (!results?.web?.results) continue;

    for (const item of results.web.results) {
      const url = item.url || '';
      if (!url.includes('linkedin.com/in/')) continue;

      const title = item.title || '';
      const namePart = title.split(' - ')[0]?.trim();
      const rolePart = title.split(' - ')[1]?.trim();

      if (!namePart || namePart.includes('LinkedIn') || namePart.length > 50) continue;
      if (!isValidLinkedInMatch(name, title)) continue;

      const username = url.split('/in/')[1]?.split(/[?/]/)[0]?.toLowerCase();
      if (!username || seen.has(username)) continue;
      seen.add(username);

      candidates.push({
        type: 'team_member',
        value: {
          name: namePart,
          title: rolePart || null,
          linkedin: url.split('?')[0],
          email: null,
        },
        source: 'linkedin_search:people',
        anchor: null, // candidate only — needs website anchor to be verified
        strength: 'weak',
        captured_at: capturedAt,
        search_title: title,
        search_query: query,
      });

      if (candidates.length >= 5) break;
    }

    if (candidates.length >= 5) break;
  }

  return candidates;
}

module.exports = { findCompanyCandidates, findTeamCandidates, isValidLinkedInMatch };
