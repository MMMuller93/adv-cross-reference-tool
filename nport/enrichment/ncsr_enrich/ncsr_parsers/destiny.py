"""Destiny Tech100 (DXYZ) N-CSR iXBRL parser.

Per /tmp/nport_research/ncsr_findings.md (Filing 4):
  Columns: Security Name, Acquisition Date, Cost, Fair Value
  XBRL-tagged numeric values are wrapped in <ix:nonFraction> elements.

Strategy: walk the iXBRL <ix:nonFraction> and <ix:nonNumeric> elements and
group them by their containing <tr>. The numeric facts have decimals and unit
attributes that confirm USD. Dates may also be tagged but more commonly they
sit as plain text in the same row.
"""
from __future__ import annotations

import re
from typing import Optional

from lxml import etree, html as lxml_html

from ..ncsr_types import AcquisitionEntry, NCsrExtractionResult

# inline-XBRL namespace
IXBRL_NS = {"ix": "http://www.xbrl.org/2013/inlineXBRL"}
DATE_PATTERN = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b")


def parse(html_content: str | bytes) -> NCsrExtractionResult:
    """Parse Destiny / iXBRL-tagged N-CSR HTML."""
    html_bytes = html_content.encode("utf-8") if isinstance(html_content, str) else html_content
    try:
        doc = lxml_html.fromstring(html_bytes)
    except Exception as exc:
        return NCsrExtractionResult(parser="destiny", entries=[], confidence=0.0, notes=f"parse_error: {exc}")

    entries: list[AcquisitionEntry] = []
    seen: set[tuple] = set()

    for tr in doc.xpath("//tr"):
        cells: list[str] = []
        for td in tr.xpath("./td"):
            cells.append(" ".join((td.text_content() or "").split()))
        if len(cells) < 3:
            continue
        # Use the iXBRL fact tags as a confirmation signal: at least one
        # numeric-fact tag with decimals or unit attribute indicates a real
        # SOI numeric, not page-noise.
        has_ixbrl_fact = bool(tr.xpath(".//*[local-name()='nonFraction']"))
        entry = _row_to_entry(cells, has_ixbrl_fact=has_ixbrl_fact)
        if entry is None:
            continue
        key = (entry.security_name, entry.acquisition_date_raw, entry.acquisition_cost_usd)
        if key in seen:
            continue
        seen.add(key)
        entries.append(entry)

    return NCsrExtractionResult(
        parser="destiny",
        entries=entries,
        confidence=0.85 if entries else 0.0,
    )


def _row_to_entry(cells: list[str], *, has_ixbrl_fact: bool) -> Optional[AcquisitionEntry]:
    # First non-empty cell is name
    name = next((c for c in cells if c.strip() and c.strip() != "*"), None)
    if not name:
        return None
    name = re.sub(r"\*+$", "", name).strip()

    # Find date cell — Destiny uses mm/dd/yy
    date_match = None
    date_idx = None
    for i, c in enumerate(cells):
        m = DATE_PATTERN.search(c)
        if m:
            date_match = m
            date_idx = i
            break
    if not date_match:
        return None

    raw_date = date_match.group(0)
    iso_date = _date_to_iso(raw_date)

    # Cost / FV: next numeric cells after the date column
    numbers: list[float] = []
    for c in cells[(date_idx or 0) + 1 :]:
        s = c.strip().replace("$", "").replace(",", "")
        if not s or s == "—" or s == "-":
            continue
        try:
            numbers.append(float(s))
        except ValueError:
            continue
    cost = numbers[0] if len(numbers) >= 1 else None
    value = numbers[1] if len(numbers) >= 2 else None

    # If no iXBRL fact and no numbers, this is likely a noise row — skip
    if not has_ixbrl_fact and not numbers:
        return None

    security_name, share_class = _split_security_name(name)

    return AcquisitionEntry(
        security_name=security_name,
        share_class=share_class,
        acquisition_date=iso_date,
        acquisition_date_raw=raw_date,
        acquisition_cost_usd=cost,
        fair_value_usd=value,
        source_filer="destiny",
    )


def _split_security_name(name: str) -> tuple[str, Optional[str]]:
    """Split name into (company, share_class). Destiny holds SPV positions:
    'Celadon Technology Fund VIII, LLC - Series B (economic exposure to ...)'

    Preserve the SPV name as the security_name (matching is done downstream
    via the (economic exposure to X) unwrapping pattern in §3.1 of the plan).
    """
    m = re.match(
        r"^(?P<company>.+?)(?:,\s*)?\s*-\s*(?P<cls>(?:Series|Class)[^()]*?)\s*(\(|$)",
        name,
    )
    if m:
        return m.group("company").strip(), m.group("cls").strip()
    return name, None


def _date_to_iso(raw: str) -> Optional[str]:
    m = DATE_PATTERN.search(raw)
    if not m:
        return None
    mo, da, yr = m.groups()
    if len(yr) == 2:
        year = 2000 + int(yr)
    else:
        year = int(yr)
    try:
        return f"{year:04d}-{int(mo):02d}-{int(da):02d}"
    except ValueError:
        return None
