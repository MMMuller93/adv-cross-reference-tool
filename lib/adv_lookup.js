/**
 * Shared ADV lookup utilities.
 *
 * Used by detect_compliance_issues.js and enrichment/* scripts to determine
 * whether a firm name (extracted from Form D) maps to a registered investment
 * adviser.
 *
 * The lookup is FIRM-LEVEL. We are asking "does this firm appear in
 * advisers_enriched as either an RIA or an ERA?" — NOT "is this specific fund
 * in funds_enriched." Per the reference guide (docs/SEC_FORM_ADV_FORM_D_REFERENCE_GUIDE.md
 * section 4.2), both RIAs and ERAs file Form ADV and are in advisers_enriched.
 *
 * Strategies (first hit wins):
 *   1. Base-name exact ilike match on adviser_name
 *   2. First-word prefix match (min length 3)
 *   3. NEW (A6): adviser_owners cross-check — Form D related persons with
 *      executive roles matched against owner_full_name where owner_type='I'
 *      (individual) and title_or_status is in the management-title allowlist.
 *      Requires ≥2-token first+last agreement.
 *   4. Legacy: last-name match on adviser_name with first-name or base-name
 *      verification (lower precision, kept as last resort).
 */

// Form D role tags that indicate this related person is involved in
// management/control of the fund. We only use these for adviser-owner
// cross-checking; passive owners and platform staff are excluded.
const MANAGEMENT_FORMD_ROLES = [
  'EXECUTIVE OFFICER', 'OFFICER',
  'DIRECTOR',
  'PROMOTER',
  'GENERAL PARTNER', 'GP',
  'MANAGING MEMBER',
  'MANAGER', 'MANAGING DIRECTOR', 'MANAGING PARTNER',
];

// ADV adviser_owners.title_or_status values that indicate the owner is a
// management decision-maker for the firm. Derived from A0.3 verification
// query against live data (top 20 titles by frequency). Excludes service
// provider / passive roles (MEMBER, SHAREHOLDER, OWNER, LIMITED PARTNER,
// CCO, CFO, GC, TRUSTEE, AUTHORIZED SIGNATORY, ATTORNEY IN FACT, CONSULTING*).
const MANAGEMENT_OWNER_TITLES = [
  'MANAGING MEMBER',
  'MANAGING PARTNER',
  'MANAGING DIRECTOR',
  'GENERAL PARTNER',
  'PARTNER',
  'PRINCIPAL',
  'FOUNDER',
  'CO-FOUNDER', 'COFOUNDER', 'CO FOUNDER',
  'CHIEF EXECUTIVE OFFICER', 'CEO',
  'PRESIDENT',
  'CHIEF OPERATING OFFICER', 'COO',
  'CHIEF INVESTMENT OFFICER', 'CIO',
  'MANAGER', 'ELECTED MANAGER',
  'DIRECTOR',  // caveat: can be board-only, but is in management-title bucket
];

// Stop words and legal/structural fragments we should never match on alone.
const NAME_STOPWORDS = new Set([
  'the', 'of', 'and', 'a', 'an',
  'fund', 'funds', 'capital', 'ventures', 'venture', 'partners', 'partner',
  'holdings', 'group', 'management', 'mgmt', 'advisors', 'advisers',
  'gp', 'lp', 'llc', 'llp', 'inc', 'ltd', 'corp', 'corporation', 'co',
  'series', 'master', 'feeder',
]);

/**
 * Extract base company name for ADV registration matching.
 *
 * GP entity names in Form D often differ from registered adviser names:
 *   "KIG GP, LLC" registers as "KIG INVESTMENT MANAGEMENT, LLC"
 *   "Akahi Capital Management, LLC" registers as "AKAHI CAPITAL MANAGEMENT"
 *   "HighVista GP LLC" registers as "HIGHVISTA STRATEGIES LLC"
 *   "Patricof Co. Master, LLC" registers as "PATRICOF CO. LLC"  ← A7 fix
 */
function extractBaseName(name) {
  if (!name) return '';
  let base = name;

  // A7: Master added to the strip list (Patricof Co. case from
  // docs/ANALYSIS_COMPLIANCE_ENRICHMENT_FIXES.md Issue #6)
  base = base.replace(/\s+(GP|General Partner|Manager|Management|Advisors?|Advisers?|Master)\s*,?\s*(LLC|LP|L\.?P\.?)?$/i, '');
  base = base.replace(/\s*,?\s*(LLC|L\.?L\.?C\.?|LP|L\.?P\.?|LTD|LIMITED|INC|INCORPORATED)\.?$/i, '');
  base = base.replace(/\s+(Fund|Capital|Ventures?|Partners?|Holdings?|Group)\s+(I{1,3}|IV|V|VI|VII|VIII|IX|X|\d+)$/i, '');

  return base.trim();
}

