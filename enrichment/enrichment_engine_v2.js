/**
 * FUND MANAGER ENRICHMENT ENGINE v2.0
 * 
 * Improvements over v1:
 * - AI-powered validation to minimize false positives
 * - Email extraction from websites
 * - Twitter/X handle discovery
 * - Enhanced team extraction from website /team pages
 * - Retry mechanism with multiple search strategies
 * - Real-time enrichment trigger
 * - Comprehensive logging
 * 
 * Target: Key decision makers (founders, partners, managing directors)
 * for service providers (compliance, legal, accounting, fund admin)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { ensureLoaded, lookupInvestor } = require('./external_investor_lookup');

// ============================================================================
// CONFIGURATION
// ============================================================================

const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || null;
const SERPER_API_KEY = process.env.SERPER_API_KEY || null;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const GOOGLE_CX = process.env.GOOGLE_CX || null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

// Form D database
const FORMD_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

// Form ADV database
const ADV_URL = 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = process.env.ADV_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

// Thresholds
const CONFIDENCE_THRESHOLD = 0.7;
const MAX_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 2000;

// Initialize clients
const formdClient = createClient(FORMD_URL, FORMD_KEY);
const advClient = createClient(ADV_URL, ADV_KEY);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ============================================================================
// BLOCKED DOMAINS - Never use as manager website
// ============================================================================

const BLOCKED_DOMAINS = [
  // Data aggregators (VC/Fund databases)
  'crunchbase.com', 'pitchbook.com', 'bloomberg.com', 'tracxn.com',
  'cbinsights.com', 'signal.nfx.com', 'dealroom.co', 'harmonic.ai',
  'inc42.com', 'icoanalytics.org', 'ynos.in', 'f6s.com', 'fundz.net',
  'venture-radar.com', 'startupranking.com',
  // Contact/data scraping sites
  'contactout.com', 'rocketreach.co', 'zoominfo.com', 'apollo.io',
  'lusha.com', 'signalhire.com', 'hunter.io',
  // Social media (extract separately)
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'tiktok.com', 'reddit.com',
  // Content platforms
  'medium.com', 'substack.com', 'wordpress.com', 'blogger.com',
  // Form D aggregators
  'formds.com', 'sec.gov', 'aum13f.com', 'whalewisdom.com', 'edgar-online.com',
  // Crowdfunding/syndicate platforms
  'venture.angellist.com', 'republic.com', 'wefunder.com', 'seedinvest.com',
  // News/press
  'techcrunch.com', 'forbes.com', 'wsj.com', 'businessinsider.com',
  'prnewswire.com', 'businesswire.com', 'venturebeat.com', 'eu-startups.com',
  'streetinsider.com', 'seekingalpha.com', 'marketwatch.com', 'yahoo.com/finance',
  // Pitch deck / analysis sites
  'bestpitchdeck.com', 'pitchenvy.com', 'slidebean.com',
  // Investor list/directory sites
  'alts.co', 'caphall.com', 'dannyleshem.com',
  // Other
  'wikipedia.org', 'ycombinator.com/companies'
];

const ADMIN_UMBRELLAS = [
  // SPV/Syndicate platforms
  'roll up vehicles', 'angellist funds', 'angellist-gp-funds', 'angellist stack',
  'multimodal ventures', 'mv funds', 'cgf2021 llc', 'sydecar',
  'assure spv', 'carta spv', 'allocations.com', 'allocations spv',
  // Fund admin platforms
  'forge', 'forge global', 'finally fund admin', 'finally admin',
  'juniper square', 'carta fund admin', 'anduin', 'decile', 'decile fund',
  // Other SPV umbrellas
  'stonks spv', 'flow spv', 'republic spv', 'wefunder spv'
];

// Platform staff names to filter out from related persons
// These are standard names that appear on many umbrella platform filings
const PLATFORM_STANDARD_NAMES = [
  // AngelList
  'belltower', 'fund gp', 'angellist', 'avlok kohli',
  // Sydecar
  'brett sagan', 'sydecar', 'nik talreja',
  // Assure
  'assure', 'jeremy johnson',
  // Carta
  'carta', 'carta fund admin',
  // Finally
  'finally', 'finally fund admin',
  // Decile
  'decile', 'long pham', 'adeo ressi',
  // Forge
  'forge', 'forge global',
  // Allocations
  'allocations', 'kingsley advani'
];

/**
 * Check if a person name matches known platform staff
 */
function isPlatformStaffName(name) {
  if (!name) return false;
  const nameLower = name.toLowerCase();
  return PLATFORM_STANDARD_NAMES.some(pn => nameLower.includes(pn));
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isBlockedDomain(url) {
  if (!url) return true;
  const lowerUrl = url.toLowerCase();
  return BLOCKED_DOMAINS.some(domain => lowerUrl.includes(domain));
}

function isAdminUmbrella(name) {
  if (!name) return false;
  const lowerName = name.toLowerCase();
  return ADMIN_UMBRELLAS.some(umbrella => lowerName.includes(umbrella));
}

function parseFundName(name) {
  if (!name) return '';
  let parsed = name;

  // Remove common suffixes
  parsed = parsed.replace(/,?\s*(LP|LLC|L\.P\.|L\.L\.C\.|Ltd|Limited|Inc|Incorporated)$/i, '');

  // Remove fund numbers
  parsed = parsed.replace(/\s+(Fund\s+)?[IVX]+$/i, '');
  parsed = parsed.replace(/\s+Fund\s+\d+$/i, '');

  return parsed.trim();
}

/**
 * Extract the ACTUAL fund name from umbrella series patterns
 * E.g., "ROADSTER CAPITAL, A SERIES OF DECILE START FUND, LP" → "ROADSTER CAPITAL"
 * This is used BEFORE the umbrella check to avoid skipping real funds
 */
function extractActualFundName(fullName) {
  if (!fullName) return fullName;

  // Pattern: "FUND NAME, A SERIES OF UMBRELLA LLC"
  const seriesMatch = fullName.match(/^(.+?),?\s+a\s+series\s+of\s+/i);
  if (seriesMatch) {
    const actualName = seriesMatch[1].trim();
    // Verify the extracted name looks like a real fund (not just "Fund I" or similar)
    if (actualName.length > 5 && !actualName.match(/^Fund\s+[IVX\d]+$/i)) {
      return actualName; // "ROADSTER CAPITAL"
    }
  }

  return fullName;
}

/**
 * Normalize manager name for deduplication
 * "ROADSTER CAPITAL" and "Roadster Capital, LP" should match
 */
function normalizeManagerName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/,?\s*(lp|llc|l\.p\.|l\.l\.c\.|ltd|limited|inc|incorporated)\.?$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(url) {
  if (!url) return null;
  let normalized = url.trim();
  if (!normalized.startsWith('http')) {
    normalized = 'https://' + normalized;
  }
  // Remove trailing slash
  normalized = normalized.replace(/\/$/, '');
  return normalized;
}

// ============================================================================
// SEARCH FUNCTIONS
// ============================================================================

async function braveSearch(query, retryCount = 0) {
  if (!BRAVE_SEARCH_API_KEY) return null;
  
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_SEARCH_API_KEY
      }
    });
    
    if (response.status === 429 && retryCount < 2) {
      console.log(`[Brave] Rate limited, waiting 5s...`);
      await delay(5000);
      return braveSearch(query, retryCount + 1);
    }
    
    if (!response.ok) {
      console.error(`[Brave] API error: ${response.status}`);
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error('[Brave] Search error:', error.message);
    return null;
  }
}

// Track Serper API failures to skip it after repeated errors
let serperFailureCount = 0;
const SERPER_MAX_FAILURES = 3;

