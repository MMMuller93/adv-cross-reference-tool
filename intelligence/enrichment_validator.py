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


def _split_into_chunks(haystack: str) -> list[str]:
    """Split a URL/handle/slug into recognizable word chunks.

    Steps:
      1. Split on non-alphabetic characters (digits, punctuation, separators).
      2. For each resulting span, split on camelCase / PascalCase boundaries.
      3. Lowercase. Drop empty.

    Examples:
      'westernasset'   -> ['westernasset']
      'WesternAsset'   -> ['western', 'asset']
      'manhattan-west' -> ['manhattan', 'west']
      'augury_invest'  -> ['augury', 'invest']
      'jpmorgan'       -> ['jpmorgan']
      'JPMorgan'       -> ['jp', 'morgan']
      'fidelity.com'   -> ['fidelity', 'com']
    """
    if not haystack:
        return []
    # 1. Split on any non-alphanumeric run. Keep digits inside chunks so that
    # firm prefixes like 'E1', 'A3' survive (without this, 'e1.vc' became
    # ['e', 'vc'] and the firm 'E1 Ventures' couldn't match itself).
    spans = re.split(r'[^A-Za-z0-9]+', haystack)
    chunks: list[str] = []
    for span in spans:
        if not span:
            continue
        # 2. Split camelCase: insert split point before any uppercase that
        # follows a lowercase letter.
        parts = re.findall(r'[A-Z]?[a-z]+[0-9]*|[A-Z]+(?=[A-Z][a-z]|$|[^A-Za-z])|[0-9]+', span)
        if not parts:
            chunks.append(span.lower())
        else:
            for p in parts:
                if p:
                    chunks.append(p.lower())
    return chunks


def _token_matches_chunk(token: str, chunk: str) -> bool:
    """A firm-name token 'matches' a haystack chunk when:
      - token == chunk (exact word match), OR
      - fuzzy: edit-distance <= 1 (token and chunk same length ±1) for
        tokens >= 5 chars (catches 'augurey' vs 'augury').
    Note: prefix-coverage is INTENTIONALLY removed here. Prefix matches
    are handled by the iterative-peel logic in _chunk_consumed_by_firm,
    which can correctly distinguish 'west' as prefix of 'westernasset'
    (leaves 'ernasset' un-consumable) vs 'fidelity' as prefix of
    'fidelityinvestments' (leaves 'investments' which IS consumable).
    """
    if not token or not chunk:
        return False
    if token == chunk:
        return True
    if len(token) >= 5 and abs(len(token) - len(chunk)) <= 1:
        if _edit_distance_at_most_1(token, chunk):
            return True
    return False


# Generic word-parts that can be peeled off a chunk during consumption.
# These are 'firm filler' tokens that often appear concatenated with the
# brand in squished handles ('FidelityInvestments', 'StarbridgeVC',
# 'AuguryInvesting').
GENERIC_PEELABLES = (
    'investments', 'investment', 'investing', 'invest',
    # Common abbreviated forms — '@nuveeninv', '@xyzmgmt' etc.
    'inv', 'invs', 'mgmt', 'mgr', 'mgrs', 'cap', 'sec', 'svc', 'svcs',
    'capital', 'management', 'managers', 'partners', 'partner',
    'advisors', 'advisers', 'advisor', 'adviser', 'advisory',
    'ventures', 'venture',
    'fund', 'funds',
    'holdings', 'holding',
    'group',
    'associates',
    'services', 'service',
    'wealth',
    'asset', 'assets',
    'global', 'us', 'usa', 'inc', 'corp', 'corporation', 'llc', 'lp',
    'company', 'co',
    'com', 'net', 'org', 'io', 'vc',
)


def _consume_prefix(remainder: str, candidates) -> Optional[str]:
    """Try to strip any candidate (firm token or generic peelable) as a
    prefix of remainder. Returns the new remainder if anything was
    stripped, else None.
    """
    # Try longest candidate first so 'investments' wins over 'invest'.
    for cand in sorted(candidates, key=len, reverse=True):
        if not cand:
            continue
        if remainder.startswith(cand):
            return remainder[len(cand):]
        # Fuzzy: token >= 5 chars, distance-1 match against a prefix of
        # remainder of the same length.
        if len(cand) >= 5 and len(remainder) >= len(cand) - 1:
            for k in (len(cand) - 1, len(cand), len(cand) + 1):
                if k > len(remainder):
                    continue
                if _edit_distance_at_most_1(cand, remainder[:k]):
                    return remainder[k:]
    return None


