/**
 * web_search.js — Brave → Google → Serper search chain.
 *
 * Reuses the search adapters and URL-filtering logic from enrichment_engine_v2.js.
 * Returns Evidence[] for website candidates and LinkedIn candidates.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY || null;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const GOOGLE_CX = process.env.GOOGLE_CX || null;
const SERPER_API_KEY = process.env.SERPER_API_KEY || null;

let serperFailures = 0;
const SERPER_MAX_FAILURES = 3;

const BLOCKED_DOMAINS = [
  'crunchbase.com', 'pitchbook.com', 'bloomberg.com', 'tracxn.com',
  'cbinsights.com', 'signal.nfx.com', 'dealroom.co', 'harmonic.ai',
  'inc42.com', 'f6s.com', 'fundz.net', 'venture-radar.com',
  'contactout.com', 'rocketreach.co', 'zoominfo.com', 'apollo.io',
  'lusha.com', 'signalhire.com', 'hunter.io',
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'tiktok.com', 'reddit.com',
  'medium.com', 'substack.com', 'wordpress.com', 'blogger.com',
  'formds.com', 'sec.gov', 'aum13f.com', 'whalewisdom.com',
  'venture.angellist.com', 'republic.com', 'wefunder.com', 'seedinvest.com',
  'techcrunch.com', 'forbes.com', 'wsj.com', 'businessinsider.com',
  'prnewswire.com', 'businesswire.com', 'venturebeat.com',
  'bestpitchdeck.com', 'alts.co', 'wikipedia.org',
];

const ARTICLE_PATH_PATTERNS = [
  '/news/', '/article/', '/articles/', '/blog/', '/posts/', '/post/',
  '/press/', '/press-release', '/insights/', '/stories/',
  '/2020/', '/2021/', '/2022/', '/2023/', '/2024/', '/2025/', '/2026/',
  '/pulse/',
];

const ARTICLE_HOST_PREFIXES = ['news.', 'blog.', 'press.', 'insights.'];

function isBlocked(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return BLOCKED_DOMAINS.some(d => lower.includes(d));
}

function isArticle(url) {
  const lower = url.toLowerCase();
  if (ARTICLE_PATH_PATTERNS.some(p => lower.includes(p))) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (ARTICLE_HOST_PREFIXES.some(p => host.startsWith(p))) return true;
  } catch (_) { /* ignore */ }
  return false;
}

function isFile(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  const FILE_EXTS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.zip', '.png', '.jpg', '.jpeg', '.gif'];
  return FILE_EXTS.some(ext => lower.endsWith(ext));
}

function isValidHomepage(url) {
  if (!url) return false;
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p === '/' || p === '' || p.length < 20) return true;
    const VALID = ['/about', '/team', '/contact', '/portfolio', '/investments', '/home',
      '/our-firm', '/our-team', '/people', '/leadership', '/partners', '/ventures'];
    if (VALID.some(v => p.startsWith(v))) return true;
    if (p.split('/').filter(Boolean).length === 1) return true;
  } catch (_) { /* ignore */ }
  return false;
}

async function braveSearch(query, retryCount = 0) {
  if (!BRAVE_API_KEY) return null;
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
    });
    // Brave free tier rate-limits ~1 req/sec. The orchestrator's Promise.all
    // fires website+linkedin searches in parallel; second call commonly 429s.
    // v2 retried with backoff; v3 had dropped this. Codex hardening rec.
    if (res.status === 429 && retryCount < 2) {
      await new Promise(r => setTimeout(r, 5000));
      return braveSearch(query, retryCount + 1);
    }
    if (!res.ok) return null;
    return res.json();
  } catch (_) { return null; }
}

async function googleSearch(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return null;
  try {
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return { web: { results: (data.items || []).map(r => ({ title: r.title, url: r.link, description: r.snippet })) } };
  } catch (_) { return null; }
}

async function serperSearch(query) {
  if (!SERPER_API_KEY || serperFailures >= SERPER_MAX_FAILURES) return null;
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 10 }),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      serperFailures++;
      return null;
    }
    if (!res.ok) return null;
    serperFailures = 0;
    const data = await res.json();
    return { web: { results: (data.organic || []).map(r => ({ title: r.title, url: r.link, description: r.snippet })) } };
  } catch (_) { return null; }
}

// DuckDuckGo HTML — free, no API key, no quota. Last-resort fallback so the
// engine still finds results when Brave/Google/Serper are exhausted or
// rate-limited. Caveat: it is HTML scraping, so it rate-limits under heavy bulk
// (a full nightly drain) — reliable for moderate volume, a stopgap not a
// replacement for a paid provider.
async function ddgSearch(query) {
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const strip = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim();
    const out = []; const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m;
    while ((m = re.exec(html))) {
      const tm = m[1].match(/uddg=([^&]+)/); const url = tm ? decodeURIComponent(tm[1]) : m[1];
      out.push({ title: strip(m[2]), url, description: '' });
    }
    const sr = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g; const sn = []; let s;
    while ((s = sr.exec(html))) sn.push(strip(s[1]));
    out.forEach((x, i) => { x.description = sn[i] || ''; });
    return { web: { results: out } };
  } catch (_) { return null; }
}

/**
 * Unified search with Brave → Google → Serper → DuckDuckGo fallback chain.
 */
