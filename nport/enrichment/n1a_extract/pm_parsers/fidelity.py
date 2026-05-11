"""Fidelity 485BPOS portfolio-manager parser.

Pattern in the wild:
    "William Danoff (Co-Portfolio Manager) has managed the fund since 2012."
    "Matthew Drukker (Co-Portfolio Manager) has managed the fund since 2025."
    "Nidhi Gupta (Co-Portfolio Manager) has managed the fund since 2025."

Sometimes the parenthetical role is just "(Portfolio Manager)". The "managed
the fund since YEAR" tail is the most stable anchor across Fidelity filings.

Note: the same name+role block is REPEATED across all share classes (Investor,
Advisor, Institutional, K, R6...) and across the SAI extended bio block. We
dedupe at the end.
"""
from __future__ import annotations

import re
from typing import Optional

from ..pm_types import PmExtractionResult, PortfolioManager

# Pattern: Name (Role) has managed the fund since YEAR
# Names may include suffixes like "Jr.", "III", honorifics; we accept letters,
# spaces, periods, hyphens, apostrophes.
NAME_PART = r"[A-Z][A-Za-z'\-\.]+(?:\s+[A-Z][A-Za-z'\-\.]+){1,4}"
ROLE_PART = r"(?:Co-?Lead\s+)?(?:Lead\s+)?(?:Co-?)?Portfolio Manager"

# Match "Name (Role) has managed the fund since YEAR"
PATTERN = re.compile(
    rf"(?P<name>{NAME_PART})\s*"
    rf"\((?P<role>{ROLE_PART})\)\s*"
    rf"has managed the fund since\s+"
    rf"(?P<year>\d{{4}})",
    re.IGNORECASE,
)


def parse(section_text: str) -> PmExtractionResult:
    """Parse Fidelity-style PM disclosures from a text section."""
    matches = list(PATTERN.finditer(section_text or ""))
    pms: list[PortfolioManager] = []
    seen: set[str] = set()

    for m in matches:
        name = _normalize_name(m.group("name"))
        role = m.group("role").strip()
        year = m.group("year")
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        pms.append(
            PortfolioManager(
                name=name,
                role=role,
                managed_since=year,
                source_filer="fidelity",
            )
        )

    confidence = _confidence(pms, section_text)
    return PmExtractionResult(
        parser="fidelity",
        portfolio_managers=pms,
        confidence=confidence,
        raw_excerpt=_excerpt(section_text),
    )


def _normalize_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip()


def _confidence(pms: list[PortfolioManager], section_text: str) -> float:
    if not pms:
        return 0.0
    # If the section text actually contains an anchor phrase, high confidence
    anchor = "has managed the fund since"
    if anchor in (section_text or "").lower():
        return 0.95
    return 0.7


def _excerpt(text: str, n: int = 400) -> Optional[str]:
    if not text:
        return None
    return text[:n] + ("..." if len(text) > n else "")
