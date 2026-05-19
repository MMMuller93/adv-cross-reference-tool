"""Lifecycle audit: cross-check seeded 'private' companies against SEC's
current public-issuer registry.

The seed in private_companies has misclassifications (Dana Inc., Squarespace
post-Permira buyback, CoreWeave post-IPO, etc.). This script doesn't try
to fix them — it produces a ranked audit CSV so we can see how many
companies are affected and which ones matter (evidence-weighted).

Codex 5.5 xhigh design (2026-05-18):
  - Don't call EDGAR full-text per company. Use SEC's bulk
    company_tickers_exchange.json (one fetch, ~50KB, fair-use).
  - Match against private_companies.display_name + legal_entities + aliases.
  - Output: slug, evidence_total, current publishable, lifecycle in seed,
    SEC ticker match (if any), classification recommendation.
  - Ranked by evidence_total so high-impact misclassifications surface first.

This is the AUDIT step. Curation (writing a company_lifecycle_events table)
happens AFTER reviewing the audit output to size the work.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Optional

import requests


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PFR_ROOT = Path("/Users/Miles/projects/PrivateFundsRadar")

# Bulk company-tickers-exchange file from SEC. Refreshed daily.
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json"
SEC_USER_AGENT = os.environ.get(
    "SEC_USER_AGENT", "PrivateFundsRadar Miles mmmuller93@gmail.com"
)


def _read_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_credentials() -> None:
    _read_env_file(PROJECT_ROOT / ".env")
    _read_env_file(PFR_ROOT / ".env.nport")


def create_nport_client():
    url = os.environ.get("SUPABASE_URL_NPORT")
    key = os.environ.get("SUPABASE_SERVICE_KEY_NPORT")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL_NPORT and SUPABASE_SERVICE_KEY_NPORT required")
    from supabase import create_client  # type: ignore
    return create_client(url, key)


# ---------------------------------------------------------------------------
# Name normalization for matching
# ---------------------------------------------------------------------------

# Legal/structural suffixes to strip before name comparison.
_SUFFIX_PATTERN = re.compile(
    r",?\s*(LLC|LP|L\.P\.?|LTD\.?|INC\.?|CORP\.?|CO\.?|PBC|"
    r"HOLDINGS|GROUP|COMPANY|INCORPORATED|CORPORATION|"
    r"PLC|S\.A\.?|GMBH|AG|NV|BV|N\.V\.?|B\.V\.?|"
    r"TRUST|FUND|PARTNERS|VENTURES)\s*$",
    re.IGNORECASE,
)


def normalize_name(value: Optional[str]) -> Optional[str]:
    """Uppercase, repeatedly strip trailing legal suffixes, collapse whitespace.

    More aggressive than the materializer's normalization because we're
    trying to match across very different data sources (SEC ticker file
    vs our private_companies seed). Suffix-stripping is run in a loop
    because companies can have stacked suffixes ('Foo Corp., Inc.').
    """
    if not value:
        return None
    text = value.upper().strip()
    text = re.sub(r"[.,]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    for _ in range(5):
        new_text = _SUFFIX_PATTERN.sub("", text).strip()
        if new_text == text:
            break
        text = new_text
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


# ---------------------------------------------------------------------------
# SEC ticker file
# ---------------------------------------------------------------------------

def fetch_sec_ticker_file(cache_path: Optional[Path] = None) -> dict[str, Any]:
    """Download SEC's company_tickers_exchange.json. Caches locally for 24h."""
    if cache_path and cache_path.exists():
        age = time.time() - cache_path.stat().st_mtime
        if age < 24 * 3600:
            return json.loads(cache_path.read_text())

    print(f"Downloading {SEC_TICKERS_URL}...")
    response = requests.get(
        SEC_TICKERS_URL,
        headers={"User-Agent": SEC_USER_AGENT},
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    if cache_path:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(data))
    return data


