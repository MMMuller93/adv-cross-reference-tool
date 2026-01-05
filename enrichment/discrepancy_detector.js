/**
 * FORM D / FORM ADV DISCREPANCY DETECTOR
 * 
 * Detects compliance issues and data discrepancies between Form D and Form ADV filings:
 * 
 * 1. NEEDS_INITIAL_ADV - New manager, Form D filed, no ADV within 60 days
 * 2. OVERDUE_ANNUAL_ADV - Existing filer, no 2025 update by April 1
 * 3. VC_EXEMPTION_VIOLATION - Claims VC exemption but has ANY PE/hedge/other fund
 * 4. FUND_TYPE_MISMATCH - Form D vs Form ADV fund type differs
 * 5. MISSING_FUND_IN_ADV - Form D filed but fund not listed in ADV
 * 6. EXEMPTION_MISMATCH - 3(c)(1) vs 3(c)(7) differs between filings
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

// Database connections
const FORMD_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const ADV_URL = 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = process.env.ADV_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

const formdClient = createClient(FORMD_URL, FORMD_KEY);
const advClient = createClient(ADV_URL, ADV_KEY);

// ============================================================================
// DISCREPANCY TYPES
// ============================================================================

const DISCREPANCY_TYPES = {
  NEEDS_INITIAL_ADV: {
    code: 'NEEDS_INITIAL_ADV',
    severity: 'high',
    description: 'New manager needs to file initial Form ADV within 60 days of closing first fund',
    actionable: true
  },
  OVERDUE_ANNUAL_ADV: {
    code: 'OVERDUE_ANNUAL_ADV',
    severity: 'high',
    description: 'Annual Form ADV amendment overdue (due 90 days after fiscal year end)',
    actionable: true
  },
  VC_EXEMPTION_VIOLATION: {
    code: 'VC_EXEMPTION_VIOLATION',
    severity: 'critical',
    description: 'Adviser claims VC exemption but manages non-VC funds',
    actionable: true
  },
  FUND_TYPE_MISMATCH: {
    code: 'FUND_TYPE_MISMATCH',
    severity: 'medium',
    description: 'Fund type differs between Form D and Form ADV',
    actionable: true
  },
  MISSING_FUND_IN_ADV: {
    code: 'MISSING_FUND_IN_ADV',
    severity: 'medium',
    description: 'Fund has Form D filing but not listed in Form ADV',
    actionable: true
  },
  EXEMPTION_MISMATCH: {
    code: 'EXEMPTION_MISMATCH',
    severity: 'medium',
    description: 'Exemption type differs between Form D and Form ADV (3(c)(1) vs 3(c)(7))',
    actionable: true
  }
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Parse date string to Date object
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  
  // Handle various date formats
  // "31-JAN-2024" format
  const monthMap = {
    'JAN': 0, 'FEB': 1, 'MAR': 2, 'APR': 3, 'MAY': 4, 'JUN': 5,
    'JUL': 6, 'AUG': 7, 'SEP': 8, 'OCT': 9, 'NOV': 10, 'DEC': 11
  };
  
  const match = dateStr.match(/(\d{1,2})-([A-Z]{3})-(\d{4})/i);
  if (match) {
    const day = parseInt(match[1]);
    const month = monthMap[match[2].toUpperCase()];
    const year = parseInt(match[3]);
    return new Date(year, month, day);
  }
  
  // Try ISO format
  const isoDate = new Date(dateStr);
  if (!isNaN(isoDate.getTime())) {
    return isoDate;
  }
  
  return null;
}

/**
 * Calculate days between two dates
 */
function daysBetween(date1, date2) {
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.round(Math.abs((date2 - date1) / oneDay));
}

/**
 * Normalize fund name for comparison
 */
function normalizeFundName(name) {
  if (!name) return '';
  return name
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[,\.]/g, '')
    .replace(/\bL\.?P\.?\b/gi, 'LP')
    .replace(/\bLLC\b/gi, '')
    .replace(/\bINC\b/gi, '')
    .replace(/\s+I\s+/g, ' 1 ')
    .replace(/\s+II\s+/g, ' 2 ')
    .replace(/\s+III\s+/g, ' 3 ')
    .replace(/\s+IV\s+/g, ' 4 ')
    .trim();
}

/**
 * Calculate string similarity (Levenshtein-based)
 */
