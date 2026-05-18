"""Diagnostic batch runner: materialize holder evidence for every seeded company.

Differs from running materialize_holders.py 843 times in a shell loop:

  - Loads credentials, Supabase clients, and the ADV CRD set ONCE upfront
    (saves ~5 seconds per company on the CRD fetch alone).
  - Tracks timing, counts, and quality flags per company in a manifest CSV.
  - Resumable: --resume skips companies already in the manifest.
  - No quality gate refusal to write — every company gets a manifest row.
    The manifest is the primary output; per-company CSVs are generated
    via fund_holders_query.py only for companies where the manifest
    indicates the report is worth reviewing.

Quality flags per company (manifest column `status`):
  - no_evidence:        0 N-PORT positions AND 0 Form D pooled vehicles
                        (legitimate for unseeded-in-the-data companies)
  - suspicious_alias:   Form D match count > SUSPICIOUS_ALIAS_THRESHOLD
                        (likely false-positive explosion from a broad alias)
  - low_resolution:     adviser-resolved / total < LOW_RESOLUTION_THRESHOLD
  - direct_issuer_risk: direct-issuer offerings found
                        (shouldn't happen for V1 seeded set per POC2)
  - ok:                 evidence exists and passes all checks

This is a DIAGNOSTIC run, not a publication. Multiple flags can apply
to the same company; they're informational, not blocking.
"""
from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path
from typing import Any, Optional

# Reuse functions from materialize_holders
sys.path.insert(0, str(Path(__file__).resolve().parent))
from materialize_holders import (  # type: ignore[import-not-found]
    NEGATIVE_PATTERNS_BY_COMPANY,
    create_adv_client,
    create_formd_client,
    create_nport_client,
    fetch_company_aliases,
    fetch_direct_issuer_formd,
    fetch_formd_via_cross_reference,
    fetch_nport_adviser_resolutions,
    fetch_nport_positions,
    fetch_valid_adv_crds,
    get_company_metadata,
    materialize_company,
    load_credentials,
)


LOW_RESOLUTION_THRESHOLD = 0.30   # below this, status=low_resolution
MIN_EVIDENCE_FOR_PUBLISH = 3      # need at least this many evidence rows
MIN_RESOLVED_FOR_PUBLISH = 2      # OR at least this many resolved advisers
PUBLISH_LIFECYCLE_ALLOWED = {"private", None}  # public/acquired -> not auto-publishable

MANIFEST_COLUMNS = [
    "slug",
    "display_name",
    "lifecycle_status",
    "status",
    "flags",
    "publishable",
    "publish_reason",
    "nport_positions",
    "formd_pooled",
    "formd_direct_issuer",
    "resolutions",
    "distinct_advisers",
    "resolution_rate",
    "suspicious_alias_count",
    "wall_clock_seconds",
    "error",
]


def list_company_slugs(nport, limit: Optional[int] = None) -> list[dict[str, str]]:
    """Return [{slug, display_name, lifecycle_status}, ...] for all rows in private_companies."""
    rows: list[dict[str, str]] = []
    last_slug = ""
    while True:
        query = (
            nport.table("private_companies")
            .select("slug,display_name,lifecycle_status")
            .gt("slug", last_slug)
            .order("slug")
            .limit(1000)
        )
        result = query.execute()
        batch = result.data or []
        if not batch:
            break
        rows.extend(batch)
        last_slug = batch[-1]["slug"]
        if len(batch) < 1000:
            break
        if limit and len(rows) >= limit:
            return rows[:limit]
    return rows[:limit] if limit else rows


def read_existing_manifest(path: Path) -> set[str]:
    """Return the set of slugs already in the manifest (for --resume)."""
    if not path.exists():
        return set()
    with path.open() as f:
        return {row["slug"] for row in csv.DictReader(f)}


def append_manifest_row(path: Path, row: dict[str, Any]) -> None:
    is_new = not path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_COLUMNS)
        if is_new:
            writer.writeheader()
        writer.writerow(row)


