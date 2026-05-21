/**
 * public_view.js — Per-field publish gate for enriched_managers rows.
 *
 * buildPublicView() is the single function all API endpoints call when
 * returning enriched manager data. It handles two row shapes:
 *
 *   v3 rows  — have a field_evidence JSONB column. Each field is emitted
 *              only when field_evidence[field].status === 'verified'.
 *
 *   v2 rows  — legacy flat columns only (no field_evidence). Each field is
 *              validated by shape (URL prefix, email regex, etc.) before emit.
 *
 * Both paths ALWAYS include enrichment_status in the output and maintain
 * backward-compatible field names (website, linkedin, twitter, email,
 * team_members, suppressed, is_published, confidence).
 */

'use strict';

const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Build public API payload from a persisted enriched_managers record.
 * Handles both v3 (field_evidence present) and v2 (legacy flat columns) rows.
 *
 * @param {object} record - Row from enriched_managers
 * @returns {object} Public payload safe to return from API endpoints
 */
function buildPublicView(record) {
  if (record.field_evidence && typeof record.field_evidence === 'object') {
    return _buildV3View(record);
  }
  return _buildV2View(record);
}

/**
 * v3 path: per-field evidence model.
 * Emit each field only when field_evidence[field].status === 'verified'.
 *
 * @private
 */
function _buildV3View(record) {
  const fe = record.field_evidence;

  const websiteVerified  = fe.website_url?.status === 'verified';
  const linkedInVerified = fe.linkedin_company_url?.status === 'verified';

  const website  = websiteVerified  ? fe.website_url.value           : null;
  const linkedin = linkedInVerified ? fe.linkedin_company_url.value  : null;
  const twitter  = fe.twitter_handle?.status === 'verified'          ? fe.twitter_handle.value         : null;
  const email    = fe.primary_contact_email?.status === 'verified'   ? fe.primary_contact_email.value  : null;

  const rawTeam = fe.team_members;
  const verifiedTeam = Array.isArray(rawTeam)
    ? rawTeam
        .filter(m => m.status === 'verified')
        .map(m => ({
          name:     m.name,
          title:    m.title    || null,
          email:    m.email    || null,
          linkedin: m.linkedin || null,
        }))
    : [];

  const hasAnyPublished = website || linkedin || twitter || email || verifiedTeam.length > 0;

  if (!hasAnyPublished) {
    return {
      enrichment_status: record.enrichment_status,
      suppressed: true,
      suppressed_reason: 'no_verified_fields',
    };
  }

  return {
    website,
    linkedin,
    twitter,
    email,
    team_members:     verifiedTeam,
    enrichment_status: record.enrichment_status,
    verified_anchor:   record.verified_anchor || [],
    suppressed:        false,
    is_published:      record.is_published,
    confidence:        record.confidence_score,
  };
}

/**
 * v2 path: legacy flat columns — validate field shape before emitting.
 *
 * @private
 */
function _buildV2View(record) {
  // website_url: must start with http:// or https://
  const website = (typeof record.website_url === 'string' &&
    /^https?:\/\//i.test(record.website_url))
    ? record.website_url
    : null;

  // linkedin_company_url: must be a linkedin.com URL
  const linkedin = (typeof record.linkedin_company_url === 'string' &&
    /^https?:\/\/(www\.)?linkedin\.com\//i.test(record.linkedin_company_url))
    ? record.linkedin_company_url
    : null;

  // primary_contact_email: basic email shape check
  const email = (typeof record.primary_contact_email === 'string' &&
    BASIC_EMAIL_RE.test(record.primary_contact_email))
    ? record.primary_contact_email
    : null;

  // twitter_handle: publish if non-empty string
  const twitter = (typeof record.twitter_handle === 'string' && record.twitter_handle.trim())
    ? record.twitter_handle.trim()
    : null;

  // team_members: non-empty array, defensively drop linkedin_search-sourced members
  let teamMembers = [];
  if (Array.isArray(record.team_members) && record.team_members.length > 0) {
    teamMembers = record.team_members
      .filter(m => m && m.source !== 'linkedin_search')
      .map(m => ({
        name:     m.name,
        title:    m.title    || null,
        email:    m.email    || null,
        linkedin: m.linkedin || null,
      }));
  }

  const hasAnyPublished = website || linkedin || email || twitter || teamMembers.length > 0;

  if (!hasAnyPublished) {
    return {
      enrichment_status: record.enrichment_status,
      suppressed: true,
      suppressed_reason: 'no_publishable_fields',
    };
  }

  return {
    website,
    linkedin,
    twitter,
    email,
    team_members:     teamMembers,
    enrichment_status: record.enrichment_status,
    verified_anchor:   record.verified_anchor || [],
    suppressed:        false,
    is_published:      record.is_published,
    confidence:        record.confidence_score,
  };
}

/**
 * Build a public view directly from a decisions map (for use in orchestrator
 * before the record is persisted, e.g., for smoke-test output).
 *
 * @param {object} decisions - Map of field → Decision from orchestrator
 * @param {string} enrichmentStatus - Derived status string
 * @param {string[]} verifiedAnchor - Verified anchor array
 * @returns {object}
 */
function buildPublicViewFromDecisions(decisions, enrichmentStatus, verifiedAnchor) {
  const websiteD  = decisions['website_url'];
  const linkedInD = decisions['linkedin_company_url'];

  const hasAnchor =
    websiteD?.status === 'verified' ||
    linkedInD?.status === 'verified';

  if (!hasAnchor) {
    return {
      enrichment_status: enrichmentStatus || 'no_data',
      suppressed: true,
      suppressed_reason: 'no_company_anchor',
    };
  }

  const teamDecisions = decisions['team_members'] || [];
  const verifiedTeam = teamDecisions
    .filter(d => d.status === 'verified')
    .map(d => ({
      name:     d.value?.name,
      title:    d.value?.title    || null,
      email:    d.value?.email    || null,
      linkedin: d.value?.linkedin || null,
    }));

  return {
    website:          websiteD?.status  === 'verified' ? websiteD.value    : null,
    linkedin:         linkedInD?.status === 'verified' ? linkedInD.value   : null,
    twitter:          decisions['twitter_handle']?.status === 'verified' ? decisions['twitter_handle'].value : null,
    email:            decisions['primary_contact_email']?.status === 'verified' ? decisions['primary_contact_email'].value : null,
    team_members:     verifiedTeam,
    enrichment_status: enrichmentStatus,
    verified_anchor:   verifiedAnchor || [],
    suppressed:        false,
    // Include field_evidence for smoke-test inspection
    field_evidence: {
      website_url:          websiteD  || null,
      linkedin_company_url: linkedInD || null,
      team_members:         teamDecisions,
    },
  };
}

module.exports = { buildPublicView, buildPublicViewFromDecisions };
