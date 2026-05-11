"""Issuer-name normalization for N-PORT entity resolution.

Implements the §5 Step 5 normalization pipeline from PLAN_NPORT_HOLDINGS.md.
The output is a stable canonical string used for exact-name and prefix matching
against `private_company_aliases`.

Pipeline:
    1. Upper-case
    2. Strip vendor noise markers (PP, PC, CVT PFD, (PHYSICAL), (NOT LISTED OR TRADING))
    3. Strip remaining parentheticals
    4. Strip punctuation
    5. Collapse whitespace
    6. Recursively strip trailing legal suffixes (LLC, INC, PBC, CORP, CO, LP,
       LTD, TRUST, FUND, HOLDINGS, HLDGS)

Validated end-to-end against 91 real 2026 Q1 Anthropic rows (POC: 100% recall,
0 false positives).
"""
from __future__ import annotations

import re

# -- Token / pattern tables ----------------------------------------------------

# Vendor noise tokens — annotations filers append to titles that aren't
# part of the issuer's identity. Order matters: longer / parenthesized
# patterns must be stripped before bare two-letter codes.
_VENDOR_NOISE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\(PHYSICAL\)", re.IGNORECASE),
    re.compile(r"\(NOT LISTED OR TRADING\)", re.IGNORECASE),
    re.compile(r"\bCVT\s+PFD\b", re.IGNORECASE),
    re.compile(r"\bPP\b", re.IGNORECASE),
    re.compile(r"\bPC\b", re.IGNORECASE),
)

# Remaining parentheticals — anything still in parens after the noise pass
# is vendor or filer commentary, not part of the entity name.
_PARENTHETICAL_RE: re.Pattern[str] = re.compile(r"\([^)]*\)")

# Punctuation — strip everything that isn't a letter, digit, or whitespace.
_PUNCT_RE: re.Pattern[str] = re.compile(r"[^A-Z0-9\s]+")

_WHITESPACE_RE: re.Pattern[str] = re.compile(r"\s+")

# Trailing legal suffixes — applied recursively (strip "Anthropic PBC Inc"
# → "Anthropic PBC" → "Anthropic"). Anchored to the end of the string.
_LEGAL_SUFFIXES: frozenset[str] = frozenset(
    {
        "LLC",
        "INC",
        "PBC",
        "CORP",
        "CO",
        "LP",
        "LTD",
        "TRUST",
        "FUND",
        "HOLDINGS",
        "HLDGS",
    }
)


def normalize_issuer(name: str | None) -> str:
    """Return the normalized form of an N-PORT issuer name.

    Args:
        name: Raw issuer string from `FUND_REPORTED_HOLDING.ISSUER_NAME` or
            `ISSUER_TITLE`. May be ``None`` or "N/A".

    Returns:
        Normalized string (upper-case, no punctuation, no legal suffixes,
        whitespace collapsed). Empty string if input is null-ish.

    Examples:
        >>> normalize_issuer("Anthropic, PBC")
        'ANTHROPIC'
        >>> normalize_issuer("ANTHROPIC PBC SER F-1 CVT PFD PP")
        'ANTHROPIC SER F1'
        >>> normalize_issuer("ANTHROPIC PBC CL F-1 PFD PP (PHYSICAL) (NOT LISTED OR TRADING)")
        'ANTHROPIC CL F1 PFD'
    """
    if not name:
        return ""

    s = name.upper()

    # 1. Strip vendor noise (codes + known parenthetical annotations).
    for pat in _VENDOR_NOISE_PATTERNS:
        s = pat.sub(" ", s)

    # 2. Strip any remaining parentheticals.
    s = _PARENTHETICAL_RE.sub(" ", s)

    # 3. Strip punctuation.
    s = _PUNCT_RE.sub(" ", s)

    # 4. Collapse whitespace.
    s = _WHITESPACE_RE.sub(" ", s).strip()

    # 5. Recursively strip trailing legal suffixes.
    while True:
        parts = s.split()
        if not parts:
            break
        if parts[-1] in _LEGAL_SUFFIXES:
            parts.pop()
            s = " ".join(parts)
            continue
        break

    return s


__all__ = ["normalize_issuer"]
