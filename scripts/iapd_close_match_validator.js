#!/usr/bin/env node
/**
 * IAPD close-match validator.
 *
 * For each (manager_name, matched_adviser_name, matched_crd) on production,
 * query IAPD's search API directly, score each IAPD candidate against the
 * manager_name with a combined token-overlap + Jaro-Winkler similarity, and
 * verify the matched CRD is the top close-match.
 *
 * Catches:
 *   - WRONG_MATCH                          matched CRD has lower closeness than top IAPD candidate
 *   - AMBIGUOUS_CLOSE_COMPETITOR           two candidates within 5% of each other
 *   - MATCHED_CRD_NOT_IN_IAPD_TOP12        matched CRD doesn't appear in IAPD search
 *   - VERIFIED                             matched CRD is the top close-match
 *   - POSSIBLE_MISSED_REGISTRATION         no match on production but IAPD finds a strong candidate
 *
 * Run:  node scripts/iapd_close_match_validator.js [limit]
 * Uses public JSON endpoint at api.adviserinfo.sec.gov — no playwright needed.
 * Rate-limited at 1 req/sec to be polite.
 */

const fs = require('node:fs');

const PROD_URL = process.env.PFR_URL || 'https://www.privatefundradar.com';
const N_LIMIT = parseInt(process.argv[2] || '32', 10);
const DELAY_MS = 1000;

const NAME_STOPWORDS = new Set([
  'the','of','and','co','llc','lp','llp','ltd','inc','corp','corporation','company',
  'fund','funds','capital','ventures','venture','partners','partner','holdings','group',
  'management','mgmt','advisors','advisers','gp','master','feeder','series','spv','spvs',
  'first','new','global','international','holding',
]);

function tokenize(s, minLength = 2) {
  const toks = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
  const stem = (t) => (t.length >= 4 && t.endsWith('s') ? t.slice(0, -1) : t);
  return new Set(toks.filter(t => t.length >= minLength).map(stem));
}

