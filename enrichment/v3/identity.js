/**
 * identity.js — Name normalization, variant generation, and SEC CRD resolution.
 *
 * Called first in the orchestrator. If we can resolve a manager to a CRD,
 * we get a verified website for free from SEC ADV and skip web search.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');
const { checkAdvDatabase, extractBaseName, NAME_STOPWORDS } = require('../../lib/adv_lookup');
const { ensureLoaded, lookupInvestor } = require('../external_investor_lookup');
const { generateVariants: generateVariantsShared, stripLegal: stripLegalShared, STRATEGY_TAILS: STRATEGY_TAILS_SHARED }
  = require('../../lib/name_variants');

/**
 * Stricter SEC-CRD-match gate (added 2026-05-18 after Hash3/TMS-Angels post-cleanup audit).
 *
 * Background: `lib/adv_lookup.js` accepts a CRD match as long as every distinctive
 * manager-name token appears as a full token in the adviser_name. That's safe when
 * the manager has 2+ distinctive tokens or one long one (Hash3 → "hash3"). It is
 * DANGEROUS when the manager name is short/acronym-only ("TMS Angels" → "TMS Capital
 * Management" — both contain "TMS" and nothing else; different firms).
 *
 * This gate adds a second-pass check before v3 accepts a CRD:
 *   - shared distinctive tokens ≥ 2                       → PASS
 *   - shared = 1 AND token length ≥ 5 (long distinctive)  → PASS
 *   - shared = 1 AND token length ≤ 4 (acronym/short):
 *       - has non-platform Form D related_persons          → PASS as candidate (downgrade)
 *       - otherwise                                        → REJECT
 *   - shared = 0                                          → REJECT (defensive)
 *
 * Returns { pass: boolean, downgrade?: boolean, reason: string, shared: string[] }.
 */
const PLATFORM_ADMIN_RE = /\b(angellist|sydecar|carta|allocations|belltower|forge|assure|fund\s+gp|cgf2021)\b/i;
const ROMAN_RE = /^[ivx]+$/i;

function distinctiveTokens(s) {
  if (!s) return new Set();
  const toks = String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (const raw of toks) {
    if (raw.length < 3) continue;
    if (NAME_STOPWORDS.has(raw)) continue;
    if (ROMAN_RE.test(raw)) continue;
    // Stem trailing 's' for plurals — but only for words ≥6 chars. Words of
    // length 4-5 that happen to end in 's' (locus, atlas, lotus, focus, axis,
    // basis) are usually singular nouns, not plurals. Over-stemming them
    // collapses real distinctive words into shorter acronym-like forms,
    // pushing the gate to reject legitimate matches like
    // "Locus Ventures II" vs "LOCUS CAPITAL". lib/adv_lookup uses a more
    // permissive ≥4 threshold; we tighten here because this is the
    // identity-correctness gate.
    const stem = (raw.length >= 6 && raw.endsWith('s')) ? raw.slice(0, -1) : raw;
    out.add(stem);
  }
  return out;
}

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

// ADV database client
const ADV_URL = process.env.ADV_URL || 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = process.env.ADV_SERVICE_KEY;
if (!ADV_KEY) throw new Error('Missing required env var: ADV_SERVICE_KEY');

const advDb = createClient(ADV_URL, ADV_KEY);

// Form D client (needed to load external investor reference)
const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY;
if (!FORMD_KEY) throw new Error('Missing required env var: FORMD_SERVICE_KEY');

const formdDb = createClient(FORMD_URL, FORMD_KEY);

// Variant generation lives in lib/name_variants.js (shared with server.js).
// Re-export wrappers preserve the local API + add the adv_lookup extractBaseName
// stripper that v3 historically applied as a second pass.
const STRATEGY_TAILS = STRATEGY_TAILS_SHARED;
const stripLegal = stripLegalShared;
function generateVariants(rawName) {
  return generateVariantsShared(rawName, { extraStripper: extractBaseName });
}

/**
 * Look up a manager's SEC CRD by trying name variants against checkAdvDatabase.
 * If found, also fetch primary_website from advisers_enriched.
 *
 * @param {string} rawName - The raw series_master_llc name from Form D
 * @param {object} opts
 * @param {string} [opts.relatedNames] - Pipe-separated Form D related persons
 * @param {string} [opts.relatedRoles] - Pipe-separated roles
 * @returns {Promise<object>} identity result
 */
async function resolveIdentity(rawName, opts = {}) {
  const variants = generateVariants(rawName);

  // Try each variant against SEC ADV
  let gateRejections = [];  // track rejected CRDs for debugging/audit
  for (const variant of variants) {
    const hit = await checkAdvDatabase(advDb, variant, {
      relatedNames: opts.relatedNames || null,
      relatedRoles: opts.relatedRoles || null,
    });

    if (hit && hit.found) {
      // STRICTER GATE (added 2026-05-18): block acronym-only false-positive matches
      // before they poison downstream evidence. See passesStricterCrdGate() docstring.
      const gate = passesStricterCrdGate(hit, rawName, {
        matchedVariant: variant,
        relatedNames: opts.relatedNames,
      });
      if (!gate.pass) {
        gateRejections.push({ crd: hit.crd, variant, adviser_name: hit.adviser_name, ...gate });
        // Don't return this hit — continue trying other variants. If all fail the gate,
        // we fall through to external DB / web search.
        continue;
      }
      // Fetch primary_website from advisers_enriched
      let primaryWebsite = null;
      try {
        const { data: advRow } = await advDb
          .from('advisers_enriched')
          .select('primary_website, other_websites')
          .eq('crd', hit.crd)
          .single();

        if (advRow) {
          // Skip noisy primary_website values (social media, app stores, etc.)
          const NOISY_HOSTS = ['instagram', 'facebook', 'twitter', 'linkedin', 'youtube', 'plynk', 'apple.com', 'play.google'];
          const pw = advRow.primary_website;
          if (pw && !NOISY_HOSTS.some(h => pw.toLowerCase().includes(h))) {
            primaryWebsite = pw;
          }
        }
      } catch (_) {
        // Not critical — identity is still resolved without website
      }

      return {
        resolved: true,
        crd: String(hit.crd),
        adviser_name: hit.adviser_name,
        registration_type: hit.registration_type,
        primary_website: primaryWebsite,
        anchor: 'sec_adv_crd',
        matched_variant: variant,
        matched_source: hit.source,
        variants_tried: variants.slice(0, variants.indexOf(variant) + 1),
      };
    }
  }

  // Try external investor DB (OpenVC / Ramp)
  try {
    await ensureLoaded(formdDb);
    for (const variant of variants) {
      const ext = lookupInvestor(variant);
      if (ext) {
        return {
          resolved: true,
          crd: null,
          adviser_name: ext.investor_name,
          registration_type: null,
          primary_website: ext.website_url || null,
          anchor: 'external_db',
          external_db_source: ext.source,
          matched_variant: variant,
          variants_tried: variants,
        };
      }
    }
  } catch (err) {
    console.error('[identity] External DB lookup failed:', err.message);
  }

  return {
    resolved: false,
    crd: null,
    adviser_name: null,
    primary_website: null,
    anchor: null,
    variants_tried: variants,
    input_name: rawName,
    // If a CRD was found but rejected by the stricter gate, expose for debugging.
    // v3 still treats this as resolved=false (falls through to web search).
    crd_gate_rejections: gateRejections.length ? gateRejections : undefined,
  };
}

module.exports = {
  resolveIdentity,
  generateVariants,
  stripLegal,
  passesStricterCrdGate,
};
