/**
 * RE-ENRICHMENT SCRIPT FOR LINKEDIN URLS
 *
 * Targets managers that were previously enriched but are missing LinkedIn URLs.
 * Uses the improved v2 engine that extracts LinkedIn directly from website HTML.
 *
 * Usage:
 *   node reenrich_linkedin.js              # Process 50 managers (default)
 *   node reenrich_linkedin.js 100          # Process 100 managers
 *   node reenrich_linkedin.js --dry-run    # Preview what would be processed
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { extractLinkedInFromWebsite, extractCompanyLinkedInFromProfile } = require('./enrichment_engine_v2');

// Database connection
const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const formdClient = createClient(FORMD_URL, FORMD_KEY);

const LIMIT = parseInt(process.argv.find(a => /^\d+$/.test(a))) || 50;
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 1500; // 1.5 seconds between requests

async function getManagersNeedingLinkedIn(limit) {
  console.log(`[Query] Finding up to ${limit} managers with website but no LinkedIn...`);

  const { data, error } = await formdClient
    .from('enriched_managers')
    .select('id, series_master_llc, website_url, linkedin_company_url, team_members')
    .is('linkedin_company_url', null)
    .not('website_url', 'is', null)
    .limit(limit);

  if (error) {
    console.error('[Query] Error:', error.message);
    return [];
  }

  console.log(`[Query] Found ${data.length} managers to process`);
  return data;
}

async function processManager(manager) {
  console.log(`\n[Process] ${manager.series_master_llc}`);
  console.log(`          Website: ${manager.website_url}`);

  // Extract LinkedIn URLs from website
  const linkedInData = await extractLinkedInFromWebsite(manager.website_url);

  let companyLinkedIn = linkedInData.companyUrl;
  const teamLinkedIns = linkedInData.teamLinkedIns;

  console.log(`          Found company LinkedIn: ${companyLinkedIn || 'none'}`);
  console.log(`          Found team LinkedIns: ${teamLinkedIns.length}`);

  // If no company LinkedIn but we have team members, try to extract from their profile
  if (!companyLinkedIn && teamLinkedIns.length > 0) {
    console.log(`          Trying to extract company from team member profile...`);
    companyLinkedIn = await extractCompanyLinkedInFromProfile(teamLinkedIns[0].url);
    if (companyLinkedIn) {
      console.log(`          Found via team member: ${companyLinkedIn}`);
    }
  }

  // Prepare updates
  const updates = {};

  if (companyLinkedIn) {
    updates.linkedin_company_url = companyLinkedIn;
  }

  // Merge team LinkedIn URLs with existing team members
  if (teamLinkedIns.length > 0) {
    const existingTeam = manager.team_members || [];
    const updatedTeam = [...existingTeam];

    for (const linkedInPerson of teamLinkedIns) {
      const username = linkedInPerson.url.split('/in/')[1]?.toLowerCase();
      const existing = updatedTeam.find(m =>
        m.linkedin?.toLowerCase().includes(username)
      );

      if (!existing && linkedInPerson.name) {
        updatedTeam.push({
          name: linkedInPerson.name,
          title: null,
          email: null,
          linkedin: linkedInPerson.url
        });
      } else if (existing && !existing.linkedin) {
        existing.linkedin = linkedInPerson.url;
      }
    }

    if (updatedTeam.length !== existingTeam.length) {
      updates.team_members = updatedTeam;
      console.log(`          Updated team: ${existingTeam.length} -> ${updatedTeam.length} members`);
    }
  }

  // Update data sources if we found something new
  if (Object.keys(updates).length > 0) {
    if (updates.linkedin_company_url) {
      updates.data_sources = [...new Set([...(manager.data_sources || []), 'linkedin'])];
    }
    updates.enrichment_date = new Date().toISOString();
  }

  return updates;
}

async function main() {
  console.log('='.repeat(80));
  console.log('RE-ENRICHMENT: LinkedIn URL Extraction');
  console.log('='.repeat(80));
  console.log();
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`Target: ${LIMIT} managers`);
  console.log();

  const managers = await getManagersNeedingLinkedIn(LIMIT);

  if (managers.length === 0) {
    console.log('No managers need LinkedIn re-enrichment!');
    return;
  }

  const results = {
    updated: 0,
    linkedInFound: 0,
    teamUpdated: 0,
    skipped: 0,
    errors: 0
  };

  for (let i = 0; i < managers.length; i++) {
    const manager = managers[i];
    const progress = `[${i + 1}/${managers.length}]`;

    try {
      console.log(`\n${progress} Processing: ${manager.series_master_llc}`);

      const updates = await processManager(manager);

      if (Object.keys(updates).length === 0) {
        console.log(`  ⏭️  No new data found`);
        results.skipped++;
        continue;
      }

      if (updates.linkedin_company_url) {
        results.linkedInFound++;
        console.log(`  ✅ LinkedIn: ${updates.linkedin_company_url}`);
      }

      if (updates.team_members) {
        results.teamUpdated++;
        console.log(`  ✅ Team members updated`);
      }

      if (!DRY_RUN) {
        const { error } = await formdClient
          .from('enriched_managers')
          .update(updates)
          .eq('id', manager.id);

        if (error) {
          console.error(`  ❌ Save error: ${error.message}`);
          results.errors++;
          continue;
        }
        console.log(`  💾 Saved to database`);
      } else {
        console.log(`  🔍 DRY RUN - would update with:`, JSON.stringify(updates, null, 2));
      }

      results.updated++;

      // Rate limiting
      if (i < managers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }

    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      results.errors++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('RE-ENRICHMENT COMPLETE');
  console.log('='.repeat(80));
  console.log();
  console.log(`  ✅ Updated: ${results.updated}`);
  console.log(`  🔗 LinkedIn found: ${results.linkedInFound}`);
  console.log(`  👥 Team updated: ${results.teamUpdated}`);
  console.log(`  ⏭️  Skipped (no data): ${results.skipped}`);
  console.log(`  ❌ Errors: ${results.errors}`);
  console.log(`\nTotal processed: ${managers.length}`);

  if (DRY_RUN) {
    console.log('\n⚠️  This was a DRY RUN. Run without --dry-run to save changes.');
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
