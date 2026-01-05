/**
 * FUND MANAGER ENRICHMENT ENGINE
 * Automated research and data enrichment for fund managers
 *
 * Phase 1: Basic search + pattern matching
 * Phase 2: + AI classification and team extraction
 * Phase 3: + Continuous operation with monitoring
 */

// Load environment variables (from parent directory where .env lives)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

// ============================================================================
// CONFIGURATION
// ============================================================================

const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || null;
const SERPER_API_KEY = process.env.SERPER_API_KEY || null; // Google via serper.dev (2500 free)
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null; // Google Custom Search (100/day = 3000/month free)
const GOOGLE_CX = process.env.GOOGLE_CX || null; // Google Custom Search Engine ID
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

// Form D database (where enriched managers are stored)
const FORMD_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

// Form ADV database (to check if manager is a registered RIA)
const ADV_URL = 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

const CONFIDENCE_THRESHOLD = 0.7; // Auto-publish if >= 0.7
const MAX_SEARCHES_PER_MANAGER = 2; // Limit API usage

// Initialize OpenAI client
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ============================================================================
// SUPABASE CLIENTS
// ============================================================================

const formdClient = createClient(FORMD_URL, FORMD_KEY);
const advClient = createClient(ADV_URL, ADV_KEY);

// For backward compatibility
const supabase = formdClient;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Delay helper for rate limiting
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// SEARCH FUNCTIONS
// ============================================================================

/**
 * Search the web for fund information
 * Uses Brave Search API (free tier: 2,000/month)
 * Includes retry logic for rate limits (429 errors)
 */
