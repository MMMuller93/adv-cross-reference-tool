#!/usr/bin/env node
/**
 * IAPD Search Validator using Playwright
 *
 * Validates manager names against SEC's IAPD (Investment Adviser Public Disclosure)
 * search page using browser automation.
 *
 * USE CASE:
 * After our local database matching finds potential "needs ADV" cases,
 * this script provides authoritative validation against SEC's live database.
 *
 * REQUIREMENTS:
 * - Playwright: npm install playwright
 * - Run: npx playwright install chromium (first time only)
 *
 * RATE LIMITING:
 * - Built-in delays between searches (2-5 seconds)
 * - Respects SEC infrastructure
 * - Don't run massively parallel
 *
 * Usage:
 *   node validate_iapd_playwright.js "Ulu Ventures"
 *   node validate_iapd_playwright.js --file candidates.json
 *   node validate_iapd_playwright.js --file candidates.json --output validated.json
 *
 * Created: 2026-01-07
 */

// Check if playwright is available
let playwright;
try {
    playwright = require('playwright');
} catch (e) {
    console.error('Playwright not installed. Run: npm install playwright');
    console.error('Then: npx playwright install chromium');
    process.exit(1);
}

const fs = require('fs');

const IAPD_SEARCH_URL = 'https://adviserinfo.sec.gov/search/genericsearch/firmgrid';
const DELAY_MIN_MS = 2000; // Minimum delay between searches
const DELAY_MAX_MS = 5000; // Maximum delay between searches

/**
 * Sleep for random duration
 */
function sleep(minMs, maxMs) {
    const duration = minMs + Math.random() * (maxMs - minMs);
    return new Promise(resolve => setTimeout(resolve, duration));
}

/**
 * Search IAPD for a firm name
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} firmName - Name to search
 * @returns {Promise<Array<{crd: string, name: string, city: string, state: string}>>}
 */
async function searchIAPD(page, firmName) {
    try {
        // Navigate to search page
        await page.goto(IAPD_SEARCH_URL, { waitUntil: 'networkidle' });

        // Wait for search input
        await page.waitForSelector('input[placeholder*="Search"]', { timeout: 10000 });

        // Clear and enter search term
        const searchInput = await page.$('input[placeholder*="Search"]');
        await searchInput.click({ clickCount: 3 }); // Select all
        await searchInput.type(firmName, { delay: 50 });

        // Click search button or press Enter
        await page.keyboard.press('Enter');

        // Wait for results to load
        await page.waitForTimeout(2000);

        // Check for results table
        const resultsExist = await page.$('.mat-table, .mat-row, table');

        if (!resultsExist) {
            // Check if "no results" message
            const noResults = await page.$eval('body', body => {
                const text = body.textContent.toLowerCase();
                return text.includes('no results') || text.includes('no matching');
            });

            if (noResults) {
                return [];
            }

            // May still be loading
            await page.waitForTimeout(2000);
        }

        // Extract results from table
        const results = await page.evaluate(() => {
            const rows = document.querySelectorAll('table tbody tr, .mat-row');
            const data = [];

            rows.forEach(row => {
                const cells = row.querySelectorAll('td, .mat-cell');
                if (cells.length >= 3) {
                    // Typical structure: Name, CRD, City, State, Status
                    const name = cells[0]?.textContent?.trim() || '';
                    const crd = cells[1]?.textContent?.trim() || '';
                    const cityState = cells[2]?.textContent?.trim() || '';

                    // Extract city/state if combined
                    let city = '', state = '';
                    if (cityState.includes(',')) {
                        [city, state] = cityState.split(',').map(s => s.trim());
                    } else {
                        city = cityState;
                    }

                    // Validate CRD is numeric
                    if (crd && /^\d+$/.test(crd)) {
                        data.push({ name, crd, city, state });
                    }
                }
            });

            return data;
        });

        return results;

    } catch (error) {
        console.error(`Error searching for "${firmName}":`, error.message);
        return [];
    }
}

/**
 * Validate a single firm
 */
async function validateFirm(page, firmName) {
    console.log(`\nSearching: "${firmName}"`);

    const results = await searchIAPD(page, firmName);

    if (results.length === 0) {
        console.log(`  -> No results found`);
        return {
            query: firmName,
            found: false,
            matches: []
        };
    }

    console.log(`  -> Found ${results.length} result(s):`);
    results.slice(0, 5).forEach((r, i) => {
        console.log(`     ${i + 1}. ${r.name} (CRD: ${r.crd}) - ${r.city}, ${r.state}`);
    });

    return {
        query: firmName,
        found: true,
        matches: results
    };
}

/**
 * Batch validate multiple firms
 */
async function batchValidate(firmNames, outputFile = null) {
    console.log(`\n=== IAPD Batch Validation ===`);
    console.log(`Firms to validate: ${firmNames.length}`);
    console.log(`Rate limit: ${DELAY_MIN_MS}-${DELAY_MAX_MS}ms between searches\n`);

    const browser = await playwright.chromium.launch({
        headless: true, // Set to false to see the browser
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });

    const page = await context.newPage();
    const results = [];

    try {
        for (let i = 0; i < firmNames.length; i++) {
            const firmName = firmNames[i];
            console.log(`\n[${i + 1}/${firmNames.length}]`);

            const result = await validateFirm(page, firmName);
            results.push(result);

            // Rate limiting
            if (i < firmNames.length - 1) {
                await sleep(DELAY_MIN_MS, DELAY_MAX_MS);
            }
        }
    } finally {
        await browser.close();
    }

    // Summary
    const found = results.filter(r => r.found).length;
    const notFound = results.filter(r => !r.found).length;

    console.log(`\n=== Summary ===`);
    console.log(`Found in IAPD: ${found}`);
    console.log(`Not found: ${notFound}`);

    // Save results
    if (outputFile) {
        fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
        console.log(`\nResults saved to: ${outputFile}`);
    }

    return results;
}

/**
 * Main entry point
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log(`
IAPD Search Validator

Usage:
  node validate_iapd_playwright.js "Firm Name"
  node validate_iapd_playwright.js --file input.json [--output output.json]

Input file format (JSON):
  ["Firm Name 1", "Firm Name 2", ...]
  or
  [{"name": "Firm Name 1"}, {"name": "Firm Name 2"}, ...]

Examples:
  node validate_iapd_playwright.js "Ulu Ventures"
  node validate_iapd_playwright.js --file candidates.json --output validated.json
        `);
        return;
    }

    // Parse arguments
    let firmNames = [];
    let outputFile = null;

    if (args.includes('--file')) {
        const fileIdx = args.indexOf('--file');
        const inputFile = args[fileIdx + 1];

        if (!inputFile || !fs.existsSync(inputFile)) {
            console.error(`Input file not found: ${inputFile}`);
            process.exit(1);
        }

        const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

        // Handle different input formats
        if (Array.isArray(data)) {
            firmNames = data.map(item => typeof item === 'string' ? item : item.name || item.manager_name || item.firm_name);
        } else {
            console.error('Input file must contain a JSON array');
            process.exit(1);
        }

        // Check for output file
        if (args.includes('--output')) {
            const outIdx = args.indexOf('--output');
            outputFile = args[outIdx + 1];
        }

    } else {
        // Single firm name from command line
        firmNames = [args.join(' ')];
    }

    // Filter empty names
    firmNames = firmNames.filter(n => n && n.trim());

    if (firmNames.length === 0) {
        console.error('No firm names to validate');
        process.exit(1);
    }

    // Run validation
    await batchValidate(firmNames, outputFile);
}

main().catch(console.error);
