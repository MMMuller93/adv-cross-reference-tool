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

// Database configuration
const SUPABASE_URL = 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

const FORM_D_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORM_D_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const advDb = createClient(SUPABASE_URL, SUPABASE_KEY);
const formDDb = createClient(FORM_D_URL, FORM_D_KEY);

// Detection configuration
const DETECTION_CONFIG = {
    initialFilingGracePeriodDays: 60,  // Days after Form D to file initial ADV
    annualAmendmentDeadline: '2025-04-01',  // Current year deadline
    batchSize: 1000,
    enabledDetectors: [
        // 'needs_initial_adv_filing',  // Disabled - no CIK in advisers_enriched
        // 'overdue_annual_amendment',  // Disabled - no latest_filing_date column
        'vc_exemption_violation'
        // 'fund_type_mismatch',  // Disabled - no fund_type columns in cross_reference_matches
        // 'missing_fund_in_adv',  // Disabled - no adviser_crd in cross_reference_matches
        // 'exemption_mismatch'  // Disabled - requires complex fuzzy matching
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
 * Managers haven't filed 2025 annual amendment by April 1
 */
async function detectOverdueAnnualAmendment() {
    console.log('\n[2/6] Detecting: Overdue Annual ADV Amendment...');

    const deadline = new Date(DETECTION_CONFIG.annualAmendmentDeadline);
    const today = new Date();

    if (today < deadline) {
        console.log(`  Skipping - deadline not reached (${DETECTION_CONFIG.annualAmendmentDeadline})`);
        return [];
    }

    // Note: Detector disabled - needs column mapping fix
    // No latest_filing_date column in advisers_enriched table
    // Would need to derive from filing_id or separate filing_dates table
    console.log('  Skipped - column mapping needs investigation');
    return [];
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
 */
async function detectFundTypeMismatch() {
    console.log('\n[4/6] Detecting: Fund Type Mismatch...');

    const { data: matches, error } = await formDDb
        .from('cross_reference_matches')
        .select('adv_fund_name, formd_entity_name, adv_fund_type, formd_fund_type, adviser_crd')
        .not('adv_fund_type', 'is', null)
        .not('formd_fund_type', 'is', null)
        .limit(DETECTION_CONFIG.batchSize);

    if (error) throw error;

    const issues = [];

    for (const match of matches) {
        const advType = (match.adv_fund_type || '').toLowerCase().trim();
        const formDType = (match.formd_fund_type || '').toLowerCase().trim();

        if (advType && formDType && advType !== formDType) {
            // Normalize types for comparison
            const isSignificantMismatch = !areTypesEquivalent(advType, formDType);

            if (isSignificantMismatch) {
                issues.push({
                    adviser_crd: match.adviser_crd,
                    discrepancy_type: 'fund_type_mismatch',
                    severity: 'medium',
                    description: `Fund type mismatch for "${match.adv_fund_name}": ADV reports "${match.adv_fund_type}", Form D reports "${match.formd_fund_type}"`,
                    metadata: {
                        fund_name: match.adv_fund_name,
                        adv_fund_type: match.adv_fund_type,
                        formd_fund_type: match.formd_fund_type
                    }
                });
            }
        }
    }

    console.log(`  Found ${issues.length} issues`);
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
 */
async function detectExemptionMismatch() {
    console.log('\n[6/6] Detecting: Exemption Mismatch...');

    const { data: funds, error } = await advDb
        .from('funds_enriched')
        .select('fund_name, reference_id, adviser_entity_crd, exclusion_3c1, exclusion_3c7')
        .not('adviser_entity_crd', 'is', null)
        .limit(DETECTION_CONFIG.batchSize);

    if (error) throw error;

    const issues = [];

    for (const fund of funds) {
        // Find corresponding Form D filing
        const { data: formDData, error: formDError } = await formDDb
            .from('form_d_filings')
            .select('entityname, federalexemptions_items_list')
            .ilike('entityname', `%${fund.fund_name.substring(0, 20)}%`)
            .limit(1)
            .single();

        if (formDError || !formDData) continue;

        const exemptions = formDData.federalexemptions_items_list || '';
        const formD3c1 = exemptions.includes('3(c)(1)') || exemptions.includes('3c1');
        const formD3c7 = exemptions.includes('3(c)(7)') || exemptions.includes('3c7');

        const adv3c1 = fund.exclusion_3c1 === true || fund.exclusion_3c1 === 'Y';
        const adv3c7 = fund.exclusion_3c7 === true || fund.exclusion_3c7 === 'Y';

        if ((formD3c1 !== adv3c1) || (formD3c7 !== adv3c7)) {
            issues.push({
                fund_reference_id: fund.reference_id,
                adviser_crd: fund.adviser_entity_crd,
                discrepancy_type: 'exemption_mismatch',
                severity: 'high',
                description: `Exemption status mismatch for "${fund.fund_name}": ADV reports 3(c)(1)=${adv3c1}, 3(c)(7)=${adv3c7}; Form D reports 3(c)(1)=${formD3c1}, 3(c)(7)=${formD3c7}`,
                metadata: {
                    fund_name: fund.fund_name,
                    adv_3c1: adv3c1,
                    adv_3c7: adv3c7,
                    formd_3c1: formD3c1,
                    formd_3c7: formD3c7
                }
            });
        }
    }

    console.log(`  Found ${issues.length} issues`);
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
 * Save issues to database
 */
async function saveIssues(issues) {
    if (issues.length === 0) {
        console.log('\n✓ No new issues to save');
        return;
    }

    console.log(`\nSaving ${issues.length} issues to database...`);

    const { data, error } = await advDb
        .from('compliance_issues')
        .insert(issues)
        .select();

    if (error) {
        console.error('Error saving issues:', error);
        throw error;
    }

    console.log(`✓ Saved ${data.length} compliance issues`);
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
