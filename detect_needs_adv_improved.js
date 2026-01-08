#!/usr/bin/env node
/**
 * Improved Needs Initial ADV Filing Detection
 *
 * GOAL: Flag ALL private fund filers (Form D) who should file Form ADV but haven't
 *
 * The 60-day rule: Must file Form ADV within 60 days of closing first fund
 *
 * APPROACH:
 * 1. Get recent Form D filings not in cross_reference_matches (no ADV match yet)
 * 2. Extract firm name candidates:
 *    - Series LLC pattern: "Fund A, a series of Manager LLC" -> "Manager LLC"
 *    - Related names: Find company names (LLC, LP, Inc, Management, Capital, etc.)
 *    - Entity name cleaning: Strip fund indicators
 * 3. Validate against advisers_enriched (fuzzy name match)
 * 4. Flag unmatched as "needs_initial_adv_filing"
 *
 * Created: 2026-01-07
 */

const { createClient } = require('@supabase/supabase-js');

// Database configuration
const ADV_URL = process.env.ADV_URL || 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = process.env.ADV_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const advDb = createClient(ADV_URL, ADV_KEY);
const formDDb = createClient(FORMD_URL, FORMD_KEY);

// Legal entity suffixes that indicate a company (not a person)
const COMPANY_SUFFIXES = [
    'LLC', 'L.L.C.', 'LP', 'L.P.', 'LTD', 'LIMITED', 'INC', 'INCORPORATED',
    'CORP', 'CORPORATION', 'CO', 'COMPANY', 'PARTNERS', 'PARTNERSHIP',
    'HOLDINGS', 'GROUP', 'FUND', 'MANAGEMENT', 'CAPITAL', 'ADVISORS',
    'ADVISERS', 'VENTURES', 'INVESTMENTS', 'EQUITY', 'ASSET', 'SECURITIES'
];

const COMPANY_SUFFIX_REGEX = new RegExp(
    `\\b(${COMPANY_SUFFIXES.join('|')})\\b\\.?$`,
    'i'
);

// Words that indicate this is a fund name, not the manager
const FUND_INDICATORS = [
    'FUND', 'SERIES', 'PORTFOLIO', 'FEEDER', 'MASTER', 'OFFSHORE', 'ONSHORE',
    'PARALLEL', 'SPV', 'VEHICLE', 'TRANCHE', 'CLASS'
];

/**
 * Check if a name looks like a company (vs a person)
 */
function isCompanyName(name) {
    if (!name) return false;
    const upper = name.toUpperCase();

    // Has company suffix?
    if (COMPANY_SUFFIX_REGEX.test(upper)) return true;

    // Has keywords suggesting company?
    for (const keyword of ['MANAGEMENT', 'CAPITAL', 'PARTNERS', 'ADVISORS', 'VENTURES', 'INVESTMENTS']) {
        if (upper.includes(keyword)) return true;
    }

    // Check if it's likely a person name (2-3 words, no company keywords)
    const words = name.trim().split(/\s+/);
    if (words.length === 2 || words.length === 3) {
        const allCapitalizedWords = words.every(w => /^[A-Z][a-z]+$/.test(w));
        if (allCapitalizedWords) return false; // Looks like "John Smith" or "John Michael Smith"
    }

    return false;
}

/**
 * Extract firm name from "a series of X" pattern
 */
function extractSeriesManager(entityName) {
    if (!entityName) return null;

    // Pattern: "Fund A, a series of Manager LLC"
    const seriesMatch = entityName.match(/[,\s]+a\s+series\s+of\s+(.+?)$/i);
    if (seriesMatch) {
        return seriesMatch[1].trim();
    }

    // Pattern: "Fund A - Series of Manager LLC"
    const dashSeriesMatch = entityName.match(/\s+-\s+series\s+of\s+(.+?)$/i);
    if (dashSeriesMatch) {
        return dashSeriesMatch[1].trim();
    }

    // Pattern: "Manager LLC - Series A"
    const managerSeriesMatch = entityName.match(/^(.+?)\s+-\s+Series\s+[A-Za-z0-9]+$/i);
    if (managerSeriesMatch && isCompanyName(managerSeriesMatch[1])) {
        return managerSeriesMatch[1].trim();
    }

    return null;
}

