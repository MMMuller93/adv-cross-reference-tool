#!/usr/bin/env python3
"""
Wikipedia unicorn list loader.

Source: https://en.wikipedia.org/wiki/List_of_unicorn_startup_companies
        (CC BY-SA 4.0 — attribution required; we preserve `seed_source='wikipedia'`
        and the raw page slug in output metadata)

Pulls the page's wikitext via the MediaWiki API, finds the two relevant
sortable tables (active unicorns + exited unicorns), splits row-by-row,
strips wikitext markup, and emits one JSON document per company.

Output file: `wikipedia_unicorns.json` (alongside this script).

Verified against PLAN_NPORT_HOLDINGS.md §6.7: ~618 active + ~206 exited rows
including SpaceX (1,250B), OpenAI (852B), Anthropic (380B), ByteDance (330B),
Stripe (159B).
"""
from __future__ import annotations

import json
import re
import sys
import time
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any

import requests

WIKI_API = "https://en.wikipedia.org/w/api.php"
PAGE_TITLE = "List of unicorn startup companies"
USER_AGENT = "Miles Muller mmmuller93@gmail.com"
SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_PATH = SCRIPT_DIR / "wikipedia_unicorns.json"

# --- markup-strip regex pre-compilation --------------------------------------
RE_REF = re.compile(r"<ref[^>]*?(?:/>|>.*?</ref>)", re.DOTALL | re.IGNORECASE)
RE_REF_NAME = re.compile(r"<ref [^>]*/>", re.IGNORECASE)
RE_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
RE_HTML_TAG = re.compile(r"<[^>]+>")
RE_FLAG = re.compile(r"\{\{flag\|([^}|]+)(?:\|[^}]*)?\}\}", re.IGNORECASE)
RE_START_DATE = re.compile(r"\{\{start date\s*\|\s*(\d{4})(?:\s*\|\s*(\d{1,2}))?(?:\s*\|\s*(\d{1,2}))?\s*\}\}", re.IGNORECASE)
RE_GENERIC_TEMPLATE = re.compile(r"\{\{[^{}]*\}\}")  # apply repeatedly
RE_PIPED_LINK = re.compile(r"\[\[([^\]\|]+)\|([^\]]+)\]\]")
RE_PLAIN_LINK = re.compile(r"\[\[([^\]]+)\]\]")
RE_EXTERNAL_LINK = re.compile(r"\[https?://[^\s\]]+\s+([^\]]+)\]")
RE_BARE_URL = re.compile(r"\[https?://[^\s\]]+\]")
RE_BOLD_ITALIC = re.compile(r"'''?")
RE_WS = re.compile(r"\s+")


@dataclass
class UnicornEntry:
    """One row from a Wikipedia unicorn table."""

    company: str
    valuation_usd_billions: float | None
    valuation_date: str | None
    industry: str | None
    country: str | None
    founders: list[str]
    table: str  # 'active' | 'exited'
    exit_date: str | None = None
    exit_reason: str | None = None
    exit_valuation_usd_billions: float | None = None
    seed_source: str = "wikipedia"
    raw_cells: list[str] = field(default_factory=list)


def fetch_wikitext(session: requests.Session) -> str:
    """Call the MediaWiki API and return the wikitext blob."""
    params = {
        "action": "parse",
        "page": PAGE_TITLE,
        "prop": "wikitext",
        "format": "json",
        "formatversion": "2",
    }
    r = session.get(WIKI_API, params=params, timeout=60)
    r.raise_for_status()
    payload = r.json()
    return payload["parse"]["wikitext"]