async function webSearch(query, retryCount = 0) {
  if (!BRAVE_SEARCH_API_KEY) {
    console.warn('No Brave Search API key configured');
    return null;
  }

  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 5000; // 5 seconds wait on rate limit

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_SEARCH_API_KEY
      }
    });

    if (response.status === 429) {
      // Rate limited - wait and retry
      if (retryCount < MAX_RETRIES) {
        console.log(`[Search] Rate limited (429), waiting ${RETRY_DELAY_MS/1000}s before retry ${retryCount + 1}/${MAX_RETRIES}...`);
        await delay(RETRY_DELAY_MS);
        return webSearch(query, retryCount + 1);
      } else {
        console.error('[Search] Rate limit exceeded after retries');
        return null;
      }
    }

    if (!response.ok) {
      throw new Error(`Brave Search API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Web search error:', error.message);
    return null;
  }
}

/**
 * Search using Google Custom Search API (official)
 * Free tier: 100 queries/day = 3,000/month
 * Best quality - actual Google results
 */
async function googleSearch(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    return null;
  }

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
 * Search using Serper.dev (Google results)
 * Free tier: 2,500 credits
 * High quality Google search results
 */
async function serperSearch(query) {
  if (!SERPER_API_KEY) {
    return null;
  }

  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: 10
      })
    });

    if (!response.ok) {
      console.error(`[Serper] API error: ${response.status}`);
      return null;
    }

    const data = await response.json();

    // Convert Serper format to Brave-like format for compatibility
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

/**
 * Unified search - tries multiple providers with fallback
 * Priority: Google Custom Search > Serper > Brave
 */
async function search(query) {
  let results;

  // 1. Google Custom Search (100/day = 3000/month, best quality)
  if (GOOGLE_API_KEY && GOOGLE_CX) {
    results = await googleSearch(query);
    if (results && results.web && results.web.results && results.web.results.length > 0) {
      return results;
    }
  }

  // 2. Serper.dev (2500 free, Google results)
  if (SERPER_API_KEY) {
    results = await serperSearch(query);
    if (results && results.web && results.web.results && results.web.results.length > 0) {
      return results;
    }
  }

  // 3. Brave Search (2000/month)
  results = await webSearch(query);
  if (results && results.web && results.web.results && results.web.results.length > 0) {
    return results;
  }

  return null;
}

/**
 * Extract portfolio companies from a fund's website
 * Looks for portfolio/investments pages and parses company listings
 */
async function extractPortfolioCompanies(websiteUrl, fundName) {
  if (!websiteUrl) return [];

  console.log(`[Portfolio] Extracting portfolio companies from ${websiteUrl}...`);

  try {
    // Common portfolio page patterns
    const portfolioPatterns = [
      '/portfolio',
      '/investments',
      '/companies',
      '/portfolio-companies',
      '/our-portfolio',
      '/our-companies'
    ];

    const portfolioCompanies = [];

    // Search for portfolio page on the website
    const portfolioQuery = `site:${websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')} portfolio OR investments`;
    const searchResults = await search(portfolioQuery);

    if (!searchResults || !searchResults.web || !searchResults.web.results) {
      console.log(`[Portfolio] No portfolio page found via search`);
      return [];
    }

    // Find the most likely portfolio page
    let portfolioPageUrl = null;
    for (const result of searchResults.web.results.slice(0, 5)) {
      const url = result.url.toLowerCase();
      if (portfolioPatterns.some(pattern => url.includes(pattern))) {
        portfolioPageUrl = result.url;
        console.log(`[Portfolio] Found portfolio page: ${portfolioPageUrl}`);
        break;
      }
    }

    if (!portfolioPageUrl) {
      console.log(`[Portfolio] No portfolio page found in results`);
      return [];
    }

    // Fetch the portfolio page
    const pageResponse = await fetch(portfolioPageUrl);
    if (!pageResponse.ok) {
      console.log(`[Portfolio] Failed to fetch portfolio page: ${pageResponse.status}`);
      return [];
    }

    const html = await pageResponse.text();

    // Basic regex-based extraction (Phase 1 - simple pattern matching)
    // Look for common company name patterns in HTML
    const companyPatterns = [
      // Look for links with common patterns
      /<a[^>]*href=["']([^"']*?(?:\.com|\.io|\.ai|\.co)[^"']*?)["'][^>]*>([^<]+)<\/a>/gi,
      // Look for company names in structured data
      /"name"\s*:\s*"([^"]+)"/gi,
      // Look for company cards/grids
      /<div[^>]*class=["'][^"']*(?:company|portfolio|investment)[^"']*["'][^>]*>[\s\S]*?<h[0-9][^>]*>([^<]+)<\/h[0-9]>/gi
    ];

    const foundCompanies = new Set();

    for (const pattern of companyPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const companyName = (match[2] || match[1]).trim();

        // Filter out noise (navigation items, common words, etc.)
        if (companyName.length > 2 &&
            companyName.length < 100 &&
            !companyName.toLowerCase().includes('portfolio') &&
            !companyName.toLowerCase().includes('login') &&
            !companyName.toLowerCase().includes('contact') &&
            !/^\d+$/.test(companyName)) {
          foundCompanies.add(companyName);
        }
      }
    }

    // Convert to structured format
    for (const name of Array.from(foundCompanies).slice(0, 50)) { // Limit to 50 companies
      portfolioCompanies.push({
        company_name: name,
        source_url: portfolioPageUrl,
        extraction_method: 'web_scraping',
        confidence_score: 0.5 // Lower confidence for regex extraction
      });
    }

    console.log(`[Portfolio] Regex extraction found ${portfolioCompanies.length} potential portfolio companies`);

    // If we found few or no companies and OpenAI is available, try AI extraction
    if (portfolioCompanies.length < 5 && openai && portfolioPageUrl) {
      console.log(`[Portfolio] Trying AI extraction as fallback...`);
      const aiCompanies = await extractPortfolioWithAI(portfolioPageUrl, fundName);
      if (aiCompanies.length > portfolioCompanies.length) {
        console.log(`[Portfolio] AI extraction found ${aiCompanies.length} companies (better than regex)`);
        return aiCompanies;
      }
    }

    return portfolioCompanies;

  } catch (error) {
    console.error(`[Portfolio] Error extracting portfolio companies:`, error.message);
    return [];
  }
}

/**
 * Extract portfolio companies using AI (GPT-4o-mini)
 * Handles JavaScript-rendered pages better than regex
 */
