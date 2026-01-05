/**
 * Export enriched managers with contact info to CSV
 */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const client = createClient(
  'https://ltdalxkhbbhmkimmogyq.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc'
);

async function exportCSV() {
  // First get the columns
  const { data: sampleData } = await client.from('enriched_managers').select('*').limit(1);
  if (sampleData && sampleData.length > 0) {
    console.log('Available columns:', Object.keys(sampleData[0]).join(', '));
  }

  const { data, error } = await client
    .from('enriched_managers')
    .select('series_master_llc, website_url, linkedin_company_url, fund_type, investment_stage, confidence_score, enrichment_status')
    .or('website_url.not.is.null,linkedin_company_url.not.is.null')
    .order('confidence_score', { ascending: false, nullsFirst: false });

  if (error) {
    console.error('Error:', error);
    return;
  }

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const headers = ['Manager Name', 'Website', 'LinkedIn', 'Fund Type', 'Investment Stage', 'Confidence', 'Status'];
  const rows = data.map(r => [
    escapeCsv(r.series_master_llc),
    escapeCsv(r.website_url),
    escapeCsv(r.linkedin_company_url),
    escapeCsv(r.fund_type),
    escapeCsv(r.investment_stage),
    r.confidence_score ? r.confidence_score.toFixed(2) : '',
    escapeCsv(r.enrichment_status)
  ].join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  const outputPath = '/Users/Miles/Desktop/ADV Info/new_managers_contact_info.csv';
  fs.writeFileSync(outputPath, csv);

  console.log('=' .repeat(60));
  console.log('CSV EXPORT COMPLETE');
  console.log('='.repeat(60));
  console.log('Exported', data.length, 'managers with contact info');
  console.log('File:', outputPath);
  console.log('\nSample records:');
  data.slice(0, 15).forEach(r => {
    const name = (r.series_master_llc || '').substring(0, 30).padEnd(30);
    const url = r.website_url ? r.website_url.substring(0, 40) : '(no website)';
    console.log(`  ${name} | ${url}`);
  });
}

exportCSV()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
