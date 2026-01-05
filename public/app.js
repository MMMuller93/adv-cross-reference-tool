// Cross-Reference Intelligence Platform - Gemini-styled ADV/Form D visualizer
// Matches the exact Gemini TypeScript aesthetic with full data functionality
const { useState, useEffect, useMemo, useRef, useCallback } = React;

// ============================================================================
// CONFIGURATION - Direct Supabase connection (same as 3006 tool)
// ============================================================================
const SUPABASE_ADV_URL = 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const SUPABASE_ADV_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

const SUPABASE_FORMD_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const SUPABASE_FORMD_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const advHeaders = {
  'apikey': SUPABASE_ADV_KEY,
  'Authorization': `Bearer ${SUPABASE_ADV_KEY}`,
  'Content-Type': 'application/json'
};

const formdHeaders = {
  'apikey': SUPABASE_FORMD_KEY,
  'Authorization': `Bearer ${SUPABASE_FORMD_KEY}`,
  'Content-Type': 'application/json'
};

const YEARS = ['2011','2012','2013','2014','2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

// ============================================================================
// SUPABASE AUTH CLIENT
// ============================================================================
const supabase = window.supabase.createClient(SUPABASE_ADV_URL, SUPABASE_ADV_KEY);

// Immediate auth debugging - runs before React
console.log('[Auth Init] URL:', window.location.href);
console.log('[Auth Init] Hash:', window.location.hash ? 'Present (' + window.location.hash.substring(0, 50) + '...)' : 'None');
console.log('[Auth Init] Origin:', window.location.origin);

// MANUAL OAuth hash processing - Supabase auto-detect isn't working
(async function processOAuthHash() {
  const hash = window.location.hash;
  if (hash && hash.includes('access_token')) {
    console.log('[Auth Init] OAuth callback detected! Manually processing tokens...');

    // Parse the hash fragment
    const params = new URLSearchParams(hash.substring(1));
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');

    console.log('[Auth Init] Tokens found:', {
      access_token: access_token ? 'present (' + access_token.length + ' chars)' : 'missing',
      refresh_token: refresh_token ? 'present' : 'missing'
    });

    if (access_token && refresh_token) {
      try {
        // Manually set the session using the tokens from the hash
        const { data, error } = await supabase.auth.setSession({
          access_token,
          refresh_token
        });

        if (error) {
          console.error('[Auth Init] setSession error:', error.message);
        } else if (data.session) {
          console.log('[Auth Init] Session MANUALLY established:', data.session.user?.email);
          // Clean up the URL hash
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }
      } catch (err) {
        console.error('[Auth Init] setSession exception:', err);
      }
    } else {
      console.warn('[Auth Init] Missing tokens in hash');
    }
  } else {
    // No OAuth callback, just check existing session
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.error('[Auth Init] Session error:', error.message);
    } else if (data.session) {
      console.log('[Auth Init] Existing session found:', data.session.user?.email);
    } else {
      console.log('[Auth Init] No existing session');
    }
  }
})();

// ============================================================================
// RATE LIMITING (localStorage-based for anonymous users)
// ============================================================================
const SEARCH_LIMIT = 10;
const STORAGE_KEY = 'pmip_search_count';
const STORAGE_DATE_KEY = 'pmip_search_date';

const getSearchCount = () => {
  const today = new Date().toDateString();
  const storedDate = localStorage.getItem(STORAGE_DATE_KEY);
  if (storedDate !== today) {
    localStorage.setItem(STORAGE_DATE_KEY, today);
    localStorage.setItem(STORAGE_KEY, '0');
    return 0;
  }
  return parseInt(localStorage.getItem(STORAGE_KEY) || '0');
};

const incrementSearchCount = () => {
  const count = getSearchCount() + 1;
  localStorage.setItem(STORAGE_KEY, count.toString());
  return count;
};

const getRemainingSearches = () => SEARCH_LIMIT - getSearchCount();

// ============================================================================
// SEO URL UTILITIES
// ============================================================================
const generateSlug = (name) => {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
};

const parseIdFromSlug = (slug) => {
  const match = slug.match(/^(\d+)-/);
  return match ? match[1] : slug;
};

const getAdviserUrl = (crd, name) => `/adviser/${crd}-${generateSlug(name)}`;
const getFundUrl = (fundId, name) => `/fund/${fundId || 'f'}-${generateSlug(name)}`;

// Parse SEO-friendly path URLs: /adviser/{crd}-{slug} or /fund/{id}-{slug}
const parseSEOPath = () => {
  const path = window.location.pathname;
  const adviserMatch = path.match(/^\/adviser\/(.+)$/);
  if (adviserMatch) {
    return { type: 'adviser', id: parseIdFromSlug(adviserMatch[1]) };
  }
  const fundMatch = path.match(/^\/fund\/(.+)$/);
  if (fundMatch) {
    return { type: 'fund', id: parseIdFromSlug(fundMatch[1]) };
  }
  return null;
};

// ============================================================================
// URL STATE SERIALIZATION
// ============================================================================
// Read state from URL query parameters (for shareable links)
const getStateFromURL = () => {
  const params = new URLSearchParams(window.location.search);
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const seoPath = parseSEOPath();

  return {
    tab: params.get('tab') || 'advisers',
    q: params.get('q') || '',
    state: params.get('state') || '',
    type: params.get('type') || '',
    exemption: params.get('exemption') || '',
    minAum: params.get('minAum') ? parseInt(params.get('minAum')) : 0,
    maxAum: params.get('maxAum') || '',
    strategy: params.get('strategy') || '',
    hasAdv: params.get('hasAdv') || '',
    // New Managers specific
    nmStartDate: params.get('nmStart') || sixMonthsAgo.toISOString().split('T')[0],
    nmEndDate: params.get('nmEnd') || new Date().toISOString().split('T')[0],
    nmFundType: params.get('nmType') || '',
    nmState: params.get('nmState') || '',
    nmHasAdv: params.get('nmHasAdv') || '',
    // Individual entity view (supports both old query param and new SEO path)
    adviser: seoPath?.type === 'adviser' ? seoPath.id : (params.get('adviser') || ''),
    fund: seoPath?.type === 'fund' ? seoPath.id : '',
    seoPath: seoPath
  };
};

// Update URL without page reload (replaceState to avoid polluting history)
const updateURL = (state) => {
  const params = new URLSearchParams();

  // Only add non-default values to keep URL clean
  if (state.tab && state.tab !== 'advisers') params.set('tab', state.tab);
  if (state.q) params.set('q', state.q);
  if (state.state) params.set('state', state.state);
  if (state.type) params.set('type', state.type);
  if (state.exemption) params.set('exemption', state.exemption);
  if (state.minAum > 0) params.set('minAum', state.minAum);
  if (state.maxAum) params.set('maxAum', state.maxAum);
  if (state.strategy) params.set('strategy', state.strategy);
  if (state.hasAdv) params.set('hasAdv', state.hasAdv);

  // New Managers specific (only if on that tab)
  if (state.tab === 'new_managers') {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const defaultStart = sixMonthsAgo.toISOString().split('T')[0];
    const defaultEnd = new Date().toISOString().split('T')[0];

    if (state.nmStartDate && state.nmStartDate !== defaultStart) params.set('nmStart', state.nmStartDate);
    if (state.nmEndDate && state.nmEndDate !== defaultEnd) params.set('nmEnd', state.nmEndDate);
    if (state.nmFundType) params.set('nmType', state.nmFundType);
    if (state.nmState) params.set('nmState', state.nmState);
    if (state.nmHasAdv) params.set('nmHasAdv', state.nmHasAdv);
  }

  // Individual entity view (adviser CRD)
  if (state.adviser) params.set('adviser', state.adviser);

  const queryString = params.toString();
  const newURL = queryString ? `${window.location.pathname}?${queryString}` : window.location.pathname;
  window.history.replaceState({}, '', newURL);
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
// Get effective AUM - use total_aum if available, otherwise find latest yearly value
const getEffectiveAum = (entity) => {
  if (entity.total_aum != null && entity.total_aum !== 0) return entity.total_aum;
  // Try to find the latest yearly AUM value (check from most recent year backwards)
  for (let i = YEARS.length - 1; i >= 0; i--) {
    const yearKey = `aum_${YEARS[i]}`;
    if (entity[yearKey] != null && entity[yearKey] !== 0) {
      return entity[yearKey];
    }
  }
  return null;
};
const parseCurrency = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const parsed = parseFloat(String(value).replace(/[$,]/g, ''));
  return isNaN(parsed) ? null : parsed;
};

// Normalize related party names - only remove N/A values and prefixes
const normalizeRelatedPartyName = (name) => {
  if (!name || name.trim().toUpperCase() === 'N/A') return null;

  let normalized = name;

  // Remove N/A prefix
  normalized = normalized.replace(/^N\/A\s+/i, '');

  // Remove entity type prefixes (LLC, Ltd., etc. at the beginning only)
  normalized = normalized.replace(/^LLC\s+/i, '');
  normalized = normalized.replace(/^Ltd\.?\s+/i, '');
  normalized = normalized.replace(/^Limited\s+/i, '');
  normalized = normalized.replace(/^L\.L\.C\.?\s+/i, '');
  normalized = normalized.replace(/^L\.P\.?\s+/i, '');
  normalized = normalized.replace(/^Inc\.?\s+/i, '');

  // DO NOT REMOVE SUFFIXES - keep "Sydecar LLC", "Belltower Fund Group Ltd.", etc. as-is

  // Remove trailing commas and spaces only
  normalized = normalized.replace(/[,\s]+$/, '').trim();

  // If after normalization we're left with nothing or just N/A, return null
  if (!normalized || normalized.toUpperCase() === 'N/A') return null;

  return normalized;
};

const formatCurrency = (value) => {
  // Handle "Indefinite" values from Form D (SEC filings allow indefinite offering amounts)
  if (typeof value === 'string' && value.toLowerCase() === 'indefinite') return 'Indefinite';
  const num = parseCurrency(value);
  if (num === null || num === 0) return 'N/A';
  if (num >= 1e12) return `$${(num / 1e12).toFixed(1)}T`;
  if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(0)}K`;
  return `$${num.toFixed(0)}`;
};

// Format phone number - handles scientific notation and numeric phone numbers
const formatPhone = (phone) => {
  if (!phone) return null;
  // Convert to string (handles scientific notation like 4.47787E+11)
  let phoneStr = typeof phone === 'number' ? phone.toFixed(0) : String(phone);
  // Remove any non-digit characters except + at start
  const digits = phoneStr.replace(/[^\d+]/g, '');
  if (!digits || digits.length < 7) return phoneStr; // Return as-is if too short
  // Format based on length
  if (digits.length === 10) {
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  } else if (digits.length === 11 && digits[0] === '1') {
    return `+1 (${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  } else if (digits.length > 10) {
    // International format - just add spaces
    return `+${digits.slice(0,-10)} ${digits.slice(-10,-7)} ${digits.slice(-7,-4)} ${digits.slice(-4)}`;
  }
  return phoneStr;
};

const formatFullCurrency = (value) => {
  // Handle "Indefinite" values from Form D
  if (typeof value === 'string' && value.toLowerCase() === 'indefinite') return 'Indefinite';
  const num = parseCurrency(value);
  if (num === null) return 'N/A';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(num);
};

const parseFilingDate = (dateStr) => {
  if (!dateStr) return new Date(0);

  // Check if it's YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }

  // Check if it's DD-MMM-YYYY format
  const monthMap = {
    'JAN': 0, 'FEB': 1, 'MAR': 2, 'APR': 3, 'MAY': 4, 'JUN': 5,
    'JUL': 6, 'AUG': 7, 'SEP': 8, 'OCT': 9, 'NOV': 10, 'DEC': 11
  };

  const match = dateStr.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/i);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = monthMap[match[2].toUpperCase()];
    const year = parseInt(match[3], 10);
    if (month !== undefined) {
      return new Date(year, month, day);
    }
  }

  // Fallback: try native parsing
  return new Date(dateStr);
};

const formatExemptions = (exemptionsStr) => {
  if (!exemptionsStr) return '';

  // Only show 506(b) and 506(c) - don't show 3(c)(1) or 3(c)(7) since badges already show those
  let result = exemptionsStr
    // 506(b) and 506(c) patterns
    .replace(/\b0?6B\b/gi, '506(b)')
    .replace(/\b0?6C\b/gi, '506(c)')
    // Remove 3(c) patterns entirely (they're shown as badges)
    .replace(/\b3C\.7\b/gi, '')
    .replace(/\b3\.C\.7\b/gi, '')
    .replace(/\b3\.c\.7\b/gi, '')
    .replace(/\b3c7\b/gi, '')
    .replace(/\b3C\.1\b/gi, '')
    .replace(/\b3\.C\.1\b/gi, '')
    .replace(/\b3\.c\.1\b/gi, '')
    .replace(/\b3c1\b/gi, '')
    .replace(/\b3C\b/gi, '');

  // Clean up extra commas and whitespace
  result = result
    .replace(/,\s*,/g, ',')  // Remove double commas
    .replace(/^[,\s]+|[,\s]+$/g, '')  // Trim leading/trailing commas and spaces
    .replace(/\s+,/g, ',')  // Remove space before comma
    .replace(/,\s+/g, ', ');  // Ensure single space after comma

  return result;
};

const formatCompactNumber = (value) => {
  if (!value) return '0';
  return new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short' }).format(value);
};

// Parse search query to extract include/exclude terms
// Supports: "anthropic -philanthropic" to include anthropic but exclude philanthropic
// Supports: "exact phrase" for exact phrase matching
const parseSearchQuery = (query) => {
  if (!query || !query.trim()) {
    return { includeTerms: [], excludeTerms: [], exactPhrases: [], apiQuery: '' };
  }

  const includeTerms = [];
  const excludeTerms = [];
  const exactPhrases = [];

  // First extract exact phrases (quoted strings)
  let remaining = query;
  const phraseRegex = /"([^"]+)"/g;
  let match;
  while ((match = phraseRegex.exec(query)) !== null) {
    exactPhrases.push(match[1].toLowerCase());
    remaining = remaining.replace(match[0], ' ');
  }

  // Split remaining into tokens
  const tokens = remaining.split(/\s+/).filter(t => t);

  for (const token of tokens) {
    if (token.startsWith('-') && token.length > 1) {
      // Exclude term
      excludeTerms.push(token.slice(1).toLowerCase());
    } else if (token.startsWith('+') && token.length > 1) {
      // Explicit include (treat same as regular term)
      includeTerms.push(token.slice(1).toLowerCase());
    } else if (token.length > 0) {
      // Regular include term
      includeTerms.push(token.toLowerCase());
    }
  }

  // Build API query from include terms only (backend doesn't support exclusions)
  const apiQuery = includeTerms.join(' ');

  return { includeTerms, excludeTerms, exactPhrases, apiQuery };
};

// Filter results based on parsed search (apply exclusions client-side)
const applySearchFilters = (results, parsedQuery, getSearchableText) => {
  if (!parsedQuery.excludeTerms.length && !parsedQuery.exactPhrases.length) {
    return results;
  }

  return results.filter(item => {
    const text = getSearchableText(item).toLowerCase();

    // Check exact phrases (must contain all)
    for (const phrase of parsedQuery.exactPhrases) {
      if (!text.includes(phrase)) return false;
    }

    // Check exclusions (must not contain any)
    for (const exclude of parsedQuery.excludeTerms) {
      if (text.includes(exclude)) return false;
    }

    return true;
  });
};

const formatDate = (dateStr) => {
  if (!dateStr) return 'N/A';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// Format filing date consistently - handles DD-MMM-YYYY, YYYY-MM-DD, etc.
// Returns YYYY-MM-DD format for consistent sorting
const formatFilingDate = (dateStr) => {
  if (!dateStr || dateStr === '' || dateStr === '-') return '-';
  try {
    const monthMap = {
      'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
      'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
      'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
    };
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      // Check if it's DD-MMM-YYYY format (e.g., "24-JUN-2025")
      if (monthMap[parts[1].toUpperCase()]) {
        const day = parts[0].padStart(2, '0');
        const month = monthMap[parts[1].toUpperCase()];
        const year = parts[2];
        return `${year}-${month}-${day}`;
      }
      // Check if it's YYYY-MM-DD format (already good)
      else if (parts[0].length === 4 && parts[1].length <= 2 && parts[2].length <= 2) {
        return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      }
    }
    // Try parsing as Date
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
    return dateStr;
  } catch (e) {
    return dateStr;
  }
};

// Format date for display (MM/DD/YYYY)
const formatDateDisplay = (dateStr) => {
  if (!dateStr || dateStr === '-') return '-';
  try {
    const normalized = formatFilingDate(dateStr);
    if (normalized === '-' || normalized === dateStr) return dateStr;
    const parts = normalized.split('-');
    if (parts.length === 3) {
      return `${parts[1]}/${parts[2]}/${parts[0]}`;
    }
    return dateStr;
  } catch (e) {
    return dateStr;
  }
};

const formatGrowth = (value) => {
  if (value === null || value === undefined || isNaN(value)) return null;
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
};

const selectBestWebsite = (primary, others) => {
  // Filter out social media and non-professional domains - never show these as manager contact
  const blockedDomains = ['linkedin.com', 'twitter.com', 'facebook.com', 'instagram.com', 'reddit.com', 'youtube.com', 'tiktok.com', 'medium.com', 'substack.com', 'x.com'];
  const isSocial = (url) => url && blockedDomains.some(d => url.toLowerCase().includes(d));
  if (primary && !isSocial(primary)) return primary;
  if (others) {
    const urls = others.split(/[,;\s]+/).filter(u => u && !isSocial(u));
    if (urls.length > 0) return urls[0];
  }
  return primary || null;
};

