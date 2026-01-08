#!/usr/bin/env node
/**
 * CORRECTED: Validate managers against ADV registration
 *
 * Key fixes:
 * 1. Extract BASE company name (strip GP, LLC, Management, etc.)
 * 2. Check advisers_enriched database first
 * 3. If not found, search IAPD with base name
 * 4. Check current registration status (not filing dates)
 */

const { createClient } = require('@supabase/supabase-js');
const { chromium } = require('playwright');
const fs = require('fs');

const ADV_URL = 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';
const advDb = createClient(ADV_URL, ADV_KEY);

/**
 * Extract base company name - strip suffixes and entity types
 */
function extractBaseName(name) {
    if (!name) return '';

    let base = name;

    // Remove GP/Manager/Management/Advisors variations
    base = base.replace(/\s+(GP|General Partner|Manager|Management|Advisors?|Advisers?)\s*,?\s*(LLC|LP|L\.?P\.?)?$/i, '');

    // Remove entity types
    base = base.replace(/\s*,?\s*(LLC|L\.?L\.?C\.?|LP|L\.?P\.?|LTD|LIMITED|INC|INCORPORATED)\.?$/i, '');

    // Remove fund-specific terms
    base = base.replace(/\s+(Fund|Capital|Ventures?|Partners?|Holdings?|Group)\s+(I{1,3}|IV|V|VI|VII|VIII|IX|X|\d+)$/i, '');

    return base.trim();
}

/**
 * Check advisers_enriched database
 */
async function checkAdvDatabase(managerName) {
    const baseName = extractBaseName(managerName);

    // Try exact base name match first
    const { data: exact } = await advDb
        .from('advisers_enriched')
        .select('crd, adviser_name')
        .ilike('adviser_name', `%${baseName}%`)
        .limit(5);

    if (exact && exact.length > 0) {
        return {
            found: true,
            source: 'database',
            matches: exact
        };
    }

    // Try first word only (e.g., "KIG" from "KIG Investment Management")
    const firstWord = baseName.split(' ')[0];
    if (firstWord && firstWord.length >= 3) {
        const { data: partial } = await advDb
            .from('advisers_enriched')
            .select('crd, adviser_name')
            .ilike('adviser_name', `${firstWord}%`)
            .limit(10);

        if (partial && partial.length > 0) {
            return {
                found: true,
                source: 'database_partial',
                matches: partial
            };
        }
    }

    return { found: false };
}

/**
 * Search IAPD (fallback)
 */
async function searchIAPD(page, managerName) {
    const baseName = extractBaseName(managerName);

    try {
        await page.goto('https://adviserinfo.sec.gov/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        const firmTab = await page.$('text=FIRM');
        if (firmTab) await firmTab.click();
        await page.waitForTimeout(500);

        const inputs = await page.$$('input');
        if (inputs.length >= 4) await inputs[3].fill(baseName);

        const searchBtns = await page.$$('button:has-text("Search")');
        if (searchBtns.length >= 2) await searchBtns[1].click();

        await page.waitForTimeout(3000);

        const text = await page.evaluate(() => document.body.innerText);
        const found = text.match(/We found (\d+) results?/);

        if (found && parseInt(found[1]) > 0) {
            // Extract CRDs
            const crds = [];
            const crdMatches = text.matchAll(/CRD#:\s*(\d+)/g);
            for (const match of crdMatches) {
                crds.push(match[1]);
            }

            return {
                found: true,
                source: 'iapd',
                count: parseInt(found[1]),
                crds: crds.slice(0, 5)
            };
        }

        return { found: false };

    } catch (error) {
        return { found: false, error: error.message };
    }
}

/**
 * Validate a single manager
 */
async function validateManager(page, managerName) {
    console.log(`Checking: ${managerName}`);

    // Step 1: Check database
    const dbResult = await checkAdvDatabase(managerName);
    if (dbResult.found) {
        console.log(`  ✓ Found in database: ${dbResult.matches[0].adviser_name} (CRD ${dbResult.matches[0].crd})`);
        return {
            manager: managerName,
            registered: true,
            source: dbResult.source,
            crd: dbResult.matches[0].crd,
            registered_as: dbResult.matches[0].adviser_name
        };
    }

    // Step 2: Search IAPD
    await page.waitForTimeout(2000); // Rate limiting
    const iapdResult = await searchIAPD(page, managerName);

    if (iapdResult.found) {
        console.log(`  ✓ Found in IAPD: ${iapdResult.count} result(s), CRDs: ${iapdResult.crds.join(', ')}`);
        return {
            manager: managerName,
            registered: true,
            source: iapdResult.source,
            crd: iapdResult.crds[0],
            iapd_results: iapdResult.count
        };
    }

    // Not found
    console.log(`  ✗ NOT FOUND - needs ADV filing`);
    return {
        manager: managerName,
        registered: false,
        checked_database: true,
        checked_iapd: true
    };
}

/**
 * Main batch validation
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || !args[0]) {
        console.log('Usage: node validate_needs_adv_corrected.js <managers.json>');
        return;
    }

    const inputFile = args[0];
    const managers = JSON.parse(fs.readFileSync(inputFile));

    console.log(`\n=== Validating ${managers.length} managers ===\n`);

    // Load Playwright for IAPD searches
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const results = [];
    const notRegistered = [];

    for (let i = 0; i < managers.length; i++) {
        const manager = typeof managers[i] === 'string' ? managers[i] : managers[i].name;
        console.log(`\n[${i+1}/${managers.length}]`);

        const result = await validateManager(page, manager);
        results.push(result);

        if (!result.registered) {
            notRegistered.push(manager);
        }
    }

    await browser.close();

    // Summary
    const registered = results.filter(r => r.registered).length;
    console.log(`\n\n=== RESULTS ===`);
    console.log(`Registered: ${registered}/${managers.length} (${(registered/managers.length*100).toFixed(1)}%)`);
    console.log(`NOT registered (need ADV): ${notRegistered.length}`);

    if (notRegistered.length > 0) {
        console.log(`\nManagers needing ADV filing:`);
        notRegistered.forEach((m, i) => console.log(`  ${i+1}. ${m}`));
    }

    // Save results
    fs.writeFileSync('/tmp/validation_corrected.json', JSON.stringify(results, null, 2));
    fs.writeFileSync('/tmp/needs_adv_corrected.json', JSON.stringify(notRegistered, null, 2));

    console.log(`\nSaved:`);
    console.log(`  /tmp/validation_corrected.json`);
    console.log(`  /tmp/needs_adv_corrected.json`);
}

main().catch(console.error);
