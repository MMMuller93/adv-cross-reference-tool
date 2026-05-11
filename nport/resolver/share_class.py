"""Share-class and security-type extraction (PLAN §5 share-class normalization).

Independent of company entity resolution. Pulls structured share-class info
from raw `ISSUER_TITLE` strings so downstream consumers can group positions
by class (Series F-1 vs Series G) without re-parsing.

Input examples (real 2026 Q1 strings):
    "ANTHROPIC PBC SER F-1 CVT PFD PP"      → Series F-1 / convertible_preferred
    "ANTHROPIC, PBC SERIES E-1 PREFERRED STOCK" → Series E-1 / preferred
    "Anthropic PBC, Series G-1"             → Series G-1 / unspecified
    "ANTHROPIC PBC CL F-1 PFD PP (PHYSICAL)" → Class F-1 / preferred
    "Space Exploration Technologies Corp., Common Stock" → Common / common
"""
from __future__ import annotations

import re
from typing import TypedDict


class ShareClassInfo(TypedDict):
    """Parsed share-class metadata."""

    normalized: str
    security_type: str


# Regex: capture (SERIES|SER|CLASS|CL) + optional separator + letter(s) + optional -digit/digit.
# Longest alternation first — Python regex alternation is leftmost-preferred,
# so "SER" would otherwise eat "SER" from "SERIES" and leave "IES" as the ident.
# Class label regex is greedy alpha + optional `-?\d+` so "F1" and "F-1" both work.
_CLASS_RE: re.Pattern[str] = re.compile(
    r"\b(SERIES|SER|CLASS|CL)\s*[-]?\s*([A-Z]+(?:-?\d+)?)\b",
    re.IGNORECASE,
)

# Security-type keyword patterns. Order matters — "convertible preferred"
# must beat plain "preferred".
_SECURITY_TYPE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("convertible_preferred", re.compile(r"\b(CVT\s+PFD|CONVERTIBLE\s+PREFERRED)\b", re.IGNORECASE)),
    ("preferred", re.compile(r"\b(PFD|PREFERRED)\b", re.IGNORECASE)),
    ("common", re.compile(r"\bCOMMON\b", re.IGNORECASE)),
    ("warrant", re.compile(r"\bWARRANTS?\b", re.IGNORECASE)),
)


def _canonical_class_label(prefix: str, ident: str) -> str:
    """Build a canonical class label, e.g. ('SER', 'F1') → 'Series F-1'."""
    prefix_u = prefix.upper()
    head = "Series" if prefix_u in ("SER", "SERIES") else "Class"

    ident_u = ident.upper()
    # Insert a hyphen between trailing digits and the alpha prefix if absent.
    # 'F1'  → 'F-1';  'F-1' → 'F-1';  'A'  → 'A';  'AA' → 'AA'.
    m = re.match(r"^([A-Z]+)(\d+)$", ident_u)
    if m:
        ident_u = f"{m.group(1)}-{m.group(2)}"

    return f"{head} {ident_u}"


def extract_share_class(title: str | None) -> ShareClassInfo:
    """Return ``{'normalized': '...', 'security_type': '...'}`` for a title string.

    The ``normalized`` field is a canonical class label (``'Series F-1'``,
    ``'Class A'``, ``'Common'``, or ``'unspecified'``).
    The ``security_type`` field is one of ``'convertible_preferred'``,
    ``'preferred'``, ``'common'``, ``'warrant'``, or ``'unspecified'``.

    Examples:
        >>> extract_share_class("ANTHROPIC PBC SER F-1 CVT PFD PP")
        {'normalized': 'Series F-1', 'security_type': 'convertible_preferred'}
        >>> extract_share_class("Anthropic PBC, Series G-1")
        {'normalized': 'Series G-1', 'security_type': 'unspecified'}
        >>> extract_share_class("Space Exploration Technologies Corp., Common Stock")
        {'normalized': 'Common', 'security_type': 'common'}
    """
    if not title:
        return {"normalized": "unspecified", "security_type": "unspecified"}

    # 1. Security type.
    security_type = "unspecified"
    for stype, pat in _SECURITY_TYPE_PATTERNS:
        if pat.search(title):
            security_type = stype
            break

    # 2. Class / series label.
    m = _CLASS_RE.search(title)
    if m:
        normalized = _canonical_class_label(m.group(1), m.group(2))
    elif security_type == "common":
        # No explicit Series/Class, but it's "Common Stock" → that's the class.
        normalized = "Common"
    else:
        normalized = "unspecified"

    return {"normalized": normalized, "security_type": security_type}


__all__ = ["extract_share_class", "ShareClassInfo"]