async function serperSearch(query, retryCount = 0) {
  if (!SERPER_API_KEY) return null;

  // Skip Serper if it's been failing repeatedly (quota/key issues)
  if (serperFailureCount >= SERPER_MAX_FAILURES) {
    return null;
  }

  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: 10 })
    });

    if (response.status === 429 && retryCount < 2) {
      console.log(`[Serper] Rate limited, waiting 5s...`);
      await delay(5000);
      return serperSearch(query, retryCount + 1);
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // API key issue or quota exceeded - mark as failing
      serperFailureCount++;
      const errorBody = await response.text().catch(() => '');
      const isQuotaError = errorBody.includes('Not enough credits') || errorBody.includes('quota');
      console.error(`[Serper] API error: ${response.status}${isQuotaError ? ' (QUOTA EXHAUSTED)' : ''} - failure ${serperFailureCount}/${SERPER_MAX_FAILURES}`);
      if (serperFailureCount >= SERPER_MAX_FAILURES) {
        console.log(`[Serper] Disabled for this session - using Brave/Google instead`);
      }
      return null;
    }

    if (!response.ok) {
      console.error(`[Serper] API error: ${response.status}`);
      return null;
    }

    // Reset failure count on success
    serperFailureCount = 0;

    const data = await response.json();
    return {
      web: {
        results: (data.organic || []).map(r => ({
          title: r.title,
          url: r.link,
          description: r.snippet
        }))
      }
    };
  } catch (error) {
    console.error('[Serper] Search error:', error.message);
    return null;
  }
}

async function googleSearch(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return null;
  
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`[Google] API error: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    return {
      web: {
        results: (data.items || []).map(r => ({
          title: r.title,
          url: r.link,
          description: r.snippet
        }))
      }
    };
  } catch (error) {
    console.error('[Google] Search error:', error.message);
    return null;
  }
}

/**
 * Unified search with fallback chain
 * Priority: Brave (best rate limits) > Google > Serper (often quota issues)
 */
async function search(query) {
  let results;

  // Priority 1: Brave Search (best free tier, 2000 requests/month)
  if (BRAVE_SEARCH_API_KEY) {
    results = await braveSearch(query);
    if (results?.web?.results?.length > 0) return results;
  }

  // Priority 2: Google Custom Search (100 free/day)
  if (GOOGLE_API_KEY && GOOGLE_CX) {
    results = await googleSearch(query);
    if (results?.web?.results?.length > 0) return results;
  }

  // Priority 3: Serper (often has quota issues)
  if (SERPER_API_KEY && serperFailureCount < SERPER_MAX_FAILURES) {
    results = await serperSearch(query);
    if (results?.web?.results?.length > 0) return results;
  }

  return results;
}

// ============================================================================
// DATA EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Check if URL looks like a document/file rather than a website
 */
function isFileUrl(url) {
  if (!url) return true;
  const urlLower = url.toLowerCase();
  // Check file extensions
  const fileExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov'];
  if (fileExtensions.some(ext => urlLower.endsWith(ext))) return true;
  // Check for common document paths
  if (urlLower.includes('/files/') || urlLower.includes('/documents/') ||
      urlLower.includes('/uploads/') || urlLower.includes('/download/') ||
      urlLower.includes('/attachments/') || urlLower.includes('/sites/default/files/')) {
    return true;
  }
  return false;
}

/**
 * Check if URL looks like a valid company homepage
 */
function isValidHomepage(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    // Homepage or short path
    if (path === '/' || path === '' || path.length < 20) return true;
    // Common valid subpaths for VC/PE firms
    const validPaths = [
      '/about', '/team', '/contact', '/portfolio', '/investments', '/home',
      '/our-firm', '/our-team', '/people', '/leadership', '/partners',
      '/venture', '/private-equity', '/technology', '/companies', '/focus'
    ];
    if (validPaths.some(p => path.startsWith(p))) return true;
    // Accept any path that's just one level deep (e.g., /ventures, /equity)
    if (path.split('/').filter(Boolean).length === 1) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if URL looks like a news/article page (not a company homepage)
 */
function isNewsOrArticlePage(url) {
  const urlLower = url.toLowerCase();
  return urlLower.includes('/news/') || urlLower.includes('/article/') ||
         urlLower.includes('/blog/') || urlLower.includes('/press/') ||
         urlLower.includes('/2024/') || urlLower.includes('/2023/') ||
         urlLower.includes('/2025/') || urlLower.includes('/2026/');
}

/**
 * Extract website URL from search results
 * Uses three-pass approach:
 *   1. Domain match (HIGHEST PRIORITY): domain contains fund name words
 *   2. Title match: fund name appears in page title
 *   3. First valid homepage: fallback for sites with poor SEO
 */
function extractWebsite(searchResults, fundName) {
  if (!searchResults?.web?.results) return null;

  const results = searchResults.web.results;
  const parsedName = parseFundName(fundName).toLowerCase();

  // Get significant words from fund name (length > 3 to avoid "LP", "of", etc.)
  const fundWords = parsedName.split(' ').filter(w => w.length > 3);

  // PASS 1: Domain match (HIGHEST PRIORITY)
  // E.g., "Patrick of Co" should match "pco.com" or "patrickofc.com"
  for (const result of results.slice(0, 5)) {
    const url = result.url;
    if (isBlockedDomain(url)) continue;
    if (isFileUrl(url)) continue;
    if (isNewsOrArticlePage(url)) continue;

    try {
      const domain = new URL(url).hostname.replace('www.', '').toLowerCase();
      // Check if domain contains any significant fund word
      // E.g., "pco.com" contains "pco", "roadstercapital.com" contains "roadster"
      const domainMatches = fundWords.some(word => domain.includes(word));

      if (domainMatches && isValidHomepage(url)) {
        console.log(`[Website] Domain match found: ${url} (matched "${fundWords.find(w => domain.includes(w))}")`);
        return url;
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }

  // PASS 2: Title match (original behavior)
  for (const result of results.slice(0, 8)) {
    const url = result.url;
    const title = (result.title || '').toLowerCase();

    if (isBlockedDomain(url)) continue;
    if (isFileUrl(url)) continue;
    if (isNewsOrArticlePage(url)) continue;

    // Check if first word of fund name appears in title
    if (title.includes(parsedName.split(' ')[0].toLowerCase())) {
      if (isValidHomepage(url)) {
        console.log(`[Website] Title match found: ${url}`);
        return url;
      }
    }
  }

  // PASS 3: Fallback - but ONLY if site looks like a VC/fund
  // Don't just take any random homepage
  for (const result of results.slice(0, 3)) {
    const url = result.url;
    if (isBlockedDomain(url)) continue;
    if (isFileUrl(url)) continue;
    if (isNewsOrArticlePage(url)) continue;

    try {
      const domain = new URL(url).hostname.toLowerCase();
      const title = (result.title || '').toLowerCase();
      const snippet = (result.description || '').toLowerCase();

      // Require at least ONE signal that this is a VC/fund website
      const fundIndicators = ['capital', 'ventures', 'partners', 'venture', 'fund',
        'investment', 'investor', 'portfolio', 'seed', 'series a', 'vc'];

      const looksLikeFund = fundIndicators.some(indicator =>
        domain.includes(indicator) || title.includes(indicator) || snippet.includes(indicator)
      );

      if (looksLikeFund && isValidHomepage(url)) {
        console.log(`[Website] Fallback match found (fund indicator): ${url}`);
        return url;
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }

  // Better to return null than pick wrong website
  console.log(`[Website] No match found - returning null to avoid wrong website`);
  return null;
}

/**
 * Extract LinkedIn company URL from search results
 */
function extractLinkedIn(searchResults) {
  if (!searchResults?.web?.results) return null;

  for (const result of searchResults.web.results) {
    if (result.url?.includes('linkedin.com/company/')) {
      return result.url;
    }
  }
  return null;
}

/**
 * Extract LinkedIn URLs directly from website HTML
 * This catches LinkedIn links on team/about pages without needing search APIs
 */
async function extractLinkedInFromWebsite(websiteUrl) {
  if (!websiteUrl) return { companyUrl: null, teamLinkedIns: [] };

  const teamPaths = ['', '/team', '/about', '/people', '/leadership', '/our-team', '/about-us', '/company'];
  const companyLinkedIns = new Set();
  const personalLinkedIns = [];

  for (const path of teamPaths) {
    try {
      const url = websiteUrl.replace(/\/$/, '') + path;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FundRadar/1.0)' },
        timeout: 10000
      });

      if (!response.ok) continue;

      const html = await response.text();

      // Extract all LinkedIn URLs from href attributes
      // Matches: href="https://linkedin.com/in/username" or href="https://www.linkedin.com/company/name"
      const linkedInRegex = /href=["']?(https?:\/\/(?:www\.)?linkedin\.com\/(?:in|company)\/[a-zA-Z0-9_-]+\/?)[^"'\s>]*/gi;
      let match;

      while ((match = linkedInRegex.exec(html)) !== null) {
        const linkedInUrl = match[1].replace(/\/$/, ''); // Clean trailing slash

        if (linkedInUrl.includes('/company/')) {
          companyLinkedIns.add(linkedInUrl);
        } else if (linkedInUrl.includes('/in/')) {
          // Try to find the person's name near this URL in the HTML
          const surrounding = html.substring(Math.max(0, match.index - 300), match.index + 300);

          // Look for name patterns near the LinkedIn link
          const nameMatch = surrounding.match(/<[^>]*>([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)<\/[^>]*>/);
          const altMatch = surrounding.match(/alt=["']([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)["']/);
          const titleMatch = surrounding.match(/title=["']([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)["']/);

          const name = nameMatch?.[1] || altMatch?.[1] || titleMatch?.[1] || null;

          // Extract username from URL for deduplication
          const username = linkedInUrl.split('/in/')[1]?.toLowerCase();

          // Check if we already have this person
          if (username && !personalLinkedIns.some(p => p.url.toLowerCase().includes(username))) {
            personalLinkedIns.push({
              url: linkedInUrl,
              name: name,
              foundOnPage: path || '/'
            });
          }
        }
      }

    } catch (error) {
      continue;
    }
  }

  return {
    companyUrl: companyLinkedIns.size > 0 ? Array.from(companyLinkedIns)[0] : null,
    teamLinkedIns: personalLinkedIns.slice(0, 20) // Limit to 20 team members
  };
}

/**
 * Try to find company LinkedIn from a team member's personal LinkedIn page
 * Their profile often links to the company page
 */
async function extractCompanyLinkedInFromProfile(personalLinkedInUrl) {
  if (!personalLinkedInUrl) return null;

  try {
    // LinkedIn pages require special handling - they may redirect or block
    const response = await fetch(personalLinkedInUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 10000,
      redirect: 'follow'
    });

    if (!response.ok) return null;

    const html = await response.text();

    // Look for company LinkedIn URL in the experience section
    const companyMatch = html.match(/linkedin\.com\/company\/([a-zA-Z0-9_-]+)/);
    if (companyMatch) {
      return `https://www.linkedin.com/company/${companyMatch[1]}`;
    }

  } catch (error) {
    // LinkedIn often blocks scraping, so this is best-effort
    return null;
  }

  return null;
}

