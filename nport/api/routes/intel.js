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
const { normalizeName, normalizeOwnersList } = require('../lib/name_normalizer');

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
// Codex 2026-05-20 — added discord.gg/discord.com (firms file these as
// 'primary_website' on Form ADV; SEC data is dirty). Also pinterest,
// vimeo, slideshare, glassdoor — same class of issue.
const SOCIAL_HOSTS = new Set([
  'facebook.com', 'fb.com', 'instagram.com', 'linkedin.com',
  'twitter.com', 'x.com',
  'youtube.com', 'youtu.be', 'vimeo.com',
  'reddit.com', 'threads.net', 'tiktok.com', 'mastodon.social',
  'bsky.app', 'pinterest.com', 'slideshare.net',
  'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com',
  'wix.com', 'squarespace.com',
  'github.com', 'github.io', 'gitlab.com',
  'glassdoor.com', 'indeed.com',
  'crunchbase.com', 'pitchbook.com', 'tracxn.com', 'cbinsights.com',
  'sec.gov', 'edgar.gov', 'secinfo.com', 'adviserinfo.sec.gov',
  'discord.gg', 'discord.com',
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

// Normalize a URL for display: lowercase scheme + host, preserve path/query.
// Drops 'www.' and trailing slash on bare-host URLs for tidiness.
function normalizeUrlForDisplay(url) {
  if (!url) return url;
  try {
    const u = new URL(String(url).trim());
    const scheme = u.protocol.toLowerCase().replace(':', '');
    const host = u.hostname.toLowerCase();
    let path = u.pathname || '';
    if (path === '/') path = '';
    const tail = (u.search || '') + (u.hash || '');
    return `${scheme}://${host}${path}${tail}`;
  } catch {
    return url;
  }
}

/**
 * Pick the best website for an adviser, in order:
 *   1. enriched_managers.website_url (validator-cleaned; preferred)
 *   2. advisers_enriched.primary_website (if not in SOCIAL_HOSTS)
 *   3. first non-social entry in advisers_enriched.other_websites
 *   4. null
 *
 * Returns null instead of a social/aggregator URL — better to show
 * nothing than to point users at a Discord invite.
 */
function pickCanonicalDomain(primary, others, enrichedWebsite) {
  if (enrichedWebsite && !isSocial(enrichedWebsite)) {
    return normalizeUrlForDisplay(enrichedWebsite);
  }
  if (primary && !isSocial(primary)) return normalizeUrlForDisplay(primary);
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
    if (url && !isSocial(url)) return normalizeUrlForDisplay(url);
  }
  // Everything is social — return null rather than a Discord invite.
  return null;
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

async function fetchPersonEnrichment(nportClient, crds) {
  // Returns { [crd]: { [normalized_name]: { linkedin_url, inferred_title, confidence } } }
  // Reads v_intel_person_enrichment (migration 007). Returns {} if the table/
  // view doesn't exist yet — the migration may not be applied.
  if (!crds || crds.length === 0) return {};
  const unique = Array.from(new Set(crds.map(c => String(c).trim()).filter(Boolean)));
  const out = {};
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data, error } = await nportClient
      .from('v_intel_person_enrichment')
      .select('adviser_crd,normalized_name,linkedin_url,inferred_title,confidence,role_hint')
      .in('adviser_crd', chunk);
    if (error) {
      // Pre-migration: log once and bail. Don't fail the whole intel request.
      console.warn('[INTEL] v_intel_person_enrichment unavailable:', error.message);
      return out;
    }
    for (const row of (data || [])) {
      const crd = String(row.adviser_crd);
      if (!out[crd]) out[crd] = {};
      out[crd][row.normalized_name] = {
        linkedin_url: row.linkedin_url,
        inferred_title: row.inferred_title,
        confidence: row.confidence,
        role_hint: row.role_hint,
      };
    }
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

/**
 * Normalize PFR's enrichment_engine_v2 team_members payload into a
 * structured array the frontend can render person-by-person.
 *
 * Each element: { name, title, linkedin, email }. Drops empty entries
 * and entries whose name was rejected by the same heuristics the
 * Python enrichment_validator uses (corporate strings, header-style
 * all-caps blobs, etc.).
 *
 * Returns null if no usable members remain.
 */
function teamMembersToStructured(value, firmName) {
  if (!value) return null;
  let arr;
  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === 'string') {
    // Legacy stringified form — try to JSON.parse, otherwise split on ';'
    try {
      const parsed = JSON.parse(value);
      arr = Array.isArray(parsed) ? parsed : null;
    } catch {
      arr = value.split(';').map(s => ({ name: s.trim() }));
    }
  }
  if (!Array.isArray(arr)) return null;

  // Reject blatantly-corporate name strings the engine sometimes emits
  // (e.g., 'Capital Research Management (...long description...)').
  const isLikelyCorporate = (name) => {
    if (!name) return true;
    const upper = name.toUpperCase();
    const corp = /\b(INC|INC\.|LLC|LP|L\.P\.|CORP|CORPORATION|HOLDINGS|TRUST|FUND|FUNDS|MANAGEMENT|ADVISORS|ADVISERS|PARTNERS|ASSOCIATES|GROUP|COMPANY|CO\.?|LTD|LIMITED)\b/;
    if (corp.test(upper) && name.split(' ').length >= 3) return true;
    // 4+ token ALL CAPS without lower → looks like a header
    if (name.split(' ').length >= 4 && !/[a-z]/.test(name)) return true;
    return false;
  };

  const out = [];
  const seenNames = new Set();
  for (const m of arr) {
    if (!m || typeof m !== 'object') continue;
    const name = (m.name || '').trim();
    if (!name) continue;
    if (isLikelyCorporate(name)) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    out.push({
      name,
      title: (m.role || m.title || '').trim() || null,
      linkedin: m.linkedin || m.linkedin_url || null,
      email: m.email || null,
    });
  }
  return out.length ? out : null;
}

// Kept for callers that want the legacy joined-string form.
function teamMembersToText(value) {
  const structured = teamMembersToStructured(value);
  if (!structured) return null;
  return structured.map(m => m.title ? `${m.name} (${m.title})` : m.name).join('; ');
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
    const personEnrichment = await fetchPersonEnrichment(deps.nportClient, crds);

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
          website: pickCanonicalDomain(adv.primary_website, adv.other_websites, extras.website_url),
          cco_name: normalizeName(adv.cco_name),
          cco_email: adv.cco_email || null,
          signatory_name: normalizeName(adv.signatory_name),
          signatory_title: adv.signatory_title || null,
          // Raw owner blob kept for backwards-compat; new `owners` array is
          // the parsed/normalized list the frontend should use.
          owner_full_legal_name: adv.owner_full_legal_name || null,
          owners: normalizeOwnersList(adv.owner_full_legal_name),
          owner_title_or_status: adv.owner_title_or_status || null,
          ownership_amount: adv.ownership_amount || null,
          control_person_name: normalizeName(adv.control_person_name),
          regulatory_contact_name: normalizeName(adv.regulatory_contact_name),
          regulatory_contact_email: adv.regulatory_contact_email || null,
          // Per-person LinkedIn / title enrichment, keyed by normalized name.
          // Populated by intelligence/enrich_people.py; empty {} when the
          // table is unmigrated or no rows exist for this firm yet.
          person_enrichment: personEnrichment[key] || {},
          form_adv_url: adv.form_adv_url || null,
          linkedin_company_url: extras.linkedin_company_url || null,
          // Structured: array of {name, title, linkedin, email}. The frontend
          // renders per-person LinkedIn icons + emails from this. Kept the
          // back-compat text form on team_members_text for older consumers.
          team_members: teamMembersToStructured(extras.team_members),
          team_members_text: teamMembersToText(extras.team_members) || null,
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
// Global search across tracked companies + advisers + ADV funds + Form D
// filings. Returns a unified, ranked result list.
// ----------------------------------------------------------------------------

router.get('/search', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ query: q, total: 0, results: [], note: 'min 2 chars' });
    }
    // Limits per source; concatenate at the end.
    const PER_SOURCE = parseInt(req.query.limit, 10) || 25;
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;

    // 1. Tracked private companies (highest priority — top of results)
    const companiesP = deps.nportClient
      .from('private_companies')
      .select('slug,display_name,sector,lifecycle_status,is_public,is_acquired')
      .ilike('display_name', like)
      .limit(PER_SOURCE);

    // 2. Advisers (advisers_enriched by adviser_name)
    const advisersP = deps.advClient
      .from('advisers_enriched')
      .select('crd,adviser_name,total_aum,phone_number')
      .ilike('adviser_name', like)
      .limit(PER_SOURCE);

    // 3. ADV registered funds (funds_enriched by fund_name)
    const fundsP = deps.advClient
      .from('funds_enriched')
      .select('reference_id,fund_name,fund_type,adviser_crd,gross_asset_value')
      .ilike('fund_name', like)
      .limit(PER_SOURCE);

    // 4. Form D filings by entityname (filter to non-amendments)
    const formdP = deps.formdClient
      .from('form_d_filings')
      .select('accessionnumber,entityname,cik,filing_date,totalofferingamount')
      .ilike('entityname', like)
      .neq('isamendment', 'true')
      .order('filing_date', { ascending: false })
      .limit(PER_SOURCE);

    const [companiesRes, advisersRes, fundsRes, formdRes] = await Promise.all([
      companiesP, advisersP, fundsP, formdP,
    ]);

    const results = [];

    // Score helper: exact-prefix match ranks higher than substring.
    const qLower = q.toLowerCase();
    const score = (text) => {
      if (!text) return 0;
      const t = text.toLowerCase();
      if (t === qLower) return 100;
      if (t.startsWith(qLower)) return 50;
      return 10;
    };

    for (const row of (companiesRes.data || [])) {
      const status = row.lifecycle_status || (row.is_public ? 'public' : 'private');
      results.push({
        type: 'company',
        id: row.slug,
        label: row.display_name,
        sublabel: `${row.sector ? row.sector + ' • ' : ''}${status}`,
        url: `/intel/${encodeURIComponent(row.slug)}`,
        rank: score(row.display_name) + 30, // companies prioritized
      });
    }
    for (const row of (advisersRes.data || [])) {
      const aum = row.total_aum
        ? '$' + Number(row.total_aum).toLocaleString(undefined, { maximumFractionDigits: 0 })
        : 'AUM —';
      results.push({
        type: 'adviser',
        id: String(row.crd),
        label: row.adviser_name,
        sublabel: `CRD ${row.crd} • ${aum}`,
        url: `/intel/adviser/${encodeURIComponent(row.crd)}`,
        rank: score(row.adviser_name) + 20,
      });
    }
    for (const row of (fundsRes.data || [])) {
      const gav = row.gross_asset_value
        ? '$' + Number(row.gross_asset_value).toLocaleString(undefined, { maximumFractionDigits: 0 })
        : null;
      const advLink = row.adviser_crd ? ` • adv CRD ${row.adviser_crd}` : '';
      results.push({
        type: 'adv_fund',
        id: String(row.reference_id || row.fund_name),
        label: row.fund_name,
        sublabel: `${row.fund_type || 'ADV fund'}${advLink}${gav ? ' • ' + gav : ''}`,
        url: row.adviser_crd ? `/intel/adviser/${encodeURIComponent(row.adviser_crd)}` : null,
        rank: score(row.fund_name) + 10,
      });
    }
    for (const row of (formdRes.data || [])) {
      const amt = row.totalofferingamount
        ? '$' + Number(row.totalofferingamount).toLocaleString(undefined, { maximumFractionDigits: 0 })
        : null;
      results.push({
        type: 'formd_filing',
        id: row.accessionnumber,
        label: row.entityname,
        sublabel: `Form D • ${row.filing_date || ''}${amt ? ' • ' + amt : ''}`,
        url: edgarFilingUrlServer(row.cik, row.accessionnumber),
        external: true,
        rank: score(row.entityname),
      });
    }

    // Rank desc then label asc as tiebreaker
    results.sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label));

    res.json({
      query: q,
      total: results.length,
      by_source: {
        companies: (companiesRes.data || []).length,
        advisers: (advisersRes.data || []).length,
        adv_funds: (fundsRes.data || []).length,
        formd_filings: (formdRes.data || []).length,
      },
      results,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// Same shape as frontend's edgarFilingUrl helper — duplicated server-side
// for the search response (avoids the frontend having to know CIK semantics).
function edgarFilingUrlServer(cik, accession) {
  if (!cik || !accession) return null;
  const cikInt = String(cik).replace(/^0+/, '') || '0';
  const accNoDashes = String(accession).replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/`;
}

// ----------------------------------------------------------------------------
// Adviser-centric endpoint — "all the funds adviser CRD X holds across every
// tracked private company, plus firm metadata."
// ----------------------------------------------------------------------------

router.get('/advisers/:crd', async (req, res) => {
  if (!configGuard(res)) return;
  try {
    const crdParam = String(req.params.crd || '').trim();
    if (!crdParam) {
      return res.status(400).json({ error: 'crd required', code: 'MISSING_CRD' });
    }

    // 1. Adviser firm metadata (advisers_enriched). We may not have the firm
    //    in advisers_enriched if it's pure-Form-D — handle that with a 404.
    const details = await fetchAdviserDetails(deps.advClient, [crdParam]);
    const advDetail = details[crdParam];
    const extras = await fetchEnrichedExtras(deps.formdClient, [crdParam]);
    const extra = extras[crdParam] || {};
    const personEnrichmentMap = await fetchPersonEnrichment(deps.nportClient, [crdParam]);
    const personEnrichmentForCrd = personEnrichmentMap[crdParam] || {};
    if (!advDetail && !extra) {
      return notFound(res, `Adviser CRD ${crdParam} not found`, 'ADVISER_NOT_FOUND');
    }

    // 2. All holdings for this CRD across every tracked company.
    //    Keyset-paginate the view.
    const allRows = [];
    let lastId = 0;
    while (true) {
      const { data, error } = await deps.nportClient
        .from('v_intel_company_holders')
        .select('*')
        .eq('adviser_crd', crdParam)
        .gt('evidence_id', lastId)
        .order('evidence_id')
        .limit(1000);
      if (error) throw error;
      const batch = data || [];
      if (!batch.length) break;
      allRows.push(...batch);
      lastId = parseInt(batch[batch.length - 1].evidence_id, 10);
      if (batch.length < 1000) break;
    }

    // 3. Look up display names + lifecycle for every company that appears
    //    in this adviser's holdings.
    const companySlugs = Array.from(new Set(allRows.map(r => r.company_slug).filter(Boolean)));
    const companyMeta = {};
    if (companySlugs.length) {
      for (let i = 0; i < companySlugs.length; i += 200) {
        const chunk = companySlugs.slice(i, i + 200);
        const { data, error } = await deps.nportClient
          .from('private_companies')
          .select('slug,display_name,sector,lifecycle_status,is_public,is_acquired,primary_domain,latest_known_valuation_usd')
          .in('slug', chunk);
        if (error) throw error;
        for (const row of (data || [])) companyMeta[row.slug] = row;
      }
    }

    // 4. Bucket holdings by company + source type. Filter to private/unknown
    //    rows unless ?audit=1.
    const audit = req.query.audit === '1' || req.query.audit === 'true';
    const byCompany = {};
    for (const r of allRows) {
      if (!audit && !(r.status_at_evidence_date === 'private' || r.status_at_evidence_date === 'unknown')) {
        continue;
      }
      const slug = r.company_slug;
      if (!byCompany[slug]) {
        const c = companyMeta[slug] || {};
        byCompany[slug] = {
          slug,
          display_name: c.display_name || slug,
          sector: c.sector || null,
          lifecycle_status: c.lifecycle_status || null,
          is_public: c.is_public || false,
          is_acquired: c.is_acquired || false,
          primary_domain: c.primary_domain || null,
          latest_known_valuation_usd: c.latest_known_valuation_usd || null,
          total_value_usd: 0,
          evidence_count: 0,
          nport_holdings: [],
          formd_holdings: [],
        };
      }
      const v = r.value_usd ? parseFloat(r.value_usd) : 0;
      byCompany[slug].evidence_count += 1;
      if (Number.isFinite(v)) byCompany[slug].total_value_usd += v;

      const evidence = {
        evidence_id: r.evidence_id,
        registrant_or_filer_cik: r.evidence_cik,
        series_id: r.evidence_series_id,
        label: r.evidence_label,
        value_usd: Number.isFinite(v) ? v : null,
        evidence_date: r.evidence_date,
        accession_number: r.accession_number,
        adviser_method: r.adviser_resolution_method,
        status_at_evidence_date: r.status_at_evidence_date,
        was_private_at_evidence_date: r.was_private_at_evidence_date,
      };
      if (r.source_type === 'nport') {
        byCompany[slug].nport_holdings.push(evidence);
      } else if (r.source_type === 'formd_pooled_vehicle') {
        byCompany[slug].formd_holdings.push(evidence);
      }
    }

    const companies = Object.values(byCompany)
      .sort((a, b) => b.total_value_usd - a.total_value_usd);

    // 5. Roll up summary
    const summary = {
      distinct_companies: companies.length,
      total_value_usd: companies.reduce((acc, c) => acc + c.total_value_usd, 0),
      total_evidence_count: companies.reduce((acc, c) => acc + c.evidence_count, 0),
      audit_mode: audit,
    };

    // 6. Adviser block (normalized names mirror /companies/:slug/holders)
    const adviser = advDetail ? {
      crd: crdParam,
      name: advDetail.adviser_name || null,
      total_aum: advDetail.total_aum || null,
      phone: advDetail.phone_number || null,
      website: pickCanonicalDomain(advDetail.primary_website, advDetail.other_websites, extra.website_url),
      cco_name: normalizeName(advDetail.cco_name),
      cco_email: advDetail.cco_email || null,
      signatory_name: normalizeName(advDetail.signatory_name),
      signatory_title: advDetail.signatory_title || null,
      owner_full_legal_name: advDetail.owner_full_legal_name || null,
      owners: normalizeOwnersList(advDetail.owner_full_legal_name),
      owner_title_or_status: advDetail.owner_title_or_status || null,
      ownership_amount: advDetail.ownership_amount || null,
      control_person_name: normalizeName(advDetail.control_person_name),
      regulatory_contact_name: normalizeName(advDetail.regulatory_contact_name),
      regulatory_contact_email: advDetail.regulatory_contact_email || null,
      form_adv_url: advDetail.form_adv_url || null,
      linkedin_company_url: extra.linkedin_company_url || null,
      team_members: teamMembersToStructured(extra.team_members),
      team_members_text: teamMembersToText(extra.team_members) || null,
      alt_contact_email: extra.primary_contact_email || null,
      twitter_handle: extra.twitter_handle || null,
      person_enrichment: personEnrichmentForCrd,
    } : {
      crd: crdParam,
      name: null,
      total_aum: null,
      phone: null,
      website: null,
      cco_name: null,
      cco_email: null,
      signatory_name: null,
      owners: [],
      form_adv_url: null,
      linkedin_company_url: extra.linkedin_company_url || null,
      team_members: teamMembersToStructured(extra.team_members),
      team_members_text: teamMembersToText(extra.team_members) || null,
      alt_contact_email: extra.primary_contact_email || null,
      twitter_handle: extra.twitter_handle || null,
      person_enrichment: personEnrichmentForCrd,
      not_in_advisers_enriched: true,
    };

    res.json({ adviser, summary, companies });
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