async function extractPortfolioWithAI(portfolioUrl, fundName) {
  if (!openai) {
    console.log(`[Portfolio AI] OpenAI not configured, skipping AI extraction`);
    return [];
  }

  try {
    // Fetch the page
    const response = await fetch(portfolioUrl);
    if (!response.ok) {
      console.log(`[Portfolio AI] Failed to fetch: ${response.status}`);
      return [];
    }

    const html = await response.text();

    // Limit HTML size to avoid token limits (take first 8000 chars which is ~2000 tokens)
    const truncatedHtml = html.slice(0, 8000);

    console.log(`[Portfolio AI] Sending ${truncatedHtml.length} chars to GPT-4o-mini...`);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a portfolio company extractor. Extract portfolio company names from HTML. Return ONLY a JSON array of company names, nothing else."
        },
        {
          role: "user",
          content: `Extract all portfolio company names from this HTML from ${fundName}'s portfolio page. Return as JSON array: ["Company 1", "Company 2", ...]. Only real company names, no navigation items or generic text.\n\nHTML:\n${truncatedHtml}`
        }
      ],
      temperature: 0,
      max_tokens: 500
    });

    const aiResponse = completion.choices[0].message.content.trim();
    console.log(`[Portfolio AI] Raw response: ${aiResponse.slice(0, 200)}...`);

    // Parse JSON array
    let companyNames = [];
    try {
      companyNames = JSON.parse(aiResponse);
    } catch (parseError) {
      // Try to extract JSON array from response
      const jsonMatch = aiResponse.match(/\[.*\]/s);
      if (jsonMatch) {
        companyNames = JSON.parse(jsonMatch[0]);
      } else {
        console.error(`[Portfolio AI] Failed to parse response as JSON`);
        return [];
      }
    }

    if (!Array.isArray(companyNames)) {
      console.error(`[Portfolio AI] Response is not an array`);
      return [];
    }

    // Convert to portfolio company format
    const portfolioCompanies = companyNames.slice(0, 50).map(name => ({
      company_name: name,
      source_url: portfolioUrl,
      extraction_method: 'ai_extraction',
      confidence_score: 0.85 // Higher confidence for AI extraction
    }));

    console.log(`[Portfolio AI] Successfully extracted ${portfolioCompanies.length} companies`);
    return portfolioCompanies;

  } catch (error) {
    console.error(`[Portfolio AI] Error:`, error.message);
    return [];
  }
}

/**
 * Parse fund name to remove common suffixes and patterns
 */
function parseFundName(name) {
  let parsed = name;

  // Remove common suffixes
  parsed = parsed.replace(/,?\s*(LP|LLC|L\.P\.|L\.L\.C\.|Ltd|Limited|Inc|Incorporated)$/i, '');

  // Handle "A Series of X" pattern
  const seriesMatch = parsed.match(/,?\s+a\s+series\s+of\s+(.+?)$/i);
  if (seriesMatch) {
    parsed = seriesMatch[1].trim();
  }

  // Remove fund numbers (Fund I, Fund II, etc.)
  parsed = parsed.replace(/\s+(Fund\s+)?[IVX]+$/i, '');
  parsed = parsed.replace(/\s+Fund\s+\d+$/i, '');

  return parsed.trim();
}

/**
 * Detect platform SPVs (Hiive, AngelList, Sydecar, etc.)
 * Only flags if the FUND NAME indicates it's an SPV platform vehicle
 * NOT if search results just mention AngelList (many real VCs have AngelList pages)
 */
function isPlatformSPV(name) {
  // Platform patterns - only check fund NAME, not search results
  // Many real VCs have AngelList syndicates, so we shouldn't flag them
  const platformNamePatterns = [
    /^HII\s+/i, // Hiive vehicles start with "HII "
    /Sydecar/i, // Sydecar SPVs
    /^AngelList[- ]/i, // AngelList platform vehicles (not funds that use AngelList)
    /AngelList[- ]GP[- ]Funds/i, // AngelList GP Funds
    /AngelList[- ].*[- ]Funds/i, // AngelList X Funds
    /Roll[- ]?up Vehicles/i,
    /Multimodal Ventures/i,
    /MV Funds/i
  ];

  // Check fund name only - search results having "angellist" just means they have a syndicate page
  for (const pattern of platformNamePatterns) {
    if (pattern.test(name)) return true;
  }

  return false;
}

// ============================================================================
// DATA EXTRACTION
// ============================================================================

/**
 * Extract website URL from search results
 * Filters out aggregator sites, news articles, and Form D databases
 * We want the manager's actual company website homepage
 */