def _chunk_consumed_by_firm(chunk: str, tokens: list[str]) -> bool:
    """Iteratively peel firm tokens (with fuzzy) and known generic
    peelables from a chunk. If everything (or all but <= 2 chars of
    plural/noise) consumes, the chunk talks about this firm.

    Examples (tokens=['fidelity', 'research']):
      'fidelityinvestments' → strip 'fidelity' → 'investments' → strip generic → '' ✓
      'fidelity'            → strip 'fidelity' → '' ✓
      'fmr'                 → no firm token prefix, no generic → False (caller may fall back to acronym)

    Examples (tokens=['manhattan', 'west']):
      'manhattanwest'   → strip 'manhattan' → 'west' → strip firm token 'west' → '' ✓
      'westernasset'    → strip 'west' → 'ernasset' → no firm/generic prefix → False ✓
      'midwest'         → no firm-token prefix ('mid' isn't one) → False ✓
    """
    if not chunk:
        return True
    if not tokens:
        return False
    remainder = chunk
    saw_firm_token = False
    while remainder:
        # Prefer firm-token peels (they 'identify' the firm)
        new_remainder = _consume_prefix(remainder, tokens)
        if new_remainder is not None:
            saw_firm_token = True
            remainder = new_remainder
            continue
        # Then generic peels
        new_remainder = _consume_prefix(remainder, GENERIC_PEELABLES)
        if new_remainder is not None:
            remainder = new_remainder
            continue
        break
    # Match if we consumed at least one firm token AND the chunk is fully
    # (or all-but-noise) reduced.
    return saw_firm_token and len(remainder) <= 2


def _firm_token_variants(firm_name: str, tokens: list[str]) -> list[str]:
    """Augment firm tokens with a 'compound' variant: leading short tokens
    glued onto the first long token. Examples:
      J.P. Morgan          -> raw ['j','p','morgan'] → compound 'jpmorgan'
      A.B.C. Capital       -> raw ['a','b','c','capital'] → compound 'abccapital'
      D.E. Shaw            -> raw ['d','e','shaw'] → compound 'deshaw'

    Uses the RAW firm-name split (not filtered tokens) so 1-letter abbrev
    parts that firm_tokens dropped (e.g., the 'P' in 'J.P. Morgan') are
    still included in the compound.
    """
    out = list(tokens)
    raw = [t.lower() for t in re.split(r'[\s,.()&/]+', firm_name or '') if t]
    raw = [t for t in raw if t not in {'the', 'a', 'an'}]
    if len(raw) >= 2 and len(raw[0]) <= 2:
        compound = ''
        idx = 0
        while idx < len(raw) and len(raw[idx]) <= 2:
            compound += raw[idx]
            idx += 1
        if idx < len(raw) and raw[idx] not in ACRONYM_SKIP_TOKENS:
            compound += raw[idx]
        if compound and len(compound) >= 3 and compound not in out:
            out.append(compound)
    return out


def _edit_distance_at_most_1(a: str, b: str) -> bool:
    """True iff Levenshtein distance between a and b is <= 1. Faster than
    full Levenshtein because we only need a small bound."""
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    # Make a the shorter one
    if len(a) > len(b):
        a, b = b, a
    # Find first mismatch
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    if i == len(a):
        # All of a matches; b has one extra char appended → distance 1 (or 0)
        return len(b) - len(a) <= 1
    # Either replacement (same length) or insertion (b is longer by 1)
    if len(a) == len(b):
        # Replacement at position i; rest must match
        return a[i + 1:] == b[i + 1:]
    else:
        # Insertion in b at position i; rest of a must match b shifted by 1
        return a[i:] == b[i + 1:]


