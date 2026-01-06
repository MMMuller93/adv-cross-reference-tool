#!/usr/bin/env node
/**
 * Compliance Discrepancy Detection Engine
 *
 * Analyzes Form D and Form ADV filings to detect regulatory compliance issues:
 * 1. Needs Initial ADV Filing - New manager filed Form D but no ADV within 60 days
 * 2. Overdue Annual ADV Amendment - No 2025 ADV update by April 1
 * 3. VC Exemption Violation - Claims VC but manages non-VC funds
 * 4. Fund Type Mismatch - Fund type differs between Form D and ADV
 * 5. Missing Fund in ADV - Form D filed but fund not in latest ADV
 * 6. Exemption Mismatch - 3(c)(1) or 3(c)(7) status differs between filings
 *
 * Created: 2026-01-05
 */

const { createClient } = require('@supabase/supabase-js');

// Database configuration - use environment variables for GitHub Actions, fallback to defaults for local dev
const SUPABASE_URL = process.env.ADV_URL || 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const SUPABASE_KEY = process.env.ADV_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

const FORM_D_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORM_D_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

console.log(`[Config] ADV DB: ${SUPABASE_URL.substring(0, 30)}...`);
console.log(`[Config] Form D DB: ${FORM_D_URL.substring(0, 30)}...`);
console.log(`[Config] Using ${process.env.ADV_SERVICE_KEY ? 'environment' : 'default'} credentials`);

const advDb = createClient(SUPABASE_URL, SUPABASE_KEY);
const formDDb = createClient(FORM_D_URL, FORM_D_KEY);

// Detection configuration
const DETECTION_CONFIG = {
    initialFilingGracePeriodDays: 60,  // Days after Form D to file initial ADV
    annualAmendmentDeadline: '2026-04-01',  // Current year deadline
    batchSize: 1000,  // Supabase default limit is 1000 rows per request
    maxRecords: 100000,  // Process up to 100k records total
    enabledDetectors: [
        'needs_initial_adv_filing',  // New managers filed Form D but no ADV within 60 days
        'overdue_annual_amendment',  // Uses overdue_adv_flag from cross_reference_matches
        'vc_exemption_violation',
        'fund_type_mismatch',
        'missing_fund_in_adv',  // Form D exists but fund not in ADV
        'exemption_mismatch'
    ]
};

/**
 * Detector 1: Needs Initial ADV Filing
 * New managers filed Form D but haven't filed ADV within 60 days
 *
 * LOGIC:
 * 1. Get recent Form D filings
 * 2. Get all matched accessions from cross_reference_matches (these have ADV matches)
 * 3. Find Form D filings NOT in matches = no ADV filing exists
 * 4. Filter to those filed more than 60 days ago
 *
 * NOTE: cross_reference_matches only contains MATCHED records.
 * Unmatched Form D filings are not stored there.
 */
async function detectNeedsInitialADVFiling() {
    console.log('\n[1/6] Detecting: Needs Initial ADV Filing...');

    // Step 1: Get recent Form D filings (last 6 months of filings)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const sixMonthsAgoStr = sixMonthsAgo.toISOString().split('T')[0];

    const { data: formDFilings, error: formDError } = await formDDb
        .from('form_d_filings')
        .select('accessionnumber, cik, entityname, filing_date, totalofferingamount')
        .not('cik', 'is', null)
        .gte('filing_date', sixMonthsAgoStr)
        .order('filing_date', { ascending: false })
        .limit(5000);

    if (formDError) throw formDError;

    console.log(`  Found ${formDFilings.length} Form D filings in last 6 months`);

    // Step 2: Get all matched accessions from cross_reference_matches
    // These Form Ds have been matched to an ADV fund
    let allMatchedAccessions = [];
    let offset = 0;
    const batchSize = 1000;

    while (offset < 200000) {  // Safety limit
        const { data: matches, error } = await formDDb
            .from('cross_reference_matches')
            .select('formd_accession')
            .range(offset, offset + batchSize - 1);

        if (error) throw error;
        if (!matches || matches.length === 0) break;

        allMatchedAccessions.push(...matches.map(m => m.formd_accession));
        offset += batchSize;

        if (matches.length < batchSize) break;
    }

    const matchedAccessionSet = new Set(allMatchedAccessions);
    console.log(`  Found ${matchedAccessionSet.size} Form D filings matched to ADV funds`);

    // Step 3: Find Form D filings NOT in cross_reference_matches
    // AND filed more than 60 days ago
    const issues = [];
    const now = Date.now();

    for (const filing of formDFilings) {
        // Skip if this Form D has a match in cross_reference_matches
        if (matchedAccessionSet.has(filing.accessionnumber)) continue;

        const filingDate = new Date(filing.filing_date);
        const daysSinceFiling = Math.floor((now - filingDate.getTime()) / (1000 * 60 * 60 * 24));

        // Only flag if more than 60 days have passed (grace period for initial ADV filing)
        if (daysSinceFiling > DETECTION_CONFIG.initialFilingGracePeriodDays) {
            issues.push({
                form_d_cik: filing.cik,
                adviser_crd: null,
                discrepancy_type: 'needs_initial_adv_filing',
                severity: 'high',
                description: `Manager "${filing.entityname}" filed Form D on ${filing.filing_date} but has not filed Form ADV within 60 days (${daysSinceFiling} days elapsed)`,
                metadata: {
                    form_d_filing_date: filing.filing_date,
                    days_since_filing: daysSinceFiling,
                    entity_name: filing.entityname,
                    cik: filing.cik,
                    accession_number: filing.accessionnumber,
                    offering_amount: filing.totalofferingamount
                }
            });
        }
    }

    console.log(`  Found ${issues.length} issues (Form D filed >60 days ago with no ADV match)`);
    return issues;
}

