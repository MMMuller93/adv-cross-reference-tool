"""SPV-wrapper unwrap patterns (PLAN §5 Step 4).

Many N-PORT holdings are filed under SPV / co-invest vehicle names rather than
the underlying private company. Examples:

    "DXYZ OAI I LLC (economic exposure to OpenAI Global LLC, ...)"
    "AESTAS LLC dba OPENAI LLC EV UNITS Class A"
    "MWAM VC SpaceX-II, LLC"
    "SPV EXPOSURE TO SPACEX LLC"
    "Celadon Technology Fund VIII, LLC - Series B (economic exposure to Space Exploration Technologies Corp., Common Stock)"
    "G Squared Special Situations Fund, LLC - Series H-1 (invested in Brex, Inc.)"

This module returns the parsed underlier issuer name + which pattern fired.
The caller then re-runs entity resolution on the extracted underlier.

POC note (validated against 5 real 2026 Q1 strings):
- The `\\(economic exposure to X\\)` parenthetical pattern is the workhorse.
- The original spec's `^MWAM VC (\\w+)` truncates multi-word names; we use
  `^MWAM VC (.+?)(?:[-,]|\\s+LLC)` instead, capturing up to dash/comma/LLC.
"""
from __future__ import annotations

import re

# -- Pattern table -------------------------------------------------------------
# Each entry is (name, compiled regex). First match wins (order matters).
# The capture group is the underlier name.

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # "(economic exposure to OpenAI Global LLC, Profit Participation Units)"
    (
        "spv_economic_exposure",
        re.compile(r"\(economic exposure to ([^,)]+?)(?:[,)])", re.IGNORECASE),
    ),
    # "(invested in Brex, Inc.)"
    (
        "spv_invested_in",
        re.compile(r"\(invested in ([^,)]+?)(?:[,)])", re.IGNORECASE),
    ),
    # "DXYZ OAI I LLC" — vendor SPV naming pattern (Destiny Tech 100)
    (
        "spv_dxyz",
        re.compile(r"^DXYZ ([A-Z]+) [IVX]+ LLC$", re.IGNORECASE),
    ),
    # "AESTAS LLC dba OPENAI LLC EV UNITS Class A"
    (
        "spv_aestas",
        re.compile(r"AESTAS LLC dba (\w+)", re.IGNORECASE),
    ),
    # "MWAM VC SpaceX-II, LLC" — Morgan Stanley co-invest wrappers.
    # POC fix: use non-greedy `.+?` up to dash/comma/" LLC" instead of `\w+`
    # so we capture multi-word underliers (e.g. "Space Exploration Tech").
    (
        "spv_mwam",
        re.compile(r"^MWAM VC (.+?)(?:[-,]|\s+LLC)", re.IGNORECASE),
    ),
    # "SPV EXPOSURE TO SPACEX LLC"
    (
        "spv_exposure",
        re.compile(r"^SPV EXPOSURE TO (\w+)", re.IGNORECASE),
    ),
    # "G Squared Special Situations Fund, LLC - Series H-1 (invested in Brex, Inc.)"
    # Fallback when the parenthetical form above doesn't fire (e.g. malformed parens).
    (
        "spv_g_squared",
        re.compile(r"^G Squared.*?invested in (\w+)", re.IGNORECASE),
    ),
)


def unwrap_spv(text: str | None) -> tuple[str | None, str | None]:
    """Try to extract the underlier issuer name from an SPV wrapper string.

    Args:
        text: Concatenated `issuer_name + " " + issuer_title` (or either alone).
            May be ``None``.

    Returns:
        ``(underlier_name, pattern_name)`` on match, else ``(None, None)``.
        The underlier name is returned trimmed but NOT normalized — callers
        run it back through :func:`resolver.normalizer.normalize_issuer`.

    Examples:
        >>> unwrap_spv("DXYZ OAI I LLC (economic exposure to OpenAI Global LLC, Profit Participation Units)")
        ('OpenAI Global LLC', 'spv_economic_exposure')
        >>> unwrap_spv("MWAM VC SpaceX-II, LLC")
        ('SpaceX', 'spv_mwam')
        >>> unwrap_spv("Plain Anthropic, Inc.")
        (None, None)
    """
    if not text:
        return (None, None)

    for pattern_name, regex in _PATTERNS:
        m = regex.search(text)
        if m:
            underlier = m.group(1).strip()
            if underlier:
                return (underlier, pattern_name)

    return (None, None)


__all__ = ["unwrap_spv"]
