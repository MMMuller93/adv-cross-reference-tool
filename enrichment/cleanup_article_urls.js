/**
 * CLEANUP ARTICLE URLs
 * Removes news article URLs that were mistakenly saved as manager websites
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const client = createClient(SUPABASE_URL, SUPABASE_KEY);

// URL patterns that indicate news articles (not fund websites)
const articlePatterns = [
  '/news/', '/news-', '/article/', '/articles/', '/blog/', '/blogs/',
  '/press/', '/press-release/', '/pressrelease/', '/media/',
  '/story/', '/stories/', '/post/', '/posts/', '/view/',
  '/2024/', '/2025/', '/2023/', '/2022/', '/2021/', '/2020/',
  '/category/', '/tag/', '/topics/'
];

// Additional bad domains
const badDomains = [
  'kresge.org', 'forbes.com', 'wsj.com', 'nytimes.com', 'reuters.com',
  'techcrunch.com', 'venturebeat.com', 'axios.com', 'fortune.com',
  'inc.com', 'entrepreneur.com', 'fastcompany.com', 'wired.com',
  'medium.com', 'substack.com', 'twitter.com', 'x.com', 'facebook.com',
  'wikipedia.org', 'prnewswire.com', 'businesswire.com',
  'philanthropy.com', 'gatesfoundation.org', 'fordfoundation.org'
];

async function cleanupArticleUrls() {
  console.log('='.repeat(60));
  console.log('CLEANING UP ARTICLE URLs FROM WEBSITE FIELD');
  console.log('='.repeat(60));

  // Get all records with website_url
  const { data: records, error: fetchError } = await client
    .from('enriched_managers')
    .select('id, series_master_llc, website_url')
    .not('website_url', 'is', null);

  if (fetchError) {
    console.error('Error fetching records:', fetchError.message);
    return;
  }

  console.log(`\nFound ${records.length} records with website URLs`);

  let cleanedCount = 0;
  const cleaned = [];

  for (const record of records) {
    const url = record.website_url.toLowerCase();
    let shouldClean = false;
    let reason = '';

    // Check for article patterns in URL path
    for (const pattern of articlePatterns) {
      if (url.includes(pattern)) {
        shouldClean = true;
        reason = `URL contains article pattern: ${pattern}`;
        break;
      }
    }

    // Check for bad domains
    if (!shouldClean) {
      for (const domain of badDomains) {
        if (url.includes(domain)) {
          shouldClean = true;
          reason = `URL is from news/media domain: ${domain}`;
          break;
        }
      }
    }

    // Check for very long URLs (usually articles)
    if (!shouldClean) {
      try {
        const parsed = new URL(record.website_url);
        const pathSegments = parsed.pathname.split('/').filter(s => s);
        if (pathSegments.length > 3) {
          shouldClean = true;
          reason = `URL has too many path segments (${pathSegments.length}) - likely article`;
        } else if (pathSegments.some(seg => seg.length > 50)) {
          shouldClean = true;
          reason = `URL has very long slug - likely article`;
        }
      } catch (e) {
        // Invalid URL, leave it
      }
    }

    if (shouldClean) {
      const { error: updateError } = await client
        .from('enriched_managers')
        .update({ website_url: null })
        .eq('id', record.id);

      if (updateError) {
        console.error(`  Failed to update ${record.series_master_llc}: ${updateError.message}`);
      } else {
        cleanedCount++;
        cleaned.push({
          name: record.series_master_llc,
          url: record.website_url,
          reason
        });
        console.log(`  ✓ Cleared: ${record.series_master_llc}`);
        console.log(`    Was: ${record.website_url.substring(0, 80)}...`);
        console.log(`    Reason: ${reason}`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('CLEANUP COMPLETE');
  console.log('='.repeat(60));
  console.log(`\nCleared ${cleanedCount} article URLs from ${records.length} total records`);

  if (cleaned.length > 0) {
    console.log('\nCleaned records:');
    cleaned.forEach((c, i) => {
      console.log(`${i + 1}. ${c.name}`);
    });
  }
}

cleanupArticleUrls()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