function extractWebsite(searchResults) {
  if (!searchResults || !searchResults.web || !searchResults.web.results) {
    return null;
  }

  const results = searchResults.web.results;

  // Sites to skip - these are aggregators, not manager websites
  const skipDomains = [
    // Data aggregators
    'crunchbase.com', 'pitchbook.com', 'linkedin.com', 'bloomberg.com',
    'tracxn.com', 'cbinsights.com', 'signal.nfx.com', 'dealroom.co',
    'golden.com', 'owler.com', 'zoominfo.com', 'apollo.io',
    // Form D aggregators - NOT manager websites
    'formds.com', 'disclosurequest.com', 'aum13f.com', 'whalewisdom.com',
    'fundz.net', 'sec.gov', 'sec.report', 'advfn.com', 'openfilings.com',
    // Platform/syndicate pages (not the manager's own site)
    'venture.angellist.com', 'republic.com', 'wefunder.com', 'seedinvest.com',
    'startengine.com', 'fundable.com',
    // News/press/media sites
    'crowdfundinsider.com', 'techcrunch.com', 'prnewswire.com', 'businesswire.com',
    'forbes.com', 'wsj.com', 'nytimes.com', 'reuters.com', 'bloomberg.com',
    'venturebeat.com', 'axios.com', 'theinformation.com', 'fortune.com',
    'inc.com', 'entrepreneur.com', 'fastcompany.com', 'wired.com',
    'medium.com', 'substack.com', 'twitter.com', 'x.com', 'facebook.com',
    // Foundation/nonprofit news (NOT fund manager sites)
    'kresge.org', 'gatesfoundation.org', 'fordfoundation.org', 'philanthropy.com',
    // Wikipedia
    'wikipedia.org',
    // PDF links
    '.pdf'
  ];

  // URL path patterns that indicate news/articles (not company homepages)
  const skipPathPatterns = [
    '/news/', '/news-', '/article/', '/articles/', '/blog/', '/blogs/',
    '/press/', '/press-release/', '/pressrelease/', '/media/',
    '/story/', '/stories/', '/post/', '/posts/', '/view/',
    '/2024/', '/2025/', '/2023/', '/2022/', '/2021/', '/2020/', // Date patterns in URLs = articles
    '/category/', '/tag/', '/topics/', '/search'
  ];

  // Helper to check if URL looks like an article page
  const isArticlePage = (url) => {
    const lowerUrl = url.toLowerCase();
    // Check path patterns
    if (skipPathPatterns.some(pattern => lowerUrl.includes(pattern))) {
      return true;
    }
    // Very long URLs with many segments are usually articles
    const pathSegments = new URL(url).pathname.split('/').filter(s => s);
    if (pathSegments.length > 3) {
      return true; // /news/2024/03/15/article-title = 5 segments
    }
    // URLs with long slugs are usually articles
    if (pathSegments.some(seg => seg.length > 50)) {
      return true;
    }
    return false;
  };

  // Helper to check if URL is a homepage or simple page
  const isLikelyHomepage = (url) => {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      // Root, /about, /team, /portfolio are acceptable
      return path === '/' ||
             path === '' ||
             /^\/(about|team|portfolio|contact|invest|investments|companies)?\/?$/.test(path);
    } catch {
      return false;
    }
  };

  for (const result of results.slice(0, 8)) {
    const url = result.url;
    const lowerUrl = url.toLowerCase();

    // Skip aggregator/news domains
    if (skipDomains.some(domain => lowerUrl.includes(domain))) {
      continue;
    }

    // Skip article pages
    if (isArticlePage(url)) {
      continue;
    }

    // Prefer homepages or simple paths that look like fund websites
    if (isLikelyHomepage(url)) {
      // Extra validation: title should match fund-related keywords OR be short (company name)
      const title = (result.title || '').toLowerCase();
      if (title.includes('venture') || title.includes('capital') ||
          title.includes('fund') || title.includes('partners') ||
          title.includes('investment') || title.length < 50) {
        return url;
      }
    }
  }

  // Second pass: accept non-homepage URLs if they're clearly fund-related
  for (const result of results.slice(0, 5)) {
    const url = result.url;
    const lowerUrl = url.toLowerCase();

    // Skip aggregator/news domains
    if (skipDomains.some(domain => lowerUrl.includes(domain))) {
      continue;
    }

    // Skip article pages
    if (isArticlePage(url)) {
      continue;
    }

    // Must have fund-related keyword in title
    const title = (result.title || '').toLowerCase();
    if (title.includes('venture') || title.includes('capital') ||
        title.includes('fund') || title.includes('partners')) {
      return url;
    }
  }

  return null;
}

/**
 * Extract LinkedIn company URL from search results
 */
function extractLinkedIn(searchResults) {
  if (!searchResults || !searchResults.web || !searchResults.web.results) {
    return null;
  }

  const results = searchResults.web.results;
  for (const result of results) {
    if (result.url && result.url.includes('linkedin.com/company/')) {
      return result.url;
    }
  }

  return null;
}

/**
 * Search specifically for LinkedIn company page
 */
async function searchLinkedIn(fundName) {
  const query = `site:linkedin.com/company "${fundName}"`;
  const results = await search(query);
  return extractLinkedIn(results);
}

/**
 * Search for team members via LinkedIn profile search
 * LinkedIn blocks direct access, but search engines show profile snippets
 */
