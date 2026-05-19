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
MIN_EVIDENCE_FOR_PUBLISH = 3      # need at least this many private-era evidence rows
MIN_RESOLVED_FOR_PUBLISH = 2      # OR at least this many resolved advisers
# Lifecycle-aware: eligible-for-publication evidence is rows where the
# company status at the evidence date was 'private' (we know it was private)
# OR 'unknown' (no lifecycle event seeded — pragmatic default for unseeded
# companies; once we seed an event the status flips to a known value).
PUBLISH_ELIGIBLE_STATUSES = {"private", "unknown"}

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
    # Lifecycle-aware evidence counts (from v_intel_company_holders).
    # eligible = status is 'private' or 'unknown' at the evidence date.
    "eligible_evidence",
    "public_era_evidence",
    "eligible_distinct_advisers",
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
    eligible_evidence: int,
    eligible_distinct_advisers: int,
) -> tuple[bool, str]:
    """Apply the publication gate (Codex 2026-05-18 spec — lifecycle-aware).

    A company is publishable iff:
      - no error
      - at least MIN_EVIDENCE_FOR_PUBLISH ELIGIBLE evidence rows
        (status_at_evidence_date IN private/unknown)
        OR at least MIN_RESOLVED_FOR_PUBLISH ELIGIBLE distinct advisers
      - resolution rate >= LOW_RESOLUTION_THRESHOLD

    Eligible-distinct-advisers (Codex sign-off correction): count distinct
    adviser CRDs ONLY among private-era rows. Public-era advisers don't
    count toward thin_evidence fallback. Previously, Ginkgo Bioworks had
    eligible=1 + 2 distinct advisers (1 private-era + 1 public-era) and
    slipped through — now eligible_distinct_advisers=1, correctly thin.

    Returns (publishable, reason).
    """
    if "error" in flags:
        return False, "error"

    res_n = result.get("resolutions") or 0
    nport_n = result.get("positions") or 0
    pooled_n = result.get("pooled") or 0
    total = nport_n + pooled_n

    if eligible_evidence == 0:
        if total == 0:
            return False, "no_evidence"
        # Has data but all of it is public-era — block from auto-publish.
        return False, "no_private_era_evidence"

    if (eligible_evidence < MIN_EVIDENCE_FOR_PUBLISH
            and eligible_distinct_advisers < MIN_RESOLVED_FOR_PUBLISH):
        return False, "thin_evidence"
    if total > 0 and (res_n / total) < LOW_RESOLUTION_THRESHOLD:
        return False, "low_resolution"
    # alias_review is intentionally informational, not blocking. The
    # alias-hit-cap discards bad rows at the source, so when alias_review
    # fires the remaining evidence is still clean.
    return True, "ok"


def preload_lifecycle_aggregates(nport_client) -> dict[str, dict[str, int]]:
    """One-shot batch load of lifecycle aggregates for every company.

    Codex optimization: replaces the per-company query that was running
    inside the materialize loop (was adding ~5s × 843 ≈ 70 min to the
    batch). Instead we walk v_intel_company_holders once, group in Python,
    and return {company_slug: {eligible, public_era, eligible_distinct_advisers}}.

    Trade-off: holds ~30K rows in memory briefly. Negligible.
    """
    aggregates: dict[str, dict] = {}
    last_evid: dict[str, int] = {}

    page_size = 1000
    # We can't easily keyset by (slug, evidence_id) in one query because
    # evidence_id is unique per source_type, not globally. So walk each
    # source_type bucket separately.
    for source_type in ("nport", "formd_pooled_vehicle"):
        last_id = 0
        while True:
            response = (
                nport_client.table("v_intel_company_holders")
                .select("company_slug,evidence_id,status_at_evidence_date,adviser_crd")
                .eq("source_type", source_type)
                .gt("evidence_id", last_id)
                .order("evidence_id")
                .limit(page_size)
                .execute()
            )
            batch = response.data or []
            if not batch:
                break
            for row in batch:
                slug = row.get("company_slug")
                if not slug:
                    continue
                agg = aggregates.setdefault(slug, {
                    "eligible": 0, "public_era": 0,
                    "eligible_adviser_set": set(),
                })
                status = row.get("status_at_evidence_date")
                if status in PUBLISH_ELIGIBLE_STATUSES:
                    agg["eligible"] += 1
                    crd = row.get("adviser_crd")
                    if crd:
                        agg["eligible_adviser_set"].add(str(crd))
                else:
                    agg["public_era"] += 1
            last_id = int(batch[-1]["evidence_id"])
            if len(batch) < page_size:
                break

    # Finalize: replace set with count
    finalized: dict[str, dict[str, int]] = {}
    for slug, agg in aggregates.items():
        finalized[slug] = {
            "eligible": agg["eligible"],
            "public_era": agg["public_era"],
            "eligible_distinct_advisers": len(agg["eligible_adviser_set"]),
        }
    return finalized


