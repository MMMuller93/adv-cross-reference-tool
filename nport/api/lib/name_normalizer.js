/**
 * Name normalization for Form ADV-sourced people fields.
 *
 * Form ADV stores person names in 'LAST, FIRST [, MIDDLE]' format and
 * often in ALL CAPS. Examples from advisers_enriched (CRD 105496, T. Rowe
 * Price):
 *
 *   OESTREICHER, DAVID, NMN   ->  David Oestreicher
 *   Sharps, Robert, W         ->  Robert W. Sharps
 *   VEIEL, ERIC, LANOUE       ->  Eric Lanoue Veiel
 *   Ferguson, Savonne, L      ->  Savonne L. Ferguson
 *
 * Corporate-entity rows that also appear in owner_full_legal_name (e.g.
 * 'T. ROWE PRICE GROUP, INC.') are detected and title-cased without
 * flipping the LAST/FIRST order.
 *
 * No dependencies — safe to require from any backend module. Pure JS,
 * works in browser too if needed.
 */

const CORPORATE_TOKENS = new Set([
  'INC', 'INC.', 'LLC', 'LP', 'L.P.', 'L.P', 'CORP', 'CORP.', 'CORPORATION',
  'GROUP', 'HOLDINGS', 'COMPANY', 'CO', 'CO.', 'LTD', 'LTD.', 'LIMITED',
  'TRUST', 'BANK', 'ASSOCIATES', 'MANAGEMENT', 'CAPITAL', 'PARTNERS',
  'FUND', 'FUNDS', 'ADVISORS', 'ADVISERS', 'SECURITIES', 'SERVICES',
  'PLC', 'GMBH', 'AG', 'SA', 'NV', 'BV',
]);

// Tokens that read as all-caps abbreviations even in mixed-case prose.
// INC and CORP are intentionally NOT here — convention is 'Inc.' / 'Corp.'
const ALWAYS_UPPER = new Set([
  'LLC', 'LP', 'L.P.', 'L.P', 'PLC', 'GMBH', 'AG', 'SA',
  'NV', 'BV', 'PBC', 'NA', 'N.A.', 'USA', 'UK',
]);

function isLikelyCorporate(str) {
  if (!str) return false;
  const tokens = str.toUpperCase().split(/[\s,.()]+/).filter(Boolean);
  for (const t of tokens) {
    if (CORPORATE_TOKENS.has(t)) return true;
  }
  return false;
}

function titleCaseWord(word) {
  if (!word) return word;
  const upper = word.toUpperCase();
  if (ALWAYS_UPPER.has(upper) || ALWAYS_UPPER.has(upper.replace(/\.$/, ''))) {
    return upper;
  }
  // Preserve mixed-case brand names (BlackRock, JPMorgan, etc.) — if the
  // word already has BOTH upper and lower letters, leave it alone. Only
  // re-case words that arrive as all-upper or all-lower.
  const hasLower = /[a-z]/.test(word);
  const hasUpperPastFirst = /[A-Z]/.test(word.slice(1));
  if (hasLower && hasUpperPastFirst) {
    return word;
  }
  // Standard title case (handles ALL CAPS and all-lowercase). Capitalize
  // after start-of-word and after internal period/hyphen/apostrophe.
  return word
    .toLowerCase()
    .replace(/(^|[\s\-'.])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());
}

function titleCase(str) {
  if (!str) return str;
  return str.split(/(\s+)/).map(part => /\s+/.test(part) ? part : titleCaseWord(part)).join('');
}

/**
 * Normalize a single name string.
 *
 * - Corporate strings: title-case only (no order flip).
 * - Person strings (with comma): flip LAST,FIRST,MIDDLE -> First Middle Last.
 *   Drop placeholder 'NMN'. Add period to single-letter middle initials.
 * - No-comma strings: title-case, no flip.
 */
function normalizeName(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  if (isLikelyCorporate(trimmed)) {
    return titleCase(trimmed);
  }

  const parts = trimmed.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    return titleCase(trimmed);
  }

  // parts = [last, first, ...middleTokens]
  const last = parts[0];
  const first = parts[1];
  const middleTokens = parts.slice(2)
    .filter(t => t.toUpperCase() !== 'NMN')   // 'no middle name' placeholder
    .map(t => {
      // Single letter -> add period (initials).
      if (/^[A-Za-z]$/.test(t)) return t.toUpperCase() + '.';
      return t;
    });

  const segments = [first, ...middleTokens, last]
    .filter(Boolean)
    .map(titleCase);

  return segments.join(' ');
}

/**
 * Normalize a semicolon-joined owners blob from advisers_enriched into an
 * array of cleaned names. Empty/falsy returns [].
 *
 * Example input:
 *   'T. ROWE PRICE GROUP, INC.; OESTREICHER, DAVID, NMN; Sharps, Robert, W'
 * Example output:
 *   ['T. Rowe Price Group, Inc.', 'David Oestreicher', 'Robert W. Sharps']
 */
function normalizeOwnersList(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeName)
    .filter(Boolean);
}

module.exports = {
  normalizeName,
  normalizeOwnersList,
  isLikelyCorporate,
};