async function searchLinkedInPeople(fundName) {
  const query = `site:linkedin.com/in "${fundName}" partner OR founder OR managing`;
  const results = await search(query);

  if (!results || !results.web || !results.web.results) {
    return [];
  }

  // Extract names and titles from LinkedIn profile search results
  const people = [];
  for (const result of results.web.results.slice(0, 10)) {
    // LinkedIn titles show as "Name - Title - Company | LinkedIn"
    const titleMatch = result.title.match(/^([^-]+)\s*-\s*([^|]+)/);
    if (titleMatch && result.url.includes('linkedin.com/in/')) {
      const name = titleMatch[1].trim();
      const titlePart = titleMatch[2].trim();

      // Skip if it's just a company page or search result
      if (name.length > 2 && name.length < 50 && !name.includes('LinkedIn')) {
        people.push({
          name: name,
          title: titlePart,
          linkedin_url: result.url,
          source: 'linkedin_search'
        });
      }
    }
  }

  return people;
}

/**
 * Extract team members using AI from website content or search results
 */
async function extractTeamMembersAI(websiteUrl, fundName, searchResults) {
  // First try LinkedIn people search (doesn't require AI)
  const linkedInPeople = await searchLinkedInPeople(fundName);
  if (linkedInPeople.length >= 2) {
    console.log(`[Team] Found ${linkedInPeople.length} people via LinkedIn search`);
    return linkedInPeople;
  }

  if (!openai) {
    console.log(`[Team] OpenAI not configured, returning LinkedIn results only`);
    return linkedInPeople;
  }

  try {
    let content = '';

    // Try to get team page from website
    if (websiteUrl) {
      const teamPages = ['/team', '/about', '/people', '/about-us', '/our-team'];
      for (const path of teamPages) {
        try {
          const baseUrl = websiteUrl.replace(/\/$/, '');
          const response = await fetch(baseUrl + path, { timeout: 5000 });
          if (response.ok) {
            const html = await response.text();
            if (html.includes('Partner') || html.includes('Managing') || html.includes('Founder')) {
              content = html.slice(0, 10000);
              console.log(`[Team AI] Found team page at ${path}`);
              break;
            }
          }
        } catch (e) {
          // Continue to next path
        }
      }
    }

    // Fall back to search results descriptions
    if (!content && searchResults && searchResults.web && searchResults.web.results) {
      content = searchResults.web.results
        .slice(0, 8)
        .map(r => `${r.title}: ${r.description || ''}`)
        .join('\n');
    }

    if (!content || content.length < 100) {
      console.log(`[Team AI] Not enough content to extract team`);
      return [];
    }

    console.log(`[Team AI] Extracting team from ${content.length} chars...`);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Extract investment team members from the content. Focus on Managing Partners, General Partners, Partners, Principals. Return JSON array with name, title, and email (if found). Ignore lawyers, accountants, and administrative staff."
        },
        {
          role: "user",
          content: `Extract team members from ${fundName}:\n\n${content}\n\nReturn JSON: [{"name": "John Smith", "title": "Managing Partner", "email": "john@fund.com"}, ...]`
        }
      ],
      temperature: 0,
      max_tokens: 500
    });

    const aiResponse = completion.choices[0].message.content.trim();

    // Parse JSON
    let team = [];
    try {
      team = JSON.parse(aiResponse);
    } catch (e) {
      const jsonMatch = aiResponse.match(/\[.*\]/s);
      if (jsonMatch) team = JSON.parse(jsonMatch[0]);
    }

    if (Array.isArray(team) && team.length > 0) {
      console.log(`[Team AI] Found ${team.length} team members`);
      return team.slice(0, 10); // Limit to 10
    }

    return [];
  } catch (error) {
    console.error(`[Team AI] Error:`, error.message);
    return [];
  }
}

/**
 * Classify fund type based on search results
 * Simple pattern matching (Phase 1)
 * Phase 2: Replace with AI classification
 */
function classifyFundType(name, searchResults) {
  if (!searchResults || !searchResults.web || !searchResults.web.results) {
    return 'Unknown';
  }

  // Check if platform SPV
  if (isPlatformSPV(name)) {
    return 'SPV Platform';
  }

  // Get all text from results
  const allText = searchResults.web.results
    .slice(0, 5)
    .map(r => `${r.title} ${r.description || ''}`)
    .join(' ')
    .toLowerCase();

  // Pattern matching for fund types
  const patterns = {
    'Operating Company': [/we build|our product|our customers|our platform|we develop/i],
    'VC': [/venture capital|vc fund|seed|series a|pre-seed|early[- ]stage startup/i],
    'PE': [/private equity|buyout|acquisition|growth equity/i],
    'Real Estate': [/real estate|property|reit|multifamily|commercial real estate/i],
    'Hedge Fund': [/hedge fund|long.short|trading|market neutral/i],
    'Credit': [/credit fund|lending|debt fund|mezzanine/i],
    'Charitable Trust': [/charitable trust|steward ownership|non[- ]?profit/i]
  };

  // Operating company detection (check if NOT investing)
  const isOperating = patterns['Operating Company'].some(p => p.test(allText)) &&
                     !/portfolio|investments|we invest|capital/i.test(allText);
  if (isOperating) return 'Operating Company';

  // Check other fund types
  for (const [type, typePatterns] of Object.entries(patterns)) {
    if (type === 'Operating Company') continue; // Already checked
    if (typePatterns.some(p => p.test(allText))) {
      return type;
    }
  }

  return 'Unknown';
}

