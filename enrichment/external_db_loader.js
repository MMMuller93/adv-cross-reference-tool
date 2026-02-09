/**
 * EXTERNAL INVESTOR DATABASE LOADER
 *
 * Parses OpenVC + Ramp CSV databases and upserts into Supabase
 * external_investor_reference table (Form D DB).
 *
 * Usage:
 *   node enrichment/external_db_loader.js import          # Full import
 *   node enrichment/external_db_loader.js import --dry-run # Parse only, no DB writes
 *   node enrichment/external_db_loader.js verify           # Check table exists + row count
 *
 * CSV Sources:
 *   - OpenVC: data-pipeline/external_dbs/openvc_investors.csv (header row, 9 cols)
 *   - Ramp:   data-pipeline/external_dbs/ramp_investors.csv   (no header, 18 cols)
 *
 * Merge Strategy:
 *   - Deduplicate on normalized_name
 *   - Ramp wins for: email, LinkedIn, Twitter, portfolio, contact_name
 *   - OpenVC wins for: check_size, thesis, countries_of_investment
 *   - Both: investor_type, website (first non-empty wins)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// Form D database (where external_investor_reference lives)
const FORMD_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const formdClient = createClient(FORMD_URL, FORMD_KEY);

const BATCH_SIZE = 500;

// ============================================================================
// NAME NORMALIZATION
// ============================================================================

// Only strip legal entity type suffixes — business descriptors (capital, ventures,
// partners, management, etc.) are DISTINCTIVE and must be preserved to prevent
// false matches like "Backbone Capital" colliding with "Backbone Ventures".
const STRIP_SUFFIXES = /\b(llc|lp|ltd|inc|corp|corporation|company|co|limited|partnership|pllc|plc|sa|ag|gmbh|bv|nv)\b/gi;
const STRIP_ROMAN = /\b(i{1,3}|iv|v|vi{0,3}|ix|x|xi{0,3})\b$/i;

function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')  // Remove non-alphanumeric
    .replace(STRIP_SUFFIXES, ' ')   // Remove legal/business suffixes
    .replace(STRIP_ROMAN, ' ')      // Remove trailing roman numerals
    .replace(/\s+/g, ' ')           // Collapse whitespace
    .trim();
}

// ============================================================================
// CSV PARSING
// ============================================================================

/**
 * Parse CSV respecting quoted fields with embedded commas/newlines.
 * Returns array of string arrays (rows of fields).
 */
function parseCSV(content) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        currentRow.push(currentField.trim());
        if (currentRow.some(f => f !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = '';
        if (ch === '\r') i++; // skip \n after \r
      } else {
        currentField += ch;
      }
    }
  }

  // Last row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(f => f !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Parse dollar amount strings like "$10000", "$1,000,000", "10000"
 */
function parseDollarAmount(str) {
  if (!str) return null;
  const cleaned = str.replace(/[$,\s]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

/**
 * Parse comma-separated text into array, filtering empties
 */
function parseArray(str) {
  if (!str) return null;
  const items = str.split(',').map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

/**
 * Parse year from string
 */
function parseYear(str) {
  if (!str) return null;
  const match = str.match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

/**
 * Clean URL - ensure has protocol
 */
function cleanUrl(url) {
  if (!url) return null;
  url = url.trim();
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return 'https://' + url;
}

// ============================================================================
// OPENVC PARSER
// ============================================================================

function parseOpenVC(filePath) {
  console.log(`[OpenVC] Reading ${filePath}...`);
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''); // strip BOM
  const rows = parseCSV(content);

  // First row is header
  const header = rows[0];
  console.log(`[OpenVC] Header: ${header.join(', ')}`);

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0]) continue; // skip empty name

    const name = row[0];
    const normalized = normalizeName(name);
    if (!normalized) continue;

    records.push({
      investor_name: name,
      normalized_name: normalized,
      website_url: cleanUrl(row[1]),
      hq_location: row[2] || null,
      countries_of_investment: parseArray(row[3]),
      investment_stage: row[4] || null,
      investment_thesis: row[5] || null,
      investor_type: row[6] || null,
      check_size_min_usd: parseDollarAmount(row[7]),
      check_size_max_usd: parseDollarAmount(row[8]),
      source: 'openvc',
      openvc_record: true,
      ramp_record: false,
    });
  }

  console.log(`[OpenVC] Parsed ${records.length} records`);
  return records;
}

