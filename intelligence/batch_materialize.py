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


SUSPICIOUS_ALIAS_THRESHOLD = 500  # Form D rows; tune after seeing distribution
LOW_RESOLUTION_THRESHOLD = 0.30   # 30% adviser-resolved minimum

MANIFEST_COLUMNS = [
    "slug",
    "display_name",
    "status",
    "flags",
    "nport_positions",
    "formd_pooled",
    "formd_direct_issuer",
    "resolutions",
    "resolution_rate",
    "wall_clock_seconds",
    "error",
]


def list_company_slugs(nport, limit: Optional[int] = None) -> list[dict[str, str]]:
    """Return [{slug, display_name}, ...] for all rows in private_companies."""
    rows: list[dict[str, str]] = []
    last_slug = ""
    while True:
        query = (
            nport.table("private_companies")
            .select("slug,display_name")
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
    """Apply quality gates. Returns (primary_status, list_of_all_flags)."""
    nport_n = result.get("positions") or result.get("positions_pending") or 0
    pooled_n = result.get("pooled") or result.get("pooled_pending") or 0
    direct_n = result.get("direct") or result.get("direct_pending") or 0
    res_n = result.get("resolutions") or result.get("resolutions_pending_total") or 0
    total = nport_n + pooled_n
    rate = (res_n / total) if total else 0.0

    flags: list[str] = []
    if total == 0:
        flags.append("no_evidence")
    if pooled_n >= SUSPICIOUS_ALIAS_THRESHOLD:
        flags.append("suspicious_alias")
    if total > 0 and rate < LOW_RESOLUTION_THRESHOLD:
        flags.append("low_resolution")
    if direct_n > 0:
        flags.append("direct_issuer_risk")
    primary = flags[0] if flags else "ok"
    return primary, flags


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
                    "status": "error",
                    "flags": "error",
                    "nport_positions": 0,
                    "formd_pooled": 0,
                    "formd_direct_issuer": 0,
                    "resolutions": 0,
                    "resolution_rate": 0,
                    "wall_clock_seconds": round(elapsed, 1),
                    "error": str(result["error"])[:200],
                }
                errors += 1
            else:
                primary, flags = classify_status(result)
                nport_n = result.get("positions") or result.get("positions_pending") or 0
                pooled_n = result.get("pooled") or result.get("pooled_pending") or 0
                direct_n = result.get("direct") or result.get("direct_pending") or 0
                res_n = result.get("resolutions") or result.get("resolutions_pending_total") or 0
                total = nport_n + pooled_n
                rate = (res_n / total) if total else 0.0
                row = {
                    "slug": slug,
                    "display_name": display_name,
                    "status": primary,
                    "flags": "|".join(flags) if flags else "ok",
                    "nport_positions": nport_n,
                    "formd_pooled": pooled_n,
                    "formd_direct_issuer": direct_n,
                    "resolutions": res_n,
                    "resolution_rate": round(rate, 3),
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
                "status": "error",
                "flags": "error",
                "nport_positions": 0,
                "formd_pooled": 0,
                "formd_direct_issuer": 0,
                "resolutions": 0,
                "resolution_rate": 0,
                "wall_clock_seconds": round(elapsed, 1),
                "error": str(exc)[:200],
            }
            errors += 1

        append_manifest_row(manifest_path, row)
        print(
            f"  [{i:>3d}/{len(company_rows)}] {slug:30s}  "
            f"{row['status']:18s}  "
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