/**
 * Search specifically for LinkedIn company page
 */
async function searchLinkedIn(fundName) {
  const query = `site:linkedin.com/company "${parseFundName(fundName)}"`;
  const results = await search(query);
  return extractLinkedIn(results);
}

/**
 * Validate if a LinkedIn profile title indicates the person works at the target fund
 * Uses strict matching: bigrams for multi-word names, word boundaries for single distinctive words
 *
 * @param {string} fundName - The parsed fund name
 * @param {string} profileTitle - The LinkedIn profile title (e.g., "John Doe - Partner at Acme Capital")
 * @returns {boolean} - True if this profile appears to be from the target fund
 */
function isValidLinkedInMatch(fundName, profileTitle) {
  const lowerTitle = profileTitle.toLowerCase();
  const lowerName = fundName.toLowerCase();

  // Method 1: Full fund name appears in title (best match)
  if (lowerTitle.includes(lowerName)) {
    return true;
  }

  // Get word parts for additional checks
  const nameParts = lowerName.split(' ').filter(w => w.length > 2);

  // Method 2: Check consecutive word pairs (bigrams) for multi-word names
  // E.g., "Renn Global Ventures" -> check for "renn global" or "global ventures"
  if (nameParts.length >= 2) {
    for (let i = 0; i < nameParts.length - 1; i++) {
      const bigram = `${nameParts[i]} ${nameParts[i + 1]}`;
      if (lowerTitle.includes(bigram)) {
        return true;
      }
    }
  }

  // Method 3: For single distinctive word, require exact word boundary match
  // "Acme" should match "Partner at Acme Capital" but NOT "Partner at Academy Ventures"
  const genericWords = ['ventures', 'capital', 'partners', 'fund', 'investment',
                        'management', 'holdings', 'group', 'equity', 'global', 'advisors'];
  const distinctiveWords = nameParts.filter(w => !genericWords.includes(w));

  if (distinctiveWords.length === 1) {
    const word = distinctiveWords[0];
    // Word boundary check: word must appear as standalone word
    const wordBoundaryRegex = new RegExp(`\\b${word}\\b`, 'i');
    return wordBoundaryRegex.test(lowerTitle);
  }

  // Method 4: For all-generic names ("Global Ventures Fund"), require ALL words present
  if (distinctiveWords.length === 0 && nameParts.length >= 2) {
    return nameParts.every(word => lowerTitle.includes(word));
  }

  return false;
}

/**
 * Search for team members via LinkedIn when website extraction fails
 * Uses search API to find "[Fund Name] team linkedin" profiles
 *
 * STRICT VALIDATION: Uses bigram matching and word boundaries to prevent false matches
 * like "Andrew Ng" matching for "Decile Group" just because "Ng" appears somewhere
 */
async function searchTeamLinkedIn(fundName) {
  const parsedName = parseFundName(fundName);
  const teamMembers = [];

  // Search for team members on LinkedIn
  const queries = [
    `site:linkedin.com/in "${parsedName}" founder OR partner OR managing`,
    `site:linkedin.com/in "${parsedName}" principal OR director`
  ];

  for (const query of queries) {
    const results = await search(query);
    if (!results?.web?.results) continue;

    for (const result of results.web.results) {
      const url = result.url;
      if (!url?.includes('linkedin.com/in/')) continue;

      // Extract name from title (usually "Name - Title - Company | LinkedIn")
      const title = result.title || '';
      const namePart = title.split(' - ')[0]?.trim();
      const rolePart = title.split(' - ')[1]?.trim();

      // Skip if name looks like search results or company pages
      if (!namePart || namePart.includes('LinkedIn') || namePart.length > 50) continue;

      // STRICT VALIDATION: Check if profile is actually associated with THIS fund
      const isValidMatch = isValidLinkedInMatch(parsedName, title);

      if (!isValidMatch) {
        console.log(`[LinkedIn Search] Rejected: "${namePart}" - title doesn't match "${parsedName}" strictly`);
        continue;
      }

      // Dedupe by LinkedIn username
      const username = url.split('/in/')[1]?.split(/[?/]/)[0]?.toLowerCase();
      if (username && !teamMembers.some(m => m.linkedin?.toLowerCase().includes(username))) {
        teamMembers.push({
          name: namePart,
          title: rolePart || null,
          email: null,
          linkedin: url.split('?')[0], // Clean URL
          source: 'linkedin_search'
        });

        console.log(`[LinkedIn Search] Accepted: ${namePart} - ${rolePart || 'Unknown role'}`);
      }

      // Limit to 5 team members from search
      if (teamMembers.length >= 5) break;
    }

    if (teamMembers.length >= 5) break;
    await delay(RATE_LIMIT_DELAY_MS);
  }

  return teamMembers;
}

/**
 * Extract related parties from Form D filings for a given series_master_llc
 * Returns structured team members from the related_names/related_roles fields
 *
 * Note: Form D related parties are often limited - may include fund admins
 * rather than actual investment team. Use as fallback, not primary source.
 */
