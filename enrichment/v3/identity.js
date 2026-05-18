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

// Strategy-tail words that appear in fund series names but not adviser names.
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

/**
 * Strip legal suffixes and fund numbers from a name.
 */
function stripLegal(name) {
  return name
    .replace(LEGAL_SUFFIXES_RE, '')
    .replace(FUND_NUMBER_RE, '')
    .trim();
}

/**
 * Generate name variants from most-specific to least-specific.
 * Returns an array of strings to try against checkAdvDatabase.
 *
 * Example: "Hash3 Capital Opportunity, LP"
 *   1. "Hash3 Capital Opportunity"   (full stripped)
 *   2. "Hash3 Capital"               (strip strategy tail)
 *   3. "Hash3"                       (first token)
 */
function generateVariants(rawName) {
  if (!rawName) return [];

  const variants = new Set();

  // Variant 1: full name with legal suffix stripped
  const stripped = stripLegal(rawName);
  if (stripped) variants.add(stripped);

  // Also try extractBaseName (adv_lookup's own stripper — handles GP/Master etc.)
  const base = extractBaseName(rawName);
  if (base && base !== stripped) variants.add(base);

  // Variant 2: strip strategy tail words from the end
  for (const tail of STRATEGY_TAILS) {
    const re = new RegExp(`\\s+${tail}\\s*$`, 'i');
    const withoutTail = stripped.replace(re, '').trim();
    if (withoutTail && withoutTail !== stripped && withoutTail.length >= 3) {
      variants.add(withoutTail);
      const withoutTailBase = stripLegal(withoutTail);
      if (withoutTailBase && withoutTailBase !== withoutTail) {
        variants.add(withoutTailBase);
      }
    }
  }

  // Variant 3: first two meaningful tokens
  const tokens = stripped.split(/\s+/).filter(t => t.length >= 2);
  if (tokens.length >= 3) {
    variants.add(tokens.slice(0, 2).join(' '));
  }

  // Variant 4: first single distinctive token
  const GENERIC = new Set([
    'fund', 'funds', 'capital', 'ventures', 'venture', 'partners', 'partner',
    'management', 'advisors', 'advisers', 'group', 'holdings', 'the',
  ]);
  if (tokens.length >= 2 && !GENERIC.has(tokens[0].toLowerCase())) {
    variants.add(tokens[0]);
  }

  return Array.from(variants).filter(v => v.length >= 3);
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
  for (const variant of variants) {
    const hit = await checkAdvDatabase(advDb, variant, {
      relatedNames: opts.relatedNames || null,
      relatedRoles: opts.relatedRoles || null,
    });

    if (hit && hit.found) {
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
  };
}

module.exports = {
  resolveIdentity,
  generateVariants,
  stripLegal,
};
