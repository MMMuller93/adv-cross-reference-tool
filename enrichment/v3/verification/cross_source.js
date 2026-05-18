/**
 * cross_source.js — Multi-source agreement helpers.
 *
 * Detects conflicts between sources and promotes candidates when multiple
 * independent sources agree on a value.
 */

'use strict';

const { hostname } = require('./website_rules');

/**
 * Check if two website URLs agree (same effective domain).
 */
function websitesAgree(urlA, urlB) {
  if (!urlA || !urlB) return false;
  return hostname(urlA) === hostname(urlB);
}

/**
 * Given multiple website decisions from different source passes,
 * check if any two agree on the same domain — that's corroboration.
 *
 * @param {Decision[]} decisions - Array of website decisions from different sources
 * @returns {{ agreed: boolean, value: string|null, sources: string[] }}
 */
function checkWebsiteAgreement(decisions) {
  const withValues = decisions.filter(d => d.value);
  if (withValues.length < 2) return { agreed: false, value: null, sources: [] };

  for (let i = 0; i < withValues.length; i++) {
    for (let j = i + 1; j < withValues.length; j++) {
      if (websitesAgree(withValues[i].value, withValues[j].value)) {
        return {
          agreed: true,
          value: withValues[i].value,
          sources: [withValues[i].reason, withValues[j].reason].filter(Boolean),
        };
      }
    }
  }

  return { agreed: false, value: null, sources: [] };
}

/**
 * Detect conflicts in evidence: multiple non-agreeing website candidates.
 *
 * @param {Evidence[]} websiteEvidence
 * @returns {{ conflict: boolean, values: string[] }}
 */
function detectWebsiteConflict(websiteEvidence) {
  const domains = [...new Set(
    websiteEvidence.map(e => hostname(e.value)).filter(Boolean)
  )];
  return {
    conflict: domains.length > 1,
    values: domains,
  };
}

module.exports = { checkWebsiteAgreement, detectWebsiteConflict, websitesAgree };