def _contains_firm_signal(haystack: str, firm_name: str) -> bool:
    """True iff the haystack contains a recognizable form of the firm's name.

    Three-tier match:
      1. Direct chunk match — split haystack into chunks (camelCase +
         non-alpha), check if any chunk equals or fuzzy-matches a firm
         token. Tracks how many *distinct* firm tokens hit some chunk.
      2. Iterative peel — for chunks that don't directly match, try
         consuming them by stripping firm tokens AND generic peelables
         off the front. Catches squished handles like 'manhattanwest',
         'fidelityinvestments', 'auguryinvesting'.
      3. Acronym fallback — NYLIM-style. Acronym appears as a chunk or
         as a prefix of one.

    Distinct-token coverage rule: for firms with 2+ tokens (Manhattan
    West, New York Life), at least 2 distinct tokens must hit somewhere;
    for single-token firms (AUGUREY, FIDELITY), 1 hit is enough. Iterative
    peel of a single chunk DOES count multiple tokens if it peels them.
    """
    if not haystack or not firm_name:
        return False
    chunks = _split_into_chunks(haystack)
    if not chunks:
        return False
    base_tokens = firm_tokens(firm_name)
    tokens = _firm_token_variants(firm_name, base_tokens)

    # Track which BASE tokens (not variants) have been observed
    matched_base_tokens: set[str] = set()
    for c in chunks:
        # Direct chunk match (exact or fuzzy)
        for t in base_tokens:
            if _token_matches_chunk(t, c):
                matched_base_tokens.add(t)
        # Compound match for J.P. Morgan style — when a compound variant
        # (e.g., 'jpmorgan') matches a chunk, credit every base token that
        # appears as a substring of the compound. This matters because the
        # required-token-count check is on base_tokens, but the compound
        # is what actually shows up in URLs/handles.
        for v in tokens:
            if v not in base_tokens and _token_matches_chunk(v, c):
                for bt in base_tokens:
                    if bt and bt in v:
                        matched_base_tokens.add(bt)
        # Iterative peel — if chunk fully consumes via firm tokens (+ generics),
        # all firm tokens peeled count toward coverage
        consumed_tokens = _peel_and_collect_tokens(c, tokens, base_tokens)
        matched_base_tokens.update(consumed_tokens)

    required = 2 if len(base_tokens) >= 2 else 1
    # For 2+ token firms, satisfy if >=2 distinct tokens observed
    if len(matched_base_tokens) >= required:
        return True
    # Brand-token rule: when the FIRST base token (the brand identifier) is
    # distinctive enough (>= 5 chars) AND it matched, that's enough even
    # for multi-token firms. Catches 'fidelity.com' for Fidelity Mgmt &
    # Research Co (where 'research' never appears in real URLs/handles).
    if base_tokens and len(base_tokens[0]) >= 5 and base_tokens[0] in matched_base_tokens:
        return True
    # Special case: single-chunk haystack that fully consumes via firm tokens
    # alone is also a match (one chunk that 'IS' the firm)
    if len(chunks) == 1 and base_tokens:
        all_consumed = _chunk_consumed_by_firm(chunks[0], tokens)
        if all_consumed:
            return True

    # Acronym fallback — for 4+ char acronyms (distinctive enough), match
    # if the acronym appears as a chunk OR as a prefix of any chunk. No
    # coverage requirement: an acronym prefix is a strong signal regardless
    # of what trails it (e.g., '@nylimanagement' starts with the firm's
    # 'NYLIM' acronym and the rest is the unrolled word 'management' that
    # overlapped the 'M' in the acronym).
    acro = firm_acronym(firm_name)
    if len(acro) >= 4:
        for c in chunks:
            if c == acro or c.startswith(acro):
                return True
    elif len(acro) == 3:
        # Stricter rule for 3-char acronyms — they're more collision-prone.
        # Require exact chunk match.
        for c in chunks:
            if c == acro:
                return True
    return False


def _peel_and_collect_tokens(chunk: str, tokens: list[str], base_tokens: list[str]) -> set[str]:
    """Run the iterative peel and return the BASE tokens that were
    consumed during the process. Caller uses this to count distinct
    tokens covered without requiring a full clean peel.
    """
    if not chunk or not tokens:
        return set()
    remainder = chunk
    consumed: set[str] = set()
    while remainder:
        new_remainder = _consume_prefix(remainder, tokens)
        if new_remainder is not None:
            # Figure out which base token was consumed
            consumed_len = len(remainder) - len(new_remainder)
            consumed_text = remainder[:consumed_len]
            for bt in base_tokens:
                if bt == consumed_text or _edit_distance_at_most_1(bt, consumed_text):
                    consumed.add(bt)
            # Also: when a compound token like 'jpmorgan' is consumed, credit
            # every base token that appears as a substring.
            for bt in base_tokens:
                if bt and bt in consumed_text:
                    consumed.add(bt)
            remainder = new_remainder
            continue
        new_remainder = _consume_prefix(remainder, GENERIC_PEELABLES)
        if new_remainder is not None:
            remainder = new_remainder
            continue
        break
    # Only return the consumed set if the chunk reduced cleanly (≤ 2 chars
    # of noise). Otherwise partial peeling could falsely credit 'west' for
    # 'westernasset'.
    if len(remainder) > 2:
        return set()
    return consumed


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
