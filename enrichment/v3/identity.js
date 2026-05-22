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
const { checkAdvDatabase, extractBaseName } = require('../../lib/adv_lookup');
const { ensureLoaded, lookupInvestor } = require('../external_investor_lookup');
const { generateVariants: generateVariantsShared, stripLegal: stripLegalShared, STRATEGY_TAILS: STRATEGY_TAILS_SHARED }
  = require('../../lib/name_variants');
// passesStricterCrdGate was originally defined inline here; moved to lib/name_matcher.js
// so server.js findAdviserMatch and lib/adv_lookup.js#searchAdvByName can use the same
// gate without circular dependencies (2026-05-19).
const { passesStricterCrdGate } = require('../../lib/name_matcher');

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

  // IAPD live fallback (added 2026-05-22).
  // The local advisers_enriched cache misses firms registered AFTER our cron
  // refresh — e.g., "201 Ventures Management LLC" (CRD 341854, ACTIVE in IAPD,
  // not yet in our cache). The IAPD JSON API is unauth'd and indexes every
  // SEC-registered + state-registered adviser. We try each variant against it
  // and apply the same stricter CRD gate to reject acronym FPs.
  //
  // Opt-in via opts.iapdFallback OR env var ENRICHMENT_IAPD_FALLBACK=true.
  // Off by default in unit tests; on for the v3 enrichment workflow.
  const iapdEnabled = opts.iapdFallback === true || process.env.ENRICHMENT_IAPD_FALLBACK === 'true';
  if (iapdEnabled) {
    try {
      const { iapdLiveLookupVariants } = require('../../lib/iapd_live');
      const iapdRes = await iapdLiveLookupVariants(variants);
      if (iapdRes && iapdRes.found) {
        const gate = passesStricterCrdGate(iapdRes, rawName, {
          matchedVariant: iapdRes.matched_variant,
          relatedNames: opts.relatedNames,
        });
        if (gate.pass) {
          console.log(`[identity] IAPD live hit: ${iapdRes.adviser_name} (CRD ${iapdRes.crd}) via variant "${iapdRes.matched_variant}"`);
          return {
            resolved: true,
            crd: String(iapdRes.crd),
            adviser_name: iapdRes.adviser_name,
            registration_type: iapdRes.registration_type || null,
            primary_website: null,  // IAPD response doesn't include primary_website
            anchor: 'iapd_live',
            matched_variant: iapdRes.matched_variant,
            matched_source: 'iapd_live',
            variants_tried: variants,
          };
        } else {
          gateRejections.push({ crd: iapdRes.crd, variant: iapdRes.matched_variant, adviser_name: iapdRes.adviser_name, source: 'iapd_live', ...gate });
        }
      }
    } catch (err) {
      console.error('[identity] IAPD fallback error:', err.message);
    }
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