def get_lifecycle_aggregate(
    aggregates: dict[str, dict[str, int]], company_slug: str
) -> tuple[int, int, int]:
    """Lookup from the preloaded aggregate. Returns (eligible, public_era,
    eligible_distinct_advisers). Companies with no evidence get zeros."""
    a = aggregates.get(company_slug)
    if not a:
        return 0, 0, 0
    return a["eligible"], a["public_era"], a["eligible_distinct_advisers"]


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

    # ---------- Phase A: materialize every company ----------
    # Materialize results are stashed; the publication gate is computed in
    # phase B after the lifecycle aggregates are preloaded in a single pass.
    # This replaces a per-company aggregate query (~5s × 843 ≈ 70 min) with
    # one bulk query (~5s total). Codex 2026-05-19 recommendation.
    materialize_results: list[dict[str, Any]] = []
    print("\n=== Phase A: materializing all companies ===")
    for i, company in enumerate(company_rows, 1):
        slug = company["slug"]
        display_name = company.get("display_name") or slug
        lifecycle = company.get("lifecycle_status")
        start = time.time()
        try:
            result = materialize_company(
                nport, formd, adv_crds, slug, execute=args.execute
            )
        except Exception as exc:  # noqa: BLE001
            result = {"error": str(exc)[:200]}
        elapsed = time.time() - start
        materialize_results.append({
            "company": company,
            "result": result,
            "elapsed": elapsed,
        })
        if (i % 25 == 0) or (i == len(company_rows)):
            print(f"  materialized {i}/{len(company_rows)} companies")

    # ---------- Phase B: preload lifecycle aggregates ----------
    print("\n=== Phase B: preloading lifecycle aggregates from v_intel_company_holders ===")
    preload_start = time.time()
    lifecycle_aggregates = preload_lifecycle_aggregates(nport)
    print(f"  aggregates for {len(lifecycle_aggregates)} companies "
          f"({time.time() - preload_start:.1f}s)")

    # ---------- Phase C: evaluate publish gate + write manifest ----------
    print("\n=== Phase C: evaluating publish gate + writing manifest ===")
    for i, mres in enumerate(materialize_results, 1):
        company = mres["company"]
        result = mres["result"]
        elapsed = mres["elapsed"]
        slug = company["slug"]
        display_name = company.get("display_name") or slug
        lifecycle = company.get("lifecycle_status")

        # Always look up lifecycle aggregate (zeros for no-evidence companies)
        (eligible_evidence,
         public_era_evidence,
         eligible_distinct_advisers) = get_lifecycle_aggregate(
            lifecycle_aggregates, slug
        )

        if result.get("error"):
            row = {
                "slug": slug, "display_name": display_name,
                "lifecycle_status": lifecycle,
                "status": "error", "flags": "error",
                "publishable": False, "publish_reason": "error",
                "nport_positions": 0, "formd_pooled": 0, "formd_direct_issuer": 0,
                "resolutions": 0, "distinct_advisers": 0, "resolution_rate": 0,
                "suspicious_alias_count": 0,
                "eligible_evidence": eligible_evidence,
                "public_era_evidence": public_era_evidence,
                "eligible_distinct_advisers": eligible_distinct_advisers,
                "wall_clock_seconds": round(elapsed, 1),
                "error": str(result["error"])[:200],
            }
            errors += 1
        else:
            primary, flags = classify_status(result)
            publishable, reason = evaluate_publishable(
                result, flags, eligible_evidence, eligible_distinct_advisers
            )
            nport_n = result.get("positions") or result.get("positions_pending") or 0
            pooled_n = result.get("pooled") or result.get("pooled_pending") or 0
            direct_n = result.get("direct") or result.get("direct_pending") or 0
            res_n = result.get("resolutions") or result.get("resolutions_pending_total") or 0
            susp = result.get("suspicious_aliases") or []
            total = nport_n + pooled_n
            rate = (res_n / total) if total else 0.0
            row = {
                "slug": slug, "display_name": display_name,
                "lifecycle_status": lifecycle,
                "status": primary, "flags": "|".join(flags) if flags else "ok",
                "publishable": publishable, "publish_reason": reason,
                "nport_positions": nport_n, "formd_pooled": pooled_n,
                "formd_direct_issuer": direct_n,
                "resolutions": res_n,
                "distinct_advisers": result.get("distinct_advisers") or 0,
                "resolution_rate": round(rate, 3),
                "suspicious_alias_count": len(susp),
                "eligible_evidence": eligible_evidence,
                "public_era_evidence": public_era_evidence,
                "eligible_distinct_advisers": eligible_distinct_advisers,
                "wall_clock_seconds": round(elapsed, 1),
                "error": "",
            }
            successes += 1
            flag_counts[primary] = flag_counts.get(primary, 0) + 1

        append_manifest_row(manifest_path, row)

    print(f"\nDone. {successes} succeeded, {errors} errored.")
    print(f"\nStatus distribution:")
    for status, count in sorted(flag_counts.items(), key=lambda x: -x[1]):
        print(f"  {status:20s}  {count}")
    print(f"\nManifest: {manifest_path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