def strip_markup(s: str) -> str:
    """Convert a wikitext fragment to plain text. Best-effort, not exhaustive."""
    if not s:
        return ""
    s = RE_REF.sub("", s)
    s = RE_REF_NAME.sub("", s)
    s = RE_COMMENT.sub("", s)
    # {{flag|USA}} -> USA
    s = RE_FLAG.sub(r"\1", s)
    # {{start date|2026|02|15}} -> 2026-02-15
    def _date_sub(m: re.Match) -> str:
        y, mo, d = m.group(1), m.group(2), m.group(3)
        out = y
        if mo:
            out += f"-{int(mo):02d}"
        if d:
            out += f"-{int(d):02d}"
        return out
    s = RE_START_DATE.sub(_date_sub, s)
    # Strip remaining templates iteratively (handles a couple of nesting layers)
    for _ in range(4):
        new = RE_GENERIC_TEMPLATE.sub("", s)
        if new == s:
            break
        s = new
    # [[Foo|Bar]] -> Bar
    s = RE_PIPED_LINK.sub(r"\2", s)
    # [[Foo]] -> Foo
    s = RE_PLAIN_LINK.sub(r"\1", s)
    # [https://… display] -> display
    s = RE_EXTERNAL_LINK.sub(r"\1", s)
    s = RE_BARE_URL.sub("", s)
    # Strip HTML tags
    s = RE_HTML_TAG.sub("", s)
    # Strip bold/italic markers
    s = RE_BOLD_ITALIC.sub("", s)
    # Collapse whitespace
    s = RE_WS.sub(" ", s).strip()
    # A common artifact: leading "align=left |" or similar table attrs
    s = re.sub(r"^(?:align|style|colspan|rowspan|scope|class|id)=[\"']?[^|]*?[\"']?\s*\|\s*", "", s, flags=re.IGNORECASE)
    return s.strip()


def parse_valuation(text: str) -> float | None:
    """Parse '1250' or '1+' or '$2.5 billion' style figures to a float (in USD billions)."""
    if not text:
        return None
    # Strip plus sign at end ("1+" common Wiki idiom for "at least 1")
    cleaned = text.replace(",", "").replace("$", "").replace("+", "").strip()
    # Sometimes value is given as e.g. "1.5 billion" — strip that
    cleaned = re.sub(r"\b(billion|bn|b)\b", "", cleaned, flags=re.IGNORECASE).strip()
    # Take first numeric token
    m = re.search(r"-?\d+(?:\.\d+)?", cleaned)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def split_founders(text: str) -> list[str]:
    """Split a founders cell into a list. Handles 'A, B and C' / 'A, B, C' / 'A & B'."""
    if not text:
        return []
    # Normalize separators
    s = re.sub(r"\band\b", ",", text, flags=re.IGNORECASE)
    s = s.replace("&", ",")
    parts = [p.strip(" .;") for p in s.split(",")]
    return [p for p in parts if p and len(p) > 1]


def extract_tables(wikitext: str) -> dict[str, str]:
    """
    Find the two target tables in the page:
      - 'active'  — main list of current unicorns
      - 'exited'  — IPO / acquired former unicorns

    Returns dict {table_key: raw_table_text}.
    """
    # The two tables we want have this exact opening line:
    table_marker = '{| class="wikitable sortable sticky-header"'
    starts: list[int] = []
    pos = 0
    while True:
        idx = wikitext.find(table_marker, pos)
        if idx == -1:
            break
        starts.append(idx)
        pos = idx + len(table_marker)

    if len(starts) < 2:
        raise RuntimeError(
            f"Expected at least 2 sortable wikitables, found {len(starts)}. "
            "Wikipedia page structure may have changed."
        )

    tables: dict[str, str] = {}
    for key, start in zip(["active", "exited"], starts[:2]):
        # Find the closing '|}' for this table
        end = wikitext.find("\n|}", start)
        if end == -1:
            end = len(wikitext)
        tables[key] = wikitext[start:end]
    return tables


def parse_row_cells(row: str) -> list[str]:
    """
    Split a wikitable row into individual cell strings.

    Each cell starts with '|' (or '!' for header) on its own line. Multi-line
    cells (cells that span lines, e.g. containing a citation) keep everything
    until the next leading '|' or end of row.
    """
    cells: list[str] = []
    current: list[str] = []
    for raw_line in row.split("\n"):
        line = raw_line.rstrip("\r")
        # Skip blank / table-attribute lines
        if not line:
            continue
        if line.startswith("|+"):
            # caption
            continue
        if line.startswith("!"):
            # header marker — emit nothing in row mode
            continue
        # New cell delimiter
        if line.startswith("|"):
            if current:
                cells.append("\n".join(current).strip())
                current = []
            # Some rows use '|| ' as inline cell-separator
            line_content = line[1:]
            # Inline '||' splits multiple cells on one line
            if "||" in line_content:
                inline_parts = line_content.split("||")
                cells.append(inline_parts[0].strip())
                for p in inline_parts[1:-1]:
                    cells.append(p.strip())
                current = [inline_parts[-1]]
            else:
                current = [line_content]
        else:
            # continuation of current cell
            current.append(line)
    if current:
        cells.append("\n".join(current).strip())
    return cells