/**
 * Detector 2: Overdue Annual ADV Amendment
 * Uses pre-computed overdue_adv_flag from cross_reference_matches
 * Flags advisers whose latest ADV filing is not current year
 * Enhanced: Includes Form D filings filed after the last ADV
 */
async function detectOverdueAnnualAmendment() {
    console.log('\n[2/6] Detecting: Overdue Annual ADV Amendment...');

    const issues = [];
    let offset = 0;
    const seenAdvisers = new Set(); // Deduplicate by adviser
    const adviserFormDs = new Map(); // Collect Form D filings per adviser

    while (offset < DETECTION_CONFIG.maxRecords) {
        const { data: matches, error } = await formDDb
            .from('cross_reference_matches')
            .select('adviser_entity_crd, adviser_entity_legal_name, latest_adv_year, overdue_adv_flag, adv_fund_name, formd_accession, formd_entity_name')
            .eq('overdue_adv_flag', true)
            .range(offset, offset + DETECTION_CONFIG.batchSize - 1);

        if (error) throw error;
        if (!matches || matches.length === 0) break;

        for (const match of matches) {
            if (!match.adviser_entity_crd) continue;

            // Collect Form D filings for each adviser
            if (!adviserFormDs.has(match.adviser_entity_crd)) {
                adviserFormDs.set(match.adviser_entity_crd, {
                    adviser_name: match.adviser_entity_legal_name,
                    latest_adv_year: match.latest_adv_year,
                    form_d_filings: []
                });
            }

            if (match.formd_accession) {
                adviserFormDs.get(match.adviser_entity_crd).form_d_filings.push({
                    accession: match.formd_accession,
                    entity_name: match.formd_entity_name
                });
            }
        }

        offset += DETECTION_CONFIG.batchSize;
        if (matches.length < DETECTION_CONFIG.batchSize) break;

        if (offset % 10000 === 0) {
            console.log(`    Processed ${offset} records...`);
        }
    }

    // Now fetch Form D filing dates for all relevant accessions
    const allAccessions = [];
    for (const [crd, data] of adviserFormDs) {
        allAccessions.push(...data.form_d_filings.map(f => f.accession));
    }

    // Batch fetch Form D filing dates
    const filingDates = new Map();
    for (let i = 0; i < allAccessions.length; i += 100) {
        const batch = allAccessions.slice(i, i + 100);
        const { data: filings } = await formDDb
            .from('form_d_filings')
            .select('accessionnumber, filing_date, entityname, cik')
            .in('accessionnumber', batch);

        for (const f of (filings || [])) {
            filingDates.set(f.accessionnumber, {
                filing_date: f.filing_date,
                cik: f.cik
            });
        }
    }

    // Build issues with Form D details
    for (const [crd, data] of adviserFormDs) {
        // Find Form D filings after the last ADV year
        const formDsAfterAdv = data.form_d_filings
            .filter(f => {
                const filingInfo = filingDates.get(f.accession);
                if (!filingInfo) return false;
                const filingYear = new Date(filingInfo.filing_date).getFullYear();
                return filingYear > (data.latest_adv_year || 0);
            })
            .map(f => ({
                ...f,
                filing_date: filingDates.get(f.accession)?.filing_date,
                cik: filingDates.get(f.accession)?.cik
            }));

        issues.push({
            adviser_crd: crd,
            discrepancy_type: 'overdue_annual_amendment',
            severity: 'high',
            description: `Manager "${data.adviser_name}" has not filed current year ADV amendment (last filing: ${data.latest_adv_year || 'unknown'})${formDsAfterAdv.length > 0 ? `. ${formDsAfterAdv.length} Form D filings since then.` : ''}`,
            metadata: {
                adviser_name: data.adviser_name,
                latest_adv_year: data.latest_adv_year,
                form_d_count_after_adv: formDsAfterAdv.length,
                form_d_filings_after_adv: formDsAfterAdv.slice(0, 5).map(f => ({
                    accession: f.accession,
                    entity_name: f.entity_name,
                    filing_date: f.filing_date,
                    cik: f.cik
                }))
            }
        });
    }

    console.log(`  Found ${issues.length} issues (unique advisers with overdue ADV)`);
    return issues;
}

