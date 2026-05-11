"""Fidelity N-CSR / N-CSRS acquisition-cost parser.

Format details (from /tmp/nport_research/ncsr_findings.md Filing 2):
  - The main Schedule of Investments lacks acquisition date/cost (just Shares + Value).
  - Acquisition date + cost live in a SEPARATE "Restricted Securities" footnote table.
  - That second table has columns: Security | Acquisition Date | Acquisition Cost ($)
  - Multi-tranche entries: date column may say "7/2/2024 - 6/16/2025" → emit
    is_multiple_tranches=True with tranche_start_date and tranche_end_date.

Strategy:
  1. Locate the restricted-securities footnote table by header anchor.
  2. Parse its rows.
  3. (Optional) Fuzzy-match each row back to the main SOI by security name —
     done downstream by the caller using normalize_name_for_match.

We DO NOT need to parse the main SOI because all the data we want is in the
restricted-securities table.
"""
from __future__ import annotations

import re
from typing import Optional

from lxml import html as lxml_html

from ..ncsr_types import AcquisitionEntry, NCsrExtractionResult

# Single date
DATE_PATTERN = re.compile(r"\b(\d{1,2}/\d{1,2}/\d{2,4})\b")
# Range — "7/2/2024 - 6/16/2025"
DATE_RANGE_PATTERN = re.compile(
    r"\b(\d{1,2}/\d{1,2}/\d{2,4})\s*[-–—]\s*(\d{1,2}/\d{1,2}/\d{2,4})\b"
)
MONEY_PATTERN = re.compile(r"\$?\s*([\d,]+(?:\.\d+)?)")


def parse(html_content: str | bytes) -> NCsrExtractionResult:
    """Parse the Fidelity restricted-securities footnote table.

    Returns an empty result with notes='no_restricted_table' if no recognizable
    table is found — callers can fall back to LLM extraction in that case.
    """
    html_bytes = html_content.encode("utf-8") if isinstance(html_content, str) else html_content
    try:
        doc = lxml_html.fromstring(html_bytes)
    except Exception as exc:
        return NCsrExtractionResult(
            parser="fidelity", entries=[], confidence=0.0, notes=f"parse_error: {exc}"
        )

    table = _find_restricted_table(doc)
    if table is None:
        return NCsrExtractionResult(
            parser="fidelity", entries=[], confidence=0.0, notes="no_restricted_table"
        )

    entries: list[AcquisitionEntry] = []
    seen: set[tuple] = set()
    for tr in table.xpath(".//tr"):
        cells = [" ".join((td.text_content() or "").split()) for td in tr.xpath("./td")]
        if len(cells) < 2:
            continue
        entry = _row_to_entry(cells)
        if entry is None:
            continue
        key = (entry.security_name, entry.acquisition_date_raw, entry.acquisition_cost_usd)
        if key in seen:
            continue
        seen.add(key)
        entries.append(entry)

    return NCsrExtractionResult(
        parser="fidelity",
        entries=entries,
        confidence=0.85 if entries else 0.0,
    )


def _find_restricted_table(doc) -> Optional[object]:
    """Find the <table> whose header row mentions both 'Acquisition Date'
    and 'Acquisition Cost' (or similar)."""
    for tbl in doc.xpath("//table"):
        header_text = " ".join((tbl.text_content() or "").split())[:600].lower()
        if "acquisition date" in header_text and "acquisition cost" in header_text:
            return tbl
    return None


def _row_to_entry(cells: list[str]) -> Optional[AcquisitionEntry]:
    """Translate a row of the restricted-securities table.

    Expected column layout (after stripping the header row): security_name |
    acquisition_date | acquisition_cost. Sometimes the layout has spacer columns;
    we therefore scan: first non-empty cell = name; first date-shaped cell = date;
    first money-shaped cell after the date = cost.
    """
    name = next((c for c in cells if c.strip()), None)
    if not name or _is_header_cell(name):
        return None

    # date detection: try range first, then single
    raw_range = None
    date_idx: Optional[int] = None
    for i, c in enumerate(cells):
        rm = DATE_RANGE_PATTERN.search(c)
        if rm:
            raw_range = rm
            date_idx = i
            break
        dm = DATE_PATTERN.search(c)
        if dm:
            raw_range = None
            date_idx = i
            break

    if date_idx is None:
        return None

    is_multi = False
    iso_date = None
    iso_start = None
    iso_end = None
    raw_date_text = cells[date_idx]
    if raw_range:
        is_multi = True
        iso_start = _date_to_iso(raw_range.group(1))
        iso_end = _date_to_iso(raw_range.group(2))
        # Use end-date as the primary acquisition_date for sort/index purposes
        iso_date = iso_end
    else:
        dm = DATE_PATTERN.search(raw_date_text)
        if dm:
            iso_date = _date_to_iso(dm.group(1))

    # Cost: first money-shaped cell after the date column
    cost: Optional[float] = None
    for c in cells[date_idx + 1 :]:
        c2 = c.strip()
        if not c2:
            continue
        m = MONEY_PATTERN.search(c2.replace(",", "").replace("$", ""))
        # Use a fresh re for the raw cell to keep the comma-stripping localized
        m2 = MONEY_PATTERN.search(c2)
        if m2:
            try:
                cost = float(m2.group(1).replace(",", ""))
                break
            except ValueError:
                pass

    security_name, share_class = _split_security_name(name)

    return AcquisitionEntry(
        security_name=security_name,
        share_class=share_class,
        acquisition_date=iso_date,
        acquisition_date_raw=raw_date_text,
        acquisition_cost_usd=cost,
        is_multiple_tranches=is_multi,
        tranche_start_date=iso_start,
        tranche_end_date=iso_end,
        source_filer="fidelity",
    )


def _is_header_cell(text: str) -> bool:
    t = text.lower().strip()
    return t in {
        "security",
        "acquisition date",
        "acquisition date(s)",
        "acquisition cost ($)",
        "acquisition cost",
        "cost",
    }


def _split_security_name(name: str) -> tuple[str, Optional[str]]:
    """Split 'Anthropic PBC Series E' → ('Anthropic PBC', 'Series E')."""
    m = re.match(
        r"^(?P<company>.+?)\s+(?P<cls>(?:Series|Class|Cl\.?)\s+\S+(?:\s+\S+)?)$",
        name,
        re.IGNORECASE,
    )
    if m:
        return m.group("company").strip(), m.group("cls").strip()
    return name, None


def _date_to_iso(raw: str) -> Optional[str]:
    m = DATE_PATTERN.match(raw)
    if not m:
        return None
    parts = m.group(1).split("/")
    if len(parts) != 3:
        return None
    mo, da, yr = parts
    if len(yr) == 2:
        year = 2000 + int(yr)
    else:
        year = int(yr)
    try:
        return f"{year:04d}-{int(mo):02d}-{int(da):02d}"
    except ValueError:
        return None
