"""Shared F4 filter logic for the N-PORT private-universe filter.

Per PLAN_NPORT_HOLDINGS.md §6.1:

    F4: fair_value_level = '3'
        AND asset_cat IN ('EC','EP')
        AND issuer_type = 'CORP'
        AND (cusip IS NULL OR cusip = '000000000' OR cusip = 'N/A'
             OR LENGTH(cusip) != 9)

    Plus loan-position branch:
        fair_value_level = '3' AND asset_cat = 'LON' AND is_restricted = 'Y'

    Plus alias-cache branch:
        normalized_issuer_name IN aliases_cache

Confidence tagging (also from §6.1):
    HIGH   if the row also has is_restricted = 'Y'
    MEDIUM otherwise (still captured by F4)

Used by both backfill_bulk.py (against TSV rows) and daily_scraper.py
(against XML-parsed holdings) so the two paths produce identical sets.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, Optional, Set


def _is_bad_cusip(cusip: Optional[str]) -> bool:
    """A CUSIP is "bad" (likely private security) if it's missing, the
    sentinel `000000000`, the literal `N/A`, or not 9 characters."""
    if not cusip:
        return True
    c = cusip.strip()
    if not c:
        return True
    if c == "000000000" or c.upper() == "N/A":
        return True
    return len(c) != 9


def normalize_issuer_name(name: Optional[str]) -> str:
    """Light normalization for alias-cache lookups.

    Matches the spirit of existing `normalize_name_for_match` (see CLAUDE.md):
    uppercase, strip punctuation, collapse whitespace, drop common entity
    suffixes. Returns "" for empty/None input.

    Intentionally permissive — the alias cache itself is curated and
    contains pre-normalized names, so the goal here is producing a stable
    join key, not perfect equivalence.
    """
    if not name:
        return ""
    s = name.upper()
    # Strip punctuation aggressively
    s = re.sub(r"[\.,'\"()/\\\-]+", " ", s)
    # Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()
    # Drop common entity suffixes (one pass)
    suffixes = (
        " LLC",
        " L L C",
        " LP",
        " L P",
        " LTD",
        " LIMITED",
        " INC",
        " INCORPORATED",
        " CORP",
        " CORPORATION",
        " CO",
        " COMPANY",
        " PBC",
        " PLC",
        " PTY",
        " HOLDINGS",
    )
    changed = True
    while changed:
        changed = False
        for suf in suffixes:
            if s.endswith(suf):
                s = s[: -len(suf)].rstrip()
                changed = True
    return s


def passes_f4(row: Dict[str, Any]) -> bool:
    """Return True iff the row matches the strict F4 equity branch.

    Expects row keys: fair_value_level, asset_cat, issuer_type, cusip.
    Values may be None.
    """
    fvl = row.get("fair_value_level")
    asset_cat = row.get("asset_cat")
    issuer_type = row.get("issuer_type")
    cusip = row.get("cusip")
    if str(fvl) != "3":
        return False
    if asset_cat not in ("EC", "EP"):
        return False
    if issuer_type != "CORP":
        return False
    return _is_bad_cusip(cusip)


def passes_loan_branch(row: Dict[str, Any]) -> bool:
    """Loan positions on tracked private companies (xAI, Databricks term loans).

    fair_value_level=3 AND asset_cat=LON AND is_restricted=Y
    """
    if str(row.get("fair_value_level")) != "3":
        return False
    if row.get("asset_cat") != "LON":
        return False
    return row.get("is_restricted") == "Y"


def passes_alias_branch(
    row: Dict[str, Any], aliases_cache: Optional[Set[str]]
) -> bool:
    """Captured by curated alias list regardless of other filter signals.

    Used so we don't drop legitimate Anthropic / SpaceX positions whose
    filers happen to mark them oddly.
    """
    if not aliases_cache:
        return False
    return normalize_issuer_name(row.get("issuer_name")) in aliases_cache


def confidence_tag(row: Dict[str, Any]) -> str:
    """HIGH if IS_RESTRICTED_SECURITY=Y, else MEDIUM. Per §6.1 confidence column."""
    return "HIGH" if row.get("is_restricted") == "Y" else "MEDIUM"


def filter_rows(
    rows: Iterable[Dict[str, Any]],
    aliases_cache: Optional[Set[str]] = None,
):
    """Stream-friendly filter: yield (row, confidence) for each kept row.

    Caller is responsible for batching the output for upsert.
    """
    for row in rows:
        if (
            passes_f4(row)
            or passes_loan_branch(row)
            or passes_alias_branch(row, aliases_cache)
        ):
            yield row, confidence_tag(row)
