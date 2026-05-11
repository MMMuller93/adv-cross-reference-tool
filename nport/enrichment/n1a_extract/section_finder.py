"""Locate the Portfolio-Manager / Fund-Management section of a 485BPOS / N-1A / N-2 HTML.

The full filing is typically 4–14 MB of HTML; the PM section is a small slice.
We narrow the document by anchoring on heading text variants, then return
the surrounding plain text of that block.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from lxml import html as lxml_html

# Heading variants observed in real filings.
# Order matters: the most specific anchor phrases come first. Earlier-in-list
# anchors win when picking the canonical PM section.
DEFAULT_HEADINGS = (
    "portfolio manager(s)",   # Fidelity prospectus header
    "portfolio manager.",     # Baron section label (literal "Portfolio Manager.")
    "portfolio management",   # T. Rowe Price extended section heading
    "portfolio manager",      # generic fallback — matches the longer phrases above
    "management of the fund", # N-1A item 9 / 10 narrative heading
    "fund management",        # generic
    "investment adviser",     # ARK / DXYZ N-2 closed-end fallback
)

# Keyword phrases inside the PM section that confirm we're in the right place.
# Used to pick the BEST match when multiple heading candidates appear (e.g.
# table-of-contents at top of doc + actual PM section in body).
# These are STRONG anchors that only appear in the actual PM disclosure and
# not in generic "investment adviser" descriptions elsewhere in the document.
PM_CONFIRMATION_PHRASES = (
    "has managed the fund",
    "has been the lead portfolio manager",
    "has been the portfolio manager",
    "has been the co-manager",
    "co-portfolio manager) has",
    "the portfolio manager is",
    "investment committee is",
    "serves as chief investment officer",
    "is the lead portfolio manager",
    "managed fund since",
    "has been a portfolio manager",
)


@dataclass
class PmSection:
    """A located PM section with surrounding raw text and HTML."""

    headings_matched: tuple[str, ...]
    text: str       # collapsed plain text of the section
    html: str       # raw HTML slice (for tabular parsers like TRP)


def _strip_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _coerce_html(content: str | bytes) -> tuple[bytes, str]:
    """Return (bytes, str) views of HTML.

    lxml.html refuses str input that contains an encoding declaration; it needs
    bytes for that. We keep the str form too for downstream parsers that prefer
    string operations.
    """
    if isinstance(content, bytes):
        return content, content.decode("utf-8", errors="replace")
    return content.encode("utf-8"), content


def find_pm_section(
    html_content: str | bytes,
    *,
    headings: tuple[str, ...] = DEFAULT_HEADINGS,
    context_chars: int = 6000,
) -> Optional[PmSection]:
    """Find the first PM-related heading in the doc and return surrounding text.

    Args:
        html_content: full filing HTML (string or bytes)
        headings: tuple of case-insensitive heading substrings to search for
        context_chars: how many characters AFTER the matched heading to include
            in the returned slice (we want enough to capture all PMs but not the
            entire filing — most PM sections are < 3000 chars of plain text)

    Returns:
        PmSection if a heading was found; None otherwise.
    """
    html_bytes, html_str = _coerce_html(html_content)

    # Parse HTML defensively. Some filings have malformed nested tags; lxml
    # handles this fine with html.fromstring.
    try:
        doc = lxml_html.fromstring(html_bytes)
    except Exception:
        return None

    # Get all plain text — lxml text_content() walks the tree and concatenates.
    # This loses absolute position but keeps document order, which is what we need
    # to find the heading.
    raw_text = doc.text_content() or ""
    # Normalize whitespace so multi-line phrases like "serves as\n\nchief
    # investment officer" match a single phrase regex/find.
    full_text = re.sub(r"\s+", " ", raw_text)

    text_lc = full_text.lower()

    # Strategy: anchor on the strongest PM_CONFIRMATION_PHRASES first.
    # These are short, specific phrases that only occur inside an actual PM
    # disclosure (not in table-of-contents or generic adviser descriptions).
    # If we find one, we take a window centered slightly before it (so the
    # preceding heading like "Portfolio Manager(s)" is included).
    first_strong_hit: Optional[int] = None
    for phrase in PM_CONFIRMATION_PHRASES:
        idx = text_lc.find(phrase)
        if idx != -1:
            if first_strong_hit is None or idx < first_strong_hit:
                first_strong_hit = idx

    if first_strong_hit is not None:
        # Backtrack up to 400 chars to include the preceding heading
        start = max(0, first_strong_hit - 400)
        chosen_heading = "<auto-anchored to PM phrase>"
    else:
        # No strong PM phrase found — fall back to heading-based search.
        # This handles closed-end funds (N-2) like DXYZ where the PM identity
        # is buried in corporate-ownership prose without standard headings.
        candidates: list[tuple[str, int]] = []
        for h in headings:
            h_lc = h.lower()
            pos = 0
            while True:
                idx = text_lc.find(h_lc, pos)
                if idx == -1:
                    break
                candidates.append((h, idx))
                pos = idx + 1
        if not candidates:
            return None
        candidates.sort(key=lambda t: t[1])
        chosen_heading, start = candidates[0]

    end = min(len(full_text), start + context_chars)
    slice_text = _strip_ws(full_text[start:end])

    # For HTML slice — we don't have a precise mapping from char offset back to
    # the source HTML. Return the full source HTML; downstream parsers that need
    # tables can re-locate by heading. (TRP parser does this.)
    return PmSection(
        headings_matched=(chosen_heading,),
        text=slice_text,
        html=html_str,
    )


def find_all_pm_text_blocks(
    html_content: str | bytes,
    *,
    headings: tuple[str, ...] = DEFAULT_HEADINGS,
    context_chars: int = 4000,
) -> list[PmSection]:
    """Return every distinct PM-section text block in the doc.

    Useful for multi-series filings (Baron Select Funds has Partners + Focused
    Growth + others, each with its own PM section).
    """
    html_bytes, _ = _coerce_html(html_content)
    try:
        doc = lxml_html.fromstring(html_bytes)
    except Exception:
        return []
    html_str = html_bytes.decode("utf-8", errors="replace")

    full_text = doc.text_content() or ""
    text_lc = full_text.lower()

    indices: set[int] = set()
    for h in headings:
        start = 0
        h_lc = h.lower()
        while True:
            idx = text_lc.find(h_lc, start)
            if idx == -1:
                break
            indices.add(idx)
            start = idx + 1

    if not indices:
        return []

    sorted_idx = sorted(indices)
    # collapse adjacent indices that fall within the same context window
    collapsed: list[int] = []
    for idx in sorted_idx:
        if not collapsed or idx - collapsed[-1] > context_chars // 2:
            collapsed.append(idx)

    out: list[PmSection] = []
    for idx in collapsed:
        end = min(len(full_text), idx + context_chars)
        out.append(
            PmSection(
                headings_matched=(),
                text=_strip_ws(full_text[idx:end]),
                html=html_str,
            )
        )
    return out