/**
 * Extract company names from related_names/related_roles
 */
function extractRelatedCompanies(relatedNames, relatedRoles) {
    if (!relatedNames) return [];

    const names = relatedNames.split('|').map(n => n.trim().replace(/^--\s*/, ''));
    const roles = relatedRoles ? relatedRoles.split('|').map(r => r.trim()) : [];

    const companies = [];

    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const role = roles[i] || '';

        // Skip if it's clearly a person name
        if (!isCompanyName(name)) continue;

        // Skip service providers (admin, custodian, legal, accountant, auditor)
        const roleLower = role.toLowerCase();
        if (roleLower.includes('admin') || roleLower.includes('custod') ||
            roleLower.includes('legal') || roleLower.includes('counsel') ||
            roleLower.includes('account') || roleLower.includes('audit') ||
            roleLower.includes('attorney') || roleLower.includes('compliance')) {
            continue;
        }

        // Skip if name contains fund indicators (this is another fund, not manager)
        const nameUpper = name.toUpperCase();
        if (FUND_INDICATORS.some(ind => nameUpper.includes(ind))) continue;

        companies.push({
            name: name,
            role: role,
            priority: role.toLowerCase().includes('managing') ||
                      role.toLowerCase().includes('general partner') ||
                      role.toLowerCase().includes('director') ? 1 : 2
        });
    }

    // Sort by priority (managing member > director > other)
    return companies.sort((a, b) => a.priority - b.priority);
}

/**
 * Clean entity name to get potential manager name
 */
function cleanEntityName(entityName) {
    if (!entityName) return null;

    let name = entityName;

    // Remove fund numbers (I, II, III, IV, Fund 1, Fund 2, etc.)
    name = name.replace(/\s+(Fund\s+)?[IVX]+$/i, '');
    name = name.replace(/\s+Fund\s+\d+$/i, '');
    name = name.replace(/\s+\d+$/i, '');

    // Remove series/class indicators
    name = name.replace(/\s*-?\s*(Series|Class|Tranche)\s+[A-Za-z0-9-]+$/i, '');

    // Remove common suffixes
    name = name.replace(/,?\s*(LP|LLC|L\.P\.|L\.L\.C\.|Ltd|Limited|Inc|Incorporated)$/i, '');

    return name.trim();
}

/**
 * Normalize name for matching (remove punctuation, standardize spacing, uppercase)
 */
