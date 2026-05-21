"""Plausibility validator for PFR enrichment_engine_v2 outputs.

Codex 2026-05-20 review identified that enrichment_engine_v2 sometimes
returns wrong data even when its own AI validation flagged a mismatch:
  - Fidelity website -> discord.gg/fidelityinvestments
  - Fidelity linkedin -> linkedin.com/company/atom-tickets
  - Fidelity twitter -> @GrishinRobotics
  - Coatue twitter -> @business (Bloomberg's account)
  - Scenic Management twitter -> @WSJ

We can't fix PFR's engine from here, but we CAN gate writes through a
plausibility validator that nulls obviously-wrong fields BEFORE they
land in enriched_managers.

Per-field validators are deliberately conservative — they err toward
keeping fields rather than nulling. We only null when the field has a
known-bad signature or fails ALL reasonable name-similarity tests.

Test patterns vetted against the 25 Anthropic-adviser enrichments:
- Legitimate acronyms (NYLIM = New York Life Investment Management,
  ARK = ARK Investment, LFG = LFG Wealth Partners) pass.
- Clever wordplay (@venividiventure for Venelite Ventures,
  @auguryinvesting for AUGUREY) passes via fuzzy substring match.
- Hard-reject: known-bad domains (discord, social), known-wrong
  Twitter handles (@business, @WSJ, etc.).
"""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlparse


# Domains that are NEVER a firm's primary website
BLOCKED_WEBSITE_DOMAINS = {
    'discord.gg', 'discord.com',
    'facebook.com', 'fb.com', 'instagram.com', 'tiktok.com',
    'twitter.com', 'x.com',
    'youtube.com', 'youtu.be',
    'reddit.com', 'threads.net', 'pinterest.com',
    'linkedin.com', 'github.com', 'gitlab.com',
    'medium.com', 'substack.com',
    'crunchbase.com', 'pitchbook.com', 'bloomberg.com',
    'wikipedia.org', 'investopedia.com', 'sec.gov',
    'adviserinfo.sec.gov',
}

# Twitter handles that are NEVER the firm's account (Bloomberg's @business,
# news outlets, well-known unrelated handles). Lower-case without leading @.
BLOCKED_TWITTER_HANDLES = {
    'business', 'bloomberg', 'wsj', 'nytimes', 'cnbc', 'reuters', 'forbes',
    'cnn', 'foxnews', 'bbcnews', 'ap', 'apnews', 'verified', 'twitter',
    'x', 'linkedin', 'instagram', 'finance', 'tech',
}

# LinkedIn company slugs that are NEVER the firm we're enriching (engine
# has been observed picking these up wrongly).
KNOWN_BAD_LINKEDIN_SLUGS = {
    'atom-tickets',
}

# Tokens that don't distinguish firms — don't count them when checking
# whether a URL/handle contains a firm-name token.
GENERIC_FIRM_TOKENS = {
    'inc', 'llc', 'corp', 'co', 'ltd', 'limited', 'company', 'corporation',
    'group', 'holdings', 'capital', 'management', 'partners', 'advisors',
    'advisers', 'fund', 'funds', 'investments', 'investment', 'ventures',
    'venture', 'associates', 'services', 'securities', 'trust', 'bank',
    'wealth', 'asset', 'assets', 'equity', 'global', 'financial',
    'opportunity', 'opportunities', 'strategic', 'alternative', 'private',
    'first', 'new', 'american', 'america', 'usa', 'and', 'the', 'of',
}


def firm_tokens(firm_name: str) -> list[str]:
    """Significant tokens of a firm name (lowered). The FIRST token is always
    kept regardless of length so short distinctive prefixes ('ID Funds', 'E1
    Ventures', 'JP Morgan') survive. Subsequent tokens require length >= 3
    AND non-generic.
    """
    if not firm_name:
        return []
    raw = [t for t in re.split(r'[\s,.()&/]+', firm_name.lower()) if t]
    if not raw:
        return []
    out = []
    # Always include the first non-trivial token (skip leading 'the', 'a').
    for i, t in enumerate(raw):
        if t in {'the', 'a', 'an'}:
            continue
        out.append(t)
        # Remaining tokens: standard filter
        for t2 in raw[i + 1:]:
            if len(t2) >= 3 and t2 not in GENERIC_FIRM_TOKENS:
                out.append(t2)
        break
    return out


# Entity-suffix tokens to drop when computing acronyms. UNLIKE
# GENERIC_FIRM_TOKENS (used for firm-name fuzzy matching), this set is
# narrow — words like 'MANAGEMENT' / 'INVESTMENT' / 'PARTNERS' STAY in
# the acronym because firms like NEW YORK LIFE INVESTMENT MANAGEMENT use
# them as official 'NYLIM' (the M's matter).
ACRONYM_SKIP_TOKENS = {
    'inc', 'inc.', 'llc', 'l.l.c.', 'lp', 'l.p.', 'corp', 'corp.', 'corporation',
    'co', 'co.', 'ltd', 'ltd.', 'limited', 'plc', 'gmbh', 'ag', 'sa', 'nv', 'bv',
    'the', 'of', 'and', '&', '&amp;',
}


