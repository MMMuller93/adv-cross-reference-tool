"""Web-enrich advisers we resolved via IAPD that don't yet have an
`enriched_managers` row in the Form D DB.

For each distinct CRD in `intel_adviser_resolution`:
  1. Look up the firm name from `advisers_enriched` (ADV DB).
  2. Check whether `enriched_managers` (Form D DB) already has a matching row.
     Match heuristic = case-insensitive substring against `series_master_llc`,
     same shape enrichment_engine_v2 uses internally.
  3. If missing, call the PFR enrichment shim (enrich_manager_shim.js) to get
     the LinkedIn URL / website / team members.
  4. Append the result to `intelligence/out/enrichment_results.json` —
     NEVER write to enriched_managers from here. That table is owned by the
     primary enrichment pipeline; this script just produces evidence the user
     can review before integrating writes in a later phase.

CLI:
   python3 intelligence/enrich_unbridged.py --company anthropic         # default
   python3 intelligence/enrich_unbridged.py --company anthropic --limit 3
   python3 intelligence/enrich_unbridged.py --crd 324933                # ad hoc
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
SHIM_JS = Path(__file__).resolve().parent / "enrich_manager_shim.js"
OUT_PATH = Path(__file__).resolve().parent / "out" / "enrichment_results.json"


def _read_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


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


def create_formd_client():
    url = os.environ.get("SUPABASE_URL_FORMD") or "https://ltdalxkhbbhmkimmogyq.supabase.co"
    key = os.environ.get("SUPABASE_ANON_KEY_FORMD") or os.environ.get("FORMD_SUPABASE_ANON_KEY")
    if not key:
        raise RuntimeError("SUPABASE_ANON_KEY_FORMD required (add to .env.nport)")
    from supabase import create_client  # type: ignore
    return create_client(url, key)


# --- DB lookups ---

def fetch_crds_for_company(nport, company_slug: str) -> set[str]:
    """All CRDs we've already resolved for this company. We then check which
    ones lack enrichment, regardless of HOW they were resolved (n-port,
    cross-ref, or our new iapd_scrape_match)."""
    pooled_resp = (
        nport.table("intel_formd_pooled_vehicle_offering")
        .select("offering_id")
        .eq("company_slug", company_slug)
        .execute()
    )
    pooled_ids = [int(r["offering_id"]) for r in pooled_resp.data or []]
    nport_resp = (
        nport.table("intel_nport_position")
        .select("position_id")
        .eq("company_slug", company_slug)
        .execute()
    )
    nport_ids = [int(r["position_id"]) for r in nport_resp.data or []]

    crds: set[str] = set()
    for table, ids in (
        ("intel_formd_pooled_vehicle_offering", pooled_ids),
        ("intel_nport_position", nport_ids),
    ):
        for chunk_start in range(0, len(ids), 200):
            chunk = ids[chunk_start : chunk_start + 200]
            if not chunk:
                continue
            resp = (
                nport.table("intel_adviser_resolution")
                .select("crd")
                .eq("source_table", table)
                .in_("source_id", chunk)
                .execute()
            )
            for row in resp.data or []:
                if row.get("crd"):
                    crds.add(str(row["crd"]))
    return crds


def fetch_adviser_names(adv, crds: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for chunk_start in range(0, len(crds), 200):
        chunk = [int(c) for c in crds[chunk_start : chunk_start + 200] if str(c).isdigit()]
        if not chunk:
            continue
        resp = (
            adv.table("advisers_enriched").select("crd,adviser_name").in_("crd", chunk).execute()
        )
        for row in resp.data or []:
            if row.get("adviser_name"):
                out[str(row["crd"])] = row["adviser_name"]
    return out


def existing_enrichments(formd, names: list[str]) -> set[str]:
    """Returns the subset of names that already have a matching row in
    `enriched_managers`. Matching by exact case-insensitive series_master_llc
    OR by normalized substring (engine convention)."""
    found: set[str] = set()
    for name in names:
        if not name:
            continue
        # Exact match attempt first.
        resp = (
            formd.table("enriched_managers")
            .select("series_master_llc")
            .ilike("series_master_llc", name)
            .limit(1)
            .execute()
        )
        if resp.data:
            found.add(name)
            continue
        # Substring fallback (engine matches by normalized inclusion).
        head = re.sub(r"\s+(LLC|L\.L\.C\.|LP|L\.P\.|INC|LTD|CORP)\.?\s*$", "", name, flags=re.IGNORECASE).strip()
        if head and head != name:
            resp = (
                formd.table("enriched_managers")
                .select("series_master_llc")
                .ilike("series_master_llc", f"%{head}%")
                .limit(1)
                .execute()
            )
            if resp.data:
                found.add(name)
    return found


# --- Shim invocation ---

def call_shim(names: list[str]) -> list[dict[str, Any]]:
    if not names:
        return []
    payload = json.dumps({"names": names})
    # 120s per name is generous; engine does several HTTP calls per manager.
    timeout_s = max(180, 120 * len(names))
    proc = subprocess.run(
        ["node", str(SHIM_JS), "--stdin"],
        input=payload,
        capture_output=True,
        text=True,
        cwd=str(PFR_ROOT),  # so the engine's dotenv finds PFR's .env
        timeout=timeout_s,
    )
    if proc.returncode != 0:
        sys.stderr.write(f"[enrich_unbridged] shim stderr:\n{proc.stderr}\n")
        raise RuntimeError(f"enrich_manager_shim exited {proc.returncode}")
    parsed = json.loads(proc.stdout or "{}")
    return parsed.get("results", [])


def append_results(records: list[dict[str, Any]]) -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = []
    if OUT_PATH.exists():
        try:
            existing = json.loads(OUT_PATH.read_text())
        except json.JSONDecodeError:
            existing = []
    existing.extend(records)
    OUT_PATH.write_text(json.dumps(existing, indent=2, default=str))


# --- Main ---

def run_for_company(nport, adv, formd, company_slug: str, *, limit: Optional[int]) -> dict[str, Any]:
    print(f"\n=== Web enrichment for {company_slug} unbridged advisers ===")
    crds = sorted(fetch_crds_for_company(nport, company_slug))
    print(f"  distinct CRDs in resolutions for this company: {len(crds)}")
    if not crds:
        return {"crds": 0, "to_enrich": 0, "results": 0}

    name_by_crd = fetch_adviser_names(adv, crds)
    print(f"  resolved {len(name_by_crd)} CRD->name mappings from advisers_enriched")

    have = existing_enrichments(formd, list(name_by_crd.values()))
    print(f"  already in enriched_managers: {len(have)}")

    needs = [(crd, nm) for crd, nm in name_by_crd.items() if nm not in have]
    needs.sort(key=lambda x: x[1])
    if limit is not None:
        needs = needs[:limit]
    print(f"  to enrich now: {len(needs)}")
    for c, n in needs[:10]:
        print(f"    - CRD {c}  |  {n}")

    if not needs:
        return {"crds": len(crds), "to_enrich": 0, "results": 0}

    enrich_names = [n for _, n in needs]
    print(f"\n  calling enrich_manager_shim.js on {len(enrich_names)} firm(s)...")
    raw_results = call_shim(enrich_names)

    out_records: list[dict[str, Any]] = []
    for (crd, name), r in zip(needs, raw_results):
        if r.get("ok"):
            d = r.get("data", {})
            out_records.append({
                "company_slug": company_slug,
                "crd": crd,
                "queried_name": name,
                "ok": True,
                "linkedin_company_url": d.get("linkedin_company_url"),
                "website_url": d.get("website_url"),
                "twitter_handle": d.get("twitter_handle"),
                "team_members_count": len(d.get("team_members") or []),
                "team_members": d.get("team_members"),
                "fund_type": d.get("fund_type"),
                "enrichment_status": d.get("enrichment_status"),
                "confidence_score": d.get("confidence_score"),
                "data_sources": d.get("data_sources"),
            })
        else:
            out_records.append({
                "company_slug": company_slug,
                "crd": crd,
                "queried_name": name,
                "ok": False,
                "error": r.get("error"),
            })

    append_results(out_records)
    print(f"  appended {len(out_records)} record(s) to {OUT_PATH}")
    return {"crds": len(crds), "to_enrich": len(needs), "results": len(out_records)}


def run_for_crd(nport, adv, formd, crd: str) -> dict[str, Any]:
    name_by_crd = fetch_adviser_names(adv, [crd])
    if not name_by_crd:
        print(f"CRD {crd} not in advisers_enriched", file=sys.stderr)
        return {"results": 0}
    name = name_by_crd[crd]
    print(f"Enriching CRD {crd} ({name})...")
    raw_results = call_shim([name])
    out = []
    for r in raw_results:
        if r.get("ok"):
            d = r["data"]
            out.append({
                "crd": crd, "queried_name": name, "ok": True,
                "linkedin_company_url": d.get("linkedin_company_url"),
                "website_url": d.get("website_url"),
                "team_members_count": len(d.get("team_members") or []),
                "team_members": d.get("team_members"),
                "data_sources": d.get("data_sources"),
            })
        else:
            out.append({"crd": crd, "queried_name": name, "ok": False, "error": r.get("error")})
    append_results(out)
    print(json.dumps(out, indent=2, default=str))
    return {"results": len(out)}


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--company", help="Company slug")
    p.add_argument("--crd", help="One-off CRD to enrich")
    p.add_argument("--limit", type=int, default=None, help="Cap per-company enrichment count")
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    load_credentials()
    nport = create_nport_client()
    adv = create_adv_client()
    formd = create_formd_client()

    if args.crd:
        summary = run_for_crd(nport, adv, formd, args.crd)
    elif args.company:
        summary = run_for_company(nport, adv, formd, args.company, limit=args.limit)
    else:
        print("ERROR: provide --company SLUG or --crd CRD", file=sys.stderr)
        return 2
    print("\nSummary:", json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
