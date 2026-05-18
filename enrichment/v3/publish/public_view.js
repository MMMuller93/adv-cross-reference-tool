/**
 * public_view.js — Apply "no anchor, no publish" rule and build public API payload.
 *
 * This is the single function all API endpoints call when returning enriched data.
 * Implements the publish gate from design doc §5 exactly.
 */

'use strict';

/**
 * Build the public API payload from a persisted enriched_managers record.
 *
 * Rules:
 *   - If no verified website AND no verified LinkedIn → suppress all contact/team fields
 *   - Otherwise return only verified fields; null for anything unverified
 *
 * @param {object} record - A row from enriched_managers (with field_evidence JSONB)
 * @returns {object} Public payload safe to return from API endpoints
 */
function buildPublicView(record) {
  const fe = record.field_evidence || {};

  const hasAnchor =
    fe.website_url?.status === 'verified' ||
    fe.linkedin_company_url?.status === 'verified';

  if (!hasAnchor) {
    return {
      enrichment_status: record.enrichment_status || 'no_data',
      suppressed: true,
      suppressed_reason: 'no_company_anchor',
    };
  }

  const verifiedTeam = (fe.team_members || []).filter(m => m.status === 'verified');

  return {
    website:          fe.website_url?.status         === 'verified' ? fe.website_url.value           : null,
    linkedin:         fe.linkedin_company_url?.status === 'verified' ? fe.linkedin_company_url.value  : null,
    twitter:          fe.twitter_handle?.status       === 'verified' ? fe.twitter_handle.value        : null,
    email:            fe.primary_contact_email?.status === 'verified' ? fe.primary_contact_email.value : null,
    team_members:     verifiedTeam.map(m => ({
      name:     m.name,
      title:    m.title || null,
      email:    m.email || null,
      linkedin: m.linkedin || null,
    })),
    enrichment_status: record.enrichment_status,
    verified_anchor:   record.verified_anchor || [],
    suppressed:        false,
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
      title:    d.value?.title || null,
      email:    d.value?.email || null,
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