// ============================================================================
// RAMP PARSER
// ============================================================================

// Ramp columns (no header row):
// [0] Name, [1] Type, [2] Website, [3] Sectors, [4] Stage,
// [5] Contact Name, [6] Email, [7] Portfolio Companies, [8] Location,
// [9] Twitter, [10] LinkedIn, [11] Facebook, [12] Investment Count,
// [13] Unknown Number, [14] Description, [15] Founded Year,
// [16] Flag, [17] (empty)

function parseRamp(filePath) {
  console.log(`[Ramp] Reading ${filePath}...`);
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const rows = parseCSV(content);

  const records = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0]) continue;

    const name = row[0];
    const normalized = normalizeName(name);
    if (!normalized) continue;

    records.push({
      investor_name: name,
      normalized_name: normalized,
      website_url: cleanUrl(row[2]),
      investor_type: row[1] || null,
      investment_sectors: parseArray(row[3]),
      investment_stage: row[4] || null,
      contact_name: row[5] || null,
      primary_contact_email: row[6] ? row[6].toLowerCase().trim() : null,
      portfolio_companies: parseArray(row[7]),
      hq_location: row[8] || null,
      twitter_url: cleanUrl(row[9]),
      linkedin_url: cleanUrl(row[10]),
      portfolio_count: row[12] ? parseInt(row[12], 10) || null : null,
      description: row[14] || null,
      founded_year: parseYear(row[15]),
      source: 'ramp',
      openvc_record: false,
      ramp_record: true,
    });
  }

  console.log(`[Ramp] Parsed ${records.length} records`);
  return records;
}

// ============================================================================
// MERGE LOGIC
// ============================================================================

/**
 * Merge OpenVC + Ramp records, deduplicating on normalized_name.
 * Ramp primary for contact/social, OpenVC for investment thesis/check sizes.
 */
function mergeRecords(openvcRecords, rampRecords) {
  const merged = new Map();

  // Load Ramp first (primary for contact data)
  for (const rec of rampRecords) {
    merged.set(rec.normalized_name, { ...rec });
  }

  let newFromOpenVC = 0;
  let mergedWithRamp = 0;

  // Merge OpenVC on top
  for (const ovc of openvcRecords) {
    const existing = merged.get(ovc.normalized_name);

    if (!existing) {
      // New record from OpenVC only
      merged.set(ovc.normalized_name, { ...ovc });
      newFromOpenVC++;
    } else {
      // Merge: OpenVC wins for thesis/check_size/countries, Ramp wins for contact/social
      mergedWithRamp++;

      // OpenVC-priority fields
      if (ovc.investment_thesis) existing.investment_thesis = ovc.investment_thesis;
      if (ovc.check_size_min_usd) existing.check_size_min_usd = ovc.check_size_min_usd;
      if (ovc.check_size_max_usd) existing.check_size_max_usd = ovc.check_size_max_usd;
      if (ovc.countries_of_investment) existing.countries_of_investment = ovc.countries_of_investment;

      // Fill gaps (first non-null wins)
      if (!existing.website_url && ovc.website_url) existing.website_url = ovc.website_url;
      if (!existing.investor_type && ovc.investor_type) existing.investor_type = ovc.investor_type;
      if (!existing.investment_stage && ovc.investment_stage) existing.investment_stage = ovc.investment_stage;
      if (!existing.hq_location && ovc.hq_location) existing.hq_location = ovc.hq_location;

      // Mark as merged
      existing.source = 'merged';
      existing.openvc_record = true;
      // ramp_record already true
    }
  }

  const results = Array.from(merged.values());

  console.log(`\n[Merge] Results:`);
  console.log(`  Ramp-only:    ${rampRecords.length - mergedWithRamp}`);
  console.log(`  OpenVC-only:  ${newFromOpenVC}`);
  console.log(`  Merged:       ${mergedWithRamp}`);
  console.log(`  Total unique: ${results.length}`);

  return results;
}

// ============================================================================
// SUPABASE UPSERT
// ============================================================================

async function verifyTable() {
  const { data, error } = await formdClient
    .from('external_investor_reference')
    .select('id')
    .limit(1);

  if (error) {
    if (error.code === 'PGRST205' || error.message?.includes('Could not find')) {
      return false;
    }
    throw error;
  }
  return true;
}

