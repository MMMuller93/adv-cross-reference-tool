/**
 * Export enriched managers with FULL data including Form D filing info
 * Includes: filing dates, offering amounts, related parties, exemptions, SEC links
 */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const client = createClient(
  'https://ltdalxkhbbhmkimmogyq.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc'
);

async function exportFullCSV() {
  console.log('Fetching enriched managers...');

  // Get all enriched managers
  const { data: managers, error: mgrError } = await client
    .from('enriched_managers')
    .select('*')
    .or('website_url.not.is.null,linkedin_company_url.not.is.null')
    .order('confidence_score', { ascending: false, nullsFirst: false });

  if (mgrError) {
    console.error('Error fetching managers:', mgrError);
    return;
  }

  console.log(`Found ${managers.length} managers with contact info`);
  console.log('Fetching Form D filings for each manager...');

  // For each manager, find their Form D filings
  const seriesPattern = /,?\s+a\s+series\s+of\s+(.+?)(?:\s*,?\s*$|$)/i;

  // Fetch ALL Form D filings with "a series of" pattern using keyset pagination
  const allFilings = [];
  let lastId = 999999999; // Start high
  let totalScanned = 0;

  console.log('Fetching ALL Form D filings with series pattern...');

  while (true) {
    const { data: batch, error } = await client
      .from('form_d_filings')
      .select('id, entityname, filing_date, totalofferingamount, totalamountsold, investmentfundtype, federalexemptions_items_list, cik, accessionnumber, related_names, related_roles')
      .lt('id', lastId)
      .order('id', { ascending: false })
      .limit(1000);

    if (error) {
      console.error('Error fetching filings:', error.message);
      break;
    }
    if (!batch || batch.length === 0) break;

    totalScanned += batch.length;

    // Filter for "a series of" pattern in JS (much faster than ILIKE)
    const seriesFilings = batch.filter(f =>
      f.entityname && f.entityname.toLowerCase().includes('a series of')
    );
    allFilings.push(...seriesFilings);

    lastId = batch[batch.length - 1].id;

    if (totalScanned % 10000 === 0) {
      console.log(`  Scanned ${totalScanned} filings, found ${allFilings.length} series filings...`);
    }

    if (batch.length < 1000) break;
  }

  console.log(`Scanned ${totalScanned} total filings, found ${allFilings.length} with series pattern`);

  // Group filings by series master
  const filingsByMaster = {};
  for (const filing of allFilings) {
    const match = (filing.entityname || '').match(seriesPattern);
    if (match) {
      const masterName = match[1].trim().toLowerCase();
      if (!filingsByMaster[masterName]) {
        filingsByMaster[masterName] = [];
      }
      filingsByMaster[masterName].push(filing);
    }
  }

  // Build enriched rows
  const rows = [];

  for (const mgr of managers) {
    const masterKey = (mgr.series_master_llc || '').toLowerCase();
    const filings = filingsByMaster[masterKey] || [];

    // Sort filings by date (earliest first)
    filings.sort((a, b) => new Date(a.filing_date) - new Date(b.filing_date));

    const firstFiling = filings[0];
    const latestFiling = filings[filings.length - 1];

    // Calculate total offering and sold across all filings
    let totalOffering = 0;
    let totalSold = 0;
    const allRelatedParties = new Set();
    const allExemptions = new Set();
    const allCiks = new Set();

    for (const f of filings) {
      if (f.totalofferingamount) totalOffering += parseFloat(f.totalofferingamount) || 0;
      if (f.totalamountsold) totalSold += parseFloat(f.totalamountsold) || 0;

      // Collect related parties
      if (f.related_names && f.related_roles) {
        const names = f.related_names.split('|');
        const roles = f.related_roles.split('|');
        for (let i = 0; i < names.length && i < roles.length; i++) {
          if (names[i] && roles[i]) {
            allRelatedParties.add(`${names[i].trim()} (${roles[i].trim()})`);
          }
        }
      }

      // Collect exemptions
      if (f.federalexemptions_items_list) {
        f.federalexemptions_items_list.split(',').forEach(ex => {
          if (ex.trim()) allExemptions.add(ex.trim());
        });
      }

      // Collect CIKs for SEC links
      if (f.cik) allCiks.add(f.cik);
    }

    // Build SEC link (using first CIK)
    const cik = Array.from(allCiks)[0];
    const secLink = cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=D&dateb=&owner=include&count=40` : '';

    // Parse team members if available
    let teamMembersStr = '';
    if (mgr.team_members) {
      try {
        const team = typeof mgr.team_members === 'string' ? JSON.parse(mgr.team_members) : mgr.team_members;
        if (Array.isArray(team)) {
          teamMembersStr = team.map(t => `${t.name}${t.title ? ' - ' + t.title : ''}`).join('; ');
        }
      } catch (e) {
        teamMembersStr = '';
      }
    }

    rows.push({
      manager_name: mgr.series_master_llc,
      website: mgr.website_url || '',
      linkedin: mgr.linkedin_company_url || '',
      first_filing_date: firstFiling?.filing_date || '',
      latest_filing_date: latestFiling?.filing_date || '',
      fund_count: filings.length,
      total_offering: totalOffering > 0 ? totalOffering : '',
      total_sold: totalSold > 0 ? totalSold : '',
      fund_type: mgr.fund_type || firstFiling?.investmentfundtype || '',
      exemptions: Array.from(allExemptions).join(', '),
      related_parties: Array.from(allRelatedParties).slice(0, 10).join('; '), // Limit to 10
      team_members: teamMembersStr,
      investment_stage: mgr.investment_stage || '',
      investment_sectors: mgr.investment_sectors || '',
      geography: mgr.geography_focus || '',
      headquarters: [mgr.headquarters_city, mgr.headquarters_state, mgr.headquarters_country].filter(Boolean).join(', '),
      email: mgr.primary_contact_email || '',
      phone: mgr.phone_number || '',
      sec_filings_link: secLink,
      confidence: mgr.confidence_score ? mgr.confidence_score.toFixed(2) : '',
      status: mgr.enrichment_status
    });
  }

  // Generate CSV
  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes(';')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const headers = [
    'Manager Name',
    'Website',
    'LinkedIn',
    'First Filing Date',
    'Latest Filing Date',
    'Fund Count',
    'Total Offering ($)',
    'Total Sold ($)',
    'Fund Type',
    'Exemptions',
    'Related Parties',
    'Team Members',
    'Investment Stage',
    'Investment Sectors',
    'Geography',
    'Headquarters',
    'Email',
    'Phone',
    'SEC Filings Link',
    'Confidence',
    'Status'
  ];

  const csvRows = rows.map(r => [
    escapeCsv(r.manager_name),
    escapeCsv(r.website),
    escapeCsv(r.linkedin),
    escapeCsv(r.first_filing_date),
    escapeCsv(r.latest_filing_date),
    r.fund_count,
    r.total_offering ? Math.round(r.total_offering) : '',
    r.total_sold ? Math.round(r.total_sold) : '',
    escapeCsv(r.fund_type),
    escapeCsv(r.exemptions),
    escapeCsv(r.related_parties),
    escapeCsv(r.team_members),
    escapeCsv(r.investment_stage),
    escapeCsv(r.investment_sectors),
    escapeCsv(r.geography),
    escapeCsv(r.headquarters),
    escapeCsv(r.email),
    escapeCsv(r.phone),
    escapeCsv(r.sec_filings_link),
    r.confidence,
    escapeCsv(r.status)
  ].join(','));

  const csv = [headers.join(','), ...csvRows].join('\n');
  const outputPath = '/Users/Miles/Desktop/ADV Info/new_managers_full_info.csv';
  fs.writeFileSync(outputPath, csv);

  console.log('\n' + '='.repeat(60));
  console.log('FULL CSV EXPORT COMPLETE');
  console.log('='.repeat(60));
  console.log(`Exported ${rows.length} managers`);
  console.log(`File: ${outputPath}`);
  console.log('\nSample records:');

  rows.slice(0, 5).forEach(r => {
    console.log(`\n  ${r.manager_name}`);
    console.log(`    Website: ${r.website || '(none)'}`);
    console.log(`    First Filing: ${r.first_filing_date || 'N/A'}`);
    console.log(`    Funds: ${r.fund_count}`);
    if (r.total_offering) console.log(`    Offering: $${r.total_offering.toLocaleString()}`);
    if (r.related_parties) console.log(`    Parties: ${r.related_parties.substring(0, 80)}...`);
    if (r.sec_filings_link) console.log(`    SEC: ${r.sec_filings_link}`);
  });
}

exportFullCSV()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