function jaroWinkler(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aLow = a.toLowerCase(), bLow = b.toLowerCase();
  const aLen = aLow.length, bLen = bLow.length;
  const matchDistance = Math.max(Math.floor(Math.max(aLen, bLen) / 2) - 1, 0);
  const aMatches = new Array(aLen).fill(false);
  const bMatches = new Array(bLen).fill(false);
  let matches = 0;
  for (let i = 0; i < aLen; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, bLen);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (aLow[i] !== bLow[j]) continue;
      aMatches[i] = bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0, k = 0;
  for (let i = 0; i < aLen; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (aLow[i] !== bLow[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / aLen + m / bLen + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(aLen, bLen));
  for (let i = 0; i < maxPrefix; i++) {
    if (aLow[i] === bLow[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function similarityScore(a, b) {
  const A = tokenize(a), B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0, sharedDistinctive = 0;
  for (const t of A) if (B.has(t)) {
    shared++;
    if (!NAME_STOPWORDS.has(t)) sharedDistinctive++;
  }
  const tokenOverlap = shared / Math.min(A.size, B.size);
  const distSize = Math.min(
    [...A].filter(t => !NAME_STOPWORDS.has(t)).length,
    [...B].filter(t => !NAME_STOPWORDS.has(t)).length,
  );
  const distinctiveOverlap = distSize === 0 ? 0 : sharedDistinctive / distSize;
  const lengthRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const jw = jaroWinkler(a, b);
  // Heavy weight on distinctive overlap; secondary on token overlap; light on JW+length
  return 0.5 * distinctiveOverlap + 0.2 * tokenOverlap + 0.2 * jw + 0.1 * lengthRatio;
}

async function iapdSearch(query) {
  const qs = encodeURIComponent(query);
  const url = `https://api.adviserinfo.sec.gov/search/firm?query=${qs}&hl=true&nrows=12&start=0&r=25&type=Firm&investmentAdvisorFullText=Y`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PFR-validation/1.0 (compliance research)' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, hits: [] };
    const data = await res.json();
    // IAPD JSON: CRD is in `firm_source_id`. Also expose `firm_other_names`
    // (array of legal-name variants) — these often contain the GP/LLC variant
    // that's the actual closest match to our Form D manager name.
    const hits = (data?.hits?.hits || []).map(h => {
      const src = h._source || {};
      return {
        crd: src.firm_source_id ? String(src.firm_source_id) : null,
        name: src.firm_name || '',
        other_names: Array.isArray(src.firm_other_names) ? src.firm_other_names : [],
        active: src.firm_ia_scope === 'ACTIVE',
      };
    }).filter(h => h.name);
    return { hits };
  } catch (e) {
    return { error: e.message, hits: [] };
  }
}

async function fetchProduction() {
  const res = await fetch(`${PROD_URL}/api/funds/new-managers?startDate=2026-01-01&endDate=2026-05-11`);
  const data = await res.json();
  return data.managers || [];
}

function classify({ managerName, matchedName, matchedCrd, iapdHits }) {
  if (iapdHits.length === 0) {
    return { verdict: 'NOT_IN_IAPD_AT_ALL' };
  }
  // Score each IAPD hit using its BEST name variant (firm_name OR any other_name).
  // E.g., a firm's primary `firm_name` may be "FIRST BIGHT VENTURES" but legal_name
  // (in `firm_other_names`) is "FIRST BIGHT MANAGEMENT, LLC" — score against both.
  const scored = iapdHits.map(h => {
    const allNames = [h.name, ...(h.other_names || [])].filter(Boolean);
    const bestScore = Math.max(...allNames.map(n => similarityScore(managerName, n)));
    return { ...h, score: bestScore };
  }).sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  const matchedScore = matchedName ? similarityScore(managerName, matchedName) : 0;
  const matchedHit = matchedCrd ? scored.find(h => String(h.crd) === String(matchedCrd)) : null;

  if (matchedCrd && !matchedHit) {
    return { verdict: 'MATCHED_CRD_NOT_IN_IAPD_TOP12', topCandidate: top, matchedScore };
  }

  if (matchedCrd && matchedHit) {
    if (matchedHit.crd === top.crd) {
      if (top.score < 0.4) return { verdict: 'WEAK_TOP_MATCH', topCandidate: top, matchedScore };
      if (second && (top.score - second.score) < 0.05) {
        return { verdict: 'AMBIGUOUS_CLOSE_COMPETITOR', topCandidate: top, runnerUp: second, matchedScore };
      }
      return { verdict: 'VERIFIED', topCandidate: top, matchedScore };
    }
    return { verdict: 'WRONG_MATCH', topCandidate: top, matchedCandidate: matchedHit, matchedScore };
  }

  if (!matchedCrd && top.score >= 0.5) {
    return { verdict: 'POSSIBLE_MISSED_REGISTRATION', topCandidate: top };
  }
  return { verdict: 'TRULY_UNREGISTERED', topCandidate: top || null };
}

async function main() {
  const mgrs = await fetchProduction();
  console.log(`[prod] ${mgrs.length} managers in response`);
  const withAdv = mgrs.filter(m => m.has_form_adv).slice(0, N_LIMIT);
  const withoutAdv = mgrs.filter(m => !m.has_form_adv);

  // Random sample for missed-registration check
  const sample = [];
  for (let i = 0; i < Math.min(15, withoutAdv.length); i++) {
    const idx = Math.floor((i * 37) % withoutAdv.length);
    if (!sample.find(s => s === withoutAdv[idx])) sample.push(withoutAdv[idx]);
  }

  const all = [
    ...withAdv.map(m => ({ ...m, _bucket: 'with_adv' })),
    ...sample.map(m => ({ ...m, _bucket: 'no_adv_sample' })),
  ];
  console.log(`Validating ${withAdv.length} with-ADV + ${sample.length} no-ADV sample...`);
  console.log('-'.repeat(140));

  const results = [];
  let i = 0;
  for (const m of all) {
    i++;
    const adv = m.adv_data || {};
    const r = await iapdSearch(m.series_master_llc);
    const v = classify({
      managerName: m.series_master_llc,
      matchedName: adv.name || null,
      matchedCrd: adv.crd || null,
      iapdHits: r.hits,
    });
    const mark = { VERIFIED: '✓', AMBIGUOUS_CLOSE_COMPETITOR: '⚠', WRONG_MATCH: '✗',
      MATCHED_CRD_NOT_IN_IAPD_TOP12: '✗', POSSIBLE_MISSED_REGISTRATION: '!',
      TRULY_UNREGISTERED: '·', WEAK_TOP_MATCH: '?', NOT_IN_IAPD_AT_ALL: '·'
    }[v.verdict] || '?';
    const prodSummary = adv.crd ? `CRD ${adv.crd} ${(adv.name || '').slice(0, 28)}` : 'no_adv';
    const topSummary = v.topCandidate ? `top: ${(v.topCandidate.name || '').slice(0, 30)} (${v.topCandidate.score?.toFixed(2)})` : '';
    const runner = v.runnerUp ? ` | 2nd: ${v.runnerUp.name.slice(0, 22)} (${v.runnerUp.score?.toFixed(2)})` : '';
    const wrongMatched = v.matchedCandidate ? ` | matched: ${v.matchedCandidate.name.slice(0, 22)} (${v.matchedCandidate.score?.toFixed(2)})` : '';
    console.log(`  ${mark} [${String(i).padStart(2)}] ${m.series_master_llc.slice(0, 34).padEnd(34)} | ${m._bucket.padEnd(15)} | prod: ${prodSummary.padEnd(38)} | ${v.verdict.padEnd(30)} | ${topSummary}${runner}${wrongMatched}`);
    results.push({ manager: m.series_master_llc, bucket: m._bucket, prod_crd: adv.crd, prod_name: adv.name, ...v });
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  const buckets = {};
  for (const r of results) buckets[r.verdict] = (buckets[r.verdict] || 0) + 1;
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(38)} ${v}`);
  }
  fs.writeFileSync('/tmp/pfr-build/iapd_close_match_results.json', JSON.stringify({ results, buckets }, null, 2));
  console.log(`\nFull results: /tmp/pfr-build/iapd_close_match_results.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
