/**
 * Fund Holders Intel API
 *
 * Mounted at /api/intel by nport/api/server.js. Returns the lifecycle-
 * aware holder report for a single tracked company in one response,
 * suitable for direct rendering by the React SPA at /intel/:slug.
 *
 * Pulls from:
 *   - v_intel_company_holders (lifecycle + holder evidence union)
 *   - company_lifecycle_events  (transition history)
 *   - advisers_enriched         (firm contact, owners, AUM)
 *   - enriched_managers         (LinkedIn, team_members; sparse)
 *
 * Response shape documented inline below.
 */

const express = require('express');
const router = express.Router();

const nportClientModule = require('../db/nport_client');
const crossSource = require('../db/cross_source');

const deps = {
  nportClient: nportClientModule.nportClient,
  advClient: crossSource.advClient,
  formdClient: crossSource.formdClient,
  isConfigured: nportClientModule.isConfigured,
};
router.deps = deps;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function configGuard(res) {
  if (!deps.isConfigured()) {
    res.status(503).json({
      error: 'N-PORT Supabase project not configured',
      code: 'NPORT_NOT_CONFIGURED',
    });
    return false;
  }
  return true;
}

function notFound(res, message = 'Not found', code = 'NOT_FOUND') {
  return res.status(404).json({ error: message, code });
}

function serverError(res, err, code = 'INTERNAL_ERROR') {
  console.error('[INTEL]', err && err.message ? err.message : err);
  return res.status(500).json({ error: err && err.message ? err.message : 'Internal error', code });
}

// Domain skip-list for canonical-website selection (matches POC3's selector).
const SOCIAL_HOSTS = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'reddit.com', 'threads.net', 'tiktok.com', 'mastodon.social',
  'bsky.app', 'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com',
  'wix.com', 'squarespace.com', 'github.com', 'github.io', 'glassdoor.com',
  'indeed.com', 'crunchbase.com', 'sec.gov', 'edgar.gov', 'secinfo.com',
  'plynk.com',
]);

function hostOf(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url).trim().toLowerCase());
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isSocial(url) {
  const h = hostOf(url);
  if (!h) return false;
  for (const skip of SOCIAL_HOSTS) {
    if (h === skip || h.endsWith('.' + skip)) return true;
  }
  return false;
}

function pickCanonicalDomain(primary, others) {
  if (primary && !isSocial(primary)) return primary;
  const list = [];
  if (Array.isArray(others)) {
    list.push(...others);
  } else if (typeof others === 'string') {
    // Split by ; or , as PFR stores other_websites inconsistently
    if (others.includes(';')) list.push(...others.split(';').map(s => s.trim()));
    else if (others.includes(',')) list.push(...others.split(',').map(s => s.trim()));
    else if (others.trim()) list.push(others.trim());
  }
  for (const url of list) {
    if (url && !isSocial(url)) return url;
  }
  return primary || null;
}

// Keyset-paginated fetch from v_intel_company_holders for one source_type.
async function paginateHolders(nportClient, companySlug, sourceType) {
  const rows = [];
  let lastId = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await nportClient
      .from('v_intel_company_holders')
      .select('*')
      .eq('company_slug', companySlug)
      .eq('source_type', sourceType)
      .gt('evidence_id', lastId)
      .order('evidence_id')
      .limit(pageSize);
    if (error) throw error;
    const batch = data || [];
    if (!batch.length) break;
    rows.push(...batch);
    lastId = parseInt(batch[batch.length - 1].evidence_id, 10);
    if (batch.length < pageSize) break;
  }
  return rows;
}

// Chunked .in_() helper — Supabase URL length caps the in-list size.
async function fetchAdviserDetails(advClient, crds) {
  if (!crds || crds.length === 0) return {};
  const unique = Array.from(new Set(crds.map(c => String(c).trim()).filter(Boolean)));
  const cols = [
    'crd', 'adviser_name', 'total_aum', 'phone_number', 'primary_website',
    'other_websites', 'cco_name', 'cco_email', 'signatory_name',
    'signatory_title', 'form_adv_url',
    'owner_full_legal_name', 'owner_title_or_status', 'ownership_amount',
    'control_person_name', 'regulatory_contact_name', 'regulatory_contact_email',
  ].join(',');
  const out = {};
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data, error } = await advClient
      .from('advisers_enriched')
      .select(cols)
      .in('crd', chunk);
    if (error) throw error;
    for (const row of (data || [])) out[String(row.crd)] = row;
  }
  return out;
}

