"""TIER 2 bridge: resolve unbridged Form D pooled-vehicle filings to an adviser
CRD by scraping SEC IAPD (adviserinfo.sec.gov) for the candidate firm name.

Pipeline:
  1. Pull `intel_formd_pooled_vehicle_offering` rows for a company whose
     accession has no matching `intel_adviser_resolution` row.
  2. Derive a 'candidate adviser name' from the filer entityname (strip series
     suffix, strip ' - ANTHROPIC X' tail, etc.). Generate up to 3 candidates per
     filing (full, first-3-tokens, first-token).
  3. For each UNIQUE candidate (across the cohort) call iapd_scraper.js once.
     Cache results to `intelligence/out/iapd_cache.json`.
  4. When a candidate returns count==1 AND that CRD exists in
     `advisers_enriched`, write an `intel_adviser_resolution` row with
     method='iapd_scrape_match'.

CLI:
   python3 intelligence/iapd_bridge.py --company anthropic            # dry run
   python3 intelligence/iapd_bridge.py --company anthropic --execute  # writes
   python3 intelligence/iapd_bridge.py --names "AUGUREY,Manhattan West"
                                                                    # ad-hoc

This script never writes the live `intel_*` tables unless `--execute` is
passed AND the user has explicitly confirmed.  Default is dry-run.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PFR_ROOT = Path("/Users/Miles/projects/PrivateFundsRadar")
SCRAPER_JS = Path(__file__).resolve().parent / "iapd_scraper.js"
CACHE_PATH = Path(__file__).resolve().parent / "out" / "iapd_cache.json"


# ----------------------------------------------------------------------------
# Env / clients (mirrors materialize_holders.py exactly so it Just Works.)
# ----------------------------------------------------------------------------

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


def create_adv_client():
    url = os.environ.get("SUPABASE_URL_ADV") or "https://ezuqwwffjgfzymqxsctq.supabase.co"
    key = (
        os.environ.get("SUPABASE_ANON_KEY_ADV")
        or os.environ.get("ADV_SUPABASE_ANON_KEY")
        or os.environ.get("SUPABASE_SERVICE_KEY_ADV")
    )
    if not key:
        raise RuntimeError("SUPABASE_ANON_KEY_ADV required (add to .env.nport)")
    from supabase import create_client  # type: ignore
    return create_client(url, key)


# ----------------------------------------------------------------------------
# Candidate-name extraction from filer entityname
# ----------------------------------------------------------------------------

ENTITY_SUFFIX_RE = re.compile(
    r",?\s+(?:LLC|L\.L\.C\.|LP|L\.P\.|INC|INC\.|LTD|CORP|LIMITED|FUND(?:\s+[IVX]+)?)\s*$",
    re.IGNORECASE,
)
# Strip trailing " - ANTHROPIC", " - ANTHROPIC A", etc.
COMPANY_TAIL_RE = re.compile(r"\s+-\s+[A-Z][A-Za-z0-9\s]+$")
# Strip leading "Anthropic " from filer name (the tracked-company token is noise
# for adviser lookup).
COMPANY_PREFIX_RE = re.compile(r"^[A-Z][A-Za-z0-9]+\s+", re.IGNORECASE)
SERIES_OF_RE = re.compile(r"\b(?:a\s+)?Series\s+of\s+(.+?)\s*$", re.IGNORECASE)
ROMAN_OR_NUM_RE = re.compile(r"\s+(?:[IVX]+|\d+|FUND|FUND\s+[IVX]+|MASTER)\s*$", re.IGNORECASE)


def candidate_names_for_filer(entityname: str, *, company_token: Optional[str] = None) -> list[str]:
    """Generate progressively-broader candidate adviser firm names.

    Order matters: most specific first, so the first hit (count==1) wins.
    """
    if not entityname:
        return []

    name = entityname.strip().strip('"').strip()
    candidates: list[str] = []

    def _push(s: str) -> None:
        s = s.strip().strip(",").strip()
        # Reject obviously-broken candidates: leading punctuation, all-digits,
        # too short to disambiguate, or contains the " - " tail we forgot to
        # strip.
        if not s or len(s) < 3:
            return
        if s[0] in "-,.&'\"":
            return
        if s.endswith("-") or s.startswith("- ") or " - " in s:
            return
        if s.isdigit():
            return
        # Candidates containing the series boilerplate are noise — the master
        # gets emitted by the SERIES_OF_RE branch separately.
        if re.search(r"\b(?:a\s+)?series\s+of\b", s, re.IGNORECASE):
            return
        if s.lower() in {"anthropic", "fund", "fund i", "capital", "ventures"}:
            return
        if s not in candidates:
            candidates.append(s)

    # 1. "X a Series of Y" -> Y is the master manager.
    m = SERIES_OF_RE.search(name)
    series_master: Optional[str] = None
    if m:
        series_master = m.group(1).strip()
        _push(series_master)

    # 2. Strip " - ANTHROPIC ..." tail.
    base = COMPANY_TAIL_RE.sub("", name).strip()
    if base != name:
        _push(base)

    # 3. Strip entity suffix.
    no_suffix = ENTITY_SUFFIX_RE.sub("", base or name).strip()
    if no_suffix:
        _push(no_suffix)

    # 4. Strip trailing roman numeral / fund number / 'MASTER' marker.
    trimmed = ROMAN_OR_NUM_RE.sub("", no_suffix).strip()
    if trimmed and trimmed != no_suffix:
        _push(trimmed)

    # 5. Drop the tracked-company token if it's the first word (e.g.
    #    "Anthropic Foo Capital" -> "Foo Capital").
    if company_token:
        ct = company_token.lower()
        for c in list(candidates):
            tokens = c.split()
            if tokens and tokens[0].lower() == ct:
                _push(" ".join(tokens[1:]))

    # 6. First two tokens of the most-trimmed candidate ("Foo Capital").
    if trimmed:
        toks = trimmed.split()
        if len(toks) >= 2:
            _push(" ".join(toks[:2]))
        if toks:
            _push(toks[0])

    return candidates


# ----------------------------------------------------------------------------
# Cache
# ----------------------------------------------------------------------------

def load_cache() -> dict[str, Any]:
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def save_cache(cache: dict[str, Any]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True))


# ----------------------------------------------------------------------------
# Scraper invocation
# ----------------------------------------------------------------------------

def call_iapd_scraper(names: list[str], *, delay_ms: int = 2500) -> dict[str, dict[str, Any]]:
    """Returns {query_name: {count, firms:[{name,crd}], error}}."""
    if not names:
        return {}
    payload = json.dumps({"names": names})
    proc = subprocess.run(
        ["node", str(SCRAPER_JS), "--stdin", "--delay-ms", str(delay_ms)],
        input=payload,
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT),
        timeout=60 * max(2, len(names)),
    )
    if proc.returncode != 0:
        sys.stderr.write(f"[iapd_bridge] scraper stderr:\n{proc.stderr}\n")
        raise RuntimeError(f"iapd_scraper.js exited {proc.returncode}")
    parsed = json.loads(proc.stdout)
    out: dict[str, dict[str, Any]] = {}
    for r in parsed.get("results", []):
        out[r["query"]] = {
            "count": r.get("count", 0),
            "firms": r.get("firms", []),
            "error": r.get("error"),
        }
    return out


# ----------------------------------------------------------------------------
# DB reads
# ----------------------------------------------------------------------------

def fetch_unbridged_pooled(nport, company_slug: str) -> list[dict[str, Any]]:
    """Pooled-vehicle offerings for the company that have NO row in
    intel_adviser_resolution."""
    offerings: list[dict[str, Any]] = []
    last_id = 0
    while True:
        resp = (
            nport.table("intel_formd_pooled_vehicle_offering")
            .select("offering_id,company_slug,accession_number,filer_entityname,series_master_llc,match_method")
            .eq("company_slug", company_slug)
            .gt("offering_id", last_id)
            .order("offering_id")
            .limit(1000)
            .execute()
        )
        batch = resp.data or []
        if not batch:
            break
        offerings.extend(batch)
        last_id = int(batch[-1]["offering_id"])
        if len(batch) < 1000:
            break

    if not offerings:
        return []

    # Pull existing resolutions for these offering_ids in one shot.
    resolved_ids: set[int] = set()
    ids = [int(o["offering_id"]) for o in offerings]
    for chunk_start in range(0, len(ids), 200):
        chunk = ids[chunk_start : chunk_start + 200]
        resp = (
            nport.table("intel_adviser_resolution")
            .select("source_id")
            .eq("source_table", "intel_formd_pooled_vehicle_offering")
            .in_("source_id", chunk)
            .execute()
        )
        for row in resp.data or []:
            resolved_ids.add(int(row["source_id"]))

    return [o for o in offerings if int(o["offering_id"]) not in resolved_ids]


def fetch_valid_adv_crds(adv) -> set[str]:
    crds: set[str] = set()
    last_crd = 0
    while True:
        resp = (
            adv.table("advisers_enriched")
            .select("crd")
            .gt("crd", last_crd)
            .order("crd")
            .limit(1000)
            .execute()
        )
        batch = resp.data or []
        if not batch:
            break
        for row in batch:
            crds.add(str(row["crd"]))
        last_crd = int(batch[-1]["crd"])
        if len(batch) < 1000:
            break
    return crds


# ----------------------------------------------------------------------------
# Main flow
# ----------------------------------------------------------------------------

def bridge_company(
    nport,
    adv_crds: set[str],
    company_slug: str,
    *,
    execute: bool,
    delay_ms: int,
    max_candidates_per_run: Optional[int] = None,
) -> dict[str, Any]:
    print(f"\n=== TIER 2 IAPD bridge for {company_slug} ===")
    unbridged = fetch_unbridged_pooled(nport, company_slug)
    print(f"  unbridged Form D pooled offerings: {len(unbridged)}")
    if not unbridged:
        return {"unbridged": 0, "scraped": 0, "matched": 0, "written": 0}

    # Build candidate set with provenance.
    company_token = company_slug.split("-")[0]
    per_filing: list[dict[str, Any]] = []
    all_candidates: set[str] = set()
    for o in unbridged:
        cands = candidate_names_for_filer(
            o["filer_entityname"], company_token=company_token
        )
        # Also consider the (already-parsed) series_master_llc if present.
        if o.get("series_master_llc"):
            sm = o["series_master_llc"].strip()
            if sm and sm not in cands:
                cands.insert(0, sm)
        per_filing.append({"offering": o, "candidates": cands})
        for c in cands:
            all_candidates.add(c)

    # Load cache, queue the unseen names.
    cache = load_cache()
    queue = [c for c in sorted(all_candidates) if c not in cache]
    if max_candidates_per_run is not None:
        queue = queue[:max_candidates_per_run]
    print(f"  unique candidate names: {len(all_candidates)} (cached {len(all_candidates) - len(queue)}, to scrape {len(queue)})")

    if queue:
        new = call_iapd_scraper(queue, delay_ms=delay_ms)
        cache.update(new)
        save_cache(cache)
        print(f"  scraped {len(new)} new (cache size now {len(cache)})")

    # Match.
    matched_rows: list[dict[str, Any]] = []
    candidates_by_filing: list[dict[str, Any]] = []
    for entry in per_filing:
        offering = entry["offering"]
        chosen_crd: Optional[str] = None
        chosen_candidate: Optional[str] = None
        chosen_firm_name: Optional[str] = None
        for c in entry["candidates"]:
            r = cache.get(c)
            if not r or r.get("error"):
                continue
            if r.get("count") == 1 and r.get("firms"):
                crd = str(r["firms"][0].get("crd") or "")
                if crd and crd in adv_crds:
                    chosen_crd = crd
                    chosen_candidate = c
                    chosen_firm_name = r["firms"][0].get("name")
                    break
        candidates_by_filing.append({
            "offering_id": offering["offering_id"],
            "filer_entityname": offering["filer_entityname"],
            "candidates": entry["candidates"],
            "chosen_candidate": chosen_candidate,
            "chosen_crd": chosen_crd,
            "chosen_firm_name": chosen_firm_name,
        })
        if chosen_crd:
            matched_rows.append({
                "source_table": "intel_formd_pooled_vehicle_offering",
                "source_id": int(offering["offering_id"]),
                "crd": chosen_crd,
                "method": "iapd_scrape_match",
            })

    print(f"  filings resolvable via IAPD: {len(matched_rows)} / {len(per_filing)}")

    # Persist a per-run report so the user can audit.
    report_path = CACHE_PATH.parent / f"iapd_bridge_report_{company_slug}.json"
    report_path.write_text(json.dumps({
        "company_slug": company_slug,
        "unbridged_count": len(unbridged),
        "candidate_count": len(all_candidates),
        "matched_count": len(matched_rows),
        "filings": candidates_by_filing,
    }, indent=2, default=str))
    print(f"  audit report: {report_path}")

    if not execute:
        print("\n  DRY RUN — no writes. Re-run with --execute to insert into intel_adviser_resolution.")
        return {"unbridged": len(unbridged), "scraped": len(queue), "matched": len(matched_rows), "written": 0}

    # WRITE intel_adviser_resolution rows.
    written = 0
    for i in range(0, len(matched_rows), 500):
        batch = matched_rows[i : i + 500]
        resp = nport.table("intel_adviser_resolution").upsert(
            batch, on_conflict="source_table,source_id,crd,method"
        ).execute()
        written += len(resp.data or batch)
    print(f"  wrote {written} intel_adviser_resolution rows (method='iapd_scrape_match')")
    return {"unbridged": len(unbridged), "scraped": len(queue), "matched": len(matched_rows), "written": written}


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="IAPD-based unbridged Form D adviser resolution (TIER 2).")
    p.add_argument("--company", help="Company slug (e.g., anthropic). Required unless --names supplied.")
    p.add_argument("--names", help="Comma-separated firm names to scrape ad hoc (no DB writes).")
    p.add_argument("--execute", action="store_true", help="Apply intel_adviser_resolution writes.")
    p.add_argument("--delay-ms", type=int, default=2500, help="Delay between scraper queries.")
    p.add_argument("--max-candidates", type=int, default=None, help="Cap scraper calls per run (testing).")
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    load_credentials()

    # Ad-hoc mode: just probe IAPD without touching the DB.
    if args.names:
        names = [n.strip() for n in args.names.split(",") if n.strip()]
        result = call_iapd_scraper(names, delay_ms=args.delay_ms)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if not args.company:
        print("ERROR: provide --company SLUG or --names 'A,B,C'", file=sys.stderr)
        return 2

    nport = create_nport_client()
    adv = create_adv_client()
    print("Loading ADV CRD set...")
    adv_crds = fetch_valid_adv_crds(adv)
    print(f"  {len(adv_crds)} CRDs")

    summary = bridge_company(
        nport, adv_crds, args.company,
        execute=args.execute, delay_ms=args.delay_ms,
        max_candidates_per_run=args.max_candidates,
    )
    print("\nSummary:", json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