/**
 * Detector 3: VC Exemption Violation
 * Manager claims venture capital exemption (Rule 203(l)-1) but manages non-VC funds
 *
 * IMPORTANT: exemption_2b1 = VC exemption (Rule 203(l)-1)
 *            exemption_2b2 = Private fund adviser exemption (Rule 203(m)-1, under $150M)
 *
 * Enhanced: Shows which funds blow the exemption (from ADV), includes Form D if matched
 */
async function detectVCExemptionViolation() {
    console.log('\n[3/6] Detecting: VC Exemption Violation...');

    // Get advisers who claim VC exemption (exemption_2b1 = 'Y' or true)
    // Note: Data has mixed formats - 'Y'/'N' strings and true/false booleans
    // Need to query for both to catch all VC exemption claimants
    const { data: advisersStringY, error: err1 } = await advDb
        .from('advisers_enriched')
        .select('crd, adviser_name, exemption_2b1')
        .eq('exemption_2b1', 'Y');

    const { data: advisersBoolTrue, error: err2 } = await advDb
        .from('advisers_enriched')
        .select('crd, adviser_name, exemption_2b1')
        .eq('exemption_2b1', true);

    if (err1) throw err1;
    if (err2) throw err2;

    // Combine and dedupe by CRD
    const seenCRDs = new Set();
    const advisers = [];
    for (const a of [...(advisersStringY || []), ...(advisersBoolTrue || [])]) {
        if (!seenCRDs.has(a.crd)) {
            seenCRDs.add(a.crd);
            advisers.push(a);
        }
    }

    console.log(`  Found ${advisers.length} advisers claiming VC exemption (2b1=Y or true)`);

    const issues = [];

    for (const adviser of advisers) {
        // Check funds managed by this adviser from ADV
        const { data: funds, error: fundsError } = await advDb
            .from('funds_enriched')
            .select('fund_name, fund_type, reference_id, form_d_file_number')
            .eq('adviser_entity_crd', adviser.crd);

        if (fundsError) continue;

        // Find non-VC funds in the ADV filing
        const nonVCFunds = funds.filter(fund => {
            const type = (fund.fund_type || '').toLowerCase();
            // Fund type must be specified AND not be VC-related
            return type !== '' && !type.includes('venture') && !type.includes('vc');
        });

        if (nonVCFunds.length > 0) {
            // Get Form D info for the non-VC funds if they have form_d_file_number
            const formDFileNumbers = nonVCFunds
                .map(f => f.form_d_file_number)
                .filter(Boolean);

            let formDMatches = [];
            if (formDFileNumbers.length > 0) {
                // Try to get Form D filing info
                const { data: formDFilings } = await formDDb
                    .from('form_d_filings')
                    .select('file_num, entityname, investmentfundtype, cik, filing_date')
                    .in('file_num', formDFileNumbers)
                    .limit(10);

                formDMatches = formDFilings || [];
            }

            // Pick the first non-VC fund as the "primary" fund for this issue
            const primaryFund = nonVCFunds[0];
            const primaryFormD = formDMatches.find(f => f.file_num === primaryFund.form_d_file_number);

            issues.push({
                adviser_crd: adviser.crd,
                fund_reference_id: primaryFund.reference_id,  // For linking to fund detail
                form_d_cik: primaryFormD?.cik || null,  // For EDGAR link if Form D exists
                discrepancy_type: 'vc_exemption_violation',
                severity: 'high',
                description: `Manager "${adviser.adviser_name}" claims VC exemption (203(l)-1) but manages ${nonVCFunds.length} non-VC fund(s) per Form ADV`,
                metadata: {
                    exemption_claimed: 'vc_203l1',  // Clear label
                    exemption_2b1: 'Y',
                    non_vc_fund_count: nonVCFunds.length,
                    total_funds: funds.length,
                    // Primary fund details
                    primary_fund_name: primaryFund.fund_name,
                    primary_fund_type: primaryFund.fund_type,
                    primary_fund_reference_id: primaryFund.reference_id,
                    primary_fund_form_d_file_num: primaryFund.form_d_file_number,
                    // Form D info if available
                    primary_formd_cik: primaryFormD?.cik || null,
                    primary_formd_entity_name: primaryFormD?.entityname || null,
                    primary_formd_fund_type: primaryFormD?.investmentfundtype || null,
                    primary_formd_filing_date: primaryFormD?.filing_date || null,
                    // Source indicator
                    source: 'form_adv',  // Non-VC fund identified from Form ADV
                    // Sample of all non-VC funds
                    sample_non_vc_funds: nonVCFunds.slice(0, 5).map(f => {
                        const matchingFormD = formDMatches.find(fd => fd.file_num === f.form_d_file_number);
                        return {
                            name: f.fund_name,
                            type: f.fund_type,
                            reference_id: f.reference_id,
                            form_d_file_num: f.form_d_file_number,
                            formd_cik: matchingFormD?.cik || null,
                            formd_type: matchingFormD?.investmentfundtype || null
                        };
                    })
                }
            });
        }
    }

    console.log(`  Found ${issues.length} VC exemption violations`);
    return issues;
}

