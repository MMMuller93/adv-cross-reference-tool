"""Reconcile N-PORT registrant-level adviser cache from N-CEN data.

This is the second half of the N-CEN bridge pipeline. Phase A
(``backfill_live.py``) scrapes SEC EDGAR and writes raw N-CEN records +
series-level adviser links. This script (Phase B) reads what's been saved,
validates against the live ADV database, and updates the registrant-level
``nport_registrants.adv_crd`` cache.

Design decisions (locked 2026-05-17 after Codex 5.5 review):
  - Treats ``nport_registrants.adv_crd`` as a derived cache, not authoritative
    truth. The authoritative source is ``fund_ncen_adviser_links``
    (series-level). Downstream queries that need fund-level adviser detail
    should join the series-level table.
  - Resolution rules (no confidence scores, no manual-review flags):
      * One unique investment-adviser CRD across all distinct series + CRD
        exists in advisers_enriched -> write that CRD, method='ncen_xref'.
      * Multiple unique CRDs across series (multi-adviser registrant) -> write
        adv_crd=NULL, method=NULL. The series-level table has the real answer.
      * Single CRD parsed but it doesn't exist in advisers_enriched (foreign,
        terminated, etc.) -> write adv_crd=NULL, method=NULL.
      * No investment-adviser link found at all -> write adv_crd=NULL.
  - Counts DISTINCT series per CIK when determining "unique CRD across series"
    (Codex bug C: raw link rows can have multiple primary-adviser entries
    per series; we deduplicate by series_id before counting).
  - Idempotent: only writes when computed state differs from current state.
    Stale values are CLEARED to NULL, not skipped.
  - Each update is verified to affect exactly one row in nport_registrants
    (Codex bug B: silent zero-row updates are flagged as anomalies).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional


PROJECT_ROOT = Path(__file__).resolve().parents[3]


# ----------------------------------------------------------------------------
# Environment + client setup
# ----------------------------------------------------------------------------

def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_credentials() -> None:
    """Load env vars from .env (project root) and .env.nport (PFR root)."""
    _load_env_file(PROJECT_ROOT / ".env")
    # PFR-level env at /Users/Miles/projects/PrivateFundsRadar/.env.nport
    pfr_root = PROJECT_ROOT
    while pfr_root.parent != pfr_root and pfr_root.name != "PrivateFundsRadar":
        pfr_root = pfr_root.parent
    _load_env_file(pfr_root / ".env.nport")


def create_nport_client():
    url = os.environ.get("SUPABASE_URL_NPORT")
    key = os.environ.get("SUPABASE_SERVICE_KEY_NPORT")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL_NPORT and SUPABASE_SERVICE_KEY_NPORT required "
            "(check /Users/Miles/projects/PrivateFundsRadar/.env.nport)"
        )
    from supabase import create_client  # type: ignore
    return create_client(url, key)


def create_adv_client():
    """Read-only client for the ADV Supabase project.

    Looks up SUPABASE_URL_ADV + SUPABASE_ANON_KEY_ADV in env.
    """
    url = os.environ.get("SUPABASE_URL_ADV") or "https://ezuqwwffjgfzymqxsctq.supabase.co"
    key = os.environ.get("SUPABASE_ANON_KEY_ADV") or os.environ.get("SUPABASE_SERVICE_KEY_ADV")
    if not key:
        raise RuntimeError(
            "SUPABASE_ANON_KEY_ADV (or SUPABASE_SERVICE_KEY_ADV) required "
            "for ADV validation step. Add to .env.nport"
        )
    from supabase import create_client  # type: ignore
    return create_client(url, key)


# ----------------------------------------------------------------------------
# Data loading
# ----------------------------------------------------------------------------

def load_adv_crd_set(adv_client) -> set[str]:
    """Load every CRD currently in advisers_enriched as a normalized string set."""
    crds: set[str] = set()
    last_crd: Optional[str] = None
    while True:
        query = (
            adv_client.table("advisers_enriched")
            .select("crd")
            .order("crd")
            .limit(1000)
        )
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


def load_adviser_links(
    nport_client, *, ciks: Optional[list[str]] = None
) -> list[dict[str, Any]]:
    """Load fund_ncen_adviser_links rows. If ciks provided, restrict to those.

    Returns rows containing at minimum: registrant_cik, series_id, adviser_role,
    adviser_crd_normalized, filing_date, accession_number.
    """
    rows: list[dict[str, Any]] = []
    select_cols = (
        "registrant_cik,series_id,adviser_role,adviser_crd_normalized,"
        "filing_date,accession_number"
    )
    last_key = None
    while True:
        query = (
            nport_client.table("fund_ncen_adviser_links")
            .select(select_cols)
            .order("registrant_cik")
            .order("series_id")
            .order("adviser_role")
            .order("adviser_crd_normalized")
            .limit(1000)
        )
        if ciks:
            query = query.in_("registrant_cik", ciks)
        if last_key:
            # Keyset paginate by registrant_cik (coarse, but adequate for our scale)
            query = query.gt("registrant_cik", last_key)
        response = query.execute()
        batch = response.data or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        last_key = batch[-1].get("registrant_cik")
    return rows


def load_current_registrant_state(
    nport_client, *, ciks: Optional[list[str]] = None
) -> dict[str, dict[str, Any]]:
    """Return {cik: {adv_crd, adv_crd_match_method}} for current state."""
    state: dict[str, dict[str, Any]] = {}
    last_cik = None
    while True:
        query = (
            nport_client.table("nport_registrants")
            .select("cik,adv_crd,adv_crd_match_method")
            .order("cik")
            .limit(1000)
        )
        if ciks:
            query = query.in_("cik", ciks)
        if last_cik:
            query = query.gt("cik", last_cik)
        response = query.execute()
        batch = response.data or []
        if not batch:
            break
        for row in batch:
            cik = row.get("cik")
            if cik:
                state[str(cik)] = {
                    "adv_crd": row.get("adv_crd"),
                    "adv_crd_match_method": row.get("adv_crd_match_method"),
                }
                last_cik = str(cik)
        if len(batch) < 1000:
            break
    return state


# ----------------------------------------------------------------------------
# Pure resolution logic — no DB access here
# ----------------------------------------------------------------------------

def compute_desired_state(
    adviser_links: list[dict[str, Any]],
    adv_crds: set[str],
) -> dict[str, dict[str, Optional[str]]]:
    """Pure function. Given series-level links + valid CRD set, compute the
    desired (adv_crd, method) for each registrant CIK.

    Returns {cik: {"adv_crd": str|None, "method": str|None, "bucket": str}}
    where bucket is one of:
      - resolved_single        : one CRD across all distinct series, in ADV
      - cleared_multi_adviser  : multiple distinct CRDs across series
      - cleared_not_in_adv     : single CRD parsed but not in advisers_enriched
      - cleared_no_primary     : no investment_adviser link found at all
    """
    # Group links by CIK, then by distinct series_id, collecting CRDs per series.
    # Counts DISTINCT series, not raw link rows (Codex bug C fix).
    crds_per_series: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for link in adviser_links:
        if link.get("adviser_role") != "investment_adviser":
            continue
        cik = link.get("registrant_cik")
        crd = link.get("adviser_crd_normalized")
        series_id = link.get("series_id") or "__no_series__"
        if cik and crd:
            crds_per_series[str(cik)][str(series_id)].add(str(crd))

    desired: dict[str, dict[str, Optional[str]]] = {}
    for cik, series_map in crds_per_series.items():
        # Per series, if there are multiple primary CRDs for the same series,
        # we don't have a clean choice — collapse to "any of them" (the parser
        # emits one row per adviser-entry, so this is rare but possible).
        # For the "is this multi-adviser at registrant level" question, we
        # count DISTINCT CRDs across all series.
        all_crds: set[str] = set()
        for series_id, crd_set in series_map.items():
            all_crds.update(crd_set)

        if not all_crds:
            desired[cik] = {
                "adv_crd": None,
                "method": None,
                "bucket": "cleared_no_primary",
            }
        elif len(all_crds) > 1:
            desired[cik] = {
                "adv_crd": None,
                "method": None,
                "bucket": "cleared_multi_adviser",
            }
        else:
            only_crd = next(iter(all_crds))
            if only_crd in adv_crds:
                desired[cik] = {
                    "adv_crd": only_crd,
                    "method": "ncen_xref",
                    "bucket": "resolved_single",
                }
            else:
                desired[cik] = {
                    "adv_crd": None,
                    "method": None,
                    "bucket": "cleared_not_in_adv",
                }
    return desired


def diff_states(
    current: dict[str, dict[str, Any]],
    desired: dict[str, dict[str, Optional[str]]],
) -> list[dict[str, Any]]:
    """Return the list of (cik, current, target) tuples where state differs.

    Only CIKs present in desired (i.e., have at least one investment_adviser
    link) are considered — registrants without N-CEN data are left alone.
    """
    diffs: list[dict[str, Any]] = []
    for cik, target in desired.items():
        cur = current.get(cik, {"adv_crd": None, "adv_crd_match_method": None})
        if (
            cur.get("adv_crd") == target["adv_crd"]
            and cur.get("adv_crd_match_method") == target["method"]
        ):
            continue
        diffs.append(
            {
                "cik": cik,
                "current_adv_crd": cur.get("adv_crd"),
                "current_method": cur.get("adv_crd_match_method"),
                "target_adv_crd": target["adv_crd"],
                "target_method": target["method"],
                "bucket": target["bucket"],
            }
        )
    return diffs


# ----------------------------------------------------------------------------
# Write path with per-update verification
# ----------------------------------------------------------------------------

def apply_updates(
    nport_client,
    diffs: list[dict[str, Any]],
) -> dict[str, int]:
    """Apply updates one at a time, verifying each affects exactly one row.

    Returns a tally:
      {"updated": int, "zero_row": int, "multi_row": int, "errored": int}
    """
    tally = {"updated": 0, "zero_row": 0, "multi_row": 0, "errored": 0}
    for diff in diffs:
        try:
            response = (
                nport_client.table("nport_registrants")
                .update(
                    {
                        "adv_crd": diff["target_adv_crd"],
                        "adv_crd_match_method": diff["target_method"],
                    }
                )
                .eq("cik", diff["cik"])
                .execute()
            )
            n = len(response.data or [])
            if n == 1:
                tally["updated"] += 1
            elif n == 0:
                tally["zero_row"] += 1
                print(
                    f"  WARN: zero rows updated for cik={diff['cik']} "
                    f"(not in nport_registrants)",
                    file=sys.stderr,
                )
            else:
                tally["multi_row"] += 1
                print(
                    f"  WARN: {n} rows updated for cik={diff['cik']} "
                    f"(expected exactly 1)",
                    file=sys.stderr,
                )
        except Exception as exc:  # noqa: BLE001
            tally["errored"] += 1
            print(
                f"  ERROR updating cik={diff['cik']}: {exc}",
                file=sys.stderr,
            )
    return tally


# ----------------------------------------------------------------------------
# Reporting
# ----------------------------------------------------------------------------

def summarize_buckets(desired: dict[str, dict[str, Optional[str]]]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for entry in desired.values():
        counts[entry["bucket"]] += 1
    return dict(counts)


def report_planned(diffs: list[dict[str, Any]], desired: dict[str, dict[str, Optional[str]]]) -> None:
    bucket_counts = summarize_buckets(desired)
    diff_by_bucket: dict[str, int] = defaultdict(int)
    for d in diffs:
        diff_by_bucket[d["bucket"]] += 1
    print("Bucket totals (across all CIKs with N-CEN data):")
    for bucket, count in sorted(bucket_counts.items()):
        print(f"  {bucket}: {count} (writes pending: {diff_by_bucket.get(bucket, 0)})")
    print(f"Total CIKs with N-CEN data: {sum(bucket_counts.values())}")
    print(f"Total updates pending: {len(diffs)}")
    if diffs[:5]:
        print("Sample diffs:")
        for d in diffs[:5]:
            print(f"  {json.dumps(d, sort_keys=True)}")


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reconcile nport_registrants.adv_crd from fund_ncen_adviser_links"
    )
    parser.add_argument("--cik", action="append", default=[], help="Restrict to specific CIK; repeatable")
    parser.add_argument("--execute", action="store_true", help="Apply updates (default is dry-run)")
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    load_credentials()

    nport = create_nport_client()
    adv = create_adv_client()

    print("Loading ADV CRD set...")
    adv_crds = load_adv_crd_set(adv)
    print(f"  loaded {len(adv_crds)} CRDs from advisers_enriched")

    print("Loading fund_ncen_adviser_links...")
    ciks_filter = args.cik or None
    links = load_adviser_links(nport, ciks=ciks_filter)
    print(f"  loaded {len(links)} link rows")

    print("Loading current nport_registrants state...")
    current = load_current_registrant_state(nport, ciks=ciks_filter)
    print(f"  loaded {len(current)} registrant rows")

    print("Computing desired state...")
    desired = compute_desired_state(links, adv_crds)
    diffs = diff_states(current, desired)

    report_planned(diffs, desired)

    if not args.execute:
        print("\nDry run only. Re-run with --execute to apply.")
        return 0

    if not diffs:
        print("\nNothing to update.")
        return 0

    print(f"\nApplying {len(diffs)} updates...")
    tally = apply_updates(nport, diffs)
    print(f"Update tally: {json.dumps(tally, sort_keys=True)}")

    # Exit nonzero if any updates didn't behave as expected
    if tally["zero_row"] > 0 or tally["multi_row"] > 0 or tally["errored"] > 0:
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
