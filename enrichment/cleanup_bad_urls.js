/**
 * CLEANUP BAD WEBSITE URLs
 * Removes aggregator URLs that were mistakenly saved as manager websites
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const client = createClient(SUPABASE_URL, SUPABASE_KEY);

// Bad URL patterns - these are NOT manager websites
const badPatterns = [
  'formds.com',
  'disclosurequest.com',
  'aum13f.com',
  'whalewisdom.com',
  'fundz.net',
  'sec.gov',
  'sec.report',
  'advfn.com',
  'venture.angellist.com',
  'crowdfundinsider.com'
];

async function cleanupBadUrls() {
  console.log('='.repeat(60));
  console.log('CLEANING UP BAD WEBSITE URLs');
  console.log('='.repeat(60));

  for (const pattern of badPatterns) {
    console.log(`\nChecking for ${pattern}...`);

    // Find records with this pattern
    const { data: records, error: fetchError } = await client
      .from('enriched_managers')
      .select('id, series_master_llc, website_url')
      .ilike('website_url', `%${pattern}%`);

    if (fetchError) {
      console.error(`  Error fetching: ${fetchError.message}`);
      continue;
    }

    if (!records || records.length === 0) {
      console.log(`  No records found`);
      continue;
    }

    console.log(`  Found ${records.length} records with ${pattern}`);

    // Update each record to null out the bad URL
    for (const record of records) {
      const { error: updateError } = await client
        .from('enriched_managers')
        .update({ website_url: null })
        .eq('id', record.id);

      if (updateError) {
        console.error(`  Failed to update ${record.series_master_llc}: ${updateError.message}`);
      } else {
        console.log(`  ✓ Cleared URL for: ${record.series_master_llc}`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('CLEANUP COMPLETE');
  console.log('='.repeat(60));
}

cleanupBadUrls()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
