/**
 * Validation script for needs_initial_adv_filing flags.
 *
 * Samples N flagged managers from compliance_issues and tries to verify each
 * against the live ADV database using a sharper lookup than the detector did.
 * Categorizes each into:
 *   - LIKELY_TRUE: detector flag confirmed (no ADV match found via any approach)
 *   - LIKELY_FP_NAME: a near-name match exists in ADV the detector missed
 *   - LIKELY_FP_PRINCIPAL: a related person matches an adviser_owners control
 *     person at some firm (so the manager IS registered, detector missed)
 *   - PLATFORM_FILING: filing is platform-admin'd (Sydecar/AngelList/etc.) —
 *     these are usually but not always legit unregistered new managers
 *   - LIKELY_FOREIGN: issuer jurisdiction non-US (no ADV required)
 *   - INCONCLUSIVE: insufficient signals either way
 *
 * Outputs:
 *   - stdout: per-flag classification + summary counts
 *   - /tmp/pfr-build/validation_results.json: structured rows
 *
 * Run: node tests/validate_new_manager_flags.js [N]   (default N=50)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { checkAdvDatabase, extractBaseName, nameTokens, namesMatch } = require('../lib/adv_lookup');
const { detectPlatform } = require('../lib/platform_detection');

const N = parseInt(process.argv[2]) || 50;
const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';
const ADV_URL = process.env.ADV_URL || 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = process.env.ADV_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE';

const formdDb = createClient(FORMD_URL, FORMD_KEY);
const advDb = createClient(ADV_URL, ADV_KEY);

function pick(arr, k) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, k);
}

async function classify(issue) {
  const m = issue.metadata || {};
  const name = m.manager_name || m.entity_name;
  if (!name) return { category: 'INCONCLUSIVE', evidence: 'no manager_name in metadata' };

  // Pull a sample Form D filing to get richer context
  const sample = m.sample_funds && m.sample_funds[0] ? m.sample_funds[0] : null;
  let filing = null;
  if (sample && sample.cik) {
    const { data: fd } = await formdDb
      .from('form_d_filings')
      .select('entityname, related_names, related_roles, stateorcountry, nameofsigner, industrygrouptype, street1, city, zipcode')
      .eq('cik', sample.cik)
      .limit(1);
    filing = fd && fd[0];
  }

  // Platform-admin filing → distinct bucket
  if (filing) {
    const platform = detectPlatform(filing);
    if (platform.is_platform) {
      return {
        category: 'PLATFORM_FILING',
        evidence: `platform=${platform.platform_name}; signals=${platform.signals.join(',')}`,
        platform: platform.platform_name,
      };
    }
    // Foreign jurisdiction (review tag, not necessarily FP — but skip-from-flag)
    const country = (filing.stateorcountry || '').toUpperCase().trim();
    const usStates = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP']);
    if (country && country.length > 0 && !usStates.has(country) && !['UNITED STATES','USA','US'].includes(country)) {
      return { category: 'LIKELY_FOREIGN', evidence: `issuer jurisdiction=${country}` };
    }
  }

  // Re-run the lookup with fresh code (includes the baseIsMeaningful guard)
  const opts = filing ? { relatedNames: filing.related_names, relatedRoles: filing.related_roles } : {};
  const lookup = await checkAdvDatabase(advDb, name, opts);

  if (lookup.found) {
    // Detector missed this. The new code finds it.
    return {
      category: lookup.source === 'adviser_owners' || lookup.source === 'database_related_person' ? 'LIKELY_FP_PRINCIPAL' : 'LIKELY_FP_NAME',
      evidence: `re-lookup found CRD ${lookup.crd} (${lookup.adviser_name}, via ${lookup.source})`,
      matched_crd: lookup.crd,
      matched_name: lookup.adviser_name,
      matched_source: lookup.source,
    };
  }

  // Person-only check using related persons (in case the firm name doesn't match
  // but a control person does)
  if (filing && filing.related_names) {
    const persons = filing.related_names.split('|').map(p => p.trim()).filter(p => p.length > 3);
    for (const p of persons.slice(0, 5)) {
      const r = await checkAdvDatabase(advDb, p, { personOnly: true });
      if (r.found) {
        return {
          category: 'LIKELY_FP_PRINCIPAL',
          evidence: `principal "${p}" resolves to CRD ${r.crd} (${r.adviser_name}) via ${r.source}`,
          matched_crd: r.crd,
          matched_name: r.adviser_name,
        };
      }
    }
  }

  return { category: 'LIKELY_TRUE', evidence: 'no ADV match via name, base, prefix, owners, or principal cross-check' };
}

async function main() {
  console.log(`Fetching needs_initial_adv_filing issues from compliance_issues...`);
  const { data: issues, error } = await formdDb
    .from('compliance_issues')
    .select('id, metadata, severity, detected_date')
    .eq('discrepancy_type', 'needs_initial_adv_filing')
    .order('detected_date', { ascending: false })
    .limit(2000);
  if (error) { console.error('error:', error.message); process.exit(2); }
  if (!issues || issues.length === 0) {
    console.error('No needs_initial_adv_filing issues found in compliance_issues.');
    process.exit(0);
  }

  console.log(`  Found ${issues.length} active flags. Sampling ${N}.`);
  const sample = pick(issues, Math.min(N, issues.length));
  const results = [];

  const buckets = {
    LIKELY_TRUE: 0,
    LIKELY_FP_NAME: 0,
    LIKELY_FP_PRINCIPAL: 0,
    PLATFORM_FILING: 0,
    LIKELY_FOREIGN: 0,
    INCONCLUSIVE: 0,
  };

  for (let i = 0; i < sample.length; i++) {
    const issue = sample[i];
    const name = issue.metadata?.manager_name || issue.metadata?.entity_name || '?';
    const c = await classify(issue);
    buckets[c.category] = (buckets[c.category] || 0) + 1;
    const flag = c.category === 'LIKELY_TRUE' ? '✓' :
                  c.category === 'PLATFORM_FILING' ? '◊' :
                  c.category === 'LIKELY_FOREIGN' ? '🌍' :
                  c.category === 'INCONCLUSIVE' ? '?' : '✗';
    console.log(`${flag} [${i+1}/${sample.length}] ${name}`);
    console.log(`    → ${c.category}: ${c.evidence}`);
    results.push({ id: issue.id, name, ...c });
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  const total = sample.length;
  for (const [cat, n] of Object.entries(buckets)) {
    if (n === 0) continue;
    const pct = ((n / total) * 100).toFixed(1);
    console.log(`  ${cat.padEnd(22)} ${String(n).padStart(3)} (${pct}%)`);
  }
  const fps = (buckets.LIKELY_FP_NAME || 0) + (buckets.LIKELY_FP_PRINCIPAL || 0);
  console.log(`  ${'FP rate (NAME+PRINCIPAL)'.padEnd(22)} ${String(fps).padStart(3)} (${((fps/total)*100).toFixed(1)}%)`);

  fs.writeFileSync('/tmp/pfr-build/validation_results.json', JSON.stringify({
    total_population: issues.length,
    sample_size: total,
    buckets,
    results,
  }, null, 2));
  console.log(`\nDetailed results: /tmp/pfr-build/validation_results.json`);
}

main().catch(e => { console.error(e); process.exit(2); });
