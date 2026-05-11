"""T. Rowe Price N-CSR / N-CSRS acquisition-cost parser.

Per /tmp/nport_research/ncsr_findings.md Filing 3, TRP embeds acquisition date
and cost INLINE in the security-name string. Example:

  "Anthropic, Series F-1, Acquisition Date: 8/29/25, Cost $38,695 (1)(2)(3)
   274,498  69,840"

Pattern: ``Acquisition Date: (\\S+), Cost \\$([0-9,]+)``

Strategy: scan the doc for any text containing the inline pattern. The
preceding fragment up to the FIRST comma before "Acquisition Date" is the
company name (sometimes with class); we split downstream.
"""
from __future__ import annotations

import re
from typing import Optional

from lxml import html as lxml_html

from ..ncsr_types import AcquisitionEntry, NCsrExtractionResult

# The acquisition fact is stable: "Acquisition Date: <date>, Cost $<n>".
# Find that anchor first, then walk backwards from its start to recover the
# preceding "<name>, <class>" pair. We do this in two passes via Python rather
# than one regex, because TRP filings include header noise that confuses
# greedy regex backtracking.
ANCHOR_PATTERN = re.compile(
    r"Acquisition Date:\s*(?P<date>\d{1,2}/\d{1,2}/\d{2,4})"
    r"\s*,\s*Cost\s*\$?\s*(?P<cost>[\d,]+(?:\.\d+)?)",
    re.IGNORECASE,
)

# Words that, if they appear in the captured "name", indicate we grabbed
# table-header text rather than a real security name. We post-trim to the
# RIGHT-MOST clean segment.
NAME_NOISE_BREAKS = (
    "Schedule of Investments",
    "SCHEDULE OF INVESTMENTS",
    "Value ($)",
    "Security Name",
    "Shares",
    "Cost",
    "Fair Value",
)


def parse(html_content: str | bytes) -> NCsrExtractionResult:
    """Parse TRP-style inline acquisition data from N-CSR HTML."""
    html_bytes = html_content.encode("utf-8") if isinstance(html_content, str) else html_content
    try:
        doc = lxml_html.fromstring(html_bytes)
    except Exception as exc:
        return NCsrExtractionResult(
            parser="trp", entries=[], confidence=0.0, notes=f"parse_error: {exc}"
        )

    full_text = " ".join((doc.text_content() or "").split())

    entries: list[AcquisitionEntry] = []
    seen: set[tuple] = set()
    for m in ANCHOR_PATTERN.finditer(full_text):
        anchor_start = m.start()
        raw_date = m.group("date")
        cost_str = m.group("cost").replace(",", "")
        try:
            cost = float(cost_str)
        except ValueError:
            cost = None
        # Walk backwards from anchor_start to find the name (and optional class)
        raw_name = _extract_name_before(full_text, anchor_start)
        if not raw_name:
            continue
        security_name, share_class = _split_security_name(raw_name)
        iso_date = _date_to_iso(raw_date)
        key = (security_name, share_class, iso_date, cost)
        if key in seen:
            continue
        seen.add(key)
        entries.append(
            AcquisitionEntry(
                security_name=security_name,
                share_class=share_class,
                acquisition_date=iso_date,
                acquisition_date_raw=raw_date,
                acquisition_cost_usd=cost,
                source_filer="trp",
            )
        )

    return NCsrExtractionResult(
        parser="trp",
        entries=entries,
        confidence=0.92 if entries else 0.0,
    )


def _trim_noise(name: str) -> str:
    """Remove leading table-header noise that the lazy regex may have grabbed.

    For "SCHEDULE OF INVESTMENTS Security Name Shares Value ($) Anthropic"
    return just "Anthropic" — split on the last occurrence of any noise phrase
    and keep what follows.
    """
    cleaned = name
    for noise in NAME_NOISE_BREAKS:
        idx = cleaned.rfind(noise)
        if idx >= 0:
            cleaned = cleaned[idx + len(noise) :].strip().strip("$()")
    return cleaned.strip()


def _extract_name_before(full_text: str, anchor_start: int, *, lookback_chars: int = 200) -> str:
    """Walk backwards from the anchor position to recover the security name.

    The name ends just before the most recent comma-space sequence that
    immediately precedes the anchor. Format is:
        '<Company>, <Class>, Acquisition Date: ...'
    or:
        '<Company>, Acquisition Date: ...'

    Returns the cleaned name with any noise stripped.
    """
    start = max(0, anchor_start - lookback_chars)
    fragment = full_text[start:anchor_start].rstrip()
    # The anchor is preceded by ", "; the segment we want is the name+class
    # back to a natural sentence/cell break (preceding HTML cell delimiter is
    # collapsed into whitespace, so a long run of whitespace is the next
    # break boundary).
    # Strip trailing comma+whitespace
    fragment = fragment.rstrip(", \t")
    # Take everything up to the last 2+ spaces (cell boundary) OR newline
    # Since the document.text_content() output collapses cell boundaries to
    # single spaces, we instead use known header keywords as boundary markers.
    cleaned = _trim_noise(fragment)
    # Constrain to roughly the last ~120 chars (a security name + class is
    # always shorter than this)
    if len(cleaned) > 120:
        cleaned = cleaned[-120:]
        # If we cut mid-word, advance to the next space
        if cleaned and not cleaned[0].isspace():
            sp = cleaned.find(" ")
            if sp > 0:
                cleaned = cleaned[sp + 1 :]
    return cleaned.strip().rstrip(",")


def _split_security_name(name: str) -> tuple[str, Optional[str]]:
    m = re.match(
        r"^(?P<company>.+?)\s*,?\s*(?P<cls>(?:Series|Class|Common Stock|Preferred|Cl\.?)\s+\S+(?:\s+\S+)?)$",
        name,
        re.IGNORECASE,
    )
    if m:
        return m.group("company").strip(), m.group("cls").strip()
    return name, None


def _date_to_iso(raw: str) -> Optional[str]:
    parts = raw.split("/")
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
