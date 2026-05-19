/**
 * iapd_live.js — SEC IAPD live-search fallback.
 *
 * When the local advisers_enriched cache doesn't have a match, fall back to
 * the SEC's IAPD JSON API. Catches:
 *   - Firms registered AFTER our last advisers_enriched cron refresh
 *   - Edge cases where the local matcher's name normalization misses
 *
 * Usage:
 *   const { iapdLiveLookup } = require('./lib/iapd_live');
 *   const r = await iapdLiveLookup('Hash3 Capital Opportunity');
 *   // → { found: true, source: 'iapd_live', crd: '326205', adviser_name: 'HASH3 LLC', ... }
 *   //   or { found: false, query: '...', hits_count: 0 }
 *
 * Endpoint: https://api.adviserinfo.sec.gov/search/firm?query=X
 *   - No auth required, no documented rate limit (be polite — TTL cache below)
 *   - Returns { hits: { hits: [ { _source: { firm_source_id, firm_name, ... } } ], total: N } }
 *
 * Caching:
 *   - In-process Map with 24h TTL (server typically restarts well within a week)
 *   - Cache keys: lowercased trimmed query string
 *   - Both positive and negative results cached (don't repeatedly hit SEC for missing firms)
 *
 * Safety:
 *   - 5-second per-request timeout
 *   - Failures (network, parse, non-200) return { found: false, error: '...' } — never throw
 *   - Caller decides whether to act on { found: true } (e.g., still gate via passesStricterCrdGate)
 */

'use strict';

const IAPD_ENDPOINT = 'https://api.adviserinfo.sec.gov/search/firm';
const REQUEST_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-process cache. Map<lowercaseQuery, { result, expiresAt }>
const _cache = new Map();

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.result;
}

function cacheSet(key, result) {
  _cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Live IAPD lookup. Returns up to one best-match hit, in the same shape as
 * lib/adv_lookup.js#checkAdvDatabase returns.
 *
 * Best-match heuristic: prefer ACTIVE firms over INACTIVE; among ties, prefer
 * shorter adviser_name (more likely the canonical firm vs. a series-aware
 * derivative).
 *
 * @param {string} name - search query (typically the Form D series-master name or a variant)
 * @returns {Promise<{found, source, crd, adviser_name, registration_type?, iapd_status?, hits_count, error?}>}
 */
async function iapdLiveLookup(name) {
  const q = (name || '').trim();
  if (!q || q.length < 3) {
    return { found: false, error: 'query_too_short', query: q };
  }
  const cacheKey = q.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, _cached: true };

  let result;
  try {
    const url = `${IAPD_ENDPOINT}?query=${encodeURIComponent(q)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'PrivateFundsRadar/1.0 (mmmuller93@gmail.com)' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      result = { found: false, error: `iapd_http_${res.status}`, query: q };
    } else {
      const data = await res.json();
      const hits = data?.hits?.hits || [];
      const total = data?.hits?.total ?? hits.length;
      if (hits.length === 0) {
        result = { found: false, query: q, hits_count: 0 };
      } else {
        // Pick best hit: prefer ACTIVE status, then shorter name
        const ranked = hits.slice().sort((a, b) => {
          const aActive = (a?._source?.firm_ia_scope || '').toUpperCase() === 'ACTIVE';
          const bActive = (b?._source?.firm_ia_scope || '').toUpperCase() === 'ACTIVE';
          if (aActive !== bActive) return aActive ? -1 : 1;
          const aLen = (a?._source?.firm_name || '').length;
          const bLen = (b?._source?.firm_name || '').length;
          return aLen - bLen;
        });
        const best = ranked[0]._source;
        result = {
          found: true,
          source: 'iapd_live',
          crd: String(best.firm_source_id || ''),
          adviser_name: best.firm_name || null,
          registration_type: best.firm_ia_scope || null,
          iapd_status: best.firm_ia_scope || null,
          hits_count: total,
        };
      }
    }
  } catch (err) {
    result = {
      found: false,
      error: err?.name === 'AbortError' ? 'timeout' : `fetch_error:${err.message}`,
      query: q,
    };
  }

  cacheSet(cacheKey, result);
  return result;
}

/**
 * Variant-aware live lookup — tries each variant in order, returns first hit.
 * Caller pre-generates variants via lib/name_variants#generateVariants.
 */
async function iapdLiveLookupVariants(variants) {
  for (const v of variants || []) {
    const r = await iapdLiveLookup(v);
    if (r.found) return { ...r, matched_variant: v };
  }
  return { found: false, variants_tried: variants };
}

module.exports = {
  iapdLiveLookup,
  iapdLiveLookupVariants,
  // Test helper — flush cache (e.g., between unit tests)
  _flushCache: () => _cache.clear(),
};
