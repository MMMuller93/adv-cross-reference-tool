#!/usr/bin/env node
/**
 * enrich_linkedins.js — fill missing LinkedIns for CRM people + firms, with a
 * FIRM-NAME validation guard so we never grab the wrong "John Smith".
 *
 * The v3 manager engine suppresses unanchored LinkedIns (good — it stops
 * garbage like Starbridge->linkedin/wix-com), but that leaves easy person/firm
 * LinkedIns blank. This is a targeted catcher: search "{name} {firm}", accept a
 * linkedin.com/in/ (person) or /company/ (firm) result ONLY when the result
 * title/snippet ties back to the firm. Disambiguates by firm — e.g. the Augurey
 * Ventures Frank Cardia wins, the Blue Sky Financial one loses.
 *
 *   node nport/scripts/enrich_linkedins.js --kind person --limit 12        # dry-run
 *   node nport/scripts/enrich_linkedins.js --kind person --limit 12 --execute
 *   node nport/scripts/enrich_linkedins.js --kind firm   --limit 12
 */
'use strict';

require('dotenv').config({ path: '/Users/Miles_1/projects/PrivateFundsRadar/.env.nport' });
require('dotenv').config({ path: '/Users/Miles_1/projects/PrivateFundsRadar/.env' });
const { createClient } = require('@supabase/supabase-js');

const NPORT_URL = process.env.SUPABASE_URL_NPORT;
const NPORT_KEY = process.env.SUPABASE_SERVICE_KEY_NPORT;
const G_KEY = process.env.GOOGLE_API_KEY, G_CX = process.env.GOOGLE_CX;  // optional CSE fallback
if (!NPORT_URL || !NPORT_KEY) { console.error('FATAL: SUPABASE_URL_NPORT / SUPABASE_SERVICE_KEY_NPORT required'); process.exit(2); }
const db = createClient(NPORT_URL, NPORT_KEY);

const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const kind = argVal('--kind', 'person');
const limit = parseInt(argVal('--limit', '10')) || 10;
const execute = args.includes('--execute');

// Generic words that must NOT count as a firm-identity match.
const STOP = new Set(['llc', 'lp', 'inc', 'ltd', 'llp', 'capital', 'ventures', 'venture', 'partners',
  'management', 'advisors', 'advisers', 'fund', 'funds', 'group', 'holdings', 'company', 'co', 'the',
  'and', 'asset', 'investment', 'investments', 'global', 'securities', 'financial']);
const firmTokens = (firm) => (firm || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .split(/\s+/).filter(t => t.length > 2 && !STOP.has(t));
const tiesToFirm = (text, tokens) => { const t = (text || '').toLowerCase(); return tokens.some(tok => t.includes(tok)); };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const clean = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim();

// DuckDuckGo HTML — free, no API key, no daily quota (Brave + Serper are
// quota-exhausted as of 2026-06). Parses {link,title,snippet} from result blocks.
async function ddg(q) {
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const html = await r.text();
    const out = []; const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m;
    while ((m = re.exec(html))) {
      const tm = m[1].match(/uddg=([^&]+)/); const link = tm ? decodeURIComponent(tm[1]) : m[1];
      out.push({ link, title: clean(m[2]), snippet: '' });
    }
    const sr = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g; const sn = []; let s;
    while ((s = sr.exec(html))) sn.push(clean(s[1]));
    out.forEach((x, i) => { x.snippet = sn[i] || ''; });
    return out;
  } catch { return []; }
}

// Google CSE fallback (only if DDG returns nothing — rate-limited/blocked).
async function googleCSE(q) {
  if (!G_KEY || !G_CX) return [];
  try {
    const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${G_KEY}&cx=${G_CX}&q=${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.items || []).map(it => ({ link: it.link, title: it.title, snippet: it.snippet }));
  } catch { return []; }
}