def firm_acronym(firm_name: str) -> str:
    """Acronym from first-letters of every significant multi-letter token.
    Drops entity suffixes and connectors only — 'NEW YORK LIFE INVESTMENT
    MANAGEMENT LLC' -> 'nylim'. Returns lowercase."""
    toks = re.split(r'[\s,.()&/]+', firm_name or '')
    acro = ''.join(t[0].lower() for t in toks
                   if t and len(t) >= 2 and t.lower() not in ACRONYM_SKIP_TOKENS)
    return acro


def _contains_firm_signal(haystack: str, firm_name: str) -> bool:
    """True iff haystack contains a firm-name token OR the firm acronym
    OR a fuzzy substring of a token.
    """
    if not haystack or not firm_name:
        return False
    h = haystack.lower()
    tokens = firm_tokens(firm_name)
    # Exact token match
    if any(t in h for t in tokens):
        return True
    # Acronym match (>= 3 chars to avoid noisy short acronyms)
    acro = firm_acronym(firm_name)
    if len(acro) >= 3 and acro in h:
        return True
    # Fuzzy: any 5+ char prefix of a token (catches 'augury' from 'augurey')
    for t in tokens:
        if len(t) >= 5:
            for n in range(5, len(t) + 1):
                if t[:n] in h or h.startswith(t[:n]):
                    return True
    return False


def validate_website(url: Optional[str], firm_name: str) -> tuple[Optional[str], Optional[str]]:
    """Returns (cleaned_url_or_None, reject_reason_or_None)."""
    if not url:
        return None, None
    parsed = urlparse(url if '://' in url else f'http://{url}')
    host = (parsed.hostname or '').lower().lstrip('www.')
    if not host:
        return None, 'no hostname'
    # Block known-bad domains
    bare = host.split('.', 1)[-1] if host.count('.') >= 2 else host
    for blocked in BLOCKED_WEBSITE_DOMAINS:
        if host == blocked or host.endswith('.' + blocked) or host == 'www.' + blocked:
            return None, f'blocked domain: {host}'
    # Acceptable if the hostname has a firm signal
    if _contains_firm_signal(host, firm_name):
        # Normalize URL: lowercase scheme + host
        scheme = (parsed.scheme or 'https').lower()
        path = parsed.path or '/'
        query = ('?' + parsed.query) if parsed.query else ''
        return f'{scheme}://{host}{path}{query}', None
    # No firm signal in hostname — reject as likely-wrong
    return None, f'no firm signal in hostname: {host}'


def validate_linkedin_company_url(url: Optional[str], firm_name: str) -> tuple[Optional[str], Optional[str]]:
    if not url:
        return None, None
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    if 'linkedin.com' not in host:
        return None, f'not linkedin.com: {host}'
    m = re.search(r'/company/([^/?#]+)', parsed.path or '')
    if not m:
        return None, 'not a /company/ URL'
    slug = m.group(1).lower()
    if slug in KNOWN_BAD_LINKEDIN_SLUGS:
        return None, f'known-bad slug: {slug}'
    slug_text = slug.replace('-', ' ').replace('_', ' ')
    if _contains_firm_signal(slug_text, firm_name):
        # Normalize to canonical https://www.linkedin.com/company/<slug>/
        return f'https://www.linkedin.com/company/{slug}/', None
    return None, f'slug has no firm signal: {slug}'


def validate_twitter_handle(handle: Optional[str], firm_name: str) -> tuple[Optional[str], Optional[str]]:
    if not handle:
        return None, None
    h = handle.lstrip('@').lower()
    if not h:
        return None, 'empty'
    if h in BLOCKED_TWITTER_HANDLES:
        return None, f'blocked handle: {h}'
    # Strip separators for matching ('@venividiventure' -> 'venividiventure')
    norm = re.sub(r'[_\-]', '', h)
    if _contains_firm_signal(norm, firm_name):
        return '@' + h, None
    return None, f'no firm signal in handle: {h}'


def validate_email(email: Optional[str], firm_name: str, website_url: Optional[str] = None) -> tuple[Optional[str], Optional[str]]:
    if not email:
        return None, None
    email = email.strip().lower()
    if '@' not in email:
        return None, 'no @'
    local, _, domain = email.rpartition('@')
    # If we have a validated website URL, the email domain should match
    if website_url:
        wparsed = urlparse(website_url)
        whost = (wparsed.hostname or '').lower().lstrip('www.')
        whost_base = whost.split('.', 1)[-1] if whost.count('.') >= 2 else whost
        if whost_base and (whost_base in domain or domain in whost):
            return email, None
        # Otherwise reject (probably an extracted-from-page email that's not the firm's)
        return None, f'domain mismatch: email={domain} site={whost}'
    # No website to cross-check: accept if domain shares a firm token
    if _contains_firm_signal(domain, firm_name):
        return email, None
    return None, f'domain has no firm signal: {domain}'


