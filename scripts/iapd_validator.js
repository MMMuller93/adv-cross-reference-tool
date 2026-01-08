#!/usr/bin/env node
/**
 * IAPD Validator - Search SEC's IAPD database for firm registration
 *
 * Usage:
 *   node iapd_validator.js "Firm Name"
 *   node iapd_validator.js --batch /tmp/candidates.json
 */

const { chromium } = require('playwright');
const fs = require('fs');

async function searchIAPD(page, firmName) {
    try {
        // Go to search page
        await page.goto('https://adviserinfo.sec.gov/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Click FIRM tab
        const firmTab = await page.$('text=FIRM');
        if (firmTab) await firmTab.click();
        await page.waitForTimeout(500);

        // Fill firm name (input index 3 is the FIRM name field)
        const inputs = await page.$$('input');
        if (inputs.length >= 4) {
            await inputs[3].fill(firmName);
        }

        // Click search button (second one is for FIRM section)
        const searchBtns = await page.$$('button:has-text("Search"), button:has-text("SEARCH")');
        if (searchBtns.length >= 2) {
            await searchBtns[1].click();
        }

        await page.waitForTimeout(4000);

        // Parse results
        const results = await page.evaluate(() => {
            const text = document.body.innerText;

            // Find "We found X results"
            const countMatch = text.match(/We found (\d+) results?/i);
            const count = countMatch ? parseInt(countMatch[1]) : 0;

            // Extract firm entries - look for "FIRM NAME ... CRD#: 123456"
            const firms = [];
            // Split by newlines and find lines with CRD
            const lines = text.split('\n');
            let currentFirm = null;

            for (const line of lines) {
                const crdMatch = line.match(/CRD#:\s*(\d+)/);
                if (crdMatch) {
                    // The firm name is usually in the previous collected text
                    if (currentFirm) {
                        firms.push({
                            name: currentFirm,
                            crd: crdMatch[1]
                        });
                    }
                    currentFirm = null;
                } else if (line.trim() && !line.includes('Investment Adviser') &&
                           !line.includes('Form ADV') && !line.includes('SEARCH') &&
                           !line.includes('City, State') && line.length > 3 && line.length < 100) {
                    // This might be a firm name
                    if (line.includes('LLC') || line.includes('LP') || line.includes('L.P.') ||
                        line.includes('INC') || line.includes('LTD') || line.includes('CORP') ||
                        line.match(/^[A-Z][A-Z\s,\.&'()-]+$/)) {
                        currentFirm = line.trim();
                    }
                }
            }

            return { count, firms: firms.slice(0, 10) };
        });

        return results;

    } catch (error) {
        return { count: 0, firms: [], error: error.message };
    }
}

async function validateFirms(firmNames) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox']
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });
    const page = await context.newPage();

    const results = [];

    for (let i = 0; i < firmNames.length; i++) {
        const firmName = firmNames[i];
        console.log(`[${i+1}/${firmNames.length}] Searching: ${firmName}`);

        const result = await searchIAPD(page, firmName);
        results.push({
            query: firmName,
            found: result.count > 0,
            count: result.count,
            matches: result.firms
        });

        if (result.count > 0) {
            console.log(`  ✓ Found ${result.count} result(s): ${result.firms.slice(0,2).map(f => f.name + ' (CRD ' + f.crd + ')').join(', ')}`);
        } else {
            console.log(`  ✗ No results found`);
        }

        // Rate limiting
        await page.waitForTimeout(2000);
    }

    await browser.close();
    return results;
}

// Main
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Usage: node iapd_validator.js "Firm Name"');
        console.log('       node iapd_validator.js --batch file.json');
        return;
    }

    let firmNames;

    if (args[0] === '--batch' && args[1]) {
        const data = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        firmNames = data.map(d => typeof d === 'string' ? d : d.name || d.entity_name || d.related_companies?.[0]);
        firmNames = firmNames.filter(Boolean).slice(0, 50); // Limit to 50 for safety
    } else {
        firmNames = [args.join(' ')];
    }

    console.log(`\nValidating ${firmNames.length} firm(s) against IAPD...\n`);

    const results = await validateFirms(firmNames);

    // Summary
    const found = results.filter(r => r.found).length;
    const notFound = results.filter(r => !r.found).length;

    console.log('\n=== Summary ===');
    console.log(`Registered (found in IAPD): ${found}`);
    console.log(`Not found: ${notFound}`);

    if (notFound > 0) {
        console.log('\nNot found:');
        results.filter(r => !r.found).forEach(r => console.log(`  - ${r.query}`));
    }

    // Save results
    const outputFile = '/tmp/iapd_validation_results.json';
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to: ${outputFile}`);
}

main().catch(console.error);