/**
 * Detector 4: Fund Type Mismatch
 * Fund type in Form D differs from Form ADV
 * Enhanced: Includes reference_id for fund linking, filing dates
 */
async function detectFundTypeMismatch() {
    console.log('\n[4/6] Detecting: Fund Type Mismatch...');

    const issues = [];
    let pageOffset = 0;
    let totalProcessed = 0;

    while (pageOffset < DETECTION_CONFIG.maxRecords) {
        // Get a page of cross-reference matches
        const { data: matches, error } = await formDDb
            .from('cross_reference_matches')
            .select('adv_fund_id, adv_fund_name, formd_accession, formd_entity_name, adviser_entity_crd, adviser_entity_legal_name')
            .not('adv_fund_id', 'is', null)
            .not('formd_accession', 'is', null)
            .range(pageOffset, pageOffset + DETECTION_CONFIG.batchSize - 1);

        if (error) throw error;
        if (!matches || matches.length === 0) break;

        // Process in smaller batches for API calls
        const apiBatchSize = 100;
        for (let i = 0; i < matches.length; i += apiBatchSize) {
            const batch = matches.slice(i, i + apiBatchSize);

            // Get ADV fund types and reference_ids for this batch
            const advFundIds = batch.map(m => m.adv_fund_id).filter(Boolean);
            const { data: advFunds } = await advDb
                .from('funds_enriched')
                .select('fund_id, fund_type, reference_id')
                .in('fund_id', advFundIds);

            const advFundMap = new Map((advFunds || []).map(f => [f.fund_id, { type: f.fund_type, reference_id: f.reference_id }]));

            // Get Form D fund types and CIK for this batch
            const accessions = batch.map(m => m.formd_accession).filter(Boolean);
            const { data: formDFilings } = await formDDb
                .from('form_d_filings')
                .select('accessionnumber, investmentfundtype, cik, filing_date')
                .in('accessionnumber', accessions);

            const formDMap = new Map((formDFilings || []).map(f => [f.accessionnumber, {
                type: f.investmentfundtype,
                cik: f.cik,
                filing_date: f.filing_date
            }]));

            // Compare types
            for (const match of batch) {
                const advInfo = advFundMap.get(match.adv_fund_id) || {};
                const formDInfo = formDMap.get(match.formd_accession) || {};

                // Skip if either type is empty
                if (!advInfo.type || !formDInfo.type) continue;

                const advTypeLower = advInfo.type.toLowerCase().trim();
                const formDTypeLower = formDInfo.type.toLowerCase().trim();

                // Check if types are significantly different
                if (!areTypesEquivalent(advTypeLower, formDTypeLower)) {
                    issues.push({
                        adviser_crd: match.adviser_entity_crd,
                        fund_reference_id: advInfo.reference_id,  // For linking to fund detail
                        form_d_cik: formDInfo.cik,  // For EDGAR link
                        discrepancy_type: 'fund_type_mismatch',
                        severity: 'medium',
                        description: `Fund type mismatch for "${match.adv_fund_name}": ADV reports "${advInfo.type}", Form D reports "${formDInfo.type}"`,
                        metadata: {
                            adv_fund_name: match.adv_fund_name,
                            adv_fund_reference_id: advInfo.reference_id,
                            formd_entity_name: match.formd_entity_name,
                            adv_fund_type: advInfo.type,
                            formd_fund_type: formDInfo.type,
                            formd_accession: match.formd_accession,
                            formd_filing_date: formDInfo.filing_date,
                            formd_cik: formDInfo.cik,
                            adviser_name: match.adviser_entity_legal_name
                        }
                    });
                }
            }
        }

        totalProcessed += matches.length;
        pageOffset += DETECTION_CONFIG.batchSize;

        if (totalProcessed % 10000 === 0) {
            console.log(`    Processed ${totalProcessed} matches, found ${issues.length} mismatches so far...`);
        }

        if (matches.length < DETECTION_CONFIG.batchSize) break;
    }

    console.log(`  Processed ${totalProcessed} total matches`);
    console.log(`  Found ${issues.length} fund type mismatches`);
    return issues;
}