/**
 * Normalize a person name for token comparison.
 * "DAVID S. BLOCK" → ["david", "block"]   (we keep first + last, drop middles/initials)
 */
function nameTokens(name) {
  if (!name) return { first: '', last: '', all: [] };
  // Form D often uses "Last, First Middle" or "First Middle Last"; handle both
  let s = name.toUpperCase().replace(/[^\w\s,'-]/g, ' ').replace(/\s+/g, ' ').trim();
  let parts;
  if (s.includes(',')) {
    // "LAST, FIRST MIDDLE" or "LAST, FIRST"
    const [last, rest] = s.split(',').map(x => x.trim());
    const restTok = rest.split(/\s+/).filter(t => t.length > 1 && t !== 'NMN');
    parts = [...restTok, last];
  } else {
    parts = s.split(/\s+/).filter(t => t.length > 1 && t !== 'NMN');
  }
  // Strip single-letter initials
  parts = parts.filter(t => t.length >= 2 || /[A-Z]/.test(t));
  parts = parts.filter(t => t.length >= 2);
  if (parts.length === 0) return { first: '', last: '', all: [] };
  return {
    first: parts[0],
    last: parts[parts.length - 1],
    all: parts,
  };
}

/**
 * Test if two names match with first+last token agreement.
 */
function namesMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.first || !tb.first || !ta.last || !tb.last) return false;
  return ta.first === tb.first && ta.last === tb.last;
}

/**
 * Parse Form D related_names + related_roles into pipe-aligned objects.
 * Filters to entries whose role indicates management authority.
 */
function parseRelatedPersons(relatedNames, relatedRoles) {
  if (!relatedNames) return [];
  const names = relatedNames.split('|').map(s => s.trim());
  const roles = (relatedRoles || '').split('|').map(s => s.trim());
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const roleRaw = (roles[i] || '').toUpperCase();
    if (!name || name.length < 3) continue;
    // role can be comma-delimited within a slot ("Executive Officer,Director")
    const roleParts = roleRaw.split(/[,;]/).map(r => r.trim()).filter(Boolean);
    const hasMgmtRole = roleParts.length === 0
      ? true  // missing role — keep but lower confidence
      : roleParts.some(rp => MANAGEMENT_FORMD_ROLES.some(mr => rp.includes(mr)));
    if (hasMgmtRole) {
      out.push({ name, roles: roleParts, role_raw: roleRaw });
    }
  }
  return out;
}

/**
 * Check if a manager (firm name extracted from Form D) is registered in ADV.
 *
 * @param {SupabaseClient} advDb - Supabase client for the ADV database
 * @param {string} managerName - Firm name extracted from Form D
 * @param {object} opts - optional context
 * @param {string} opts.relatedNames - pipe-separated names from Form D
 * @param {string} opts.relatedRoles - pipe-separated roles aligned to names
 * @param {boolean} opts.personOnly - if true, treat managerName as a person name;
 *   skip firm-name strategies (exact basename, first-word prefix) and ONLY use
 *   person-graph strategies (adviser_owners + legacy last-name match). Use this
 *   when re-checking against Form D related persons in timing-lag suppression,
 *   where the input is a personal name like "John Smith" — without this flag,
 *   first-word prefix would resolve "John" → any adviser starting with "John"
 *   and produce a false-positive suppression.
 * @returns {Promise<{found, source, crd, adviser_name, registration_type, matched_person?}>}
 */
