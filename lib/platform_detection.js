/**
 * Platform detection for Form D filings.
 *
 * Mirrors and extends the patterns documented in
 * `lead_lists/PLATFORM_DETECTION_REFERENCE.md`.
 *
 * Used by detect_compliance_issues.js and the enrichment pipeline to identify
 * filings where the issuer is hosted on a fund-admin platform (Sydecar, AngelList,
 * Assure, etc.). For those filings, the series-master extracted from the entity
 * name is the platform admin LLC — NOT the real fund manager. The real manager
 * must be found via related_names with executive roles instead.
 *
 * NOTE on AngelList specifically: AngelList Advisors LLC (CRD 167700) IS a
 * registered investment adviser, and IS the IA-of-record for many platform funds
 * that appear on its Form ADV Schedule D Section 7.B. This module does NOT filter
 * those out — the cross_reference_matches anti-join handles them correctly because
 * they ARE matched advisers. What this module does identify is filings where the
 * pattern in entityname/related_names indicates a platform admin signature; that
 * signal is used downstream to choose the right manager-name extraction strategy.
 */

const PLATFORM_PATTERNS = [
  {
    name: 'AngelList',
    entityname: [/\broll\s+up\s+vehicles\b/i, /\bangellist\b/i, /,\s*al,?\s*lp\s*$/i, /-al-/i, /\bangellist-gp-funds?\b/i, /\bangellist\s+stack\b/i],
    related_names: [/\bbelltower\b/i, /\bangellist\b/i, /\bllc\s+fund\s+gp\b/i],
    known_crd: '167700',
  },
  {
    name: 'Sydecar',
    entityname: [/\bcgf2021\b/i, /\bsydecar\b/i],
    related_names: [/\bsydecar\b/i, /\bllc\s+sydecar\b/i, /\bnik\s+talreja\b/i],
    known_signer_substrings: ['brett sagan', 'taylor hughes', 'theodore stiefel', 'tuan tiet'],
  },
  {
    name: 'Assure',
    entityname: [/\bassure\s+labs\b/i],
    related_names: [/\bassure\s+fund\b/i, /\bassure\s+services\b/i, /\bglassboard\b/i],
    known_signer_substrings: ['richard thoms', 'jeremy neilson', 'troy esquibel'],
  },
  {
    name: 'EquityZen',
    entityname: [/\bequityzen\b/i, /\bcfund\s+master\b/i],
    related_names: [/\bequityzen\b/i],
    known_signer_substrings: ['phil haslett'],
  },
  {
    name: 'Allocations',
    entityname: [/\ballocations\b/i],
    related_names: [/\ballocations?\s+fund\b/i, /\ballocation\s+fund\b/i],
    known_signer_substrings: ['hoang phan', 'kurt nunez'],
  },
  {
    name: 'Carta',
    entityname: [],
    related_names: [/\bcarta\s+(fund|capital)\b/i],
    known_signer_substrings: [],
  },
  {
    name: 'Decile',
    entityname: [/\bdecile\s+start\b/i],
    related_names: [/\bdecile\b/i],
    known_signer_substrings: ['long pham', 'adeo ressi'],
  },
  {
    name: 'Finally',
    entityname: [],
    related_names: [/\bfinally\s+fund\b/i, /\bfinally\s+(admin|fund\s+admin)\b/i],
    known_signer_substrings: ['melissa garlough', 'nhi nguyen', 'jenna fernandes'],
  },
  {
    name: 'Republic',
    entityname: [/\brepublic\s+master\b/i, /\brepublic\s+deal\s+room\b/i],
    related_names: [/\brepublic\s+capital\b/i, /\brepublic\s+deal\b/i, /\brepublic\s+fund\s+admin\b/i],
    known_signer_substrings: ['thomas k. hoops', 'giovanni corrado'],
  },
  {
    name: 'Seed Labs',
    entityname: [],
    related_names: [/\bseed\s+labs\b/i],
    known_signer_substrings: ['shriank kanaparti'],
  },
  {
    name: 'Alt Financial',
    entityname: [],
    related_names: [/\balternative\s+financial\b/i],
    known_signer_substrings: ['bryan casey'],
  },
  {
    name: 'Vauban',
    entityname: [],
    related_names: [/\bvauban\b/i],
    known_signer_substrings: [],
  },
  {
    name: 'WeFunder',
    entityname: [/\bwefunder\b/i],
    related_names: [/\bwefunder\b/i],
    known_signer_substrings: [],
  },
  {
    name: 'iAngels',
    entityname: [/\b(g)?iangels\b/i],
    related_names: [/\biangels\b/i],
    known_signer_substrings: [],
  },
  {
    name: 'FundersClub',
    entityname: [/\bfundersclub\b/i],
    related_names: [/\bfundersclub\b/i],
    known_signer_substrings: [],
  },
  {
    name: 'OurCrowd',
    entityname: [/\bourcrowd\b/i],
    related_names: [/\bourcrowd\b/i],
    known_signer_substrings: [],
  },
];

/**
 * Detect whether a Form D filing is platform-admin-filed.
 * @param {object} filing - Form D filing row (entityname, related_names, nameofsigner)
 * @returns {{is_platform: boolean, platform_name: string|null, signals: string[]}}
 */
function detectPlatform(filing) {
  if (!filing) return { is_platform: false, platform_name: null, signals: [] };
  const en = filing.entityname || '';
  const rn = filing.related_names || '';
  const sig = (filing.nameofsigner || '').toLowerCase();
  const signals = [];
  for (const p of PLATFORM_PATTERNS) {
    for (const re of (p.entityname || [])) {
      if (re.test(en)) signals.push(`entityname:${p.name}`);
    }
    for (const re of (p.related_names || [])) {
      if (re.test(rn)) signals.push(`related_names:${p.name}`);
    }
    for (const s of (p.known_signer_substrings || [])) {
      if (sig.includes(s)) signals.push(`signer:${p.name}`);
    }
  }
  if (signals.length === 0) {
    return { is_platform: false, platform_name: null, signals: [] };
  }
  const platforms = signals.map(s => s.split(':')[1]);
  const counts = {};
  platforms.forEach(p => { counts[p] = (counts[p] || 0) + 1; });
  const platform_name = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return { is_platform: true, platform_name, signals };
}

module.exports = {
  PLATFORM_PATTERNS,
  detectPlatform,
};
