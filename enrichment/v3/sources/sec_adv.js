/**
 * sec_adv.js — Fetch evidence from SEC ADV (advisers_enriched).
 *
 * Uses the resolved identity (crd) to pull structured data:
 * website, phone, CCO email. Returns Evidence[] objects.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { createClient } = require('@supabase/supabase-js');

const ADV_URL = process.env.ADV_URL || 'https://ezuqwwffjgfzymqxsctq.supabase.co';
const ADV_KEY = process.env.ADV_SERVICE_KEY;
if (!ADV_KEY) throw new Error('Missing required env var: ADV_SERVICE_KEY');

const advDb = createClient(ADV_URL, ADV_KEY);

// Social/noisy hosts that should not be treated as primary websites
const NOISY_HOSTS = [
  'instagram', 'facebook', 'twitter', 'linkedin', 'youtube',
  'plynk', 'apple.com', 'play.google',
];

/**
 * Fetch evidence from SEC ADV for a resolved identity.
 *
 * @param {object} identity - Result from resolveIdentity()
 * @returns {Promise<Evidence[]>}
 */
async function fetchEvidence(identity) {
  const evidence = [];

  if (!identity || !identity.crd) return evidence;

  try {
    const { data: row, error } = await advDb
      .from('advisers_enriched')
      .select('crd, adviser_name, primary_website, other_websites, phone_number, cco_email, registration_type')
      .eq('crd', identity.crd)
      .single();

    if (error || !row) return evidence;

    const capturedAt = new Date().toISOString();
    const source = `sec_adv:crd:${row.crd}`;

    // Website evidence
    const websites = [];
    if (row.primary_website && !NOISY_HOSTS.some(h => row.primary_website.toLowerCase().includes(h))) {
      websites.push({ url: row.primary_website, field: 'primary_website' });
    }
    if (row.other_websites) {
      const others = Array.isArray(row.other_websites) ? row.other_websites : [row.other_websites];
      for (const w of others) {
        if (w && !NOISY_HOSTS.some(h => w.toLowerCase().includes(h))) {
          websites.push({ url: w, field: 'other_websites' });
        }
      }
    }

    for (const w of websites) {
      evidence.push({
        type: 'website_url',
        value: w.url,
        source,
        field: w.field,
        anchor: `sec_adv_crd:${row.crd}`,
        strength: 'strong', // SEC-reported, high trust
        captured_at: capturedAt,
      });
    }

    // CCO email evidence
    if (row.cco_email) {
      evidence.push({
        type: 'primary_contact_email',
        value: row.cco_email.toLowerCase(),
        source,
        field: 'cco_email',
        anchor: `sec_adv_crd:${row.crd}`,
        strength: 'strong',
        captured_at: capturedAt,
      });
    }

    // Phone evidence
    if (row.phone_number) {
      evidence.push({
        type: 'phone_number',
        value: row.phone_number,
        source,
        field: 'phone_number',
        anchor: `sec_adv_crd:${row.crd}`,
        strength: 'strong',
        captured_at: capturedAt,
      });
    }

  } catch (err) {
    console.error('[sec_adv] fetchEvidence error:', err.message);
  }

  return evidence;
}

module.exports = { fetchEvidence };
