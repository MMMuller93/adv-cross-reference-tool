/**
 * website_fetch.js — Fetch HTML from a website candidate and extract
 * team members, emails, and LinkedIn links.
 *
 * Reuses the GPT extractor pattern from enrichment_engine_v2.js.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const TEAM_PATHS = ['/team', '/about', '/people', '/leadership', '/our-team', '/about-us', '/company', ''];

async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { timeout, ...rest } = opts;
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check og:type=article in first 4KB of HTML.
 */
async function isArticleByMeta(url) {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (PFR-Enrichment)' },
    }, 4000);
    if (!res.ok) return false;
    const text = await res.text();
    const chunk = text.slice(0, 4096);
    return /og:type["']?\s*content=["']article["']/i.test(chunk) ||
           /content=["']article["']\s+property=["']og:type["']/i.test(chunk);
  } catch (_) {
    return false;
  }
}

/**
 * Extract all LinkedIn URLs from HTML.
 */
function extractLinkedInFromHtml(html) {
  const companyUrls = new Set();
  const personalUrls = [];
  const linkedInRe = /href=["']?(https?:\/\/(?:www\.)?linkedin\.com\/(?:in|company)\/[a-zA-Z0-9_-]+\/?)[^"'\s>]*/gi;
  let match;

  while ((match = linkedInRe.exec(html)) !== null) {
    const url = match[1].replace(/\/$/, '');
    if (url.includes('/company/')) {
      companyUrls.add(url);
    } else if (url.includes('/in/')) {
      const surrounding = html.substring(Math.max(0, match.index - 300), match.index + 300);
      const nameMatch = surrounding.match(/<[^>]*>([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)<\/[^>]*>/);
      const altMatch = surrounding.match(/alt=["']([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)["']/);
      const name = nameMatch?.[1] || altMatch?.[1] || null;
      const username = url.split('/in/')[1]?.toLowerCase();
      if (username && !personalUrls.some(p => p.url.toLowerCase().includes(username))) {
        personalUrls.push({ url, name });
      }
    }
  }

  return {
    companyUrl: companyUrls.size > 0 ? Array.from(companyUrls)[0] : null,
    personalUrls,
  };
}

/**
 * Extract emails from HTML.
 */
function extractEmailsFromHtml(html) {
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const found = html.match(emailRe) || [];
  const NOISE = ['example.com', 'domain.com', 'sentry.io', 'cloudflare', 'wixpress', 'squarespace'];
  const filtered = found
    .filter(e => {
      const lower = e.toLowerCase();
      return !NOISE.some(n => lower.includes(n)) &&
             !lower.endsWith('.js') &&
             !lower.endsWith('.css') &&
             !lower.includes('.png') &&
             !lower.includes('.jpg');
    })
    .map(e => e.toLowerCase());

  // Dedupe
  const unique = Array.from(new Set(filtered));

  // Prioritize contact-style prefixes
  const PRIORITY = ['info', 'contact', 'hello', 'invest', 'ir', 'team'];
  return unique.sort((a, b) => {
    const aP = a.split('@')[0];
    const bP = b.split('@')[0];
    const aScore = PRIORITY.findIndex(p => aP.includes(p));
    const bScore = PRIORITY.findIndex(p => bP.includes(p));
    return (aScore === -1 ? 99 : aScore) - (bScore === -1 ? 99 : bScore);
  }).slice(0, 5);
}

/**
 * Use GPT to extract team members from HTML.
 * Returns array of { name, title, email, linkedin } or [] on failure.
 */
async function extractTeamWithGPT(html, url, managerName) {
  if (!openai) return [];

  const lowerHtml = html.toLowerCase();
  const hasTeamContent = ['team', 'partner', 'founder', 'managing', 'people'].some(k => lowerHtml.includes(k));
  if (!hasTeamContent) return [];

  const truncated = html.slice(0, 8000);

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract team members from this investment firm's team page.
Return JSON: {"firmNameFound": "name found on page", "team": [{"name": "Full Name", "title": "Job Title", "email": "email or null", "linkedin": "url or null"}]}

CRITICAL VALIDATION:
1. First, identify what firm/company name appears on this page.
2. ONLY extract team members if this page is for the EXACT firm specified (not a similarly-named firm).
3. If the page mentions a DIFFERENT firm, return empty team.
4. Focus on: Partners, Founders, Managing Directors, Principals.
5. Skip: Advisors, Board members, contractors.

If firm name doesn't match, return: {"firmNameFound": "actual firm name", "team": []}`,
        },
        {
          role: 'user',
          content: `Extract team for: "${managerName}"\nURL: ${url}\nHTML:\n${truncated}`,
        },
      ],
      temperature: 0,
      max_tokens: 1200,
    });

    const raw = completion.choices[0].message.content;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const result = JSON.parse(jsonMatch[0]);

    // Verify firm name matches
    if (result.firmNameFound) {
      const normalize = s => s.toLowerCase().replace(/\s*(llc|lp|inc|corp|ltd|l\.l\.c\.|l\.p\.)\s*$/i, '').trim();
      const found = normalize(result.firmNameFound);
      const searched = normalize(managerName);
      if (found !== searched && !found.includes(searched) && !searched.includes(found)) {
        return [];
      }
    }

    return Array.isArray(result.team) ? result.team : [];
  } catch (err) {
    console.error('[website_fetch] GPT extraction error:', err.message);
    return [];
  }
}