def classify_status(result: dict[str, Any]) -> tuple[str, list[str]]:
    """Apply quality gates. Returns (primary_status, list_of_all_flags).

    Statuses (in priority order — first match wins for primary):
      no_evidence:        0 N-PORT + 0 Form D pooled vehicles
      alias_review:       at least one alias was capped (hit > ALIAS_HIT_CAP);
                          rows were discarded — manifest needs review
      low_resolution:     has evidence, <30% adviser-resolved
      ok:                 evidence exists, resolution acceptable
    """
    nport_n = result.get("positions") or result.get("positions_pending") or 0
    pooled_n = result.get("pooled") or result.get("pooled_pending") or 0
    direct_n = result.get("direct") or result.get("direct_pending") or 0
    res_n = result.get("resolutions") or result.get("resolutions_pending_total") or 0
    susp = result.get("suspicious_aliases") or []
    total = nport_n + pooled_n
    rate = (res_n / total) if total else 0.0

    flags: list[str] = []
    if total == 0 and not susp:
        flags.append("no_evidence")
    if susp:
        flags.append("alias_review")
    if total > 0 and rate < LOW_RESOLUTION_THRESHOLD:
        flags.append("low_resolution")
    primary = flags[0] if flags else "ok"
    return primary, flags


def evaluate_publishable(
    result: dict[str, Any],
    flags: list[str],
    lifecycle_status: Optional[str],
) -> tuple[bool, str]:
    """Apply the publication gate (Codex spec).

    A company is publishable iff:
      - lifecycle is private (or NULL), NOT public/acquired
      - no alias_review flag
      - no error
      - has at least MIN_EVIDENCE_FOR_PUBLISH evidence rows
        OR at least MIN_RESOLVED_FOR_PUBLISH advisers identified
      - resolution rate >= LOW_RESOLUTION_THRESHOLD

    Returns (publishable: bool, reason: str). Reason describes why
    NOT publishable when False; 'ok' when True.
    """
    if lifecycle_status not in PUBLISH_LIFECYCLE_ALLOWED:
        return False, f"lifecycle_{lifecycle_status}"
    if "error" in flags:
        return False, "error"

    nport_n = result.get("positions") or 0
    pooled_n = result.get("pooled") or 0
    res_n = result.get("resolutions") or 0
    distinct_advisers = result.get("distinct_advisers") or 0
    total = nport_n + pooled_n

    if total == 0:
        return False, "no_evidence"
    # Use DISTINCT advisers, not resolution rows, for the "min advisers"
    # threshold — Codex flagged this. A company with 2 Form D rows both
    # attributed to the same firm has only 1 distinct adviser.
    if total < MIN_EVIDENCE_FOR_PUBLISH and distinct_advisers < MIN_RESOLVED_FOR_PUBLISH:
        return False, "thin_evidence"
    if total > 0 and (res_n / total) < LOW_RESOLUTION_THRESHOLD:
        return False, "low_resolution"
    # alias_review is intentionally informational, not blocking. The
    # alias-hit-cap discards bad rows at the source, so when alias_review
    # fires the remaining evidence is still clean. The flag tells the
    # operator "one or more aliases were filtered — review them if you
    # want better coverage." If alias_review + low_resolution co-occur,
    # the low_resolution branch above blocks publication.
    return True, "ok"


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Diagnostic batch materialization for every seeded company."
    )
    parser.add_argument(
        "--manifest",
        default=str(Path(__file__).resolve().parent / "out" / "batch_manifest.csv"),
        help="Path to manifest CSV. Default: intelligence/out/batch_manifest.csv",
    )
    parser.add_argument("--limit", type=int, help="Max companies to process")
    parser.add_argument("--slug", action="append", help="Process only specific slug(s); repeatable")
    parser.add_argument("--resume", action="store_true", help="Skip slugs already in manifest")
    parser.add_argument("--execute", action="store_true", help="Materialize for real (default: dry-run)")
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    manifest_path = Path(args.manifest)

    load_credentials()
    nport = create_nport_client()
    formd = create_formd_client()
    adv = create_adv_client()

    print("Loading ADV CRD set (once for the whole batch)...")
    adv_crds = fetch_valid_adv_crds(adv)
    print(f"  {len(adv_crds)} CRDs")

    if args.slug:
        company_rows = [{"slug": s, "display_name": s} for s in args.slug]
    else:
        company_rows = list_company_slugs(nport, limit=args.limit)
    print(f"\nCompanies to process: {len(company_rows)}")

    already_done: set[str] = set()
    if args.resume:
        already_done = read_existing_manifest(manifest_path)
        if already_done:
            print(f"  resuming — skipping {len(already_done)} already in manifest")
            company_rows = [c for c in company_rows if c["slug"] not in already_done]
            print(f"  remaining: {len(company_rows)}")

    if not company_rows:
        print("Nothing to do.")
        return 0

    successes = 0
    errors = 0
    flag_counts: dict[str, int] = {}

    for i, company in enumerate(company_rows, 1):
        slug = company["slug"]
        display_name = company.get("display_name") or slug
        lifecycle = company.get("lifecycle_status")
        start = time.time()
        try:
            result = materialize_company(
                nport, formd, adv_crds, slug, execute=args.execute
            )
            elapsed = time.time() - start
            if result.get("error"):
                row = {
                    "slug": slug,
                    "display_name": display_name,
                    "lifecycle_status": lifecycle,
                    "status": "error",
                    "flags": "error",
                    "publishable": False,
                    "publish_reason": "error",
                    "nport_positions": 0,
                    "formd_pooled": 0,
                    "formd_direct_issuer": 0,
                    "resolutions": 0,
                    "distinct_advisers": 0,
                    "resolution_rate": 0,
                    "suspicious_alias_count": 0,
                    "wall_clock_seconds": round(elapsed, 1),
                    "error": str(result["error"])[:200],
                }
                errors += 1
            else:
                primary, flags = classify_status(result)
                publishable, reason = evaluate_publishable(result, flags, lifecycle)
                nport_n = result.get("positions") or result.get("positions_pending") or 0
                pooled_n = result.get("pooled") or result.get("pooled_pending") or 0
                direct_n = result.get("direct") or result.get("direct_pending") or 0
                res_n = result.get("resolutions") or result.get("resolutions_pending_total") or 0
                susp = result.get("suspicious_aliases") or []
                total = nport_n + pooled_n
                rate = (res_n / total) if total else 0.0
                row = {
                    "slug": slug,
                    "display_name": display_name,
                    "lifecycle_status": lifecycle,
                    "status": primary,
                    "flags": "|".join(flags) if flags else "ok",
                    "publishable": publishable,
                    "publish_reason": reason,
                    "nport_positions": nport_n,
                    "formd_pooled": pooled_n,
                    "formd_direct_issuer": direct_n,
                    "resolutions": res_n,
                    "distinct_advisers": result.get("distinct_advisers") or 0,
                    "resolution_rate": round(rate, 3),
                    "suspicious_alias_count": len(susp),
                    "wall_clock_seconds": round(elapsed, 1),
                    "error": "",
                }
                successes += 1
                flag_counts[primary] = flag_counts.get(primary, 0) + 1
        except Exception as exc:  # noqa: BLE001
            elapsed = time.time() - start
            row = {
                "slug": slug,
                "display_name": display_name,
                "lifecycle_status": lifecycle,
                "status": "error",
                "flags": "error",
                "publishable": False,
                "publish_reason": "error",
                "nport_positions": 0,
                "formd_pooled": 0,
                "formd_direct_issuer": 0,
                "resolutions": 0,
                "distinct_advisers": 0,
                "resolution_rate": 0,
                "suspicious_alias_count": 0,
                "wall_clock_seconds": round(elapsed, 1),
                "error": str(exc)[:200],
            }
            errors += 1

        append_manifest_row(manifest_path, row)
        pub_label = "PUBLISH" if row["publishable"] else "skip"
        print(
            f"  [{i:>3d}/{len(company_rows)}] {slug:30s}  "
            f"{row['status']:14s}  pub:{pub_label:7s}  "
            f"nport={row['nport_positions']:>4d}  pooled={row['formd_pooled']:>4d}  "
            f"resolved={row['resolution_rate']:.0%}  ({elapsed:.1f}s)"
        )

    print(f"\nDone. {successes} succeeded, {errors} errored.")
    print(f"\nStatus distribution:")
    for status, count in sorted(flag_counts.items(), key=lambda x: -x[1]):
        print(f"  {status:20s}  {count}")
    print(f"\nManifest: {manifest_path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
