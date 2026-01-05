/**
 * Upload State ERA advisers and funds to the enriched Supabase database
 */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const SUPABASE_URL = 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzMyNjQ0MCwiZXhwIjoyMDc4OTAyNDQwfQ.Rq2lPQ1Uy_zTAPuY7VmEHA0I802vvEV9mm-br3M8aKM';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getTableColumns(tableName) {
  const { data } = await supabase.from(tableName).select('*').limit(1);
  return data && data[0] ? Object.keys(data[0]) : [];
}

async function uploadAdvisers() {
  console.log('Loading advisers data...');
  const advisers = JSON.parse(fs.readFileSync('/Users/Miles/Desktop/ADV Info/db_ready_advisers.json'));
  console.log(`Loaded ${advisers.length} advisers`);

  // Get existing columns
  const existingCols = new Set(await getTableColumns('advisers_enriched'));
  const newCols = Object.keys(advisers[0]);

  console.log('\nColumns in our data but NOT in table:');
  newCols.forEach(col => {
    if (!existingCols.has(col)) console.log('  -', col);
  });

  // Filter to only matching columns
  const matchingCols = newCols.filter(c => existingCols.has(c));
  console.log(`\nMatching columns: ${matchingCols.length}/${newCols.length}`);

  // Upload in batches
  const BATCH_SIZE = 100;
  let uploaded = 0;
  let errors = 0;

  for (let i = 0; i < advisers.length; i += BATCH_SIZE) {
    const batch = advisers.slice(i, i + BATCH_SIZE).map(a => {
      const filtered = {};
      matchingCols.forEach(col => {
        filtered[col] = a[col];
      });
      return filtered;
    });

    const { error } = await supabase
      .from('advisers_enriched')
      .upsert(batch, { onConflict: 'crd' });

    if (error) {
      console.error(`Batch ${i / BATCH_SIZE + 1} error:`, error.message);
      errors++;
    } else {
      uploaded += batch.length;
      if ((i / BATCH_SIZE + 1) % 5 === 0) {
        console.log(`Uploaded ${uploaded}/${advisers.length} advisers...`);
      }
    }
  }

  console.log(`\nAdvisers upload complete: ${uploaded} uploaded, ${errors} errors`);
  return uploaded;
}

async function uploadFunds() {
  console.log('\nLoading funds data...');
  const funds = JSON.parse(fs.readFileSync('/Users/Miles/Desktop/ADV Info/db_ready_funds.json'));
  console.log(`Loaded ${funds.length} funds`);

  // Get existing columns
  const existingCols = new Set(await getTableColumns('funds_enriched'));
  const newCols = Object.keys(funds[0]);

  console.log('\nColumns in our data but NOT in table:');
  newCols.forEach(col => {
    if (!existingCols.has(col)) console.log('  -', col);
  });

  // Filter to only matching columns
  const matchingCols = newCols.filter(c => existingCols.has(c));
  console.log(`\nMatching columns: ${matchingCols.length}/${newCols.length}`);

  // Upload in batches
  const BATCH_SIZE = 100;
  let uploaded = 0;
  let errors = 0;

  for (let i = 0; i < funds.length; i += BATCH_SIZE) {
    const batch = funds.slice(i, i + BATCH_SIZE).map(f => {
      const filtered = {};
      matchingCols.forEach(col => {
        filtered[col] = f[col];
      });
      return filtered;
    });

    const { error } = await supabase
      .from('funds_enriched')
      .upsert(batch, { onConflict: 'fund_id' });

    if (error) {
      console.error(`Batch ${i / BATCH_SIZE + 1} error:`, error.message);
      errors++;
    } else {
      uploaded += batch.length;
      if ((i / BATCH_SIZE + 1) % 10 === 0) {
        console.log(`Uploaded ${uploaded}/${funds.length} funds...`);
      }
    }
  }

  console.log(`\nFunds upload complete: ${uploaded} uploaded, ${errors} errors`);
  return uploaded;
}

async function main() {
  const mode = process.argv[2] || 'test';

  if (mode === 'test') {
    console.log('=== TEST MODE (10 advisers only) ===\n');

    const advisers = JSON.parse(fs.readFileSync('/Users/Miles/Desktop/ADV Info/db_ready_advisers.json'));
    const existingCols = new Set(await getTableColumns('advisers_enriched'));
    const matchingCols = Object.keys(advisers[0]).filter(c => existingCols.has(c));

    const testBatch = advisers.slice(0, 10).map(a => {
      const filtered = {};
      matchingCols.forEach(col => { filtered[col] = a[col]; });
      return filtered;
    });

    const { error } = await supabase
      .from('advisers_enriched')
      .upsert(testBatch, { onConflict: 'crd' });

    if (error) {
      console.error('Test upload error:', error.message);
    } else {
      console.log('Test upload SUCCESS!');

      // Verify
      const { data: verify } = await supabase
        .from('advisers_enriched')
        .select('crd, adviser_name, phone_number, type')
        .eq('crd', advisers[0].crd)
        .single();

      console.log('\nVerification:', JSON.stringify(verify, null, 2));
    }
  } else if (mode === 'advisers') {
    await uploadAdvisers();
  } else if (mode === 'funds') {
    await uploadFunds();
  } else if (mode === 'all') {
    await uploadAdvisers();
    await uploadFunds();

    // Verify final counts
    const { count: advCount } = await supabase.from('advisers_enriched').select('*', { count: 'exact', head: true });
    const { count: fundsCount } = await supabase.from('funds_enriched').select('*', { count: 'exact', head: true });

    console.log('\n=== FINAL COUNTS ===');
    console.log('advisers_enriched:', advCount);
    console.log('funds_enriched:', fundsCount);
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
