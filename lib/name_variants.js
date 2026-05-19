/**
 * name_variants.js — Pure-function name-variant generator (no DB deps).
 *
 * Shared by:
 *   - enrichment/v3/identity.js (drives the SEC CRD resolution variant ladder)
 *   - server.js                  (drives the in-memory findAdviserMatch)
 *
 * The two callers used to maintain divergent matchers — Codex's
 * pre-flag-on review flagged this as a real risk. This module collapses
 * the variant logic. Each caller still owns its own per-pair match
 * predicate (DB query in lib/adv_lookup, raw-token bidirectional subset
 * in server.js); they just iterate the same set of variants.
 *
 * Example for "Hash3 Capital Opportunity, LP":
 *   variants = [
 *     "Hash3 Capital Opportunity",   // full stripped
 *     "Hash3 Capital",               // stripped strategy tail
 *     "Hash3",                       // first distinctive token (Hash3 matches HASH3 LLC)
 *   ]
 */

'use strict';

// Strategy-tail words that appear in fund series names but rarely in
// the underlying adviser's registered name.
const STRATEGY_TAILS = [
  'Opportunity', 'Opportunities',
  'Growth', 'Income', 'Aggressive',
  'Balanced', 'Conservative', 'Diversified',
  'Sustainable', 'Impact', 'ESG',
  'Global', 'International', 'Emerging',
  'Technology', 'Healthcare', 'Climate',
  'Select', 'Premium', 'Enhanced',
  'Plus', 'Pro', 'Elite',
  'Alpha', 'Beta',
  'Master', 'Feeder', 'Onshore', 'Offshore',
];

const LEGAL_SUFFIXES_RE = /\s*,?\s*(LP|LLC|L\.P\.|L\.L\.C\.|LTD|LIMITED|INC|CORP|INCORPORATED)\.?\s*$/i;
const FUND_NUMBER_RE = /\s+(Fund\s+)?(I{1,3}|IV|V|VI{0,3}|IX|X|\d+)\s*$/i;

const GENERIC_TOKENS = new Set([
  'fund', 'funds', 'capital', 'ventures', 'venture', 'partners', 'partner',
  'management', 'advisors', 'advisers', 'group', 'holdings', 'the',
]);

/**
 * Strip legal suffixes and fund numbers from a name.
 */
function stripLegal(name) {
  if (!name) return '';
  return String(name)
    .replace(LEGAL_SUFFIXES_RE, '')
    .replace(FUND_NUMBER_RE, '')
    .trim();
}

/**
 * Generate name variants from most-specific to least-specific.
 *
 * @param {string} rawName - Form D series-master name or similar input
 * @param {object} [opts]
 * @param {function} [opts.extraStripper] - Optional second stripper (e.g.,
 *                                          extractBaseName from lib/adv_lookup.js)
 *                                          to handle GP/Manager/Management suffixes
 * @returns {string[]} Variants, in priority order. Always ≥3 chars each.
 */
function generateVariants(rawName, opts = {}) {
  if (!rawName) return [];

  const variants = [];   // ordered list; convert to Set for dedup, preserve order
  const seen = new Set();
  const add = (s) => {
    if (!s) return;
    const t = String(s).trim();
    if (t.length < 3) return;
    if (seen.has(t)) return;
    seen.add(t);
    variants.push(t);
  };

  // Variant 1: full name, legal-suffix stripped
  const stripped = stripLegal(rawName);
  add(stripped);

  // Optional: second stripper for callers that have one (lib/adv_lookup.extractBaseName)
  if (typeof opts.extraStripper === 'function') {
    try {
      const extra = opts.extraStripper(rawName);
      add(extra);
    } catch (_) { /* tolerate stripper errors */ }
  }

  // Variant 2: strip strategy tail words from the end
  for (const tail of STRATEGY_TAILS) {
    const re = new RegExp(`\\s+${tail}\\s*$`, 'i');
    const withoutTail = stripped.replace(re, '').trim();
    if (withoutTail && withoutTail !== stripped && withoutTail.length >= 3) {
      add(withoutTail);
      const withoutTailBase = stripLegal(withoutTail);
      if (withoutTailBase) add(withoutTailBase);
    }
  }

  // Variant 3: first two meaningful tokens (only when name has 3+ tokens)
  const tokens = stripped.split(/\s+/).filter(t => t.length >= 2);
  if (tokens.length >= 3) {
    add(tokens.slice(0, 2).join(' '));
  }

  // Variant 4: first single distinctive token (only when first token isn't generic)
  if (tokens.length >= 2 && !GENERIC_TOKENS.has(tokens[0].toLowerCase())) {
    add(tokens[0]);
  }

  return variants;
}

module.exports = {
  generateVariants,
  stripLegal,
  STRATEGY_TAILS,
  GENERIC_TOKENS,
};
