"""Load private-company seed JSON into the N-PORT Supabase project.

Default mode is validation-only. Use ``--execute`` to perform live upserts.
The sanctioned-securities list is intentionally excluded because
``migrations/002_seed_sanctioned.sql`` owns that table.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any, Iterable

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]

COMPANY_SEED = "private_companies_seed.json"
ALIAS_SEED = "private_company_aliases_seed.json"
BATCH_SIZE = 500

COMPANY_COLUMNS = {
    "slug",
    "display_name",
    "primary_domain",
    "sector",
    "description",
    "founded_year",
    "hq_country",
    "hq_state",
    "legal_entities",
    "most_recent_round",
    "most_recent_round_date",
    "latest_known_valuation_usd",
    "latest_known_valuation_date",
    "total_funding_usd",
    "seed_source",
    "is_sanctioned",
    "is_public",
    "ipo_date",
    "is_acquired",
    "acquired_by",
    "acquired_date",
    "lifecycle_status",
}

ALIAS_COLUMNS = {
    "company_id",
    "pattern_type",
    "pattern",
    "exposure_type",
    "underlier_only",
    "vendor_code_type",
    "notes",
    "source",
    "confidence",
}

DATE_FIELDS = {
    "most_recent_round_date",
    "latest_known_valuation_date",
    "ipo_date",
    "acquired_date",
}

ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SeedValidationError(RuntimeError):
    """Raised when seed files are internally inconsistent."""


def load_dotenv(root: Path = PROJECT_ROOT) -> None:
    """Best-effort local .env loader; existing values win."""
    env_path = root / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def read_rows(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text())
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise SeedValidationError(f"{path} does not contain a top-level rows[]")
    return rows


def normalize_date(value: Any) -> str | None:
    """Return a full ISO date, or None for blank/ambiguous dates."""
    if value in (None, ""):
        return None
    text = str(value).strip()
    return text if ISO_DATE_RE.match(text) else None


def sanitize_company(row: dict[str, Any]) -> dict[str, Any]:
    out = {k: row.get(k) for k in COMPANY_COLUMNS}
    for field in DATE_FIELDS:
        out[field] = normalize_date(out.get(field))
    if not out.get("slug") or not out.get("display_name"):
        raise SeedValidationError(f"company missing slug/display_name: {row}")
    return out


def sanitize_alias(
    row: dict[str, Any],
    slug_to_id: dict[str, str] | None = None,
) -> dict[str, Any]:
    slug = row.get("company_slug")
    if not slug:
        raise SeedValidationError(f"alias missing company_slug: {row}")
    company_id = slug_to_id.get(slug) if slug_to_id is not None else row.get("company_id")
    if slug_to_id is not None and not company_id:
        raise SeedValidationError(f"alias references unknown company_slug={slug!r}")
    out = {
        "company_id": company_id,
        "pattern_type": row.get("pattern_type"),
        "pattern": row.get("pattern"),
        "exposure_type": row.get("exposure_type") or "direct",
        "underlier_only": bool(row.get("underlier_only")),
        "vendor_code_type": row.get("vendor_code_type"),
        "notes": row.get("notes"),
        "source": row.get("source"),
        "confidence": row.get("confidence") if row.get("confidence") is not None else 100,
    }
    missing = [key for key in ("pattern_type", "pattern") if not out.get(key)]
    if missing:
        raise SeedValidationError(f"alias missing {missing}: {row}")
    return {k: out.get(k) for k in ALIAS_COLUMNS}


def chunks(rows: list[dict[str, Any]], size: int = BATCH_SIZE) -> Iterable[list[dict[str, Any]]]:
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


def build_seed_payload(input_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    raw_companies = read_rows(input_dir / COMPANY_SEED)
    company_rows = [sanitize_company(row) for row in raw_companies]
    aliases_raw = read_rows(input_dir / ALIAS_SEED)

    slugs = {row["slug"] for row in company_rows}
    alias_slugs = {row.get("company_slug") for row in aliases_raw}
    missing_slugs = sorted(slug for slug in alias_slugs if slug and slug not in slugs)
    if missing_slugs:
        raise SeedValidationError(
            f"{len(missing_slugs)} alias company_slug values are missing from company seed: "
            f"{missing_slugs[:20]}"
        )

    alias_rows = [sanitize_alias(row, slug_to_id=None) for row in aliases_raw]

    dropped_dates: list[str] = []
    for raw in raw_companies:
        for field in DATE_FIELDS:
            value = raw.get(field)
            if value and normalize_date(value) is None:
                dropped_dates.append(f"{raw.get('slug')}.{field}={value!r}")

    return company_rows, alias_rows, dropped_dates


def create_supabase_client():
    load_dotenv()
    url = os.environ.get("SUPABASE_URL_NPORT")
    key = os.environ.get("SUPABASE_SERVICE_KEY_NPORT")
    if not url or not key:
        raise SeedValidationError(
            "SUPABASE_URL_NPORT and SUPABASE_SERVICE_KEY_NPORT are required for --execute"
        )
    try:
        from supabase import create_client  # type: ignore
    except ImportError as exc:
        raise SeedValidationError(
            "supabase-py is required for --execute. Install with: pip install '.[supabase]'"
        ) from exc
    return create_client(url, key)


def upsert_companies(client, company_rows: list[dict[str, Any]]) -> dict[str, str]:
    for batch in chunks(company_rows):
        client.table("private_companies").upsert(batch, on_conflict="slug").execute()

    slug_to_id: dict[str, str] = {}
    slugs = [row["slug"] for row in company_rows]
    for i in range(0, len(slugs), 1000):
        response = (
            client.table("private_companies")
            .select("id,slug")
            .in_("slug", slugs[i : i + 1000])
            .execute()
        )
        for row in response.data or []:
            slug_to_id[row["slug"]] = row["id"]
    if len(slug_to_id) != len(slugs):
        missing = sorted(set(slugs) - set(slug_to_id))
        raise SeedValidationError(f"missing company ids after upsert: {missing[:20]}")
    return slug_to_id


def upsert_aliases(client, aliases_raw: list[dict[str, Any]], slug_to_id: dict[str, str]) -> int:
    alias_rows = [sanitize_alias(row, slug_to_id=slug_to_id) for row in aliases_raw]
    for batch in chunks(alias_rows):
        client.table("private_company_aliases").upsert(
            batch,
            on_conflict="company_id,pattern_type,pattern",
        ).execute()
    return len(alias_rows)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load N-PORT private-company seed data")
    parser.add_argument(
        "--input-dir",
        default=str(SCRIPT_DIR),
        help="Directory containing private_companies_seed.json and private_company_aliases_seed.json",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Perform live Supabase upserts. Omit for validation-only dry run.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    input_dir = Path(args.input_dir)
    try:
        companies, aliases, dropped_dates = build_seed_payload(input_dir)
        print(f"companies: {len(companies)}")
        print(f"aliases: {len(aliases)}")
        print(f"ambiguous_dates_dropped: {len(dropped_dates)}")
        if dropped_dates:
            print("first_ambiguous_dates:")
            for item in dropped_dates[:10]:
                print(f"  - {item}")

        if not args.execute:
            print("dry_run: no writes performed. Re-run with --execute to upsert.")
            return 0

        client = create_supabase_client()
        slug_to_id = upsert_companies(client, companies)
        aliases_raw = read_rows(input_dir / ALIAS_SEED)
        alias_count = upsert_aliases(client, aliases_raw, slug_to_id)
        print(f"upserted_companies: {len(companies)}")
        print(f"upserted_aliases: {alias_count}")
        return 0
    except SeedValidationError as exc:
        print(f"ERROR: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
