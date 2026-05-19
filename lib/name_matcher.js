/**
 * name_matcher.js — Shared identity-correctness gate for SEC-CRD matches.
 *
 * This module is a pure-function home for the stricter-CRD-match gate that
 * was originally added inline in `enrichment/v3/identity.js` (2026-05-18,
 * post-cleanup audit). It now lives in `lib/` so multiple callers can share
 * the SAME gate logic:
 *
 *   - enrichment/v3/identity.js (resolveIdentity)
 *   - lib/adv_lookup.js#searchAdvByName (variant-laddered wrapper)
 *   - server.js#findAdviserMatch (new-managers endpoint)
 *   - detect_compliance_issues.js (compliance detector)
 *
 * No DB clients, no env vars — purely a token-comparison function.
 *
 * Background:
 *   `checkAdvDatabase` accepts a CRD match as long as every distinctive
 *   manager-name token appears as a full token in the adviser_name. That
 *   works for managers with 2+ distinctive tokens or one long one (Hash3 →
 *   "hash3"). It is DANGEROUS when the manager name is short/acronym-only
 *   ("TMS Angels" → "TMS Capital Management" — share only the "TMS" acronym
 *   but are different firms).
 *
 * Gate rule:
 *   - shared distinctive tokens ≥ 2                       → PASS
 *   - shared = 1 AND token length ≥ 5 (long distinctive)  → PASS
 *   - shared = 1 AND token length ≤ 4 (acronym/short):
 *       - has non-platform Form D related_persons          → PASS as candidate (downgrade)
 *       - otherwise                                        → REJECT
 *   - shared = 0                                          → REJECT (defensive)
 *
 * Returns { pass: boolean, downgrade?: boolean, reason: string, shared: string[] }.
 */

'use strict';

const { NAME_STOPWORDS } = require('./adv_lookup');

const PLATFORM_ADMIN_RE = /\b(angellist|sydecar|carta|allocations|belltower|forge|assure|fund\s+gp|cgf2021)\b/i;
const ROMAN_RE = /^[ivx]+$/i;

/**
 * Extract distinctive tokens from a name (stopword-filtered, stemmed
 * for plurals only on long words).
 *
 * Stemming nuance: only strip trailing 's' on words ≥6 chars. Words of
 * length 4–5 ending in 's' (locus, atlas, lotus, focus, axis, basis) are
 * usually singular nouns, not plurals. Over-stemming collapses real
 * distinctive words into shorter acronym-like forms, pushing the gate
 * to reject legitimate matches like "Locus Ventures II" vs "LOCUS CAPITAL".
 */
function distinctiveTokens(s) {
  if (!s) return new Set();
  const toks = String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (const raw of toks) {
    if (raw.length < 3) continue;
    if (NAME_STOPWORDS.has(raw)) continue;
    if (ROMAN_RE.test(raw)) continue;
    const stem = (raw.length >= 6 && raw.endsWith('s')) ? raw.slice(0, -1) : raw;
    out.add(stem);
  }
  return out;
}

/**
 * @param {{found: boolean, adviser_name?: string}} advResult - checkAdvDatabase output
 * @param {string} mgrName - the original Form D series-master name (or whatever the caller is matching)
 * @param {object} [opts]
 * @param {string} [opts.matchedVariant] - the specific variant that produced the match (preferred for token comparison)
 * @param {string} [opts.relatedNames] - pipe-separated Form D related_names for corroboration on acronym matches
 * @returns {{pass: boolean, downgrade?: boolean, reason: string, shared?: string[]}}
 */
function passesStricterCrdGate(advResult, mgrName, opts = {}) {
  if (!advResult || !advResult.found) {
    return { pass: true, reason: 'no_sec_match_to_gate' };
  }
  const mgrTokens = distinctiveTokens(opts.matchedVariant || mgrName);
  const advTokens = distinctiveTokens(advResult.adviser_name);
  const shared = [...mgrTokens].filter(t => advTokens.has(t));

  if (shared.length >= 2) {
    return { pass: true, reason: `shares_${shared.length}_distinctive_tokens`, shared };
  }
  if (shared.length === 1) {
    const tok = shared[0];
    if (tok.length >= 5) {
      return { pass: true, reason: `single_long_distinctive:${tok}`, shared };
    }
    // Acronym / short token — need corroboration
    const relatedNames = String(opts.relatedNames || '');
    const personEntries = relatedNames.split('|')
      .map(s => s.trim())
      .filter(s => s.length > 2 && !PLATFORM_ADMIN_RE.test(s));
    if (personEntries.length > 0) {
      return {
        pass: false,
        downgrade: true,
        reason: `acronym_${tok}_weak_corroboration_${personEntries.length}_persons`,
        shared,
      };
    }
    return { pass: false, reason: `acronym_${tok}_no_corroboration`, shared };
  }
  return { pass: false, reason: 'zero_shared_distinctive_tokens', shared };
}

module.exports = {
  passesStricterCrdGate,
  distinctiveTokens,
  PLATFORM_ADMIN_RE,
};