function normalizeName(name) {
    if (!name) return '';
    return name
        .toUpperCase()
        .replace(/[.,\-'"]/g, ' ')  // Replace punctuation with spaces
        .replace(/\s+/g, ' ')       // Collapse multiple spaces
        .replace(/\b(LLC|L\.?L\.?C\.?|LP|L\.?P\.?|LTD|LIMITED|INC|INCORPORATED|CORP|CORPORATION)\b/gi, '')
        .trim();
}

// Words that are generic in fund/manager names (not distinctive)
const GENERIC_WORDS = new Set([
    'FUND', 'FUNDS', 'MANAGEMENT', 'CAPITAL', 'PARTNERS', 'PARTNER',
    'INVESTMENTS', 'INVESTMENT', 'ADVISORS', 'ADVISERS', 'VENTURES',
    'HOLDINGS', 'GROUP', 'COMPANY', 'CO', 'THE', 'OF', 'AND', 'GP',
    'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'
]);

/**
 * Calculate similarity score between two names (0-1)
 */
function calculateSimilarity(name1, name2) {
    const n1 = normalizeName(name1);
    const n2 = normalizeName(name2);

    if (!n1 || !n2) return 0;
    if (n1 === n2) return 1;

    // Check if one contains the other
    if (n1.includes(n2) || n2.includes(n1)) {
        return 0.9;
    }

    // Word-level matching with weighting
    const words1 = n1.split(' ').filter(w => w.length > 1);
    const words2 = n2.split(' ').filter(w => w.length > 1);

    if (words1.length === 0 || words2.length === 0) return 0;

    // Get distinctive words (non-generic)
    const distinctive1 = words1.filter(w => !GENERIC_WORDS.has(w));
    const distinctive2 = words2.filter(w => !GENERIC_WORDS.has(w));

    // If both have distinctive words, match on those
    if (distinctive1.length > 0 && distinctive2.length > 0) {
        const set1 = new Set(distinctive1);
        const set2 = new Set(distinctive2);

        let matchCount = 0;
        for (const word of set1) {
            if (set2.has(word)) matchCount++;
        }

        // If all distinctive words from one match the other, high confidence
        if (matchCount === distinctive1.length || matchCount === distinctive2.length) {
            return 0.95;
        }

        const totalDistinctive = Math.max(distinctive1.length, distinctive2.length);
        if (matchCount >= 1 && matchCount / totalDistinctive >= 0.5) {
            return 0.85;
        }
    }

    // Prefix matching: first 2 words match?
    if (words1.length >= 2 && words2.length >= 2) {
        if (words1[0] === words2[0] && words1[1] === words2[1]) {
            return 0.85; // First two words match
        }
    }

    // Basic word-level matching
    const set1 = new Set(words1);
    const set2 = new Set(words2);

    let matchCount = 0;
    for (const word of set1) {
        if (set2.has(word)) matchCount++;
    }

    const totalWords = Math.max(words1.length, words2.length);
    return matchCount / totalWords;
}

/**
 * Get all firm name candidates from a Form D filing
 */
function getFirmNameCandidates(filing) {
    const candidates = [];

    // 1. Series LLC pattern (highest priority)
    const seriesManager = extractSeriesManager(filing.entityname);
    if (seriesManager) {
        candidates.push({ name: seriesManager, source: 'series_pattern', priority: 1 });
    }

    // 2. Related companies (second priority)
    const relatedCompanies = extractRelatedCompanies(filing.related_names, filing.related_roles);
    for (const company of relatedCompanies) {
        candidates.push({
            name: company.name,
            source: 'related_names',
            role: company.role,
            priority: company.priority === 1 ? 2 : 3
        });
    }

    // 3. Cleaned entity name (third priority - if it looks like a company)
    const cleaned = cleanEntityName(filing.entityname);
    if (cleaned && isCompanyName(cleaned)) {
        candidates.push({ name: cleaned, source: 'entity_name', priority: 4 });
    }

    // Deduplicate by normalized name
    const seen = new Set();
    return candidates.filter(c => {
        const norm = normalizeName(c.name);
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
    });
}

/**
 * Load adviser names from database for matching
 */
async function loadAdviserNameIndex() {
    console.log('Loading adviser name index from advisers_enriched...');

    const nameIndex = new Map(); // normalized_name -> { crd, original_name }
    let offset = 0;
    const batchSize = 1000;

    while (offset < 50000) {  // Safety limit
        const { data: advisers, error } = await advDb
            .from('advisers_enriched')
            .select('crd, adviser_name')
            .range(offset, offset + batchSize - 1);

        if (error) throw error;
        if (!advisers || advisers.length === 0) break;

        for (const adviser of advisers) {
            if (!adviser.adviser_name) continue;
            const normalized = normalizeName(adviser.adviser_name);
            if (normalized) {
                nameIndex.set(normalized, {
                    crd: adviser.crd,
                    name: adviser.adviser_name
                });
            }
        }

        offset += batchSize;
        if (advisers.length < batchSize) break;
    }

    console.log(`  Loaded ${nameIndex.size} adviser names`);
    return nameIndex;
}

/**
 * Check if any candidate matches a registered adviser
 */
function findAdviserMatch(candidates, nameIndex) {
    for (const candidate of candidates) {
        const normalized = normalizeName(candidate.name);

        // Exact match
        if (nameIndex.has(normalized)) {
            const match = nameIndex.get(normalized);
            return {
                matched: true,
                crd: match.crd,
                matched_name: match.name,
                candidate_name: candidate.name,
                source: candidate.source,
                match_type: 'exact'
            };
        }

        // Fuzzy match (>80% similarity)
        for (const [normName, adviser] of nameIndex) {
            const similarity = calculateSimilarity(candidate.name, adviser.name);
            if (similarity >= 0.8) {
                return {
                    matched: true,
                    crd: adviser.crd,
                    matched_name: adviser.name,
                    candidate_name: candidate.name,
                    source: candidate.source,
                    match_type: 'fuzzy',
                    similarity: similarity
                };
            }
        }
    }

    return { matched: false };
}

/**
 * Main detection function
 */
async function detectNeedsInitialADV() {
    console.log('\n=== Improved Needs Initial ADV Filing Detection ===\n');

    // Step 1: Load adviser name index for matching
    const nameIndex = await loadAdviserNameIndex();

    // Step 2: Get Form D filings from last 6 months
    console.log('\nFetching recent Form D filings...');
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const sixMonthsAgoStr = sixMonthsAgo.toISOString().split('T')[0];

    const { data: formDFilings, error: formDError } = await formDDb
        .from('form_d_filings')
        .select('accessionnumber, cik, entityname, filing_date, totalofferingamount, related_names, related_roles')
        .not('cik', 'is', null)
        .gte('filing_date', sixMonthsAgoStr)
        .order('filing_date', { ascending: false })
        .limit(5000);

    if (formDError) throw formDError;
    console.log(`  Found ${formDFilings.length} Form D filings in last 6 months`);

    // Step 3: Get matched accessions (already have ADV)
    console.log('\nLoading cross_reference_matches...');
    let matchedAccessions = new Set();
    let offset = 0;
    const batchSize = 1000;

    while (offset < 200000) {
        const { data: matches, error } = await formDDb
            .from('cross_reference_matches')
            .select('formd_accession')
            .range(offset, offset + batchSize - 1);

        if (error) throw error;
        if (!matches || matches.length === 0) break;

        for (const m of matches) {
            if (m.formd_accession) matchedAccessions.add(m.formd_accession);
        }

        offset += batchSize;
        if (matches.length < batchSize) break;
    }
    console.log(`  Found ${matchedAccessions.size} Form D filings already matched to ADV`);

    // Step 4: Process unmatched filings
    console.log('\nProcessing unmatched Form D filings...');
    const now = Date.now();
    const GRACE_PERIOD_DAYS = 60;

    const managerIssues = new Map(); // manager_name -> issue data
    let matched = 0, unmatched = 0, withinGrace = 0;

    for (const filing of formDFilings) {
        // Skip if already matched to ADV
        if (matchedAccessions.has(filing.accessionnumber)) {
            matched++;
            continue;
        }

        // Check grace period
        const filingDate = new Date(filing.filing_date);
        const daysSinceFiling = Math.floor((now - filingDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysSinceFiling <= GRACE_PERIOD_DAYS) {
            withinGrace++;
            continue;
        }

        // Extract firm name candidates
        const candidates = getFirmNameCandidates(filing);

        if (candidates.length === 0) {
            // No firm name candidates - use entity name as-is
            candidates.push({ name: filing.entityname, source: 'entity_name_raw', priority: 5 });
        }

        // Check if any candidate matches a registered adviser
        const adviserMatch = findAdviserMatch(candidates, nameIndex);

        if (adviserMatch.matched) {
            matched++;
            continue;
        }

        unmatched++;

        // Group by best firm name candidate (first one)
        const bestCandidate = candidates[0];
        const managerName = bestCandidate.name;

        if (!managerIssues.has(managerName)) {
            managerIssues.set(managerName, {
                manager_name: managerName,
                name_source: bestCandidate.source,
                filings: [],
                earliest_date: filing.filing_date,
                total_offering: 0,
                primary_cik: filing.cik,
                all_candidates: candidates
            });
        }

        const issue = managerIssues.get(managerName);
        issue.filings.push({
            entity_name: filing.entityname,
            cik: filing.cik,
            accession: filing.accessionnumber,
            filing_date: filing.filing_date,
            offering_amount: filing.totalofferingamount
        });

        if (filing.filing_date < issue.earliest_date) {
            issue.earliest_date = filing.filing_date;
        }

        if (filing.totalofferingamount && !isNaN(filing.totalofferingamount)) {
            issue.total_offering += parseFloat(filing.totalofferingamount);
        }
    }

    console.log(`\n=== Results ===`);
    console.log(`  Already matched to ADV: ${matched}`);
    console.log(`  Within 60-day grace period: ${withinGrace}`);
    console.log(`  Needs ADV filing: ${unmatched}`);
    console.log(`  Unique managers needing ADV: ${managerIssues.size}`);

    // Step 5: Create issue records
    const issues = [];
    const nowDate = new Date();

    for (const [managerName, data] of managerIssues) {
        const daysSinceFirst = Math.floor((nowDate.getTime() - new Date(data.earliest_date).getTime()) / (1000 * 60 * 60 * 24));

        issues.push({
            form_d_cik: data.primary_cik,
            adviser_crd: null,
            discrepancy_type: 'needs_initial_adv_filing',
            severity: daysSinceFirst > 180 ? 'critical' : daysSinceFirst > 120 ? 'high' : 'medium',
            description: `Manager "${managerName}" has ${data.filings.length} Form D filing(s) since ${data.earliest_date} but has not filed Form ADV (${daysSinceFirst} days since first filing)`,
            metadata: {
                manager_name: managerName,
                entity_name: managerName,
                name_source: data.name_source,
                fund_count: data.filings.length,
                earliest_filing_date: data.earliest_date,
                days_since_first_filing: daysSinceFirst,
                total_offering_amount: data.total_offering,
                cik: data.primary_cik,
                all_firm_candidates: data.all_candidates.map(c => ({ name: c.name, source: c.source })),
                sample_funds: data.filings.slice(0, 5).map(f => ({
                    name: f.entity_name,
                    cik: f.cik,
                    filing_date: f.filing_date,
                    offering_amount: f.offering_amount
                }))
            }
        });
    }

    // Sort by total offering amount (largest first)
    issues.sort((a, b) => (b.metadata.total_offering_amount || 0) - (a.metadata.total_offering_amount || 0));

    return issues;
}

/**
 * Save issues to database
 */
async function saveIssues(issues) {
    if (issues.length === 0) {
        console.log('\nNo issues to save.');
        return;
    }

    console.log(`\nSaving ${issues.length} issues to compliance_issues table...`);

    // Delete existing needs_initial_adv_filing issues first
    const { error: deleteError } = await formDDb
        .from('compliance_issues')
        .delete()
        .eq('discrepancy_type', 'needs_initial_adv_filing');

    if (deleteError) {
        console.error('  Warning: Could not delete existing issues:', deleteError.message);
    }

    // Insert in batches
    const batchSize = 100;
    for (let i = 0; i < issues.length; i += batchSize) {
        const batch = issues.slice(i, i + batchSize);

        const { error } = await formDDb
            .from('compliance_issues')
            .insert(batch);

        if (error) {
            console.error(`  Batch ${Math.floor(i/batchSize) + 1} error:`, error.message);
        } else {
            console.log(`  Saved batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(issues.length/batchSize)}`);
        }
    }

    console.log('Done saving issues.');
}

/**
 * Print summary table
 */
function printSummary(issues) {
    console.log('\n=== Top 20 Managers Needing ADV Filing ===\n');
    console.log('| # | Manager | Funds | Days | Total Offering | Name Source |');
    console.log('|---|---------|-------|------|----------------|-------------|');

    const top20 = issues.slice(0, 20);
    for (let i = 0; i < top20.length; i++) {
        const issue = top20[i];
        const m = issue.metadata;
        const name = m.manager_name.substring(0, 35);
        const offering = m.total_offering_amount > 0
            ? '$' + (m.total_offering_amount / 1000000).toFixed(1) + 'M'
            : 'N/A';

        console.log(`| ${i+1} | ${name} | ${m.fund_count} | ${m.days_since_first_filing} | ${offering} | ${m.name_source} |`);
    }

    console.log(`\n**Total: ${issues.length} managers need initial ADV filing**`);
}

// Main execution
async function main() {
    try {
        const issues = await detectNeedsInitialADV();
        printSummary(issues);

        // Optionally save to database
        if (process.argv.includes('--save')) {
            await saveIssues(issues);
        } else {
            console.log('\nRun with --save to save issues to database.');
        }

    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

main();