/**
 * Extract investment stage from search results
 */
function extractInvestmentStage(searchResults) {
  if (!searchResults || !searchResults.web || !searchResults.web.results) {
    return null;
  }

  const allText = searchResults.web.results
    .slice(0, 5)
    .map(r => `${r.title} ${r.description || ''}`)
    .join(' ')
    .toLowerCase();

  const stages = [];

  if (/pre[- ]?seed/i.test(allText)) stages.push('Pre-seed');
  if (/\bseed\b/i.test(allText)) stages.push('Seed');
  if (/series a/i.test(allText)) stages.push('Series A');
  if (/series b/i.test(allText)) stages.push('Series B');
  if (/growth/i.test(allText)) stages.push('Growth');
  if (/late[- ]?stage/i.test(allText)) stages.push('Late-stage');

  if (stages.length === 0) return null;
  if (stages.length === 1) return stages[0];
  return `${stages[0]} to ${stages[stages.length - 1]}`;
}

/**
 * Calculate confidence score based on data quality
 */
function calculateConfidence(data) {
  let score = 0;

  // Website found and appears valid (40%)
  if (data.website && !data.website.includes('crunchbase') && !data.website.includes('linkedin')) {
    score += 0.4;
  }

  // LinkedIn found (20%)
  if (data.linkedinUrl) {
    score += 0.2;
  }

  // Fund type identified (not Unknown) (20%)
  if (data.fundType && data.fundType !== 'Unknown') {
    score += 0.2;
  }

  // Investment stage identified (10%)
  if (data.investmentStage) {
    score += 0.1;
  }

  // Multiple data sources (10%)
  if (data.dataSources && data.dataSources.length >= 2) {
    score += 0.1;
  }

  return Math.min(score, 1.0);
}

/**
 * Determine if data should be auto-published
 */
function shouldAutoPublish(data, confidence) {
  return (
    confidence >= CONFIDENCE_THRESHOLD &&
    data.fundType &&
    data.fundType !== 'Unknown' &&
    data.fundType !== 'Operating Company' && // Never auto-publish operating companies
    data.website &&
    !data.website.includes('crunchbase') // Must have real website, not aggregator
  );
}

// ============================================================================
// MAIN ENRICHMENT FUNCTION
// ============================================================================

/**
 * Enrich a single fund manager
 */
