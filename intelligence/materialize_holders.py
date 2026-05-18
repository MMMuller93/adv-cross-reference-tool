"""Materialize fund-holder evidence into the intel_* tables.

For a given tracked company (by slug, e.g., 'anthropic'), this script reads
the raw source tables — N-PORT holdings, Form D filings, the cross-reference
bridge, and the curated alias list — and writes the typed evidence rows to:

  intel_nport_position                    -> registered-fund holdings
  intel_formd_pooled_vehicle_offering     -> pooled-vehicle Form Ds (holders)
  intel_formd_direct_issuer_offering      -> the company's own Form Ds (NOT
                                             holders; stored for audit)
  intel_adviser_resolution                -> which adviser firm runs each
                                             holder-evidence row

Idempotent: re-runs upsert by stable unique keys, so re-running for a company
is safe. Use --execute to apply writes; default is dry-run.

Design notes (locked 2026-05-17, post-Codex):
  - Adviser resolution writes ONLY when a CRD exists in advisers_enriched.
    Unresolved evidence has no row in intel_adviser_resolution (the absence
    is the signal). No confidence scores. No manual-review buckets.
  - N-PORT adviser resolution prefers series-level (fund_ncen_adviser_links)
    over registrant-level (nport_registrants.adv_crd). Series-level is more
    precise: it answers "which firm runs THIS specific fund," whereas the
    registrant cache is a coarse summary.
  - Form D pooled-vehicle resolution uses two paths:
      1. cross_reference_matches: adviser_entity_crd from the existing bridge
      2. (V1.1) entityname-alias match: no resolution yet; evidence is
         surfaced without an adviser link.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PFR_ROOT = Path("/Users/Miles/projects/PrivateFundsRadar")


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


def create_formd_client():
    url = os.environ.get("SUPABASE_URL_FORMD") or "https://ltdalxkhbbhmkimmogyq.supabase.co"
    key = os.environ.get("SUPABASE_ANON_KEY_FORMD") or os.environ.get("FORMD_SUPABASE_ANON_KEY")
    if not key:
        raise RuntimeError("SUPABASE_ANON_KEY_FORMD required (add to .env.nport)")
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
# Read paths: pull raw evidence from each source
# ----------------------------------------------------------------------------

def fetch_nport_positions(nport, company_slug: str) -> list[dict[str, Any]]:
    """N-PORT holdings of the tracked company, keyset-paginated."""
    rows: list[dict[str, Any]] = []
    last_id = 0
    while True:
        query = (
            nport.table("nport_company_positions_mv")
            .select(
                "holding_id_internal,registrant_cik,series_id,raw_issuer_title,"
                "raw_issuer_name,currency_value_usd,pct_of_nav,"
                "report_period_date,report_period_end,accession_number"
            )
            .eq("company_slug", company_slug)
            .gt("holding_id_internal", last_id)
            .order("holding_id_internal")
            .limit(1000)
        )
        response = query.execute()
        batch = response.data or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        last_id = int(batch[-1]["holding_id_internal"])
    return rows


def fetch_company_aliases(nport, company_id: str) -> list[dict[str, Any]]:
    """Curated alias list for a company (used for Form D entityname matching).

    The schema stores patterns under company_id (UUID), with `pattern` and
    `pattern_type` columns. We use only the patterns suitable for Form D
    entityname substring matching — vendor_code patterns are for N-PORT
    issuer matching (not Form D filer names) so we exclude them.
    """
    response = (
        nport.table("private_company_aliases")
        .select("pattern,pattern_type,exposure_type")
        .eq("company_id", company_id)
        .in_("pattern_type", ["exact_normalized", "prefix", "regex"])
        .execute()
    )
    return response.data or []


# Negative-exclusion patterns from POC2 (curated). When Form D entityname
# matches one of these substrings (case-insensitive), exclude the row even
# if a positive alias matched. Hardcoded in V1; future versions can move this
# into a private_company_alias_exclusions table.
NEGATIVE_PATTERNS_BY_COMPANY: dict[str, list[str]] = {
    "anthropic": [
        "anthropic capital fund",   # CIK 1931731 — different entity, finance not AI
        "antrum",                   # biotech
        "claude preval",            # personal name
        "carbon revolution",        # Australian auto parts
        "recursion pharmaceuticals",
        "community philanthropic",  # false match
    ],
    "stripe": [
        "stripes vi rainier",       # Stripes PE fund (with 's')
        "pinstripes",
    ],
    "openai": [
        "anyscale",                 # different AI company
    ],
}


def fetch_formd_via_cross_reference(formd, aliases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Form D filings hit via aliases (entityname ILIKE) + optionally linked
    to an adviser CRD via cross_reference_matches.

    Returns filings annotated with `_resolved_crd` and `_resolution_method`.
    Rows without a cross_reference_matches link still get returned (with
    `_resolved_crd=None`); they're V1 holder evidence without adviser
    attribution.
    """
    # Use positive patterns suitable for entityname substring matching.
    candidates = [a["pattern"] for a in aliases if a.get("pattern")]
    if not candidates:
        return []

    # 1. Find form_d_filings rows whose entityname matches any alias (ILIKE)
    matched: list[dict[str, Any]] = []
    seen_accessions: set[str] = set()
    for alias in candidates:
        # Use ILIKE pattern with % wildcards for substring match
        like_pattern = f"%{alias}%"
        last_id = 0
        while True:
            query = (
                formd.table("form_d_filings")
                .select(
                    "id,accessionnumber,entityname,cik,series_master_llc,"
                    "filing_date,totalofferingamount"
                )
                .ilike("entityname", like_pattern)
                .gt("id", last_id)
                .order("id")
                .limit(1000)
            )
            response = query.execute()
            batch = response.data or []
            for row in batch:
                acc = row["accessionnumber"]
                if acc and acc not in seen_accessions:
                    seen_accessions.add(acc)
                    matched.append(row)
            if len(batch) < 1000:
                break
            last_id = int(batch[-1]["id"])

    # 2. Cross-reference: which of these are bridged to a CRD?
    if not matched:
        return []
    accession_set = list(seen_accessions)
    xref_map: dict[str, str] = {}  # accession -> adviser_entity_crd
    # Chunk to stay under PostgREST URL limits
    for chunk_start in range(0, len(accession_set), 100):
        chunk = accession_set[chunk_start : chunk_start + 100]
        response = (
            formd.table("cross_reference_matches")
            .select("formd_accession,adviser_entity_crd")
            .in_("formd_accession", chunk)
            .not_.is_("adviser_entity_crd", "null")
            .execute()
        )
        for row in response.data or []:
            xref_map[row["formd_accession"]] = str(row["adviser_entity_crd"])

    # 3. Annotate matched filings with the xref CRD (if any)
    for filing in matched:
        filing["_resolved_crd"] = xref_map.get(filing["accessionnumber"])
        filing["_resolution_method"] = (
            "cross_reference_match" if filing["_resolved_crd"] else "entityname_alias"
        )
    return matched


