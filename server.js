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

    // Sort by aum_2025 (most complete), push NULLs to end
    adviserQuery = adviserQuery.order('aum_2025', { ascending: false, nullsFirst: false }).limit(parseInt(limit));
    const { data, error } = await adviserQuery;

    if (error) throw error;

    // Enrich advisers with fund counts using database-level aggregation
    const advisers = data || [];
    if (advisers.length > 0) {
      const crdList = advisers.map(a => a.crd).filter(Boolean);
      const crdStrings = crdList.map(c => String(c));

      if (crdStrings.length > 0) {
        // OPTIMIZED: Use parallel count queries with head: true (no row data transferred)
        // This is much faster than fetching all rows just to count them
        const countPromises = crdStrings.map(crd =>
          advClient
            .from('funds_enriched')
            .select('*', { count: 'exact', head: true })
            .eq('adviser_entity_crd', crd)
            .then(({ count, error }) => ({ crd, count: error ? 0 : (count || 0) }))
        );

        const countResults = await Promise.all(countPromises);

        // Build count map from results
        const countMap = {};
        countResults.forEach(({ crd, count }) => {
          countMap[crd] = count;
        });

        console.log(`[FundCount] Got counts for ${crdStrings.length} advisers via parallel database queries`);

        // Merge counts into advisers
        advisers.forEach(a => {
          a.fund_count = countMap[String(a.crd)] || 0;
        });
      }
    }

    res.json(advisers);
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

    // Enrich ADV funds with Form D cross-reference data using DIRECT lookup
    // The cross_reference_matches table has adv_fund_name that matches funds_enriched.fund_name exactly
    let crossRefMap = {};
    if (data && data.length > 0) {
      const fundNames = data.map(f => f.fund_name).filter(Boolean);

      if (fundNames.length > 0) {
        try {
          // DIRECT LOOKUP: Query cross_reference_matches by exact fund names (in batches if needed)
          // This is much more reliable than word-based fuzzy matching
          const { data: matches, error: crossRefError } = await formdClient
            .from('cross_reference_matches')
            .select('adv_fund_name,formd_entity_name,formd_filing_date,formd_offering_amount,formd_amount_sold,formd_indefinite,formd_accession,match_score')
            .in('adv_fund_name', fundNames);

          if (crossRefError) {
            console.error('[ADV Search] Cross-reference query error:', crossRefError.message);
          } else if (matches && matches.length > 0) {
            // Build map from adv_fund_name to match data (keep best match per fund)
            matches.forEach(match => {
              const key = match.adv_fund_name;
              if (!crossRefMap[key] || (match.match_score > (crossRefMap[key].match_score || 0))) {
                crossRefMap[key] = match;
              }
            });
            console.log(`[ADV Search] Direct lookup found ${matches.length} Form D matches for ${fundNames.length} funds, linked ${Object.keys(crossRefMap).length} unique`);
          } else {
            console.log(`[ADV Search] No Form D matches found for ${fundNames.length} funds`);
          }
        } catch (crossRefErr) {
          console.error('[ADV Search] Cross-reference lookup failed:', crossRefErr.message);
          // Continue without cross-reference data rather than failing
        }
      }
    }

    // Add source field and Form D enrichment to each result
    const results = (data || []).map(fund => {
      const crossRef = crossRefMap[fund.fund_name];
      return {
        ...fund,
        source: 'adv',
        // Add Form D data from pre-computed cross-reference matches
        form_d_entity_name: crossRef?.formd_entity_name || null,
        form_d_filing_date: crossRef?.formd_filing_date || null,
        form_d_offering_amount: crossRef?.formd_offering_amount || null,
        form_d_amount_sold: crossRef?.formd_amount_sold || null,
        form_d_indefinite: crossRef?.formd_indefinite || false,
        form_d_accession: crossRef?.formd_accession || null,
        form_d_match_score: crossRef?.match_score || null,
        has_form_d_match: !!crossRef
      };
    });

    res.json({
      success: true,
      results,
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
      .select('cik,entityname,filing_date,sale_date,totalofferingamount,totalamountsold,indefiniteofferingamount,federalexemptions_items_list,stateorcountry,related_names,related_roles,accessionnumber')
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
      .select('accessionnumber,entityname,cik,filing_date,stateorcountry,federalexemptions_items_list,investmentfundtype,related_names,related_roles,totalofferingamount,totalamountsold,indefiniteofferingamount');

    if (query) {
      dbQuery = dbQuery.or(`entityname.ilike.%${query}%,related_names.ilike.%${query}%`);
    }

    // Note: Date filters may not work perfectly with mixed formats, but we'll apply them
    if (startDate) dbQuery = dbQuery.gte('filing_date', startDate);
    if (endDate) dbQuery = dbQuery.lte('filing_date', endDate);
    if (state) dbQuery = dbQuery.eq('stateorcountry', state);

    // Order by id descending (indexed, fast) to get most recent filings first
    dbQuery = dbQuery.order('id', { ascending: false }).limit(Math.min(parseInt(limit), 2000));

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

    // Apply limit after deduplication and normalize field names for frontend
    const results = Array.from(fundMap.values()).slice(0, parseInt(limit)).map(fund => ({
      ...fund,
      fund_name: fund.entityname,
      form_d_cik: fund.cik,
      form_d_filing_date: fund.filing_date,
      federal_exemptions: fund.federalexemptions_items_list,
      investment_fund_type: fund.investmentfundtype,
      form_d_offering_amount: fund.totalofferingamount,
      form_d_amount_sold: fund.totalamountsold,
      source: 'formd'
    }));

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
    const { startDate, endDate, fundType, state, query } = req.query;

    // Default to last 12 months if no date filter provided for performance
    const defaultStartDate = startDate || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    console.log(`[Gemini] Fetching new managers from ${defaultStartDate} to ${endDate || 'now'}, fundType: ${fundType || 'all'}, state: ${state || 'all'}, query: ${query || 'none'}`);

    // Use paginated fetch to get all results (Supabase has 1000 row limit)
    const data = await fetchAllResultsPaginated((from, to) => {
      let q = formdClient
        .from('form_d_filings')
        .select('*')
        .range(from, to);

      // If query provided, search entityname; otherwise filter by "a series of"
      if (query) {
        q = q.ilike('entityname', `%${query}%`);
      } else {
        q = q.ilike('entityname', '%a series of%');
      }

      // Always apply date filter (default to last 12 months for performance)
      q = q.gte('filing_date', defaultStartDate);
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
    let result = Object.values(managers).sort((a, b) => {
      return b.first_filing_date_parsed - a.first_filing_date_parsed;
    });

    // OPTIMIZED: Batch fetch enriched_managers and advisers upfront instead of individual queries
    console.log(`[Gemini] Batch fetching enrichment data for ${result.length} managers...`);

    // Batch fetch all enriched_managers data
    const enrichedManagersData = await fetchAllResultsPaginated((from, to) => {
      return formdClient
        .from('enriched_managers')
        .select('*')
        .range(from, to);
    });

    // Create lookup map for enriched managers
    const enrichedManagersMap = {};
    enrichedManagersData.forEach(em => {
      if (em.series_master_llc) {
        enrichedManagersMap[em.series_master_llc.toLowerCase()] = em;
      }
    });
    console.log(`  Loaded ${enrichedManagersData.length} enriched managers for matching`);

    // Batch fetch all advisers for matching
    const advisersData = await fetchAllResultsPaginated((from, to) => {
      return advClient
        .from('advisers_enriched')
        .select('crd, adviser_name, adviser_entity_legal_name, primary_website, total_aum')
        .range(from, to);
    });

    // Create lookup structures for advisers
    const advisersByNameExact = {};
    const advisersByNamePrefix = [];
    advisersData.forEach(adv => {
      const name1 = (adv.adviser_name || '').toLowerCase();
      const name2 = (adv.adviser_entity_legal_name || '').toLowerCase();
      if (name1) advisersByNameExact[name1] = adv;
      if (name2) advisersByNameExact[name2] = adv;
      advisersByNamePrefix.push({
        names: [name1, name2].filter(n => n),
        adv
      });
    });
    console.log(`  Loaded ${advisersData.length} advisers for matching`);

    // Helper to parse fund name
    const parseFundName = (name) => {
      return name
        .replace(/\s+[A-Z]{2}[,\s]+(LLC|LP|L\.P\.|L\.L\.C\.)$/i, '')
        .replace(/,?\s+(LLC|LP|L\.P\.|L\.L\.C\.|Ltd|Limited|Inc|Incorporated|GP)$/i, '')
        .replace(/[,\s]+$/, '')
        .trim();
    };

    // Helper to find adviser match
    const findAdviserMatch = (parsedName) => {
      const lowerName = parsedName.toLowerCase();

      // Try exact match first
      if (advisersByNameExact[lowerName]) {
        return advisersByNameExact[lowerName];
      }

      // Try prefix match
      for (const { names, adv } of advisersByNamePrefix) {
        for (const name of names) {
          if (name.startsWith(lowerName) || lowerName.startsWith(name)) {
            return adv;
          }
        }
      }

      return null;
    };

    // Process all managers in memory (no API calls)
    const enrichedResult = result.map(manager => {
      const enrichedManager = { ...manager };
      const parsedName = parseFundName(manager.series_master_llc);

      // Check enriched_managers lookup
      const enrichedData = enrichedManagersMap[manager.series_master_llc.toLowerCase()];
      if (enrichedData) {
        enrichedManager.enrichment_data = {
          website: enrichedData.website_url,
          fund_type: enrichedData.fund_type,
          investment_stage: enrichedData.investment_stage,
          linkedin: enrichedData.linkedin_company_url,
          is_published: enrichedData.is_published,
          confidence: enrichedData.confidence_score
        };
      }

      // Check advisers lookup
      const advData = findAdviserMatch(parsedName);
      if (advData) {
        enrichedManager.has_form_adv = true;
        enrichedManager.linked_crd = advData.crd;
        enrichedManager.adv_data = {
          crd: advData.crd,
          name: advData.adviser_name || advData.adviser_entity_legal_name,
          website: advData.primary_website,
          aum: advData.total_aum
        };
      } else {
        enrichedManager.has_form_adv = false;
      }

      return enrichedManager;
    });

    const hasAdvCount = enrichedResult.filter(m => m.has_form_adv).length;
    console.log(`[Gemini] Found ${hasAdvCount} managers with existing Form ADV data`);

    res.json({ success: true, managers: enrichedResult, total: enrichedResult.length });
  } catch (error) {
    console.error('New managers error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENRICHMENT REVIEW QUEUE ROUTES
// ============================================

// Get all funds needing manual review
app.get('/api/review/queue', async (req, res) => {
  try {
    const { data, error } = await formdClient
      .from('enriched_managers')
      .select('*')
      .in('enrichment_status', ['needs_manual_review', 'platform_spv', 'no_data_found', 'conflicting_data'])
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      managers: data
    });
  } catch (error) {
    console.error('Error fetching review queue:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get auto-enriched funds (for verification)
app.get('/api/review/auto-enriched', async (req, res) => {
  try {
    const { data, error } = await formdClient
      .from('enriched_managers')
      .select('*')
      .eq('enrichment_status', 'auto_enriched')
      .eq('is_published', false)
      .order('confidence_score', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      managers: data
    });
  } catch (error) {
    console.error('Error fetching auto-enriched:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Publish a fund (mark as verified and public)
app.post('/api/review/publish', async (req, res) => {
  try {
    const { id } = req.body;

    const { data, error } = await formdClient
      .from('enriched_managers')
      .update({
        is_published: true,
        enrichment_status: 'manually_verified',
        verified_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      manager: data
    });
  } catch (error) {
    console.error('Error publishing fund:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update enrichment data
app.post('/api/review/update', async (req, res) => {
  try {
    const { id, updates } = req.body;

    const { data, error } = await formdClient
      .from('enriched_managers')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      manager: data
    });
  } catch (error) {
    console.error('Error updating fund:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Mark as not a fund / skip
app.post('/api/review/skip', async (req, res) => {
  try {
    const { id, reason } = req.body;

    const { data, error } = await formdClient
      .from('enriched_managers')
      .update({
        enrichment_status: 'not_a_fund',
        flagged_issues: reason ? [reason] : [],
        is_published: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      manager: data
    });
  } catch (error) {
    console.error('Error skipping fund:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get enrichment stats
app.get('/api/review/stats', async (req, res) => {
  try {
    const { data, error } = await formdClient
      .from('enriched_managers')
      .select('enrichment_status, is_published');

    if (error) throw error;

    const stats = {
      total: data.length,
      auto_enriched: data.filter(m => m.enrichment_status === 'auto_enriched').length,
      needs_review: data.filter(m => m.enrichment_status === 'needs_manual_review').length,
      platform_spv: data.filter(m => m.enrichment_status === 'platform_spv').length,
      no_data: data.filter(m => m.enrichment_status === 'no_data_found').length,
      manually_verified: data.filter(m => m.enrichment_status === 'manually_verified').length,
      published: data.filter(m => m.is_published).length,
      unpublished: data.filter(m => !m.is_published).length
    };

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// UNIFIED ADVISER / ENRICHED MANAGER ROUTES
// ============================================

// Get unified adviser data (Form ADV + Enriched Manager)
app.get('/api/advisers/unified/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const isCRD = /^\d+$/.test(identifier);

    let adviserData = null;
    let enrichedData = null;
    let portfolioCompanies = [];

    if (isCRD) {
      // Fetch from Form ADV by CRD
      const { data: advData } = await advClient
        .from('advisers_enriched')
        .select('*')
        .eq('crd', identifier)
        .single();

      adviserData = advData;

      // Check if also in enriched managers (linked by CRD)
      const { data: enriched } = await formdClient
        .from('enriched_managers')
        .select('*')
        .eq('linked_crd', identifier)
        .single();

      enrichedData = enriched;
    } else {
      // Fetch from enriched managers by name
      const { data: enriched } = await formdClient
        .from('enriched_managers')
        .select('*')
        .eq('series_master_llc', identifier)
        .single();

      enrichedData = enriched;

      // If has CRD, also fetch ADV data
      if (enriched && enriched.linked_crd) {
        const { data: advData } = await advClient
          .from('advisers_enriched')
          .select('*')
          .eq('crd', enriched.linked_crd)
          .single();

        adviserData = advData;
      }
    }

    // Fetch portfolio companies if enriched data exists
    if (enrichedData) {
      const { data: portfolio } = await formdClient
        .from('portfolio_companies')
        .select('*')
        .eq('manager_id', enrichedData.id)
        .order('company_name');

      portfolioCompanies = portfolio || [];
    }

    // Merge the data
    const unifiedData = {
      // Basic info (prefer ADV data if available)
      name: adviserData?.adviser_name || adviserData?.adviser_entity_legal_name || enrichedData?.series_master_llc,
      crd: adviserData?.crd || enrichedData?.linked_crd,
      website: enrichedData?.website_url || adviserData?.primary_website,

      // Form ADV specific
      hasFormADV: !!adviserData,
      advData: adviserData ? {
        aum: adviserData.total_aum,
        crd: adviserData.crd
      } : null,

      // Enriched data specific
      hasEnrichedData: !!enrichedData,
      enrichedData: enrichedData ? {
        fund_type: enrichedData.fund_type,
        investment_stage: enrichedData.investment_stage,
        linkedin_url: enrichedData.linkedin_company_url,
        confidence_score: enrichedData.confidence_score,
        enrichment_status: enrichedData.enrichment_status
      } : null,

      // Portfolio companies
      portfolioCompanies
    };

    res.json({
      success: true,
      adviser: unifiedData
    });

  } catch (error) {
    console.error('Error fetching unified adviser:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get portfolio companies for a manager
app.get('/api/managers/:managerId/portfolio', async (req, res) => {
  try {
    const { managerId } = req.params;

    const { data, error } = await formdClient
      .from('portfolio_companies')
      .select('*')
      .eq('manager_id', managerId)
      .order('company_name');

    if (error) throw error;

    res.json({
      success: true,
      companies: data || [],
      count: data?.length || 0
    });

  } catch (error) {
    console.error('Error fetching portfolio companies:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3009;
app.listen(PORT, () => {
  console.log(`\n🚀 Gemini Cross-Reference Visualizer running on port ${PORT}\n`);
});