async function search(q) {
  const d = await ddg(q);
  if (d.length) return d;
  return googleCSE(q);
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function enrichPeople() {
  const { data: people } = await db.from('crm_person')
    .select('person_id,full_name,linkedin_url,firm_id')
    .is('linkedin_url', null).not('firm_id', 'is', null).not('full_name', 'is', null)
    .limit(limit * 4);
  const firmIds = Array.from(new Set((people || []).map(p => p.firm_id)));
  const { data: firms } = await db.from('crm_firm').select('firm_id,display_name').in('firm_id', firmIds);
  const firmName = Object.fromEntries((firms || []).map(f => [f.firm_id, f.display_name]));
  const sample = (people || []).filter(p => firmName[p.firm_id]).slice(0, limit);

  console.log(`\n=== PERSON LinkedIns — ${sample.length} candidates (execute=${execute}) ===`);
  let matched = 0;
  for (const p of sample) {
    const firm = firmName[p.firm_id] || '';
    // Firm identity tokens, EXCLUDING any that are also the person's name — else
    // "Ken Bloom" trivially ties to "Bloom Advisors" via his own surname. Require
    // >=1 independent firm token so the firm match is real, not a name coincidence.
    const nameTokens = new Set((p.full_name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean));
    const tokens = firmTokens(firm).filter(t => !nameTokens.has(t));
    // Name guard: the result must also be THIS person (last name in title or slug).
    const lastName = ((p.full_name || '').trim().split(/\s+/).filter(Boolean).pop() || '').toLowerCase().replace(/[^a-z]/g, '');
    const nameOk = (o) => lastName.length < 3 || (o.title || '').toLowerCase().includes(lastName) || (o.link || '').toLowerCase().includes(lastName);
    const results = await search(`${p.full_name} ${firm} linkedin`);
    const hit = results.find(o => /linkedin\.com\/in\//i.test(o.link || '') && nameOk(o) && tokens.length &&
      (tiesToFirm(o.title, tokens) || tiesToFirm(o.snippet, tokens)));
    if (hit) {
      matched++;
      console.log(`  OK  ${p.full_name}  @ ${firm}`);
      console.log(`        -> ${hit.link}`);
      console.log(`        (${(hit.title || '').slice(0, 100)})`);
      if (execute) await db.from('crm_person').update({ linkedin_url: hit.link }).eq('person_id', p.person_id);
    } else {
      const any = results.find(o => /linkedin\.com\/in\//i.test(o.link || ''));
      console.log(`  --  ${p.full_name}  @ ${firm}  ${any ? `(found ${any.link} but firm not confirmed -> skipped)` : '(no /in/ result)'}`);
    }
    await delay(400);
  }
  console.log(`\n${matched}/${sample.length} confirmed.` + (execute ? ' Written.' : ' DRY RUN — re-run with --execute.'));
}

async function enrichFirms() {
  const { data: firms } = await db.from('crm_firm')
    .select('firm_id,display_name,website_url,linkedin_company_url')
    .is('linkedin_company_url', null).not('display_name', 'is', null)
    .limit(limit * 3);
  const sample = (firms || []).slice(0, limit);
  console.log(`\n=== FIRM LinkedIns — ${sample.length} candidates (execute=${execute}) ===`);
  let matched = 0;
  for (const f of sample) {
    const tokens = firmTokens(f.display_name);
    const results = await search(`${f.display_name} linkedin company`);
    const hit = results.find(o => /linkedin\.com\/company\//i.test(o.link || '') &&
      (tiesToFirm(o.title, tokens) || tiesToFirm(o.snippet, tokens)));
    if (hit) {
      matched++;
      console.log(`  OK  ${f.display_name}\n        -> ${hit.link}`);
      if (execute) await db.from('crm_firm').update({ linkedin_company_url: hit.link }).eq('firm_id', f.firm_id);
    } else {
      console.log(`  --  ${f.display_name}  (no firm-confirmed /company/ result)`);
    }
    await delay(400);
  }
  console.log(`\n${matched}/${sample.length} confirmed.` + (execute ? ' Written.' : ' DRY RUN — re-run with --execute.'));
}

(async () => {
  if (kind === 'firm') await enrichFirms();
  else if (kind === 'both') { await enrichPeople(); await enrichFirms(); }
  else await enrichPeople();
})().catch(e => { console.error('error:', e.message); process.exit(1); });
