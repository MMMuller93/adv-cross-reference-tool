/**
 * orchestrator.js — Public entry point for enrichment v3.
 *
 * enrichManager(name, opts) → result
 *
 * Pipeline:
 *   1. resolveIdentity  — SEC CRD lookup, external DB
 *   2. fetchEvidence    — SEC ADV, external DB, web search, website HTML, LinkedIn
 *   3. decide           — per-field verification rules
 *   4. save             — write field_evidence + legacy flat columns
 *   5. schedule retry   — if below-bar
 *   6. return           — public view
 */

'use strict';

const { resolveIdentity } = require('./identity');
const secAdv = require('./sources/sec_adv');
const externalDb = require('./sources/external_db');
const webSearch = require('./sources/web_search');
const websiteFetch = require('./sources/website_fetch');
const linkedInSearch = require('./sources/linkedin_search');
const websiteRules = require('./verification/website_rules');
const linkedInRules = require('./verification/linkedin_rules');
const teamRules = require('./verification/team_rules');
const { save, deriveEnrichmentStatus, buildVerifiedAnchor } = require('./persistence/evidence_store');
const { scheduleRetry } = require('./persistence/retry_queue');
const { buildPublicViewFromDecisions } = require('./publish/public_view');

/**
 * Decide email field from all evidence.
 */
function decideEmail(allEvidence) {
  const emailEvidence = allEvidence.filter(e => e.type === 'primary_contact_email');
  if (emailEvidence.length === 0) return { status: 'no_data', value: null, anchors: [], evidence: [] };

  // Prefer evidence with a strong anchor (from website or SEC ADV)
  const anchored = emailEvidence.find(e => e.anchor && e.anchor !== null);
  if (anchored) {
    return {
      status: 'verified',
      value: anchored.value,
      anchors: [anchored.anchor],
      evidence: [{ source: anchored.source, field: anchored.field, captured_at: anchored.captured_at }],
      decided_at: new Date().toISOString(),
      reason: `anchored_by:${anchored.anchor}`,
    };
  }

  // Unanchored email → candidate
  const first = emailEvidence[0];
  return {
    status: 'candidate',
    value: first.value,
    anchors: [],
    evidence: [{ source: first.source, field: first.field, captured_at: first.captured_at }],
    decided_at: new Date().toISOString(),
    reason: 'unanchored_email_candidate',
  };
}

/**
 * Main enrichment function. Replaces enrichManager in enrichment_engine_v2.js
 * when ENRICHMENT_V3_ENABLED=true.
 *
 * @param {string} name - The series_master_llc name from Form D
 * @param {object} opts
 * @param {boolean} [opts.skipValidation=false] - Skip website AI validation (for tests)
 * @param {boolean} [opts.forceRefresh=false] - Overwrite existing verified data
 * @param {string} [opts.relatedNames] - Pipe-separated Form D related persons
 * @param {string} [opts.relatedRoles] - Pipe-separated Form D related roles
 * @param {boolean} [opts.dryRun=false] - Don't persist; just return decisions
 * @returns {Promise<object>} Public view object + full field_evidence for inspection
 */
