"""Coverage report for per-person enrichment.

For a given company (or all): how many named individuals have a
high-confidence LinkedIn URL, broken out by role bucket
(CCO / signatory / owner / team / control / regulatory).

Codex 2026-05-22 V1 plan validation gate: precision-first reporting
with per-source-bucket breakdown.

CLI:
  python intelligence/coverage_report.py --company anthropic
  python intelligence/coverage_report.py --crd 105496
  python intelligence/coverage_report.py --all
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from materialize_holders import (  # type: ignore
    create_adv_client, create_formd_client, create_nport_client,
    load_credentials,
)
from enrich_people import fetch_named_people_for_crds  # type: ignore


def coverage_for_crds(nport, adv, formd, crds: list[str]) -> dict:
    """Returns counts of named individuals + high-confidence enrichment
    rows, broken out by role bucket.
    """
    people = fetch_named_people_for_crds(nport, adv, formd, crds)
    # Dedupe on (crd, name)
    seen = set()
    deduped = []
    for p in people:
        key = (p["crd"], p["name"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(p)
    by_role = Counter(p["role"] for p in deduped)

    # Pull all high-confidence enrichment rows for those CRDs
    enriched_keys: set[tuple[str, str]] = set()
    enriched_by_role: Counter = Counter()
    for chunk_start in range(0, len(crds), 100):
        chunk = crds[chunk_start : chunk_start + 100]
        r = nport.table("v_intel_person_enrichment").select(
            "adviser_crd,normalized_name,role_hint"
        ).in_("adviser_crd", chunk).execute().data or []
        for row in r:
            key = (str(row["adviser_crd"]), row["normalized_name"])
            enriched_keys.add(key)
            enriched_by_role[row["role_hint"]] += 1

    # Now compute per-role coverage
    coverage = {}
    for role in sorted(set(by_role) | set(enriched_by_role)):
        total = by_role.get(role, 0)
        enriched = enriched_by_role.get(role, 0)
        coverage[role] = {
            "total": total,
            "enriched_high": enriched,
            "pct": (enriched / total * 100) if total > 0 else 0.0,
        }

    overall_total = len(deduped)
    overall_enriched = sum(1 for p in deduped
                           if (p["crd"], p["name"]) in enriched_keys)
    return {
        "crds_processed": len(crds),
        "people_total": overall_total,
        "people_enriched_high": overall_enriched,
        "overall_pct": (overall_enriched / overall_total * 100) if overall_total else 0.0,
        "by_role": coverage,
    }


def main(argv=None):
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--company", help="Slug; report on its tracked adviser CRDs")
    g.add_argument("--crd", action="append", help="Specific CRD; repeatable")
    g.add_argument("--all", action="store_true", help="Every tracked company")
    args = p.parse_args(argv)

    load_credentials()
    nport = create_nport_client()
    adv = create_adv_client()
    formd = create_formd_client()

    if args.crd:
        crds = list(args.crd)
    else:
        slugs = []
        if args.all:
            rs = nport.table("private_companies").select("slug").limit(5000).execute()
            slugs = [r["slug"] for r in (rs.data or [])]
        else:
            slugs = [args.company]
        crds_set = set()
        for slug in slugs:
            r = nport.table("v_intel_company_holders").select("adviser_crd").eq(
                "company_slug", slug
            ).not_.is_("adviser_crd", "null").execute().data or []
            for row in r:
                if row.get("adviser_crd"):
                    crds_set.add(str(row["adviser_crd"]))
        crds = sorted(crds_set)

    print(f"\nCoverage report — {len(crds)} CRD(s)")
    report = coverage_for_crds(nport, adv, formd, crds)
    print(f"\n  TOTAL: {report['people_enriched_high']}/{report['people_total']} "
          f"people enriched at high confidence ({report['overall_pct']:.1f}%)")
    print()
    print("  By role:")
    print(f"  {'role':<12} {'total':>8} {'enriched':>10} {'pct':>8}")
    print(f"  {'-'*12} {'-'*8} {'-'*10} {'-'*8}")
    for role, c in report["by_role"].items():
        print(f"  {role:<12} {c['total']:>8} {c['enriched_high']:>10} {c['pct']:>7.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
