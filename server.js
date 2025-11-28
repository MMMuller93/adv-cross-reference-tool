const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.js') || path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Supabase clients (same as original)
const advClient = createClient(
  'https://ezuqwwffjgfzymqxsctq.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE'
);

const formdClient = createClient(
  'https://ltdalxkhbbhmkimmogyq.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc'
);

// Helper functions
function normalizeName(name) {
  if (!name) return '';
  let normalized = String(name).toUpperCase();
  const replacements = [
    ', LLC', ' LLC', ', LP', ' LP', ', L.P.', ' L.P.',
    ', L.L.C.', ' L.L.C.', ' INC', ' INC.', ', INC', ', INC.',
    ' FUND', ' A SERIES OF', ', A SERIES OF'
  ];
  replacements.forEach(r => {
    normalized = normalized.replace(new RegExp(r, 'g'), ' ');
  });
  return normalized.replace(/\s+/g, ' ').trim();
}

function similarity(s1, s2) {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  if (longer.length === 0) return 1.0;
  return (longer.length - editDistance(longer, shorter)) / longer.length;
}

function editDistance(s1, s2) {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

// Parse mixed date formats: "DD-MMM-YYYY" (e.g., "31-OCT-2024") or "YYYY-MM-DD" (e.g., "2025-11-06")
function parseFilingDate(dateStr) {
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
}

// Helper: Fetch all results with pagination (Supabase has 1000 row hard limit)
async function fetchAllResultsPaginated(buildQuery, pageSize = 1000) {
  let allResults = [];
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const query = buildQuery(from, from + pageSize - 1);
    const { data, error } = await query;

    if (error) {
      console.error(`Error fetching page at offset ${from}:`, error);
      throw error;
    }

    if (data && data.length > 0) {
      allResults = allResults.concat(data);
      console.log(`  Fetched ${data.length} rows (offset ${from}), total so far: ${allResults.length}`);
      from += pageSize;
      hasMore = data.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return allResults;
}

// API: Search Advisers
app.get('/api/advisers/search', async (req, res) => {
  try {
    const { query, minAum, maxAum, state, type, exemption, limit = 500 } = req.query;
    console.log(`[Gemini] Searching Advisers: query="${query || '(none)'}"`);

    let adviserQuery = advClient.from('advisers_enriched').select('*');

    // Require at least 3 chars like old tool to prevent slow full-table scans
    if (query && query.trim().length >= 3) {
      adviserQuery = adviserQuery.or(`adviser_name.ilike.%${query}%,adviser_entity_legal_name.ilike.%${query}%,other_business_names.ilike.%${query}%`);
    }

    if (state && state.trim()) {
      adviserQuery = adviserQuery.eq('state_country', state);
    }

    if (type && type.trim()) {
      adviserQuery = adviserQuery.eq('type', type);
    }

    if (exemption === 'vc') {
      adviserQuery = adviserQuery.eq('exemption_2b1', 'Y');
    } else if (exemption === 'private_fund') {
      adviserQuery = adviserQuery.eq('exemption_2b2', 'Y');
    }

    if (minAum) {
      adviserQuery = adviserQuery.gte('total_aum', parseFloat(minAum) * 1000000);
    }
    if (maxAum) {
      adviserQuery = adviserQuery.lte('total_aum', parseFloat(maxAum) * 1000000);
    }

    adviserQuery = adviserQuery.order('total_aum', { ascending: false }).limit(parseInt(limit));
    const { data, error } = await adviserQuery;

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Adviser search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get single adviser by CRD
app.get('/api/advisers/:crd', async (req, res) => {
  try {
    const { crd } = req.params;
    const { data, error } = await advClient
      .from('advisers_enriched')
      .select('*')
      .eq('crd', crd)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Adviser fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get funds by adviser CRD
app.get('/api/advisers/:crd/funds', async (req, res) => {
  try {
    const { crd } = req.params;
    const { data, error } = await advClient
      .from('funds_enriched')
      .select('*')
      .eq('adviser_entity_crd', crd);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Adviser funds error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Search ADV Funds with pagination
app.get('/api/funds/adv', async (req, res) => {
  try {
    const { query, page = 1, pageSize = 100, exemption3c1, exemption3c7, sortBy = 'updated_at', sortOrder = 'desc' } = req.query;

    const pageNum = parseInt(page);
    const pageSizeNum = Math.min(parseInt(pageSize), 500);
    const offset = (pageNum - 1) * pageSizeNum;

    console.log(`[Gemini] Searching ADV funds: ${query || '(all)'}`);

    let dbQuery = advClient.from('funds_enriched').select('*', { count: 'exact' });

    if (query) {
      dbQuery = dbQuery.or(`fund_name.ilike.%${query}%,adviser_entity_legal_name.ilike.%${query}%`);
    }

    if (exemption3c1 === 'yes') {
      dbQuery = dbQuery.eq('exclusion_3c1', 'Y');
    } else if (exemption3c1 === 'no') {
      dbQuery = dbQuery.or('exclusion_3c1.neq.Y,exclusion_3c1.is.null');
    }

    if (exemption3c7 === 'yes') {
      dbQuery = dbQuery.eq('exclusion_3c7', 'Y');
    } else if (exemption3c7 === 'no') {
      dbQuery = dbQuery.or('exclusion_3c7.neq.Y,exclusion_3c7.is.null');
    }

    const validSortColumns = ['updated_at', 'created_at', 'fund_name', 'latest_gross_asset_value', 'adviser_entity_legal_name'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'updated_at';
    dbQuery = dbQuery.order(sortColumn, { ascending: sortOrder === 'asc', nullsFirst: false });
    dbQuery = dbQuery.range(offset, offset + pageSizeNum - 1);

    const { data, error, count } = await dbQuery;
    if (error) throw error;

    res.json({
      success: true,
      results: data || [],
      pagination: {
        page: pageNum,
        pageSize: pageSizeNum,
        totalResults: count || 0,
        totalPages: Math.ceil((count || 0) / pageSizeNum),
        hasMore: pageNum < Math.ceil((count || 0) / pageSizeNum)
      }
    });
  } catch (error) {
    console.error('ADV search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get single fund by name
app.get('/api/funds/by-name', async (req, res) => {
  try {
    const { name, crd } = req.query;
    let dbQuery = advClient.from('funds_enriched').select('*');

    if (name) {
      dbQuery = dbQuery.eq('fund_name', name);
    }
    if (crd) {
      dbQuery = dbQuery.eq('adviser_entity_crd', crd);
    }

    const { data, error } = await dbQuery.limit(1).single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Fund fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Find Form D match for a fund by name (fuzzy matching)
app.get('/api/funds/formd-match', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.json({ match: null });
    }

    console.log(`[Gemini] Finding Form D match for: ${name}`);
    const normalizedName = normalizeName(name);

    // Search Form D database for potential matches
    const { data, error } = await formdClient
      .from('form_d_filings')
      .select('cik,entityname,filing_date,totalofferingamount,totalamountsold,federalexemptions_items_list,stateorcountry,related_names,related_roles,accessionnumber')
      .or(`entityname.ilike.%${name.substring(0, 20)}%,entityname.ilike.%${name.split(' ').slice(0, 3).join('%')}%`)
      .limit(50);

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.json({ match: null });
    }

    // Find best match using similarity scoring
    let bestMatch = null;
    let bestScore = 0;

    for (const filing of data) {
      const normalizedFormd = normalizeName(filing.entityname);
      const score = similarity(normalizedName, normalizedFormd);

      if (score > bestScore && score > 0.6) { // 60% similarity threshold
        bestScore = score;
        bestMatch = {
          ...filing,
          match_score: score
        };
      }
    }

    res.json({ match: bestMatch });
  } catch (error) {
    console.error('Form D match error:', error);
    res.status(500).json({ error: error.message, match: null });
  }
});

// API: Search Form D filings
app.get('/api/funds/formd', async (req, res) => {
  try {
    const { query, limit = 1000, startDate, endDate, state } = req.query;
    console.log(`[Gemini] Searching Form D: ${query || '(all)'}`);

    if (query && query.length < 5) {
      return res.json({ success: true, results: [], message: 'Search query must be at least 5 characters' });
    }

    let dbQuery = formdClient
      .from('form_d_filings')
      .select('accessionnumber,entityname,cik,filing_date,stateorcountry,federalexemptions_items_list,investmentfundtype,related_names,related_roles,totalofferingamount,totalamountsold');

    if (query) {
      dbQuery = dbQuery.or(`entityname.ilike.%${query}%,related_names.ilike.%${query}%`);
    }

    // Note: Date filters may not work perfectly with mixed formats, but we'll apply them
    if (startDate) dbQuery = dbQuery.gte('filing_date', startDate);
    if (endDate) dbQuery = dbQuery.lte('filing_date', endDate);
    if (state) dbQuery = dbQuery.eq('stateorcountry', state);

    // Fetch more than needed for proper sorting, then limit after sorting
    dbQuery = dbQuery.limit(Math.min(parseInt(limit) * 3, 5000));

    const { data, error } = await dbQuery;
    if (error) throw error;

    // Sort by parsed date (handles mixed DD-MMM-YYYY and YYYY-MM-DD formats)
    const sortedData = (data || []).sort((a, b) => {
      const dateA = parseFilingDate(a.filing_date);
      const dateB = parseFilingDate(b.filing_date);
      return dateB - dateA; // Descending (newest first)
    });

    // Deduplicate by CIK (keep most recent filing for each CIK)
    const fundMap = new Map();
    for (const filing of sortedData) {
      const key = filing.cik || filing.entityname;
      if (!fundMap.has(key)) {
        fundMap.set(key, filing);
      }
    }

    // Apply limit after deduplication
    const results = Array.from(fundMap.values()).slice(0, parseInt(limit));

    res.json({ success: true, results });
  } catch (error) {
    console.error('Form D search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Browse cross-reference matches
app.get('/api/browse-computed', async (req, res) => {
  try {
    const { limit = 10000, offset = 0, discrepanciesOnly, overdueAdvOnly, searchTerm } = req.query;
    console.log(`[Gemini] Browsing computed matches`);

    let query = formdClient.from('cross_reference_matches').select('*', { count: 'estimated' });

    if (searchTerm && searchTerm.trim().length > 0) {
      query = query.or(`adv_fund_name.ilike.%${searchTerm}%,formd_entity_name.ilike.%${searchTerm}%,adviser_entity_legal_name.ilike.%${searchTerm}%`);
    }

    if (discrepanciesOnly === 'true') {
      query = query.not('issues', 'is', null).neq('issues', '');
    }

    if (overdueAdvOnly === 'true') {
      query = query.eq('overdue_adv_flag', true);
    }

    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1).order('computed_at', { ascending: false });

    const { data: matches, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      matches: matches || [],
      total_matches: count || matches?.length || 0,
      inconsistency_count: (matches || []).filter(m => m.issues && m.issues.trim() !== '').length
    });
  } catch (error) {
    console.error('Browse computed error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: New Managers
app.get('/api/funds/new-managers', async (req, res) => {
  try {
    const { startDate, endDate, fundType, state } = req.query;
    console.log(`[Gemini] Fetching new managers from ${startDate || 'beginning'} to ${endDate || 'now'}, fundType: ${fundType || 'all'}, state: ${state || 'all'}`);

    // Use paginated fetch to get all results (Supabase has 1000 row limit)
    const data = await fetchAllResultsPaginated((from, to) => {
      let q = formdClient
        .from('form_d_filings')
        .select('*')
        .ilike('entityname', '%a series of%')
        .range(from, to);

      if (startDate) q = q.gte('filing_date', startDate);
      if (endDate) q = q.lte('filing_date', endDate);
      if (fundType) q = q.ilike('investmentfundtype', `%${fundType}%`);
      if (state) q = q.eq('stateorcountry', state);

      return q;
    });

    console.log(`  Total filings fetched: ${data.length}`);

    // Sort by parsed date first (handles mixed DD-MMM-YYYY and YYYY-MM-DD formats)
    const sortedData = (data || []).sort((a, b) => {
      const dateA = parseFilingDate(a.filing_date);
      const dateB = parseFilingDate(b.filing_date);
      return dateB - dateA; // Descending (newest first)
    });

    // Group by series master
    const seriesPattern = /,?\s+a\s+series\s+of\s+(.+?)(?:\s*,?\s*$|$)/i;
    const adminUmbrellas = ['roll up vehicles', 'angellist funds', 'multimodal ventures', 'mv funds', 'cgf2021 llc', 'sydecar'];
    const managers = {};

    sortedData.forEach(filing => {
      const match = (filing.entityname || '').match(seriesPattern);
      if (match) {
        const masterLlc = match[1].trim();
        const isAdmin = adminUmbrellas.some(p => masterLlc.toLowerCase().includes(p));
        if (!isAdmin) {
          if (!managers[masterLlc]) {
            managers[masterLlc] = {
              series_master_llc: masterLlc,
              first_filing_date: filing.filing_date,
              first_filing_date_parsed: parseFilingDate(filing.filing_date),
              funds: [],
              total_offering_amount: 0,
              fund_count: 0
            };
          }
          managers[masterLlc].funds.push(filing);
          managers[masterLlc].fund_count++;
          managers[masterLlc].total_offering_amount += parseFloat(filing.totalofferingamount) || 0;
          // Compare using parsed dates
          const currentParsed = parseFilingDate(filing.filing_date);
          if (currentParsed < managers[masterLlc].first_filing_date_parsed) {
            managers[masterLlc].first_filing_date = filing.filing_date;
            managers[masterLlc].first_filing_date_parsed = currentParsed;
          }
        }
      }
    });

    // Sort managers by first filing date (newest first) using parsed dates
    const result = Object.values(managers).sort((a, b) => {
      return b.first_filing_date_parsed - a.first_filing_date_parsed;
    });

    res.json({ success: true, managers: result, total: result.length });
  } catch (error) {
    console.error('New managers error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3009;
app.listen(PORT, () => {
  console.log(`\n🚀 Gemini Cross-Reference Visualizer running on port ${PORT}\n`);
});
