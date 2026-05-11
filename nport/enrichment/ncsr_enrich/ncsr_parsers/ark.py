"""ARK Venture N-CSR / N-CSRS acquisition-cost parser.

Format: clean HTML <table> with the schedule of investments. Each row has td
cells in order: Name, blank, AcqDate, blank, Shares, blank, blank, Cost,
blank, FairValue. Footnote codes are attached as superscript spans inside the
Name cell.

We extract every row that has a recognizable mm/dd/yy date AND a numeric value.
Restricted-securities-only filtering is left to the caller: per the ARK SOI
convention, ALL rows with a date column populated are private/restricted.
"""
from __future__ import annotations

import re
from typing import Optional

from lxml import html as lxml_html

from ..ncsr_types import AcquisitionEntry, NCsrExtractionResult

DATE_PATTERN = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$")
NUMBER_PATTERN = re.compile(r"^-?\$?\s*([\d,]+(?:\.\d+)?)$")
FOOTNOTE_PATTERN = re.compile(r"\(([a-z](?:\)\([a-z])*)\)")


def parse(html_content: str | bytes) -> NCsrExtractionResult:
    """Parse an ARK Venture N-CSR HTML doc and return acquisition entries."""
    html_bytes = html_content.encode("utf-8") if isinstance(html_content, str) else html_content

    try:
        doc = lxml_html.fromstring(html_bytes)
    except Exception as exc:
        return NCsrExtractionResult(parser="ark", entries=[], confidence=0.0, notes=f"parse_error: {exc}")

    entries: list[AcquisitionEntry] = []
    seen_keys: set[tuple] = set()

    for tr in doc.xpath("//tr"):
        cells = []
        for td in tr.xpath("./td"):
            text = " ".join((td.text_content() or "").split())
            cells.append(text)
        if len(cells) < 3:
            continue
        entry = _row_to_entry(cells)
        if entry is None:
            continue
        # dedupe identical rows that the SOI may repeat as carry-over from prior page
        key = (entry.security_name, entry.acquisition_date_raw, entry.acquisition_cost_usd)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        entries.append(entry)

    return NCsrExtractionResult(
        parser="ark",
        entries=entries,
        confidence=0.9 if entries else 0.0,
    )


def _row_to_entry(cells: list[str]) -> Optional[AcquisitionEntry]:
    """Translate a TD-array into an AcquisitionEntry.

    We look for the first date-shaped cell, then take the next two non-empty
    numeric cells as (shares, cost) with the third being fair_value.

    Skip rows that don't have BOTH a date AND a numeric cost.
    """
    # First non-empty text cell is the security name
    name = next((c for c in cells if c.strip() and c.strip() != "*"), None)
    if not name:
        return None
    # Drop stray asterisks and footnote-label suffixes for storage
    raw_name = re.sub(r"\*+$", "", name).strip()

    # extract footnotes inside the name string
    footnote_codes = []
    fn_match = re.search(r"\(([a-z](?:\)\([a-z])*)\)$", raw_name)
    if fn_match:
        # collect all single-letter codes like (a)(b)(c)
        footnote_codes = re.findall(r"\(([a-z])\)", raw_name)
        raw_name = re.sub(r"(\([a-z]\))+\s*$", "", raw_name).strip()
    raw_name = re.sub(r"\s+\*\s*$", "", raw_name).strip()

    # Find date cell
    date_idx: Optional[int] = None
    for i, c in enumerate(cells):
        if DATE_PATTERN.match(c.strip()):
            date_idx = i
            break
    if date_idx is None:
        return None

    raw_date = cells[date_idx].strip()
    iso_date = _date_to_iso(raw_date)

    # Collect numbers in cells AFTER the date
    numbers: list[float] = []
    for c in cells[date_idx + 1 :]:
        c2 = c.strip().replace("$", "").replace(",", "").strip()
        if not c2 or c2 == "—" or c2 == "-":
            continue
        try:
            n = float(c2)
            numbers.append(n)
        except ValueError:
            continue

    # ARK column order: shares, cost, value (sometimes shares, cost, value with
    # blank spacer cells; we collapse the non-empty numerics in order).
    shares = numbers[0] if len(numbers) >= 1 else None
    cost = numbers[1] if len(numbers) >= 2 else None
    value = numbers[2] if len(numbers) >= 3 else None

    # Split name into "Company Name" and "share class" — ARK uses commas:
    # "Anthropic, Inc., Series C-1" → name="Anthropic, Inc.", class="Series C-1"
    security_name, share_class = _split_security_name(raw_name)

    return AcquisitionEntry(
        security_name=security_name,
        share_class=share_class,
        acquisition_date=iso_date,
        acquisition_date_raw=raw_date,
        acquisition_cost_usd=cost,
        fair_value_usd=value,
        shares=shares,
        footnotes=",".join(footnote_codes) if footnote_codes else None,
        source_filer="ark",
    )


def _split_security_name(name: str) -> tuple[str, Optional[str]]:
    """Split 'Anthropic, Inc., Series C-1' → ('Anthropic, Inc.', 'Series C-1').

    Heuristic: if a "Series X", "Class X", "Common Stock", or "Preferred" appears
    after a comma, treat everything before it as company name.
    """
    share_class_pat = re.compile(
        r"^(?P<company>.+?),?\s*(?P<cls>(?:Series|Class|Common Stock|Preferred(?: Stock)?|SAFE|Convertible Note|Warrant|Cl\.?)[^,]*)$",
        re.IGNORECASE,
    )
    m = share_class_pat.match(name)
    if m:
        company = m.group("company").rstrip(", ").strip()
        cls = m.group("cls").strip()
        return company, cls
    return name, None


def _date_to_iso(raw: str) -> Optional[str]:
    m = DATE_PATTERN.match(raw)
    if not m:
        return None
    mo, da, yr = m.groups()
    if len(yr) == 2:
        # Assume 20XX for fund filings — N-CSR universe is 2000+
        year = 2000 + int(yr)
    else:
        year = int(yr)
    try:
        return f"{year:04d}-{int(mo):02d}-{int(da):02d}"
    except ValueError:
        return None