async function extractRelatedPartiesFromFormD(seriesMasterLlc) {
  if (!seriesMasterLlc) return [];

  try {
    // Get Form D filings for this master LLC
    // NOTE: form_d_filings does NOT have series_master_llc column
    // Must search by entityname containing "a series of {seriesMasterLlc}"
    const { data: filings, error } = await formdClient
      .from('form_d_filings')
      .select('related_names, related_roles, entityname')
      .ilike('entityname', `%a series of ${seriesMasterLlc}%`)
      .not('related_names', 'is', null)
      .limit(10);

    if (error || !filings?.length) return [];

    const teamMap = new Map();

    // Roles that indicate actual team members (not service providers)
    const investmentRoles = [
      'managing member', 'manager', 'general partner', 'executive officer',
      'director', 'founder', 'principal', 'partner', 'ceo', 'cio', 'cfo',
      'president', 'chief', 'portfolio manager'
    ];

    // Roles that indicate service providers (filter out)
    // Use word boundary regex to avoid false positives like "Chief Legal Officer"
    const serviceProviderRolePatterns = [
      /\badministrator\b/i,           // Matches "Administrator" not "Chief Administrator"
      /\bfund admin\b/i,
      /\bcustodian\b/i,
      /\boutside counsel\b/i,         // Matches "Outside Counsel" not "General Counsel"
      /\bexternal counsel\b/i,
      /\boutside legal\b/i,
      /\bexternal legal\b/i,
      /\baccountant\b/i,
      /\bauditor\b/i,
      /\bsecretary\b/i                // Keep "Secretary" as it's often a service role
    ];

    for (const filing of filings) {
      const names = (filing.related_names || '').split('|').map(n => n.trim()).filter(Boolean);
      const roles = (filing.related_roles || '').split('|').map(r => r.trim()).filter(Boolean);

      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const role = roles[i] || '';

        // Skip service providers using word boundary matching
        // This keeps "Chief Legal Officer", "General Counsel", "Chief Compliance Officer"
        // but filters "Outside Counsel", "Administrator", "Auditor"
        if (serviceProviderRolePatterns.some(pattern => pattern.test(role))) continue;

        // Skip platform staff names (Belltower, Brett Sagan, etc.)
        if (isPlatformStaffName(name)) {
          console.log(`[Form D] Skipping platform staff: ${name}`);
          continue;
        }

        // Skip if name looks like a company, not a person
        if (name.includes('LLC') || name.includes('LP') || name.includes('Inc') ||
            name.includes('Corp') || name.includes('Ltd') || name.includes('Fund')) continue;

        // Check if this looks like an investment team member
        const roleLower = role.toLowerCase();
        const isInvestmentTeam = investmentRoles.some(ir => roleLower.includes(ir));

        // Add to map (dedupe by name)
        const nameKey = name.toLowerCase();
        if (!teamMap.has(nameKey)) {
          teamMap.set(nameKey, {
            name: name,
            title: role || null,
            email: null,
            linkedin: null,
            source: 'form_d',
            isInvestmentTeam: isInvestmentTeam
          });
        }
      }
    }

    // Sort: investment team first, then others
    const results = Array.from(teamMap.values())
      .sort((a, b) => (b.isInvestmentTeam ? 1 : 0) - (a.isInvestmentTeam ? 1 : 0))
      .slice(0, 10); // Limit to 10

    console.log(`[Form D] Found ${results.length} related parties for ${seriesMasterLlc}`);
    return results;

  } catch (error) {
    console.error('[Form D] Error extracting related parties:', error.message);
    return [];
  }
}

/**
 * Search for Twitter/X handle
 */
async function searchTwitter(fundName) {
  const parsedName = parseFundName(fundName);
  const query = `site:twitter.com OR site:x.com "${parsedName}"`;
  const results = await search(query);
  
  if (!results?.web?.results) return null;
  
  for (const result of results.web.results) {
    const url = result.url;
    // Match twitter.com/username or x.com/username (not search pages)
    const match = url.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)(?:\/|$|\?)/);
    if (match && match[1]) {
      const handle = match[1].toLowerCase();
      // Skip non-profile pages
      if (!['search', 'hashtag', 'i', 'intent', 'share', 'home'].includes(handle)) {
        return `@${match[1]}`;
      }
    }
  }
  
  return null;
}

/**
 * Extract emails from a website
 */
async function extractEmailsFromWebsite(websiteUrl) {
  if (!websiteUrl) return [];
  
  const contactPaths = ['', '/contact', '/about', '/team', '/contact-us', '/about-us'];
  const emails = new Set();
  
  for (const path of contactPaths) {
    try {
      const url = websiteUrl.replace(/\/$/, '') + path;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FundRadar/1.0)' },
        timeout: 10000
      });
      
      if (!response.ok) continue;
      
      const html = await response.text();
      
      // Email regex
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const foundEmails = html.match(emailRegex) || [];
      
      // Filter out noise
      const filteredEmails = foundEmails.filter(email => {
        const lower = email.toLowerCase();
        return !lower.includes('example.com') &&
               !lower.includes('domain.com') &&
               !lower.includes('email.com') &&
               !lower.includes('sentry.io') &&
               !lower.includes('cloudflare') &&
               !lower.includes('wixpress') &&
               !lower.includes('squarespace') &&
               !lower.includes('.png') &&
               !lower.includes('.jpg') &&
               !lower.endsWith('.js') &&
               !lower.endsWith('.css');
      });
      
      filteredEmails.forEach(e => emails.add(e.toLowerCase()));
      
    } catch (error) {
      continue;
    }
  }
  
  // Prioritize contact emails
  const priorityPrefixes = ['info', 'contact', 'hello', 'invest', 'ir', 'team'];
  const sortedEmails = Array.from(emails).sort((a, b) => {
    const aPrefix = a.split('@')[0];
    const bPrefix = b.split('@')[0];
    const aScore = priorityPrefixes.findIndex(p => aPrefix.includes(p));
    const bScore = priorityPrefixes.findIndex(p => bPrefix.includes(p));
    return (aScore === -1 ? 99 : aScore) - (bScore === -1 ? 99 : bScore);
  });
  
  return sortedEmails.slice(0, 5); // Return top 5
}

// ============================================================================
// AI-POWERED VALIDATION & EXTRACTION
// ============================================================================

/**
 * Use AI to validate if a website belongs to the fund
 */
async function validateWebsiteWithAI(websiteUrl, fundName) {
  if (!openai || !websiteUrl) {
    return { isValid: false, confidence: 0, reason: 'No AI available for validation' };
  }

  // PRE-CHECK: Domain should have SOME relation to fund name
  // Catches garbage like realestate-tokyo.com for "Cape Tower LLC"
  try {
    const domain = new URL(websiteUrl).hostname.toLowerCase().replace('www.', '');
    const fundWords = parseFundName(fundName).toLowerCase().split(' ')
      .filter(w => w.length >= 3 && !['the', 'and', 'for', 'llc', 'inc', 'ltd'].includes(w));

    // Check if ANY fund word appears in domain
    const hasWordOverlap = fundWords.some(word => domain.includes(word));

    // Allow known VC domain patterns even without word overlap
    const isVcDomainPattern = /\.(vc|ventures|capital|fund|partners)\./.test(domain) ||
                              domain.endsWith('.vc') ||
                              /(ventures|capital|fund|partners)/.test(domain);

    if (!hasWordOverlap && !isVcDomainPattern) {
      console.log(`[AI Validation] Domain pre-check failed: "${domain}" has no overlap with fund words [${fundWords.join(', ')}]`);
      return { isValid: false, confidence: 0, reason: `Domain "${domain}" has no relation to fund name` };
    }
  } catch (urlError) {
    // If URL parsing fails, continue to AI validation
  }

  try {
    const response = await fetch(websiteUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FundRadar/1.0)' },
      timeout: 10000
    });

    if (!response.ok) {
      return { isValid: false, confidence: 0, reason: 'Website not accessible' };
    }

    const html = await response.text();
    const truncatedHtml = html.slice(0, 5000); // Limit tokens

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are validating if a website belongs to the EXACT investment fund/firm specified.
Return JSON only: {"isValid": boolean, "confidence": 0.0-1.0, "reason": "brief explanation", "foundName": "name found on site or null"}

CRITICAL RULES for validation:
1. The website MUST mention the EXACT fund name (or very close variant), not just a similar name
2. "Global Ventures" is NOT the same as "Renn Global Ventures" - these are DIFFERENT firms
3. "XYZ Capital" is NOT the same as "ABC XYZ Capital" - partial matches are FALSE
4. Watch out for common generic words: "Ventures", "Capital", "Partners", "Fund", "Investment"
5. The FULL distinctive name must match, not just common suffixes
6. If you find a different company name on the website, return isValid: false

Examples of FALSE matches:
- Fund "Renn Global Ventures" vs website for "Global Ventures" -> FALSE (different company)
- Fund "Oak Capital" vs website for "Red Oak Capital" -> FALSE (different company)
- Fund "Summit Partners" vs website for "Summit Fund Partners" -> FALSE (different company)

