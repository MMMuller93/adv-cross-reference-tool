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
    annualAmendmentDeadline: '2025-04-01',  // Current year deadline
    batchSize: 1000,  // Supabase default limit is 1000 rows per request
    maxRecords: 100000,  // Process up to 100k records total
    enabledDetectors: [
        'overdue_annual_amendment',  // Uses overdue_adv_flag from cross_reference_matches
        'vc_exemption_violation',
        'fund_type_mismatch',
        'exemption_mismatch'
        // 'needs_initial_adv_filing'  // Disabled - requires comparing Form D to ADV at entity level
    ]
};

/**
 * Detector 1: Needs Initial ADV Filing
 * New managers filed Form D but haven't filed ADV within 60 days
 */
async function detectNeedsInitialADVFiling() {
    console.log('\n[1/6] Detecting: Needs Initial ADV Filing...');

    const { data: formDFilings, error: formDError } = await formDDb
        .from('form_d_filings')
        .select('cik, entityname, filing_date')
        .not('cik', 'is', null)
        .order('filing_date', { ascending: false })
        .limit(DETECTION_CONFIG.batchSize);

    if (formDError) throw formDError;

    const issues = [];

    for (const filing of formDFilings) {
        // Check if CIK has corresponding ADV filing
        const { data: adviser, error } = await advDb
            .from('advisers_enriched')
            .select('crd, adviser_name')
            .eq('sec_file_number', filing.cik)
            .single();

        if (error && error.code !== 'PGRST116') continue; // PGRST116 = no rows

        if (!adviser) {
            // No ADV filing found - check if 60 days have passed
            const filingDate = new Date(filing.filing_date);
            const daysSinceFiling = Math.floor((Date.now() - filingDate.getTime()) / (1000 * 60 * 60 * 24));

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
                        cik: filing.cik
                    }
                });
            }
        }
    }

    console.log(`  Found ${issues.length} issues`);
    return issues;
}

/**
 * Detector 2: Overdue Annual ADV Amendment
 * Uses pre-computed overdue_adv_flag from cross_reference_matches
 * Flags advisers whose latest ADV filing is not current year
 */
async function detectOverdueAnnualAmendment() {
    console.log('\n[2/6] Detecting: Overdue Annual ADV Amendment...');

    const issues = [];
    let offset = 0;
    const seenAdvisers = new Set(); // Deduplicate by adviser

    while (offset < DETECTION_CONFIG.maxRecords) {
        const { data: matches, error } = await formDDb
            .from('cross_reference_matches')
            .select('adviser_entity_crd, adviser_entity_legal_name, latest_adv_year, overdue_adv_flag, adv_fund_name')
            .eq('overdue_adv_flag', true)
            .range(offset, offset + DETECTION_CONFIG.batchSize - 1);

        if (error) throw error;
        if (!matches || matches.length === 0) break;

        for (const match of matches) {
            // Deduplicate by adviser CRD
            if (!match.adviser_entity_crd || seenAdvisers.has(match.adviser_entity_crd)) continue;
            seenAdvisers.add(match.adviser_entity_crd);

            issues.push({
                adviser_crd: match.adviser_entity_crd,
                discrepancy_type: 'overdue_annual_amendment',
                severity: 'high',
                description: `Manager "${match.adviser_entity_legal_name}" has not filed current year ADV amendment (last filing: ${match.latest_adv_year || 'unknown'})`,
                metadata: {
                    adviser_name: match.adviser_entity_legal_name,
                    latest_adv_year: match.latest_adv_year,
                    sample_fund: match.adv_fund_name
                }
            });
        }

        offset += DETECTION_CONFIG.batchSize;
        if (matches.length < DETECTION_CONFIG.batchSize) break;

        if (offset % 10000 === 0) {
            console.log(`    Processed ${offset} records, found ${issues.length} overdue advisers...`);
        }
    }

    console.log(`  Found ${issues.length} issues (unique advisers with overdue ADV)`);
    return issues;
}

/**
 * Detector 3: VC Exemption Violation
 * Manager claims venture capital exemption but manages non-VC funds
 */