def fetch_direct_issuer_formd(formd, company_ciks: list[str]) -> list[dict[str, Any]]:
    """Form D filings where the FILER's CIK matches the tracked company's
    own CIK (e.g., Anthropic PBC = CIK 1839804). These are NOT holder evidence.

    Returns empty list for companies whose Form D direct-filings don't appear
    in the DB (POC2 confirmed Anthropic has 0 such rows in our Form D DB).
    """
    if not company_ciks:
        return []
    response = (
        formd.table("form_d_filings")
        .select("id,accessionnumber,entityname,cik,filing_date,totalofferingamount")
        .in_("cik", company_ciks)
        .execute()
    )
    return response.data or []


# ----------------------------------------------------------------------------
# Adviser resolution from existing N-PORT bridge
# ----------------------------------------------------------------------------

def fetch_nport_adviser_resolutions(
    nport, registrant_ciks: list[str], series_ids: list[str]
) -> dict[tuple[str, Optional[str]], dict[str, str]]:
    """Build a (cik, series_id) -> {crd, method} map from the N-PORT bridge.

    Series-level (fund_ncen_adviser_links) is preferred over registrant-level
    (nport_registrants.adv_crd). Returns only entries with a non-NULL CRD.

    Paginates within each CIK chunk: a single chunk of 100 CIKs can produce
    thousands of series-level rows (some fund families have 20+ series each),
    so PostgREST's 1000-row default would silently truncate without keyset
    pagination here.
    """
    resolutions: dict[tuple[str, Optional[str]], dict[str, str]] = {}
    if not registrant_ciks:
        return resolutions

    cik_set = set(registrant_ciks)

    # Series-level: full-table scan with keyset pagination, filtered in memory.
    # fund_ncen_adviser_links is ~15k rows total, cheap to walk.
    page_size = 1000
    last_link_key = ""
    while True:
        query = (
            nport.table("fund_ncen_adviser_links")
            .select("link_key,registrant_cik,series_id,adviser_role,adviser_crd_normalized")
            .eq("adviser_role", "investment_adviser")
            .gt("link_key", last_link_key)
            .order("link_key")
            .limit(page_size)
        )
        response = query.execute()
        batch = response.data or []
        if not batch:
            break
        for row in batch:
            cik = str(row["registrant_cik"])
            if cik not in cik_set:
                continue
            series_id = row.get("series_id")
            crd = row.get("adviser_crd_normalized")
            if crd:
                key = (cik, series_id)
                if key not in resolutions:
                    resolutions[key] = {"crd": str(crd), "method": "ncen_xref"}
        last_link_key = batch[-1]["link_key"]
        if len(batch) < page_size:
            break

    # Registrant-level fallback: paginate within each chunk too.
    for chunk_start in range(0, len(registrant_ciks), 100):
        chunk = registrant_ciks[chunk_start : chunk_start + 100]
        # Only 100 CIKs and each has at most one nport_registrants row, so
        # this stays under the 1000-row cap. No internal pagination needed.
        response = (
            nport.table("nport_registrants")
            .select("cik,adv_crd,adv_crd_match_method")
            .in_("cik", chunk)
            .not_.is_("adv_crd", "null")
            .execute()
        )
        for row in response.data or []:
            cik = str(row["cik"])
            crd = row.get("adv_crd")
            method = row.get("adv_crd_match_method") or "ncen_xref"
            if crd:
                key = (cik, None)
                if key not in resolutions:
                    resolutions[key] = {"crd": str(crd), "method": method}
    return resolutions