Only return isValid: true if the website clearly belongs to the EXACT fund specified.`
        },
        {
          role: "user",
          content: `Fund name: "${fundName}"
Website URL: ${websiteUrl}
HTML excerpt:
${truncatedHtml}`
        }
      ],
      temperature: 0,
      max_tokens: 200
    });

    const aiResponse = completion.choices[0].message.content;
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      // Log any potential mismatches for debugging
      if (result.foundName && result.foundName.toLowerCase() !== fundName.toLowerCase()) {
        console.log(`[AI Validation] Name mismatch check: searched "${fundName}", found "${result.foundName}", isValid: ${result.isValid}`);
      }
      return result;
    }

    // FAIL CLOSED: If we can't parse AI response, reject the website
    console.log(`[AI Validation] Could not parse AI response, rejecting website`);
    return { isValid: false, confidence: 0, reason: 'AI response parse failed' };
  } catch (error) {
    console.error('[AI Validation] Error:', error.message);
    // FAIL CLOSED: On any error, reject the website (don't accept garbage)
    return { isValid: false, confidence: 0, reason: `Validation error: ${error.message}` };
  }
}

/**
 * Extract team members from website using AI
 */
async function extractTeamWithAI(websiteUrl, fundName) {
  if (!openai || !websiteUrl) return [];

  const teamPaths = ['/team', '/about', '/people', '/leadership', '/our-team', '/about-us'];

  for (const path of teamPaths) {
    try {
      const url = websiteUrl.replace(/\/$/, '') + path;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FundRadar/1.0)' },
        timeout: 10000
      });

      if (!response.ok) continue;

      const html = await response.text();

      // Check if this looks like a team page
      const lowerHtml = html.toLowerCase();
      if (!lowerHtml.includes('team') && !lowerHtml.includes('partner') &&
          !lowerHtml.includes('founder') && !lowerHtml.includes('managing')) {
        continue;
      }

      const truncatedHtml = html.slice(0, 8000);

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Extract team members from this investment firm's team page.
Return JSON: {"firmNameFound": "name found on page", "team": [{"name": "Full Name", "title": "Job Title", "email": "email or null", "linkedin": "url or null"}]}

CRITICAL VALIDATION:
1. First, identify what firm/company name appears on this page
2. ONLY extract team members if this page is for the EXACT firm specified (not a similarly-named firm)
3. If the page mentions a DIFFERENT firm (e.g., searching "Renn Global Ventures" but page is for "Global Ventures"), return empty team
4. Focus on: Partners, Founders, Managing Directors, Principals
5. Skip: Advisors, Board members, contractors

If the firm name doesn't match exactly, return: {"firmNameFound": "actual firm name", "team": []}`
          },
          {
            role: "user",
            content: `Extract team members for: "${fundName}"
Website URL: ${url}
HTML:
${truncatedHtml}`
          }
        ],
        temperature: 0,
        max_tokens: 1200
      });

      const aiResponse = completion.choices[0].message.content;
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        // Check if firm name matches
        if (result.firmNameFound && result.firmNameFound.toLowerCase() !== fundName.toLowerCase()) {
          // Check if it's a reasonable variant (e.g., "X LLC" vs "X")
          const normalizedFound = result.firmNameFound.toLowerCase().replace(/\s*(llc|lp|inc|corp|ltd|l\.l\.c\.|l\.p\.)\s*$/i, '').trim();
          const normalizedSearch = fundName.toLowerCase().replace(/\s*(llc|lp|inc|corp|ltd|l\.l\.c\.|l\.p\.)\s*$/i, '').trim();
          if (normalizedFound !== normalizedSearch && !normalizedFound.includes(normalizedSearch) && !normalizedSearch.includes(normalizedFound)) {
            console.log(`[Team AI] Firm name mismatch: searched "${fundName}", found "${result.firmNameFound}" - skipping team extraction`);
            continue; // Try next path
          }
        }
        if (result.team && result.team.length > 0) {
          console.log(`[Team AI] Found ${result.team.length} team members from ${url} (firm: ${result.firmNameFound || 'not specified'})`);
          return result.team;
        }
      }
    } catch (error) {
      continue;
    }
  }

  return [];
}

/**
 * Get fund type from Form D filing data (preferred: uses authoritative SEC data)
 * Falls back to basic regex classification if Form D data not available
 *
 * @param {string} seriesMasterLlc - The series master LLC name to look up
 * @param {string} fundName - Fallback fund name for regex classification
 * @param {object} searchResults - Search results for fallback classification
 */
async function getFundTypeFromFormD(seriesMasterLlc, fundName, searchResults) {
  try {
    // Query Form D for investmentfundtype
    // NOTE: form_d_filings does NOT have series_master_llc column
    // Must search by entityname containing the umbrella name
    const { data, error } = await formdClient
      .from('form_d_filings')
      .select('investmentfundtype')
      .ilike('entityname', `%a series of ${seriesMasterLlc}%`)
      .not('investmentfundtype', 'is', null)
      .limit(1);

    if (!error && data?.length > 0 && data[0].investmentfundtype) {
      const formDType = data[0].investmentfundtype.toLowerCase();
      console.log(`[Fund Type] Found in Form D: ${formDType}`);

      // Map Form D types to our normalized types
      let fundType = 'Unknown';
      if (formDType.includes('venture capital')) {
        fundType = 'Venture Capital';
      } else if (formDType.includes('private equity')) {
        fundType = 'Private Equity';
      } else if (formDType.includes('hedge')) {
        fundType = 'Hedge Fund';
      } else if (formDType.includes('real estate')) {
        fundType = 'Real Estate';
      } else if (formDType.includes('liquidity') || formDType.includes('credit')) {
        fundType = 'Credit';
      } else if (formDType.includes('securitized') || formDType.includes('other private fund')) {
        fundType = 'Other Private Fund';
      }

      return {
        fundType: fundType,
        confidence: 0.95, // High confidence from authoritative source
        investmentStage: null,
        source: 'form_d'
      };
    }
  } catch (error) {
    console.error('[Fund Type] Error querying Form D:', error.message);
  }

  // Fallback to regex classification (no AI needed)
  console.log(`[Fund Type] Not in Form D, using regex classification`);
  return classifyFundTypeBasic(fundName, searchResults);
}

/**
 * Classify fund type using AI (DEPRECATED - keeping for backwards compatibility)
 * Prefer getFundTypeFromFormD which uses authoritative Form D data
 */
async function classifyFundTypeWithAI(fundName, searchResults) {
  // Just use basic classification now - Form D data is checked separately
  return classifyFundTypeBasic(fundName, searchResults);
}

/**
 * Basic fund type classification (fallback)
 */
function classifyFundTypeBasic(fundName, searchResults) {
  const allText = [
    fundName,
    ...(searchResults?.web?.results?.slice(0, 5).map(r => `${r.title} ${r.description || ''}`) || [])
  ].join(' ').toLowerCase();
  
  if (/venture|vc|seed|startup|early.stage/i.test(allText)) {
    return { fundType: 'Venture Capital', confidence: 0.7 };
  }
  if (/private equity|buyout|lbo|leveraged/i.test(allText)) {
    return { fundType: 'Private Equity', confidence: 0.7 };
  }
  if (/hedge fund|long.short|trading|market neutral/i.test(allText)) {
    return { fundType: 'Hedge Fund', confidence: 0.7 };
  }
  if (/real estate|property|reit|multifamily/i.test(allText)) {
    return { fundType: 'Real Estate', confidence: 0.7 };
  }
  
  return { fundType: 'Unknown', confidence: 0.3 };
}

// ============================================================================
// MAIN ENRICHMENT FUNCTION
// ============================================================================

/**
 * Enrich a single fund manager with retry logic
 */
