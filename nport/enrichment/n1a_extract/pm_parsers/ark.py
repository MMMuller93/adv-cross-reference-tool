"""ARK Venture N-2/A portfolio-manager parser.

ARK Venture Fund N-2/A doesn't use a standardized "Portfolio Manager(s)" header.
The PM section appears as a "Portfolio Manager" label followed by a single
prose paragraph with the CIO's career biography:

  "Catherine D. Wood serves as Chief Investment Officer of the Fund. Having
   completed 12 years at AllianceBernstein LP, Ms. Wood founded ARK
   Investment Management LLC and registered the firm with the SEC in January 2014."

Strategy: Look for the bolded "Portfolio Manager" anchor, then capture the
following sentence beginning with a person's name and a role-defining verb
(serves, is, manages).

ARK Venture is a single-PM filing; we expect exactly one PortfolioManager
output.
"""
from __future__ import annotations

import re
from typing import Optional

from ..pm_types import PmExtractionResult, PortfolioManager

NAME_PART = r"[A-Z][A-Za-z'\-\.]+(?:\s+[A-Z]\.?(?:\s+[A-Z][A-Za-z'\-\.]+)?\s+|\s+)[A-Z][A-Za-z'\-\.]+"

# "Catherine D. Wood serves as Chief Investment Officer of the Fund."
SERVES_AS_PATTERN = re.compile(
    rf"(?P<name>{NAME_PART})\s+(?:serves as|is)\s+"
    rf"(?P<role>Chief Investment Officer|Portfolio Manager|"
    rf"Co-Portfolio Manager|Senior Portfolio Manager)"
    rf"(?:\s+of\s+the\s+Fund)?",
    re.IGNORECASE,
)

# "Ms. Wood founded ARK ... in January 2014"
FOUNDED_PATTERN = re.compile(
    r"founded\s+(?:ARK|the firm|the Adviser).{0,80}?(?P<year>\d{4})",
    re.IGNORECASE | re.DOTALL,
)


def parse(section_text: str) -> PmExtractionResult:
    """Parse ARK-style PM disclosures from a text section."""
    text = section_text or ""
    pms: list[PortfolioManager] = []
    seen: set[str] = set()

    for m in SERVES_AS_PATTERN.finditer(text):
        name = _normalize_name(m.group("name"))
        role = m.group("role").strip()
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        pm = PortfolioManager(
            name=name,
            role=role,
            source_filer="ark",
        )
        # Add founded-year as joined_firm if present in proximity
        f = FOUNDED_PATTERN.search(text)
        if f:
            pm.joined_firm = f.group("year")
        pms.append(pm)

    conf = 0.85 if pms else 0.0
    return PmExtractionResult(
        parser="ark",
        portfolio_managers=pms,
        confidence=conf,
        raw_excerpt=_excerpt(text),
    )


def _normalize_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip()


def _excerpt(text: str, n: int = 400) -> Optional[str]:
    if not text:
        return None
    return text[:n] + ("..." if len(text) > n else "")