def build_ticker_index(sec_data: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Return a {normalized_name: [{cik, name, ticker, exchange}, ...]} index.

    Multiple SEC entries can share a normalized name (e.g., 'DANA' could
    match multiple companies); we keep all of them and surface the
    collision in the audit output.
    """
    fields = sec_data.get("fields") or []
    rows = sec_data.get("data") or []
    name_idx = fields.index("name")
    cik_idx = fields.index("cik")
    ticker_idx = fields.index("ticker") if "ticker" in fields else None
    exch_idx = fields.index("exchange") if "exchange" in fields else None

    index: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        name = row[name_idx]
        norm = normalize_name(name)
        if not norm:
            continue
        entry = {
            "cik": row[cik_idx],
            "name": name,
            "ticker": row[ticker_idx] if ticker_idx is not None else None,
            "exchange": row[exch_idx] if exch_idx is not None else None,
        }
        index.setdefault(norm, []).append(entry)
    return index


# ---------------------------------------------------------------------------
# Audit logic
# ---------------------------------------------------------------------------

def list_companies_with_metadata(nport) -> list[dict[str, Any]]:
    """Pull every row in private_companies with the fields we need for the audit."""
    rows: list[dict[str, Any]] = []
    last_slug = ""
    while True:
        query = (
            nport.table("private_companies")
            .select("slug,display_name,legal_entities,lifecycle_status,is_public,is_acquired")
            .gt("slug", last_slug)
            .order("slug")
            .limit(1000)
        )
        response = query.execute()
        batch = response.data or []
        if not batch:
            break
        rows.extend(batch)
        last_slug = batch[-1]["slug"]
        if len(batch) < 1000:
            break
    return rows


def list_company_aliases(nport) -> dict[str, list[str]]:
    """Return {company_id: [normalized_alias, ...]} for exact_normalized + prefix patterns."""
    aliases: dict[str, list[str]] = {}
    last_id = 0
    while True:
        query = (
            nport.table("private_company_aliases")
            .select("id,company_id,pattern,pattern_type")
            .in_("pattern_type", ["exact_normalized", "prefix"])
            .gt("id", last_id)
            .order("id")
            .limit(1000)
        )
        response = query.execute()
        batch = response.data or []
        if not batch:
            break
        for row in batch:
            cid = row.get("company_id")
            pat = row.get("pattern")
            if cid and pat:
                norm = normalize_name(pat)
                if norm and len(norm) >= 4:  # skip very short patterns
                    aliases.setdefault(cid, []).append(norm)
            last_id = int(row["id"])
        if len(batch) < 1000:
            break
    return aliases


def load_manifest(manifest_path: Path) -> dict[str, dict[str, Any]]:
    """Read batch_manifest.csv into {slug: row_dict}."""
    if not manifest_path.exists():
        return {}
    with manifest_path.open() as f:
        return {row["slug"]: row for row in csv.DictReader(f)}


def find_ticker_matches(
    company: dict[str, Any],
    aliases_by_company: dict[str, list[str]],
    ticker_index: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Try to find SEC ticker rows that match this company by name/aliases.

    Returns a list of match dicts (could be empty, could have multiple if
    the name collides with several public entities).
    """
    candidates: set[str] = set()

    norm = normalize_name(company.get("display_name"))
    if norm:
        candidates.add(norm)

    for entity in company.get("legal_entities") or []:
        if isinstance(entity, dict):
            name = entity.get("name")
            n = normalize_name(name)
            if n:
                candidates.add(n)

    for alias in aliases_by_company.get(company.get("id") or "", []):
        if alias:
            candidates.add(alias)

    matches: list[dict[str, Any]] = []
    seen_ciks: set[int] = set()
    for cand in candidates:
        for hit in ticker_index.get(cand, []):
            if hit["cik"] not in seen_ciks:
                seen_ciks.add(hit["cik"])
                matches.append({**hit, "matched_via": cand})
    return matches


def classify(
    company: dict[str, Any],
    manifest_row: Optional[dict[str, Any]],
    ticker_matches: list[dict[str, Any]],
) -> tuple[str, str]:
    """Return (assessment, recommendation) for this company.

    Assessments:
      seed_correct_private        seed says private, no SEC ticker match
      seed_correct_public         seed says public/acquired, SEC ticker exists
      seed_says_private_but_public seed says private, SEC ticker exists  <-- the bug
      seed_says_public_no_ticker   seed says public/acquired, no SEC ticker (delisted?)
      ambiguous_collision         multiple ticker matches — needs review
    """
    seed_status = (company.get("lifecycle_status") or "").lower()
    is_public_seed = bool(company.get("is_public")) or seed_status == "public"
    is_acquired_seed = bool(company.get("is_acquired")) or seed_status == "acquired"
    has_sec_match = bool(ticker_matches)
    n_matches = len(ticker_matches)

    if n_matches > 1:
        if not is_public_seed and not is_acquired_seed:
            return ("ambiguous_collision",
                    "needs_review_multiple_ticker_matches")
        return ("ambiguous_collision", "needs_review")

    if has_sec_match and not is_public_seed and not is_acquired_seed:
        return ("seed_says_private_but_public",
                "set_lifecycle_status_public_or_remove_from_seed")

    if not has_sec_match and (is_public_seed or is_acquired_seed):
        return ("seed_says_public_no_ticker",
                "may_be_delisted_or_acquired_correctly")

    if has_sec_match and (is_public_seed or is_acquired_seed):
        return ("seed_correct_public", "ok")

    return ("seed_correct_private", "ok")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

AUDIT_COLUMNS = [
    "slug",
    "display_name",
    "lifecycle_status",
    "is_public",
    "is_acquired",
    "evidence_total",
    "nport_positions",
    "formd_pooled",
    "publishable",
    "publish_reason",
    "assessment",
    "recommendation",
    "sec_ticker_match_count",
    "sec_ticker",
    "sec_exchange",
    "sec_name",
    "sec_matched_via",
    "all_sec_matches_json",
]


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Lifecycle audit: which seeded private companies are actually public?"
    )
    parser.add_argument(
        "--manifest",
        default=str(Path(__file__).resolve().parent / "out" / "batch_manifest.csv"),
        help="Path to the batch manifest CSV (default: out/batch_manifest.csv)",
    )
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parent / "out" / "lifecycle_audit.csv"),
        help="Path to write audit CSV",
    )
    parser.add_argument(
        "--sec-cache",
        default=str(Path(__file__).resolve().parent / "out" / "_sec_tickers.json"),
        help="Path to cache SEC ticker file (24h TTL)",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    load_credentials()

    nport = create_nport_client()
    print("Loading companies + aliases from N-PORT...")
    companies = list_companies_with_metadata(nport)
    aliases = list_company_aliases(nport)
    print(f"  {len(companies)} companies, {sum(len(v) for v in aliases.values())} alias patterns")

    print("\nLoading manifest...")
    manifest_path = Path(args.manifest)
    manifest = load_manifest(manifest_path)
    print(f"  {len(manifest)} manifest rows")

    print("\nFetching SEC company_tickers_exchange.json...")
    sec_data = fetch_sec_ticker_file(Path(args.sec_cache))
    ticker_index = build_ticker_index(sec_data)
    print(f"  {len(ticker_index)} unique normalized names in SEC ticker file")

    print("\nAuditing...")
    audit_rows: list[dict[str, Any]] = []
    for company in companies:
        slug = company["slug"]
        manifest_row = manifest.get(slug)
        ticker_matches = find_ticker_matches(company, aliases, ticker_index)
        assessment, recommendation = classify(company, manifest_row, ticker_matches)

        nport_n = int(manifest_row["nport_positions"]) if manifest_row else 0
        pooled_n = int(manifest_row["formd_pooled"]) if manifest_row else 0
        evidence_total = nport_n + pooled_n

        primary_match = ticker_matches[0] if ticker_matches else {}
        audit_rows.append({
            "slug": slug,
            "display_name": company.get("display_name"),
            "lifecycle_status": company.get("lifecycle_status"),
            "is_public": company.get("is_public"),
            "is_acquired": company.get("is_acquired"),
            "evidence_total": evidence_total,
            "nport_positions": nport_n,
            "formd_pooled": pooled_n,
            "publishable": manifest_row.get("publishable") if manifest_row else "",
            "publish_reason": manifest_row.get("publish_reason") if manifest_row else "",
            "assessment": assessment,
            "recommendation": recommendation,
            "sec_ticker_match_count": len(ticker_matches),
            "sec_ticker": primary_match.get("ticker"),
            "sec_exchange": primary_match.get("exchange"),
            "sec_name": primary_match.get("name"),
            "sec_matched_via": primary_match.get("matched_via"),
            "all_sec_matches_json": json.dumps(ticker_matches) if ticker_matches else "",
        })

    # Rank by evidence weight (high-impact misclassifications first)
    audit_rows.sort(
        key=lambda r: (
            # Sort so that high-impact problematic assessments come first
            0 if r["assessment"] == "seed_says_private_but_public" else
            1 if r["assessment"] == "ambiguous_collision" else
            2 if r["assessment"] == "seed_says_public_no_ticker" else 3,
            -r["evidence_total"],
        )
    )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=AUDIT_COLUMNS)
        writer.writeheader()
        writer.writerows(audit_rows)

    # Summary
    from collections import Counter
    assessment_counts = Counter(r["assessment"] for r in audit_rows)
    print(f"\nAudit summary:")
    for a, n in assessment_counts.most_common():
        print(f"  {n:>4d}  {a}")

    print(f"\nTop 20 'seed_says_private_but_public' by evidence weight:")
    flagged = [r for r in audit_rows if r["assessment"] == "seed_says_private_but_public"]
    flagged.sort(key=lambda r: -r["evidence_total"])
    for r in flagged[:20]:
        print(f"  {r['slug']:30s}  {r['display_name'][:25]:25s}  "
              f"evidence={r['evidence_total']:>5d}  "
              f"ticker={r['sec_ticker'] or '?':>6s}  "
              f"sec_name={(r['sec_name'] or '')[:30]}")

    print(f"\nWrote {len(audit_rows)} audit rows to {output_path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