async function enrichManager(name, options = {}) {
  const startTime = Date.now();
  const { skipValidation = false, forceRefresh = false } = options;
  
  console.log(`\n[Enrichment] Starting: ${name}`);
  
  const enrichmentData = {
    series_master_llc: name,
    website_url: null,
    linkedin_company_url: null,
    twitter_handle: null,
    primary_contact_email: null,
    team_members: [],
    fund_type: null,
    investment_stage: null,
    confidence_score: 0,
    enrichment_status: 'pending',
    enrichment_source: 'automated_v2',
    data_sources: [],
    search_queries_used: [],
    flagged_issues: [],
    enrichment_date: new Date().toISOString()
  };
  
  // Extract actual fund name from umbrella series patterns
  // E.g., "ROADSTER CAPITAL, A SERIES OF DECILE START FUND" → "ROADSTER CAPITAL"
  const actualFundName = extractActualFundName(name);
  const isSeriesFund = actualFundName !== name;

  if (isSeriesFund) {
    console.log(`[Enrichment] Extracted actual fund name: "${actualFundName}" from "${name}"`);
  }

  // Only skip if the ACTUAL fund name (not the umbrella) is itself an admin platform
  if (isAdminUmbrella(actualFundName)) {
    console.log(`[Enrichment] Skipping admin umbrella: ${actualFundName}`);
    enrichmentData.enrichment_status = 'platform_spv';
    enrichmentData.fund_type = 'SPV Platform';
    enrichmentData.confidence_score = 1.0;
    return enrichmentData;
  }

  // Use the actual fund name for searching (not the full umbrella string)
  const parsedName = parseFundName(actualFundName);
  console.log(`[Enrichment] Parsed name: ${parsedName}`);
  
  // Check Form ADV database first
  try {
    const { data: advData } = await advClient
      .from('advisers_enriched')
      .select('crd, adviser_name, primary_website, phone_number, cco_email')
      .or(`adviser_name.ilike.%${parsedName}%,adviser_entity_legal_name.ilike.%${parsedName}%`)
      .limit(1)
      .single();
    
    if (advData) {
      console.log(`[Enrichment] Found in Form ADV! CRD: ${advData.crd}`);
      enrichmentData.linked_crd = advData.crd;
      enrichmentData.data_sources.push('form_adv');
      
      if (advData.primary_website && !isBlockedDomain(advData.primary_website)) {
        enrichmentData.website_url = advData.primary_website;
      }
      if (advData.cco_email) {
        enrichmentData.primary_contact_email = advData.cco_email.toLowerCase();
      }
    }
  } catch (error) {
    // Not found in ADV, continue with web search
  }

  // Check external investor databases (OpenVC + Ramp) for pre-enrichment data
  const extMatch = lookupInvestor(parsedName) || lookupInvestor(actualFundName);
  if (extMatch) {
    console.log(`[Enrichment] Found in external DB (${extMatch.source}): ${extMatch.investor_name}`);

    // Pre-fill empty fields from external DB
    if (!enrichmentData.website_url && extMatch.website_url) {
      enrichmentData.website_url = extMatch.website_url;
    }
    if (!enrichmentData.primary_contact_email && extMatch.primary_contact_email) {
      enrichmentData.primary_contact_email = extMatch.primary_contact_email;
    }
    if (!enrichmentData.linkedin_company_url && extMatch.linkedin_url) {
      enrichmentData.linkedin_company_url = extMatch.linkedin_url;
    }
    if (extMatch.twitter_url) {
      enrichmentData.twitter_handle = enrichmentData.twitter_handle || extMatch.twitter_url;
    }
    if (extMatch.investor_type && !enrichmentData.fund_type) {
      enrichmentData.fund_type = extMatch.investor_type;
    }
    if (extMatch.investment_stage && !enrichmentData.investment_stage) {
      enrichmentData.investment_stage = extMatch.investment_stage;
    }
    if (extMatch.founded_year) {
      enrichmentData.founded_year = extMatch.founded_year;
    }
    if (extMatch.investment_sectors) {
      enrichmentData.investment_sectors = extMatch.investment_sectors;
    }
    if (extMatch.geography_focus || extMatch.hq_location) {
      enrichmentData.geography_focus = extMatch.geography_focus || extMatch.hq_location;
    }
    if (extMatch.check_size_min_usd || extMatch.check_size_max_usd) {
      enrichmentData.check_size_min = extMatch.check_size_min_usd;
      enrichmentData.check_size_max = extMatch.check_size_max_usd;
    }

    // Track provenance
    if (extMatch.openvc_record) enrichmentData.data_sources.push('openvc');
    if (extMatch.ramp_record) enrichmentData.data_sources.push('ramp');

    // Add contact as team member if team is empty
    if (extMatch.contact_name && enrichmentData.team_members.length === 0) {
      enrichmentData.team_members.push({
        name: extMatch.contact_name,
        source: 'external_db'
      });
    }

    // Skip web search if core fields already filled (website + email + LinkedIn)
    if (enrichmentData.website_url && enrichmentData.primary_contact_email && enrichmentData.linkedin_company_url) {
      enrichmentData.skipped_web_search = true;
      console.log('[Enrichment] Core fields filled from ADV + external DB, skipping web search');
    }
  }

  // Search strategies for retry - start with unquoted (more results) then get specific
  let searchResults = null;
  let strategyUsed = 0;

  if (!enrichmentData.skipped_web_search) {
    const searchStrategies = [
      `${parsedName}`,  // Simple unquoted search first - most likely to find website
      `${parsedName} venture capital`,
      `"${parsedName}"`,  // Exact match
      `${parsedName} fund manager`
    ];

    // Try each search strategy
    for (let i = 0; i < searchStrategies.length; i++) {
      const query = searchStrategies[i];
      enrichmentData.search_queries_used.push(query);

      console.log(`[Enrichment] Search strategy ${i + 1}: ${query}`);
      searchResults = await search(query);

      if (searchResults?.web?.results?.length > 0) {
        strategyUsed = i + 1;
        console.log(`[Enrichment] Found ${searchResults.web.results.length} results`);
        break;
      }

      await delay(RATE_LIMIT_DELAY_MS);
    }

    if (!searchResults?.web?.results?.length) {
      console.log(`[Enrichment] No web search results found, trying LinkedIn fallback...`);

      // LinkedIn fallback: Try to find company LinkedIn page even when website search fails
      if (!enrichmentData.linkedin_company_url) {
        await delay(RATE_LIMIT_DELAY_MS);
        enrichmentData.linkedin_company_url = await searchLinkedIn(parsedName);
      }

      if (enrichmentData.linkedin_company_url) {
        console.log(`[Enrichment] LinkedIn fallback found: ${enrichmentData.linkedin_company_url}`);
        if (!enrichmentData.data_sources.includes('linkedin')) {
          enrichmentData.data_sources.push('linkedin');
        }
        enrichmentData.enrichment_status = 'linkedin_only';
        enrichmentData.flagged_issues.push('no_website_found');

        // Try to get team info from Form D related parties as additional fallback
        // (This is done later in the flow for cases with website, but we need it here too)
      } else {
        console.log(`[Enrichment] No search results or LinkedIn found`);
        enrichmentData.enrichment_status = 'no_data_found';
        enrichmentData.flagged_issues.push('no_search_results');
        return enrichmentData;
      }
    }
  }
  
  // Extract website
  if (!enrichmentData.website_url) {
    enrichmentData.website_url = extractWebsite(searchResults, name);
    if (enrichmentData.website_url) {
      enrichmentData.data_sources.push('website');
      console.log(`[Enrichment] Website: ${enrichmentData.website_url}`);
    }
  }
  
  // Validate website with AI - use tiered confidence thresholds
  if (enrichmentData.website_url && !skipValidation) {
    const validation = await validateWebsiteWithAI(enrichmentData.website_url, actualFundName);
    console.log(`[Enrichment] Website validation: ${JSON.stringify(validation)}`);

    if (!validation.isValid || validation.confidence < 0.5) {
      // Low confidence (< 0.5): Discard website - be strict to avoid garbage
      console.log(`[Enrichment] Website failed validation (confidence ${validation.confidence}), clearing`);
      enrichmentData.website_url = null;
      enrichmentData.data_sources = enrichmentData.data_sources.filter(s => s !== 'website');
      enrichmentData.flagged_issues.push('website_validation_failed');
    } else if (validation.confidence < 0.75) {
      // Medium confidence (0.5-0.75): Keep but flag for review
      console.log(`[Enrichment] Website borderline (confidence ${validation.confidence}), flagging for review`);
      enrichmentData.flagged_issues.push('website_needs_review');
    }
    // High confidence (>= 0.75): Accept without flagging
  }
  
  // Extract LinkedIn - try multiple methods
  if (!enrichmentData.linkedin_company_url) {
    enrichmentData.linkedin_company_url = extractLinkedIn(searchResults);
  }

  // Method 2: Extract directly from website HTML (no API needed!)
  let websiteLinkedInData = null;
  if (enrichmentData.website_url) {
    console.log(`[Enrichment] Extracting LinkedIn URLs from website HTML...`);
    websiteLinkedInData = await extractLinkedInFromWebsite(enrichmentData.website_url);

    // Use company LinkedIn if found on website
    if (!enrichmentData.linkedin_company_url && websiteLinkedInData.companyUrl) {
      enrichmentData.linkedin_company_url = websiteLinkedInData.companyUrl;
      console.log(`[Enrichment] Found company LinkedIn on website: ${enrichmentData.linkedin_company_url}`);
    }

    // Store team LinkedIn URLs for later merge with AI-extracted team
    if (websiteLinkedInData.teamLinkedIns.length > 0) {
      console.log(`[Enrichment] Found ${websiteLinkedInData.teamLinkedIns.length} team LinkedIn URLs on website`);
    }
  }

  // Method 3: Search specifically for LinkedIn (uses API quota)
  if (!enrichmentData.linkedin_company_url) {
    console.log(`[Enrichment] Searching LinkedIn specifically...`);
    await delay(RATE_LIMIT_DELAY_MS);
    enrichmentData.linkedin_company_url = await searchLinkedIn(parsedName);
  }

  // Method 4: Try to get company LinkedIn from a team member's profile
  if (!enrichmentData.linkedin_company_url && websiteLinkedInData?.teamLinkedIns.length > 0) {
    console.log(`[Enrichment] Trying to extract company LinkedIn from team member profile...`);
    const companyFromProfile = await extractCompanyLinkedInFromProfile(websiteLinkedInData.teamLinkedIns[0].url);
    if (companyFromProfile) {
      enrichmentData.linkedin_company_url = companyFromProfile;
      console.log(`[Enrichment] Found company LinkedIn via team member: ${enrichmentData.linkedin_company_url}`);
    }
  }

  if (enrichmentData.linkedin_company_url) {
    enrichmentData.data_sources.push('linkedin');
    console.log(`[Enrichment] LinkedIn: ${enrichmentData.linkedin_company_url}`);
  }
  
  // Extract Twitter (skip API call if already have from external DB)
  if (!enrichmentData.twitter_handle) {
    console.log(`[Enrichment] Searching Twitter...`);
    await delay(RATE_LIMIT_DELAY_MS);
    enrichmentData.twitter_handle = await searchTwitter(parsedName);
  }
  if (enrichmentData.twitter_handle) {
    enrichmentData.data_sources.push('twitter');
    console.log(`[Enrichment] Twitter: ${enrichmentData.twitter_handle}`);
  }
  
  // Extract emails from website
  if (enrichmentData.website_url && !enrichmentData.primary_contact_email) {
    console.log(`[Enrichment] Extracting emails from website...`);
    const emails = await extractEmailsFromWebsite(enrichmentData.website_url);
    if (emails.length > 0) {
      enrichmentData.primary_contact_email = emails[0];
      enrichmentData.data_sources.push('email_extracted');
      console.log(`[Enrichment] Email: ${enrichmentData.primary_contact_email}`);
    }
  }
  
  // Extract team members
  if (enrichmentData.website_url) {
    console.log(`[Enrichment] Extracting team members...`);
    enrichmentData.team_members = await extractTeamWithAI(enrichmentData.website_url, parsedName);

    // Merge LinkedIn URLs found directly from website with AI-extracted team
    if (websiteLinkedInData?.teamLinkedIns.length > 0) {
      const aiTeamMap = new Map();

      // Index AI-extracted team by lowercase name for matching
      for (const member of enrichmentData.team_members) {
        if (member.name) {
          aiTeamMap.set(member.name.toLowerCase(), member);
        }
      }

      // Try to match LinkedIn URLs to team members
      for (const linkedInPerson of websiteLinkedInData.teamLinkedIns) {
        if (linkedInPerson.name) {
          const existingMember = aiTeamMap.get(linkedInPerson.name.toLowerCase());
          if (existingMember && !existingMember.linkedin) {
            existingMember.linkedin = linkedInPerson.url;
            console.log(`[Enrichment] Added LinkedIn to ${existingMember.name}: ${linkedInPerson.url}`);
          }
        }
      }

      // Add any LinkedIn-only team members not found by AI
      for (const linkedInPerson of websiteLinkedInData.teamLinkedIns) {
        const username = linkedInPerson.url.split('/in/')[1]?.toLowerCase();
        const alreadyHasLinkedIn = enrichmentData.team_members.some(m =>
          m.linkedin?.toLowerCase().includes(username)
        );

        if (!alreadyHasLinkedIn && linkedInPerson.name) {
          // Add as new team member with just LinkedIn and name
          enrichmentData.team_members.push({
            name: linkedInPerson.name,
            title: null,
            email: null,
            linkedin: linkedInPerson.url
          });
          console.log(`[Enrichment] Added new team member from LinkedIn: ${linkedInPerson.name}`);
        }
      }
    }

    if (enrichmentData.team_members.length > 0) {
      enrichmentData.data_sources.push('team_extracted');
      console.log(`[Enrichment] Found ${enrichmentData.team_members.length} team members total`);
    }
  }

  // FALLBACK 1: If no team members from website, search LinkedIn for team
  // Use actualFundName (not full umbrella string) for better search results
  if (enrichmentData.team_members.length === 0) {
    console.log(`[Enrichment] No team from website - trying LinkedIn search fallback...`);
    await delay(RATE_LIMIT_DELAY_MS);
    const linkedInTeam = await searchTeamLinkedIn(actualFundName);
    if (linkedInTeam.length > 0) {
      enrichmentData.team_members = linkedInTeam;
      enrichmentData.data_sources.push('team_linkedin_search');
      console.log(`[Enrichment] Found ${linkedInTeam.length} team members via LinkedIn search`);
    }
  }

  // FALLBACK 2: Cross-reference with Form D related parties
  // For umbrella series, the related parties may include the actual fund manager
  console.log(`[Enrichment] Cross-referencing with Form D related parties...`);
  const formDRelatedParties = await extractRelatedPartiesFromFormD(name); // Use original name to match DB

  if (formDRelatedParties.length > 0) {
    // Merge with existing team (Form D as supplementary, not replacement)
    const existingNames = new Set(enrichmentData.team_members.map(m => m.name?.toLowerCase()));

    for (const formDPerson of formDRelatedParties) {
      const nameKey = formDPerson.name?.toLowerCase();
      if (nameKey && !existingNames.has(nameKey)) {
        // Add Form D person to team
        enrichmentData.team_members.push({
          name: formDPerson.name,
          title: formDPerson.title,
          email: null,
          linkedin: null,
          source: 'form_d'
        });
        existingNames.add(nameKey);
      } else if (nameKey && existingNames.has(nameKey)) {
        // Fill in title from Form D if missing
        const existing = enrichmentData.team_members.find(m => m.name?.toLowerCase() === nameKey);
        if (existing && !existing.title && formDPerson.title) {
          existing.title = formDPerson.title;
        }
      }
    }

    if (!enrichmentData.data_sources.includes('form_d_related')) {
      enrichmentData.data_sources.push('form_d_related');
    }
    console.log(`[Enrichment] Team after Form D merge: ${enrichmentData.team_members.length} members`);
  }

  // Classify fund type - use Form D data first (authoritative), then regex fallback
  const classification = await getFundTypeFromFormD(name, actualFundName, searchResults);
  enrichmentData.fund_type = classification.fundType;
  enrichmentData.investment_stage = classification.investmentStage || null;
  if (classification.source === 'form_d') {
    enrichmentData.data_sources.push('form_d_fundtype');
  }
  console.log(`[Enrichment] Classification: ${enrichmentData.fund_type} (${classification.confidence}, source: ${classification.source || 'regex'})`);
  
  // Calculate confidence score
  let confidence = 0;
  if (enrichmentData.website_url) confidence += 0.35;
  if (enrichmentData.linkedin_company_url) confidence += 0.20;
  if (enrichmentData.twitter_handle) confidence += 0.10;
  if (enrichmentData.primary_contact_email) confidence += 0.15;
  if (enrichmentData.team_members.length > 0) confidence += 0.10;
  if (enrichmentData.fund_type && enrichmentData.fund_type !== 'Unknown') confidence += 0.10;
  
  enrichmentData.confidence_score = Math.min(confidence, 1.0);
  
  // Determine status
  if (enrichmentData.confidence_score >= CONFIDENCE_THRESHOLD) {
    enrichmentData.enrichment_status = 'auto_enriched';
    enrichmentData.is_published = true;
  } else if (enrichmentData.confidence_score >= 0.4) {
    enrichmentData.enrichment_status = 'needs_manual_review';
    enrichmentData.is_published = false;
  } else {
    enrichmentData.enrichment_status = 'no_data_found';
    enrichmentData.is_published = false;
  }
  
  const duration = Date.now() - startTime;
  console.log(`[Enrichment] Complete: ${name} | Status: ${enrichmentData.enrichment_status} | Confidence: ${enrichmentData.confidence_score} | Duration: ${duration}ms`);
  
  return enrichmentData;
}