async function enrichManager(name) {
  console.log(`[Enrichment] Starting enrichment for: ${name}`);

  const enrichmentData = {
    series_master_llc: name,
    website: null,
    linkedinUrl: null,
    fundType: null,
    investmentStage: null,
    dataSources: [],
    searchQueries: [],
    rawSearchResults: null,
    confidence: 0,
    enrichmentStatus: 'pending',
    flaggedIssues: []
  };

  try {
    // Check if platform SPV first
    if (isPlatformSPV(name)) {
      console.log(`[Enrichment] ${name} identified as platform SPV`);
      enrichmentData.fundType = 'SPV Platform';
      enrichmentData.enrichmentStatus = 'platform_spv';
      enrichmentData.confidence = 1.0;
      return enrichmentData;
    }

    // Parse fund name
    const parsedName = parseFundName(name);
    console.log(`[Enrichment] Parsed name: ${parsedName}`);

    // Check if exists in Form ADV database (registered RIA)
    console.log(`[Enrichment] Checking Form ADV database...`);
    const { data: advData, error: advError } = await advClient
      .from('advisers_enriched')
      .select('*')
      .or(`adviser_name.ilike.%${parsedName}%,adviser_entity_legal_name.ilike.%${parsedName}%`)
      .limit(1)
      .single();

    if (advData && !advError) {
      console.log(`[Enrichment] ✓ Found in Form ADV! CRD: ${advData.crd}`);
      // Pre-fill with ADV data
      enrichmentData.website = advData.website_url || advData.other_website_urls;
      enrichmentData.fundType = 'VC'; // Most RIAs managing funds are VC/PE
      enrichmentData.dataSources.push('form_adv');
      enrichmentData.linkedCRD = advData.crd;
      enrichmentData.hasFormADV = true;
      enrichmentData.advData = {
        crd: advData.crd,
        name: advData.adviser_name || advData.adviser_entity_legal_name,
        aum: advData.assets_under_mgmt_usd,
        location: `${advData.city}, ${advData.state_country}`
      };
      enrichmentData.confidence += 0.3; // Boost confidence
      enrichmentData.dataSources.push('form_adv');
      console.log(`[Enrichment] Pre-filled from ADV: ${enrichmentData.website || 'no website'}`);
    } else {
      console.log(`[Enrichment] Not found in Form ADV database`);
    }

    // Search 1: Basic fund search
    const query1 = `"${parsedName}" venture capital`;
    enrichmentData.searchQueries.push(query1);
    console.log(`[Enrichment] Search query: ${query1}`);

    let searchResults = await search(query1);

    // Fallback: try simpler search if first fails
    if (!searchResults || !searchResults.web || searchResults.web.results.length === 0) {
      console.log(`[Enrichment] First search failed, trying simpler query...`);
      await delay(1000); // Rate limit protection
      const query2 = `"${parsedName}"`;
      enrichmentData.searchQueries.push(query2);
      searchResults = await search(query2);
    }

    if (!searchResults || !searchResults.web || searchResults.web.results.length === 0) {
      console.log(`[Enrichment] No search results found for ${name}`);
      enrichmentData.enrichmentStatus = 'no_data_found';
      enrichmentData.flaggedIssues.push('no_search_results');
      return enrichmentData;
    }

    enrichmentData.rawSearchResults = searchResults;

    // Extract data
    enrichmentData.website = extractWebsite(searchResults);
    enrichmentData.linkedinUrl = extractLinkedIn(searchResults);
    enrichmentData.fundType = classifyFundType(name, searchResults);
    enrichmentData.investmentStage = extractInvestmentStage(searchResults);

    // If no LinkedIn found in main search, do dedicated LinkedIn search
    if (!enrichmentData.linkedinUrl && enrichmentData.website) {
      console.log(`[Enrichment] Searching LinkedIn specifically...`);
      await delay(1000); // Rate limit protection
      enrichmentData.linkedinUrl = await searchLinkedIn(parsedName);
      if (enrichmentData.linkedinUrl) {
        console.log(`[Enrichment] ✓ Found LinkedIn: ${enrichmentData.linkedinUrl}`);
      }
    }

    // Extract team members if we have website or good search results
    if (enrichmentData.website || enrichmentData.confidence >= 0.5) {
      console.log(`[Enrichment] Extracting team members...`);
      enrichmentData.teamMembers = await extractTeamMembersAI(enrichmentData.website, parsedName, searchResults);
      if (enrichmentData.teamMembers && enrichmentData.teamMembers.length > 0) {
        console.log(`[Enrichment] ✓ Found ${enrichmentData.teamMembers.length} team members`);
      }
    }

    // Build data sources list
    if (enrichmentData.website) enrichmentData.dataSources.push('website');
    if (enrichmentData.linkedinUrl) enrichmentData.dataSources.push('linkedin');
    if (enrichmentData.teamMembers && enrichmentData.teamMembers.length > 0) enrichmentData.dataSources.push('team_extracted');
    if (searchResults.web.results.some(r => r.url.includes('crunchbase'))) {
      enrichmentData.dataSources.push('crunchbase');
    }
    if (searchResults.web.results.some(r => r.url.includes('pitchbook'))) {
      enrichmentData.dataSources.push('pitchbook');
    }

    // Calculate confidence
    enrichmentData.confidence = calculateConfidence(enrichmentData);

    // Determine status
    const autoPublish = shouldAutoPublish(enrichmentData, enrichmentData.confidence);

    if (autoPublish) {
      enrichmentData.enrichmentStatus = 'auto_enriched';
    } else if (enrichmentData.confidence >= 0.5) {
      enrichmentData.enrichmentStatus = 'needs_manual_review';
      if (enrichmentData.fundType === 'Unknown') {
        enrichmentData.flaggedIssues.push('unclear_fund_type');
      }
      if (!enrichmentData.website) {
        enrichmentData.flaggedIssues.push('no_website_found');
      }
    } else {
      enrichmentData.enrichmentStatus = 'no_data_found';
    }

    // Extract portfolio companies if we have a website
    if (enrichmentData.website) {
      const portfolioCompanies = await extractPortfolioCompanies(enrichmentData.website, name);
      enrichmentData.portfolioCompanies = portfolioCompanies;
      if (portfolioCompanies.length > 0) {
        console.log(`[Enrichment] ✓ Found ${portfolioCompanies.length} portfolio companies`);
      }
    }

    console.log(`[Enrichment] ${name}: ${enrichmentData.enrichmentStatus} (confidence: ${enrichmentData.confidence})`);

    return enrichmentData;

  } catch (error) {
    console.error(`[Enrichment] Error enriching ${name}:`, error.message);
    enrichmentData.enrichmentStatus = 'no_data_found';
    enrichmentData.flaggedIssues.push(`error: ${error.message}`);
    return enrichmentData;
  }
}