function similarity(s1, s2) {
  if (!s1 || !s2) return 0;
  
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(s1, s2) {
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

/**
 * Map Form D fund type to standardized type
 */
function mapFormDFundType(investmentFundType) {
  if (!investmentFundType) return null;
  
  const type = investmentFundType.toLowerCase();
  
  if (type.includes('venture')) return 'Venture Capital';
  if (type.includes('private equity') || type.includes('buyout')) return 'Private Equity';
  if (type.includes('hedge')) return 'Hedge Fund';
  if (type.includes('real estate')) return 'Real Estate';
  if (type.includes('other')) return 'Other';
  
  return investmentFundType;
}

/**
 * Map Form ADV fund type to standardized type
 */
function mapFormADVFundType(fundType) {
  if (!fundType) return null;
  
  const type = fundType.toLowerCase();
  
  if (type.includes('venture')) return 'Venture Capital';
  if (type.includes('private equity') || type.includes('buyout')) return 'Private Equity';
  if (type.includes('hedge')) return 'Hedge Fund';
  if (type.includes('real estate')) return 'Real Estate';
  if (type.includes('securitized')) return 'Securitized Asset';
  if (type.includes('other')) return 'Other';
  
  return fundType;
}

// ============================================================================
// DISCREPANCY DETECTION FUNCTIONS
// ============================================================================

/**
 * Detect managers who need to file initial Form ADV
 * (Form D filed, no ADV within 60 days)
 */
async function detectNeedsInitialADV() {
  console.log('[Discrepancy] Detecting managers needing initial Form ADV...');
  
  const discrepancies = [];
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  
  // Get recent Form D filings that are potential new managers
  const { data: formDFilings, error } = await formdClient
    .from('form_d_filings')
    .select('*')
    .eq('potential_new_manager', true)
    .not('series_master_llc', 'is', null)
    .order('filing_date', { ascending: false })
    .limit(1000);
  
  if (error || !formDFilings) {
    console.error('[Discrepancy] Error fetching Form D filings:', error?.message);
    return discrepancies;
  }
  
  // Group by series master
  const managerFilings = {};
  for (const filing of formDFilings) {
    const master = filing.series_master_llc;
    if (!managerFilings[master]) {
      managerFilings[master] = {
        series_master_llc: master,
        first_filing_date: filing.filing_date,
        filings: []
      };
    }
    managerFilings[master].filings.push(filing);
    
    // Track earliest filing
    const filingDate = parseDate(filing.filing_date);
    const currentFirst = parseDate(managerFilings[master].first_filing_date);
    if (filingDate && currentFirst && filingDate < currentFirst) {
      managerFilings[master].first_filing_date = filing.filing_date;
    }
  }
  
  // Check each manager against Form ADV database
  for (const [master, data] of Object.entries(managerFilings)) {
    const firstFilingDate = parseDate(data.first_filing_date);
    if (!firstFilingDate) continue;
    
    const daysSinceFiling = daysBetween(firstFilingDate, new Date());
    
    // Only flag if more than 60 days since first filing
    if (daysSinceFiling <= 60) continue;
    
    // Check if they have a Form ADV
    const { data: advData } = await advClient
      .from('advisers_enriched')
      .select('crd, adviser_name')
      .or(`adviser_name.ilike.%${master.split(' ')[0]}%,adviser_entity_legal_name.ilike.%${master.split(' ')[0]}%`)
      .limit(1);
    
    if (!advData || advData.length === 0) {
      discrepancies.push({
        type: DISCREPANCY_TYPES.NEEDS_INITIAL_ADV.code,
        severity: DISCREPANCY_TYPES.NEEDS_INITIAL_ADV.severity,
        entity_name: master,
        first_form_d_date: data.first_filing_date,
        days_since_filing: daysSinceFiling,
        days_overdue: daysSinceFiling - 60,
        fund_count: data.filings.length,
        details: {
          description: `Manager filed Form D ${daysSinceFiling} days ago but has no Form ADV on file. Initial ADV was due within 60 days.`,
          filings: data.filings.slice(0, 5).map(f => ({
            accession: f.accessionnumber,
            entity_name: f.entityname,
            filing_date: f.filing_date
          }))
        },
        contact_info: null, // Will be enriched separately
        detected_at: new Date().toISOString()
      });
    }
  }
  
  console.log(`[Discrepancy] Found ${discrepancies.length} managers needing initial ADV`);
  return discrepancies;
}

/**
 * Detect advisers with overdue annual Form ADV amendments
 * (Existing filer, no 2025 update by April 1)
 */
async function detectOverdueAnnualADV() {
  console.log('[Discrepancy] Detecting overdue annual Form ADV amendments...');
  
  const discrepancies = [];
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1; // 1-12
  const currentDay = new Date().getDate();
  
  // Only flag after April 1 (most funds have Dec 31 fiscal year, due March 31)
  // Add buffer: flag after April 15
  const isAfterDeadline = currentMonth > 4 || (currentMonth === 4 && currentDay >= 15);
  
  if (!isAfterDeadline) {
    console.log('[Discrepancy] Before April 15, skipping overdue annual ADV check');
    return discrepancies;
  }
  
  // Get advisers from cross_reference_matches with old ADV year
  const { data: matches, error } = await formdClient
    .from('cross_reference_matches')
    .select('*')
    .lt('latest_adv_year', currentYear.toString())
    .order('formd_filing_date', { ascending: false })
    .limit(500);
  
  if (error || !matches) {
    console.error('[Discrepancy] Error fetching cross references:', error?.message);
    return discrepancies;
  }
  
  // Group by adviser
  const adviserMatches = {};
  for (const match of matches) {
    const crd = match.adviser_entity_crd;
    if (!crd) continue;
    
    if (!adviserMatches[crd]) {
      adviserMatches[crd] = {
        crd,
        adviser_name: match.adviser_entity_legal_name,
        latest_adv_year: match.latest_adv_year,
        funds: []
      };
    }
    adviserMatches[crd].funds.push(match);
  }
  
  // Create discrepancies
  for (const [crd, data] of Object.entries(adviserMatches)) {
    // Get contact info from Form ADV
    const { data: advData } = await advClient
      .from('advisers_enriched')
      .select('cco_name, cco_email, phone_number, primary_website')
      .eq('crd', crd)
      .single();
    
    discrepancies.push({
      type: DISCREPANCY_TYPES.OVERDUE_ANNUAL_ADV.code,
      severity: DISCREPANCY_TYPES.OVERDUE_ANNUAL_ADV.severity,
      entity_name: data.adviser_name,
      crd: crd,
      latest_adv_year: data.latest_adv_year,
      expected_year: currentYear.toString(),
      fund_count: data.funds.length,
      details: {
        description: `Adviser's latest Form ADV is from ${data.latest_adv_year}. Annual amendment for ${currentYear} was due by March 31.`,
        recent_form_d_filings: data.funds.slice(0, 5).map(f => ({
          fund_name: f.formd_entity_name,
          filing_date: f.formd_filing_date
        }))
      },
      contact_info: advData ? {
        cco_name: advData.cco_name,
        cco_email: advData.cco_email,
        phone: advData.phone_number,
        website: advData.primary_website
      } : null,
      detected_at: new Date().toISOString()
    });
  }
  
  console.log(`[Discrepancy] Found ${discrepancies.length} advisers with overdue annual ADV`);
  return discrepancies;
}

/**
 * Detect VC exemption violations
 * (Adviser claims VC exemption but has ANY PE/hedge/other fund)
 */
async function detectVCExemptionViolations() {
  console.log('[Discrepancy] Detecting VC exemption violations...');
  
  const discrepancies = [];
  
  // Get advisers claiming VC exemption (exemption_2b1 = true means Venture Capital adviser exemption)
  const { data: vcAdvisers, error } = await advClient
    .from('advisers_enriched')
    .select('crd, adviser_name, adviser_entity_legal_name, exemption_2b1, exemption_2b2, exemption_2b3, cco_name, cco_email, phone_number, primary_website')
    .eq('exemption_2b1', true)
    .limit(500);
  
  if (error || !vcAdvisers) {
    console.error('[Discrepancy] Error fetching VC advisers:', error?.message);
    return discrepancies;
  }
  
  console.log(`[Discrepancy] Checking ${vcAdvisers.length} VC-exempt advisers...`);
  
  // For each VC adviser, check their funds
  for (const adviser of vcAdvisers) {
    // Get their funds from funds_enriched
    const { data: funds } = await advClient
      .from('funds_enriched')
      .select('fund_name, fund_type')
      .eq('crd', adviser.crd);
    
    if (!funds || funds.length === 0) continue;
    
    // Check for non-VC funds
    const nonVCFunds = funds.filter(f => {
      const type = (f.fund_type || '').toLowerCase();
      return type.includes('private equity') ||
             type.includes('hedge') ||
             type.includes('real estate') ||
             type.includes('credit') ||
             type.includes('buyout');
    });
    
    if (nonVCFunds.length > 0) {
      discrepancies.push({
        type: DISCREPANCY_TYPES.VC_EXEMPTION_VIOLATION.code,
        severity: DISCREPANCY_TYPES.VC_EXEMPTION_VIOLATION.severity,
        entity_name: adviser.adviser_name || adviser.adviser_entity_legal_name,
        crd: adviser.crd,
        total_funds: funds.length,
        non_vc_fund_count: nonVCFunds.length,
        details: {
          description: `Adviser claims Venture Capital adviser exemption (Item 2.B(1)) but manages ${nonVCFunds.length} non-VC fund(s). VC exemption requires ALL funds to be qualifying venture capital funds.`,
          non_vc_funds: nonVCFunds.slice(0, 10).map(f => ({
            fund_name: f.fund_name,
            fund_type: f.fund_type
          }))
        },
        contact_info: {
          cco_name: adviser.cco_name,
          cco_email: adviser.cco_email,
          phone: adviser.phone_number,
          website: adviser.primary_website
        },
        detected_at: new Date().toISOString()
      });
    }
  }
  
  console.log(`[Discrepancy] Found ${discrepancies.length} VC exemption violations`);
  return discrepancies;
}

/**
 * Detect fund type mismatches between Form D and Form ADV
 */
async function detectFundTypeMismatches() {
  console.log('[Discrepancy] Detecting fund type mismatches...');
  
  const discrepancies = [];
  
  // Get cross-reference matches
  const { data: matches, error } = await formdClient
    .from('cross_reference_matches')
    .select('*')
    .gte('match_score', 0.9) // High confidence matches only
    .limit(1000);
  
  if (error || !matches) {
    console.error('[Discrepancy] Error fetching matches:', error?.message);
    return discrepancies;
  }
  
  for (const match of matches) {
    // Get Form D fund type
    const { data: formdData } = await formdClient
      .from('form_d_filings')
      .select('investmentfundtype, entityname')
      .eq('accessionnumber', match.formd_accession)
      .single();
    
    if (!formdData || !formdData.investmentfundtype) continue;
    
    // Get Form ADV fund type
    const { data: advFund } = await advClient
      .from('funds_enriched')
      .select('fund_type, fund_name')
      .eq('fund_id', match.adv_fund_id)
      .single();
    
    if (!advFund || !advFund.fund_type) continue;
    
    // Compare types
    const formdType = mapFormDFundType(formdData.investmentfundtype);
    const advType = mapFormADVFundType(advFund.fund_type);
    
    if (formdType && advType && formdType !== advType) {
      // Get adviser contact info
      const { data: adviserData } = await advClient
        .from('advisers_enriched')
        .select('cco_name, cco_email, phone_number, primary_website')
        .eq('crd', match.adviser_entity_crd)
        .single();
      
      discrepancies.push({
        type: DISCREPANCY_TYPES.FUND_TYPE_MISMATCH.code,
        severity: DISCREPANCY_TYPES.FUND_TYPE_MISMATCH.severity,
        entity_name: match.adviser_entity_legal_name,
        crd: match.adviser_entity_crd,
        fund_name: match.adv_fund_name,
        form_d_type: formdType,
        form_adv_type: advType,
        details: {
          description: `Fund type mismatch: Form D shows "${formdType}" but Form ADV shows "${advType}". This may indicate a data entry error or fund strategy change.`,
          form_d_filing: {
            accession: match.formd_accession,
            entity_name: formdData.entityname,
            filing_date: match.formd_filing_date
          }
        },
        contact_info: adviserData ? {
          cco_name: adviserData.cco_name,
          cco_email: adviserData.cco_email,
          phone: adviserData.phone_number,
          website: adviserData.primary_website
        } : null,
        detected_at: new Date().toISOString()
      });
    }
  }
  
  console.log(`[Discrepancy] Found ${discrepancies.length} fund type mismatches`);
  return discrepancies;
}

/**
 * Detect funds with Form D but not listed in Form ADV
 */
async function detectMissingFundsInADV() {
  console.log('[Discrepancy] Detecting funds missing from Form ADV...');
  
  const discrepancies = [];
  
  // Get Form D filings that are pooled investment funds
  const { data: formDFilings, error } = await formdClient
    .from('form_d_filings')
    .select('*')
    .eq('ispooledinvestmentfundtype', 'true')
    .not('linked_adviser_crd', 'is', null)
    .order('filing_date', { ascending: false })
    .limit(500);
  
  if (error || !formDFilings) {
    console.error('[Discrepancy] Error fetching Form D filings:', error?.message);
    return discrepancies;
  }
  
  // Check each against cross_reference_matches
  for (const filing of formDFilings) {
    // Check if this filing has a match
    const { data: match } = await formdClient
      .from('cross_reference_matches')
      .select('id')
      .eq('formd_accession', filing.accessionnumber)
      .single();
    
    if (!match) {
      // No match found - this fund might be missing from ADV
      
      // Get adviser info
      const { data: adviserData } = await advClient
        .from('advisers_enriched')
        .select('adviser_name, cco_name, cco_email, phone_number, primary_website')
        .eq('crd', filing.linked_adviser_crd)
        .single();
      
      if (adviserData) {
        discrepancies.push({
          type: DISCREPANCY_TYPES.MISSING_FUND_IN_ADV.code,
          severity: DISCREPANCY_TYPES.MISSING_FUND_IN_ADV.severity,
          entity_name: adviserData.adviser_name,
          crd: filing.linked_adviser_crd,
          fund_name: filing.entityname,
          form_d_accession: filing.accessionnumber,
          form_d_filing_date: filing.filing_date,
          details: {
            description: `Fund "${filing.entityname}" has a Form D filing but is not listed in the adviser's Form ADV. This may indicate the fund needs to be added to Schedule D.`,
            form_d_details: {
              offering_amount: filing.totalofferingamount,
              fund_type: filing.investmentfundtype,
              filing_date: filing.filing_date
            }
          },
          contact_info: {
            cco_name: adviserData.cco_name,
            cco_email: adviserData.cco_email,
            phone: adviserData.phone_number,
            website: adviserData.primary_website
          },
          detected_at: new Date().toISOString()
        });
      }
    }
  }
  
  console.log(`[Discrepancy] Found ${discrepancies.length} funds missing from ADV`);
  return discrepancies;
}

/**
 * Detect exemption mismatches (3(c)(1) vs 3(c)(7))
 */
async function detectExemptionMismatches() {
  console.log('[Discrepancy] Detecting exemption mismatches...');
  
  const discrepancies = [];
  
  // Get cross-reference matches with high confidence
  const { data: matches, error } = await formdClient
    .from('cross_reference_matches')
    .select('*')
    .gte('match_score', 0.9)
    .limit(500);
  
  if (error || !matches) {
    console.error('[Discrepancy] Error fetching matches:', error?.message);
    return discrepancies;
  }
  
  for (const match of matches) {
    // Get Form D exemption info
    const { data: formdData } = await formdClient
      .from('form_d_filings')
      .select('federalexemptions_items_list, entityname')
      .eq('accessionnumber', match.formd_accession)
      .single();
    
    if (!formdData) continue;
    
    // Get Form ADV fund exemption info
    const { data: advFund } = await advClient
      .from('funds_enriched')
      .select('exclusion_3c1, exclusion_3c7, fund_name')
      .eq('fund_id', match.adv_fund_id)
      .single();
    
    if (!advFund) continue;
    
    // Parse Form D exemptions
    const formdExemptions = formdData.federalexemptions_items_list || '';
    const formdHas3c1 = formdExemptions.includes('3(c)(1)');
    const formdHas3c7 = formdExemptions.includes('3(c)(7)');
    
    // Compare
    const advHas3c1 = advFund.exclusion_3c1 === true || advFund.exclusion_3c1 === 'true';
    const advHas3c7 = advFund.exclusion_3c7 === true || advFund.exclusion_3c7 === 'true';
    
    // Check for mismatch
    if ((formdHas3c1 && !advHas3c1 && advHas3c7) || (formdHas3c7 && !advHas3c7 && advHas3c1)) {
      // Get adviser contact info
      const { data: adviserData } = await advClient
        .from('advisers_enriched')
        .select('cco_name, cco_email, phone_number, primary_website')
        .eq('crd', match.adviser_entity_crd)
        .single();
      
      discrepancies.push({
        type: DISCREPANCY_TYPES.EXEMPTION_MISMATCH.code,
        severity: DISCREPANCY_TYPES.EXEMPTION_MISMATCH.severity,
        entity_name: match.adviser_entity_legal_name,
        crd: match.adviser_entity_crd,
        fund_name: match.adv_fund_name,
        form_d_exemption: formdHas3c1 ? '3(c)(1)' : (formdHas3c7 ? '3(c)(7)' : 'Unknown'),
        form_adv_exemption: advHas3c1 ? '3(c)(1)' : (advHas3c7 ? '3(c)(7)' : 'Unknown'),
        details: {
          description: `Exemption mismatch: Form D claims ${formdHas3c1 ? '3(c)(1)' : '3(c)(7)'} but Form ADV shows ${advHas3c1 ? '3(c)(1)' : '3(c)(7)'}. This affects investor count limits and qualification requirements.`,
          form_d_filing: {
            accession: match.formd_accession,
            filing_date: match.formd_filing_date
          }
        },
        contact_info: adviserData ? {
          cco_name: adviserData.cco_name,
          cco_email: adviserData.cco_email,
          phone: adviserData.phone_number,
          website: adviserData.primary_website
        } : null,
        detected_at: new Date().toISOString()
      });
    }
  }
  
  console.log(`[Discrepancy] Found ${discrepancies.length} exemption mismatches`);
  return discrepancies;
}

// ============================================================================
// MAIN DETECTION FUNCTION
// ============================================================================

/**
 * Run all discrepancy detections
 */
async function detectAllDiscrepancies(options = {}) {
  const { types = null } = options;
  
  console.log('\n[Discrepancy Detector] Starting full scan...\n');
  
  const allDiscrepancies = [];
  
  // Run each detection
  if (!types || types.includes('NEEDS_INITIAL_ADV')) {
    const results = await detectNeedsInitialADV();
    allDiscrepancies.push(...results);
  }
  
  if (!types || types.includes('OVERDUE_ANNUAL_ADV')) {
    const results = await detectOverdueAnnualADV();
    allDiscrepancies.push(...results);
  }
  
  if (!types || types.includes('VC_EXEMPTION_VIOLATION')) {
    const results = await detectVCExemptionViolations();
    allDiscrepancies.push(...results);
  }
  
  if (!types || types.includes('FUND_TYPE_MISMATCH')) {
    const results = await detectFundTypeMismatches();
    allDiscrepancies.push(...results);
  }
  
  if (!types || types.includes('MISSING_FUND_IN_ADV')) {
    const results = await detectMissingFundsInADV();
    allDiscrepancies.push(...results);
  }
  
  if (!types || types.includes('EXEMPTION_MISMATCH')) {
    const results = await detectExemptionMismatches();
    allDiscrepancies.push(...results);
  }
  
  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  allDiscrepancies.sort((a, b) => 
    (severityOrder[a.severity] || 4) - (severityOrder[b.severity] || 4)
  );
  
  // Summary
  const summary = {
    total: allDiscrepancies.length,
    by_type: {},
    by_severity: {}
  };
  
  for (const d of allDiscrepancies) {
    summary.by_type[d.type] = (summary.by_type[d.type] || 0) + 1;
    summary.by_severity[d.severity] = (summary.by_severity[d.severity] || 0) + 1;
  }
  
  console.log('\n[Discrepancy Detector] Summary:');
  console.log(`  Total: ${summary.total}`);
  console.log('  By Type:', summary.by_type);
  console.log('  By Severity:', summary.by_severity);
  
  return {
    discrepancies: allDiscrepancies,
    summary
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  detectAllDiscrepancies,
  detectNeedsInitialADV,
  detectOverdueAnnualADV,
  detectVCExemptionViolations,
  detectFundTypeMismatches,
  detectMissingFundsInADV,
  detectExemptionMismatches,
  DISCREPANCY_TYPES
};

// ============================================================================
// CLI EXECUTION
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const type = args[0] || null;
  
  console.log('Running discrepancy detection...');
  
  const options = type ? { types: [type.toUpperCase()] } : {};
  
  detectAllDiscrepancies(options)
    .then(results => {
      console.log('\n\nResults:', JSON.stringify(results.summary, null, 2));
      console.log('\nSample discrepancies:');
      results.discrepancies.slice(0, 5).forEach(d => {
        console.log(`\n  ${d.type} (${d.severity}): ${d.entity_name}`);
        console.log(`    ${d.details.description}`);
      });
      process.exit(0);
    })
    .catch(error => {
      console.error('Detection failed:', error);
      process.exit(1);
    });
}
