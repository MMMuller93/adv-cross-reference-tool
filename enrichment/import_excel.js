/**
 * Import Existing Enriched Funds from Excel
 *
 * Reads venture_fund_contacts_comprehensive.xlsx and imports
 * the 150 manually enriched funds into the enriched_managers table.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const XLSX = require('xlsx');
const path = require('path');

// Supabase client (Form D database)
const FORMD_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1OTU5ODc1MywiZXhwIjoyMDc1MTc0NzUzfQ.YOUR_SERVICE_KEY_HERE';

const client = createClient(FORMD_URL, FORMD_KEY);

// Path to Excel file
const EXCEL_PATH = '/Users/Miles/Downloads/venture_fund_contacts_comprehensive.xlsx';

/**
 * Parse fund type from various formats
 */
function parseFundType(fundTypeStr) {
  if (!fundTypeStr) return 'Unknown';

  const normalized = fundTypeStr.toLowerCase();
  if (normalized.includes('vc') || normalized.includes('venture')) return 'VC';
  if (normalized.includes('pe') || normalized.includes('private equity')) return 'PE';
  if (normalized.includes('real estate') || normalized.includes('property')) return 'Real Estate';
  if (normalized.includes('hedge')) return 'Hedge Fund';
  if (normalized.includes('credit') || normalized.includes('debt')) return 'Credit';

  return fundTypeStr; // Return as-is if no match
}

/**
 * Parse investment stage
 */
function parseInvestmentStage(stageStr) {
  if (!stageStr) return null;
  return stageStr;
}

/**
 * Parse sectors array from various formats
 */
function parseSectors(sectorsStr) {
  if (!sectorsStr) return null;

  // If already array, return
  if (Array.isArray(sectorsStr)) return sectorsStr;

  // Split by common delimiters
  return sectorsStr.split(/[,;|]/).map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Import Excel data
 */
async function importExcelData() {
  console.log('[Import] Reading Excel file...');

  // Read Excel file
  const workbook = XLSX.readFile(EXCEL_PATH);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet);

  console.log(`[Import] Found ${data.length} rows in Excel file\n`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of data) {
    // Skip rows without fund name
    if (!row['Fund Name'] && !row['fund_name'] && !row['series_master_llc']) {
      skipped++;
      continue;
    }

    // Extract fund name (try various column names)
    const fundName = row['Fund Name'] || row['fund_name'] || row['series_master_llc'];

    // Check if already exists
    const { data: existing, error: checkError } = await client
      .from('enriched_managers')
      .select('id')
      .eq('series_master_llc', fundName)
      .single();

    if (existing) {
      console.log(`[Import] ⏭️  Skipping "${fundName}" - already exists`);
      skipped++;
      continue;
    }

    // Prepare enrichment data
    const enrichmentData = {
      series_master_llc: fundName,
      website_url: row['Website'] || row['website'] || row['website_url'] || null,
      fund_type: parseFundType(row['Fund Type'] || row['fund_type'] || row['fundType']),
      investment_stage: parseInvestmentStage(row['Investment Stage'] || row['investment_stage'] || row['investmentStage']),
      investment_sectors: parseSectors(row['Sectors'] || row['sectors'] || row['investment_sectors']),
      geography_focus: row['Geography'] || row['geography'] || row['geography_focus'] || null,
      headquarters_city: row['City'] || row['city'] || row['headquarters_city'] || null,
      headquarters_state: row['State'] || row['state'] || row['headquarters_state'] || null,
      primary_contact_email: row['Email'] || row['email'] || row['primary_contact_email'] || null,
      linkedin_company_url: row['LinkedIn'] || row['linkedin'] || row['linkedin_company_url'] || null,
      linked_crd: row['CRD'] || row['crd'] || row['linked_crd'] || null,
      enrichment_status: 'manually_verified',
      enrichment_source: 'excel_import',
      confidence_score: 1.0,
      is_published: true,
      has_form_adv: !!row['CRD'] || !!row['crd'],
      data_sources: ['manual_research'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      verified_at: new Date().toISOString()
    };

    // Insert into database
    try {
      const { data: insertedData, error: insertError } = await client
        .from('enriched_managers')
        .insert([enrichmentData])
        .select()
        .single();

      if (insertError) throw insertError;

      console.log(`[Import] ✓ Imported "${fundName}" - ${enrichmentData.fund_type}`);
      imported++;

      // If has team members, import those too (if columns exist)
      if (row['Team Members'] || row['team_members']) {
        const teamStr = row['Team Members'] || row['team_members'];
        const teamMembers = teamStr.split(';').map(t => t.trim()).filter(t => t.length > 0);

        for (const member of teamMembers) {
          const [name, title] = member.split('|').map(s => s.trim());
          if (name) {
            await client.from('enriched_team_members').insert([{
              manager_id: insertedData.id,
              name: name,
              title: title || 'Partner',
              is_key_person: true,
              created_at: new Date().toISOString()
            }]);
          }
        }
      }

    } catch (error) {
      console.error(`[Import] ❌ Error importing "${fundName}":`, error.message);
      errors++;
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log('\n=== IMPORT SUMMARY ===');
  console.log(`Total rows: ${data.length}`);
  console.log(`Imported: ${imported}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
}

// Run import
importExcelData()
  .then(() => {
    console.log('\n✓ Import complete!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Import failed:', error);
    process.exit(1);
  });