/**
 * Detector 5: Missing Fund in ADV
 * Form D filing exists but fund not found in latest ADV
 *
 * LOGIC:
 * cross_reference_matches only contains MATCHED records (where ADV fund matched Form D).
 * To find "missing" funds, we need to:
 * 1. Get advisers who have at least one match in cross_reference_matches
 * 2. Get ALL Form D filings (from form_d_filings table)
 * 3. Find Form Ds that share adviser name patterns but aren't in cross_reference_matches
 *
 * Per user: "This mostly applies to Form Ds filed in a previous year, not reflected in ADV filed after"
 *
 * SIMPLIFIED APPROACH:
 * Since we can't easily link Form Ds to advisers without matches, we look for:
 * - Form D filings where related_names/roles suggest they're managed by a known adviser
 * - But the fund itself isn't in cross_reference_matches
 *
 * For now: Use a name-based heuristic - find Form Ds with similar names to matched funds
 * from the same adviser but not in the matches themselves.
 */
async function detectMissingFundInADV() {
    console.log('\n[5/6] Detecting: Missing Fund in ADV...');

    // Step 1: Get all unique advisers from cross_reference_matches with their matched Form Ds
    const adviserMatches = new Map();  // adviser_crd -> { name, matchedAccessions, latestAdvYear }

    let offset = 0;
    while (offset < DETECTION_CONFIG.maxRecords) {
        const { data: matches, error } = await formDDb
            .from('cross_reference_matches')
            .select('adviser_entity_crd, adviser_entity_legal_name, formd_accession, latest_adv_year')
            .not('adviser_entity_crd', 'is', null)
            .range(offset, offset + DETECTION_CONFIG.batchSize - 1);

        if (error) throw error;
        if (!matches || matches.length === 0) break;

        for (const m of matches) {
            if (!adviserMatches.has(m.adviser_entity_crd)) {
                adviserMatches.set(m.adviser_entity_crd, {
                    name: m.adviser_entity_legal_name,
                    matchedAccessions: new Set(),
                    latestAdvYear: m.latest_adv_year
                });
            }
            adviserMatches.get(m.adviser_entity_crd).matchedAccessions.add(m.formd_accession);
        }

        offset += DETECTION_CONFIG.batchSize;
        if (matches.length < DETECTION_CONFIG.batchSize) break;
    }

    console.log(`  Found ${adviserMatches.size} advisers with Form D matches`);

    // Step 2: For each adviser, get their ADV funds and check for unmatched Form Ds
    // We look for Form D filings that share the adviser's name pattern
    const issues = [];
    const currentYear = new Date().getFullYear();
    const advDeadlinePassed = (new Date().getMonth() >= 3); // After April

    // Get all Form D filings to check
    const { data: allFormDFilings, error: formDError } = await formDDb
        .from('form_d_filings')
        .select('accessionnumber, cik, entityname, filing_date, totalofferingamount, related_names')
        .order('filing_date', { ascending: false })
        .limit(10000);

    if (formDError) throw formDError;

    // Build a set of all matched accessions for quick lookup
    const allMatchedAccessions = new Set();
    for (const [_, advData] of adviserMatches) {
        for (const acc of advData.matchedAccessions) {
            allMatchedAccessions.add(acc);
        }
    }

    console.log(`  Total matched accessions: ${allMatchedAccessions.size}`);

    // Step 3: For each adviser, find Form Ds that mention their name but aren't matched
    for (const [crd, advData] of adviserMatches) {
        const adviserName = (advData.name || '').toUpperCase();
        if (!adviserName || adviserName.length < 3) continue;

        // Extract key words from adviser name (skip common words)
        const skipWords = new Set(['LLC', 'LP', 'INC', 'CAPITAL', 'PARTNERS', 'MANAGEMENT', 'FUND', 'ADVISORS', 'ADVISERS', 'INVESTMENTS', 'GROUP', 'HOLDINGS', 'THE', 'AND', 'OF']);
        const adviserKeyWords = adviserName.split(/\s+/)
            .filter(w => w.length > 2 && !skipWords.has(w))
            .slice(0, 3);  // Use first 3 distinctive words

        if (adviserKeyWords.length === 0) continue;

        // Find Form Ds that mention adviser name in related_names or entity name
        for (const filing of allFormDFilings) {
            // Skip if already matched
            if (allMatchedAccessions.has(filing.accessionnumber)) continue;

            // Check if this Form D is related to this adviser
            const relatedNames = (filing.related_names || '').toUpperCase();
            const entityName = (filing.entityname || '').toUpperCase();
            const combinedText = relatedNames + ' ' + entityName;

            // Check if adviser's key words appear in the Form D
            const matchCount = adviserKeyWords.filter(w => combinedText.includes(w)).length;
            if (matchCount < 2) continue;  // Need at least 2 matching key words

            // Check timing - Form D should have been filed before latest ADV
            const filingDate = new Date(filing.filing_date);
            const filingYear = filingDate.getFullYear();
            const latestAdvYear = advData.latestAdvYear || currentYear;

            const shouldHaveBeenInADV = (filingYear < latestAdvYear) ||
                (filingYear < currentYear && advDeadlinePassed);

            if (shouldHaveBeenInADV) {
                issues.push({
                    adviser_crd: crd,
                    form_d_cik: filing.cik,
                    discrepancy_type: 'missing_fund_in_adv',
                    severity: 'medium',
                    description: `Fund "${filing.entityname}" filed Form D on ${filing.filing_date} but not in latest Form ADV (${latestAdvYear}) for "${advData.name}"`,
                    metadata: {
                        fund_name: filing.entityname,
                        formd_accession: filing.accessionnumber,
                        formd_filing_date: filing.filing_date,
                        formd_cik: filing.cik,
                        offering_amount: filing.totalofferingamount,
                        latest_adv_year: latestAdvYear,
                        adviser_name: advData.name,
                        matched_keywords: adviserKeyWords.filter(w => combinedText.includes(w))
                    }
                });
            }
        }
    }

    // Deduplicate by accession number (same Form D might match multiple advisers)
    const seenAccessions = new Set();
    const dedupedIssues = issues.filter(issue => {
        const acc = issue.metadata.formd_accession;
        if (seenAccessions.has(acc)) return false;
        seenAccessions.add(acc);
        return true;
    });

    console.log(`  Found ${dedupedIssues.length} issues (Form Ds potentially missing from ADV)`);
    return dedupedIssues;
}