def parse_active_row(cells: list[str]) -> UnicornEntry | None:
    """
    Active table columns:
      0: Company
      1: Valuation (US$ billions)
      2: Valuation date
      3: Industry
      4: Country
      5: Founder(s)
    """
    if len(cells) < 5:
        return None
    company = strip_markup(cells[0])
    if not company:
        return None
    valuation = parse_valuation(strip_markup(cells[1]))
    val_date = strip_markup(cells[2]) or None
    industry = strip_markup(cells[3]) or None
    country = strip_markup(cells[4]) or None
    founders_text = strip_markup(cells[5]) if len(cells) > 5 else ""
    founders = split_founders(founders_text)
    return UnicornEntry(
        company=company,
        valuation_usd_billions=valuation,
        valuation_date=val_date,
        industry=industry,
        country=country,
        founders=founders,
        table="active",
        raw_cells=[strip_markup(c) for c in cells],
    )


def parse_exited_row(cells: list[str]) -> UnicornEntry | None:
    """
    Exited table columns:
      0: Company
      1: Last valuation (US$ billions)
      2: Valuation date
      3: Exit date
      4: Exit reason
      5: Exit valuation (US$ billions)
      6: Country
      7: Founders
    """
    if len(cells) < 7:
        return None
    company = strip_markup(cells[0])
    if not company:
        return None
    valuation = parse_valuation(strip_markup(cells[1]))
    val_date = strip_markup(cells[2]) or None
    exit_date = strip_markup(cells[3]) or None
    exit_reason = strip_markup(cells[4]) or None
    exit_val = parse_valuation(strip_markup(cells[5]))
    country = strip_markup(cells[6]) or None
    founders_text = strip_markup(cells[7]) if len(cells) > 7 else ""
    founders = split_founders(founders_text)
    return UnicornEntry(
        company=company,
        valuation_usd_billions=valuation,
        valuation_date=val_date,
        industry=None,
        country=country,
        founders=founders,
        table="exited",
        exit_date=exit_date,
        exit_reason=exit_reason,
        exit_valuation_usd_billions=exit_val,
        raw_cells=[strip_markup(c) for c in cells],
    )


def parse_table(table_text: str, kind: str) -> list[UnicornEntry]:
    """Split table on `|-` row delimiters and parse each."""
    rows = table_text.split("\n|-")
    entries: list[UnicornEntry] = []
    # First row is the header; skip it.
    for raw_row in rows[1:]:
        cells = parse_row_cells(raw_row)
        if kind == "active":
            entry = parse_active_row(cells)
        else:
            entry = parse_exited_row(cells)
        if entry:
            entries.append(entry)
    return entries


def load_unicorns(session: requests.Session | None = None) -> list[UnicornEntry]:
    """Top-level entry: fetch, parse, return list of UnicornEntry."""
    sess = session or _make_session()
    wt = fetch_wikitext(sess)
    tables = extract_tables(wt)
    active = parse_table(tables["active"], "active")
    exited = parse_table(tables["exited"], "exited")
    return active + exited


def _make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    return s


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    out_path = OUTPUT_PATH
    if argv:
        out_path = Path(argv[0])

    print(f"[wikipedia_loader] Fetching wikitext for '{PAGE_TITLE}' ...", flush=True)
    t0 = time.time()
    entries = load_unicorns()
    elapsed = time.time() - t0
    print(
        f"[wikipedia_loader] Parsed {len(entries)} unicorn rows "
        f"({sum(1 for e in entries if e.table == 'active')} active + "
        f"{sum(1 for e in entries if e.table == 'exited')} exited) in {elapsed:.1f}s",
        flush=True,
    )

    payload: dict[str, Any] = {
        "source_url": "https://en.wikipedia.org/wiki/" + PAGE_TITLE.replace(" ", "_"),
        "license": "CC BY-SA 4.0",
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "row_count": len(entries),
        "active_count": sum(1 for e in entries if e.table == "active"),
        "exited_count": sum(1 for e in entries if e.table == "exited"),
        "entries": [asdict(e) for e in entries],
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"[wikipedia_loader] Wrote {out_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