async function checkAdvDatabase(advDb, managerName, opts = {}) {
  const relatedNames = opts.relatedNames || opts.related_names || null;
  const relatedRoles = opts.relatedRoles || opts.related_roles || null;
  const personOnly = !!opts.personOnly;

  const baseName = extractBaseName(managerName);

  // Meaningful-token guard: when the base name reduces to generic vocabulary
  // (e.g., "Fund I", "Capital", "The Fund"), the substring ilike will match
  // thousands of advisers and the first row is arbitrary. Strategy 1 requires
  // at least one distinctive token (≥3 chars, not in stopwords, not a roman
  // numeral) and a base name length of ≥4 chars. Live evidence (2026-05-11
  // detector run): "Fund I" → "EDELWEISS FUND II ASSOCIATES" matched because
  // "Fund I" is a substring prefix of "Fund II"; this guard prevents that.
  const ROMAN_RE = /^[ivx]+$/i;
  const meaningfulTokens = (baseName || '').split(/\s+/).filter(t =>
    t.length >= 3 && !NAME_STOPWORDS.has(t.toLowerCase()) && !ROMAN_RE.test(t)
  );
  // baseName must be ≥3 chars AND contain at least one distinctive token
  // (not stopword, not roman). This blocks "Fund I" / "Capital" / "The Fund"
  // while keeping legit 3-char acronym firms like KIG, FSF, VTC.
  const baseIsMeaningful = baseName && baseName.length >= 3 && meaningfulTokens.length >= 1;

  // Strategy 1: exact base-name ilike (firm-name strategy — skip in personOnly mode)
  if (!personOnly && baseIsMeaningful) {
    const { data: exact } = await advDb
      .from('advisers_enriched')
      .select('crd, adviser_name, registration_type')
      .ilike('adviser_name', `%${baseName}%`)
      .not('adviser_name', 'is', null)
      .neq('adviser_name', '')
      .order('adviser_name')
      .limit(5);
    if (exact && exact.length > 0) {
      // Pick the SHORTEST match — when multiple advisers match, the shortest is
      // most likely the registered firm itself (vs longer variants like
      // "CAPITAL FACTORY VENTURES MANAGEMENT II, LLC" vs base "CAPITAL FACTORY").
      const best = exact.slice().sort((a, b) => (a.adviser_name || '').length - (b.adviser_name || '').length)[0];
      return {
        found: true,
        source: 'database_basename',
        crd: best.crd,
        adviser_name: best.adviser_name,
        registration_type: best.registration_type,
      };
    }
  }

  // Strategy 1.5: two-word ilike substring (catches the "stopword-first compound name"
  // case where baseName is wider than the registered name).
  //
  // Live evidence (2026-05-11): "Capital Factory SPVs, LP" → extractBaseName = "Capital Factory SPVs"
  // → Strategy 1 ilike '%Capital Factory SPVs%' = 0 hits (registered firm is just "CAPITAL FACTORY").
  // Strategy 2 firstWord = "Capital" is a stopword → blocked by stopword guard.
  // This strategy fires when:
  //   - firstWord is a stopword (otherwise Strategy 2 will catch it)
  //   - secondWord is non-stopword, ≥4 chars (specific enough to avoid FPs)
  // It then runs ilike '%firstWord secondWord%' to find the registered firm.
  if (!personOnly && baseName) {
    const tokens = baseName.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      const fw = tokens[0];
      const sw = tokens[1];
      const fwIsStopword = NAME_STOPWORDS.has(fw.toLowerCase());
      const swIsDistinctive = sw.length >= 4 && !NAME_STOPWORDS.has(sw.toLowerCase()) && !ROMAN_RE.test(sw);
      if (fwIsStopword && swIsDistinctive) {
        const twoWord = `${fw} ${sw}`;
        const { data: twoHits } = await advDb
          .from('advisers_enriched')
          .select('crd, adviser_name, registration_type')
          .ilike('adviser_name', `%${twoWord}%`)
          .not('adviser_name', 'is', null)
          .neq('adviser_name', '')
          .limit(8);
        if (twoHits && twoHits.length > 0) {
          // Prefer the shortest — most likely the bare firm name vs longer variants
          const best = twoHits.slice().sort((a, b) => (a.adviser_name || '').length - (b.adviser_name || '').length)[0];
          return {
            found: true,
            source: 'database_twoword',
            crd: best.crd,
            adviser_name: best.adviser_name,
            registration_type: best.registration_type,
          };
        }
      }
    }
  }

  // Strategy 2: first-word prefix (firm-name strategy — skip in personOnly mode)
  // Min 3 chars per A0.3 evidence (214 real advisers have 3-4 char first words;
  // raising to ≥5 would break Patricof-style cases).
  const firstWord = baseName.split(' ')[0];
  if (!personOnly && firstWord && firstWord.length >= 3 && !NAME_STOPWORDS.has(firstWord.toLowerCase())) {
    const { data: partial } = await advDb
      .from('advisers_enriched')
      .select('crd, adviser_name, registration_type')
      .ilike('adviser_name', `${firstWord}%`)
      .not('adviser_name', 'is', null)
      .neq('adviser_name', '')
      .limit(10);
    if (partial && partial.length > 0) {
      return {
        found: true,
        source: 'database_firstword',
        crd: partial[0].crd,
        adviser_name: partial[0].adviser_name,
        registration_type: partial[0].registration_type,
      };
    }
  }

  // Strategy 3 (A6): adviser_owners cross-check.
  //
  // Two modes:
  //   - personOnly: input managerName IS a person name (e.g., A8 timing-lag check).
  //     Match the input directly against adviser_owners with first+last agreement.
  //   - default: iterate Form D related persons (parseRelatedPersons), check each
  //     against adviser_owners with first+last agreement and management title filter.
  //
  // Owner-side filters in both modes:
  //   - owner_type='I' (individuals only — skip entity owners)
  //   - title_or_status in MANAGEMENT_OWNER_TITLES (skip service-role owners like
  //     CCO/CFO/GC/Authorized Signatory).
  const personCandidates = personOnly
    ? [{ name: managerName, role_raw: '' }]
    : parseRelatedPersons(relatedNames, relatedRoles);

  for (const person of personCandidates.slice(0, 8)) {
    const tokens = nameTokens(person.name);
    if (!tokens.first || !tokens.last || tokens.first.length < 2 || tokens.last.length < 2) continue;
    // Search adviser_owners for individuals matching this person's last name
    const { data: ownerMatches } = await advDb
      .from('adviser_owners')
      .select('firm_crd, owner_full_name, title_or_status, is_control_person, owner_type, schedule')
      .eq('owner_type', 'I')
      .ilike('owner_full_name', `%${tokens.last}%`)
      .limit(40);
    if (!ownerMatches || ownerMatches.length === 0) continue;

    for (const om of ownerMatches) {
      if (!namesMatch(person.name, om.owner_full_name)) continue;
      // Title filter: owner must hold a management role (not service/passive)
      const title = (om.title_or_status || '').toUpperCase().trim();
      const isMgmtTitle = title && MANAGEMENT_OWNER_TITLES.some(mt => title.includes(mt));
      if (!isMgmtTitle) continue;
      // Resolve to advisers_enriched
      const { data: advRow } = await advDb
        .from('advisers_enriched')
        .select('crd, adviser_name, registration_type')
        .eq('crd', om.firm_crd)
        .not('adviser_name', 'is', null)
        .neq('adviser_name', '')
        .single();
      if (advRow && advRow.crd) {
        return {
          found: true,
          source: personOnly ? 'adviser_owners_person_only' : 'adviser_owners',
          crd: advRow.crd,
          adviser_name: advRow.adviser_name,
          registration_type: advRow.registration_type,
          matched_person: person.name,
          matched_owner: om.owner_full_name,
          matched_title: om.title_or_status,
        };
      }
    }
  }

  // Strategy 4 (legacy): last-name on adviser_name with first-name or base-name
  // validation. Firm-name-side strategy — skip in personOnly mode.
  if (!personOnly && relatedNames) {
    const personList = relatedNames.split('|').map(n => n.trim()).filter(n => n.length > 3);
    for (const person of personList.slice(0, 5)) {
      const nameParts = person.split(/\s+/);
      if (nameParts.length < 2) continue;
      const lastName = nameParts[nameParts.length - 1];
      if (lastName.length < 3) continue;
      const { data: personMatch } = await advDb
        .from('advisers_enriched')
        .select('crd, adviser_name, registration_type')
        .ilike('adviser_name', `%${lastName}%`)
        .not('adviser_name', 'is', null)
        .neq('adviser_name', '')
        .limit(5);
      if (!personMatch || personMatch.length === 0) continue;
      const firstName = nameParts[0];
      const baseFirstWord = (baseName.toUpperCase().split(' ')[0] || '');
      const hit = personMatch.find(a => {
        const an = a.adviser_name.toUpperCase();
        return an.includes(lastName.toUpperCase()) &&
          (an.includes(firstName.toUpperCase()) || (baseFirstWord && an.includes(baseFirstWord)));
      });
      if (hit) {
        return {
          found: true,
          source: 'database_related_person',
          crd: hit.crd,
          adviser_name: hit.adviser_name,
          registration_type: hit.registration_type,
          matched_person: person,
        };
      }
    }
  }

  return { found: false };
}

module.exports = {
  extractBaseName,
  checkAdvDatabase,
  parseRelatedPersons,
  nameTokens,
  namesMatch,
  MANAGEMENT_FORMD_ROLES,
  MANAGEMENT_OWNER_TITLES,
  NAME_STOPWORDS,
};