/**
 * Detector 6: Exemption Mismatch
 * 3(c)(1) or 3(c)(7) status differs between Form D and ADV
 * Paginates through ALL cross_reference_matches to find exemption mismatches
 */
async function detectExemptionMismatch() {
    console.log('\n[6/6] Detecting: Exemption Mismatch (3c1 vs 3c7)...');

    const issues = [];
    let pageOffset = 0;
    let totalProcessed = 0;

    while (pageOffset < DETECTION_CONFIG.maxRecords) {
        // Get a page of cross-reference matches
        const { data: matches, error } = await formDDb
            .from('cross_reference_matches')
            .select('adv_fund_id, adv_fund_name, formd_accession, formd_entity_name, adviser_entity_crd, adviser_entity_legal_name')
            .not('adv_fund_id', 'is', null)
            .not('formd_accession', 'is', null)
            .range(pageOffset, pageOffset + DETECTION_CONFIG.batchSize - 1);

        if (error) throw error;
        if (!matches || matches.length === 0) break;

        // Process in smaller batches for API calls
        const apiBatchSize = 100;
        for (let i = 0; i < matches.length; i += apiBatchSize) {
            const batch = matches.slice(i, i + apiBatchSize);

            // Get ADV fund exemptions for this batch
            const advFundIds = batch.map(m => m.adv_fund_id).filter(Boolean);
            const { data: advFunds } = await advDb
                .from('funds_enriched')
                .select('fund_id, exclusion_3c1, exclusion_3c7')
                .in('fund_id', advFundIds);

            const advFundMap = new Map((advFunds || []).map(f => [f.fund_id, {
                c1: f.exclusion_3c1 === 'Y' || f.exclusion_3c1 === true,
                c7: f.exclusion_3c7 === 'Y' || f.exclusion_3c7 === true
            }]));

            // Get Form D exemptions for this batch
            const accessions = batch.map(m => m.formd_accession).filter(Boolean);
            const { data: formDFilings } = await formDDb
                .from('form_d_filings')
                .select('accessionnumber, federalexemptions_items_list')
                .in('accessionnumber', accessions);

            // Parse Form D exemptions
            const formDMap = new Map();
            for (const f of (formDFilings || [])) {
                const exemptions = (f.federalexemptions_items_list || '').toLowerCase();
                // Form D uses variations: "3C", "3C.1", "3C.7", "3(c)(1)", "3(c)(7)"
                const has3c1 = exemptions.includes('3c.1') || exemptions.includes('3(c)(1)') ||
                              (exemptions.includes('3c') && !exemptions.includes('3c.7') && !exemptions.includes('3(c)(7)'));
                const has3c7 = exemptions.includes('3c.7') || exemptions.includes('3(c)(7)');
                formDMap.set(f.accessionnumber, { c1: has3c1, c7: has3c7 });
            }

            // Compare exemptions
            for (const match of batch) {
                const advExempt = advFundMap.get(match.adv_fund_id);
                const formDExempt = formDMap.get(match.formd_accession);

                // Skip if we don't have both
                if (!advExempt || !formDExempt) continue;

                // Detect mismatch - significant difference in 3(c)(1) vs 3(c)(7) status
                const mismatch = (advExempt.c1 !== formDExempt.c1) || (advExempt.c7 !== formDExempt.c7);

                if (mismatch) {
                    issues.push({
                        adviser_crd: match.adviser_entity_crd,
                        discrepancy_type: 'exemption_mismatch',
                        severity: 'high',
                        description: `Exemption mismatch for "${match.adv_fund_name}": ADV reports 3(c)(1)=${advExempt.c1 ? 'Y' : 'N'}, 3(c)(7)=${advExempt.c7 ? 'Y' : 'N'}; Form D reports 3(c)(1)=${formDExempt.c1 ? 'Y' : 'N'}, 3(c)(7)=${formDExempt.c7 ? 'Y' : 'N'}`,
                        metadata: {
                            adv_fund_name: match.adv_fund_name,
                            formd_entity_name: match.formd_entity_name,
                            adv_3c1: advExempt.c1,
                            adv_3c7: advExempt.c7,
                            formd_3c1: formDExempt.c1,
                            formd_3c7: formDExempt.c7,
                            formd_accession: match.formd_accession,
                            adviser_name: match.adviser_entity_legal_name
                        }
                    });
                }
            }
        }

        totalProcessed += matches.length;
        pageOffset += DETECTION_CONFIG.batchSize;

        if (totalProcessed % 10000 === 0) {
            console.log(`    Processed ${totalProcessed} matches, found ${issues.length} exemption mismatches so far...`);
        }

        if (matches.length < DETECTION_CONFIG.batchSize) break;
    }

    console.log(`  Processed ${totalProcessed} total matches`);
    console.log(`  Found ${issues.length} exemption mismatches`);
    return issues;
}