def validate_team_members(team_members, firm_name: str) -> tuple[list, list]:
    """Returns (clean_list, rejected_list_with_reasons).
    team_members may be a list of {name, role} dicts OR a list of strings.
    Reject entries whose 'name' is clearly not a person (matches a
    corporate token, or contains weird parenthetical bodies of text).
    """
    if not team_members:
        return [], []
    if not isinstance(team_members, list):
        return [], [(str(team_members), 'not a list')]
    clean = []
    rejected = []
    for m in team_members:
        if isinstance(m, dict):
            name = (m.get('name') or '').strip()
            role = (m.get('role') or m.get('title') or '').strip()
        else:
            name = str(m or '').strip()
            role = ''
        if not name:
            continue
        # Reject obvious-corporate names (e.g., 'Capital Research Management')
        # heuristic: 4+ token name with no comma is suspicious
        toks = name.split()
        if len(toks) >= 4 and not any(c.islower() for c in name):
            rejected.append((name, 'all-caps long string, looks like a header'))
            continue
        if len(toks) > 5:
            rejected.append((name, 'too many tokens to be a person'))
            continue
        # Reject if name is just firm tokens
        firm_tok = set(firm_tokens(firm_name))
        name_tok = set(t.lower() for t in toks)
        if firm_tok and name_tok and name_tok <= firm_tok:
            rejected.append((name, 'name is only firm tokens'))
            continue
        clean.append({'name': name, 'role': role})
    return clean, rejected


def validate_enrichment(firm_name: str, payload: dict) -> tuple[dict, list]:
    """Apply all field validators. Returns (cleaned_payload, audit_log).
    `payload` is the dict that would be written to enriched_managers.
    """
    cleaned = dict(payload)
    audit = []

    new_web, reason = validate_website(cleaned.get('website_url'), firm_name)
    if reason:
        audit.append(('website_url', cleaned.get('website_url'), reason))
    cleaned['website_url'] = new_web

    new_li, reason = validate_linkedin_company_url(cleaned.get('linkedin_company_url'), firm_name)
    if reason:
        audit.append(('linkedin_company_url', cleaned.get('linkedin_company_url'), reason))
    cleaned['linkedin_company_url'] = new_li

    new_tw, reason = validate_twitter_handle(cleaned.get('twitter_handle'), firm_name)
    if reason:
        audit.append(('twitter_handle', cleaned.get('twitter_handle'), reason))
    cleaned['twitter_handle'] = new_tw

    new_email, reason = validate_email(cleaned.get('primary_contact_email'), firm_name, new_web)
    if reason:
        audit.append(('primary_contact_email', cleaned.get('primary_contact_email'), reason))
    cleaned['primary_contact_email'] = new_email

    clean_tm, rejected_tm = validate_team_members(cleaned.get('team_members'), firm_name)
    if rejected_tm:
        for rname, rreason in rejected_tm:
            audit.append(('team_member', rname, rreason))
    cleaned['team_members'] = clean_tm if clean_tm else None

    return cleaned, audit


if __name__ == '__main__':
    # Quick sanity test against known cases.
    import json
    cases = [
        ('FIDELITY MANAGEMENT & RESEARCH COMPANY LLC', {
            'website_url': 'https://discord.gg/fidelityinvestments',
            'linkedin_company_url': 'https://de.linkedin.com/company/atom-tickets',
            'twitter_handle': '@GrishinRobotics',
            'primary_contact_email': 'stephanie.j.brown@fmr.com',
        }),
        ('NEW YORK LIFE INVESTMENT MANAGEMENT LLC', {
            'website_url': 'https://www.nylim.com/',
            'linkedin_company_url': 'https://www.linkedin.com/company/nylim',
            'twitter_handle': '@NYLIManagement',
            'primary_contact_email': 'kevin_bopp@nylim.com',
        }),
        ('COATUE MANAGEMENT, L.L.C.', {
            'website_url': 'HTTP://WWW.COATUE.COM',
            'twitter_handle': '@business',
            'primary_contact_email': 'vdesimone@coatue.com',
        }),
        ('VENELITE VENTURES, LLC', {
            'website_url': 'https://www.venelite.com/',
            'twitter_handle': '@venividiventure',
        }),
        ('AUGUREY CAPITAL ADVISORS, LLC', {
            'website_url': 'https://www.augureyventures.com/',
            'twitter_handle': '@auguryinvesting',
            'primary_contact_email': 'frank@augureyventures.com',
        }),
    ]
    for firm, payload in cases:
        print(f'\n=== {firm} ===')
        cleaned, audit = validate_enrichment(firm, payload)
        print(f'  CLEANED: {json.dumps(cleaned, default=str)}')
        if audit:
            for field, val, reason in audit:
                print(f'  REJECTED {field}={val!r}: {reason}')
