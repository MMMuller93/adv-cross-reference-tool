"""Preflight checks for the live N-PORT Supabase project.

Default mode is read-only. ``--write-smoke`` performs one reversible
insert/read/delete check using synthetic rows.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]

EXPECTED_RELATIONS = [
    "private_companies",
    "private_company_aliases",
    "sanctioned_securities",
    "nport_registrants",
    "nport_filings",
    "nport_holdings",
    "nport_identifiers",
    "nport_holdings_ncsr",
    "fund_portfolio_managers",
    "fund_ncen_records",
    "fund_ncen_adviser_links",
    "position_deltas",
    "nport_company_positions_mv",
]

SMOKE_SLUG = "codex-nport-smoke-test"
SMOKE_ALIAS = "CODEX NPORT SMOKE TEST"


class PreflightError(RuntimeError):
    """Raised when live preflight checks fail."""


def load_dotenv(root: Path = PROJECT_ROOT) -> None:
    env_path = root / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def create_supabase_client():
    load_dotenv()
    url = os.environ.get("SUPABASE_URL_NPORT")
    key = os.environ.get("SUPABASE_SERVICE_KEY_NPORT")
    if not url or not key:
        raise PreflightError(
            "SUPABASE_URL_NPORT and SUPABASE_SERVICE_KEY_NPORT are required"
        )
    try:
        from supabase import create_client  # type: ignore
    except ImportError as exc:
        raise PreflightError(
            "supabase-py is required. Install with: pip install '.[supabase]'"
        ) from exc
    return create_client(url, key)


def count_relation(client, name: str) -> int:
    response = client.table(name).select("*", count="exact").limit(1).execute()
    return int(response.count or 0)


def run_readonly_checks(client) -> dict[str, int]:
    counts: dict[str, int] = {}
    for relation in EXPECTED_RELATIONS:
        try:
            counts[relation] = count_relation(client, relation)
        except Exception as exc:  # noqa: BLE001 - include relation name in error
            raise PreflightError(f"relation not queryable: {relation}: {exc}") from exc

    if counts["private_companies"] <= 0:
        raise PreflightError("private_companies is empty; run seed loader first")
    if counts["private_company_aliases"] <= 0:
        raise PreflightError("private_company_aliases is empty; resolver cannot run")
    if counts["sanctioned_securities"] <= 0:
        raise PreflightError("sanctioned_securities is empty; run 002_seed_sanctioned.sql")
    return counts


def run_write_smoke(client) -> dict[str, Any]:
    company = {
        "slug": SMOKE_SLUG,
        "display_name": "Codex N-PORT Smoke Test",
        "seed_source": "smoke_test",
        "lifecycle_status": "private",
    }
    try:
        created = (
            client.table("private_companies")
            .upsert(company, on_conflict="slug")
            .select("id,slug")
            .execute()
        )
        company_id = (created.data or [])[0]["id"]
        alias = {
            "company_id": company_id,
            "pattern_type": "exact_normalized",
            "pattern": SMOKE_ALIAS,
            "exposure_type": "direct",
            "source": "smoke_test",
            "confidence": 100,
        }
        client.table("private_company_aliases").upsert(
            alias,
            on_conflict="company_id,pattern_type,pattern",
        ).execute()
        readback = (
            client.table("private_company_aliases")
            .select("id,pattern")
            .eq("company_id", company_id)
            .eq("pattern", SMOKE_ALIAS)
            .execute()
        )
        if not readback.data:
            raise PreflightError("smoke alias did not read back after upsert")
        return {"company_id": company_id, "alias_rows": len(readback.data)}
    finally:
        try:
            client.table("private_company_aliases").delete().eq("pattern", SMOKE_ALIAS).execute()
            client.table("private_companies").delete().eq("slug", SMOKE_SLUG).execute()
        except Exception as exc:  # noqa: BLE001
            print(f"WARNING: smoke cleanup failed: {exc}", file=sys.stderr)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live N-PORT Supabase preflight")
    parser.add_argument(
        "--write-smoke",
        action="store_true",
        help="Perform one reversible write/read/delete smoke test",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        client = create_supabase_client()
        counts = run_readonly_checks(client)
        print("relation_counts:")
        for name in EXPECTED_RELATIONS:
            print(f"  {name}: {counts[name]}")
        if args.write_smoke:
            smoke = run_write_smoke(client)
            print(f"write_smoke: ok company_id={smoke['company_id']} alias_rows={smoke['alias_rows']}")
        else:
            print("write_smoke: skipped. Re-run with --write-smoke after reviewing counts.")
        return 0
    except PreflightError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
