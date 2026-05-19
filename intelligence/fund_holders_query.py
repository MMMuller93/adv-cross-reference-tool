"""Produce the fund-holders CSV report for a tracked private company.

Reads the materialized intel_* tables (populated by materialize_holders.py),
joins them to advisers_enriched for firm-level details (name, AUM, contact,
canonical website), and writes a CSV with one row per holder evidence.

Each row is labeled by source ('nport' or 'formd_pooled_vehicle'). Direct-
issuer Form Ds are NEVER included — they're stored in the audit table but
filtered out by the v_intel_company_holders view.

Adviser-firm enrichment columns are populated only when the evidence row has
a resolved CRD (intel_adviser_resolution). Unresolved evidence shows the
fund/filer name but blanks in the adviser-firm columns — that's the honest
signal that we know the holding exists but not (yet) who manages it.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path
from typing import Any, Optional

# Local imports — canonical_domain lives next to this script
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from canonical_domain import pick_canonical_domain  # type: ignore
except ImportError:
    pick_canonical_domain = None  # graceful degrade


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


def create_adv_client():
    url = os.environ.get("SUPABASE_URL_ADV") or "https://ezuqwwffjgfzymqxsctq.supabase.co"
    key = (
        os.environ.get("SUPABASE_ANON_KEY_ADV")
        or os.environ.get("ADV_SUPABASE_ANON_KEY")
        or os.environ.get("SUPABASE_SERVICE_KEY_ADV")
    )
    if not key:
        raise RuntimeError("SUPABASE_ANON_KEY_ADV required")
    from supabase import create_client  # type: ignore
    return create_client(url, key)


def create_formd_client():
    url = os.environ.get("SUPABASE_URL_FORMD") or "https://ltdalxkhbbhmkimmogyq.supabase.co"
    key = os.environ.get("SUPABASE_ANON_KEY_FORMD") or os.environ.get("FORMD_SUPABASE_ANON_KEY")
    if not key:
        return None  # enriched_managers join is optional
    from supabase import create_client  # type: ignore
    return create_client(url, key)


def _paginate_holders(nport, company_slug: str, source_type: str) -> list[dict[str, Any]]:
    """Keyset-paginate one source_type bucket of v_intel_company_holders."""
    rows: list[dict[str, Any]] = []
    last_id = 0
    page_size = 1000
    while True:
        response = (
            nport.table("v_intel_company_holders")
            .select("*")
            .eq("company_slug", company_slug)
            .eq("source_type", source_type)
            .gt("evidence_id", last_id)
            .order("evidence_id")
            .limit(page_size)
            .execute()
        )
        batch = response.data or []
        if not batch:
            break
        rows.extend(batch)
        last_id = int(batch[-1]["evidence_id"])
        if len(batch) < page_size:
            break
    return rows


def fetch_holders(nport, company_slug: str) -> list[dict[str, Any]]:
    """Pull every holder evidence row from v_intel_company_holders.

    Splits by source_type so PostgREST's 1000-row default doesn't truncate
    larger companies (SpaceX, Databricks, etc.).
    """
    rows: list[dict[str, Any]] = []
    for source_type in ("nport", "formd_pooled_vehicle"):
        rows.extend(_paginate_holders(nport, company_slug, source_type))
    return rows


def fetch_adviser_details(adv, crds: list[str]) -> dict[str, dict[str, Any]]:
    """For each CRD, pull firm-level details from advisers_enriched."""
    details: dict[str, dict[str, Any]] = {}
    if not crds:
        return details
    select_cols = (
        "crd,adviser_name,total_aum,phone_number,primary_website,other_websites,"
        "cco_name,cco_email,signatory_name,signatory_title,form_adv_url,"
        # Owner / control-person data — the firm's principals
        "owner_full_legal_name,owner_title_or_status,ownership_amount,"
        "control_person_name,direct_or_indirect_owner,"
        # Alternative regulatory-contact path (low coverage but useful when present)
        "regulatory_contact_name,regulatory_contact_email,regulatory_contact_title"
    )
    unique_crds = list({str(c).strip() for c in crds if c})
    for chunk_start in range(0, len(unique_crds), 100):
        chunk = unique_crds[chunk_start : chunk_start + 100]
        response = (
            adv.table("advisers_enriched")
            .select(select_cols)
            .in_("crd", chunk)
            .execute()
        )
        for row in response.data or []:
            details[str(row["crd"])] = row
    return details


def fetch_enriched_manager_extras(formd, crds: list[str]) -> dict[str, dict[str, Any]]:
    """Pull the small set of extra contact-path fields from enriched_managers
    (Form D DB) for any adviser CRDs that have web-enriched records.

    Coverage is sparse (~3.4k records globally, most without linked_crd
    populated) but where data exists it includes LinkedIn URL, team_members,
    and a verified primary_contact_email — very useful for outreach.
    """
    extras: dict[str, dict[str, Any]] = {}
    if formd is None or not crds:
        return extras
    unique_crds = list({str(c).strip() for c in crds if c})
    select_cols = (
        "linked_crd,website_url,linkedin_company_url,team_members,"
        "primary_contact_email,twitter_handle"
    )
    for chunk_start in range(0, len(unique_crds), 100):
        chunk = unique_crds[chunk_start : chunk_start + 100]
        response = (
            formd.table("enriched_managers")
            .select(select_cols)
            .in_("linked_crd", chunk)
            .execute()
        )
        for row in response.data or []:
            crd = str(row.get("linked_crd") or "")
            if crd:
                # Keep first hit per CRD — coverage is tiny so collisions are rare
                extras.setdefault(crd, row)
    return extras


def resolve_canonical_website(adviser_row: Optional[dict[str, Any]]) -> Optional[str]:
    if not adviser_row or not pick_canonical_domain:
        return None
    primary = adviser_row.get("primary_website")
    other = adviser_row.get("other_websites")
    other_list: list[str] = []
    if isinstance(other, str):
        # Other websites are stored as comma- or semicolon-separated strings
        for delim in (";", ","):
            if delim in other:
                other_list = [s.strip() for s in other.split(delim) if s.strip()]
                break
        else:
            other_list = [other.strip()] if other.strip() else []
    elif isinstance(other, list):
        other_list = [str(s) for s in other if s]
    return pick_canonical_domain(
        adviser_row.get("adviser_name") or "",
        primary,
        other_list,
    )


def _team_members_to_text(value: Any) -> Optional[str]:
    """team_members in enriched_managers is JSONB (list of person dicts).
    Flatten to a readable semicolon-delimited string for CSV use."""
    if not value:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for member in value:
            if isinstance(member, dict):
                name = member.get("name") or ""
                role = member.get("role") or member.get("title") or ""
                if name:
                    parts.append(f"{name} ({role})" if role else name)
                elif role:
                    parts.append(role)
            elif isinstance(member, str):
                parts.append(member)
        return "; ".join(parts) if parts else None
    return str(value)


def build_csv_rows(
    holders: list[dict[str, Any]],
    adviser_details: dict[str, dict[str, Any]],
    enriched_extras: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """One CSV row per holder evidence, joined to adviser firm details +
    enriched_managers extras (LinkedIn, team_members) when available."""
    rows: list[dict[str, Any]] = []
    for h in holders:
        crd = h.get("adviser_crd")
        adv_row = adviser_details.get(str(crd)) if crd else None
        extras = enriched_extras.get(str(crd)) if crd else None
        canonical_site = resolve_canonical_website(adv_row) if adv_row else None
        rows.append({
            "company_slug": h["company_slug"],
            "source_type": h["source_type"],
            "evidence_label": h.get("evidence_label"),
            "evidence_cik": h.get("evidence_cik"),
            "evidence_series_id": h.get("evidence_series_id"),
            "value_usd": h.get("value_usd"),
            "evidence_date": h.get("evidence_date"),
            "accession_number": h.get("accession_number"),
            # Lifecycle-aware labeling (from company_lifecycle_events).
            # 'private', 'public', 'acquired_private', 'acquired_public_parent',
            # or 'unknown' (no event seeded for this company at this date).
            "status_at_evidence_date": h.get("status_at_evidence_date"),
            # Convenience boolean for filtering: True only when the company was
            # explicitly private on the evidence date. False for public/unknown.
            "was_private_at_evidence_date": h.get("was_private_at_evidence_date"),
            "adviser_crd": crd,
            "adviser_resolution_method": h.get("adviser_resolution_method"),
            "adviser_name": adv_row.get("adviser_name") if adv_row else None,
            "adviser_aum": adv_row.get("total_aum") if adv_row else None,
            "adviser_phone": adv_row.get("phone_number") if adv_row else None,
            "adviser_website": canonical_site,
            "adviser_cco_name": adv_row.get("cco_name") if adv_row else None,
            "adviser_cco_email": adv_row.get("cco_email") if adv_row else None,
            "adviser_signatory_name": adv_row.get("signatory_name") if adv_row else None,
            "adviser_signatory_title": adv_row.get("signatory_title") if adv_row else None,
            # Firm principals / owners — the actual decision-makers
            "owner_full_legal_name": adv_row.get("owner_full_legal_name") if adv_row else None,
            "owner_title_or_status": adv_row.get("owner_title_or_status") if adv_row else None,
            "ownership_amount": adv_row.get("ownership_amount") if adv_row else None,
            "control_person_name": adv_row.get("control_person_name") if adv_row else None,
            # Alternative regulatory contact (low coverage, but useful)
            "regulatory_contact_name": adv_row.get("regulatory_contact_name") if adv_row else None,
            "regulatory_contact_email": adv_row.get("regulatory_contact_email") if adv_row else None,
            # Web-enriched extras (sparse — only for CRDs in enriched_managers)
            "linkedin_company_url": (extras or {}).get("linkedin_company_url"),
            "team_members": _team_members_to_text((extras or {}).get("team_members")),
            "alt_contact_email": (extras or {}).get("primary_contact_email"),
            "twitter_handle": (extras or {}).get("twitter_handle"),
            "adviser_form_adv_url": adv_row.get("form_adv_url") if adv_row else None,
        })
    return rows


CSV_COLUMNS = [
    "company_slug",
    "source_type",
    "evidence_label",
    "evidence_cik",
    "evidence_series_id",
    "value_usd",
    "evidence_date",
    "accession_number",
    "status_at_evidence_date",
    "was_private_at_evidence_date",
    "adviser_crd",
    "adviser_resolution_method",
    "adviser_name",
    "adviser_aum",
    "adviser_phone",
    "adviser_website",
    "adviser_cco_name",
    "adviser_cco_email",
    "adviser_signatory_name",
    "adviser_signatory_title",
    "owner_full_legal_name",
    "owner_title_or_status",
    "ownership_amount",
    "control_person_name",
    "regulatory_contact_name",
    "regulatory_contact_email",
    "linkedin_company_url",
    "team_members",
    "alt_contact_email",
    "twitter_handle",
    "adviser_form_adv_url",
]


def write_csv(rows: list[dict[str, Any]], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Produce the fund-holders CSV report for a tracked private company."
    )
    parser.add_argument("--company", required=True, help="Company slug (e.g., anthropic)")
    parser.add_argument(
        "--output",
        default=None,
        help="Output CSV path. Defaults to ./out/{company}_holders_{date}.csv",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    load_credentials()

    nport = create_nport_client()
    adv = create_adv_client()
    formd = create_formd_client()  # may be None — enriched_managers join is optional

    print(f"Fetching holder evidence for {args.company}...")
    holders = fetch_holders(nport, args.company)
    print(f"  {len(holders)} evidence rows")

    if not holders:
        print(
            "  No evidence found. Did you run materialize_holders.py "
            f"--company {args.company} --execute first?"
        )
        return 1

    nport_count = sum(1 for h in holders if h["source_type"] == "nport")
    formd_count = sum(1 for h in holders if h["source_type"] == "formd_pooled_vehicle")
    resolved = sum(1 for h in holders if h.get("adviser_crd"))
    print(f"    N-PORT positions:           {nport_count}")
    print(f"    Form D pooled vehicles:     {formd_count}")
    print(f"    Adviser resolved:           {resolved}/{len(holders)}")

    print("Fetching adviser firm details (advisers_enriched)...")
    crds = [h["adviser_crd"] for h in holders if h.get("adviser_crd")]
    adviser_details = fetch_adviser_details(adv, crds)
    print(f"  {len(adviser_details)} adviser firms found in advisers_enriched")

    print("Fetching enriched_managers extras (LinkedIn, team_members, etc.) ...")
    enriched_extras = fetch_enriched_manager_extras(formd, crds)
    print(f"  {len(enriched_extras)} firms with web-enriched extras")

    csv_rows = build_csv_rows(holders, adviser_details, enriched_extras)

    from datetime import datetime, timezone
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    output_path = (
        Path(args.output)
        if args.output
        else Path(__file__).resolve().parent / "out" / f"{args.company}_holders_{timestamp}.csv"
    )
    write_csv(csv_rows, output_path)
    print(f"\nWrote {len(csv_rows)} rows to {output_path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
