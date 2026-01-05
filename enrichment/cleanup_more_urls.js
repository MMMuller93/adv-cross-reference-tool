const { createClient } = require('@supabase/supabase-js');

const client = createClient(
  'https://ltdalxkhbbhmkimmogyq.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc'
);

// Additional bad domains to clean
const badDomains = [
  'wiley.com', 'springer.com', 'sciencedirect.com', 'researchgate.net',
  'privateequityinternational.com', 'preqin.com', 'anchin.com',
  'reddit.com', 'quora.com', 'ycombinator.com/companies',
  'youtube.com', 'vimeo.com', 'slideshare.com',
  'notablecap.com', 'signal.nfx.com', 'kando.tech', 'capedge.com',
  '13f.info', 'radientanalytics.com', 'research.secdatabase.com',
  'privatefunddata.com', 'finance.j16.io', 'gaebler.com',
  'whoisraisingmoney.com', 'plainsite.org', 'listcorp.com',
  // News/aggregators with article patterns
  'bizjournals.com', 'vcsheet.com', 'frontlines.io/podcast',
  'signatureblock.co/emerging', 'rogo.ai/news', 'edh.udel.edu',
  // More aggregator sites
  'vcpost.com', 'fundingpost.com', 'vcgate.com', 'vcnewsdaily.com',
  'vcelist.com', 'vcaonline.com', 'vcplatform.com',
  // Investor profile aggregators
  'investorsglobe.com', 'openvc.app', 'venturecapitaldirectory.com',
  'vcguide.co', 'vcwiki.co', 'thevcproject.com',
  // Law firm pages (not fund websites)
  'kjk.com/corporate-securities', 'cooley.com', 'wsgr.com/en/services'
];

async function cleanup() {
  const { data, error } = await client
    .from('enriched_managers')
    .select('id, series_master_llc, website_url')
    .not('website_url', 'is', null);

  if (error) {
    console.error('Error:', error.message);
    return;
  }

  console.log('Checking', data.length, 'records...\n');

  let cleaned = 0;
  for (const r of data) {
    const url = (r.website_url || '').toLowerCase();
    const shouldClean = badDomains.some(d => url.includes(d));

    if (shouldClean) {
      const { error: upErr } = await client
        .from('enriched_managers')
        .update({ website_url: null })
        .eq('id', r.id);

      if (!upErr) {
        cleaned++;
        console.log('Cleared:', r.series_master_llc.substring(0, 40), '|', r.website_url.substring(0, 50));
      }
    }
  }

  console.log('\nTotal cleaned:', cleaned);
}

cleanup()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