async function search(query) {
  if (BRAVE_API_KEY) {
    const r = await braveSearch(query);
    if (r?.web?.results?.length > 0) return r;
  }
  if (GOOGLE_API_KEY && GOOGLE_CX) {
    const r = await googleSearch(query);
    if (r?.web?.results?.length > 0) return r;
  }
  if (SERPER_API_KEY && serperFailures < SERPER_MAX_FAILURES) {
    const r = await serperSearch(query);
    if (r?.web?.results?.length > 0) return r;
  }
  // Free, keyless last resort — keeps the engine producing when the paid
  // providers are exhausted (e.g. after a big nightly drain burns the quotas).
  {
    const r = await ddgSearch(query);
    if (r?.web?.results?.length > 0) return r;
  }
  return null;
}

/**
 * Extract website candidates from search results.
 * Uses three-pass: domain match → title match → distinctive-token fallback.
 */
function extractWebsiteCandidates(results, managerName, capturedAt) {
  if (!results?.web?.results) return [];

  const items = results.web.results;
  const nameLower = managerName.toLowerCase().replace(/,?\s*(lp|llc|l\.p\.|l\.l\.c\.|ltd|limited|inc)\s*$/i, '').trim();
  const fundWords = nameLower.split(' ').filter(w => w.length > 3);

  const GENERIC = new Set([
    'capital', 'ventures', 'venture', 'partners', 'partner', 'fund', 'funds',
    'management', 'mgmt', 'advisors', 'advisers', 'group', 'holdings', 'invest',
    'investment', 'investments', 'private', 'equity', 'asset', 'global',
  ]);
  const distinctiveTokens = fundWords.filter(w => !GENERIC.has(w.toLowerCase()) && w.length >= 4);

  const candidates = [];

  // Pass 1: domain contains a fund word
  for (const item of items.slice(0, 5)) {
    const url = item.url;
    if (!url || isBlocked(url) || isFile(url) || isArticle(url) || !isValidHomepage(url)) continue;
    try {
      const domain = new URL(url).hostname.replace('www.', '').toLowerCase();
      const matched = fundWords.find(w => domain.includes(w));
      if (matched) {
        candidates.push({
          type: 'website_url',
          value: url,
          source: 'web_search:domain_match',
          match_reason: `domain contains "${matched}"`,
          anchor: null,
          strength: 'medium',
          captured_at: capturedAt,
          search_title: item.title,
        });
      }
    } catch (_) { /* invalid URL */ }
  }

  // Pass 2: title contains first fund word
  if (candidates.length === 0) {
    const firstWord = nameLower.split(' ')[0];
    for (const item of items.slice(0, 8)) {
      const url = item.url;
      if (!url || isBlocked(url) || isFile(url) || isArticle(url) || !isValidHomepage(url)) continue;
      if ((item.title || '').toLowerCase().includes(firstWord)) {
        candidates.push({
          type: 'website_url',
          value: url,
          source: 'web_search:title_match',
          match_reason: `title contains "${firstWord}"`,
          anchor: null,
          strength: 'weak',
          captured_at: capturedAt,
          search_title: item.title,
        });
      }
    }
  }

  // Pass 3: distinctive-token domain match (last resort)
  if (candidates.length === 0 && distinctiveTokens.length > 0) {
    for (const item of items.slice(0, 3)) {
      const url = item.url;
      if (!url || isBlocked(url) || isFile(url) || isArticle(url) || !isValidHomepage(url)) continue;
      try {
        const domain = new URL(url).hostname.replace('www.', '').toLowerCase();
        const matched = distinctiveTokens.find(w => domain.includes(w.toLowerCase()));
        if (matched) {
          candidates.push({
            type: 'website_url',
            value: url,
            source: 'web_search:distinctive_token',
            match_reason: `domain distinctive token "${matched}"`,
            anchor: null,
            strength: 'weak',
            captured_at: capturedAt,
            search_title: item.title,
          });
        }
      } catch (_) { /* ignore */ }
    }
  }

  return candidates;
}

/**
 * Extract LinkedIn company candidates from search results.
 */
function extractLinkedInCandidates(results, capturedAt) {
  if (!results?.web?.results) return [];
  const candidates = [];
  for (const item of results.web.results) {
    const url = item.url || '';
    if (url.includes('linkedin.com/company/')) {
      candidates.push({
        type: 'linkedin_company_url',
        value: url.split('?')[0],
        source: 'web_search:linkedin',
        anchor: null,
        strength: 'weak',
        captured_at: capturedAt,
        search_title: item.title,
      });
    }
  }
  return candidates;
}

/**
 * Find website candidates via web search.
 *
 * @param {object} identity - Result from resolveIdentity()
 * @returns {Promise<Evidence[]>}
 */
async function findWebsiteCandidates(identity) {
  const capturedAt = new Date().toISOString();
  const name = identity.adviser_name
    || identity.matched_variant
    || (Array.isArray(identity.variants_tried) && identity.variants_tried[0])
    || identity.input_name
    || '';
  if (!name) return [];

  const queries = [
    name,
    `"${name}" venture capital`,
    `${name} fund manager`,
  ];

  for (const query of queries) {
    const results = await search(query);
    if (!results?.web?.results?.length) continue;

    const candidates = extractWebsiteCandidates(results, name, capturedAt);
    if (candidates.length > 0) return candidates;
  }

  return [];
}

/**
 * Find LinkedIn company page candidates via web search.
 *
 * @param {object} identity - Result from resolveIdentity()
 * @returns {Promise<Evidence[]>}
 */
async function findLinkedInCandidates(identity) {
  const capturedAt = new Date().toISOString();
  const name = identity.adviser_name
    || identity.matched_variant
    || (Array.isArray(identity.variants_tried) && identity.variants_tried[0])
    || identity.input_name
    || '';
  if (!name) return [];

  const query = `site:linkedin.com/company "${name}"`;
  const results = await search(query);
  return extractLinkedInCandidates(results, capturedAt);
}

module.exports = { findWebsiteCandidates, findLinkedInCandidates, search };