const normalizeUrl = (url) => {
  if (!url) return null;
  let normalized = url.trim();
  normalized = normalized.replace(/^https?\/\//i, m => m.replace('//', '://'));
  if (!normalized.match(/^https?:\/\//i)) normalized = `https://${normalized}`;
  return normalized;
};

// ============================================================================
// SVG ICONS (Gemini style - 1.5px stroke)
// ============================================================================
const Icon = ({ children, className = "w-4 h-4" }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>{children}</svg>
);
const SearchIcon = (p) => <Icon {...p}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></Icon>;
const BriefcaseIcon = (p) => <Icon {...p}><rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></Icon>;
const Building2Icon = (p) => <Icon {...p}><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></Icon>;
const FileWarningIcon = (p) => <Icon {...p}><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M12 9v4"/><path d="M12 17h.01"/></Icon>;
const PieChartIcon = (p) => <Icon {...p}><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></Icon>;
const SlidersIcon = (p) => <Icon {...p}><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/></Icon>;
const ArrowLeftIcon = (p) => <Icon {...p}><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></Icon>;
const ArrowUpRightIcon = (p) => <Icon {...p}><path d="M7 7h10v10"/><path d="M7 17 17 7"/></Icon>;
const FilterIcon = (p) => <Icon {...p}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></Icon>;
const XIcon = (p) => <Icon {...p}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></Icon>;
const PlusIcon = (p) => <Icon {...p}><path d="M5 12h14"/><path d="M12 5v14"/></Icon>;
const MapPinIcon = (p) => <Icon {...p}><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></Icon>;
const GlobeIcon = (p) => <Icon {...p}><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></Icon>;
const FileTextIcon = (p) => <Icon {...p}><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/></Icon>;
const UsersIcon = (p) => <Icon {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></Icon>;
const MailIcon = (p) => <Icon {...p}><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></Icon>;
const LinkedinIcon = (p) => <Icon {...p}><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect width="4" height="12" x="2" y="9"/><circle cx="4" cy="4" r="2"/></Icon>;
const AlertTriangleIcon = (p) => <Icon {...p}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></Icon>;
const ChevronDownIcon = (p) => <Icon {...p}><path d="m6 9 6 6 6-6"/></Icon>;
const ShareIcon = (p) => <Icon {...p}><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></Icon>;
const MoreHorizontalIcon = (p) => <Icon {...p}><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></Icon>;
const PhoneIcon = (p) => <Icon {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></Icon>;
const ChevronRightIcon = (p) => <Icon {...p}><path d="m9 18 6-6-6-6"/></Icon>;
const CalendarIcon = (p) => <Icon {...p}><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></Icon>;
const TrendingUpIcon = (p) => <Icon {...p}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></Icon>;
const TrendingDownIcon = (p) => <Icon {...p}><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></Icon>;
const UserIcon = (p) => <Icon {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></Icon>;
const LogOutIcon = (p) => <Icon {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></Icon>;
const LockIcon = (p) => <Icon {...p}><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></Icon>;
const CheckIcon = (p) => <Icon {...p}><path d="M20 6 9 17l-5-5"/></Icon>;

// ============================================================================
// PAYWALL MODAL COMPONENT
// ============================================================================
const PaywallModal = ({ isOpen, onClose, onOpenAuth, user }) => {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);

  const handleSubscribe = async () => {
    if (!user?.email) {
      onClose();
      onOpenAuth('signup');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/stripe/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          successUrl: window.location.href,
          cancelUrl: window.location.href,
        }),
      });

      const data = await response.json();

      if (data.error === 'Already subscribed') {
        setError('You already have an active subscription!');
        setLoading(false);
        return;
      }

      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error || 'Failed to create checkout session');
        setLoading(false);
      }
    } catch (err) {
      setError('Failed to connect to payment system');
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[100]" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden border border-gray-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-slate-800 to-slate-700 px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-500/20 rounded-lg flex items-center justify-center">
                <LockIcon className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white font-serif">Upgrade to Professional</h2>
                <p className="text-slate-300 text-xs mt-0.5">Paid subscription required for this feature</p>
              </div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
              <XIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-6">
          {/* Feature Grid - Professional Features */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <div className="bg-slate-50 rounded-lg p-4 border border-slate-100">
              <div className="w-8 h-8 bg-slate-200 rounded-lg flex items-center justify-center mb-2">
                <TrendingUpIcon className="w-4 h-4 text-slate-700" />
              </div>
              <h3 className="text-sm font-semibold text-gray-900 mb-1">New Managers</h3>
              <p className="text-xs text-gray-500 leading-relaxed">Identify emerging fund managers</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-4 border border-slate-100">
              <div className="w-8 h-8 bg-slate-200 rounded-lg flex items-center justify-center mb-2">
                <FileWarningIcon className="w-4 h-4 text-slate-700" />
              </div>
              <h3 className="text-sm font-semibold text-gray-900 mb-1">Intelligence Radar</h3>
              <p className="text-xs text-gray-500 leading-relaxed">Cross-reference ADV and Form D for compliance insights</p>
            </div>
          </div>

          {/* Professional Contact */}
          <div className="bg-slate-50 rounded-lg p-4 mb-4 border border-slate-200">
            <div className="text-center">
              <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Professional Access</div>
              <p className="text-sm text-gray-600">Contact us for pricing and enterprise options</p>
              <a href="mailto:contact@strategicfundpartners.com" className="text-sm font-medium text-slate-800 hover:text-slate-600 mt-1 inline-block">
                contact@strategicfundpartners.com
              </a>
            </div>
          </div>

          {/* Benefits List */}
          <div className="bg-gray-50 rounded-lg p-4 mb-6 border border-gray-100">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">What's Included</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                'New Managers Discovery',
                'Intelligence Radar',
                'Unlimited searches',
                'CSV & JSON exports',
                'Saved search alerts',
                'Priority support'
              ].map((feature, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-gray-700">
                  <CheckIcon className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                  {feature}
                </div>
              ))}
            </div>
          </div>

          {error && (
            <div className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">
              {error}
            </div>
          )}

          {/* CTA Buttons */}
          {!user ? (
            <div className="space-y-2">
              <button
                onClick={() => { onClose(); onOpenAuth('signup'); }}
                className="w-full py-3 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 transition-colors text-sm"
              >
                Create Free Account
              </button>
              <button
                onClick={() => { onClose(); onOpenAuth('login'); }}
                className="w-full py-2.5 border border-gray-200 text-gray-600 rounded-lg font-medium hover:bg-gray-50 transition-colors text-sm"
              >
                Already have access? Sign In
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <a
                href="mailto:contact@strategicfundpartners.com?subject=Professional%20Access%20Request&body=Hi%2C%0A%0AI%27m%20interested%20in%20Professional%20access%20to%20Private%20Fund%20Radar.%0A%0AName%3A%20%0ACompany%3A%20%0AUse%20Case%3A%20%0A%0APlease%20let%20me%20know%20the%20pricing%20and%20next%20steps.%0A%0AThank%20you!"
                className="w-full py-3 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 transition-colors text-sm flex items-center justify-center gap-2"
              >
                Request Professional Access
              </a>
              <button
                onClick={handleSubscribe}
                disabled={loading}
                className="w-full py-2.5 border border-slate-300 text-slate-700 rounded-lg font-medium hover:bg-slate-50 transition-colors text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Processing...
                  </>
                ) : (
                  'Start 3-Day Free Trial — then $30/mo'
                )}
              </button>
              <p className="text-center text-xs text-gray-400 mt-1">
                Cancel anytime during trial, no charge
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-gray-50 border-t border-gray-100">
          <p className="text-center text-[11px] text-gray-400">
            Questions? <a href="mailto:contact@strategicfundpartners.com" className="text-gray-600 hover:text-gray-800">contact@strategicfundpartners.com</a>
          </p>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// AUTH MODAL COMPONENT
// ============================================================================
const AuthModal = ({ isOpen, onClose, mode, setMode, user, hasPremiumAccess, onLogout, onShowPaywall }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) throw error;
        setMessage('Check your email to confirm your account.');
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        onClose();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    try {
      await supabase.auth.signOut();
      onLogout();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin
        }
      });
      if (error) throw error;
      // OAuth will redirect, so no need to close modal
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  // If user is logged in, show account info instead of login form
  if (user) {
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100]" onClick={onClose}>
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-sm mx-4 overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          <div className="p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-gray-900 font-serif">Account</h2>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                <XIcon className="w-5 h-5" />
              </button>
            </div>

            {/* User Profile */}
            <div className="flex items-center gap-4 mb-6 pb-6 border-b border-gray-100">
              <div className="h-14 w-14 rounded-full bg-gradient-to-tr from-slate-600 to-slate-700 flex items-center justify-center text-white font-bold text-lg shadow-md">
                {user.email ? user.email.substring(0, 2).toUpperCase() : 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{user.email}</p>
                <div className="flex items-center gap-2 mt-1">
                  {hasPremiumAccess ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
                      Professional
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                      Free Plan
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Account Actions */}
            <div className="space-y-2">
              {!hasPremiumAccess && (
                <button
                  onClick={() => { onClose(); onShowPaywall && onShowPaywall(); }}
                  className="w-full py-2.5 px-4 bg-slate-800 text-white rounded-md font-medium hover:bg-slate-700 transition-colors text-sm flex items-center justify-center gap-2"
                >
                  <TrendingUpIcon className="w-4 h-4" />
                  Upgrade to Professional
                </button>
              )}
              <button
                onClick={handleLogout}
                disabled={loading}
                className="w-full py-2.5 px-4 border border-gray-200 text-gray-700 rounded-md font-medium hover:bg-gray-50 transition-colors text-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <LogOutIcon className="w-4 h-4" />
                {loading ? 'Signing out...' : 'Sign Out'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Login/Signup form for non-logged-in users
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100]" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900 font-serif">
              {mode === 'signup' ? 'Create Account' : 'Sign In'}
            </h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <XIcon className="w-5 h-5" />
            </button>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-600">
              {error}
            </div>
          )}

          {message && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-md text-sm text-green-600">
              {message}
            </div>
          )}

          {/* Google Sign-In Button */}
          <button
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="w-full py-2.5 bg-white border border-gray-300 text-gray-700 rounded-md font-medium hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </button>

          {/* Divider */}
          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-white text-gray-500">or continue with email</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-transparent"
                placeholder="you@example.com"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-transparent"
                placeholder={mode === 'signup' ? 'Min 6 characters' : 'Your password'}
                minLength={6}
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-slate-800 text-white rounded-md font-medium hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Please wait...' : mode === 'signup' ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <div className="mt-4 text-center text-sm text-gray-600">
            {mode === 'signup' ? (
              <>
                Already have an account?{' '}
                <button onClick={() => setMode('login')} className="text-slate-700 font-medium hover:underline">
                  Sign in
                </button>
              </>
            ) : (
              <>
                Don't have an account?{' '}
                <button onClick={() => setMode('signup')} className="text-slate-700 font-medium hover:underline">
                  Create one
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// LOADING OVERLAY WITH SKELETON + COLD-START TOAST
// ============================================================================
const SkeletonRow = () => (
  <div className="flex items-center gap-4 px-6 py-3 border-b border-gray-100 animate-pulse">
    <div className="w-6 h-4 bg-gray-200 rounded" />
    <div className="flex-1">
      <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
      <div className="h-3 bg-gray-100 rounded w-1/2" />
    </div>
    <div className="w-20 h-4 bg-gray-200 rounded" />
    <div className="w-16 h-4 bg-gray-100 rounded" />
  </div>
);

const LoadingOverlay = ({ isLoading }) => {
  if (!isLoading) return null;
  return (
    <div className="absolute inset-0 bg-white z-50 overflow-hidden">
      {/* Skeleton loader */}
      <div className="pt-4">
        {[...Array(12)].map((_, i) => <SkeletonRow key={i} />)}
      </div>
    </div>
  );
};

// ============================================================================
// STEPPED AREA CHART COMPONENT (matches 3006 tool exactly)
// ============================================================================
const HistoricalChart = ({ data, label, color = '#10b981' }) => {
  const chartRef = useRef(null);
  const chartInstance = useRef(null);

  useEffect(() => {
    if (!chartRef.current || !data || data.length === 0) return;
    if (chartInstance.current) chartInstance.current.destroy();

    const ctx = chartRef.current.getContext('2d');
    const values = data.map(d => d.value);
    const isPositive = values.length >= 2 ? values[values.length - 1] >= values[0] : true;
    const lineColor = isPositive ? '#10b981' : '#ef4444';

    chartInstance.current = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(d => d.year),
        datasets: [{
          label,
          data: values,
          stepped: 'after',
          borderColor: lineColor,
          backgroundColor: (context) => {
            const chart = context.chart;
            const { ctx: c, chartArea } = chart;
            if (!chartArea) return null;
            const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            gradient.addColorStop(0.05, isPositive ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)');
            gradient.addColorStop(0.95, isPositive ? 'rgba(16, 185, 129, 0)' : 'rgba(239, 68, 68, 0)');
            return gradient;
          },
          borderWidth: 2,
          fill: true,
          tension: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'white',
            borderColor: '#e5e7eb',
            borderWidth: 1,
            titleColor: '#111827',
            bodyColor: '#111827',
            padding: 12,
            boxPadding: 6,
            usePointStyle: true,
            callbacks: {
              label: (context) => {
                const value = context.parsed.y;
                if (value >= 1e9) return `${label}: $${(value / 1e9).toFixed(2)}B`;
                if (value >= 1e6) return `${label}: $${(value / 1e6).toFixed(2)}M`;
                if (value >= 1e3) return `${label}: $${(value / 1e3).toFixed(2)}K`;
                return `${label}: $${value.toLocaleString()}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#e5e7eb', drawBorder: false, drawTicks: false },
            ticks: { color: '#6b7280', font: { size: 12 }, padding: 8 }
          },
          y: {
            beginAtZero: true,
            min: 0,
            grid: { color: '#e5e7eb', drawBorder: false, drawTicks: false },
            ticks: {
              color: '#6b7280',
              font: { size: 12 },
              padding: 8,
              callback: (val) => {
                if (val >= 1e9) return `$${(val / 1e9).toFixed(0)}B`;
                if (val >= 1e6) return `$${(val / 1e6).toFixed(0)}M`;
                if (val >= 1e3) return `$${(val / 1e3).toFixed(0)}K`;
                return `$${val}`;
              }
            }
          }
        },
        interaction: { intersect: false, mode: 'index' }
      }
    });

    return () => { if (chartInstance.current) chartInstance.current.destroy(); };
  }, [data, label, color]);

  if (!data || data.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-gray-500">
        No historical data available
      </div>
    );
  }

  return <canvas ref={chartRef}></canvas>;
};

// ============================================================================
// SIDEBAR COMPONENT (Gemini style - EXACT match)
// ============================================================================
const Sidebar = ({ activeTab, setActiveTab, filters, setFilters, onResetFilters, user, searchCount, onOpenAuth, onLogout, hasPremiumAccess, onShowPaywall }) => {
  // Premium tabs require sign-in AND payment
  const PREMIUM_TABS = ['new_managers', 'cross_reference'];
  const isPremiumTab = (tabId) => PREMIUM_TABS.includes(tabId);
  const canAccessTab = (tabId) => !isPremiumTab(tabId) || hasPremiumAccess;

  const handleTabClick = (tabId) => {
    if (isPremiumTab(tabId) && !hasPremiumAccess) {
      onShowPaywall();
      return;
    }
    setActiveTab(tabId);
  };

  return (
    <aside className="w-[280px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0 z-30 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)]">
      {/* Brand - Icon only, no branding name */}
      <div className="h-14 flex items-center px-5 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 bg-slate-700 rounded-lg flex items-center justify-center text-white shadow-sm ring-1 ring-black/5">
            <PieChartIcon className="w-4 h-4" />
          </div>
          <div>
            <span className="block text-sm font-bold tracking-tight text-gray-900 leading-none">Private Markets</span>
            <span className="block text-[10px] text-gray-500 font-medium mt-0.5 tracking-wide uppercase">Intelligence Platform</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col py-6 px-4 space-y-8">
        {/* Main Navigation */}
        <div className="space-y-1">
          <div className="px-2 mb-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest">Modules</div>
          {[
            { id: 'advisers', icon: BriefcaseIcon, label: 'Advisers' },
            { id: 'funds', icon: Building2Icon, label: 'Funds' },
            { id: 'new_managers', icon: TrendingUpIcon, label: 'New Managers', premium: true },
            { id: 'cross_reference', icon: FileWarningIcon, label: 'Intelligence Radar', premium: true }
          ].map(item => (
            <button
              key={item.id}
              onClick={() => handleTabClick(item.id)}
              title={item.premium && !hasPremiumAccess ? 'Professional subscription required' : ''}
              className={`w-full flex items-center px-3 py-2 text-xs font-medium rounded-md transition-all duration-200 group relative ${
                item.premium && !hasPremiumAccess
                  ? 'text-gray-400 hover:bg-amber-50/50 hover:text-gray-500 cursor-pointer'
                  : activeTab === item.id
                    ? item.id === 'cross_reference'
                      ? 'bg-slate-100 text-slate-900 shadow-sm ring-1 ring-slate-200'
                      : 'bg-gray-100 text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <item.icon className={`w-4 h-4 mr-3 ${
                item.premium && !hasPremiumAccess
                  ? 'text-gray-300'
                  : activeTab === item.id
                    ? item.id === 'cross_reference' ? 'text-slate-700' : 'text-gray-900'
                    : 'text-gray-400 group-hover:text-gray-600'
              }`} />
              {item.label}
              {/* Premium badge */}
              {item.premium && !hasPremiumAccess && (
                <LockIcon className="ml-auto w-3.5 h-3.5 text-slate-400" />
              )}
              {activeTab === item.id && !item.premium && <span className="absolute right-2.5 top-2.5 w-1.5 h-1.5 rounded-full bg-slate-500"></span>}
            </button>
          ))}
        </div>

        {/* Filter Sections */}
        <div className="space-y-4">
          <div className="px-2 flex items-center justify-between pb-2 border-b border-gray-100">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
              {activeTab === 'advisers' ? 'Adviser Parameters' : activeTab === 'funds' ? 'Fund Parameters' : activeTab === 'new_managers' ? 'Discovery Parameters' : 'Analysis Parameters'}
            </span>
          </div>

          {/* Adviser Filters */}
          {activeTab === 'advisers' && (
            <div className="space-y-5 px-1">
              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">JURISDICTION</label>
                <select
                  className="block w-full px-2.5 py-2 text-[11px] bg-white border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700 appearance-none"
                  value={filters.state}
                  onChange={(e) => setFilters(f => ({ ...f, state: e.target.value }))}
                >
                  <option value="">Global View</option>
                  {US_STATES.map(st => <option key={st} value={st}>{st}</option>)}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">AUM RANGE</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Min ($)"
                    className="w-1/2 px-2.5 py-2 text-[11px] border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700"
                    value={filters.minAum || ''}
                    onChange={(e) => setFilters(f => ({ ...f, minAum: e.target.value ? parseInt(e.target.value.replace(/\D/g, '')) : 0 }))}
                  />
                  <input
                    type="text"
                    placeholder="Max ($)"
                    className="w-1/2 px-2.5 py-2 text-[11px] border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700"
                    value={filters.maxAum || ''}
                    onChange={(e) => setFilters(f => ({ ...f, maxAum: e.target.value ? parseInt(e.target.value.replace(/\D/g, '')) : '' }))}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between py-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Verified Website</label>
                <button
                  onClick={() => setFilters(f => ({ ...f, hasWebsite: !f.hasWebsite }))}
                  className={`w-8 h-4 rounded-full relative transition-colors ${filters.hasWebsite ? 'bg-slate-700' : 'bg-slate-200'}`}
                >
                  <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-all ${filters.hasWebsite ? 'right-0.5' : 'left-0.5'}`}></div>
                </button>
              </div>
            </div>
          )}

          {/* Fund Filters - GEMINI STYLE */}
          {activeTab === 'funds' && (
            <div className="space-y-5 px-1">
              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">STRATEGY</label>
                <select
                  className="block w-full px-2.5 py-2 text-[11px] bg-white border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700 appearance-none"
                  value={filters.strategy}
                  onChange={(e) => setFilters(f => ({ ...f, strategy: e.target.value }))}
                >
                  <option value="">All Strategies</option>
                  <option value="hedge">Hedge Fund</option>
                  <option value="pe">Private Equity Fund</option>
                  <option value="vc">Venture Capital</option>
                  <option value="real_estate">Real Estate Fund</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">JURISDICTION</label>
                <select
                  className="block w-full px-2.5 py-2 text-[11px] bg-white border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700 appearance-none"
                  value={filters.state}
                  onChange={(e) => setFilters(f => ({ ...f, state: e.target.value }))}
                >
                  <option value="">All Jurisdictions</option>
                  {US_STATES.map(st => <option key={st} value={st}>{st}</option>)}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">OFFERING RANGE</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Min ($)"
                    className="w-1/2 px-2.5 py-2 text-[11px] border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700"
                    value={filters.minOffering || ''}
                    onChange={(e) => setFilters(f => ({ ...f, minOffering: e.target.value ? parseInt(e.target.value.replace(/\D/g, '')) : '' }))}
                  />
                  <input
                    type="text"
                    placeholder="Max ($)"
                    className="w-1/2 px-2.5 py-2 text-[11px] border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700"
                    value={filters.maxOffering || ''}
                    onChange={(e) => setFilters(f => ({ ...f, maxOffering: e.target.value ? parseInt(e.target.value.replace(/\D/g, '')) : '' }))}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">EXEMPTION</label>
                <div className="flex border border-slate-200 rounded overflow-hidden">
                  {[{ val: '', label: 'All' }, { val: '3c1', label: '3c1' }, { val: '3c7', label: '3c7' }].map(({ val, label }) => (
                    <button
                      key={val}
                      onClick={() => setFilters(f => ({ ...f, exemption: val }))}
                      className={`flex-1 py-1.5 text-[10px] font-medium transition-all ${filters.exemption === val ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">ADVISER REGISTRATION</label>
                <select
                  className="block w-full px-2.5 py-2 text-[11px] bg-white border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700 appearance-none"
                  value={filters.hasAdv || ''}
                  onChange={(e) => setFilters(f => ({ ...f, hasAdv: e.target.value }))}
                >
                  <option value="">All Funds</option>
                  <option value="yes">Has Form ADV</option>
                  <option value="no">No Form ADV</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">FILING DATE RANGE</label>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-400 w-10">FROM</span>
                    <input
                      type="date"
                      className="flex-1 px-2.5 py-1.5 text-[11px] border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700"
                      value={filters.startDate}
                      onChange={(e) => setFilters(f => ({ ...f, startDate: e.target.value }))}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-400 w-10">TO</span>
                    <input
                      type="date"
                      className="flex-1 px-2.5 py-1.5 text-[11px] border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700"
                      value={filters.endDate}
                      onChange={(e) => setFilters(f => ({ ...f, endDate: e.target.value }))}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Cross Reference / Intelligence Radar Filters */}
          {activeTab === 'cross_reference' && (
            <div className="space-y-4 px-1">
              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">DISCREPANCY TYPE</label>
                <select
                  className="w-full px-2.5 py-1.5 text-[11px] border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700 bg-white"
                  value={filters.discrepancyType || ''}
                  onChange={(e) => setFilters(f => ({ ...f, discrepancyType: e.target.value }))}
                >
                  <option value="">All Types</option>
                  <option value="needs_initial_adv_filing">Needs Initial ADV Filing</option>
                  <option value="overdue_annual_amendment">Overdue Annual Amendment</option>
                  <option value="vc_exemption_violation">VC Exemption Violation</option>
                  <option value="fund_type_mismatch">Fund Type Mismatch</option>
                  <option value="missing_fund_in_adv">Missing Fund in ADV</option>
                  <option value="exemption_mismatch">Exemption Mismatch</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">SEVERITY</label>
                <select
                  className="w-full px-2.5 py-1.5 text-[11px] border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700 bg-white"
                  value={filters.complianceSeverity || ''}
                  onChange={(e) => setFilters(f => ({ ...f, complianceSeverity: e.target.value }))}
                >
                  <option value="">All Severities</option>
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">STATUS</label>
                <select
                  className="w-full px-2.5 py-1.5 text-[11px] border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400 text-slate-700 bg-white"
                  value={filters.complianceStatus || 'active'}
                  onChange={(e) => setFilters(f => ({ ...f, complianceStatus: e.target.value }))}
                >
                  <option value="">All Statuses</option>
                  <option value="active">Active</option>
                  <option value="resolved">Resolved</option>
                  <option value="reviewing">Reviewing</option>
                  <option value="ignored">Ignored</option>
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer - User Section + Reset Filters */}
      <div className="border-t border-gray-200 bg-gray-50/50">
        {/* User Section */}
        {/* Search limit - only for non-premium users */}
        {!hasPremiumAccess && (
          <div className="p-4 border-b border-gray-100">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Searches today</span>
                <span className={`font-medium ${searchCount >= SEARCH_LIMIT ? 'text-red-600' : 'text-gray-700'}`}>
                  {Math.max(0, SEARCH_LIMIT - searchCount)} / {SEARCH_LIMIT}
                </span>
              </div>
              {!user && (
                <button
                  onClick={() => onOpenAuth('login')}
                  className="w-full py-2 px-3 bg-slate-800 text-white text-[11px] font-medium rounded-md hover:bg-slate-700 transition-colors flex items-center justify-center gap-2"
                >
                  <UserIcon className="w-3.5 h-3.5" />
                  Sign In
                </button>
              )}
            </div>
          </div>
        )}

        {/* Reset Filters Button */}
        <div className="p-4">
          <button
            onClick={onResetFilters}
            className="w-full py-2 px-3 border border-gray-200 shadow-sm text-[11px] font-medium rounded-md text-gray-600 bg-white hover:bg-gray-50 hover:text-gray-900 transition-all flex items-center justify-center gap-2"
          >
            <FilterIcon className="w-3.5 h-3.5" />
            Reset Filters
          </button>
        </div>
      </div>
    </aside>
  );
};

// ============================================================================
// ADVISER DETAIL VIEW (Gemini style - matches AdviserDetail.tsx)
// ============================================================================
const AdviserDetailView = ({ adviser, onBack, onNavigateToFund }) => {
  const [funds, setFunds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortField, setSortField] = useState('latest_gross_asset_value');
  const [sortOrder, setSortOrder] = useState('desc');
  const [contactsExpanded, setContactsExpanded] = useState(true);
  const [ownersExpanded, setOwnersExpanded] = useState(false);
  const [serviceProvidersExpanded, setServiceProvidersExpanded] = useState(false);
  const [portfolioExpanded, setPortfolioExpanded] = useState(false);
  const [portfolioCompanies, setPortfolioCompanies] = useState([]);
  const [shareCopied, setShareCopied] = useState(false);

  // Share link handler - copies current URL to clipboard
  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // State for enriched AUM (after aggregating fund GAVs as fallback)
  const [enrichedAumByYear, setEnrichedAumByYear] = useState({});
  const [computedTotalAum, setComputedTotalAum] = useState(null);

  // Build AUM history from enriched data (includes fund GAV fallback)
  const aumHistory = useMemo(() => {
    if (!adviser) return [];
    const history = [];
    YEARS.forEach(year => {
      // Use enriched AUM (with fund GAV fallback) if available, otherwise adviser's direct value
      const enrichedValue = enrichedAumByYear[`aum_${year}`];
      const directValue = parseCurrency(adviser[`aum_${year}`]);
      const value = enrichedValue || directValue;
      if (value && value > 0) history.push({ year, value });
    });
    return history;
  }, [adviser, enrichedAumByYear]);

  // Calculate effective AUM (uses enriched data with fund GAV fallback)
  const effectiveAum = useMemo(() => {
    // If we computed a total from fund GAVs, use that
    if (computedTotalAum) return computedTotalAum;
    // Otherwise fall back to getEffectiveAum on adviser directly
    return getEffectiveAum(adviser);
  }, [adviser, computedTotalAum]);

  // Use database growth rates if available, else calculate from enriched history
  const growthRates = useMemo(() => {
    if (adviser?.growth_rate_1y !== undefined && computedTotalAum === null) {
      return {
        growth_1y: adviser.growth_rate_1y,
        growth_2y: adviser.growth_rate_2y,
        growth_5y: adviser.growth_rate_5y
      };
    }
    // Calculate from enriched history
    if (aumHistory.length < 2) return { growth_1y: null, growth_2y: null, growth_5y: null };
    const sorted = [...aumHistory].sort((a, b) => parseInt(b.year) - parseInt(a.year));
    const current = sorted[0];
    const oneYearAgo = sorted.find(d => parseInt(d.year) === parseInt(current.year) - 1);
    const twoYearsAgo = sorted.find(d => parseInt(d.year) === parseInt(current.year) - 2);
    const fiveYearsAgo = sorted.find(d => parseInt(d.year) === parseInt(current.year) - 5);
    return {
      growth_1y: current && oneYearAgo ? ((current.value - oneYearAgo.value) / oneYearAgo.value) * 100 : null,
      growth_2y: current && twoYearsAgo ? ((current.value - twoYearsAgo.value) / twoYearsAgo.value) * 100 : null,
      growth_5y: current && fiveYearsAgo ? ((current.value - fiveYearsAgo.value) / fiveYearsAgo.value) * 100 : null
    };
  }, [adviser, aumHistory, computedTotalAum]);

  // Fetch ALL funds for this adviser (paginated, matching old tool's approach)
  useEffect(() => {
    if (!adviser?.crd) return;
    const fetchFunds = async () => {
      try {
        // Paginated fetch like old tool
        let allFunds = [];
        let offset = 0;
        const batchSize = 1000;
        let hasMore = true;

        while (hasMore) {
          const res = await fetch(
            `${SUPABASE_ADV_URL}/rest/v1/funds_enriched?adviser_entity_crd=eq.${adviser.crd}&select=*&limit=${batchSize}&offset=${offset}`,
            { headers: advHeaders }
          );
          const data = await res.json();

          if (data && data.length > 0) {
            allFunds = allFunds.concat(data);
            offset += batchSize;
            hasMore = data.length === batchSize;
          } else {
            hasMore = false;
          }
        }

        // Enrich with growth rates (same as old tool)
        const enriched = allFunds.map(fund => {
          const gavHistory = [];
          YEARS.forEach(year => {
            const v = parseCurrency(fund[`gav_${year}`]);
            if (v) gavHistory.push({ year: parseInt(year), value: v });
          });
          gavHistory.sort((a, b) => b.year - a.year);
          const current = gavHistory[0];
          const latestGAV = parseCurrency(fund.latest_gross_asset_value) || current?.value;
          const oneYearAgo = current ? gavHistory.find(d => d.year === current.year - 1) : null;
          const twoYearsAgo = current ? gavHistory.find(d => d.year === current.year - 2) : null;
          const fiveYearsAgo = current ? gavHistory.find(d => d.year === current.year - 5) : null;
          return {
            ...fund,
            latest_gross_asset_value: latestGAV,
            growth_1y: current && oneYearAgo ? ((current.value - oneYearAgo.value) / oneYearAgo.value) * 100 : null,
            growth_2y: current && twoYearsAgo ? ((current.value - twoYearsAgo.value) / twoYearsAgo.value) * 100 : null,
            growth_5y: current && fiveYearsAgo ? ((current.value - fiveYearsAgo.value) / fiveYearsAgo.value) * 100 : null
          };
        });
        setFunds(enriched);

        // === KEY FIX: Aggregate fund GAVs to fill in missing adviser AUM (same as original tool) ===
        if (allFunds.length > 0) {
          // Calculate yearly GAV totals from ALL funds
          const fundYearlyTotals = {};
          allFunds.forEach(fund => {
            YEARS.forEach(year => {
              const gav = parseCurrency(fund[`gav_${year}`]);
              if (gav) {
                if (!fundYearlyTotals[year]) fundYearlyTotals[year] = 0;
                fundYearlyTotals[year] += gav;
              }
            });
          });

          // Build enriched AUM by year: use adviser's value if available, else fund GAV total
          const newEnrichedAum = {};
          YEARS.forEach(year => {
            const adviserAum = parseCurrency(adviser[`aum_${year}`]);
            if (adviserAum) {
              newEnrichedAum[`aum_${year}`] = adviserAum;
            } else if (fundYearlyTotals[year]) {
              newEnrichedAum[`aum_${year}`] = fundYearlyTotals[year];
            }
          });
          setEnrichedAumByYear(newEnrichedAum);

          // Find most recent year with data for total AUM
          const availableYears = YEARS.filter(y => newEnrichedAum[`aum_${y}`]).map(y => parseInt(y)).sort((a, b) => b - a);
          const mostRecentYear = availableYears[0];
          const mostRecentAum = mostRecentYear ? newEnrichedAum[`aum_${mostRecentYear}`] : null;

          // Use adviser's total_aum if available, otherwise use most recent enriched AUM
          const adviserTotalAum = parseCurrency(adviser.total_aum);
          setComputedTotalAum(adviserTotalAum || mostRecentAum);
        }
      } catch (err) {
        console.error('Error fetching funds:', err);
      }
      setLoading(false);
    };
    fetchFunds();
  }, [adviser?.crd, adviser]);

  // Fetch portfolio companies if this adviser has enriched data
  useEffect(() => {
    if (!adviser?.crd) return;

    const fetchPortfolio = async () => {
      try {
        // First check if this adviser exists in enriched_managers (by CRD)
        const enrichedRes = await fetch(`/api/advisers/unified/${adviser.crd}`);
        const enrichedData = await enrichedRes.json();

        if (enrichedData.success && enrichedData.adviser.portfolioCompanies) {
          setPortfolioCompanies(enrichedData.adviser.portfolioCompanies);
        }
      } catch (err) {
        console.error('Error fetching portfolio companies:', err);
      }
    };

    fetchPortfolio();
  }, [adviser?.crd]);

  // Parse owners from semicolon-separated fields
  const owners = useMemo(() => {
    if (!adviser?.owner_title_or_status) return [];
    const titles = (adviser.owner_title_or_status || '').split(';');
    const names = (adviser.owner_full_legal_name || adviser.owner_legal_name || '').split(';');
    const types = (adviser.direct_or_indirect_owner || '').split(';');
    const amounts = (adviser.ownership_amount || '').split(';');
    return titles.map((title, i) => ({
      name: names[i]?.trim() || 'N/A',
      title: title?.trim() || 'N/A',
      type: types[i]?.trim() || 'N/A',
      amount: amounts[i]?.trim() || 'N/A'
    })).filter(o => o.name !== 'N/A');
  }, [adviser]);

  // Aggregate service providers from funds
  const serviceProviders = useMemo(() => {
    const sp = { auditors: new Set(), administrators: new Set(), custodians: new Set(), primeBrokers: new Set() };
    funds.forEach(fund => {
      if (fund.auditing_firm_name) fund.auditing_firm_name.split(';').forEach(n => n.trim() && sp.auditors.add(n.trim()));
      if (fund.administrator_name) fund.administrator_name.split(';').forEach(n => n.trim() && sp.administrators.add(n.trim()));
      if (fund.custodian_name) fund.custodian_name.split(';').forEach(n => n.trim() && n !== 'N' && sp.custodians.add(n.trim()));
      if (fund.prime_broker_name) fund.prime_broker_name.split(';').forEach(n => n.trim() && n !== 'N' && sp.primeBrokers.add(n.trim()));
    });
    return {
      auditors: Array.from(sp.auditors),
      administrators: Array.from(sp.administrators),
      custodians: Array.from(sp.custodians),
      primeBrokers: Array.from(sp.primeBrokers)
    };
  }, [funds]);

  const hasServiceProviders = serviceProviders.auditors.length > 0 || serviceProviders.administrators.length > 0 || serviceProviders.custodians.length > 0 || serviceProviders.primeBrokers.length > 0;

  // Sort funds
  const sortedFunds = useMemo(() => {
    return [...funds].sort((a, b) => {
      let aVal = parseCurrency(a[sortField]) || 0;
      let bVal = parseCurrency(b[sortField]) || 0;
      return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
    });
  }, [funds, sortField, sortOrder]);

  const handleSort = (field) => {
    if (sortField === field) setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
    else { setSortField(field); setSortOrder('desc'); }
  };

  if (!adviser) return null;
  const bestWebsite = selectBestWebsite(adviser.primary_website, adviser.other_websites);
  const name = adviser.adviser_name || adviser.adviser_entity_legal_name || 'Unknown';

  return (
    <div className="flex flex-col h-full bg-gray-50 overflow-y-auto custom-scrollbar relative">
      <LoadingOverlay isLoading={loading} />

      {/* Navigation Bar - EXACT Gemini Style: < BACK | NAME | CRD + buttons */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-20 shrink-0 h-12 flex items-center px-5 justify-between">
        <div className="flex items-center">
          <button onClick={onBack} className="text-[11px] font-medium text-slate-500 hover:text-slate-900 transition-colors flex items-center mr-4">
            <span className="mr-1">&lt;</span> BACK
          </button>
          <span className="text-slate-300 mr-4">|</span>
          <span className="text-[13px] font-semibold text-slate-800 mr-4">{name}</span>
          <span className="text-[10px] font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded">CRD: {adviser.crd}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleShare} className="px-3 py-1.5 border border-slate-200 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-50 bg-white flex items-center gap-1.5 transition-all relative">
            <ShareIcon className="w-3 h-3" /> {shareCopied ? 'Copied!' : 'Share'}
          </button>
          {bestWebsite && (
            <a href={normalizeUrl(bestWebsite)} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 border border-slate-200 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-50 bg-white flex items-center gap-1.5 transition-all">
              <GlobeIcon className="w-3 h-3" /> Website
            </a>
          )}
          <a href={`https://adviserinfo.sec.gov/firm/summary/${adviser.crd}`} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 border border-slate-200 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-50 bg-white flex items-center gap-1.5 transition-all">
            VIEW IAPD <ArrowUpRightIcon className="w-3 h-3" />
          </a>
          {adviser.form_adv_url && (
            <a href={adviser.form_adv_url} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 border border-slate-200 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-50 bg-white flex items-center gap-1.5 transition-all">
              <FileTextIcon className="w-3 h-3" /> Form ADV
            </a>
          )}
        </div>
      </div>

      <div className="p-8 max-w-[1200px] mx-auto w-full">
        {/* Header Section - Gemini Style: Avatar + Serif Name + Stats */}
        <div className="flex items-start gap-8 mb-8">
          {/* Large Avatar */}
          <div className="w-24 h-24 rounded-lg bg-slate-800 flex items-center justify-center text-white font-serif font-medium text-4xl flex-shrink-0">
            {name.charAt(0)}
          </div>

          {/* Name and Badges */}
          <div className="flex-1">
            <h1 className="text-3xl font-serif font-semibold text-slate-900 tracking-tight leading-tight mb-3">{name}</h1>
            <div className="flex items-center gap-3">
              {adviser.type && (
                <span className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                  <Building2Icon className="w-3 h-3 mr-1" />{adviser.type}
                </span>
              )}
              {adviser.state_country && (
                <span className="inline-flex items-center text-[11px] text-slate-500">
                  <MapPinIcon className="w-3 h-3 mr-1" />{adviser.state_country}
                </span>
              )}
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-[10px] font-medium text-emerald-700">
                Status: Approved
              </span>
            </div>
          </div>

          {/* Total AUM on right */}
          <div className="text-right flex-shrink-0">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Total AUM</div>
            <div className="text-3xl font-mono font-bold text-slate-900 tabular-nums tracking-tight">{formatCurrency(effectiveAum)}</div>
          </div>
        </div>

        {/* Two-column layout */}
        <div className="flex gap-8">
          {/* Left Column - Stats + Key Personnel */}
          <div className="w-[320px] flex-shrink-0 space-y-6">
            {/* Stats Grid - FUNDS, EMPLOYEES, Growth Rates */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 border border-slate-200 rounded-lg bg-white">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">FUNDS</div>
                <div className="text-2xl font-bold text-slate-900 tabular-nums">{funds.length}</div>
              </div>
              <div className="p-4 border border-slate-200 rounded-lg bg-white">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">EMPLOYEES</div>
                <div className="text-2xl font-bold text-slate-900 tabular-nums">{adviser.employee_count || 'N/A'}</div>
              </div>
              <div className="p-4 border border-slate-200 rounded-lg bg-white">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">1Y GROWTH</div>
                <div className={`text-xl font-bold tabular-nums ${growthRates.growth_1y !== null ? (growthRates.growth_1y >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-slate-400'}`}>
                  {growthRates.growth_1y !== null ? `${growthRates.growth_1y >= 0 ? '+' : ''}${growthRates.growth_1y.toFixed(1)}%` : 'N/A'}
                </div>
              </div>
              <div className="p-4 border border-slate-200 rounded-lg bg-white">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">2Y GROWTH</div>
                <div className={`text-xl font-bold tabular-nums ${growthRates.growth_2y !== null ? (growthRates.growth_2y >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-slate-400'}`}>
                  {growthRates.growth_2y !== null ? `${growthRates.growth_2y >= 0 ? '+' : ''}${growthRates.growth_2y.toFixed(1)}%` : 'N/A'}
                </div>
              </div>
              <div className="col-span-2 p-4 border border-slate-200 rounded-lg bg-white">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">5Y GROWTH</div>
                <div className={`text-xl font-bold tabular-nums ${growthRates.growth_5y !== null ? (growthRates.growth_5y >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-slate-400'}`}>
                  {growthRates.growth_5y !== null ? `${growthRates.growth_5y >= 0 ? '+' : ''}${growthRates.growth_5y.toFixed(1)}%` : 'N/A'}
                </div>
              </div>
            </div>

            {/* Key Personnel Section */}
            <div>
              <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">KEY PERSONNEL</h3>
              {(adviser.cco_name || adviser.regulatory_contact_name) ? (
                <div className="space-y-4">
                  {/* CCO */}
                  {adviser.cco_name && (
                    <div className="space-y-2">
                      <p className="text-sm font-serif font-semibold text-slate-900">{adviser.cco_name}</p>
                      <p className="text-[11px] text-slate-500">Chief Compliance Officer</p>
                      {adviser.cco_phone && (
                        <div className="flex items-center gap-2">
                          <PhoneIcon className="w-3.5 h-3.5 text-slate-400" />
                          <a href={`tel:${adviser.cco_phone}`} className="text-[11px] font-mono text-slate-600 hover:text-slate-900">{formatPhone(adviser.cco_phone)}</a>
                        </div>
                      )}
                      {adviser.cco_email && (
                        <div className="flex items-center gap-2">
                          <MailIcon className="w-3.5 h-3.5 text-slate-400" />
                          <a href={`mailto:${adviser.cco_email}`} className="text-[11px] text-slate-600 hover:text-slate-900">{adviser.cco_email}</a>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Regulatory Contact */}
                  {adviser.regulatory_contact_name && (
                    <div className={`space-y-2 ${adviser.cco_name ? 'pt-3 border-t border-slate-100' : ''}`}>
                      <p className="text-sm font-serif font-semibold text-slate-900">{adviser.regulatory_contact_name}</p>
                      <p className="text-[11px] text-slate-500">{adviser.regulatory_contact_title || 'Regulatory Contact'}</p>
                      {adviser.regulatory_contact_email && (
                        <div className="flex items-center gap-2">
                          <MailIcon className="w-3.5 h-3.5 text-slate-400" />
                          <a href={`mailto:${adviser.regulatory_contact_email}`} className="text-[11px] text-slate-600 hover:text-slate-900">{adviser.regulatory_contact_email}</a>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-slate-400 italic">Contact information not available</p>
              )}
            </div>

            {/* Contact Info */}
            {adviser.phone_number && (
              <div>
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">CONTACT</h3>
                <div className="flex items-center gap-2">
                  <PhoneIcon className="w-3.5 h-3.5 text-slate-400" />
                  <a href={`tel:${adviser.phone_number}`} className="text-[12px] font-mono text-slate-700 hover:text-slate-900">{formatPhone(adviser.phone_number)}</a>
                </div>
              </div>
            )}

            {/* Exemptions */}
            {(adviser.exemption_2b1 === 'Y' || adviser.exemption_2b2 === 'Y' || adviser.exemption_2b3 === 'Y') && (
              <div>
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">EXEMPTIONS</h3>
                <div className="space-y-1">
                  {adviser.exemption_2b1 === 'Y' && <span className="block text-[11px] text-slate-600">Venture Capital Adviser</span>}
                  {adviser.exemption_2b2 === 'Y' && <span className="block text-[11px] text-slate-600">Private Fund Adviser (&gt;$150M)</span>}
                  {adviser.exemption_2b3 === 'Y' && <span className="block text-[11px] text-slate-600">Former ERA now &gt;$150M</span>}
                </div>
              </div>
            )}
          </div>

          {/* Right Column - Chart */}
          <div className="flex-1">
            <div className="border border-slate-200 rounded-lg bg-white p-6 h-[320px] flex flex-col">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">AUM GROWTH (2011-2025)</h3>
                <div className="flex items-center bg-slate-100 p-0.5 rounded">
                  {['1Y', '3Y', '5Y', 'All'].map(range => (
                    <button key={range} className={`px-2 py-1 text-[10px] font-medium rounded transition-all ${range === 'All' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                      {range}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1">
                <HistoricalChart data={aumHistory} label="AUM" />
              </div>
            </div>
          </div>
        </div>

        {/* Collapsible Sections - OWNERSHIP and SERVICE PROVIDERS */}
        <div className="mt-8 space-y-4">
          {/* Ownership Section */}
          {owners.length > 0 && (
            <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
              <button onClick={() => setOwnersExpanded(!ownersExpanded)} className="w-full px-5 py-3 flex justify-between items-center hover:bg-slate-50 transition-colors">
                <div className="flex items-center gap-2">
                  <UsersIcon className="w-4 h-4 text-slate-400" />
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">OWNERSHIP ({owners.length})</span>
                </div>
                <ChevronDownIcon className={`w-4 h-4 text-slate-400 transition-transform ${ownersExpanded ? 'rotate-180' : ''}`} />
              </button>
              {ownersExpanded && (
                <div className="border-t border-slate-100">
                  {owners.map((owner, i) => (
                    <div key={i} className="px-5 py-3 flex justify-between items-center border-b border-slate-50 last:border-b-0">
                      <div>
                        <p className="text-[13px] font-serif font-semibold text-slate-900 uppercase tracking-wide">{owner.name}</p>
                        <p className="text-[10px] text-slate-500 mt-0.5 uppercase">{owner.title}</p>
                      </div>
                      <span className="text-[11px] font-mono font-medium text-slate-600 bg-slate-100 px-2 py-0.5 rounded">{owner.amount}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Service Providers Section */}
          {hasServiceProviders && (
            <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
              <button onClick={() => setServiceProvidersExpanded(!serviceProvidersExpanded)} className="w-full px-5 py-3 flex justify-between items-center hover:bg-slate-50 transition-colors">
                <div className="flex items-center gap-2">
                  <BriefcaseIcon className="w-4 h-4 text-slate-400" />
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">SERVICE PROVIDERS</span>
                </div>
                <ChevronDownIcon className={`w-4 h-4 text-slate-400 transition-transform ${serviceProvidersExpanded ? 'rotate-180' : ''}`} />
              </button>
              {serviceProvidersExpanded && (
                <div className="border-t border-slate-100 p-5 grid grid-cols-2 gap-6">
                  {serviceProviders.auditors.length > 0 && (
                    <div>
                      <div className="text-[10px] text-slate-500 mb-2 font-bold uppercase tracking-wide">Auditors</div>
                      {serviceProviders.auditors.map((n, i) => <div key={i} className="text-xs text-slate-700 py-1">{n}</div>)}
                    </div>
                  )}
                  {serviceProviders.administrators.length > 0 && (
                    <div>
                      <div className="text-[10px] text-slate-500 mb-2 font-bold uppercase tracking-wide">Administrators</div>
                      {serviceProviders.administrators.map((n, i) => <div key={i} className="text-xs text-slate-700 py-1">{n}</div>)}
                    </div>
                  )}
                  {serviceProviders.custodians.length > 0 && (
                    <div>
                      <div className="text-[10px] text-slate-500 mb-2 font-bold uppercase tracking-wide">Custodians</div>
                      {serviceProviders.custodians.map((n, i) => <div key={i} className="text-xs text-slate-700 py-1">{n}</div>)}
                    </div>
                  )}
                  {serviceProviders.primeBrokers.length > 0 && (
                    <div>
                      <div className="text-[10px] text-slate-500 mb-2 font-bold uppercase tracking-wide">Prime Brokers</div>
                      {serviceProviders.primeBrokers.map((n, i) => <div key={i} className="text-xs text-slate-700 py-1">{n}</div>)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Portfolio Companies Section */}
          {portfolioCompanies.length > 0 && (
            <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
              <button onClick={() => setPortfolioExpanded(!portfolioExpanded)} className="w-full px-5 py-3 flex justify-between items-center hover:bg-slate-50 transition-colors">
                <div className="flex items-center gap-2">
                  <Building2Icon className="w-4 h-4 text-slate-400" />
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">PORTFOLIO COMPANIES ({portfolioCompanies.length})</span>
                </div>
                <ChevronDownIcon className={`w-4 h-4 text-slate-400 transition-transform ${portfolioExpanded ? 'rotate-180' : ''}`} />
              </button>
              {portfolioExpanded && (
                <div className="border-t border-slate-100 p-5">
                  <div className="grid grid-cols-3 gap-4">
                    {portfolioCompanies.map((company, i) => (
                      <div key={i} className="border border-slate-200 rounded-lg p-3 hover:border-slate-300 transition-colors">
                        <div className="text-[13px] font-semibold text-slate-900 mb-1">{company.company_name}</div>
                        {company.company_website && (
                          <a href={company.company_website.startsWith('http') ? company.company_website : `https://${company.company_website}`} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-600 hover:text-blue-800 hover:underline block truncate">
                            {company.company_website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                          </a>
                        )}
                        {company.investment_stage && (
                          <span className="inline-flex items-center mt-2 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide rounded bg-slate-100 text-slate-600">
                            {company.investment_stage}
                          </span>
                        )}
                        {company.source_url && (
                          <div className="mt-2 text-[9px] text-slate-400">
                            Source: {company.extraction_method}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded text-[11px] text-blue-800">
                    <strong>Note:</strong> Portfolio data is automatically extracted from public sources. Accuracy may vary. Confidence: {portfolioCompanies[0]?.confidence_score ? (portfolioCompanies[0].confidence_score * 100).toFixed(0) : 50}%
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* MANAGED FUNDS Section - with growth columns like original */}
        {funds.length > 0 && (
          <div className="mt-8">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">MANAGED FUNDS ({funds.length})</h3>
            <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
              <div className="max-h-[500px] overflow-y-auto">
                <table className="min-w-full">
                  <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                    <tr>
                      <th onClick={() => handleSort('fund_name')} className="px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-slate-100">
                        Fund Name {sortField === 'fund_name' && <span className="ml-1">{sortOrder === 'desc' ? '↓' : '↑'}</span>}
                      </th>
                      <th onClick={() => handleSort('latest_gross_asset_value')} className="px-4 py-3 text-right text-[10px] font-bold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-slate-100">
                        Current GAV {sortField === 'latest_gross_asset_value' && <span className="ml-1">{sortOrder === 'desc' ? '↓' : '↑'}</span>}
                      </th>
                      <th onClick={() => handleSort('growth_1y')} className="px-3 py-3 text-right text-[10px] font-bold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-slate-100">
                        1Y {sortField === 'growth_1y' && <span className="ml-1">{sortOrder === 'desc' ? '↓' : '↑'}</span>}
                      </th>
                      <th onClick={() => handleSort('growth_2y')} className="px-3 py-3 text-right text-[10px] font-bold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-slate-100">
                        2Y {sortField === 'growth_2y' && <span className="ml-1">{sortOrder === 'desc' ? '↓' : '↑'}</span>}
                      </th>
                      <th onClick={() => handleSort('growth_5y')} className="px-3 py-3 text-right text-[10px] font-bold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-slate-100">
                        5Y {sortField === 'growth_5y' && <span className="ml-1">{sortOrder === 'desc' ? '↓' : '↑'}</span>}
                      </th>
                      <th className="px-3 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider">Type</th>
                      <th className="px-3 py-3 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sortedFunds.map((fund, idx) => (
                      <tr key={idx} className="hover:bg-slate-50 cursor-pointer transition-colors group" onClick={() => onNavigateToFund && onNavigateToFund(fund)}>
                        <td className="px-4 py-3">
                          <div className="text-[12px] font-medium text-slate-900 group-hover:text-slate-700">{fund.fund_name}</div>
                          <div className="text-[9px] text-slate-400 font-mono mt-0.5">CIK: {fund.form_d_cik || fund.fund_id || 'N/A'}</div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-[12px] font-mono font-semibold text-slate-900 tabular-nums">{formatCurrency(fund.latest_gross_asset_value)}</span>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <span className={`text-[11px] font-semibold tabular-nums ${fund.growth_1y !== null ? (fund.growth_1y >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-slate-400'}`}>
                            {fund.growth_1y !== null ? `${fund.growth_1y >= 0 ? '+' : ''}${fund.growth_1y.toFixed(1)}%` : 'N/A'}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <span className={`text-[11px] font-semibold tabular-nums ${fund.growth_2y !== null ? (fund.growth_2y >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-slate-400'}`}>
                            {fund.growth_2y !== null ? `${fund.growth_2y >= 0 ? '+' : ''}${fund.growth_2y.toFixed(1)}%` : 'N/A'}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <span className={`text-[11px] font-semibold tabular-nums ${fund.growth_5y !== null ? (fund.growth_5y >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-slate-400'}`}>
                            {fund.growth_5y !== null ? `${fund.growth_5y >= 0 ? '+' : ''}${fund.growth_5y.toFixed(1)}%` : 'N/A'}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap items-center gap-1">
                            {fund.exclusion_3c1 === 'Y' && <span className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-[9px] font-semibold">3(c)(1)</span>}
                            {fund.exclusion_3c7 === 'Y' && <span className="bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded text-[9px] font-semibold">3(c)(7)</span>}
                            {fund.exclusion_3c1 !== 'Y' && fund.exclusion_3c7 !== 'Y' && <span className="text-[11px] text-slate-600">{fund.fund_type || 'HF'}</span>}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <ChevronRightIcon className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// FUND DETAIL VIEW (Gemini style - matches FundDetail.tsx)
// ============================================================================
const FundDetailView = ({ fund, onBack, onNavigateToAdviser }) => {
  const [adviserInfo, setAdviserInfo] = useState(null);
  const [formDMatch, setFormDMatch] = useState(null);

  // Fetch adviser contact info when fund loads
  useEffect(() => {
    if (!fund?.adviser_entity_crd) return;
    const fetchAdviser = async () => {
      try {
        const res = await fetch(`${SUPABASE_ADV_URL}/rest/v1/advisers_enriched?crd=eq.${fund.adviser_entity_crd}&select=*`, { headers: advHeaders });
        const data = await res.json();
        if (data && data.length > 0) setAdviserInfo(data[0]);
      } catch (err) {
        console.error('Error fetching adviser for fund:', err);
      }
    };
    fetchAdviser();
  }, [fund?.adviser_entity_crd]);

  // Fetch Form D match by fund name (if no CIK already)
  useEffect(() => {
    if (fund?.form_d_cik || fund?.cik || !fund?.fund_name) return;
    const fetchFormDMatch = async () => {
      try {
        const res = await fetch(`/api/funds/formd-match?name=${encodeURIComponent(fund.fund_name)}`);
        const data = await res.json();
        if (data?.match) setFormDMatch(data.match);
      } catch (err) {
        console.error('Error fetching Form D match:', err);
      }
    };
    fetchFormDMatch();
  }, [fund?.fund_name, fund?.form_d_cik, fund?.cik]);

  // Build GAV history
  const gavHistory = useMemo(() => {
    if (!fund) return [];
    const history = [];
    YEARS.forEach(year => {
      const value = parseCurrency(fund[`gav_${year}`]);
      if (value && value > 0) history.push({ year, value });
    });
    return history;
  }, [fund]);

  // Calculate growth rates
  const growthRates = useMemo(() => {
    if (gavHistory.length < 2) return { growth_1y: null, growth_2y: null, growth_5y: null };
    const sorted = [...gavHistory].sort((a, b) => parseInt(b.year) - parseInt(a.year));
    const current = sorted[0];
    const oneYearAgo = sorted.find(d => parseInt(d.year) === parseInt(current.year) - 1);
    const twoYearsAgo = sorted.find(d => parseInt(d.year) === parseInt(current.year) - 2);
    const fiveYearsAgo = sorted.find(d => parseInt(d.year) === parseInt(current.year) - 5);
    return {
      growth_1y: current && oneYearAgo ? ((current.value - oneYearAgo.value) / oneYearAgo.value) * 100 : null,
      growth_2y: current && twoYearsAgo ? ((current.value - twoYearsAgo.value) / twoYearsAgo.value) * 100 : null,
      growth_5y: current && fiveYearsAgo ? ((current.value - fiveYearsAgo.value) / fiveYearsAgo.value) * 100 : null
    };
  }, [gavHistory]);

  if (!fund) return null;
  const latestGAV = parseCurrency(fund.latest_gross_asset_value) || (gavHistory.length > 0 ? gavHistory[gavHistory.length - 1].value : null);

  // Get contact info from adviser if available, fallback to fund fields
  const adviserWebsite = selectBestWebsite(adviserInfo?.primary_website, adviserInfo?.other_websites) || fund.adviser_website;
  const adviserPhone = adviserInfo?.phone_number || fund.adviser_phone;
  const adviserEmail = adviserInfo?.cco_email || fund.adviser_email;
  const adviserAddress = adviserInfo?.state_country || fund.adviser_state;

  // Build SEC links (use Form D match if no direct CIK)
  const effectiveCik = fund.form_d_cik || fund.cik || formDMatch?.cik;
  const secEdgarUrl = effectiveCik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${effectiveCik}&type=D&dateb=&owner=include&count=40` : null;
  const iapdUrl = fund.adviser_entity_crd ? `https://adviserinfo.sec.gov/firm/summary/${fund.adviser_entity_crd}` : null;

  // Form D data (from cross-reference match or direct formDMatch fallback)
  const formDOfferingAmount = fund.form_d_amount_sold || fund.form_d_offering_amount || formDMatch?.totalamountsold || formDMatch?.totalofferingamount;
  const formDFilingDate = fund.form_d_filing_date || formDMatch?.filing_date;
  const formDExemptions = fund.form_d_exemptions || formDMatch?.federalexemptions_items_list;
  const formDSaleDate = fund.form_d_sale_date || fund.first_sale_date || formDMatch?.sale_date;

  return (
    <div className="flex flex-col h-full bg-white overflow-y-auto custom-scrollbar">
      {/* Navigation Header - Gemini Style with Breadcrumb */}
      <div className="bg-white/90 backdrop-blur-sm border-b border-gray-200 sticky top-0 z-20 shrink-0 h-14 flex items-center px-6 justify-between">
        <div className="flex items-center space-x-4">
          <button onClick={onBack} className="p-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors">
            <ArrowLeftIcon className="w-4 h-4" />
          </button>
          <div className="flex items-center space-x-2 text-xs">
            <span className="text-gray-500 hover:text-gray-900 cursor-pointer transition-colors" onClick={onBack}>Dashboard</span>
            <span className="text-gray-300">/</span>
            <span className="text-gray-500">Funds</span>
            <span className="text-gray-300">/</span>
            <span className="font-semibold text-gray-900 truncate max-w-md">{fund.fund_name}</span>
          </div>
        </div>
        <span className="text-[10px] font-mono text-gray-500 bg-gray-50 px-2 py-1 rounded-md ring-1 ring-gray-200">CIK: {effectiveCik || 'N/A'}</span>
      </div>

      <div className="p-8 max-w-[1300px] mx-auto w-full">
        {/* Header - Gemini Style */}
        <div className="mb-10 flex justify-between items-start">
          <div>
            <div className="flex items-center space-x-2 mb-3">
              <span className="inline-flex items-center rounded-md bg-gray-100 px-2 py-1 text-[10px] font-medium text-gray-700 ring-1 ring-inset ring-gray-700/10 uppercase tracking-wide">{fund.fund_type || 'HEDGE FUND'}</span>
              {fund.adviser_entity_crd && (
                <a href={`https://adviserinfo.sec.gov/firm/summary/${fund.adviser_entity_crd}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20 hover:bg-emerald-100 transition-colors">
                  ✓ Form ADV
                </a>
              )}
            </div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight mb-1.5 leading-tight">{fund.fund_name}</h1>
            <p className="text-xs text-gray-500 flex items-center gap-2">
              Primary CIK Identifier: <span className="font-mono text-gray-700 font-medium">{effectiveCik || 'N/A'}</span>{formDMatch && !fund.form_d_cik && <span className="ml-2 text-[10px] text-emerald-600">(matched)</span>}
            </p>
          </div>
          <div className="flex gap-3">
            {secEdgarUrl ? (
              <a href={secEdgarUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-gray-700 bg-white border border-gray-200 px-3.5 py-2 rounded-lg hover:bg-gray-50 shadow-sm flex items-center transition-all">
                <FileTextIcon className="w-3.5 h-3.5 mr-2 text-gray-400" /> SEC Edgar
              </a>
            ) : (
              <span className="text-xs font-semibold text-gray-400 bg-gray-50 border border-gray-200 px-3.5 py-2 rounded-lg flex items-center cursor-not-allowed">
                <FileTextIcon className="w-3.5 h-3.5 mr-2 text-gray-300" /> SEC Edgar
              </span>
            )}
            {iapdUrl ? (
              <a href={iapdUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-gray-700 bg-white border border-gray-200 px-3.5 py-2 rounded-lg hover:bg-gray-50 shadow-sm flex items-center transition-all">
                <FileTextIcon className="w-3.5 h-3.5 mr-2 text-gray-400" /> IAPD
              </a>
            ) : (
              <span className="text-xs font-semibold text-gray-400 bg-gray-50 border border-gray-200 px-3.5 py-2 rounded-lg flex items-center cursor-not-allowed">
                <FileTextIcon className="w-3.5 h-3.5 mr-2 text-gray-300" /> IAPD
              </span>
            )}
          </div>
        </div>

        {/* Stats Row - Gemini Style */}
        <div className="grid grid-cols-6 gap-4 mb-8">
          <div className="p-4 border border-gray-200 rounded-lg bg-white shadow-sm">
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Current GAV</div>
            <div className="text-lg font-bold text-gray-900 tabular-nums">{formatCurrency(latestGAV)}</div>
          </div>
          <div className="p-4 border border-gray-200 rounded-lg bg-white shadow-sm">
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">1Y Growth</div>
            <div className={`text-lg font-bold tabular-nums ${growthRates.growth_1y !== null ? (growthRates.growth_1y >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-gray-400'}`}>
              {growthRates.growth_1y !== null ? formatGrowth(growthRates.growth_1y) : 'N/A'}
            </div>
          </div>
          <div className="p-4 border border-gray-200 rounded-lg bg-white shadow-sm">
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">2Y Growth</div>
            <div className={`text-lg font-bold tabular-nums ${growthRates.growth_2y !== null ? (growthRates.growth_2y >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-gray-400'}`}>
              {growthRates.growth_2y !== null ? formatGrowth(growthRates.growth_2y) : 'N/A'}
            </div>
          </div>
          <div className="p-4 border border-gray-200 rounded-lg bg-white shadow-sm">
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">5Y Growth</div>
            <div className={`text-lg font-bold tabular-nums ${growthRates.growth_5y !== null ? (growthRates.growth_5y >= 0 ? 'text-emerald-600' : 'text-red-600') : 'text-gray-400'}`}>
              {growthRates.growth_5y !== null ? formatGrowth(growthRates.growth_5y) : 'N/A'}
            </div>
          </div>
          <div className="p-4 border border-gray-200 rounded-lg bg-white shadow-sm col-span-2 cursor-pointer hover:border-gray-300 transition-colors" onClick={() => onNavigateToAdviser && onNavigateToAdviser(fund.adviser_entity_crd)}>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Adviser</div>
            <div className="text-sm font-bold text-gray-900 truncate hover:text-slate-600 transition-colors">{fund.adviser_entity_legal_name}</div>
            <div className="text-[10px] text-gray-400 font-mono mt-0.5">CRD: {fund.adviser_entity_crd}</div>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-8">
          {/* Main Content Column */}
          <div className="col-span-8 space-y-8">
            {/* GAV History Chart */}
            <div className="border border-gray-200 rounded-lg shadow-sm bg-white h-[320px] p-6 flex flex-col">
              <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-4">Historical GAV (2011-2025)</h3>
              <div className="flex-1 w-full">
                <HistoricalChart data={gavHistory} label="GAV" color="#10b981" />
              </div>
            </div>

            {/* Fund Particulars */}
            <div className="border border-gray-200 rounded-lg shadow-sm bg-white overflow-hidden">
              <div className="bg-gray-50/50 px-6 py-3 border-b border-gray-100 flex justify-between items-center">
                <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Fund Particulars</h3>
              </div>
              <div className="p-6">
                <dl className="grid grid-cols-2 gap-x-12 gap-y-8">
                  <div>
                    <dt className="text-[10px] font-bold text-gray-500 mb-1.5 uppercase tracking-wider">Gross Asset Value (ADV)</dt>
                    <dd className="text-2xl font-bold text-gray-900 tabular-nums tracking-tight font-mono">{formatFullCurrency(latestGAV)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-bold text-gray-500 mb-1.5 uppercase tracking-wider">Total Offering Amount (D)</dt>
                    <dd className="text-2xl font-bold text-gray-900 tracking-tight font-mono">{formDOfferingAmount ? formatFullCurrency(formDOfferingAmount) : 'N/A'}</dd>
                  </div>
                </dl>
                <div className="mt-8 pt-8 border-t border-gray-50 grid grid-cols-3 gap-8">
                  <div>
                    <dt className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">First Sale Date</dt>
                    <dd className="text-[13px] font-medium text-gray-900 tabular-nums">{formDSaleDate ? formatDate(formDSaleDate) : 'N/A'}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Last Form ADV</dt>
                    <dd className="text-[13px] font-medium text-gray-900 tabular-nums">{fund.adv_filing_date ? formatDate(fund.adv_filing_date) : 'N/A'}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Exemptions Claimed</dt>
                    <dd className="text-xs font-medium text-gray-900 flex flex-wrap gap-1.5">
                      {fund.exclusion_3c1 === 'Y' && <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-[11px] font-semibold">3(c)(1)</span>}
                      {fund.exclusion_3c7 === 'Y' && <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-[11px] font-semibold">3(c)(7)</span>}
                      {(fund.federal_exemptions || fund.form_d_exemptions) && (
                        <span className="text-[11px] text-gray-600">{formatExemptions(fund.federal_exemptions || fund.form_d_exemptions)}</span>
                      )}
                      {fund.exclusion_3c1 !== 'Y' && fund.exclusion_3c7 !== 'Y' && !fund.federal_exemptions && !fund.form_d_exemptions && <span className="text-gray-400">None</span>}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Min. Investment</dt>
                    <dd className="text-[13px] font-medium text-gray-900 tabular-nums">{fund.minimum_investment ? formatCurrency(parseCurrency(fund.minimum_investment)) : '$0K'}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Investors</dt>
                    <dd className="text-[13px] font-medium text-gray-900 tabular-nums">{fund.beneficial_owners_count || 'N/A'}</dd>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="col-span-4 space-y-6">
            {/* Manager Contact */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 shadow-sm">
              <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-4">Manager Contact</h3>
              <div className="space-y-3">
                {adviserWebsite && (
                  <a href={normalizeUrl(adviserWebsite)} target="_blank" rel="noopener noreferrer" className="flex items-center cursor-pointer group">
                    <GlobeIcon className="w-3.5 h-3.5 text-gray-400 mr-3" />
                    <span className="text-xs font-medium text-gray-700 border-b border-gray-300 group-hover:border-gray-600 transition-all truncate">{adviserWebsite.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
                  </a>
                )}
                {adviserPhone && (
                  <a href={`tel:${adviserPhone}`} className="flex items-center group cursor-pointer">
                    <PhoneIcon className="w-3.5 h-3.5 text-gray-400 mr-3" />
                    <span className="text-xs font-medium text-gray-700 group-hover:text-gray-900">{adviserPhone}</span>
                  </a>
                )}
                {adviserEmail && (
                  <a href={`mailto:${adviserEmail}`} className="flex items-center group cursor-pointer">
                    <MailIcon className="w-3.5 h-3.5 text-gray-400 mr-3" />
                    <span className="text-xs font-medium text-gray-700 group-hover:text-gray-900">{adviserEmail}</span>
                  </a>
                )}
                {!adviserWebsite && !adviserPhone && !adviserEmail && (
                  <p className="text-xs text-gray-500 italic">Contact information not available</p>
                )}
                <div className="pt-3 border-t border-gray-200 mt-1">
                  <p className="text-[11px] text-gray-600 leading-relaxed pl-6">{adviserAddress || 'N/A'}</p>
                </div>
              </div>
            </div>

            {/* Related Parties */}
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center">
                <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Related Parties</h3>
                <UsersIcon className="w-3.5 h-3.5 text-gray-400" />
              </div>
              <div className="divide-y divide-gray-50">
                {fund.adviser_entity_legal_name && (
                  <div className="px-5 py-3">
                    <div className="text-xs font-semibold text-gray-900">{fund.adviser_entity_legal_name}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">Investment Adviser</div>
                  </div>
                )}
                {fund.general_partner_name && (
                  <div className="px-5 py-3">
                    <div className="text-xs font-semibold text-gray-900">{fund.general_partner_name}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">General Partner</div>
                  </div>
                )}
                {fund.related_names && (() => {
                  const names = fund.related_names.split('|');
                  const roles = fund.related_roles ? fund.related_roles.split('|') : [];
                  const normalized = names.map((n, i) => ({
                    name: normalizeRelatedPartyName(n.trim()),
                    role: roles[i] || 'Related Party'
                  })).filter(item => item.name);

                  return normalized.map((item, i) => (
                    <div key={i} className="px-5 py-3">
                      <div className="text-xs font-semibold text-gray-900">{item.name}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">{item.role.trim()}</div>
                    </div>
                  ));
                })()}
                {!fund.adviser_entity_legal_name && !fund.general_partner_name && !fund.related_names && (
                  <div className="px-5 py-3">
                    <div className="text-xs text-gray-400 italic">No related parties available</div>
                  </div>
                )}
              </div>
            </div>

            {/* Regulatory Filings */}
            <div className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm">
              <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Regulatory Filings</h3>
              <ul className="space-y-1">
                <li className="flex items-center justify-between text-xs group cursor-pointer p-2 hover:bg-gray-50 rounded-md -mx-2 transition-colors">
                  <span className="text-gray-700 flex items-center font-medium">
                    <FileTextIcon className="w-3.5 h-3.5 mr-2.5 text-gray-400 group-hover:text-gray-600 transition-colors" /> Form D Notice
                  </span>
                  <span className="text-[10px] text-gray-400 font-mono">{formDFilingDate ? formatDate(formDFilingDate) : 'N/A'}</span>
                </li>
                {fund.adv_filing_date && (
                  <li className="flex items-center justify-between text-xs group cursor-pointer p-2 hover:bg-gray-50 rounded-md -mx-2 transition-colors">
                    <span className="text-gray-700 flex items-center font-medium">
                      <FileTextIcon className="w-3.5 h-3.5 mr-2.5 text-gray-400 group-hover:text-gray-600 transition-colors" /> ADV Schedule D
                    </span>
                    <span className="text-[10px] text-gray-400 font-mono">{formatDate(fund.adv_filing_date)}</span>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// MAIN APP COMPONENT
// ============================================================================
function App() {
  // Initialize state from URL params (for shareable links)
  const initialURLState = getStateFromURL();

  const [view, setView] = useState('dashboard');
  const [activeTab, setActiveTab] = useState(initialURLState.tab);
  const [selectedAdviser, setSelectedAdviser] = useState(null);
  const [selectedFund, setSelectedFund] = useState(null);
  const [loading, setLoading] = useState(false);

  // Auth state
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [searchCount, setSearchCount] = useState(getSearchCount());

  // Premium access state (requires sign-in AND payment)
  // Whitelisted premium users (for testing/admin)
  const PREMIUM_USERS = ['mmmuller93@gmail.com', 'contact@strategicfundpartners.com'];
  const [hasPremiumAccess, setHasPremiumAccess] = useState(false);
  const [showPaywallModal, setShowPaywallModal] = useState(false);

  // Search & Filter state (initialized from URL)
  const [searchTerm, setSearchTerm] = useState(initialURLState.q);
  const [filters, setFilters] = useState({
    state: initialURLState.state,
    type: initialURLState.type,
    exemption: initialURLState.exemption,
    minAum: initialURLState.minAum,
    maxAum: initialURLState.maxAum,
    strategy: initialURLState.strategy,
    hasAdv: initialURLState.hasAdv,
    minOffering: '',
    maxOffering: '',
    startDate: '',
    endDate: '',
    hasWebsite: false,
    discrepanciesOnly: false,
    overdueAdvOnly: false
  });

  // Data state
  const [advisers, setAdvisers] = useState([]);
  const [funds, setFunds] = useState([]);
  const [crossRefMatches, setCrossRefMatches] = useState([]);
  const [newManagers, setNewManagers] = useState([]);

  // New Manager filters (initialized from URL, default to last 6 months)
  const [nmStartDate, setNmStartDate] = useState(initialURLState.nmStartDate);
  const [nmEndDate, setNmEndDate] = useState(initialURLState.nmEndDate);
  const [nmFundType, setNmFundType] = useState(initialURLState.nmFundType);
  const [nmState, setNmState] = useState(initialURLState.nmState);
  const [nmHasAdv, setNmHasAdv] = useState(initialURLState.nmHasAdv);
  const [expandedManagers, setExpandedManagers] = useState(new Set());

  // New Managers sorting
  const [nmSortField, setNmSortField] = useState('first_filing_date');
  const [nmSortOrder, setNmSortOrder] = useState('desc');

  // Funds sorting (default to most recent filings first)
  const [fundsSortField, setFundsSortField] = useState('filing_date');
  const [fundsSortOrder, setFundsSortOrder] = useState('desc');

  // Export menu state
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef(null);

  // Close export menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auth state listener with OAuth callback handling
  useEffect(() => {
    // Handle OAuth callback - check for tokens in URL hash
    const handleOAuthCallback = async () => {
      const hash = window.location.hash;
      if (hash && hash.includes('access_token')) {
        console.log('[Auth] OAuth callback detected, processing tokens...');
        // Supabase should auto-detect, but let's ensure we get the session
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) {
          console.error('[Auth] Error getting session after OAuth:', error);
        } else if (session) {
          console.log('[Auth] Session established:', session.user?.email);
          setUser(session.user);
          setShowAuthModal(false);
          // Clean up URL hash
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        } else {
          console.log('[Auth] No session found after OAuth callback - possible domain mismatch');
        }
        setAuthLoading(false);
        return true;
      }
      return false;
    };

    // Check for OAuth callback first
    handleOAuthCallback().then((wasCallback) => {
      if (!wasCallback) {
        // Normal session check
        supabase.auth.getSession().then(({ data: { session } }) => {
          console.log('[Auth] Session check:', session ? session.user?.email : 'none');
          setUser(session?.user ?? null);
          setAuthLoading(false);
        });
      }
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('[Auth] Auth state changed:', event, session?.user?.email);
      setUser(session?.user ?? null);
      // Close auth modal on successful login (including OAuth callback)
      if (session?.user) {
        setShowAuthModal(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Check premium access when user changes (via Stripe subscription)
  useEffect(() => {
    const checkSubscription = async () => {
      // Whitelist for admins
      if (user?.email && PREMIUM_USERS.includes(user.email.toLowerCase())) {
        setHasPremiumAccess(true);
        return;
      }

      if (!user?.email) {
        setHasPremiumAccess(false);
        return;
      }

      try {
        const response = await fetch(`/api/stripe/subscription-status?email=${encodeURIComponent(user.email)}`);
        const data = await response.json();
        setHasPremiumAccess(data.hasSubscription);
        console.log('[Stripe] Subscription status:', data.hasSubscription);
      } catch (err) {
        console.error('[Stripe] Error checking subscription:', err);
        setHasPremiumAccess(false);
      }
    };

    checkSubscription();
  }, [user]);

  // Sync state to URL (for shareable links)
  useEffect(() => {
    updateURL({
      tab: activeTab,
      q: searchTerm,
      state: filters.state,
      type: filters.type,
      exemption: filters.exemption,
      minAum: filters.minAum,
      maxAum: filters.maxAum,
      strategy: filters.strategy,
      hasAdv: filters.hasAdv,
      nmStartDate,
      nmEndDate,
      nmFundType,
      nmState,
      nmHasAdv,
      adviser: selectedAdviser?.crd || ''
    });
  }, [activeTab, searchTerm, filters.state, filters.type, filters.exemption, filters.minAum, filters.maxAum, filters.strategy, filters.hasAdv, nmStartDate, nmEndDate, nmFundType, nmState, nmHasAdv, selectedAdviser]);

  // Auto-load adviser or fund from URL on initial load (supports SEO URLs)
  const urlEntityLoadedRef = useRef(false);
  useEffect(() => {
    const loadEntityFromURL = async () => {
      if (urlEntityLoadedRef.current) return;
      urlEntityLoadedRef.current = true;

      // Handle adviser URL (/adviser/{crd}-{slug} or ?adviser={crd})
      const adviserCrd = initialURLState.adviser;
      if (adviserCrd) {
        try {
          const res = await fetch(`${SUPABASE_ADV_URL}/rest/v1/advisers_enriched?crd=eq.${adviserCrd}&select=*`, { headers: advHeaders });
          const data = await res.json();
          if (data && data.length > 0) {
            setSelectedAdviser(data[0]);
            setView('adviser_detail');
          }
        } catch (err) {
          console.error('Error loading adviser from URL:', err);
        }
        return;
      }

      // Handle fund URL (/fund/{id}-{slug})
      const fundId = initialURLState.fund;
      if (fundId) {
        try {
          // Try to load fund by reference_id
          const res = await fetch(`${SUPABASE_ADV_URL}/rest/v1/funds_enriched?reference_id=eq.${fundId}&select=*`, { headers: advHeaders });
          const data = await res.json();
          if (data && data.length > 0) {
            setSelectedFund(data[0]);
            setView('fund_detail');
          }
        } catch (err) {
          console.error('Error loading fund from URL:', err);
        }
      }
    };
    loadEntityFromURL();
  }, []);

  // Handle browser back/forward buttons
  useEffect(() => {
    const handlePopState = () => {
      const seoPath = parseSEOPath();
      if (!seoPath) {
        // Back to dashboard
        setView('dashboard');
        setSelectedAdviser(null);
        setSelectedFund(null);
      }
      // For SEO paths, page will reload and initialURLState handles it
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Auth handlers
  const handleOpenAuth = (mode) => {
    setAuthMode(mode);
    setShowAuthModal(true);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  // ============================================================================
  // EXPORT FUNCTIONS
  // ============================================================================
  const escapeCSV = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const downloadFile = (content, filename, mimeType) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const getExportData = () => {
    switch (activeTab) {
      case 'advisers':
        return { data: advisers, type: 'advisers' };
      case 'funds':
        return { data: funds, type: 'funds' };
      case 'new_managers':
        return { data: newManagers, type: 'new_managers' };
      case 'cross_reference':
        return { data: crossRefMatches, type: 'cross_reference' };
      default:
        return { data: [], type: 'unknown' };
    }
  };

  const exportToCSV = () => {
    // Premium feature check
    if (!hasPremiumAccess) {
      setShowPaywallModal(true);
      setShowExportMenu(false);
      return;
    }

    const { data, type } = getExportData();
    if (!data || data.length === 0) {
      alert('No data to export');
      return;
    }

    let headers, rows;
    const timestamp = new Date().toISOString().split('T')[0];

    switch (type) {
      case 'advisers':
        headers = ['Name', 'CRD', 'State', 'Type', 'AUM', 'Website'];
        rows = data.map(a => [
          escapeCSV(a.adviser_name || a.adviser_entity_legal_name),
          escapeCSV(a.crd),
          escapeCSV(a.state_country),
          escapeCSV(a.type || 'RIA'),
          escapeCSV(getEffectiveAum(a)),
          escapeCSV(a.website_url || a.other_website_urls)
        ]);
        break;
      case 'funds':
        headers = ['Fund Name', 'Adviser', 'CRD', 'Form D Offering', 'ADV AUM', 'Type', 'Exemptions', 'Filing Date', 'State', 'CIK', 'Contact Phone', 'Contact Email', 'Related Parties', 'SEC Filing Link'];
        rows = data.map(f => {
          // Get related parties
          let relatedParties = '';
          if (f.related_names) {
            const names = f.related_names.split('|');
            const roles = f.related_roles ? f.related_roles.split('|') : [];
            relatedParties = names
              .map(n => normalizeRelatedPartyName(n.trim()))
              .filter(n => n) // Remove nulls
              .map((n, i) => `${n}${roles[i] ? ` (${roles[i].trim()})` : ''}`)
              .join('; ');
          }
          // Build SEC link
          const secLink = f.cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${f.cik}&type=D&dateb=&owner=include&count=40` : '';
          return [
            escapeCSV(f.name || f.fund_name),
            escapeCSV(f.adviser_entity_legal_name),
            escapeCSV(f.adviser_entity_crd || f.crd),
            escapeCSV(f.form_d_offering_amount || 'N/A'),
            escapeCSV(f.latest_gross_asset_value || 'N/A'),
            escapeCSV(f.fund_type || f.investmentfundtype || 'N/A'),
            escapeCSV(f.exemptions || f.federalexemptions_items_list || 'N/A'),
            escapeCSV(f.filing_date || f.datesigned || 'N/A'),
            escapeCSV(f.stateorcountry || f.state_country || 'N/A'),
            escapeCSV(f.cik || 'N/A'),
            escapeCSV(f.contactphonenumber || 'N/A'),
            escapeCSV(f.contactemail || 'N/A'),
            escapeCSV(relatedParties || 'N/A'),
            escapeCSV(secLink || 'N/A')
          ];
        });
        break;
      case 'new_managers':
        headers = ['Series Master LLC', 'Fund Count', 'Total Offering', 'First Filing', 'Primary Fund Type', 'Key Person', 'Key Person Role', 'Jurisdictions', 'Related Parties', 'Contact Phone', 'Contact Email'];
        rows = data.map(m => {
          const keyPerson = getKeyPerson(m);
          const primaryType = getPrimaryFundType(m);
          // Get all unique jurisdictions
          const jurisdictions = [...new Set((m.funds || []).map(f => f.stateorcountry).filter(Boolean))].join('; ');
          // Get all related parties
          const allRelatedParties = [...new Set((m.funds || []).flatMap(f => {
            if (!f.related_names) return [];
            const names = f.related_names.split('|');
            const roles = f.related_roles ? f.related_roles.split('|') : [];
            return names
              .map(n => normalizeRelatedPartyName(n.trim()))
              .filter(n => n) // Remove nulls
              .map((n, i) => `${n}${roles[i] ? ` (${roles[i].trim()})` : ''}`);
          }))].join('; ');
          // Get contact info from first fund with contact
          let phone = '', email = '';
          for (const f of (m.funds || [])) {
            if (!phone && f.contactphonenumber) phone = f.contactphonenumber;
            if (!email && f.contactemail) email = f.contactemail;
            if (phone && email) break;
          }
          return [
            escapeCSV(m.series_master_llc),
            escapeCSV(m.fund_count),
            escapeCSV(m.total_offering_amount),
            escapeCSV(m.first_filing_date),
            escapeCSV(primaryType || 'N/A'),
            escapeCSV(keyPerson?.name || 'N/A'),
            escapeCSV(keyPerson?.role || 'N/A'),
            escapeCSV(jurisdictions || 'N/A'),
            escapeCSV(allRelatedParties || 'N/A'),
            escapeCSV(phone || 'N/A'),
            escapeCSV(email || 'N/A')
          ];
        });
        break;
      case 'cross_reference':
        headers = ['ADV Fund Name', 'Adviser', 'Form D Match', 'Issues', 'Match Score'];
        rows = data.map(m => [
          escapeCSV(m.adv_fund_name),
          escapeCSV(m.adviser_entity_legal_name),
          escapeCSV(m.formd_entity_name || 'N/A'),
          escapeCSV(m.issues || 'None'),
          escapeCSV(m.match_score ? `${(m.match_score * 100).toFixed(0)}%` : 'N/A')
        ]);
        break;
      default:
        return;
    }

    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    downloadFile(csvContent, `${type}_export_${timestamp}.csv`, 'text/csv;charset=utf-8;');
    setShowExportMenu(false);
  };

  const exportToMarkdown = () => {
    // Premium feature check
    if (!hasPremiumAccess) {
      setShowPaywallModal(true);
      setShowExportMenu(false);
      return;
    }

    const { data, type } = getExportData();
    if (!data || data.length === 0) {
      alert('No data to export');
      return;
    }

    let headers, rows, title;
    const timestamp = new Date().toISOString().split('T')[0];

    switch (type) {
      case 'advisers':
        title = 'Adviser Registry Export';
        headers = ['Name', 'CRD', 'State', 'Type', 'AUM'];
        rows = data.map(a => [
          a.adviser_name || a.adviser_entity_legal_name || 'N/A',
          a.crd || 'N/A',
          a.state_country || 'N/A',
          a.type || 'RIA',
          formatCurrency(getEffectiveAum(a))
        ]);
        break;
      case 'funds':
        title = 'Private Fund Offerings Export';
        headers = ['Fund Name', 'Adviser', 'AUM/Offering', 'Type', 'State', 'Filing Date', 'Contact'];
        rows = data.map(f => {
          const contact = f.contactemail || f.contactphonenumber || 'N/A';
          return [
            f.name || f.fund_name || 'N/A',
            f.adviser_entity_legal_name || 'N/A',
            formatCurrency(f.latest_gross_asset_value || parseCurrency(f.form_d_offering_amount)),
            f.fund_type || f.investmentfundtype || 'N/A',
            f.stateorcountry || f.state_country || 'N/A',
            formatDate(f.filing_date || f.datesigned) || 'N/A',
            contact
          ];
        });
        break;
      case 'new_managers':
        title = 'New Managers Discovery Export';
        headers = ['Series Master LLC', 'Funds', 'Total Offering', 'First Filing', 'Fund Type', 'Key Person', 'Contact'];
        rows = data.map(m => {
          const keyPerson = getKeyPerson(m);
          const primaryType = getPrimaryFundType(m);
          let contact = 'N/A';
          for (const f of (m.funds || [])) {
            if (f.contactemail) { contact = f.contactemail; break; }
            if (f.contactphonenumber) { contact = f.contactphonenumber; break; }
          }
          return [
            m.series_master_llc || 'N/A',
            String(m.fund_count || 0),
            formatCurrency(m.total_offering_amount),
            formatDate(m.first_filing_date),
            primaryType || 'N/A',
            keyPerson ? `${keyPerson.name}${keyPerson.role ? ` (${keyPerson.role})` : ''}` : 'N/A',
            contact
          ];
        });
        break;
      case 'cross_reference':
        title = 'Private Markets Intelligence Export';
        headers = ['ADV Fund Name', 'Form D Match', 'Issues', 'Score'];
        rows = data.map(m => [
          m.adv_fund_name || 'N/A',
          m.formd_entity_name || 'No match',
          m.issues || 'None',
          m.match_score ? `${(m.match_score * 100).toFixed(0)}%` : 'N/A'
        ]);
        break;
      default:
        return;
    }

    // Build markdown table
    const headerRow = `| ${headers.join(' | ')} |`;
    const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;
    const dataRows = rows.map(row => `| ${row.join(' | ')} |`).join('\n');

    const mdContent = `# ${title}\n\n**Exported:** ${timestamp}\n**Records:** ${data.length}\n\n${headerRow}\n${separatorRow}\n${dataRows}\n`;

    downloadFile(mdContent, `${type}_export_${timestamp}.md`, 'text/markdown;charset=utf-8;');
    setShowExportMenu(false);
  };

  // Helper: Get primary fund type from manager's funds (Form D data only for consistent naming)
  const getPrimaryFundType = (manager) => {
    if (!manager.funds || manager.funds.length === 0) return null;
    const types = manager.funds.map(f => f.investmentfundtype).filter(Boolean);
    if (types.length === 0) return null;
    // Return most common type
    const counts = types.reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  };

  // Helper: Get key person from manager's related parties
  const getKeyPerson = (manager) => {
    if (!manager.funds || manager.funds.length === 0) return null;
    for (const fund of manager.funds) {
      if (fund.related_names) {
        const names = fund.related_names.split('|');
        const roles = fund.related_roles ? fund.related_roles.split('|') : [];

        // Find first valid name (not N/A, after normalization)
        for (let i = 0; i < names.length; i++) {
          const rawName = names[i].trim();
          // Skip "N/A" entries
          if (rawName.toUpperCase() === 'N/A' || !rawName) continue;

          const normalized = normalizeRelatedPartyName(rawName);
          if (normalized) {
            return {
              name: normalized,
              role: (roles[i]?.trim() && roles[i].trim().toUpperCase() !== 'N/A') ? roles[i].trim() : ''
            };
          }
        }
      }
    }
    return null;
  };

  // Helper: Get avatar color based on string
  const getAvatarColor = (str) => {
    // Simple gray background, no bright colors
    return 'from-gray-400 to-gray-500';
  };

  // Helper: Get fund type tag color
  const getFundTypeTagColor = (type) => {
    if (!type) return 'bg-gray-100 text-gray-600';
    const t = type.toLowerCase();
    if (t.includes('venture')) return 'bg-emerald-100 text-emerald-700';
    if (t.includes('private equity')) return 'bg-purple-100 text-purple-700';
    if (t.includes('hedge')) return 'bg-blue-100 text-blue-700';
    if (t.includes('real estate')) return 'bg-amber-100 text-amber-700';
    return 'bg-slate-100 text-slate-600';
  };

  // Fund type options for Form D filings
  const fundTypeOptions = [
    { value: '', label: 'All Fund Types' },
    { value: 'Venture Capital', label: 'Venture Capital' },
    { value: 'Private Equity', label: 'Private Equity' },
    { value: 'Hedge Fund', label: 'Hedge Fund' },
    { value: 'Other Investment', label: 'Other Investment' },
    { value: 'Pooled Investment', label: 'Pooled Investment' },
  ];

  // US State options
  const stateOptions = [
    { value: '', label: 'All Jurisdictions' },
    { value: 'AL', label: 'Alabama' }, { value: 'AK', label: 'Alaska' }, { value: 'AZ', label: 'Arizona' },
    { value: 'AR', label: 'Arkansas' }, { value: 'CA', label: 'California' }, { value: 'CO', label: 'Colorado' },
    { value: 'CT', label: 'Connecticut' }, { value: 'DE', label: 'Delaware' }, { value: 'FL', label: 'Florida' },
    { value: 'GA', label: 'Georgia' }, { value: 'HI', label: 'Hawaii' }, { value: 'ID', label: 'Idaho' },
    { value: 'IL', label: 'Illinois' }, { value: 'IN', label: 'Indiana' }, { value: 'IA', label: 'Iowa' },
    { value: 'KS', label: 'Kansas' }, { value: 'KY', label: 'Kentucky' }, { value: 'LA', label: 'Louisiana' },
    { value: 'ME', label: 'Maine' }, { value: 'MD', label: 'Maryland' }, { value: 'MA', label: 'Massachusetts' },
    { value: 'MI', label: 'Michigan' }, { value: 'MN', label: 'Minnesota' }, { value: 'MS', label: 'Mississippi' },
    { value: 'MO', label: 'Missouri' }, { value: 'MT', label: 'Montana' }, { value: 'NE', label: 'Nebraska' },
    { value: 'NV', label: 'Nevada' }, { value: 'NH', label: 'New Hampshire' }, { value: 'NJ', label: 'New Jersey' },
    { value: 'NM', label: 'New Mexico' }, { value: 'NY', label: 'New York' }, { value: 'NC', label: 'North Carolina' },
    { value: 'ND', label: 'North Dakota' }, { value: 'OH', label: 'Ohio' }, { value: 'OK', label: 'Oklahoma' },
    { value: 'OR', label: 'Oregon' }, { value: 'PA', label: 'Pennsylvania' }, { value: 'RI', label: 'Rhode Island' },
    { value: 'SC', label: 'South Carolina' }, { value: 'SD', label: 'South Dakota' }, { value: 'TN', label: 'Tennessee' },
    { value: 'TX', label: 'Texas' }, { value: 'UT', label: 'Utah' }, { value: 'VT', label: 'Vermont' },
    { value: 'VA', label: 'Virginia' }, { value: 'WA', label: 'Washington' }, { value: 'WV', label: 'West Virginia' },
    { value: 'WI', label: 'Wisconsin' }, { value: 'WY', label: 'Wyoming' }, { value: 'DC', label: 'Washington DC' },
  ];

  // Simple version tracking for each search function to prevent stale results
  const searchVersionRef = useRef({ advisers: 0, funds: 0, crossRef: 0, newManagers: 0 });

  // Fetch advisers
  const searchAdvisers = async (currentSearchTerm, currentFilters) => {
    console.log('[searchAdvisers] Starting adviser search, searchTerm:', currentSearchTerm || '(empty)');

    // Rate limit check for non-premium users (both anonymous and logged-in free users)
    if (!hasPremiumAccess && getSearchCount() >= SEARCH_LIMIT) {
      console.log('[searchAdvisers] Rate limited - showing modal');
      if (!user) {
        setShowAuthModal(true);
        setAuthMode('signup');
      } else {
        setShowPaywallModal(true);
      }
      return;
    }

    const myVersion = ++searchVersionRef.current.advisers;
    console.log('[searchAdvisers] Version:', myVersion, 'hasPremiumAccess:', hasPremiumAccess);
    setLoading(true);

    // Increment search count for non-premium users
    if (!hasPremiumAccess) {
      const newCount = incrementSearchCount();
      setSearchCount(newCount);
    }

    try {
      // Parse search query for include/exclude terms
      const parsedQuery = parseSearchQuery(currentSearchTerm);

      const params = new URLSearchParams();
      if (parsedQuery.apiQuery && parsedQuery.apiQuery.length >= 3) {
        params.append('query', parsedQuery.apiQuery);
      }
      if (currentFilters.state) params.append('state', currentFilters.state);
      if (currentFilters.type) params.append('type', currentFilters.type);
      if (currentFilters.exemption) params.append('exemption', currentFilters.exemption);
      if (currentFilters.minAum > 0) params.append('minAum', currentFilters.minAum / 1000000);
      if (currentFilters.maxAum > 0) params.append('maxAum', currentFilters.maxAum / 1000000);
      params.append('limit', '500');
      params.append('sortBy', 'aum');
      params.append('sortOrder', 'desc');

      console.log('[searchAdvisers] Fetching:', `/api/advisers/search?${params.toString()}`);
      const res = await fetch(`/api/advisers/search?${params.toString()}`);
      const data = await res.json();
      console.log('[searchAdvisers] Response received:', data?.length || 0, 'advisers');

      // Apply search exclusions
      const filteredData = applySearchFilters(data || [], parsedQuery, (adviser) => {
        return [
          adviser.adviser_name || '',
          adviser.type || ''
        ].join(' ');
      });

      // Only update if this is still the latest request
      if (myVersion === searchVersionRef.current.advisers) {
        setAdvisers(filteredData);
        setLoading(false);
      }
    } catch (err) {
      console.error('Error fetching advisers:', err);
      if (myVersion === searchVersionRef.current.advisers) setLoading(false);
    }
  };

  // Fetch funds - default to recent Form D filings sorted by date
  const searchFunds = async (currentSearchTerm, currentFilters) => {
    // Rate limit check for non-premium users
    if (!hasPremiumAccess && getSearchCount() >= SEARCH_LIMIT) {
      if (!user) {
        setShowAuthModal(true);
        setAuthMode('signup');
      } else {
        setShowPaywallModal(true);
      }
      return;
    }

    const myVersion = ++searchVersionRef.current.funds;
    console.log('[searchFunds] Starting fund search, version:', myVersion, 'searchTerm:', currentSearchTerm || '(empty)');
    setLoading(true);

    // Increment search count for non-premium users
    if (!hasPremiumAccess) {
      const newCount = incrementSearchCount();
      setSearchCount(newCount);
    }

    try {
      // Parse search query for include/exclude terms
      // Supports: "anthropic -philanthropic" to exclude philanthropic results
      const parsedQuery = parseSearchQuery(currentSearchTerm);
      console.log('[searchFunds] Parsed query:', parsedQuery);

      // DEFAULT VIEW: Fetch recent Form D filings sorted by date (when no search term)
      // When searching: Also fetch ADV funds and merge (backend requires 5 chars min)
      const hasSearchTerm = parsedQuery.apiQuery && parsedQuery.apiQuery.length >= 5;

      // Always fetch Form D filings (they're the default view)
      const formdParams = new URLSearchParams({ limit: '500' });
      if (hasSearchTerm) {
        formdParams.append('query', parsedQuery.apiQuery);
      }
      if (currentFilters.state) formdParams.append('state', currentFilters.state);

      console.log('[searchFunds] Fetching Form D filings...');
      const formdResponse = await fetch(`/api/funds/formd?${formdParams}`);
      const formdData = await formdResponse.json();
      console.log('[searchFunds] Form D response:', formdData.results?.length, 'results');
      console.log('[searchFunds] First 3 results:', formdData.results?.slice(0, 3).map(r => r.entityname));

      // If searching OR "Has Form ADV" filter is active, also get ADV funds and merge
      let advResults = [];
      if (hasSearchTerm || currentFilters.hasAdv === 'yes') {
        const advParams = new URLSearchParams({
          pageSize: '500',
          sortBy: 'updated_at',
          sortOrder: 'desc'
        });
        if (hasSearchTerm) advParams.append('query', parsedQuery.apiQuery);
        if (currentFilters.exemption === '3c1') advParams.append('exemption3c1', 'yes');
        if (currentFilters.exemption === '3c7') advParams.append('exemption3c7', 'yes');

        console.log('[searchFunds] Fetching ADV funds...');
        const advResponse = await fetch(`/api/funds/adv?${advParams}`);
        const advData = await advResponse.json();
        advResults = advData.results || [];
        console.log('[searchFunds] ADV response:', advResults.length, 'results');
      }

      // Create lookup map and array for Form D filings
      const formdMap = {};
      const formdArray = [];
      (formdData.results || []).forEach(filing => {
        if (filing.entityname) {
          const key = filing.entityname.toLowerCase().trim();
          formdMap[key] = filing;
          formdArray.push({ key, filing });
        }
      });

      // Normalize name for matching - strips punctuation and normalizes whitespace
      const normalizeForMatch = (name) => {
        return name
          .toLowerCase()
          .replace(/[,.'"\-()]/g, ' ')  // Replace punctuation with spaces
          .replace(/\s+/g, ' ')          // Collapse multiple spaces
          .trim();
      };

      // Helper function for fuzzy matching
      const findBestFormDMatch = (advFundName) => {
        const advKey = advFundName.toLowerCase().trim();
        const advNorm = normalizeForMatch(advFundName);

        // Try exact match first (original lowercase)
        if (formdMap[advKey]) {
          return formdMap[advKey];
        }

        // Try normalized exact match (handles punctuation differences)
        let bestMatch = null;
        let bestScore = 0;

        for (const { key, filing } of formdArray) {
          const formdNorm = normalizeForMatch(key);

          // Check for exact normalized match
          if (advNorm === formdNorm) {
            return filing;
          }

          // Fall back to similarity scoring on normalized strings
          const maxLen = Math.max(advNorm.length, formdNorm.length);
          const minLen = Math.min(advNorm.length, formdNorm.length);
          const lengthRatio = minLen / maxLen;
          if (lengthRatio < 0.9) continue;

          // Calculate character similarity on normalized strings
          let matchingChars = 0;
          for (let i = 0; i < maxLen; i++) {
            if (advNorm[i] === formdNorm[i]) {
              matchingChars++;
            }
          }
          const score = matchingChars / maxLen;

          // Require 90%+ match on normalized strings
          if (score > bestScore && score >= 0.90) {
            bestScore = score;
            bestMatch = filing;
          }
        }

        return bestMatch;
      };

      // Build combined results
      let combinedFunds = [];
      const matchedFormDKeys = new Set();

      // Add ADV funds with Form D enrichment
      // Server now provides pre-computed cross-reference data via has_form_d_match, form_d_* fields
      // Also try client-side matching as fallback for any additional Form D filings in search results
      advResults.forEach(fund => {
        // Use server-provided cross-reference data if available, otherwise try client-side match
        const serverHasFormD = fund.has_form_d_match;
        const clientFormD = !serverHasFormD ? findBestFormDMatch(fund.fund_name || '') : null;
        const hasMatch = serverHasFormD || !!clientFormD;

        combinedFunds.push({
          ...fund,
          source: 'adv',
          adv_filing_date: formatFilingDate(fund.updated_at ? fund.updated_at.split('T')[0] : null),
          // Use server Form D data if available, fall back to client-side match
          form_d_filing_date: fund.form_d_filing_date
            ? formatFilingDate(fund.form_d_filing_date)
            : formatFilingDate(clientFormD?.filing_date || clientFormD?.dateoffirstsale || null),
          form_d_offering_amount: fund.form_d_offering_amount || clientFormD?.totalofferingamount || null,
          form_d_amount_sold: fund.form_d_amount_sold || clientFormD?.totalamountsold || null,
          form_d_indefinite: fund.form_d_indefinite || clientFormD?.indefiniteofferingamount || false,
          form_d_cik: clientFormD?.cik || null,
          formd_entity_name: fund.form_d_entity_name || clientFormD?.entityname || null,
          has_form_d_match: hasMatch,
          related_parties_count: (typeof fund.owners === 'string' && fund.owners) ? (fund.owners.match(/;/g) || []).length + 1 : (typeof fund.partner_names === 'string' && fund.partner_names ? fund.partner_names.split(',').length : 0),
          sort_date: formatFilingDate(fund.updated_at || fund.form_d_filing_date || clientFormD?.filing_date),
          related_names: fund.related_names || clientFormD?.related_names || null,
          related_roles: fund.related_roles || clientFormD?.related_roles || null
        });
        // Track matched Form D filings to avoid duplicates
        if (serverHasFormD && fund.form_d_entity_name) {
          matchedFormDKeys.add(fund.form_d_entity_name.toLowerCase().trim());
        }
        if (clientFormD) {
          matchedFormDKeys.add(clientFormD.entityname.toLowerCase().trim());
        }
      });

      // Add remaining Form D filings that didn't match ADV funds
      Object.values(formdMap).forEach(filing => {
        const filingKey = filing.entityname.toLowerCase().trim();
        if (matchedFormDKeys.has(filingKey)) return; // Skip already matched

        combinedFunds.push({
          fund_name: filing.entityname,
          source: 'formd',
          adv_filing_date: null,
          form_d_filing_date: formatFilingDate(filing.filing_date),
          form_d_offering_amount: filing.totalofferingamount,
          form_d_amount_sold: filing.totalamountsold,
          form_d_indefinite: filing.indefiniteofferingamount || false,
          formd_entity_name: filing.entityname,
          has_form_d_match: true,
          cik: filing.cik,
          state_of_organization: filing.stateorcountry,
          federal_exemptions: filing.federalexemptions_items_list,
          investment_fund_type: filing.investmentfundtype,
          related_names: filing.related_names,
          related_roles: filing.related_roles,
          sort_date: formatFilingDate(filing.filing_date)
        });
      });

      // DEDUPLICATION: Remove duplicate entries based on normalized fund name
      // Prefer ADV entries over Form D only, and entries with Form D match over those without
      const dedupeMap = {};
      combinedFunds.forEach(fund => {
        const key = normalizeForMatch(fund.fund_name || fund.formd_entity_name || '');
        if (!key) return;

        const existing = dedupeMap[key];
        if (!existing) {
          dedupeMap[key] = fund;
        } else {
          // Prefer ADV source over Form D only
          const existingIsAdv = existing.source === 'adv';
          const currentIsAdv = fund.source === 'adv';

          if (currentIsAdv && !existingIsAdv) {
            // Replace Form D only with ADV entry
            dedupeMap[key] = fund;
          } else if (currentIsAdv && existingIsAdv) {
            // Both are ADV - prefer the one with Form D match
            if (fund.has_form_d_match && !existing.has_form_d_match) {
              dedupeMap[key] = fund;
            }
          }
          // Otherwise keep existing
        }
      });
      combinedFunds = Object.values(dedupeMap);
      console.log(`[searchFunds] After deduplication: ${combinedFunds.length} unique funds`);

      // Sort by most recent filing date
      combinedFunds.sort((a, b) => {
        const dateA = a.sort_date || '0000-00-00';
        const dateB = b.sort_date || '0000-00-00';
        return dateB.localeCompare(dateA);
      });

      // Apply client-side filters
      let filteredFunds = combinedFunds;

      // Filter by strategy (investment fund type)
      if (currentFilters.strategy) {
        const strategyMap = {
          'hedge': 'Hedge Fund',
          'pe': 'Private Equity Fund',
          'vc': 'Venture Capital Fund',  // Fixed: should be "Venture Capital Fund" not "Venture Capital"
          'real_estate': 'Real Estate Fund'
        };
        const targetStrategy = strategyMap[currentFilters.strategy];
        console.log(`[searchFunds] Filtering by strategy: ${currentFilters.strategy} -> ${targetStrategy}`);
        filteredFunds = filteredFunds.filter(f => {
          const matchInvestmentType = f.investment_fund_type?.toLowerCase().includes(targetStrategy?.toLowerCase() || '');
          const matchFundType = f.fund_type?.toLowerCase().includes(targetStrategy?.toLowerCase() || '');
          return matchInvestmentType || matchFundType;
        });
        console.log(`[searchFunds] After strategy filter: ${filteredFunds.length} funds remain`);
      }

      // Filter by offering amount range (Form D only)
      if (currentFilters.minOffering) {
        filteredFunds = filteredFunds.filter(f => {
          const formDAmount = parseCurrency(f.form_d_offering_amount);
          if (!formDAmount) return false; // Exclude funds without Form D offering amount
          return formDAmount >= currentFilters.minOffering;
        });
      }
      if (currentFilters.maxOffering) {
        filteredFunds = filteredFunds.filter(f => {
          const formDAmount = parseCurrency(f.form_d_offering_amount);
          if (!formDAmount) return false; // Exclude funds without Form D offering amount
          return formDAmount <= currentFilters.maxOffering;
        });
      }

      // Filter by filing date range
      if (currentFilters.startDate) {
        filteredFunds = filteredFunds.filter(f => {
          if (!f.sort_date) return false;
          return f.sort_date >= currentFilters.startDate;
        });
      }
      if (currentFilters.endDate) {
        filteredFunds = filteredFunds.filter(f => {
          if (!f.sort_date) return false;
          return f.sort_date <= currentFilters.endDate;
        });
      }

      console.log('[searchFunds] Combined funds:', combinedFunds.length, ', after filters:', filteredFunds.length);

      // Apply search exclusions (e.g., -philanthropic to exclude results containing "philanthropic")
      const finalFunds = applySearchFilters(filteredFunds, parsedQuery, (fund) => {
        return [
          fund.fund_name || '',
          fund.adviser_entity_legal_name || '',
          fund.formd_entity_name || ''
        ].join(' ');
      });
      console.log('[searchFunds] After exclusion filter:', finalFunds.length);
      console.log('[searchFunds] First 3 filtered:', finalFunds.slice(0, 3).map(f => f.fund_name));

      // Only update if this is still the latest request
      if (myVersion === searchVersionRef.current.funds) {
        console.log('[searchFunds] Setting funds state with', finalFunds.length, 'funds, version:', myVersion);
        // DEBUG: Log first fund's Form D data
        if (finalFunds.length > 0) {
          const f = finalFunds[0];
          console.log('[DEBUG] First fund Form D data:', {
            name: f.fund_name,
            form_d_offering_amount: f.form_d_offering_amount,
            form_d_filing_date: f.form_d_filing_date,
            form_d_entity_name: f.form_d_entity_name,
            has_form_d_match: f.has_form_d_match
          });
        }
        setFunds(finalFunds);
        setLoading(false);
      } else {
        console.log('[searchFunds] SKIPPED update - stale request version', myVersion, 'vs current', searchVersionRef.current.funds);
      }
    } catch (err) {
      console.error('[searchFunds] Error:', err);
      if (myVersion === searchVersionRef.current.funds) setLoading(false);
    }
  };

  // Fetch cross-reference matches
  const fetchCrossRef = async (currentSearchTerm, currentFilters) => {
    const myVersion = ++searchVersionRef.current.crossRef;
    setLoading(true);
    try {
      // Parse search query for modifiers
      const parsedQuery = parseSearchQuery(currentSearchTerm);

      // Use new discrepancy detection API
      const params = new URLSearchParams({ limit: '1000' });
      if (parsedQuery.apiQuery) {
        params.append('searchTerm', parsedQuery.apiQuery);
      }

      // New filter system
      if (currentFilters.discrepancyType) {
        params.append('type', currentFilters.discrepancyType);
      }
      if (currentFilters.complianceSeverity) {
        params.append('severity', currentFilters.complianceSeverity);
      }
      if (currentFilters.complianceStatus) {
        params.append('status', currentFilters.complianceStatus);
      }

      // Legacy filters for backward compatibility
      if (currentFilters.discrepanciesOnly) params.append('severity', 'high,critical');
      if (currentFilters.overdueAdvOnly) params.append('type', 'overdue_annual_amendment,needs_initial_adv_filing');

      // Try new API first, fallback to old API
      let response, result;
      try {
        response = await fetch(`/api/discrepancies?${params}`);
        result = await response.json();
        // Transform new API format to match old format
        if (result.discrepancies) {
          result = {
            success: true,
            matches: result.discrepancies.map(d => ({
              adv_fund_name: d.fund_name || d.entity_name,
              formd_entity_name: d.fund_name || d.entity_name,
              adviser_entity_legal_name: d.entity_name,
              adviser_entity_crd: d.crd,
              issues: d.details?.description || d.type,
              discrepancy_type: d.type,
              severity: d.severity,
              contact_info: d.contact_info
            }))
          };
        }
      } catch (err) {
        console.log('[Intelligence Radar] New API failed, using fallback:', err);
        // Fallback to old API
        const oldParams = new URLSearchParams({ limit: '10000' });
        if (parsedQuery.apiQuery) oldParams.append('searchTerm', parsedQuery.apiQuery);
        if (currentFilters.discrepanciesOnly) oldParams.append('discrepanciesOnly', 'true');
        if (currentFilters.overdueAdvOnly) oldParams.append('overdueAdvOnly', 'true');
        response = await fetch(`/api/browse-computed?${oldParams}`);
        result = await response.json();
      }
      if (myVersion === searchVersionRef.current.crossRef) {
        if (result.success) {
          // Apply client-side filtering for exclusions and exact phrases
          const filtered = applySearchFilters(
            result.matches || [],
            parsedQuery,
            (match) => `${match.adv_fund_name || ''} ${match.formd_entity_name || ''} ${match.adviser_entity_legal_name || ''}`
          );
          setCrossRefMatches(filtered);
        }
        setLoading(false);
      }
    } catch (err) {
      console.error('Error fetching cross-ref:', err);
      if (myVersion === searchVersionRef.current.crossRef) setLoading(false);
    }
  };

  // Fetch new managers
  const fetchNewManagers = async () => {
    const myVersion = ++searchVersionRef.current.newManagers;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (nmStartDate) params.append('startDate', nmStartDate);
      if (nmEndDate) params.append('endDate', nmEndDate);
      if (nmFundType) params.append('fundType', nmFundType);
      if (nmState) params.append('state', nmState);
      const res = await fetch(`/api/funds/new-managers?${params}`);
      const result = await res.json();
      if (myVersion === searchVersionRef.current.newManagers) {
        if (result.success) setNewManagers(result.managers || []);
        setLoading(false);
      }
    } catch (err) {
      console.error('Error fetching new managers:', err);
      if (myVersion === searchVersionRef.current.newManagers) setLoading(false);
    }
  };

  // Handle new managers sorting
  const handleNmSort = (field) => {
    if (nmSortField === field) {
      setNmSortOrder(nmSortOrder === 'desc' ? 'asc' : 'desc');
    } else {
      setNmSortField(field);
      setNmSortOrder('desc');
    }
  };

  // Handle funds sorting
  const handleFundsSort = (field) => {
    if (fundsSortField === field) {
      setFundsSortOrder(fundsSortOrder === 'desc' ? 'asc' : 'desc');
    } else {
      setFundsSortField(field);
      setFundsSortOrder('desc');
    }
  };

  // Filter new managers first
  const filteredNewManagers = React.useMemo(() => {
    return newManagers.filter(manager => {
      // Apply Form ADV filter
      if (nmHasAdv === 'yes' && !manager.has_form_adv) return false;
      if (nmHasAdv === 'no' && manager.has_form_adv) return false;

      return true;
    });
  }, [newManagers, nmHasAdv]);

  // Sorted new managers (with proper date parsing)
  const sortedNewManagers = React.useMemo(() => {
    if (!nmSortField) return filteredNewManagers;

    return [...filteredNewManagers].sort((a, b) => {
      let aVal, bVal;

      if (nmSortField === 'first_filing_date') {
        aVal = parseFilingDate(a.first_filing_date).getTime();
        bVal = parseFilingDate(b.first_filing_date).getTime();
      } else if (nmSortField === 'total_offering_amount') {
        aVal = parseCurrency(a.total_offering_amount) || 0;
        bVal = parseCurrency(b.total_offering_amount) || 0;
      } else if (nmSortField === 'fund_count') {
        aVal = a.fund_count || 0;
        bVal = b.fund_count || 0;
      } else {
        return 0;
      }

      if (nmSortOrder === 'desc') {
        return bVal - aVal;
      } else {
        return aVal - bVal;
      }
    });
  }, [filteredNewManagers, nmSortField, nmSortOrder]);

  // Sorted funds (with proper date parsing and filtering)
  const sortedFunds = React.useMemo(() => {
    // First filter
    let filtered = funds;

    // Filter by has Form ADV
    if (filters.hasAdv === 'yes') {
      filtered = filtered.filter(f => f.adviser_entity_crd || f.source === 'adv');
    } else if (filters.hasAdv === 'no') {
      filtered = filtered.filter(f => !f.adviser_entity_crd && f.source !== 'adv');
    }

    // Then sort
    if (!fundsSortField) return filtered;

    return [...filtered].sort((a, b) => {
      let aVal, bVal;

      if (fundsSortField === 'filing_date') {
        const aDate = a.form_d_filing_date || a.adv_filing_date;
        const bDate = b.form_d_filing_date || b.adv_filing_date;
        aVal = parseFilingDate(aDate).getTime();
        bVal = parseFilingDate(bDate).getTime();
      } else if (fundsSortField === 'aum_offering') {
        // Sort by Form D Offering amount only (to match column header)
        const aAmount = parseCurrency(a.form_d_offering_amount);
        const bAmount = parseCurrency(b.form_d_offering_amount);

        // Push N/A values to the bottom regardless of sort direction
        if (!aAmount && !bAmount) return 0;
        if (!aAmount) return 1; // a is N/A, put it after b
        if (!bAmount) return -1; // b is N/A, put it after a

        aVal = aAmount;
        bVal = bAmount;
      } else if (fundsSortField === 'amount_sold') {
        // Sort by Amount Sold
        const aAmount = parseCurrency(a.form_d_amount_sold);
        const bAmount = parseCurrency(b.form_d_amount_sold);

        // Push N/A values to the bottom regardless of sort direction
        if (!aAmount && !bAmount) return 0;
        if (!aAmount) return 1;
        if (!bAmount) return -1;

        aVal = aAmount;
        bVal = bAmount;
      } else if (fundsSortField === 'adv_aum') {
        // Sort by ADV AUM
        const aAmount = parseCurrency(a.latest_gross_asset_value);
        const bAmount = parseCurrency(b.latest_gross_asset_value);

        // Push N/A values to the bottom regardless of sort direction
        if (!aAmount && !bAmount) return 0;
        if (!aAmount) return 1;
        if (!bAmount) return -1;

        aVal = aAmount;
        bVal = bAmount;
      } else {
        return 0;
      }

      if (fundsSortOrder === 'desc') {
        return bVal - aVal;
      } else {
        return aVal - bVal;
      }
    });
  }, [funds, fundsSortField, fundsSortOrder, filters.hasAdv]);

  // Track previous tab to detect actual tab changes (for immediate vs debounced search)
  const prevActiveTabRef = useRef(activeTab);

  // Unified search effect - handles tab changes (immediate) and search/filter changes (debounced)
  useEffect(() => {
    if (view !== 'dashboard') return;

    const tabChanged = prevActiveTabRef.current !== activeTab;
    prevActiveTabRef.current = activeTab;

    const triggerSearch = () => {
      console.log('[useEffect] Triggering search for tab:', activeTab, 'searchTerm:', searchTerm || '(empty)');
      if (activeTab === 'advisers') searchAdvisers(searchTerm, filters);
      else if (activeTab === 'funds') searchFunds(searchTerm, filters);
      else if (activeTab === 'cross_reference') fetchCrossRef(searchTerm, filters);
      else if (activeTab === 'new_managers') fetchNewManagers();
    };

    if (tabChanged) {
      // Tab changed - search immediately (no debounce)
      triggerSearch();
      return;
    }

    // Search/filter changed - debounce to avoid excessive API calls while typing
    const timeoutId = setTimeout(triggerSearch, 300);
    return () => clearTimeout(timeoutId);
  }, [activeTab, view, searchTerm, filters.state, filters.type, filters.exemption, filters.minAum, filters.maxAum, filters.strategy, filters.minOffering, filters.maxOffering, filters.startDate, filters.endDate, filters.hasAdv, filters.hasWebsite, filters.discrepanciesOnly, filters.overdueAdvOnly, filters.discrepancyType, filters.complianceSeverity, filters.complianceStatus]);

  // New managers filter effect
  useEffect(() => {
    if (view !== 'dashboard' || activeTab !== 'new_managers') return;
    fetchNewManagers();
  }, [nmStartDate, nmEndDate, nmFundType, nmState]);

  // Navigate to adviser detail - fetch full data from advisers_enriched
  const handleAdviserClick = async (adviser) => {
    // Re-fetch full adviser data to get all yearly AUM fields
    try {
      const res = await fetch(`${SUPABASE_ADV_URL}/rest/v1/advisers_enriched?crd=eq.${adviser.crd}&select=*`, { headers: advHeaders });
      const data = await res.json();
      if (data && data.length > 0) {
        setSelectedAdviser(data[0]);
        // Update URL to SEO-friendly format
        const url = getAdviserUrl(data[0].crd, data[0].adviser_name || data[0].adviser_entity_legal_name);
        window.history.pushState({}, '', url);
      } else {
        setSelectedAdviser(adviser);
        const url = getAdviserUrl(adviser.crd, adviser.adviser_name || adviser.adviser_entity_legal_name);
        window.history.pushState({}, '', url);
      }
    } catch (err) {
      console.error('Error fetching adviser details:', err);
      setSelectedAdviser(adviser);
      const url = getAdviserUrl(adviser.crd, adviser.adviser_name || adviser.adviser_entity_legal_name);
      window.history.pushState({}, '', url);
    }
    setView('adviser_detail');
  };

  // Navigate to fund detail
  const handleFundClick = (fund) => {
    setSelectedFund(fund);
    // Update URL to SEO-friendly format
    const url = getFundUrl(fund.reference_id || fund.fund_id, fund.fund_name);
    window.history.pushState({}, '', url);
    setView('fund_detail');
  };

  // Navigate back
  const handleBack = () => {
    setView('dashboard');
    setSelectedAdviser(null);
    setSelectedFund(null);
    // Reset URL to home
    window.history.pushState({}, '', '/');
  };

  // Reset filters
  const handleResetFilters = () => {
    setFilters({
      state: '',
      type: '',
      exemption: '',
      minAum: 0,
      maxAum: '',
      strategy: '',
      minOffering: '',
      maxOffering: '',
      startDate: '',
      endDate: '',
      hasWebsite: false,
      discrepanciesOnly: false,
      overdueAdvOnly: false
    });
    setSearchTerm('');
  };

  // Navigate to adviser from fund
  const handleNavigateToAdviserFromFund = async (crd) => {
    try {
      const res = await fetch(`${SUPABASE_ADV_URL}/rest/v1/advisers_enriched?crd=eq.${crd}&select=*`, { headers: advHeaders });
      const data = await res.json();
      if (data && data.length > 0) {
        setSelectedAdviser(data[0]);
        // Update URL to SEO-friendly format
        const url = getAdviserUrl(data[0].crd, data[0].adviser_name || data[0].adviser_entity_legal_name);
        window.history.pushState({}, '', url);
        setView('adviser_detail');
      }
    } catch (err) {
      console.error('Error fetching adviser:', err);
    }
  };

  const activeCount = activeTab === 'advisers' ? advisers.length : activeTab === 'funds' ? funds.length : activeTab === 'new_managers' ? newManagers.length : crossRefMatches.length;

  return (
    <div className="flex h-screen bg-gray-50 font-sans text-gray-900 overflow-hidden antialiased selection:bg-slate-100 selection:text-slate-900">
      {/* Auth Modal */}
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        mode={authMode}
        setMode={setAuthMode}
        user={user}
        hasPremiumAccess={hasPremiumAccess}
        onLogout={handleLogout}
        onShowPaywall={() => setShowPaywallModal(true)}
      />

      {/* Paywall Modal */}
      <PaywallModal
        isOpen={showPaywallModal}
        onClose={() => setShowPaywallModal(false)}
        onOpenAuth={handleOpenAuth}
        user={user}
      />

      {/* Sidebar */}
      {view === 'dashboard' && (
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          filters={filters}
          setFilters={setFilters}
          onResetFilters={handleResetFilters}
          user={user}
          searchCount={searchCount}
          onOpenAuth={handleOpenAuth}
          onLogout={handleLogout}
          hasPremiumAccess={hasPremiumAccess}
          onShowPaywall={() => setShowPaywallModal(true)}
        />
      )}

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-white relative">
        {view === 'dashboard' && (
          <>
            {/* Header */}
            <header className="h-14 border-b border-gray-200 flex items-center justify-between px-6 sticky top-0 bg-white/90 backdrop-blur-md z-20">
              <div className="flex-1 max-w-xl">
                <div className="relative group">
                  <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-slate-600 transition-colors" />
                  <input
                    type="search"
                    placeholder="Search CRD, CIK, or Entity Name..."
                    className="block w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg leading-5 bg-gray-50/50 text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-1 focus:ring-slate-500 focus:border-slate-500 text-[13px] transition-all shadow-sm"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
              </div>
              <div className="ml-6 flex items-center space-x-6">
                {user ? (
                  <div className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => setShowAuthModal(true)}>
                    <div className="text-right">
                      <span className="text-[11px] font-medium text-gray-700 block">{user.email}</span>
                      <span className="text-[9px] text-gray-400">{hasPremiumAccess ? 'Professional' : 'Free Plan'}</span>
                    </div>
                    <div className="h-7 w-7 rounded-full bg-gradient-to-tr from-slate-600 to-slate-700 flex items-center justify-center text-white font-bold text-[10px] shadow-sm ring-2 ring-white">
                      {user.email ? user.email.substring(0, 2).toUpperCase() : 'U'}
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setAuthMode('login'); setShowAuthModal(true); }}
                    className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium text-white bg-slate-700 hover:bg-slate-800 rounded-lg transition-colors shadow-sm"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                    Sign In
                  </button>
                )}
              </div>
            </header>

            {/* Content */}
            <div className="flex-1 overflow-auto custom-scrollbar bg-white relative">
              <LoadingOverlay isLoading={loading} />
              <div className="max-w-full mx-auto">
                {/* Data Header */}
                <div className="px-8 py-6 flex items-end justify-between bg-white">
                  <div>
                    <h2 className="text-xl font-serif font-bold text-gray-900 tracking-tight leading-none mb-1">
                      {activeTab === 'advisers' && 'Adviser Registry'}
                      {activeTab === 'funds' && 'Private Fund Offerings'}
                      {activeTab === 'new_managers' && 'New Managers Discovery'}
                      {activeTab === 'cross_reference' && 'Intelligence Radar'}
                    </h2>
                    <p className="text-[11px] text-gray-500 mt-1 flex items-center gap-2 font-medium">
                      {activeCount} records found matching criteria
                    </p>
                  </div>
                  <div className="flex space-x-3">
                    <button className="px-3 py-1.5 text-[11px] font-medium text-gray-700 bg-white border border-gray-200 rounded-md hover:bg-gray-50 shadow-sm transition-colors flex items-center gap-2">
                      <PlusIcon className="w-3.5 h-3.5 text-gray-400" /> Save View
                    </button>
                    <div className="relative" ref={exportMenuRef}>
                      <button
                        onClick={() => setShowExportMenu(!showExportMenu)}
                        className="px-3 py-1.5 text-[11px] font-medium text-white bg-slate-700 border border-slate-800 rounded-md hover:bg-slate-800 shadow-sm transition-colors flex items-center gap-2 shadow-slate-200"
                      >
                        <ShareIcon className="w-3.5 h-3.5" />
                        Export
                        <ChevronDownIcon className={`w-3 h-3 transition-transform ${showExportMenu ? 'rotate-180' : ''}`} />
                      </button>
                      {showExportMenu && (
                        <div className="absolute right-0 mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                          <button
                            onClick={exportToCSV}
                            className="w-full px-3 py-2 text-left text-[12px] text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors"
                          >
                            <FileTextIcon className="w-3.5 h-3.5 text-gray-400" />
                            Export as CSV
                            {!hasPremiumAccess && (
                              <span className="ml-auto flex items-center gap-1">
                                <LockIcon className="w-3 h-3 text-amber-500" />
                                <span className="text-[9px] font-bold text-amber-600 bg-amber-50 px-1 rounded">PRO</span>
                              </span>
                            )}
                          </button>
                          <button
                            onClick={exportToMarkdown}
                            className="w-full px-3 py-2 text-left text-[12px] text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors"
                          >
                            <FileTextIcon className="w-3.5 h-3.5 text-gray-400" />
                            Export as Markdown
                            {!hasPremiumAccess && (
                              <span className="ml-auto flex items-center gap-1">
                                <LockIcon className="w-3 h-3 text-amber-500" />
                                <span className="text-[9px] font-bold text-amber-600 bg-amber-50 px-1 rounded">PRO</span>
                              </span>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Advisers Table - Gemini Style */}
                {activeTab === 'advisers' && (
                  <div className="min-w-full inline-block align-middle px-6 pb-12">
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-xs bg-white">
                      <table className="min-w-full divide-y divide-gray-100">
                        <thead className="bg-white">
                          <tr>
                            <th className="px-6 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-gray-100">Entity</th>
                            <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-gray-100">Type</th>
                            <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-gray-100">AUM</th>
                            <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-gray-100"># Funds</th>
                            <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-gray-100">Links</th>
                            <th className="px-4 py-3 border-b border-gray-100"></th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-50">
                          {advisers.map((adviser) => (
                            <tr key={adviser.crd} onClick={() => handleAdviserClick(adviser)} className="group hover:bg-gray-50 cursor-pointer transition-colors">
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-[13px] font-serif font-semibold text-slate-900 italic tracking-tight">{adviser.adviser_name || adviser.adviser_entity_legal_name}</div>
                                <div className="text-[10px] text-slate-400 font-mono mt-0.5">CRD: {adviser.crd}</div>
                              </td>
                              <td className="px-4 py-4 whitespace-nowrap text-center">
                                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-600 border border-slate-200">{adviser.type || 'RIA'}</span>
                              </td>
                              <td className="px-4 py-4 whitespace-nowrap text-right">
                                <div className="text-[13px] text-slate-900 font-mono tabular-nums font-semibold">{formatCurrency(getEffectiveAum(adviser))}</div>
                              </td>
                              <td className="px-4 py-4 whitespace-nowrap text-center">
                                <div className="text-[12px] text-slate-700 font-mono tabular-nums">{adviser.fund_count || 0}</div>
                              </td>
                              <td className="px-4 py-4 whitespace-nowrap text-center">
                                <div className="flex items-center justify-center gap-2">
                                  {/* Website - always show */}
                                  {adviser.primary_website ? (
                                    <a
                                      href={adviser.primary_website.startsWith('http') ? adviser.primary_website : `https://${adviser.primary_website}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="text-blue-600 hover:text-blue-800 transition-colors"
                                      title="Website"
                                    >
                                      <GlobeIcon className="w-4 h-4" />
                                    </a>
                                  ) : (
                                    <span className="text-gray-300 cursor-not-allowed relative" title="Website not available">
                                      <GlobeIcon className="w-4 h-4" />
                                    </span>
                                  )}
                                  {/* SEC ADV - always available when CRD exists */}
                                  {adviser.crd && (
                                    <a
                                      href={`https://adviserinfo.sec.gov/firm/summary/${adviser.crd}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="text-green-600 hover:text-green-800 transition-colors"
                                      title="SEC ADV Filing"
                                    >
                                      <FileTextIcon className="w-4 h-4" />
                                    </a>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-4 whitespace-nowrap text-right">
                                <ChevronRightIcon className="w-4 h-4 text-gray-300 group-hover:text-slate-600 ml-auto transition-colors" />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Funds Table - Compact Layout */}
                {activeTab === 'funds' && (
                  <div className="px-4 pb-4 overflow-x-auto">
                    {funds.length === 0 && !loading && (
                      <div className="text-center py-12 text-gray-500">
                        <p className="text-sm">No funds found. Try adjusting your search.</p>
                      </div>
                    )}
                    {funds.length > 0 && (
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white">
                      <table className="min-w-full divide-y divide-gray-100">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-2.5 text-left text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Fund / Entity Name</th>
                            <th className="px-3 py-2.5 text-center text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Source</th>
                            <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Type</th>
                            <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Adviser</th>
                            <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Related Parties</th>
                            <th onClick={() => handleFundsSort('filing_date')} className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-600 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors">
                              Filing Date {fundsSortField === 'filing_date' && (fundsSortOrder === 'desc' ? '↓' : '↑')}
                            </th>
                            <th onClick={() => handleFundsSort('aum_offering')} className="px-3 py-2.5 text-right text-[10px] font-semibold text-gray-600 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors">
                              Form D Offering {fundsSortField === 'aum_offering' && (fundsSortOrder === 'desc' ? '↓' : '↑')}
                            </th>
                            <th onClick={() => handleFundsSort('amount_sold')} className="px-3 py-2.5 text-right text-[10px] font-semibold text-gray-600 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors">
                              Amt Sold {fundsSortField === 'amount_sold' && (fundsSortOrder === 'desc' ? '↓' : '↑')}
                            </th>
                            <th onClick={() => handleFundsSort('adv_aum')} className="px-3 py-2.5 text-right text-[10px] font-semibold text-gray-600 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors">
                              ADV AUM {fundsSortField === 'adv_aum' && (fundsSortOrder === 'desc' ? '↓' : '↑')}
                            </th>
                            <th className="px-3 py-2.5 text-center text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Links</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {sortedFunds.map((fund, idx) => (
                            <tr key={idx} onClick={() => handleFundClick(fund)} className="group hover:bg-blue-50/50 cursor-pointer transition-colors">
                              <td className="px-4 py-2.5">
                                <div className="text-[12px] font-medium text-gray-900 group-hover:text-blue-700 transition-colors">{fund.fund_name}</div>
                                <div className="text-[10px] text-gray-400 mt-0.5">{fund.state_of_organization || fund.adviser_state || '—'}</div>
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                <div className="flex justify-center gap-1">
                                  {fund.source === 'adv' ? (
                                    <>
                                      <span className="px-1.5 py-0.5 text-[9px] rounded font-semibold bg-green-100 text-green-700">ADV</span>
                                      {fund.has_form_d_match && <span className="px-1.5 py-0.5 text-[9px] rounded font-semibold bg-blue-100 text-blue-700">D</span>}
                                    </>
                                  ) : (
                                    <span className="px-1.5 py-0.5 text-[9px] rounded font-semibold bg-blue-100 text-blue-700">Form D</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                {(() => {
                                  // Check both ADV fields (exclusion_3c1/3c7) and Form D field (federal_exemptions containing "3C.1" or "3C.7")
                                  const exemptions = fund.federal_exemptions || '';
                                  const has3c1 = fund.exclusion_3c1 === 'Y' || /3C\.?1\b/i.test(exemptions);
                                  const has3c7 = fund.exclusion_3c7 === 'Y' || /3C\.?7\b/i.test(exemptions);
                                  return (
                                    <div className="flex flex-wrap items-center gap-1">
                                      {has3c1 && <span className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-[9px] font-semibold">3(c)(1)</span>}
                                      {has3c7 && <span className="bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded text-[9px] font-semibold">3(c)(7)</span>}
                                      {!has3c1 && !has3c7 && <span className="text-[11px] text-gray-700">{fund.fund_type || fund.investment_fund_type || '—'}</span>}
                                    </div>
                                  );
                                })()}
                              </td>
                              <td className="px-3 py-2.5">
                                {fund.adviser_entity_legal_name && fund.adviser_entity_crd ? (
                                  <div
                                    className="cursor-pointer hover:bg-blue-50 p-1 -m-1 rounded transition-colors"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleNavigateToAdviserFromFund(fund.adviser_entity_crd);
                                    }}
                                  >
                                    <div className="text-[11px] text-blue-600 hover:text-blue-800 font-medium" title={fund.adviser_entity_legal_name}>{fund.adviser_entity_legal_name}</div>
                                    <div className="text-[9px] text-gray-400">CRD: {fund.adviser_entity_crd}</div>
                                  </div>
                                ) : fund.adviser_entity_legal_name ? (
                                  <div className="text-[11px] text-gray-700" title={fund.adviser_entity_legal_name}>{fund.adviser_entity_legal_name}</div>
                                ) : (
                                  <span className="text-[11px] text-gray-400">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5">
                                {fund.related_names ? (() => {
                                  const names = fund.related_names.split('|');
                                  const roles = fund.related_roles ? fund.related_roles.split('|') : [];
                                  const normalized = names.map((n, i) => ({
                                    name: normalizeRelatedPartyName(n.trim()),
                                    role: roles[i] || ''
                                  })).filter(item => item.name); // Remove nulls

                                  return normalized.length > 0 ? (
                                    <div className="space-y-1">
                                      {normalized.slice(0, 2).map((item, i) => (
                                        <div key={i}>
                                          <div className="text-[11px] text-gray-700">{item.name}</div>
                                          {item.role && <div className="text-[9px] text-gray-400">{item.role.trim()}</div>}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-[11px] text-gray-400">—</span>
                                  );
                                })() : (
                                  <span className="text-[11px] text-gray-400">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="text-[11px] text-gray-600 font-mono tabular-nums">
                                  {formatDateDisplay(fund.form_d_filing_date || fund.adv_filing_date) || '—'}
                                </div>
                                {fund.source === 'adv' && fund.form_d_filing_date && (
                                  <div className="text-[9px] text-gray-400">Form D: {formatDateDisplay(fund.form_d_filing_date)}</div>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                {fund.form_d_offering_amount ? (
                                  <div className="text-[11px] font-medium text-gray-900 font-mono tabular-nums">{formatCurrency(fund.form_d_offering_amount)}</div>
                                ) : (
                                  <span className="text-[11px] text-gray-400">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                {fund.form_d_amount_sold ? (
                                  <div className="text-[11px] text-gray-900 font-mono tabular-nums font-medium">{formatCurrency(parseCurrency(fund.form_d_amount_sold))}</div>
                                ) : (
                                  <span className="text-[11px] text-gray-400">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                {fund.latest_gross_asset_value ? (
                                  <div className="text-[11px] text-gray-900 font-mono tabular-nums font-medium">{formatCurrency(fund.latest_gross_asset_value)}</div>
                                ) : (
                                  <span className="text-[11px] text-gray-400">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                <div className="flex justify-center items-center gap-2">
                                  {fund.adviser_entity_crd ? (
                                    <a href={`https://adviserinfo.sec.gov/firm/summary/${fund.adviser_entity_crd}`} target="_blank" rel="noopener noreferrer" className="text-[10px] font-medium text-blue-600 hover:text-blue-800 hover:underline" onClick={(e) => e.stopPropagation()}>IAPD</a>
                                  ) : (
                                    <span className="text-[10px] text-gray-300">IAPD</span>
                                  )}
                                  {fund.cik || fund.form_d_cik ? (
                                    <a href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${fund.cik || fund.form_d_cik}&type=D&dateb=&owner=include&count=40`} target="_blank" rel="noopener noreferrer" className="text-[10px] font-medium text-blue-600 hover:text-blue-800 hover:underline" onClick={(e) => e.stopPropagation()}>EDGAR</a>
                                  ) : (
                                    <span className="text-[10px] text-gray-300">EDGAR</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    )}
                  </div>
                )}

                {/* Intelligence Radar - Compliance Issues Table */}
                {activeTab === 'cross_reference' && (
                  <div className="min-w-full inline-block align-middle px-6 pb-12">
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-xs">
                      <table className="min-w-full divide-y divide-gray-100">
                        <thead className="bg-gray-50/50">
                          <tr>
                            <th className="px-6 py-2.5 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-200">Manager / Fund</th>
                            <th className="px-6 py-2.5 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-200">Discrepancy Type</th>
                            <th className="px-6 py-2.5 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-200">Description</th>
                            <th className="px-6 py-2.5 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-200">Contact</th>
                            <th className="px-6 py-2.5 text-center text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-200">Links</th>
                            <th className="px-6 py-2.5 text-center text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-200">Detected</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-50">
                          {crossRefMatches.map((match, idx) => {
                            const getSeverityColor = (severity) => {
                              switch(severity?.toLowerCase()) {
                                case 'critical': return 'bg-red-100 text-red-800 border-red-300';
                                case 'high': return 'bg-orange-100 text-orange-800 border-orange-300';
                                case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-300';
                                case 'low': return 'bg-blue-100 text-blue-800 border-blue-300';
                                default: return 'bg-gray-100 text-gray-800 border-gray-300';
                              }
                            };

                            const getTypeLabel = (type) => {
                              const labels = {
                                'needs_initial_adv_filing': 'Initial ADV Filing',
                                'overdue_annual_amendment': 'Overdue Amendment',
                                'vc_exemption_violation': 'VC Exemption Issue',
                                'fund_type_mismatch': 'Type Mismatch',
                                'missing_fund_in_adv': 'Missing Fund',
                                'exemption_mismatch': 'Exemption Mismatch'
                              };
                              return labels[type] || type;
                            };

                            return (
                              <tr key={match.id || idx} className="group hover:bg-gray-50 transition-colors">
                                <td className="px-6 py-3">
                                  <div className="flex flex-col">
                                    {match.crd || match.adviser_entity_crd ? (
                                      <a
                                        href={getAdviserUrl(match.crd || match.adviser_entity_crd, match.entity_name || match.adviser_entity_legal_name)}
                                        className="text-[13px] font-medium text-gray-900 hover:text-slate-700 transition-colors tracking-tight"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        {match.entity_name || match.adviser_entity_legal_name || 'Unknown Manager'}
                                      </a>
                                    ) : (
                                      <div className="text-[13px] font-medium text-gray-900">{match.entity_name || 'Unknown Manager'}</div>
                                    )}
                                    {match.fund_name && (
                                      <div className="text-[10px] text-gray-500 mt-0.5">{match.fund_name}</div>
                                    )}
                                    <div className="flex items-center gap-1.5 mt-1">
                                      <span className={`inline-block px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide rounded border ${getSeverityColor(match.severity)}`}>
                                        {match.severity || 'N/A'}
                                      </span>
                                      {match.status && match.status !== 'active' && (
                                        <span className="inline-block px-1.5 py-0.5 text-[9px] font-medium text-gray-600 bg-gray-100 rounded">
                                          {match.status}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </td>
                                <td className="px-6 py-3">
                                  <div className="text-[11px] font-medium text-gray-700">
                                    {getTypeLabel(match.type || match.discrepancy_type)}
                                  </div>
                                </td>
                                <td className="px-6 py-3">
                                  <div className="text-[11px] text-gray-600 leading-relaxed max-w-md">
                                    {match.description || match.issues || 'No description available'}
                                  </div>
                                </td>
                                <td className="px-6 py-3">
                                  <div className="flex flex-col gap-1 text-[10px]">
                                    {match.contact_info?.email && (
                                      <a href={`mailto:${match.contact_info.email}`} className="text-blue-600 hover:text-blue-800 hover:underline" onClick={(e) => e.stopPropagation()}>
                                        {match.contact_info.email}
                                      </a>
                                    )}
                                    {match.contact_info?.phone && (
                                      <a href={`tel:${match.contact_info.phone}`} className="text-gray-600 hover:text-gray-800" onClick={(e) => e.stopPropagation()}>
                                        {match.contact_info.phone}
                                      </a>
                                    )}
                                    {match.contact_info?.website && (
                                      <a href={match.contact_info.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline truncate max-w-[150px]" onClick={(e) => e.stopPropagation()}>
                                        {match.contact_info.website.replace(/^https?:\/\/(www\.)?/, '')}
                                      </a>
                                    )}
                                    {!match.contact_info?.email && !match.contact_info?.phone && !match.contact_info?.website && (
                                      <span className="text-gray-400">No contact info</span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-6 py-3">
                                  <div className="flex justify-center items-center gap-2">
                                    {match.crd || match.adviser_entity_crd ? (
                                      <a
                                        href={`https://adviserinfo.sec.gov/firm/summary/${match.crd || match.adviser_entity_crd}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[10px] font-medium text-blue-600 hover:text-blue-800 hover:underline"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        IAPD
                                      </a>
                                    ) : (
                                      <span className="text-[10px] text-gray-300">IAPD</span>
                                    )}
                                    {match.form_d_cik ? (
                                      <a
                                        href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${match.form_d_cik}&type=D&dateb=&owner=include&count=40`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[10px] font-medium text-blue-600 hover:text-blue-800 hover:underline"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        EDGAR
                                      </a>
                                    ) : (
                                      <span className="text-[10px] text-gray-300">EDGAR</span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-6 py-3 text-center">
                                  <div className="text-[10px] text-gray-500 font-mono">
                                    {match.detected_date ? formatDateDisplay(match.detected_date) : 'N/A'}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {crossRefMatches.length === 0 && (
                        <div className="px-6 py-12 text-center">
                          <div className="text-gray-400 text-sm">No compliance issues found matching your filters</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* New Managers Table */}
                {activeTab === 'new_managers' && (
                  <div className="px-4 pb-4 overflow-x-auto">
                    {/* Filter Bar */}
                    <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
                      <div className="flex flex-wrap items-center gap-4">
                        {/* Date Range */}
                        <div className="flex items-center gap-3 bg-white px-3 py-2 rounded-lg border border-gray-200 shadow-sm">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide">From</span>
                            <input
                              type="date"
                              value={nmStartDate}
                              onChange={(e) => setNmStartDate(e.target.value)}
                              className="px-2 py-1 text-[12px] border-0 bg-gray-50 rounded focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono"
                            />
                          </div>
                          <span className="text-gray-300">→</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide">To</span>
                            <input
                              type="date"
                              value={nmEndDate}
                              onChange={(e) => setNmEndDate(e.target.value)}
                              className="px-2 py-1 text-[12px] border-0 bg-gray-50 rounded focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono"
                            />
                          </div>
                        </div>
                        {/* Fund Type Filter */}
                        <select
                          value={nmFundType}
                          onChange={(e) => setNmFundType(e.target.value)}
                          className="px-3 py-2 text-[12px] bg-white border border-gray-200 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
                        >
                          {fundTypeOptions.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        {/* Jurisdiction Filter */}
                        <select
                          value={nmState}
                          onChange={(e) => setNmState(e.target.value)}
                          className="px-3 py-2 text-[12px] bg-white border border-gray-200 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
                        >
                          {stateOptions.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        {/* Form ADV Filter */}
                        <select
                          value={nmHasAdv}
                          onChange={(e) => setNmHasAdv(e.target.value)}
                          className="px-3 py-2 text-[12px] bg-white border border-gray-200 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
                        >
                          <option value="">All Registrations</option>
                          <option value="yes">Has Form ADV</option>
                          <option value="no">No Form ADV</option>
                        </select>
                        {/* Result Count */}
                        <div className="ml-auto flex items-center gap-2">
                          {(nmFundType || nmState || nmHasAdv) && (
                            <button
                              onClick={() => { setNmFundType(''); setNmState(''); setNmHasAdv(''); }}
                              className="px-2 py-1 text-[10px] font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                            >
                              Clear Filters
                            </button>
                          )}
                          <span className="text-[11px] text-gray-600 font-medium bg-white px-3 py-1.5 rounded-full border border-gray-200">
                            {filteredNewManagers.length} managers
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white">
                      <table className="min-w-full divide-y divide-gray-100">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-2.5 text-left text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Series Master LLC</th>
                            <th onClick={() => handleNmSort('fund_count')} className="px-3 py-2.5 text-center text-[10px] font-semibold text-gray-600 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors">
                              Funds {nmSortField === 'fund_count' && (nmSortOrder === 'desc' ? '↓' : '↑')}
                            </th>
                            <th onClick={() => handleNmSort('total_offering_amount')} className="px-3 py-2.5 text-right text-[10px] font-semibold text-gray-600 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors">
                              Total Offering {nmSortField === 'total_offering_amount' && (nmSortOrder === 'desc' ? '↓' : '↑')}
                            </th>
                            <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-600 uppercase tracking-wider">Key Person</th>
                            <th onClick={() => handleNmSort('first_filing_date')} className="px-3 py-2.5 text-center text-[10px] font-semibold text-gray-600 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors">
                              First Filing {nmSortField === 'first_filing_date' && (nmSortOrder === 'desc' ? '↓' : '↑')}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {sortedNewManagers.map((manager, idx) => {
                            const isExpanded = expandedManagers.has(manager.series_master_llc);
                            const fundType = getPrimaryFundType(manager);
                            const keyPerson = getKeyPerson(manager);
                            const firstLetter = manager.series_master_llc?.charAt(0)?.toUpperCase() || '?';
                            const avatarColor = getAvatarColor(manager.series_master_llc || '');
                            return (
                              <React.Fragment key={idx}>
                                <tr
                                  className="group hover:bg-blue-50/50 cursor-pointer transition-colors"
                                  onClick={() => {
                                    const newExpanded = new Set(expandedManagers);
                                    if (isExpanded) {
                                      newExpanded.delete(manager.series_master_llc);
                                    } else {
                                      newExpanded.add(manager.series_master_llc);
                                    }
                                    setExpandedManagers(newExpanded);
                                  }}
                                >
                                  <td className="px-4 py-2.5">
                                    <div className="flex items-center gap-2.5">
                                      <span className={`text-gray-400 text-[10px] transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                                      <div className="min-w-0">
                                        <div className="text-[12px] font-medium text-gray-900 group-hover:text-blue-700 transition-colors truncate max-w-[260px]" title={manager.series_master_llc}>{manager.series_master_llc}</div>
                                        {fundType && (
                                          <div className="mt-1">
                                            <span className={`inline-flex items-center px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide rounded ${getFundTypeTagColor(fundType)}`}>
                                              {fundType}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2.5 text-center">
                                    <span className="inline-flex items-center justify-center min-w-[28px] px-2.5 py-1 text-[11px] font-bold bg-gray-100 text-gray-700 rounded-full">{manager.fund_count}</span>
                                  </td>
                                  <td className="px-3 py-2.5 text-right">
                                    <div className="text-[11px] font-mono text-gray-700 tabular-nums font-semibold">{formatCurrency(manager.total_offering_amount)}</div>
                                  </td>
                                  <td className="px-3 py-2.5">
                                    {keyPerson ? (
                                      <div>
                                        <div className="text-[11px] font-medium text-gray-700">{keyPerson.name}</div>
                                        {keyPerson.role && (
                                          <div className="text-[9px] text-gray-400">{keyPerson.role}</div>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-[11px] text-gray-400 italic">—</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2.5 text-center">
                                    <div className="text-[11px] font-mono text-gray-500">{formatDate(manager.first_filing_date)}</div>
                                  </td>
                                </tr>
                                {isExpanded && manager.has_form_adv && (
                                  <tr className="bg-emerald-50/50 border-l-2 border-emerald-400">
                                    <td colSpan="5" className="px-6 py-3">
                                      <div className="ml-6">
                                        <div className="flex items-start justify-between">
                                          <div>
                                            <div className="flex items-center gap-2 mb-2">
                                              <span className="inline-flex items-center px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide rounded bg-emerald-100 text-emerald-700">
                                                ✓ Form ADV
                                              </span>
                                              <span className="text-[11px] font-medium text-gray-700">
                                                CRD {manager.adv_data.crd}
                                              </span>
                                            </div>
                                            <div className="grid grid-cols-4 gap-4 text-[11px]">
                                              <div>
                                                <div className="text-gray-500">Registered Name:</div>
                                                <div className="text-gray-900 font-medium">{manager.adv_data.name}</div>
                                              </div>
                                              {manager.adv_data.location && (
                                                <div>
                                                  <div className="text-gray-500">Location:</div>
                                                  <div className="text-gray-900">{manager.adv_data.location}</div>
                                                </div>
                                              )}
                                              {manager.adv_data.aum && (
                                                <div>
                                                  <div className="text-gray-500">AUM:</div>
                                                  <div className="text-gray-900 font-mono">{formatCurrency(manager.adv_data.aum)}</div>
                                                </div>
                                              )}
                                            </div>
                                          </div>
                                          <div className="flex gap-2">
                                            <button
                                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 text-white rounded text-[10px] font-medium hover:bg-gray-800 transition-colors shadow-sm"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleNavigateToAdviserFromFund(manager.adv_data.crd);
                                              }}
                                            >
                                              <span>View Adviser Page</span>
                                            </button>
                                            <a
                                              href={`https://adviserinfo.sec.gov/firm/summary/${manager.adv_data.crd}`}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded text-[10px] font-medium hover:bg-gray-50 transition-colors shadow-sm"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              <span>SEC IAPD</span>
                                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                                            </a>
                                          </div>
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                                {isExpanded && manager.funds && manager.funds.map((fund, fundIdx) => (
                                  <tr key={`${idx}-${fundIdx}`} className="bg-gray-50/50 border-l-2 border-gray-300">
                                    <td colSpan="5" className="px-6 py-4">
                                      <div className="ml-6 grid grid-cols-3 gap-6 text-[12px]">
                                        {/* Fund Details */}
                                        <div className="space-y-2">
                                          <div className="font-semibold text-gray-900 text-[13px]">{fund.entityname}</div>
                                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                                            <div className="text-gray-500">Filing Date:</div>
                                            <div className="text-gray-700 font-mono">{formatDate(fund.filing_date)}</div>
                                            <div className="text-gray-500">Offering:</div>
                                            <div className="text-gray-700 font-mono">{formatCurrency(parseCurrency(fund.totalofferingamount))}</div>
                                            <div className="text-gray-500">Amount Sold:</div>
                                            <div className="text-gray-700 font-mono">{formatCurrency(parseCurrency(fund.totalamountsold))}</div>
                                            <div className="text-gray-500">Fund Type:</div>
                                            <div className="text-gray-700">{fund.investmentfundtype || 'N/A'}</div>
                                            <div className="text-gray-500">Exemptions:</div>
                                            <div className="text-gray-700">{fund.federalexemptions_items_list || 'N/A'}</div>
                                          </div>
                                          <div className="pt-2 flex items-center gap-4">
                                            {fund.cik && (
                                              <a
                                                href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${fund.cik}&type=D&dateb=&owner=exclude&count=100`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-slate-600 hover:text-slate-800 text-[11px] font-medium flex items-center gap-1"
                                                onClick={(e) => e.stopPropagation()}
                                              >
                                                <span>View Form D on SEC</span>
                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                                              </a>
                                            )}
                                            {fund.cik && (
                                              <span className="text-gray-400 text-[10px] font-mono">CIK: {fund.cik}</span>
                                            )}
                                          </div>
                                        </div>
                                        {/* Contact Buttons */}
                                        <div>
                                          <div className="font-semibold text-gray-900 mb-2 text-[11px] uppercase tracking-wide">Contact</div>
                                          <div className="flex flex-wrap gap-2">
                                              {/* Website Button */}
                                              {(manager.enrichment_data?.website || manager.adv_data?.primary_website) ? (
                                                <a
                                                  href={(() => {
                                                    const website = manager.enrichment_data?.website || manager.adv_data?.primary_website;
                                                    return website.startsWith('http') ? website : `https://${website}`;
                                                  })()}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-gray-300 text-gray-700 rounded text-[10px] font-medium hover:bg-gray-50 transition-colors shadow-sm"
                                                  onClick={(e) => e.stopPropagation()}
                                                >
                                                  <GlobeIcon className="w-3 h-3" />
                                                  Website
                                                </a>
                                              ) : (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-50 border border-gray-200 text-gray-400 rounded text-[10px] font-medium cursor-not-allowed relative group">
                                                  <GlobeIcon className="w-3 h-3" />
                                                  Website
                                                  <svg className="w-3 h-3 absolute -top-1 -right-1 text-gray-400" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="white" stroke="currentColor" strokeWidth="1.5"/><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                                </span>
                                              )}
                                              {/* LinkedIn Button */}
                                              {manager.enrichment_data?.linkedin ? (
                                                <a
                                                  href={manager.enrichment_data.linkedin}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-gray-300 text-gray-700 rounded text-[10px] font-medium hover:bg-gray-50 transition-colors shadow-sm"
                                                  onClick={(e) => e.stopPropagation()}
                                                >
                                                  <LinkedinIcon className="w-3 h-3" />
                                                  LinkedIn
                                                </a>
                                              ) : (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-50 border border-gray-200 text-gray-400 rounded text-[10px] font-medium cursor-not-allowed relative group">
                                                  <LinkedinIcon className="w-3 h-3" />
                                                  LinkedIn
                                                  <svg className="w-3 h-3 absolute -top-1 -right-1 text-gray-400" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="white" stroke="currentColor" strokeWidth="1.5"/><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                                </span>
                                              )}
                                              {/* Email Button */}
                                              {fund.issueremail ? (
                                                <a
                                                  href={`mailto:${fund.issueremail}`}
                                                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-gray-300 text-gray-700 rounded text-[10px] font-medium hover:bg-gray-50 transition-colors shadow-sm"
                                                  onClick={(e) => e.stopPropagation()}
                                                >
                                                  <MailIcon className="w-3 h-3" />
                                                  Email
                                                </a>
                                              ) : (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-50 border border-gray-200 text-gray-400 rounded text-[10px] font-medium cursor-not-allowed relative group">
                                                  <MailIcon className="w-3 h-3" />
                                                  Email
                                                  <svg className="w-3 h-3 absolute -top-1 -right-1 text-gray-400" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="white" stroke="currentColor" strokeWidth="1.5"/><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                                </span>
                                              )}
                                          </div>
                                        </div>
                                        {/* Related Parties */}
                                        <div>
                                          <div className="font-semibold text-gray-900 mb-2 text-[11px] uppercase tracking-wide">Related Parties</div>
                                          {fund.related_names ? (() => {
                                            const names = fund.related_names.split('|');
                                            const roles = fund.related_roles ? fund.related_roles.split('|') : [];
                                            const normalized = names.map((n, i) => ({
                                              name: normalizeRelatedPartyName(n.trim()),
                                              role: roles[i] || ''
                                            })).filter(item => item.name); // Remove nulls

                                            return normalized.length > 0 ? (
                                              <div className="space-y-2">
                                                {normalized.slice(0, 4).map((item, i) => (
                                                  <div key={i} className="bg-white rounded px-3 py-2 border border-gray-100">
                                                    <div className="text-gray-900 font-medium text-[12px]">{item.name}</div>
                                                    {item.role && <div className="text-gray-500 text-[10px] mt-0.5">{item.role.trim()}</div>}
                                                  </div>
                                                ))}
                                                {normalized.length > 4 && (
                                                  <div className="text-gray-400 text-[10px] italic">+{normalized.length - 4} more</div>
                                                )}
                                              </div>
                                            ) : (
                                              <div className="text-gray-400 text-[11px] italic">No related parties listed</div>
                                            );
                                          })() : (
                                            <div className="text-gray-400 text-[11px] italic">No related parties listed</div>
                                          )}
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Empty State */}
                {activeCount === 0 && !loading && (
                  <div className="py-32 flex flex-col items-center justify-center text-center">
                    <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mb-4 ring-1 ring-gray-100">
                      <SearchIcon className="h-6 w-6 text-gray-300" />
                    </div>
                    <h3 className="text-sm font-semibold text-gray-900">No matching records</h3>
                    <p className="mt-1.5 text-xs text-gray-500 max-w-xs mx-auto">Adjust your filters or try a different search term.</p>
                    <button onClick={handleResetFilters} className="mt-6 text-xs font-medium text-slate-600 hover:text-slate-700 flex items-center gap-2">
                      <XIcon className="w-3 h-3" /> Clear all filters
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Detail Views */}
        {view === 'adviser_detail' && selectedAdviser && (
          <AdviserDetailView adviser={selectedAdviser} onBack={handleBack} onNavigateToFund={handleFundClick} />
        )}
        {view === 'fund_detail' && selectedFund && (
          <FundDetailView fund={selectedFund} onBack={handleBack} onNavigateToAdviser={handleNavigateToAdviserFromFund} />
        )}
      </main>
    </div>
  );
}

// Render
ReactDOM.render(<App />, document.getElementById('root'));