/**
 * Helper: Check if two fund types are equivalent
 */
function areTypesEquivalent(type1, type2) {
    const normalizations = {
        'pe': ['private equity', 'privateequity', 'pe fund'],
        'vc': ['venture capital', 'venturecapital', 'venture', 'vc fund'],
        'hedge': ['hedge fund', 'hedgefund'],
        're': ['real estate', 'realestate', 're fund']
    };

    for (const [canonical, variants] of Object.entries(normalizations)) {
        const isType1 = variants.some(v => type1.includes(v)) || type1 === canonical;
        const isType2 = variants.some(v => type2.includes(v)) || type2 === canonical;
        if (isType1 && isType2) return true;
    }

    return false;
}

/**
 * Clear existing issues from database
 */
async function clearExistingIssues() {
    console.log('\nClearing existing compliance issues...');

    const { error } = await formDDb
        .from('compliance_issues')
        .delete()
        .neq('id', 0);  // Delete all rows (Supabase requires a filter)

    if (error) {
        console.error('Error clearing issues:', error);
        throw error;
    }

    console.log('✓ Cleared existing issues');
}

/**
 * Save issues to database in batches
 */
async function saveIssues(issues) {
    if (issues.length === 0) {
        console.log('\n✓ No new issues to save');
        return;
    }

    console.log(`\nSaving ${issues.length} issues to database...`);

    const insertBatchSize = 500;  // Insert in smaller batches to avoid timeout
    let totalSaved = 0;

    for (let i = 0; i < issues.length; i += insertBatchSize) {
        const batch = issues.slice(i, i + insertBatchSize);

        const { data, error } = await formDDb
            .from('compliance_issues')
            .insert(batch)
            .select('id');

        if (error) {
            console.error(`Error saving batch ${i / insertBatchSize + 1}:`, error);
            throw error;
        }

        totalSaved += data.length;

        if (totalSaved % 5000 === 0 || i + insertBatchSize >= issues.length) {
            console.log(`  Saved ${totalSaved}/${issues.length} issues...`);
        }
    }

    console.log(`✓ Saved ${totalSaved} compliance issues`);
}

