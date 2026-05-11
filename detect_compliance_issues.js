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
const { extractBaseName, checkAdvDatabase, parseRelatedPersons } = require('./lib/adv_lookup');
const { detectPlatform } = require('./lib/platform_detection');

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
 * Parse fund name to extract the "series master LLC" (the manager name)
 * e.g., "Fund A, a series of Manager LLC" -> "Manager LLC"
 * Same logic as New Managers tab uses
 */
function parseFundName(name) {
    if (!name) return name;
    let parsed = name;

    // Remove common suffixes first
    parsed = parsed.replace(/,?\s*(LP|LLC|L\.P\.|L\.L\.C\.|Ltd|Limited|Inc|Incorporated)$/i, '');

    // Handle "A Series of X" pattern - extract the master LLC
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
 * extractBaseName and checkAdvDatabase are now in lib/adv_lookup.js.
 * They are imported at the top of this file and shared with enrichment scripts.
 * The shared version adds the A6 adviser_owners cross-check (title-filtered,
 * owner_type='I' individuals only, requires ≥2-token first+last agreement).
 */

/**
 * A3 + A4: Extract a manager-identity candidate from a Form D filing.
 *
 * Strategy:
 *   1. Detect whether the filing is platform-admin-filed (Sydecar, AngelList, etc.)
 *   2. For platform filings: series-master IS the platform admin — DON'T use it as
 *      the manager identity. Instead pick the pre-series prefix or the first
 *      executive-role related person.
 *   3. For non-platform filings:
 *      a. If entityname matches "X, a series of Y", use Y (the series master)
 *      b. Otherwise, strip fund-numbering suffix and use the prefix
 *
 * Returns { primary, alternates, is_platform, platform_name, source }.
 */
function extractManagerCandidate(filing) {
    const en = filing.entityname || '';
    const platform = detectPlatform(filing);

    const seriesMatch = en.match(/,?\s+a\s+series\s+of\s+(.+?)(?:\s*,?\s*$|$)/i);
    let seriesMaster = seriesMatch ? seriesMatch[1].trim() : null;

    let prefix = seriesMatch
        ? en.substring(0, seriesMatch.index).trim().replace(/,\s*$/, '')
        : en;

    if (!seriesMatch) {
        prefix = prefix
            .replace(/,?\s*(LP|LLC|L\.P\.|L\.L\.C\.|Ltd|Limited|Inc|Incorporated)\.?\s*$/i, '')
            .replace(/\s+(Fund\s+)?[IVX]+$/i, '')
            .replace(/\s+Fund\s+\d+$/i, '')
            .trim();
    }

    const principals = parseRelatedPersons(filing.related_names, filing.related_roles);

    let primary, source;
    let alternates = [];

    if (platform.is_platform) {
        if (prefix && prefix.length >= 4 && !platform.platform_name.toLowerCase().includes(prefix.toLowerCase().slice(0, 6))) {
            primary = prefix;
            source = `platform_${platform.platform_name}_prefix`;
        } else if (principals.length > 0) {
            primary = principals[0].name;
            source = `platform_${platform.platform_name}_principal`;
        } else {
            primary = seriesMaster || en;
            source = `platform_${platform.platform_name}_fallback_master`;
        }
        alternates = principals.slice(0, 5).map(p => p.name);
    } else {
        primary = seriesMaster || prefix || en;
        source = seriesMaster ? 'series_master' : 'entity_prefix';
        alternates = principals.slice(0, 3).map(p => p.name);
    }

    return {
        primary,
        alternates,
        is_platform: platform.is_platform,
        platform_name: platform.platform_name,
        platform_signals: platform.signals,
        source,
    };
}

/**
 * A10: Classify likely-exemption tags (review tags, NOT hard suppressions).
 *
 * Only flag the two exemptions that genuinely require NO Form ADV filing:
 *   - Foreign private adviser (§202(a)(30))
 *   - Family office (Rule 202(a)(11)(G)-1)
 *
 * Do NOT tag §203(l) VC or §203(m) PF — those advisers DO file Form ADV (as ERAs).
 */
function classifyExemptions(data) {
    const tags = [];
    const country = (data.stateorcountry || '').toUpperCase().trim();
    const usStates = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP']);
    if (country && country.length > 0 && !usStates.has(country) && !['UNITED STATES','USA','US'].includes(country)) {
        tags.push({ tag: 'likely_foreign_private_adviser', evidence: `issuer jurisdiction = ${country}` });
    }

    if (data.related_names) {
        const persons = data.related_names.split('|').map(n => n.trim()).filter(Boolean);
        if (persons.length > 0 && persons.length <= 4) {
            const surnames = persons.map(p => {
                const parts = p.split(/[\s,]+/).filter(Boolean);
                return (parts[parts.length - 1] || '').toUpperCase();
            }).filter(s => s.length >= 3);
            const surnameCounts = {};
            surnames.forEach(s => { surnameCounts[s] = (surnameCounts[s] || 0) + 1; });
            const sharedSurname = Object.entries(surnameCounts).find(([s, c]) => c >= 2);
            if (sharedSurname) {
                tags.push({ tag: 'likely_family_office', evidence: `${sharedSurname[1]}/${persons.length} related persons share surname "${sharedSurname[0]}"` });
            }
        }
    }

    return tags;
}

/**
 * Detector 1: Needs Initial ADV Filing
 * New MANAGERS filed Form D but haven't filed ADV within 60 days
 *
 * CORRECTED LOGIC (2026-01-07):
 * 1. Get recent Form D filings
 * 2. Get all matched accessions from cross_reference_matches (these have ADV matches)
 * 3. Find Form D filings NOT in matches = potentially no ADV filing
 * 4. Filter to those filed more than 60 days ago
 * 5. GROUP by manager (using series/master LLC pattern)
 * 6. **NEW: Validate each manager against advisers_enriched database using base name extraction**
 * 7. Only flag if NOT found in database (true violators)
 *
 * KEY FIX: GP entity names (e.g., "KIG GP, LLC") often differ from registered adviser names
 * (e.g., "KIG INVESTMENT MANAGEMENT, LLC"). We must check the database with base name matching
 * to avoid false positives.
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
        .select('accessionnumber, cik, entityname, filing_date, totalofferingamount, related_names, related_roles, stateorcountry, isamendment, industrygrouptype, street1, city, zipcode, issuerphonenumber, nameofsigner')
        .not('cik', 'is', null)
        .eq('industrygrouptype', 'Pooled Investment Fund')  // A1: hard scope gate
        .neq('isamendment', 'true')                          // exclude amendments
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
    // GROUP by manager using parseFundName (series/master LLC pattern)
    const managerFilings = new Map(); // manager_name -> { filings: [], earliest_date, latest_date, total_offering }
    const now = Date.now();

    for (const filing of formDFilings) {
        // Skip if this Form D has a match in cross_reference_matches
        if (matchedAccessionSet.has(filing.accessionnumber)) continue;

        const filingDate = new Date(filing.filing_date);
        const daysSinceFiling = Math.floor((now - filingDate.getTime()) / (1000 * 60 * 60 * 24));

        // Only consider if more than 60 days have passed (grace period for initial ADV filing)
        if (daysSinceFiling > DETECTION_CONFIG.initialFilingGracePeriodDays) {
            // A3 + A4: extract manager identity via multi-strategy + platform routing
            const cand = extractManagerCandidate(filing);
            const managerName = cand.primary || filing.entityname;

            if (!managerFilings.has(managerName)) {
                managerFilings.set(managerName, {
                    filings: [],
                    earliest_date: filing.filing_date,
                    latest_date: filing.filing_date,
                    total_offering: 0,
                    primary_cik: filing.cik,
                    related_names: filing.related_names,
                    related_roles: filing.related_roles,           // A6
                    stateorcountry: filing.stateorcountry,         // A10
                    is_platform_filing: cand.is_platform,          // A4
                    platform_name: cand.platform_name,             // A4
                    extraction_source: cand.source,                // diagnostic
                    issuer_address: filing.street1 || null,        // A4
                    issuer_phone: filing.issuerphonenumber || null,// A4
                    issuer_signer: filing.nameofsigner || null,    // diagnostic
                });
            }

            const manager = managerFilings.get(managerName);
            manager.filings.push({
                entity_name: filing.entityname,
                cik: filing.cik,
                accession: filing.accessionnumber,
                filing_date: filing.filing_date,
                offering_amount: filing.totalofferingamount
            });

            if (filing.filing_date < manager.earliest_date) manager.earliest_date = filing.filing_date;
            if (filing.filing_date > manager.latest_date) manager.latest_date = filing.filing_date;

            if (filing.totalofferingamount && !isNaN(filing.totalofferingamount)) {
                manager.total_offering += parseFloat(filing.totalofferingamount);
            }
        }
    }

    console.log(`  Found ${managerFilings.size} unique managers with unmatched Form D filings`);

    // Step 4: Validate each manager against ADV database
    // Only flag managers that are NOT registered
    const issues = [];
    const nowDate = new Date();
    let checkedCount = 0;

    for (const [managerName, data] of managerFilings) {
        // A6: Check ADV with multi-strategy lookup (now in lib/adv_lookup.js).
        // We pass related_names AND related_roles so the lib can do title-filtered
        // adviser_owners cross-check on Form D principals with executive roles.
        const dbResult = await checkAdvDatabase(advDb, managerName, {
            relatedNames: data.related_names,
            relatedRoles: data.related_roles,
        });

        if (dbResult.found) {
            console.log(`  ✓ Found: ${managerName} → ${dbResult.adviser_name} (CRD ${dbResult.crd}, via ${dbResult.source}${dbResult.matched_person ? `, person: ${dbResult.matched_person}` : ''})`);
            continue;
        }

        // A8: Form D timing-lag suppression — if this firm has any Form ADV filing
        // discoverable through one of its named principals (Schedule A/B control
        // persons in adviser_owners), suppress the flag. The principal is
        // registered ⇒ their firm is registered ⇒ this fund is just a new fund
        // pending next annual amendment.
        //
        // Use personOnly: true so checkAdvDatabase skips firm-name strategies
        // (which would otherwise resolve "John" → any adviser starting with John,
        // producing false-positive suppressions). Person-graph match only.
        let timingLagSkip = false;
        if (data.related_names) {
            const personList = data.related_names.split('|').map(n => n.trim()).filter(n => n.length > 3);
            for (const p of personList.slice(0, 5)) {
                const altCheck = await checkAdvDatabase(advDb, p, {
                    relatedNames: data.related_names,
                    relatedRoles: data.related_roles,
                    personOnly: true,
                });
                if (altCheck.found) {
                    console.log(`  ↻ Timing-lag suppress: ${managerName} (resolved via principal "${p}" → CRD ${altCheck.crd})`);
                    timingLagSkip = true;
                    break;
                }
            }
        }
        if (timingLagSkip) continue;

        // A10: classify likely exemptions (FOREIGN / FAMILY_OFFICE only — these are
        // the regulatorily-real "no Form ADV required" exemptions per §202(a)(30) and
        // Rule 202(a)(11)(G)-1. §203(l)/§203(m) are NOT suppressions because those
        // firms still file Form ADV as ERAs.)
        const exemptionTags = classifyExemptions(data);

        // Manager NOT found - this is a candidate for review
        const daysSinceFirst = Math.floor((nowDate.getTime() - new Date(data.earliest_date).getTime()) / (1000 * 60 * 60 * 24));

        issues.push({
            form_d_cik: data.primary_cik,
            adviser_crd: null,
            discrepancy_type: 'needs_initial_adv_filing',
            severity: exemptionTags.length > 0 ? 'low' : 'high',
            description: `Manager "${managerName}" has ${data.filings.length} Form D filing(s) since ${data.earliest_date} but has not filed Form ADV (${daysSinceFirst} days since first filing, verified against ADV database)`,
            metadata: {
                manager_name: managerName,
                entity_name: managerName,
                fund_count: data.filings.length,
                earliest_filing_date: data.earliest_date,
                latest_filing_date: data.latest_date,
                days_since_first_filing: daysSinceFirst,
                total_offering_amount: data.total_offering,
                cik: data.primary_cik,
                validation_method: 'database_check_v2',
                extraction_source: data.extraction_source,
                is_platform_filing: data.is_platform_filing || false,
                platform_name: data.platform_name || null,
                stateorcountry: data.stateorcountry || null,
                likely_exemptions: exemptionTags, // A10: tags, not hard suppression
                sample_funds: data.filings.slice(0, 5).map(f => ({
                    name: f.entity_name,
                    cik: f.cik,
                    filing_date: f.filing_date,
                    offering_amount: f.offering_amount
                }))
            }
        });

        checkedCount++;
        if (checkedCount % 50 === 0) {
            console.log(`  Validated ${checkedCount}/${managerFilings.size} managers, found ${issues.length} candidates...`);
        }
    }

    console.log(`  Validated all ${managerFilings.size} managers`);
    console.log(`  Found ${issues.length} true violators (managers NOT registered in ADV database)`);
    return issues;
}

/**
 * Helper: Get actual latest ADV year for an adviser from the ADV database
 * Uses GAV (Gross Asset Value) columns to find the most recent year with data
 */
async function getActualLatestAdvYear(crd) {
    try {
        const { data: funds } = await advDb
            .from('funds_enriched')
            .select('gav_2025, gav_2024, gav_2023, gav_2022, gav_2021, gav_2020')
            .eq('adviser_entity_crd', crd)
            .limit(10);

        if (!funds || funds.length === 0) return null;

        // Check each year from newest to oldest
        const years = [2025, 2024, 2023, 2022, 2021, 2020];
        for (const year of years) {
            const hasDataThisYear = funds.some(f => f[`gav_${year}`] !== null);
            if (hasDataThisYear) return year;
        }
        return null;
    } catch (error) {
        return null;
    }
}

/**
 * Detector 2: Overdue Annual ADV Amendment
 * Finds advisers with Form D activity who haven't updated their ADV this year
 *
 * FIXED LOGIC:
 * 1. Get advisers with recent Form D filings (from cross_reference_matches)
 * 2. For each adviser, check ACTUAL latest ADV year from advisers_enriched GAV columns
 * 3. Only flag if ADV is truly outdated (no data for current year or last year)
 */
async function detectOverdueAnnualAmendment() {
    console.log('\n[2/6] Detecting: Overdue Annual ADV Amendment...');

    const currentYear = new Date().getFullYear();
    const issues = [];
    const adviserFormDs = new Map(); // Collect Form D filings per adviser

    // Step 1: Get all advisers with Form D matches
    let offset = 0;
    while (offset < DETECTION_CONFIG.maxRecords) {
        const { data: matches, error } = await formDDb
            .from('cross_reference_matches')
            .select('adviser_entity_crd, adviser_entity_legal_name, formd_accession, formd_entity_name')
            .not('adviser_entity_crd', 'is', null)
            .range(offset, offset + DETECTION_CONFIG.batchSize - 1);

        if (error) throw error;
        if (!matches || matches.length === 0) break;

        for (const match of matches) {
            if (!match.adviser_entity_crd) continue;

            if (!adviserFormDs.has(match.adviser_entity_crd)) {
                adviserFormDs.set(match.adviser_entity_crd, {
                    adviser_name: match.adviser_entity_legal_name,
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

    console.log(`  Found ${adviserFormDs.size} unique advisers with Form D activity`);

    // Step 2: For each adviser, check actual latest ADV year
    let checkedCount = 0;
    for (const [crd, data] of adviserFormDs) {
        const actualLatestYear = await getActualLatestAdvYear(crd);

        // Only flag if ADV is actually overdue (not filed in current year)
        // Note: We allow last year since annual amendment deadline is April 1
        const isOverdue = actualLatestYear !== null && actualLatestYear < currentYear - 1;

        if (isOverdue) {
            // Get Form D filing dates
            const formDDetails = [];
            for (const f of data.form_d_filings.slice(0, 10)) {
                const { data: filingData } = await formDDb
                    .from('form_d_filings')
                    .select('accessionnumber, filing_date, cik')
                    .eq('accessionnumber', f.accession)
                    .single();

                if (filingData) {
                    formDDetails.push({
                        accession: f.accession,
                        entity_name: f.entity_name,
                        filing_date: filingData.filing_date,
                        cik: filingData.cik
                    });
                }
            }

            // Filter to Form Ds filed after last ADV
            const formDsAfterAdv = formDDetails.filter(f => {
                if (!f.filing_date) return false;
                return new Date(f.filing_date).getFullYear() > actualLatestYear;
            });

            issues.push({
                adviser_crd: crd,
                form_d_cik: formDsAfterAdv[0]?.cik || null,  // Bug 3 fix: Add CIK at root for EDGAR link
                discrepancy_type: 'overdue_annual_amendment',
                severity: 'high',
                description: `Manager "${data.adviser_name}" has not filed current year ADV amendment (last filing: ${actualLatestYear || 'unknown'})${formDsAfterAdv.length > 0 ? `. ${formDsAfterAdv.length} Form D filings since then.` : ''}`,
                metadata: {
                    adviser_name: data.adviser_name,
                    latest_adv_year: actualLatestYear,
                    current_year: currentYear,
                    form_d_count_after_adv: formDsAfterAdv.length,
                    form_d_filings_after_adv: formDsAfterAdv.slice(0, 5)
                }
            });
        }

        checkedCount++;
        if (checkedCount % 500 === 0) {
            console.log(`    Checked ${checkedCount}/${adviserFormDs.size} advisers, found ${issues.length} overdue...`);
        }
    }

    console.log(`  Found ${issues.length} issues (unique advisers with overdue ADV)`);
    return issues;
}

/**
 * Detector 3: VC Exemption Violation
 * Manager claims venture capital exemption (Rule 203(l)-1) but manages non-VC funds
 *
 * REGULATORY BASIS (Section 203(l)):
 * - Adviser must manage ONLY venture capital funds
 * - ANY non-VC fund blows the entire exemption
 *
 * NON-VC FUND TYPES (per Form ADV Section 7.B Q10):
 * - Hedge Fund = VIOLATION
 * - Private Equity Fund = VIOLATION
 * - Real Estate Fund = VIOLATION
 * - Liquidity Fund = VIOLATION
 * - Securitized Asset Fund = VIOLATION
 * - Other Private Fund = VIOLATION
 *
 * IMPORTANT: exemption_2b1 = VC exemption (Rule 203(l)-1)
 *            exemption_2b2 = Private fund adviser exemption (Rule 203(m)-1, under $150M)
 */
async function detectVCExemptionViolation() {
    console.log('\n[3/6] Detecting: VC Exemption Violation...');

    // Non-VC fund types that blow the 203(l) exemption
    // Per SEC: VC exemption requires adviser to manage ONLY VC funds
    const NON_VC_FUND_TYPES = [
        'hedge fund',
        'private equity fund',
        'real estate fund',
        'liquidity fund',
        'securitized asset fund',
        'other private fund'
    ];

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

    // Bug 1 fix: Pre-fetch Form D CIKs via cross_reference_matches -> form_d_filings join
    // form_d_file_number in ADV is often NULL, so we need this fallback
    // NOTE: cross_reference_matches has formd_accession, NOT formd_cik
    // We must look up CIK from form_d_filings using the accession number
    const adviserCrds = advisers.map(a => a.crd);
    const crossRefCiks = new Map();  // CRD -> [CIK1, CIK2, ...]

    console.log('  Pre-fetching Form D accessions from cross_reference_matches...');
    const crdToAccessions = new Map();  // CRD -> [accession1, accession2, ...]

    let crOffset = 0;
    while (crOffset < 200000) {
        const { data: crossRefs, error: crError } = await formDDb
            .from('cross_reference_matches')
            .select('adviser_entity_crd, formd_accession')
            .in('adviser_entity_crd', adviserCrds)
            .not('formd_accession', 'is', null)
            .range(crOffset, crOffset + 1000 - 1);

        if (crError) {
            console.error('  Warning: Could not fetch cross_reference_matches:', crError.message);
            break;
        }
        if (!crossRefs || crossRefs.length === 0) break;

        for (const cr of crossRefs) {
            if (!crdToAccessions.has(cr.adviser_entity_crd)) {
                crdToAccessions.set(cr.adviser_entity_crd, []);
            }
            if (cr.formd_accession && !crdToAccessions.get(cr.adviser_entity_crd).includes(cr.formd_accession)) {
                crdToAccessions.get(cr.adviser_entity_crd).push(cr.formd_accession);
            }
        }

        crOffset += 1000;
        if (crossRefs.length < 1000) break;
    }
    console.log(`  Found ${crdToAccessions.size} advisers with Form D accessions`);

    // Now batch-fetch CIKs from form_d_filings using the accession numbers
    const allAccessions = [...new Set([...crdToAccessions.values()].flat())];
    const accessionToCik = new Map();  // accession -> CIK

    if (allAccessions.length > 0) {
        console.log(`  Looking up CIKs for ${allAccessions.length} Form D filings...`);
        let accOffset = 0;
        while (accOffset < allAccessions.length) {
            const batch = allAccessions.slice(accOffset, accOffset + 500);
            const { data: filings, error: filingsError } = await formDDb
                .from('form_d_filings')
                .select('accessionnumber, cik')
                .in('accessionnumber', batch)
                .not('cik', 'is', null);

            if (filingsError) {
                console.error('  Warning: Could not fetch form_d_filings:', filingsError.message);
                break;
            }
            if (filings) {
                for (const f of filings) {
                    if (f.cik) accessionToCik.set(f.accessionnumber, f.cik);
                }
            }
            accOffset += 500;
        }
        console.log(`  Found CIKs for ${accessionToCik.size} filings`);
    }

    // Build CRD -> CIK map by joining the two lookups
    for (const [crd, accessions] of crdToAccessions) {
        const ciks = accessions
            .map(acc => accessionToCik.get(acc))
            .filter(Boolean);
        if (ciks.length > 0) {
            crossRefCiks.set(crd, [...new Set(ciks)]);
        }
    }
    console.log(`  Built CIK map for ${crossRefCiks.size} advisers`);

    const issues = [];

    for (const adviser of advisers) {
        // Check funds managed by this adviser from ADV
        const { data: funds, error: fundsError } = await advDb
            .from('funds_enriched')
            .select('fund_name, fund_type, reference_id, form_d_file_number')
            .eq('adviser_entity_crd', adviser.crd);

        if (fundsError) continue;

        // Find non-VC funds in the ADV filing
        // CRITICAL: VC exemption requires ALL funds to be VC funds
        // ANY of these fund types blows the exemption
        const nonVCFunds = funds.filter(fund => {
            const type = (fund.fund_type || '').toLowerCase().trim();
            // Skip if no fund type specified
            if (!type) return false;

            // Check if this is a non-VC fund type
            // Venture Capital Fund is the ONLY acceptable type
            const isVentureCapital = type.includes('venture capital') || type === 'vc' || type === 'venture capital fund';

            // If it's explicitly a non-VC type, it's a violation
            const isExplicitNonVC = NON_VC_FUND_TYPES.some(nonVC => type.includes(nonVC));

            // Return true if: has a type AND (explicitly non-VC OR not explicitly VC)
            return isExplicitNonVC || !isVentureCapital;
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

            // Categorize the non-VC funds by type for clarity
            const fundTypeBreakdown = {};
            nonVCFunds.forEach(f => {
                const type = (f.fund_type || 'Unknown').trim();
                fundTypeBreakdown[type] = (fundTypeBreakdown[type] || 0) + 1;
            });

            // Bug 1 fix: Use cross_reference_matches fallback when form_d_file_number is NULL
            const fallbackCik = crossRefCiks.get(adviser.crd)?.[0] || null;

            issues.push({
                adviser_crd: adviser.crd,
                fund_reference_id: primaryFund.reference_id,  // For linking to fund detail
                form_d_cik: primaryFormD?.cik || fallbackCik,  // Primary from file_num, fallback from cross_ref
                discrepancy_type: 'vc_exemption_violation',
                severity: 'critical',  // Upgraded: this is a serious exemption violation
                description: `Manager "${adviser.adviser_name}" claims VC exemption (203(l)-1) but manages ${nonVCFunds.length} non-VC fund(s): ${Object.entries(fundTypeBreakdown).map(([t, c]) => `${c} ${t}`).join(', ')}`,
                metadata: {
                    exemption_claimed: 'vc_203l1',  // Clear label
                    exemption_2b1: 'Y',
                    non_vc_fund_count: nonVCFunds.length,
                    total_funds: funds.length,
                    fund_type_breakdown: fundTypeBreakdown,
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
 * REGULATORY BASIS: ADV Section 7.B must list all managed private funds
 *
 * CRITICAL DATA LIMITATION:
 * The form_d_file_number field in ADV Section 7.B Q22 is OPTIONAL and often unpopulated.
 * Cannot rely solely on direct file number matching.
 *
 * DETECTION STRATEGIES (in order of reliability):
 *
 * 1. DIRECT FILE NUMBER MATCHING (highest confidence, but often unavailable):
 *    - Get form_d_file_numbers from funds_enriched for each adviser
 *    - Find Form D filings with those file_nums
 *    - Check if they're in cross_reference_matches
 *    - If Form D exists but no match, fund may be missing
 *
 * 2. NAME MATCHING (medium confidence):
 *    - Find Form Ds where entity_name is similar to adviser name or related_names
 *    - But fund not in cross_reference_matches
 *
 * 3. TIMING ANALYSIS:
 *    - Form D filed before latest ADV should be reflected in that ADV
 *    - Focus on Form Ds filed in previous years not yet in ADV
 */
async function detectMissingFundInADV() {
    console.log('\n[5/6] Detecting: Missing Fund in ADV...');

    const issues = [];
    const currentYear = new Date().getFullYear();
    const advDeadlinePassed = (new Date().getMonth() >= 3); // After April

    // =====================================================
    // STRATEGY 1: Direct form_d_file_number matching
    // =====================================================
    console.log('  Strategy 1: Checking form_d_file_number matches...');

    // Get all advisers with their funds that have form_d_file_numbers
    let adviserFundFileNums = new Map(); // crd -> { name, file_numbers: Set, funds: [] }
    let fundOffset = 0;

    while (fundOffset < DETECTION_CONFIG.maxRecords) {
        const { data: funds, error } = await advDb
            .from('funds_enriched')
            .select('adviser_entity_crd, fund_name, form_d_file_number, reference_id')
            .not('form_d_file_number', 'is', null)
            .not('adviser_entity_crd', 'is', null)
            .range(fundOffset, fundOffset + DETECTION_CONFIG.batchSize - 1);

        if (error) throw error;
        if (!funds || funds.length === 0) break;

        for (const fund of funds) {
            if (!fund.form_d_file_number) continue;

            if (!adviserFundFileNums.has(fund.adviser_entity_crd)) {
                adviserFundFileNums.set(fund.adviser_entity_crd, {
                    file_numbers: new Set(),
                    funds: []
                });
            }

            const advData = adviserFundFileNums.get(fund.adviser_entity_crd);
            advData.file_numbers.add(fund.form_d_file_number);
            advData.funds.push({
                name: fund.fund_name,
                file_num: fund.form_d_file_number,
                reference_id: fund.reference_id
            });
        }

        fundOffset += DETECTION_CONFIG.batchSize;
        if (funds.length < DETECTION_CONFIG.batchSize) break;
    }

    console.log(`  Found ${adviserFundFileNums.size} advisers with form_d_file_number data`);

    // Collect all file numbers to check against Form D filings
    const allFileNums = new Set();
    for (const [_, advData] of adviserFundFileNums) {
        for (const fn of advData.file_numbers) {
            allFileNums.add(fn);
        }
    }

    console.log(`  Total unique file numbers to check: ${allFileNums.size}`);

    // Get Form D filings for these file numbers
    if (allFileNums.size > 0) {
        const fileNumArray = Array.from(allFileNums);
        let formDByFileNum = new Map();

        // Query in batches
        for (let i = 0; i < fileNumArray.length; i += 500) {
            const batch = fileNumArray.slice(i, i + 500);
            const { data: filings } = await formDDb
                .from('form_d_filings')
                .select('file_num, accessionnumber, cik, entityname, filing_date')
                .in('file_num', batch);

            if (filings) {
                for (const f of filings) {
                    if (!formDByFileNum.has(f.file_num)) {
                        formDByFileNum.set(f.file_num, []);
                    }
                    formDByFileNum.get(f.file_num).push(f);
                }
            }
        }

        console.log(`  Found ${formDByFileNum.size} file numbers with Form D filings`);

        // Get all matched accessions from cross_reference_matches
        const allMatchedAccessions = new Set();
        let matchOffset = 0;

        while (matchOffset < DETECTION_CONFIG.maxRecords) {
            const { data: matches, error } = await formDDb
                .from('cross_reference_matches')
                .select('formd_accession')
                .range(matchOffset, matchOffset + DETECTION_CONFIG.batchSize - 1);

            if (error) throw error;
            if (!matches || matches.length === 0) break;

            for (const m of matches) {
                if (m.formd_accession) allMatchedAccessions.add(m.formd_accession);
            }

            matchOffset += DETECTION_CONFIG.batchSize;
            if (matches.length < DETECTION_CONFIG.batchSize) break;
        }

        console.log(`  Total matched accessions: ${allMatchedAccessions.size}`);

        // Get adviser names
        const adviserCrds = Array.from(adviserFundFileNums.keys());
        const adviserNames = new Map();

        for (let i = 0; i < adviserCrds.length; i += 500) {
            const batch = adviserCrds.slice(i, i + 500);
            const { data: advisers } = await advDb
                .from('advisers_enriched')
                .select('crd, adviser_name')
                .in('crd', batch);

            if (advisers) {
                for (const a of advisers) {
                    adviserNames.set(a.crd, a.adviser_name);
                }
            }
        }

        // Check each adviser's file numbers for unmatched Form Ds
        for (const [crd, advData] of adviserFundFileNums) {
            const adviserName = adviserNames.get(crd) || 'Unknown';

            for (const fund of advData.funds) {
                const formDFilings = formDByFileNum.get(fund.file_num) || [];

                for (const filing of formDFilings) {
                    // Skip if already matched
                    if (allMatchedAccessions.has(filing.accessionnumber)) continue;

                    // Check timing
                    const filingDate = new Date(filing.filing_date);
                    const filingYear = filingDate.getFullYear();

                    // Only flag if Form D was filed in a previous year
                    // (should have been reflected in latest ADV)
                    const shouldBeInAdv = filingYear < currentYear ||
                        (filingYear === currentYear - 1 && advDeadlinePassed);

                    if (shouldBeInAdv) {
                        issues.push({
                            adviser_crd: crd,
                            fund_reference_id: fund.reference_id,
                            form_d_cik: filing.cik,
                            discrepancy_type: 'missing_fund_in_adv',
                            severity: 'medium',
                            description: `Fund "${filing.entityname}" (Form D filed ${filing.filing_date}) has file number ${fund.file_num} listed in ADV fund "${fund.name}" but Form D not matched to ADV fund record`,
                            metadata: {
                                detection_strategy: 'form_d_file_number',
                                fund_name: filing.entityname,
                                adv_fund_name: fund.name,
                                adv_fund_reference_id: fund.reference_id,
                                form_d_file_number: fund.file_num,
                                formd_accession: filing.accessionnumber,
                                formd_filing_date: filing.filing_date,
                                formd_cik: filing.cik,
                                adviser_name: adviserName
                            }
                        });
                    }
                }
            }
        }
    }

    console.log(`  Strategy 1 found ${issues.length} issues`);

    // =====================================================
    // STRATEGY 2: Name-based matching for advisers
    // =====================================================
    console.log('  Strategy 2: Checking name-based matches...');

    // Get advisers with existing cross_reference_matches
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

    // Get recent Form D filings for name matching
    const { data: allFormDFilings, error: formDError } = await formDDb
        .from('form_d_filings')
        .select('accessionnumber, cik, entityname, filing_date, totalofferingamount, related_names')
        .order('filing_date', { ascending: false })
        .limit(10000);

    if (formDError) throw formDError;

    // Build set of all matched accessions (including from Strategy 1)
    const allMatchedAccessions = new Set();
    for (const [_, advData] of adviserMatches) {
        for (const acc of advData.matchedAccessions) {
            allMatchedAccessions.add(acc);
        }
    }

    // Also exclude any we already flagged in Strategy 1
    const strategy1Accessions = new Set(issues.map(i => i.metadata.formd_accession));

    // For each adviser, find Form Ds that mention their name but aren't matched
    for (const [crd, advData] of adviserMatches) {
        const adviserName = (advData.name || '').toUpperCase();
        if (!adviserName || adviserName.length < 3) continue;

        // Extract key words from adviser name (skip common words)
        const skipWords = new Set(['LLC', 'LP', 'INC', 'CAPITAL', 'PARTNERS', 'MANAGEMENT', 'FUND', 'ADVISORS', 'ADVISERS', 'INVESTMENTS', 'GROUP', 'HOLDINGS', 'THE', 'AND', 'OF']);
        const adviserKeyWords = adviserName.split(/\s+/)
            .filter(w => w.length > 2 && !skipWords.has(w))
            .slice(0, 3);  // Use first 3 distinctive words

        if (adviserKeyWords.length === 0) continue;

        for (const filing of allFormDFilings) {
            // Skip if already matched or flagged in Strategy 1
            if (allMatchedAccessions.has(filing.accessionnumber)) continue;
            if (strategy1Accessions.has(filing.accessionnumber)) continue;

            // Check if this Form D is related to this adviser
            const relatedNames = (filing.related_names || '').toUpperCase();
            const entityName = (filing.entityname || '').toUpperCase();
            const combinedText = relatedNames + ' ' + entityName;

            // Check if adviser's key words appear in the Form D
            const matchCount = adviserKeyWords.filter(w => combinedText.includes(w)).length;
            if (matchCount < 2) continue;  // Need at least 2 matching key words

            // Check timing
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
                        detection_strategy: 'name_matching',
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

    // Deduplicate by accession number (same Form D might match multiple strategies/advisers)
    const seenAccessions = new Set();
    const dedupedIssues = issues.filter(issue => {
        const acc = issue.metadata.formd_accession;
        if (seenAccessions.has(acc)) return false;
        seenAccessions.add(acc);
        return true;
    });

    console.log(`  Found ${dedupedIssues.length} total issues (Form Ds potentially missing from ADV)`);
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
 * Clear existing issues of a specific type from database
 * This approach ensures each detector's issues are cleanly replaced
 * without requiring full table DELETE access (RLS-compatible)
 */
async function clearIssuesByType(discrepancyType) {
    console.log(`  Clearing existing "${discrepancyType}" issues...`);

    const { error, count } = await formDDb
        .from('compliance_issues')
        .delete()
        .eq('discrepancy_type', discrepancyType);

    if (error) {
        // Log error but don't throw - RLS might block DELETE
        // In that case, we'll have duplicates but script continues
        console.error(`  Warning: Could not clear "${discrepancyType}" issues:`, error.message);
        return false;
    }

    console.log(`  Cleared existing "${discrepancyType}" issues`);
    return true;
}

/**
 * Save issues to database in batches for a specific discrepancy type
 * Called immediately after clearing that type's issues to prevent duplicates
 */
async function saveIssuesBatch(issues, discrepancyType) {
    if (issues.length === 0) {
        console.log(`  No ${discrepancyType} issues to save`);
        return 0;
    }

    console.log(`  Saving ${issues.length} ${discrepancyType} issues...`);

    const insertBatchSize = 500;  // Insert in smaller batches to avoid timeout
    let totalSaved = 0;

    for (let i = 0; i < issues.length; i += insertBatchSize) {
        const batch = issues.slice(i, i + insertBatchSize);

        const { data, error } = await formDDb
            .from('compliance_issues')
            .insert(batch)
            .select('id');

        if (error) {
            console.error(`  Error saving ${discrepancyType} batch ${i / insertBatchSize + 1}:`, error);
            throw error;
        }

        totalSaved += data.length;
    }

    console.log(`  Saved ${totalSaved} ${discrepancyType} issues`);
    return totalSaved;
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
        // Each detector clears its own issue type before inserting fresh data
        // This prevents duplicates and ensures each run gives accurate counts
        if (DETECTION_CONFIG.enabledDetectors.includes('needs_initial_adv_filing')) {
            await clearIssuesByType('needs_initial_adv_filing');
            const issues = await detectNeedsInitialADVFiling();
            await saveIssuesBatch(issues, 'needs_initial_adv_filing');
            allIssues.push(...issues);
        }
        if (DETECTION_CONFIG.enabledDetectors.includes('overdue_annual_amendment')) {
            await clearIssuesByType('overdue_annual_amendment');
            const issues = await detectOverdueAnnualAmendment();
            await saveIssuesBatch(issues, 'overdue_annual_amendment');
            allIssues.push(...issues);
        }
        if (DETECTION_CONFIG.enabledDetectors.includes('vc_exemption_violation')) {
            await clearIssuesByType('vc_exemption_violation');
            const issues = await detectVCExemptionViolation();
            await saveIssuesBatch(issues, 'vc_exemption_violation');
            allIssues.push(...issues);
        }
        if (DETECTION_CONFIG.enabledDetectors.includes('fund_type_mismatch')) {
            await clearIssuesByType('fund_type_mismatch');
            const issues = await detectFundTypeMismatch();
            await saveIssuesBatch(issues, 'fund_type_mismatch');
            allIssues.push(...issues);
        }
        if (DETECTION_CONFIG.enabledDetectors.includes('missing_fund_in_adv')) {
            await clearIssuesByType('missing_fund_in_adv');
            const issues = await detectMissingFundInADV();
            await saveIssuesBatch(issues, 'missing_fund_in_adv');
            allIssues.push(...issues);
        }
        if (DETECTION_CONFIG.enabledDetectors.includes('exemption_mismatch')) {
            await clearIssuesByType('exemption_mismatch');
            const issues = await detectExemptionMismatch();
            await saveIssuesBatch(issues, 'exemption_mismatch');
            allIssues.push(...issues);
        }

        // Note: Issues are saved per-detector above, not in bulk at the end

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
    detectExemptionMismatch,
    // Exported for tests:
    extractManagerCandidate,
    classifyExemptions,
};