/**
 * Save enrichment data to database with deduplication
 * Checks for existing records by normalized name (if column exists) to prevent duplicates like
 * "ROADSTER CAPITAL" and "Roadster Capital, LP" creating separate entries
 */
async function saveEnrichment(enrichmentData) {
  try {
    const normalizedName = normalizeManagerName(enrichmentData.series_master_llc);

    // Try to find existing record by series_master_llc first (always works)
    const { data: existingByName } = await formdClient
      .from('enriched_managers')
      .select('id, series_master_llc')
      .eq('series_master_llc', enrichmentData.series_master_llc)
      .limit(1);

    // Also check by normalized name using ilike (case-insensitive partial match)
    // This catches "ROADSTER CAPITAL" and "Roadster Capital, LP" as same manager
    const { data: existingByNormalized } = await formdClient
      .from('enriched_managers')
      .select('id, series_master_llc')
      .ilike('series_master_llc', `%${normalizedName}%`)
      .limit(5);

    // Find exact normalized match
    const exactMatch = (existingByNormalized || []).find(e =>
      normalizeManagerName(e.series_master_llc) === normalizedName
    );

    const existing = existingByName?.[0] || exactMatch;

    if (existing) {
      // Update existing record
      console.log(`[Save] Found existing record for "${existing.series_master_llc}", updating...`);
      const { error } = await formdClient
        .from('enriched_managers')
        .update(enrichmentData)
        .eq('id', existing.id);

      if (error) {
        console.error('[Save] Update error:', error.message);
        return false;
      }
      console.log(`[Save] Updated enrichment for: ${enrichmentData.series_master_llc}`);
      return true;
    }

    // No existing record, insert new
    const { error } = await formdClient
      .from('enriched_managers')
      .upsert(enrichmentData, {
        onConflict: 'series_master_llc',
        ignoreDuplicates: false
      });

    if (error) {
      console.error('[Save] Error:', error.message);
      return false;
    }

    console.log(`[Save] Saved enrichment for: ${enrichmentData.series_master_llc}`);
    return true;
  } catch (error) {
    console.error('[Save] Error:', error.message);
    return false;
  }
}

