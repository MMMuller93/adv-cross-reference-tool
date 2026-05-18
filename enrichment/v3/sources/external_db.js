/**
 * external_db.js — Fetch evidence from OpenVC/Ramp external investor cache.
 *
 * Wraps the existing external_investor_lookup module. Returns Evidence[].
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { createClient } = require('@supabase/supabase-js');
const { ensureLoaded, lookupInvestor } = require('../../external_investor_lookup');

const FORMD_URL = process.env.FORMD_URL || 'https://ltdalxkhbbhmkimmogyq.supabase.co';
const FORMD_KEY = process.env.FORMD_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc';

const formdDb = createClient(FORMD_URL, FORMD_KEY);

/**
 * Fetch evidence from external investor DB for all identity variants.
 *
 * @param {object} identity - Result from resolveIdentity()
 * @returns {Promise<Evidence[]>}
 */
async function fetchEvidence(identity) {
  const evidence = [];

  try {
    await ensureLoaded(formdDb);
  } catch (err) {
    console.error('[external_db] Failed to load investor reference:', err.message);
    return evidence;
  }

  const variants = identity.variants_tried || [];
  if (identity.matched_variant && !variants.includes(identity.matched_variant)) {
    variants.push(identity.matched_variant);
  }

  const capturedAt = new Date().toISOString();
  const seen = new Set();

  for (const variant of variants) {
    const ext = lookupInvestor(variant);
    if (!ext) continue;

    const dedupKey = ext.investor_name;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const source = `external_db:${ext.source || 'unknown'}`;

    if (ext.website_url) {
      evidence.push({
        type: 'website_url',
        value: ext.website_url,
        source,
        field: 'website_url',
        anchor: null, // external DB is not an anchor — needs corroboration
        strength: 'medium',
        captured_at: capturedAt,
        matched_name: ext.investor_name,
      });
    }

    if (ext.linkedin_url) {
      evidence.push({
        type: 'linkedin_company_url',
        value: ext.linkedin_url,
        source,
        field: 'linkedin_url',
        anchor: null,
        strength: 'medium',
        captured_at: capturedAt,
        matched_name: ext.investor_name,
      });
    }

    if (ext.primary_contact_email) {
      evidence.push({
        type: 'primary_contact_email',
        value: ext.primary_contact_email,
        source,
        field: 'primary_contact_email',
        anchor: null,
        strength: 'medium',
        captured_at: capturedAt,
        matched_name: ext.investor_name,
      });
    }

    if (ext.contact_name) {
      evidence.push({
        type: 'team_member',
        value: { name: ext.contact_name, title: null, source: source },
        source,
        field: 'contact_name',
        anchor: null,
        strength: 'weak',
        captured_at: capturedAt,
        matched_name: ext.investor_name,
      });
    }
  }

  return evidence;
}

module.exports = { fetchEvidence };