async function enrichManager(name, opts = {}) {
  const startTime = Date.now();
  const { forceRefresh = false, dryRun = false, relatedNames, relatedRoles } = opts;

  console.log(`\n[v3] Starting enrichment: ${name}`);

  // ── 1. Identity resolution ──────────────────────────────────────────────────
  const identity = await resolveIdentity(name, { relatedNames, relatedRoles });
  console.log(`[v3] Identity: resolved=${identity.resolved}, crd=${identity.crd || 'none'}, anchor=${identity.anchor || 'none'}`);

  // ── 2. Fetch evidence from all sources ─────────────────────────────────────

  // SEC ADV evidence (only useful if identity resolved to a CRD)
  const advEvidence = await secAdv.fetchEvidence(identity);

  // External DB evidence
  const extEvidence = await externalDb.fetchEvidence(identity);

  // Web search: website candidates + LinkedIn candidates (parallel)
  const [webCandidates, liCandidates] = await Promise.all([
    webSearch.findWebsiteCandidates(identity),
    webSearch.findLinkedInCandidates(identity),
  ]);

  // Merge all evidence so far for first-pass website decision
  const allEvidencePreFetch = [
    ...advEvidence,
    ...extEvidence,
    ...webCandidates,
    ...liCandidates,
  ];

  // ── 3. First-pass website decision (needed to decide whether to fetch HTML) ─
  const websiteDecisionPre = websiteRules.decide(allEvidencePreFetch, identity);
  console.log(`[v3] Website pre-fetch decision: ${websiteDecisionPre.status} → ${websiteDecisionPre.value || 'null'}`);

  // ── 4. Website HTML fetch (if we have a candidate) ─────────────────────────
  let websiteHtmlEvidence = [];
  let candidateWebsiteUrl = websiteDecisionPre.value;

  // If identity gave us a primary_website, always try to fetch it
  if (!candidateWebsiteUrl && identity.primary_website) {
    candidateWebsiteUrl = identity.primary_website;
  }

  if (candidateWebsiteUrl) {
    const managerName = identity.adviser_name || name;
    websiteHtmlEvidence = await websiteFetch.fetchEvidence(candidateWebsiteUrl, managerName);
    console.log(`[v3] Website HTML fetch: ${websiteHtmlEvidence.length} evidence items from ${candidateWebsiteUrl}`);
  }

  // ── 5. LinkedIn-from-slug fallback (if no website found yet) ───────────────
  let slugWebsiteEvidence = [];
  if (!candidateWebsiteUrl) {
    // Try to derive website from any LinkedIn company URL
    const liCandidate = liCandidates.find(e => e.type === 'linkedin_company_url');
    if (liCandidate) {
      const derived = await websiteFetch.deriveWebsiteFromLinkedInSlug(liCandidate.value);
      if (derived) {
        slugWebsiteEvidence.push({
          type: 'website_url',
          value: derived,
          source: 'website_from_linkedin_slug',
          anchor: null,
          strength: 'medium',
          captured_at: new Date().toISOString(),
        });
        // Also fetch HTML from derived website
        const extraHtml = await websiteFetch.fetchEvidence(derived, identity.adviser_name || name);
        websiteHtmlEvidence = [...websiteHtmlEvidence, ...extraHtml];
      }
    }
  }

  // ── 6. LinkedIn people search ───────────────────────────────────────────────
  const liPeopleCandidates = await linkedInSearch.findTeamCandidates(identity);

  // ── 7. Merge all evidence ───────────────────────────────────────────────────
  const allEvidence = [
    ...advEvidence,
    ...extEvidence,
    ...webCandidates,
    ...liCandidates,
    ...websiteHtmlEvidence,
    ...slugWebsiteEvidence,
    ...liPeopleCandidates,
  ];

  // ── 8. Final verification decisions ────────────────────────────────────────
  const websiteDecision = websiteRules.decide(allEvidence, identity);
  const linkedInDecision = linkedInRules.decide(allEvidence, identity, websiteDecision);
  const teamDecisions = teamRules.decide(allEvidence, identity, websiteDecision, linkedInDecision);
  const emailDecision = decideEmail(allEvidence);

  const decisions = {
    website_url: websiteDecision,
    linkedin_company_url: linkedInDecision,
    primary_contact_email: emailDecision,
    team_members: teamDecisions,
  };

  console.log(`[v3] Decisions: website=${websiteDecision.status}, linkedin=${linkedInDecision.status}, team=${teamDecisions.filter(d => d.status === 'verified').length} verified`);

  // ── 9. Derive metadata ──────────────────────────────────────────────────────
  const enrichmentStatus = deriveEnrichmentStatus(decisions);
  const verifiedAnchor = buildVerifiedAnchor(decisions, identity);

  // ── 10. Persist (unless dry run) ────────────────────────────────────────────
  if (!dryRun) {
    await save(name, decisions, identity, { forceRefresh });

    // Schedule retry if below-bar
    if (['candidates_only', 'partial', 'no_data'].includes(enrichmentStatus)) {
      await scheduleRetry(name, enrichmentStatus, 0);
    }
  }

  const duration = Date.now() - startTime;
  console.log(`[v3] Complete: ${name} | status=${enrichmentStatus} | duration=${duration}ms`);

  // ── 11. Return public view ──────────────────────────────────────────────────
  return buildPublicViewFromDecisions(decisions, enrichmentStatus, verifiedAnchor);
}

module.exports = { enrichManager };
