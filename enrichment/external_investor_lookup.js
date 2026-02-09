/**
 * EXTERNAL INVESTOR LOOKUP MODULE
 *
 * In-memory lookup against external_investor_reference table (OpenVC + Ramp).
 * Loaded once at startup, provides instant pre-enrichment lookups.
 *
 * Usage:
 *   const { ensureLoaded, lookupInvestor, getInvestorCount } = require('./external_investor_lookup');
 *   await ensureLoaded(formdClient);
 *   const match = lookupInvestor('Andreessen Horowitz');
 */

// In-memory store
let investorMap = null;  // Map<normalized_name, record>
let loadPromise = null;  // Singleton promise for lazy init

// ============================================================================
// NAME NORMALIZATION (must match external_db_loader.js)
// ============================================================================

const STRIP_SUFFIXES = /\b(llc|lp|ltd|inc|corp|corporation|company|co|group|holdings|management|advisors|advisers|advisory|consulting|consultants|associates|international|global|partners|fund|funds|capital|ventures|investments|investment|asset|assets|wealth|financial|securities|strategies|strategy|solutions|services|limited|partnership|pllc|plc|sa|ag|gmbh|bv|nv)\b/gi;
const STRIP_ROMAN = /\b(i{1,3}|iv|v|vi{0,3}|ix|x|xi{0,3})\b$/i;

function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(STRIP_SUFFIXES, ' ')
    .replace(STRIP_ROMAN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// LOADING
// ============================================================================

/**
 * Load all external investor records from Supabase using keyset pagination.
 * ~8k records, ~8MB memory footprint.
 */
async function loadFromSupabase(supabaseClient) {
  const map = new Map();
  let lastId = 0;
  const pageSize = 1000;
  let totalLoaded = 0;

  console.log('[ExternalDB] Loading external investor reference data...');

  while (true) {
    const { data, error } = await supabaseClient
      .from('external_investor_reference')
      .select('*')
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(pageSize);

    if (error) {
      // Table might not exist yet
      if (error.code === 'PGRST205' || error.message?.includes('Could not find')) {
        console.warn('[ExternalDB] Table external_investor_reference not found. Skipping load.');
        return map;
      }
      throw new Error(`Failed to load external investors: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    for (const record of data) {
      map.set(record.normalized_name, record);
      lastId = record.id;
    }

    totalLoaded += data.length;

    if (data.length < pageSize) break;
  }

  console.log(`[ExternalDB] Loaded ${totalLoaded} external investors into memory`);
  return map;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Ensure the external investor data is loaded. Safe to call multiple times.
 * Uses lazy init pattern — first call loads, subsequent calls return immediately.
 */
async function ensureLoaded(supabaseClient) {
  if (investorMap) return;

  if (!loadPromise) {
    loadPromise = loadFromSupabase(supabaseClient).then(map => {
      investorMap = map;
    }).catch(err => {
      console.error('[ExternalDB] Load failed:', err.message);
      investorMap = new Map(); // Empty map so we don't retry on failure
      loadPromise = null;
    });
  }

  await loadPromise;
}

/**
 * Look up an investor by name. Tries exact normalized match first,
 * then falls back to progressively stripped versions.
 *
 * @param {string} name - Raw investor name
 * @returns {object|null} - Matched record or null
 */
function lookupInvestor(name) {
  if (!investorMap || investorMap.size === 0) return null;
  if (!name) return null;

  const normalized = normalizeName(name);
  if (!normalized) return null;

  // Exact normalized match
  const exact = investorMap.get(normalized);
  if (exact) return exact;

  // Fallback: try stripping additional trailing words that the suffix regex might miss
  const words = normalized.split(' ');
  if (words.length > 1) {
    // Try dropping last word (e.g., "sequoia capital" -> "sequoia" won't match,
    // but "blackrock fund advisors" -> "blackrock" might)
    for (let dropCount = 1; dropCount <= Math.min(2, words.length - 1); dropCount++) {
      const shorter = words.slice(0, words.length - dropCount).join(' ');
      if (shorter.length >= 3) {
        const match = investorMap.get(shorter);
        if (match) return match;
      }
    }
  }

  return null;
}

/**
 * Get the number of loaded investors.
 */
function getInvestorCount() {
  return investorMap ? investorMap.size : 0;
}

/**
 * Get the full map (for debugging/testing)
 */
function getInvestorMap() {
  return investorMap;
}

/**
 * Force reload (for testing or manual refresh)
 */
async function reload(supabaseClient) {
  investorMap = null;
  loadPromise = null;
  await ensureLoaded(supabaseClient);
}

module.exports = {
  ensureLoaded,
  lookupInvestor,
  getInvestorCount,
  getInvestorMap,
  reload,
  normalizeName,
};