/**
 * Save enrichment data to database
 */
async function saveEnrichment(data) {
  if (!supabase) {
    console.warn('Supabase not configured, skipping save');
    return null;
  }

  try {
    const { data: result, error } = await supabase
      .from('enriched_managers')
      .upsert({
        series_master_llc: data.series_master_llc,
        website_url: data.website,
        fund_type: data.fundType,
        investment_stage: data.investmentStage,
        linkedin_company_url: data.linkedinUrl,
        enrichment_status: data.enrichmentStatus,
        confidence_score: data.confidence,
        enrichment_source: 'automated',
        search_queries_used: data.searchQueries,
        data_sources: data.dataSources,
        raw_search_results: data.rawSearchResults,
        flagged_issues: data.flaggedIssues,
        // Note: team_members column doesn't exist in DB - team data extracted but not persisted
        is_published: data.enrichmentStatus === 'auto_enriched' && data.confidence >= CONFIDENCE_THRESHOLD,
        published_at: (data.enrichmentStatus === 'auto_enriched' && data.confidence >= CONFIDENCE_THRESHOLD) ? new Date().toISOString() : null
      }, {
        onConflict: 'series_master_llc'
      })
      .select();

    if (error) throw error;

    console.log(`[Database] Saved enrichment for ${data.series_master_llc}`);

    // Save portfolio companies if we have any
    if (data.portfolioCompanies && data.portfolioCompanies.length > 0 && result && result[0]) {
      const managerId = result[0].id;

      // Delete existing portfolio companies for this manager first
      await supabase
        .from('portfolio_companies')
        .delete()
        .eq('manager_id', managerId);

      // Insert new portfolio companies
      const portfolioInserts = data.portfolioCompanies.map(company => ({
        manager_id: managerId,
        company_name: company.company_name,
        company_website: company.company_website || null,
        source_url: company.source_url,
        extraction_method: company.extraction_method,
        confidence_score: company.confidence_score
      }));

      const { error: portfolioError } = await supabase
        .from('portfolio_companies')
        .insert(portfolioInserts);

      if (portfolioError) {
        console.error(`[Database] Error saving portfolio companies:`, portfolioError.message);
      } else {
        console.log(`[Database] Saved ${portfolioInserts.length} portfolio companies for ${data.series_master_llc}`);
      }
    }

    return result;

  } catch (error) {
    console.error(`[Database] Error saving enrichment:`, error.message);
    return null;
  }
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

/**
 * Process a batch of managers
 */
async function processBatch(managers, options = {}) {
  const results = {
    total: managers.length,
    auto_enriched: 0,
    needs_review: 0,
    no_data: 0,
    platform_spv: 0,
    errors: 0
  };

  for (const manager of managers) {
    try {
      const enrichmentData = await enrichManager(manager.series_master_llc);

      // Save to database
      await saveEnrichment(enrichmentData);

      // Update counters
      switch (enrichmentData.enrichmentStatus) {
        case 'auto_enriched':
          results.auto_enriched++;
          break;
        case 'needs_manual_review':
          results.needs_review++;
          break;
        case 'platform_spv':
          results.platform_spv++;
          break;
        case 'no_data_found':
          results.no_data++;
          break;
      }

      // Rate limiting (if needed)
      if (options.delayMs) {
        await new Promise(resolve => setTimeout(resolve, options.delayMs));
      }

    } catch (error) {
      console.error(`[Batch] Error processing ${manager.series_master_llc}:`, error.message);
      results.errors++;
    }
  }

  return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  enrichManager,
  saveEnrichment,
  processBatch,
  parseFundName,
  isPlatformSPV,
  classifyFundType,
  calculateConfidence
};

// ============================================================================
// CLI USAGE (for testing)
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node enrichment_engine.js "Fund Name"');
    console.log('Example: node enrichment_engine.js "Ben\'s Bites Fund, LP"');
    process.exit(1);
  }

  const fundName = args[0];

  enrichManager(fundName)
    .then(result => {
      console.log('\n=== ENRICHMENT RESULT ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error('Error:', error.message);
      process.exit(1);
    });
}