def fetch_valid_adv_crds(adv) -> set[str]:
    """All CRDs currently in advisers_enriched."""
    crds: set[str] = set()
    last_crd: Optional[str] = None
    while True:
        query = adv.table("advisers_enriched").select("crd").order("crd").limit(1000)
        if last_crd is not None:
            query = query.gt("crd", last_crd)
        response = query.execute()
        batch = response.data or []
        if not batch:
            break
        for row in batch:
            crd = row.get("crd")
            if crd:
                crds.add(str(crd).strip())
                last_crd = str(crd)
        if len(batch) < 1000:
            break
    return crds


# ----------------------------------------------------------------------------
# Write paths: upsert into intel_* tables
# ----------------------------------------------------------------------------

def upsert_nport_positions(nport, positions: list[dict[str, Any]], company_slug: str) -> int:
    if not positions:
        return 0
    rows = [
        {
            "company_slug": company_slug,
            "holding_id_internal": p["holding_id_internal"],
            "registrant_cik": p["registrant_cik"],
            "series_id": p.get("series_id"),
            # Prefer raw_issuer_title; fall back to raw_issuer_name. These
            # describe the SAME holding from different XML fields.
            "issuer_title": p.get("raw_issuer_title") or p.get("raw_issuer_name"),
            "value_usd": p.get("currency_value_usd"),
            "pct_net_assets": p.get("pct_of_nav"),
            # Holding as-of date is report_period_date (the actual snapshot
            # date the fund reports), NOT report_period_end (fiscal period
            # end, which can be in the future for funds with Nov/Dec FYE).
            "as_of_date": p.get("report_period_date") or p.get("report_period_end"),
            "accession_number": p.get("accession_number"),
        }
        for p in positions
    ]
    total = 0
    for i in range(0, len(rows), 500):
        batch = rows[i : i + 500]
        response = nport.table("intel_nport_position").upsert(
            batch, on_conflict="company_slug,holding_id_internal"
        ).execute()
        total += len(response.data or batch)
    return total


