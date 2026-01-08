#!/usr/bin/env node
/**
 * Find managers that truly need to file Form ADV
 *
 * Approach:
 * 1. Get Form D filings not in cross_reference_matches
 * 2. Extract the SPECIFIC manager/GP entity for each fund
 * 3. Check if THAT SPECIFIC ENTITY is registered in IAPD
 * 4. If not found → needs ADV filing
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const FORMD_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';
const formDDb = createClient(FORMD_URL, FORMD_KEY);

/**
 * Extract manager entity from Form D filing
 */
function extractManagerEntity(filing) {
    const candidates = [];

    // 1. Check for GP entity in related_names
    if (filing.related_names) {
        const names = filing.related_names.split('|').map(n => n.trim().replace(/^[-\s]+/, ''));
        const roles = filing.related_roles ? filing.related_roles.split('|').map(r => r.trim()) : [];

        names.forEach((name, i) => {
            const role = roles[i] || '';

            // Look for GP, Manager, or Adviser entities (must be a company, not a person)
            const hasCompanySuffix = /\b(LLC|L\.?L\.?C\.?|LP|L\.?P\.?|LTD|LIMITED|INC|INCORPORATED)\b/i.test(name);
            const hasManagerKeyword = /(GP|General Partner|Management|Manager|Advisor|Adviser)/i.test(name);

            if (hasCompanySuffix && hasManagerKeyword) {
                candidates.push({
                    name: name,
                    source: 'related_names',
                    role: role,
                    priority: role.toLowerCase().includes('executive officer') ? 1 : 2
                });
            }
        });
    }

    // 2. Check for series pattern: "Fund A, a series of Manager LLC"
    if (filing.entityname) {
        const seriesMatch = filing.entityname.match(/,?\s+a\s+series\s+of\s+(.+)$/i);
        if (seriesMatch) {
            candidates.push({
                name: seriesMatch[1].trim(),
                source: 'series_pattern',
                priority: 1
            });
        }
    }

    // Sort by priority and return best candidate
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0] || null;
}

async function main() {
    console.log('Finding managers that need to file Form ADV...\n');

    // Step 1: Get matched accessions
    console.log('Loading matched accessions...');
    const matched = new Set();
    let offset = 0;

    while (offset < 200000) {
        const { data } = await formDDb
            .from('cross_reference_matches')
            .select('formd_accession')
            .range(offset, offset + 999);

        if (!data || data.length === 0) break;
        data.forEach(m => { if (m.formd_accession) matched.add(m.formd_accession); });
        offset += 1000;
        if (data.length < 1000) break;
    }
    console.log(`  ${matched.size} matched accessions\n`);

    // Step 2: Get unmatched filings
    console.log('Loading unmatched Form D filings...');
    const unmatched = [];
    offset = 0;
    const now = Date.now();

    while (offset < 10000) {  // Limit to first 10k for now
        const { data: filings } = await formDDb
            .from('form_d_filings')
            .select('accessionnumber, cik, entityname, filing_date, totalofferingamount, related_names, related_roles')
            .range(offset, offset + 999);

        if (!filings || filings.length === 0) break;

        for (const f of filings) {
            if (matched.has(f.accessionnumber)) continue;

            const days = Math.floor((now - new Date(f.filing_date).getTime()) / (1000*60*60*24));
            if (days > 60) {
                unmatched.push(f);
            }
        }

        offset += 1000;
        if (filings.length < 1000) break;
    }
    console.log(`  ${unmatched.length} unmatched filings (past 60 day grace period)\n`);

    // Step 3: Extract manager entities
    console.log('Extracting manager entities...');
    const managerMap = new Map(); // manager_name -> filings[]

    for (const filing of unmatched) {
        const manager = extractManagerEntity(filing);

        if (manager) {
            if (!managerMap.has(manager.name)) {
                managerMap.set(manager.name, {
                    name: manager.name,
                    source: manager.source,
                    filings: [],
                    total_offering: 0
                });
            }

            const entry = managerMap.get(manager.name);
            entry.filings.push({
                entity_name: filing.entityname,
                cik: filing.cik,
                filing_date: filing.filing_date,
                offering_amount: filing.totalofferingamount
            });

            if (filing.totalofferingamount && !isNaN(filing.totalofferingamount)) {
                entry.total_offering += parseFloat(filing.totalofferingamount);
            }
        }
    }

    console.log(`  ${managerMap.size} unique manager entities\n`);

    // Step 4: Export for validation
    const managersToCheck = Array.from(managerMap.values())
        .sort((a, b) => b.total_offering - a.total_offering)
        .slice(0, 200);  // Top 200 by offering amount

    // Save manager names for IAPD validation
    const managerNames = managersToCheck.map(m => m.name);
    fs.writeFileSync('/tmp/managers_to_validate.json', JSON.stringify(managerNames, null, 2));

    // Save full details
    fs.writeFileSync('/tmp/manager_details.json', JSON.stringify(managersToCheck, null, 2));

    console.log('=== Top 30 Manager Entities to Validate ===\n');
    managersToCheck.slice(0, 30).forEach((m, i) => {
        const amt = m.total_offering > 0 ? '$' + (m.total_offering/1000000).toFixed(1) + 'M' : 'N/A';
        console.log(`${i+1}. ${m.name}`);
        console.log(`   Funds: ${m.filings.length} | Total: ${amt} | Source: ${m.source}`);
    });

    console.log(`\n✓ Saved ${managerNames.length} manager names to /tmp/managers_to_validate.json`);
    console.log('✓ Saved details to /tmp/manager_details.json\n');
    console.log('Next: Run IAPD validation:');
    console.log('  node scripts/iapd_validator.js --batch /tmp/managers_to_validate.json');
}

main().catch(console.error);