/**
 * Main execution
 */
async function main() {
    console.log('========================================');
    console.log('Compliance Discrepancy Detection Engine');
    console.log('========================================');
    console.log(`Started: ${new Date().toISOString()}\n`);

    try {
        // Clear existing issues before running detection
        await clearExistingIssues();

        const allIssues = [];

        // Run all enabled detectors
        if (DETECTION_CONFIG.enabledDetectors.includes('needs_initial_adv_filing')) {
            allIssues.push(...await detectNeedsInitialADVFiling());
        }
        if (DETECTION_CONFIG.enabledDetectors.includes('overdue_annual_amendment')) {
            allIssues.push(...await detectOverdueAnnualAmendment());
        }
        if (DETECTION_CONFIG.enabledDetectors.includes('vc_exemption_violation')) {
            allIssues.push(...await detectVCExemptionViolation());
        }
        if (DETECTION_CONFIG.enabledDetectors.includes('fund_type_mismatch')) {
            allIssues.push(...await detectFundTypeMismatch());
        }
        if (DETECTION_CONFIG.enabledDetectors.includes('missing_fund_in_adv')) {
            allIssues.push(...await detectMissingFundInADV());
        }
        if (DETECTION_CONFIG.enabledDetectors.includes('exemption_mismatch')) {
            allIssues.push(...await detectExemptionMismatch());
        }

        // Save to database
        await saveIssues(allIssues);

        console.log('\n========================================');
        console.log('Detection Complete');
        console.log('========================================');
        console.log(`Total issues found: ${allIssues.length}`);
        console.log(`Completed: ${new Date().toISOString()}`);

        // Summary by type
        const byType = {};
        allIssues.forEach(issue => {
            byType[issue.discrepancy_type] = (byType[issue.discrepancy_type] || 0) + 1;
        });

        console.log('\nBreakdown by type:');
        Object.entries(byType).forEach(([type, count]) => {
            console.log(`  ${type}: ${count}`);
        });

    } catch (error) {
        console.error('\n✗ Error during detection:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    detectNeedsInitialADVFiling,
    detectOverdueAnnualAmendment,
    detectVCExemptionViolation,
    detectFundTypeMismatch,
    detectMissingFundInADV,
    detectExemptionMismatch
};