async function fetchEnrichedExtras(formdClient, crds) {
  if (!formdClient || !crds || crds.length === 0) return {};
  const unique = Array.from(new Set(crds.map(c => String(c).trim()).filter(Boolean)));
  const out = {};
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data, error } = await formdClient
      .from('enriched_managers')
      .select('linked_crd,website_url,linkedin_company_url,team_members,primary_contact_email,twitter_handle')
      .in('linked_crd', chunk);
    if (error) {
      // enriched_managers is optional; log and continue
      console.warn('[INTEL] enriched_managers fetch failed:', error.message);
      return out;
    }
    for (const row of (data || [])) {
      const k = String(row.linked_crd || '');
      if (k && !out[k]) out[k] = row;
    }
  }
  return out;
}

function teamMembersToText(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map((m) => {
      if (m && typeof m === 'object') {
        const name = m.name || '';
        const role = m.role || m.title || '';
        if (name && role) return `${name} (${role})`;
        return name || role || '';
      }
      return String(m || '');
    }).filter(Boolean);
    return parts.length ? parts.join('; ') : null;
  }
  return String(value);
}

// ----------------------------------------------------------------------------
// GET /api/intel/companies/:slug/holders
// ----------------------------------------------------------------------------

router.get('/companies/:slug/holders', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: 'slug required', code: 'MISSING_SLUG' });
    const audit = req.query.audit === '1' || req.query.audit === 'true';

    // 1. Company metadata
    const { data: companyRow, error: compErr } = await deps.nportClient
      .from('private_companies')
      .select('slug,display_name,lifecycle_status,is_public,is_acquired,primary_domain,legal_entities,sector,founded_year,latest_known_valuation_usd,latest_known_valuation_date,most_recent_round,most_recent_round_date,description')
      .eq('slug', slug)
      .maybeSingle();
    if (compErr) throw compErr;
    if (!companyRow) return notFound(res, `Company not found: ${slug}`, 'COMPANY_NOT_FOUND');

    // 2. Lifecycle events for this company
    const { data: eventRows, error: evErr } = await deps.nportClient
      .from('company_lifecycle_events')
      .select('event_date,event_type,status_after,source_name,source_url,confidence,notes')
      .eq('company_slug', slug)
      .order('event_date');
    if (evErr) throw evErr;

    // 3. Current status (most-recent event's status_after, falls back to seed flag)
    const { data: currentRow } = await deps.nportClient
      .from('v_company_current_lifecycle')
      .select('current_status,last_event_date,last_event_type')
      .eq('company_slug', slug)
      .maybeSingle();
    const currentStatus = (currentRow && currentRow.current_status)
      || (companyRow.is_public ? 'public' : (companyRow.is_acquired ? 'acquired' : 'private'));

    // 4. Holder evidence (filtered by lifecycle eligibility unless ?audit=1)
    const nportRows = await paginateHolders(deps.nportClient, slug, 'nport');
    const formdRows = await paginateHolders(deps.nportClient, slug, 'formd_pooled_vehicle');
    let allRows = [...nportRows, ...formdRows];
    if (!audit) {
      allRows = allRows.filter(r => r.status_at_evidence_date === 'private' || r.status_at_evidence_date === 'unknown');
    }

    // 5. Adviser details (one call covering both N-PORT + Form D resolved advisers)
    const crds = Array.from(new Set(allRows.map(r => r.adviser_crd).filter(Boolean)));
    const adviserDetails = await fetchAdviserDetails(deps.advClient, crds);
    const enrichedExtras = await fetchEnrichedExtras(deps.formdClient, crds);

    // 6. Build adviser rollup: one entry per distinct CRD, with total $ value
    //    and evidence count across both source types
    const adviserRollup = {};
    for (const row of allRows) {
      const crd = row.adviser_crd;
      if (!crd) continue;
      const key = String(crd);
      if (!adviserRollup[key]) {
        const adv = adviserDetails[key] || {};
        const extras = enrichedExtras[key] || {};
        adviserRollup[key] = {
          crd: key,
          name: adv.adviser_name || null,
          total_aum: adv.total_aum || null,
          phone: adv.phone_number || null,
          website: pickCanonicalDomain(adv.primary_website, adv.other_websites),
          cco_name: adv.cco_name || null,
          cco_email: adv.cco_email || null,
          signatory_name: adv.signatory_name || null,
          signatory_title: adv.signatory_title || null,
          owner_full_legal_name: adv.owner_full_legal_name || null,
          owner_title_or_status: adv.owner_title_or_status || null,
          ownership_amount: adv.ownership_amount || null,
          control_person_name: adv.control_person_name || null,
          regulatory_contact_name: adv.regulatory_contact_name || null,
          regulatory_contact_email: adv.regulatory_contact_email || null,
          form_adv_url: adv.form_adv_url || null,
          linkedin_company_url: extras.linkedin_company_url || null,
          team_members: teamMembersToText(extras.team_members) || null,
          alt_contact_email: extras.primary_contact_email || null,
          twitter_handle: extras.twitter_handle || null,
          evidence_count: 0,
          total_value_usd: 0,
        };
      }
      adviserRollup[key].evidence_count += 1;
      const v = row.value_usd ? parseFloat(row.value_usd) : 0;
      if (Number.isFinite(v)) adviserRollup[key].total_value_usd += v;
    }
    const advisers = Object.values(adviserRollup).sort(
      (a, b) => (b.total_value_usd || 0) - (a.total_value_usd || 0)
    );

    // 7. Split returned rows into N-PORT vs Form D buckets for the UI tables
    const annotatedNport = nportRows
      .filter(r => audit || r.status_at_evidence_date === 'private' || r.status_at_evidence_date === 'unknown')
      .map(r => ({
        evidence_id: r.evidence_id,
        registrant_cik: r.evidence_cik,
        series_id: r.evidence_series_id,
        issuer_title: r.evidence_label,
        value_usd: r.value_usd ? parseFloat(r.value_usd) : null,
        evidence_date: r.evidence_date,
        accession_number: r.accession_number,
        adviser_crd: r.adviser_crd || null,
        adviser_name: (adviserRollup[r.adviser_crd] || {}).name || null,
        adviser_method: r.adviser_resolution_method,
        status_at_evidence_date: r.status_at_evidence_date,
        was_private_at_evidence_date: r.was_private_at_evidence_date,
      }))
      .sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0));

    const annotatedFormd = formdRows
      .filter(r => audit || r.status_at_evidence_date === 'private' || r.status_at_evidence_date === 'unknown')
      .map(r => ({
        evidence_id: r.evidence_id,
        filer_cik: r.evidence_cik,
        filer_entityname: r.evidence_label,
        value_usd: r.value_usd ? parseFloat(r.value_usd) : null,
        filing_date: r.evidence_date,
        accession_number: r.accession_number,
        adviser_crd: r.adviser_crd || null,
        adviser_name: (adviserRollup[r.adviser_crd] || {}).name || null,
        adviser_method: r.adviser_resolution_method,
        status_at_evidence_date: r.status_at_evidence_date,
        was_private_at_evidence_date: r.was_private_at_evidence_date,
      }))
      .sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0));

    return res.json({
      company: {
        slug: companyRow.slug,
        display_name: companyRow.display_name,
        sector: companyRow.sector,
        founded_year: companyRow.founded_year,
        primary_domain: companyRow.primary_domain,
        latest_known_valuation_usd: companyRow.latest_known_valuation_usd,
        most_recent_round: companyRow.most_recent_round,
        most_recent_round_date: companyRow.most_recent_round_date,
        legal_entities: companyRow.legal_entities,
        description: companyRow.description,
      },
      lifecycle: {
        seed_status: companyRow.lifecycle_status,
        is_public_seed: companyRow.is_public,
        is_acquired_seed: companyRow.is_acquired,
        current_status: currentStatus,
        last_event_date: currentRow ? currentRow.last_event_date : null,
        last_event_type: currentRow ? currentRow.last_event_type : null,
        events: eventRows || [],
      },
      summary: {
        total_nport: nportRows.length,
        total_formd: formdRows.length,
        eligible_nport: annotatedNport.length,
        eligible_formd: annotatedFormd.length,
        distinct_advisers: advisers.length,
        audit_mode: audit,
      },
      nport_holders: annotatedNport,
      formd_holders: annotatedFormd,
      advisers,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// ----------------------------------------------------------------------------
// CSV download endpoints
// ----------------------------------------------------------------------------

/**
 * Escape a single value for inclusion in CSV. Wraps in double-quotes when the
 * value contains a delimiter, quote, or newline, and doubles any internal
 * quotes per RFC 4180. Nulls/undefineds become empty cells.
 */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function rowsToCsv(headers, rows, accessors) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(accessors.map(fn => csvEscape(fn(row))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

async function fetchHolderRowsForCsv(slug, evidenceType, { audit }) {
  const rows = await paginateHolders(deps.nportClient, slug, evidenceType);
  const crds = Array.from(new Set(rows.map(r => r.adviser_crd).filter(Boolean)));
  const adviserDetails = await fetchAdviserDetails(deps.advClient, crds);
  const filtered = audit
    ? rows
    : rows.filter(r => r.status_at_evidence_date === 'private' || r.status_at_evidence_date === 'unknown');
  return { rows: filtered, adviserDetails };
}

router.get('/companies/:slug/holders/nport.csv', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;
    const audit = req.query.audit === '1' || req.query.audit === 'true';
    const { rows, adviserDetails } = await fetchHolderRowsForCsv(slug, 'nport', { audit });
    const sorted = rows.slice().sort((a, b) => {
      const av = a.value_usd ? parseFloat(a.value_usd) : 0;
      const bv = b.value_usd ? parseFloat(b.value_usd) : 0;
      return bv - av;
    });
    const headers = [
      'evidence_id', 'registrant_cik', 'series_id', 'issuer_title',
      'value_usd', 'evidence_date', 'accession_number',
      'adviser_crd', 'adviser_name', 'adviser_method',
      'status_at_evidence_date', 'was_private_at_evidence_date',
    ];
    const accessors = [
      r => r.evidence_id,
      r => r.evidence_cik,
      r => r.evidence_series_id,
      r => r.evidence_label,
      r => r.value_usd ? parseFloat(r.value_usd) : '',
      r => r.evidence_date,
      r => r.accession_number,
      r => r.adviser_crd || '',
      r => (adviserDetails[r.adviser_crd] || {}).adviser_name || '',
      r => r.adviser_resolution_method || '',
      r => r.status_at_evidence_date,
      r => r.was_private_at_evidence_date,
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-nport-holders.csv"`);
    res.send(rowsToCsv(headers, sorted, accessors));
  } catch (err) {
    return serverError(res, err);
  }
});

router.get('/companies/:slug/holders/formd.csv', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const { slug } = req.params;
    const audit = req.query.audit === '1' || req.query.audit === 'true';
    const { rows, adviserDetails } = await fetchHolderRowsForCsv(slug, 'formd_pooled_vehicle', { audit });
    const sorted = rows.slice().sort((a, b) => {
      const av = a.value_usd ? parseFloat(a.value_usd) : 0;
      const bv = b.value_usd ? parseFloat(b.value_usd) : 0;
      return bv - av;
    });
    const headers = [
      'evidence_id', 'filer_cik', 'filer_entityname', 'value_usd',
      'filing_date', 'accession_number',
      'adviser_crd', 'adviser_name', 'adviser_method',
      'status_at_evidence_date', 'was_private_at_evidence_date',
    ];
    const accessors = [
      r => r.evidence_id,
      r => r.evidence_cik,
      r => r.evidence_label,
      r => r.value_usd ? parseFloat(r.value_usd) : '',
      r => r.evidence_date,
      r => r.accession_number,
      r => r.adviser_crd || '',
      r => (adviserDetails[r.adviser_crd] || {}).adviser_name || '',
      r => r.adviser_resolution_method || '',
      r => r.status_at_evidence_date,
      r => r.was_private_at_evidence_date,
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-formd-holders.csv"`);
    res.send(rowsToCsv(headers, sorted, accessors));
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