/**
 * Fetch a website and extract all evidence (team, emails, LinkedIn links).
 *
 * @param {string} websiteUrl - Candidate website URL
 * @param {string} managerName - The manager name (for GPT validation)
 * @returns {Promise<Evidence[]>}
 */
async function fetchEvidence(websiteUrl, managerName) {
  const evidence = [];
  if (!websiteUrl) return evidence;

  // Check for article meta tag first
  const isArticle = await isArticleByMeta(websiteUrl);
  if (isArticle) {
    return evidence; // Silently reject articles
  }

  const capturedAt = new Date().toISOString();
  const source = `website_fetch:${websiteUrl}`;

  for (const teamPath of TEAM_PATHS) {
    const url = websiteUrl.replace(/\/$/, '') + teamPath;
    let html;

    try {
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FundRadar/1.0)' },
      }, 10000);
      if (!res.ok) continue;
      html = await res.text();
    } catch (_) {
      continue;
    }

    // LinkedIn links
    const { companyUrl, personalUrls } = extractLinkedInFromHtml(html);
    if (companyUrl) {
      evidence.push({
        type: 'linkedin_company_url',
        value: companyUrl,
        source,
        field: 'linkedin_company_url',
        anchor: 'website_links_to_linkedin', // found directly on verified website
        strength: 'strong',
        captured_at: capturedAt,
        found_on_path: teamPath || '/',
      });
    }

    // Emails
    const emails = extractEmailsFromHtml(html);
    for (const email of emails) {
      if (!evidence.some(e => e.type === 'primary_contact_email' && e.value === email)) {
        evidence.push({
          type: 'primary_contact_email',
          value: email,
          source,
          field: 'email',
          anchor: 'found_on_website',
          strength: 'strong',
          captured_at: capturedAt,
          found_on_path: teamPath || '/',
        });
      }
    }

    // Team members via GPT
    if (teamPath !== '' || evidence.filter(e => e.type === 'team_member').length === 0) {
      const team = await extractTeamWithGPT(html, url, managerName);
      for (const member of team) {
        if (!member.name) continue;
        evidence.push({
          type: 'team_member',
          value: {
            name: member.name,
            title: member.title || null,
            email: member.email || null,
            linkedin: member.linkedin || null,
          },
          source,
          field: 'team_member',
          anchor: 'found_on_verified_website',
          strength: 'strong',
          captured_at: capturedAt,
          found_on_path: teamPath || '/',
        });
      }

      // Merge personal LinkedIn URLs into team members
      for (const li of personalUrls) {
        if (!li.name) continue;
        const existing = evidence.find(
          e => e.type === 'team_member' && e.value.name?.toLowerCase() === li.name.toLowerCase()
        );
        if (existing && !existing.value.linkedin) {
          existing.value.linkedin = li.url;
        } else if (!existing) {
          evidence.push({
            type: 'team_member',
            value: { name: li.name, title: null, email: null, linkedin: li.url },
            source,
            field: 'team_member',
            anchor: 'found_on_verified_website',
            strength: 'medium',
            captured_at: capturedAt,
            found_on_path: teamPath || '/',
          });
        }
      }

      // Stop after first path that yields team members
      if (evidence.filter(e => e.type === 'team_member').length > 0) break;
    }
  }

  return evidence;
}

/**
 * Derive a website URL from a LinkedIn company slug (fallback).
 * E.g., linkedin.com/company/4thand1ventures → check https://www.4thand1ventures.com
 */
async function deriveWebsiteFromLinkedInSlug(linkedInUrl) {
  if (!linkedInUrl) return null;
  const slugMatch = linkedInUrl.match(/linkedin\.com\/company\/([^\/?#]+)/i);
  if (!slugMatch) return null;

  const slug = slugMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (slug.length < 4 || /^[0-9-]+$/.test(slug)) return null;

  const candidates = [`https://www.${slug}.com`, `https://${slug}.com`];
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (FundRadar/1.0)' },
      }, 6000);
      if (res.status >= 200 && res.status < 400) {
        return res.url && res.url.startsWith('http') ? res.url : url;
      }
    } catch (_) { /* try next */ }
  }

  return null;
}

module.exports = { fetchEvidence, isArticleByMeta, deriveWebsiteFromLinkedInSlug };
