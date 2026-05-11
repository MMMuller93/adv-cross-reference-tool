"""T. Rowe Price 485BPOS portfolio-manager parser.

Two formats in the same filing:

1) HTML table in Fund Summary — columns: Name | Title | Managed Fund Since | Joined Investment Adviser
   The Global Tech fixture is multi-line: each <td> wraps the value across newlines, so
   we work from the plain-text of the table cells rather than fixed-width parsing.

2) Free-text narrative — pattern:
   "The portfolio manager is Dom Rizzo."
   "Mr. Rizzo served as co-portfolio manager of the fund beginning in 2022, and became sole portfolio manager in 2023."
   "He joined the Firm in 2015..."

We use approach (2) first because it's universal across TRP single-PM funds.
The table parser is a secondary signal for the rare multi-PM case.
"""
from __future__ import annotations

import re
from typing import Optional

from lxml import html as lxml_html

from ..pm_types import PmExtractionResult, PortfolioManager

NAME_PART = r"[A-Z][A-Za-z'\-\.]+(?:\s+[A-Z][A-Za-z'\-\.]+){1,3}"

# "The portfolio manager is Dom Rizzo." (the most stable TRP anchor)
SINGLE_PM_PATTERN = re.compile(
    rf"(?:The\s+)?portfolio manager(?:\s+for\s+the\s+fund)?\s+is\s+(?P<name>{NAME_PART})\.",
    re.IGNORECASE,
)

# "Mr. Rizzo served as co-portfolio manager of the fund beginning in 2022,
#  and became sole portfolio manager in 2023."
ROLE_TENURE_PATTERN = re.compile(
    rf"(?:Mr\.|Ms\.|Mrs\.|Dr\.)?\s*(?P<last>[A-Z][A-Za-z'\-\.]+)\s+"
    rf"(?:served as|became|has served as)\s+"
    rf"(?P<role>(?:co-?|sole\s+)?(?:lead\s+)?portfolio manager)"
    rf".{{0,80}}?(?:beginning in|in|since)\s+(?P<year>\d{{4}})",
    re.IGNORECASE | re.DOTALL,
)

# "He joined the Firm in 2015"
JOINED_FIRM_PATTERN = re.compile(
    r"joined the (?:Firm|firm|Adviser|adviser)\s+in\s+(?P<year>\d{4})",
    re.IGNORECASE,
)


def parse(section_text: str, *, full_html: Optional[str] = None) -> PmExtractionResult:
    """Parse TRP-style PM disclosures from a text section."""
    pms: list[PortfolioManager] = []
    name: Optional[str] = None
    managed_since: Optional[str] = None
    joined_firm: Optional[str] = None
    role: Optional[str] = None

    # Primary: "The portfolio manager is X"
    m = SINGLE_PM_PATTERN.search(section_text or "")
    if m:
        name = m.group("name").strip()

    # If table parsing is needed and HTML is provided
    if not name and full_html:
        name, managed_since, joined_firm, role = _try_table_parse(full_html)

    # Role + managed-since via narrative
    rt = ROLE_TENURE_PATTERN.search(section_text or "")
    if rt:
        # Use the matched role + earliest year as managed_since
        role_text = rt.group("role").strip()
        # Normalize "co-portfolio manager" / "sole portfolio manager" / "portfolio manager"
        role = role or _normalize_role(role_text)
        # Take the earliest mentioned year as 'managed_since'
        all_years = re.findall(r"\b(20\d{2}|19\d{2})\b", rt.group(0))
        if all_years:
            managed_since = managed_since or min(all_years)

    jm = JOINED_FIRM_PATTERN.search(section_text or "")
    if jm:
        joined_firm = joined_firm or jm.group("year")

    if name:
        pms.append(
            PortfolioManager(
                name=name,
                role=role or "Portfolio Manager",
                managed_since=managed_since,
                joined_firm=joined_firm,
                source_filer="trp",
            )
        )

    conf = 0.92 if pms else 0.0
    return PmExtractionResult(
        parser="trp",
        portfolio_managers=pms,
        confidence=conf,
        raw_excerpt=_excerpt(section_text),
    )


def _normalize_role(text: str) -> str:
    t = text.lower()
    if "sole" in t:
        return "Portfolio Manager"
    if "co" in t:
        return "Co-Portfolio Manager"
    return "Portfolio Manager"


def _try_table_parse(html_content: str) -> tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
    """Try the fund-summary management table.

    Returns (name, managed_since, joined_firm, role) — any may be None.
    """
    try:
        doc = lxml_html.fromstring(html_content)
    except Exception:
        return None, None, None, None

    # Find a table whose header text contains both "Managed Fund Since" and "Joined"
    for tbl in doc.xpath("//table"):
        full = " ".join((tbl.text_content() or "").split())
        if "Portfolio Manager" not in full:
            continue
        if "Managed" not in full and "Joined" not in full:
            continue
        # collect rows; locate one where a year appears
        rows = tbl.xpath(".//tr")
        for tr in rows:
            tds = tr.xpath(".//td")
            if len(tds) < 2:
                continue
            cells = [" ".join((td.text_content() or "").split()) for td in tds]
            joined = " | ".join(cells)
            year_matches = re.findall(r"\b(20\d{2}|19\d{2})\b", joined)
            name_match = re.search(r"\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b", joined)
            if year_matches and name_match:
                name = name_match.group(1).strip()
                # First year = managed since, second year = joined adviser
                managed_since = year_matches[0]
                joined_firm = year_matches[1] if len(year_matches) > 1 else None
                role = None
                if "Co-" in joined or "co-" in joined:
                    role = "Co-Portfolio Manager"
                elif "Portfolio Manager" in joined:
                    role = "Portfolio Manager"
                return name, managed_since, joined_firm, role
    return None, None, None, None


def _excerpt(text: str, n: int = 400) -> Optional[str]:
    if not text:
        return None
    return text[:n] + ("..." if len(text) > n else "")