/**
 * Enrich and save a manager
 */
async function enrichAndSaveManager(name, options = {}) {
  const enrichmentData = await enrichManager(name, options);
  await saveEnrichment(enrichmentData);
  return enrichmentData;
}

/**
 * Get unenriched managers from recent Form D filings
 */
async function getUnenrichedManagers(limit = 50, daysBack = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  // Get recent Form D filings with series pattern in entityname
  // NOTE: form_d_filings does NOT have series_master_llc column - must parse from entityname
  const { data: filings, error } = await formdClient
    .from('form_d_filings')
    .select('entityname, filing_date')
    .ilike('entityname', '%a series of%')
    .gte('filing_date', cutoffDate.toISOString().split('T')[0])
    .order('filing_date', { ascending: false })
    .limit(500);

  if (error || !filings) {
    console.error('[GetUnenriched] Error:', error?.message);
    return [];
  }

  // Parse umbrella names from entity names
  const seriesPattern = /,?\s+a\s+series\s+of\s+(.+?)(?:\s*,?\s*$|$)/i;
  const uniqueManagers = [...new Set(
    filings
      .map(f => {
        const match = (f.entityname || '').match(seriesPattern);
        return match ? match[1].trim() : null;
      })
      .filter(Boolean)
  )];
  
  // Filter out already enriched
  const { data: enriched } = await formdClient
    .from('enriched_managers')
    .select('series_master_llc')
    .in('series_master_llc', uniqueManagers);
  
  const enrichedSet = new Set((enriched || []).map(e => e.series_master_llc));
  
  // Filter out admin umbrellas and already enriched
  // Use extractActualFundName to avoid skipping umbrella series with real fund names
  const unenriched = uniqueManagers
    .filter(m => {
      if (enrichedSet.has(m)) return false;
      const actualName = extractActualFundName(m);
      return !isAdminUmbrella(actualName); // Check the actual fund name, not the umbrella
    })
    .slice(0, limit);
  
  console.log(`[GetUnenriched] Found ${unenriched.length} unenriched managers`);
  return unenriched;
}

/**
 * Batch enrich multiple managers
 */
async function batchEnrich(managers, options = {}) {
  const { delayBetween = 3000 } = options;
  const results = [];
  
  for (let i = 0; i < managers.length; i++) {
    const manager = managers[i];
    console.log(`\n[Batch] Processing ${i + 1}/${managers.length}: ${manager}`);
    
    try {
      const result = await enrichAndSaveManager(manager);
      results.push(result);
    } catch (error) {
      console.error(`[Batch] Error enriching ${manager}:`, error.message);
      results.push({
        series_master_llc: manager,
        enrichment_status: 'error',
        error: error.message
      });
    }
    
    if (i < managers.length - 1) {
      await delay(delayBetween);
    }
  }
  
  return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  enrichManager,
  enrichAndSaveManager,
  saveEnrichment,
  getUnenrichedManagers,
  batchEnrich,
  parseFundName,
  extractActualFundName,
  isAdminUmbrella,
  isValidLinkedInMatch,
  extractEmailsFromWebsite,
  extractTeamWithAI,
  validateWebsiteWithAI,
  searchTwitter,
  searchLinkedIn,
  searchTeamLinkedIn,
  extractLinkedInFromWebsite,
  extractCompanyLinkedInFromProfile,
  extractRelatedPartiesFromFormD
};

// ============================================================================
// CLI EXECUTION
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args[0] === 'batch') {
    const limit = parseInt(args[1]) || 10;
    console.log(`Starting batch enrichment of ${limit} managers...`);
    
    getUnenrichedManagers(limit)
      .then(managers => batchEnrich(managers))
      .then(results => {
        const success = results.filter(r => r.enrichment_status === 'auto_enriched').length;
        const review = results.filter(r => r.enrichment_status === 'needs_manual_review').length;
        const failed = results.filter(r => r.enrichment_status === 'no_data_found' || r.enrichment_status === 'error').length;
        
        console.log(`\n[Summary] Success: ${success}, Needs Review: ${review}, Failed: ${failed}`);
        process.exit(0);
      })
      .catch(error => {
        console.error('Batch enrichment failed:', error);
        process.exit(1);
      });
  } else if (args[0]) {
    // Enrich single manager
    const managerName = args.join(' ');
    console.log(`Enriching single manager: ${managerName}`);
    
    enrichAndSaveManager(managerName)
      .then(result => {
        console.log('\nResult:', JSON.stringify(result, null, 2));
        process.exit(0);
      })
      .catch(error => {
        console.error('Enrichment failed:', error);
        process.exit(1);
      });
  } else {
    console.log('Usage:');
    console.log('  node enrichment_engine_v2.js "Manager Name"  - Enrich single manager');
    console.log('  node enrichment_engine_v2.js batch 10        - Batch enrich 10 recent managers');
    process.exit(0);
  }
}