async function upsertBatch(records) {
  // Clean records for Supabase - remove undefined values
  const cleaned = records.map(rec => {
    const obj = {};
    for (const [key, value] of Object.entries(rec)) {
      if (value !== undefined) {
        obj[key] = value;
      }
    }
    return obj;
  });

  const { data, error } = await formdClient
    .from('external_investor_reference')
    .upsert(cleaned, {
      onConflict: 'normalized_name',
      ignoreDuplicates: false
    });

  if (error) {
    throw new Error(`Upsert failed: ${error.message}`);
  }

  return cleaned.length;
}

async function importToSupabase(records, dryRun = false) {
  if (dryRun) {
    console.log(`\n[Dry Run] Would upsert ${records.length} records in ${Math.ceil(records.length / BATCH_SIZE)} batches`);

    // Show sample
    const sample = records[0];
    console.log('\n[Dry Run] Sample record:');
    console.log(JSON.stringify(sample, null, 2));

    // Stats
    const withEmail = records.filter(r => r.primary_contact_email).length;
    const withLinkedIn = records.filter(r => r.linkedin_url).length;
    const withWebsite = records.filter(r => r.website_url).length;
    const withThesis = records.filter(r => r.investment_thesis).length;
    const sourceBreakdown = {};
    records.forEach(r => { sourceBreakdown[r.source] = (sourceBreakdown[r.source] || 0) + 1; });

    console.log('\n[Dry Run] Stats:');
    console.log(`  With email:    ${withEmail} (${(withEmail / records.length * 100).toFixed(1)}%)`);
    console.log(`  With LinkedIn: ${withLinkedIn} (${(withLinkedIn / records.length * 100).toFixed(1)}%)`);
    console.log(`  With website:  ${withWebsite} (${(withWebsite / records.length * 100).toFixed(1)}%)`);
    console.log(`  With thesis:   ${withThesis} (${(withThesis / records.length * 100).toFixed(1)}%)`);
    console.log(`  Source: ${JSON.stringify(sourceBreakdown)}`);
    return;
  }

  // Verify table exists
  const tableExists = await verifyTable();
  if (!tableExists) {
    console.error('\n[ERROR] Table external_investor_reference does not exist!');
    console.error('Create it in Supabase Dashboard SQL Editor with:');
    console.error(fs.readFileSync(path.resolve(__dirname, '../database/external_investor_reference.sql'), 'utf-8'));
    process.exit(1);
  }

  console.log(`\n[Import] Upserting ${records.length} records in batches of ${BATCH_SIZE}...`);

  let totalUpserted = 0;
  const totalBatches = Math.ceil(records.length / BATCH_SIZE);

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    try {
      const count = await upsertBatch(batch);
      totalUpserted += count;
      console.log(`  Batch ${batchNum}/${totalBatches}: ${count} records upserted (${totalUpserted} total)`);
    } catch (err) {
      console.error(`  Batch ${batchNum} FAILED: ${err.message}`);
      console.error(`  First record in failed batch: ${JSON.stringify(batch[0]?.investor_name)}`);
      // Continue with remaining batches
    }
  }

  console.log(`\n[Import] Complete. ${totalUpserted} records upserted.`);

  // Verify final count
  const { count, error } = await formdClient
    .from('external_investor_reference')
    .select('id', { count: 'exact', head: true });

  if (!error) {
    console.log(`[Import] Table now has ${count} total records.`);
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'import';
  const dryRun = args.includes('--dry-run');

  const openvcPath = path.resolve(__dirname, '../data-pipeline/external_dbs/openvc_investors.csv');
  const rampPath = path.resolve(__dirname, '../data-pipeline/external_dbs/ramp_investors.csv');

  if (command === 'verify') {
    const exists = await verifyTable();
    if (exists) {
      const { count } = await formdClient
        .from('external_investor_reference')
        .select('id', { count: 'exact', head: true });
      console.log(`[Verify] Table exists with ${count} records`);
    } else {
      console.log('[Verify] Table does NOT exist. Create it in Supabase Dashboard.');
    }
    return;
  }

  if (command === 'import') {
    // Parse both CSVs
    const openvcRecords = parseOpenVC(openvcPath);
    const rampRecords = parseRamp(rampPath);

    // Merge
    const merged = mergeRecords(openvcRecords, rampRecords);

    // Import
    await importToSupabase(merged, dryRun);
  } else {
    console.log('Usage: node external_db_loader.js [import|verify] [--dry-run]');
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
