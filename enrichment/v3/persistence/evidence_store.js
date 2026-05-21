/**
 * evidence_store.js — Read/write field_evidence + candidates JSONB columns.
 *
 * v3 writes BOTH the new field_evidence/candidates/verified_anchor columns
 * AND the legacy flat columns (website_url, linkedin_company_url, team_members)
 * so existing API endpoints in server.js keep working.
 *
 * Legacy column write policy:
 *   - Write ONLY when the corresponding field has status === 'verified'
 *   - Otherwise leave null (the firebreak gate in server.js suppresses display)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { createClient } = require('@supabase/supabase-js');

const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY;
if (!FORMD_KEY) throw new Error('Missing required env var: FORMD_SERVICE_KEY');

const formdDb = createClient(FORMD_URL, FORMD_KEY);

/**
 * Derive enrichment_status from field_evidence decisions.
 * verified > partial > candidates_only > no_data
 */
function deriveEnrichmentStatus(decisions) {
  const statuses = Object.values(decisions)
    .flat()
    .map(d => d.status)
    .filter(s => s && s !== 'no_data' && s !== 'rejected');

  if (statuses.length === 0) return 'no_data';
  if (statuses.includes('verified')) {
    const allVerified = statuses.every(s => s === 'verified');
    return allVerified ? 'verified' : 'partial';
  }
  if (statuses.includes('candidate')) return 'candidates_only';
  return 'no_data';
}

/**
 * Map v3-style status to the legacy enrichment_status values that server.js
 * and the existing CHECK constraint expect.
 *
 * Valid legacy values: auto_enriched | candidates_only | no_data_found | manually_verified
 *
 * Mapping:
 *   - Any website or linkedin field is verified → auto_enriched
 *   - Some evidence exists but no website/linkedin anchor → candidates_only (auto-retry eligible)
 *   - Nothing useful found → no_data_found
 *
 * NOTE: needs_manual_review is intentionally NOT written — that status dead-queues rows
 * with no auto-retry path. candidates_only rows are re-enriched automatically.
 */
function deriveLegacyEnrichmentStatus(decisions) {
  const websiteDecision = decisions['website_url'];
  const linkedInDecision = decisions['linkedin_company_url'];

  const websiteVerified = websiteDecision?.status === 'verified';
  const linkedInVerified = linkedInDecision?.status === 'verified';

  if (websiteVerified || linkedInVerified) {
    return 'auto_enriched';
  }

  // Some evidence exists but no verified anchor — keep in auto-retry queue
  const anyEvidence = Object.values(decisions)
    .flat()
    .some(d => d && (d.status === 'verified' || d.status === 'candidate'));

  if (anyEvidence) {
    return 'candidates_only';
  }

  return 'no_data_found';
}

/**
 * Derive confidence_score from verified field count (legacy display).
 */
function deriveLegacyConfidence(decisions) {
  const POSSIBLE_FIELDS = ['website_url', 'linkedin_company_url', 'primary_contact_email', 'team_members'];
  let verified = 0;
  for (const field of POSSIBLE_FIELDS) {
    const d = decisions[field];
    if (!d) continue;
    const arr = Array.isArray(d) ? d : [d];
    if (arr.some(item => item.status === 'verified')) verified++;
  }
  return Math.min(verified / POSSIBLE_FIELDS.length, 1.0);
}

/**
 * Build field_evidence JSONB from decisions map.
 */
function buildFieldEvidence(decisions) {
  const fe = {};

  // Scalar fields
  for (const field of ['website_url', 'linkedin_company_url', 'primary_contact_email', 'twitter_handle']) {
    const d = decisions[field];
    if (!d) continue;
    if (d.status === 'no_data') continue;
    fe[field] = {
      value: d.value,
      status: d.status,
      anchors: d.anchors || [],
      evidence: d.evidence || [],
      decided_at: d.decided_at,
      reason: d.reason,
    };
  }

  // Team members (array)
  const teamDecisions = decisions['team_members'];
  if (Array.isArray(teamDecisions) && teamDecisions.length > 0) {
    fe['team_members'] = teamDecisions
      .filter(d => d.status !== 'no_data')
      .map(d => ({
        ...d.value,
        status: d.status,
        anchors: d.anchors || [],
        evidence: d.evidence || [],
        reason: d.reason,
        decided_at: d.decided_at,
      }));
  }

  return fe;
}

/**
 * Build candidates JSONB from below-bar decisions.
 * Candidates are never published; stored for next retry.
 */
function buildCandidates(decisions) {
  const cands = {};

  for (const field of ['website_url', 'linkedin_company_url']) {
    const d = decisions[field];
    if (!d || d.status !== 'candidate') continue;
    cands[field] = [{
      value: d.value,
      score: 0.4, // placeholder — could be enriched with a proper scoring model later
      evidence: d.evidence || [],
    }];
  }

  const teamDecisions = decisions['team_members'];
  if (Array.isArray(teamDecisions)) {
    const candidateTeam = teamDecisions.filter(d => d.status === 'candidate');
    if (candidateTeam.length > 0) {
      cands['team_members'] = candidateTeam.map(d => ({
        ...d.value,
        score: 0.3,
        evidence: d.evidence || [],
      }));
    }
  }

  return cands;
}