async function detectVCExemptionViolation() {
    console.log('\n[3/6] Detecting: VC Exemption Violation...');

    const { data: advisers, error } = await advDb
        .from('advisers_enriched')
        .select('crd, adviser_name, exemption_2b2')
        .eq('exemption_2b2', 'Y');

    if (error) throw error;

    const issues = [];

    for (const adviser of advisers) {
        // Check funds managed by this adviser
        const { data: funds, error: fundsError } = await advDb
            .from('funds_enriched')
            .select('fund_name, fund_type, reference_id')
            .eq('adviser_entity_crd', adviser.crd);

        if (fundsError) continue;

        const nonVCFunds = funds.filter(fund => {
            const type = (fund.fund_type || '').toLowerCase();
            return !type.includes('venture') && !type.includes('vc') && type !== '';
        });

        if (nonVCFunds.length > 0) {
            issues.push({
                adviser_crd: adviser.crd,
                discrepancy_type: 'vc_exemption_violation',
                severity: 'high',
                description: `Manager "${adviser.adviser_name}" claims venture capital exemption but manages ${nonVCFunds.length} non-VC funds`,
                metadata: {
                    exemption_2b2: 'Y',
                    non_vc_fund_count: nonVCFunds.length,
                    sample_non_vc_funds: nonVCFunds.slice(0, 5).map(f => ({
                        name: f.fund_name,
                        type: f.fund_type
                    }))
                }
            });
        }
    }

    console.log(`  Found ${issues.length} issues`);
    return issues;
}

/**
 * Detector 4: Fund Type Mismatch
 * Fund type in Form D differs from Form ADV
 * Paginates through ALL cross_reference_matches to find mismatches
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

            // Get ADV fund types for this batch
            const advFundIds = batch.map(m => m.adv_fund_id).filter(Boolean);
            const { data: advFunds } = await advDb
                .from('funds_enriched')
                .select('fund_id, fund_type')
                .in('fund_id', advFundIds);

            const advFundMap = new Map((advFunds || []).map(f => [f.fund_id, f.fund_type]));

            // Get Form D fund types for this batch
            const accessions = batch.map(m => m.formd_accession).filter(Boolean);
            const { data: formDFilings } = await formDDb
                .from('form_d_filings')
                .select('accessionnumber, investmentfundtype')
                .in('accessionnumber', accessions);

            const formDMap = new Map((formDFilings || []).map(f => [f.accessionnumber, f.investmentfundtype]));

            // Compare types
            for (const match of batch) {
                const advType = advFundMap.get(match.adv_fund_id) || '';
                const formDType = formDMap.get(match.formd_accession) || '';

                // Skip if either type is empty
                if (!advType || !formDType) continue;

                const advTypeLower = advType.toLowerCase().trim();
                const formDTypeLower = formDType.toLowerCase().trim();

                // Check if types are significantly different
                if (!areTypesEquivalent(advTypeLower, formDTypeLower)) {
                    issues.push({
                        adviser_crd: match.adviser_entity_crd,
                        discrepancy_type: 'fund_type_mismatch',
                        severity: 'medium',
                        description: `Fund type mismatch for "${match.adv_fund_name}": ADV reports "${advType}", Form D reports "${formDType}"`,
                        metadata: {
                            adv_fund_name: match.adv_fund_name,
                            formd_entity_name: match.formd_entity_name,
                            adv_fund_type: advType,
                            formd_fund_type: formDType,
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
 */
async function detectMissingFundInADV() {
    console.log('\n[5/6] Detecting: Missing Fund in ADV...');

    const { data: matches, error } = await formDDb
        .from('cross_reference_matches')
        .select('formd_entity_name, formd_accession, adviser_crd, match_score')
        .is('adv_fund_name', null)  // Form D exists but no ADV match
        .not('adviser_crd', 'is', null)
        .limit(DETECTION_CONFIG.batchSize);

    if (error) throw error;

    const issues = [];

    for (const match of matches) {
        issues.push({
            adviser_crd: match.adviser_crd,
            discrepancy_type: 'missing_fund_in_adv',
            severity: 'medium',
            description: `Fund "${match.formd_entity_name}" appears in Form D but not in latest Form ADV`,
            metadata: {
                fund_name: match.formd_entity_name,
                formd_accession: match.formd_accession,
                match_score: match.match_score
            }
        });
    }

    console.log(`  Found ${issues.length} issues`);
    return issues;
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