def _numeric_or_none(value: Any) -> Optional[float]:
    """Form D's totalofferingamount can be 'Indefinite' (no cap) — return None
    in that case so the NUMERIC column accepts the row."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def upsert_pooled_vehicle_offerings(
    nport, filings: list[dict[str, Any]], company_slug: str
) -> dict[str, Any]:
    """Returns {'rows': N, 'offering_id_by_accession': {acc: id}} so we can
    write the adviser resolutions next."""
    if not filings:
        return {"rows": 0, "offering_id_by_accession": {}}
    rows = [
        {
            "company_slug": company_slug,
            "accession_number": f["accessionnumber"],
            "filer_entityname": f["entityname"],
            "filer_cik": str(f.get("cik")) if f.get("cik") else None,
            "series_master_llc": f.get("series_master_llc"),
            "filing_date": f.get("filing_date"),
            "total_offering_amount": _numeric_or_none(f.get("totalofferingamount")),
            "match_method": f.get("_resolution_method") or "entityname_alias",
        }
        for f in filings
    ]
    total = 0
    for i in range(0, len(rows), 500):
        batch = rows[i : i + 500]
        response = nport.table("intel_formd_pooled_vehicle_offering").upsert(
            batch, on_conflict="company_slug,accession_number"
        ).execute()
        total += len(response.data or batch)
    # Read back to get the offering_ids
    response = (
        nport.table("intel_formd_pooled_vehicle_offering")
        .select("offering_id,accession_number")
        .eq("company_slug", company_slug)
        .execute()
    )
    id_by_accession = {row["accession_number"]: row["offering_id"] for row in (response.data or [])}
    return {"rows": total, "offering_id_by_accession": id_by_accession}


def upsert_direct_issuer_offerings(
    nport, filings: list[dict[str, Any]], company_slug: str
) -> int:
    if not filings:
        return 0
    rows = [
        {
            "company_slug": company_slug,
            "accession_number": f["accessionnumber"],
            "filer_entityname": f["entityname"],
            "filer_cik": str(f.get("cik")) if f.get("cik") else None,
            "filing_date": f.get("filing_date"),
            "total_offering_amount": _numeric_or_none(f.get("totalofferingamount")),
        }
        for f in filings
    ]
    total = 0
    for i in range(0, len(rows), 500):
        batch = rows[i : i + 500]
        response = nport.table("intel_formd_direct_issuer_offering").upsert(
            batch, on_conflict="company_slug,accession_number"
        ).execute()
        total += len(response.data or batch)
    return total


def upsert_adviser_resolutions(
    nport, resolutions: list[dict[str, Any]]
) -> int:
    """resolutions is a list of {source_table, source_id, crd, method} dicts.
    Caller is responsible for filtering to only CRDs that exist in
    advisers_enriched (no validation here)."""
    if not resolutions:
        return 0
    total = 0
    for i in range(0, len(resolutions), 500):
        batch = resolutions[i : i + 500]
        response = nport.table("intel_adviser_resolution").upsert(
            batch, on_conflict="source_table,source_id,crd,method"
        ).execute()
        total += len(response.data or batch)
    return total


# ----------------------------------------------------------------------------
# Materialization orchestration
# ----------------------------------------------------------------------------

def get_company_metadata(nport, slug: str) -> Optional[dict[str, Any]]:
    response = (
        nport.table("private_companies")
        .select("id,slug,display_name,legal_entities,primary_domain")
        .eq("slug", slug)
        .single()
        .execute()
    )
    return response.data


def materialize_company(
    nport, formd, adv_crds: set[str], company_slug: str, *, execute: bool
) -> dict[str, Any]:
    """Materialize all evidence for a single company. Returns a summary dict."""
    print(f"\n=== Materializing {company_slug} ===")

    company_meta = get_company_metadata(nport, company_slug)
    if not company_meta:
        return {"error": f"company_slug {company_slug!r} not found in private_companies"}
    print(f"  company: {company_meta.get('display_name')}")

    # 1. N-PORT positions
    print("  fetching N-PORT positions...")
    positions = fetch_nport_positions(nport, company_slug)
    print(f"    {len(positions)} positions found")

    # 2. Form D pooled-vehicle offerings (via aliases + xref)
    company_id = company_meta["id"]
    print("  fetching company aliases...")
    aliases = fetch_company_aliases(nport, company_id)
    print(f"    {len(aliases)} positive alias patterns")
    print("  fetching Form D pooled-vehicle filings...")
    pooled_filings = fetch_formd_via_cross_reference(formd, aliases)
    print(f"    {len(pooled_filings)} pooled-vehicle filings (pre-exclusion)")
    # Apply hardcoded negative-exclusion patterns from POC2 curation
    negatives = NEGATIVE_PATTERNS_BY_COMPANY.get(company_slug, [])
    if negatives:
        filtered = [
            f for f in pooled_filings
            if not any(neg in (f.get("entityname") or "").lower() for neg in negatives)
        ]
        excluded = len(pooled_filings) - len(filtered)
        if excluded:
            print(f"    excluded {excluded} via negative patterns: {negatives}")
        pooled_filings = filtered

    # 3. Form D direct-issuer (kept for audit, never surfaced as holder)
    # V1: skipped. POC2 verified there are zero direct-issuer Form D rows for
    # the gold-set companies (e.g., Anthropic PBC CIK 1839804 returns 0 rows
    # in our Form D DB). The intel_formd_direct_issuer_offering table exists
    # as future-proofing but is not populated by V1.
    direct_filings: list[dict[str, Any]] = []
    print("  direct-issuer step: skipped for V1 (no rows expected per POC2)")

    # 4. N-PORT adviser resolution map
    print("  building N-PORT adviser resolution map...")
    cik_set = list({str(p["registrant_cik"]) for p in positions})
    series_set = list({p.get("series_id") for p in positions if p.get("series_id")})
    resolutions_map = fetch_nport_adviser_resolutions(nport, cik_set, series_set)
    print(f"    {len(resolutions_map)} resolution entries")

    if not execute:
        print("\n  DRY RUN — no writes. Re-run with --execute to materialize.")
        return {
            "positions_pending": len(positions),
            "pooled_pending": len(pooled_filings),
            "direct_pending": len(direct_filings),
            "resolutions_pending_total": len(resolutions_map),
        }

    # WRITES
    print("\n  Writing intel_* tables...")
    nport_written = upsert_nport_positions(nport, positions, company_slug)
    print(f"    intel_nport_position: {nport_written}")
    pooled_result = upsert_pooled_vehicle_offerings(nport, pooled_filings, company_slug)
    print(f"    intel_formd_pooled_vehicle_offering: {pooled_result['rows']}")
    direct_written = upsert_direct_issuer_offerings(nport, direct_filings, company_slug)
    print(f"    intel_formd_direct_issuer_offering: {direct_written}")

    # Build adviser-resolution links
    # For N-PORT positions, look up by (registrant_cik, series_id) then fallback (cik, None).
    # A single fund (series) can hold the tracked company in multiple share classes,
    # producing multiple positions with the same (cik, series_id). All of those
    # positions get the same adviser resolution — we don't collapse them.
    response = (
        nport.table("intel_nport_position")
        .select("position_id,registrant_cik,series_id")
        .eq("company_slug", company_slug)
        .execute()
    )
    nport_ids_by_key: dict[tuple[str, Optional[str]], list[int]] = defaultdict(list)
    for row in (response.data or []):
        key = (str(row["registrant_cik"]), row.get("series_id"))
        nport_ids_by_key[key].append(row["position_id"])

    resolution_rows: list[dict[str, Any]] = []
    for (cik, series_id), position_ids in nport_ids_by_key.items():
        # Prefer series-level match, fall back to registrant-level cache
        res = resolutions_map.get((cik, series_id)) or resolutions_map.get((cik, None))
        if res and res["crd"] in adv_crds:
            # Write a resolution for EVERY position with this (cik, series_id),
            # not just one. Same fund can hold multiple share classes of the
            # tracked company.
            for position_id in position_ids:
                resolution_rows.append({
                    "source_table": "intel_nport_position",
                    "source_id": position_id,
                    "crd": res["crd"],
                    "method": res["method"],
                })

    # For pooled-vehicle offerings, use the resolved CRD from cross_reference_matches
    for filing in pooled_filings:
        accession = filing["accessionnumber"]
        crd = filing.get("_resolved_crd")
        offering_id = pooled_result["offering_id_by_accession"].get(accession)
        if crd and offering_id and crd in adv_crds:
            resolution_rows.append({
                "source_table": "intel_formd_pooled_vehicle_offering",
                "source_id": offering_id,
                "crd": str(crd),
                "method": "cross_reference_match",
            })

    print(f"  building adviser resolutions: {len(resolution_rows)} (only CRDs in ADV)")
    resolutions_written = upsert_adviser_resolutions(nport, resolution_rows)
    print(f"    intel_adviser_resolution: {resolutions_written}")

    return {
        "positions": nport_written,
        "pooled": pooled_result["rows"],
        "direct": direct_written,
        "resolutions": resolutions_written,
    }


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Materialize fund-holder evidence into intel_* tables for a tracked company."
    )
    parser.add_argument("--company", required=True, help="Company slug (e.g., anthropic)")
    parser.add_argument("--execute", action="store_true", help="Apply writes (default is dry-run)")
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    load_credentials()

    nport = create_nport_client()
    formd = create_formd_client()
    adv = create_adv_client()

    print("Loading ADV CRD set (for adviser-resolution validation)...")
    adv_crds = fetch_valid_adv_crds(adv)
    print(f"  {len(adv_crds)} CRDs")

    result = materialize_company(nport, formd, adv_crds, args.company, execute=args.execute)
    print("\nResult:", json.dumps(result, sort_keys=True, default=str))
    return 0 if not result.get("error") else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
