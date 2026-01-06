/**
 * CLEANUP BAD URLS
 *
 * Finds and fixes enriched managers with bad website URLs (PDFs, documents, etc)
 * Sets their website_url to null and marks them for re-enrichment.
 *
 * Usage:
 *   node cleanup_bad_urls.js              # Dry run - show what would be fixed
 *   node cleanup_bad_urls.js --fix        # Actually fix the records
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const formdClient = createClient(FORMD_URL, FORMD_KEY);

const DRY_RUN = !process.argv.includes('--fix');

// Bad URL patterns
const BAD_PATTERNS = [
  // File extensions
  /\.pdf$/i,
  /\.doc$/i,
  /\.docx$/i,
  /\.xls$/i,
  /\.xlsx$/i,
  /\.ppt$/i,
  /\.pptx$/i,
  /\.zip$/i,
  /\.csv$/i,
  // Document paths
  /\/files\//i,
  /\/documents\//i,
  /\/uploads\//i,
  /\/download\//i,
  /\/attachments\//i,
  /\/sites\/default\/files\//i,
  // Deep article-like paths
  /\/news\/\d{4}\//i,
  /\/article\/\d+/i,
  // Social media (should be extracted separately, not as website)
  /^https?:\/\/(www\.)?linkedin\.com/i,
  /^https?:\/\/(www\.)?twitter\.com/i,
  /^https?:\/\/(www\.)?x\.com/i,
  /^https?:\/\/(www\.)?facebook\.com/i,
];

function isBadUrl(url) {
  if (!url) return false;
  return BAD_PATTERNS.some(pattern => pattern.test(url));
}

async function main() {
  console.log('='.repeat(80));
  console.log('CLEANUP BAD URLS');
  console.log('='.repeat(80));
  console.log();
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (use --fix to make changes)' : 'LIVE - Making changes'}`);
  console.log();

  // Fetch all managers with website URLs
  console.log('Fetching managers with website URLs...');

  const { data: managers, error } = await formdClient
    .from('enriched_managers')
    .select('id, series_master_llc, website_url, enrichment_status')
    .not('website_url', 'is', null);

  if (error) {
    console.error('Error fetching managers:', error.message);
    return;
  }

  console.log(`Found ${managers.length} managers with website URLs`);
  console.log();

  // Find bad URLs
  const badManagers = managers.filter(m => isBadUrl(m.website_url));

  if (badManagers.length === 0) {
    console.log('No bad URLs found!');
    return;
  }

  console.log(`Found ${badManagers.length} managers with bad URLs:\n`);

  for (const manager of badManagers) {
    console.log(`${manager.series_master_llc}`);
    console.log(`   URL: ${manager.website_url}`);
    console.log(`   Status: ${manager.enrichment_status}`);

    if (!DRY_RUN) {
      // Clear the bad URL and mark for re-enrichment
      const { error: updateError } = await formdClient
        .from('enriched_managers')
        .update({
          website_url: null,
          enrichment_status: 'needs_manual_review',
          flagged_issues: ['bad_url_cleared']
        })
        .eq('id', manager.id);

      if (updateError) {
        console.log(`   Failed to update: ${updateError.message}`);
      } else {
        console.log(`   Fixed - URL cleared`);
      }
    }
    console.log();
  }

  console.log('='.repeat(80));
  console.log(`Total bad URLs: ${badManagers.length}`);

  if (DRY_RUN) {
    console.log('\nThis was a dry run. Use --fix to actually fix these records.');
  } else {
    console.log('\nAll bad URLs have been cleared.');
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