/**
 * Build verified_anchor TEXT[] from decisions.
 */
function buildVerifiedAnchor(decisions, identity) {
  const anchors = new Set();

  if (identity && identity.anchor === 'sec_adv_crd' && identity.crd) {
    anchors.add('sec_adv_crd');
  }

  for (const field of ['website_url', 'linkedin_company_url']) {
    const d = decisions[field];
    if (!d || d.status !== 'verified') continue;
    for (const a of (d.anchors || [])) {
      if (a.startsWith('sec_adv_crd')) anchors.add('sec_adv_crd');
      if (a === 'website_links_to_linkedin') anchors.add('linkedin_self');
      if (a === 'found_on_verified_website') anchors.add('website_self');
    }
  }

  return Array.from(anchors);
}

/**
 * Save enrichment decisions to enriched_managers.
 * Writes both v3 columns and legacy flat columns.
 *
 * @param {string} seriesMasterLlc - The manager name key
 * @param {object} decisions - Map of field → Decision (from orchestrator)
 * @param {object} identity - resolveIdentity() result
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh=false]
 * @returns {Promise<boolean>}
 */
async function save(seriesMasterLlc, decisions, identity, opts = {}) {
  const forceRefresh = !!opts.forceRefresh;

  const fieldEvidence = buildFieldEvidence(decisions);
  const candidates = buildCandidates(decisions);
  const verifiedAnchor = buildVerifiedAnchor(decisions, identity);
  const enrichmentStatus = deriveEnrichmentStatus(decisions);
  const confidenceScore = deriveLegacyConfidence(decisions);
  const now = new Date().toISOString();

  // Legacy flat columns — only set when verified
  const websiteDecision = decisions['website_url'];
  const linkedInDecision = decisions['linkedin_company_url'];
  const emailDecision = decisions['primary_contact_email'];
  const teamDecisions = decisions['team_members'];

  const legacyWebsite = websiteDecision?.status === 'verified' ? websiteDecision.value : null;
  const legacyLinkedIn = linkedInDecision?.status === 'verified' ? linkedInDecision.value : null;
  const legacyEmail = emailDecision?.status === 'verified' ? emailDecision.value : null;
  const legacyTeam = Array.isArray(teamDecisions)
    ? teamDecisions
        .filter(d => d.status === 'verified')
        .map(d => d.value)
    : [];

  const payload = {
    series_master_llc: seriesMasterLlc,
    // v3 columns
    field_evidence: fieldEvidence,
    candidates: Object.keys(candidates).length > 0 ? candidates : null,
    verified_anchor: verifiedAnchor.length > 0 ? verifiedAnchor : null,
    last_retry_at: now,
    // Legacy columns (only when verified)
    website_url: legacyWebsite,
    linkedin_company_url: legacyLinkedIn,
    primary_contact_email: legacyEmail,
    team_members: legacyTeam.length > 0 ? legacyTeam : [],
    // Status + metadata
    enrichment_status: deriveLegacyEnrichmentStatus(decisions),
    v3_status: enrichmentStatus,
    confidence_score: confidenceScore,
    enrichment_source: 'automated_v3',
    enrichment_date: now,
    last_updated: now,
    // CRD if resolved
    linked_crd: identity?.crd || null,
  };

  // Check for existing record
  try {
    const { data: existing } = await formdDb
      .from('enriched_managers')
      .select('id, enrichment_status')
      .eq('series_master_llc', seriesMasterLlc)
      .limit(1);

    const existingRow = existing?.[0];

    if (existingRow) {
      // Don't overwrite manually-verified rows unless forced
      if (!forceRefresh && existingRow.enrichment_status === 'manually_verified') {
        console.log(`[evidence_store] Skipping manually_verified row: ${seriesMasterLlc}`);
        return true;
      }

      const { error } = await formdDb
        .from('enriched_managers')
        .update(payload)
        .eq('id', existingRow.id);

      if (error) {
        console.error('[evidence_store] Update error:', error.message);
        return false;
      }
      return true;
    }

    // Insert new row
    const { error } = await formdDb
      .from('enriched_managers')
      .insert(payload);

    if (error) {
      console.error('[evidence_store] Insert error:', error.message);
      return false;
    }
    return true;

  } catch (err) {
    console.error('[evidence_store] save error:', err.message);
    return false;
  }
}

/**
 * Read existing field_evidence for a manager.
 *
 * @param {string} seriesMasterLlc
 * @returns {Promise<object|null>}
 */
async function read(seriesMasterLlc) {
  try {
    const { data, error } = await formdDb
      .from('enriched_managers')
      .select('field_evidence, candidates, verified_anchor, enrichment_status, last_retry_at, next_retry_at')
      .eq('series_master_llc', seriesMasterLlc)
      .limit(1);

    if (error || !data?.length) return null;
    return data[0];
  } catch (err) {
    console.error('[evidence_store] read error:', err.message);
    return null;
  }
}

module.exports = {
  save,
  read,
  buildFieldEvidence,
  buildCandidates,
  buildVerifiedAnchor,
  deriveEnrichmentStatus,
  deriveLegacyConfidence,
};
