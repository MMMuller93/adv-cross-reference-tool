"""Backfill N-CEN adviser links into the live N-PORT Supabase project.

Default mode is dry-run. ``--execute`` performs live upserts after printing the
planned row counts. The live write path deliberately stores normalized
series-level adviser links in ``fund_ncen_adviser_links`` and only uses the
legacy ``fund_ncen_records`` table as a filing-level summary.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

import requests

from .parser import Adviser, NCenFiling, parse_ncen_xml

PROJECT_ROOT = Path(__file__).resolve().parents[3]
EDGAR_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik10}.json"
EDGAR_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_no_dashes}/primary_doc.xml"
DEFAULT_USER_AGENT = "PrivateFundsRadar Miles mmmuller93@gmail.com"
DEFAULT_SLEEP_SECONDS = 0.12
BATCH_SIZE = 500
READ_CHUNK_SIZE = 100


class NCenBackfillError(RuntimeError):
    """Raised when the backfill cannot safely proceed."""


def _read_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_dotenv(root: Path = PROJECT_ROOT) -> None:
    """Load env from the worktree's .env, and also walk up to find the main
    PFR repo's .env.nport (the canonical location for N-PORT credentials —
    macOS auto-cleans /tmp/ so creds can't live in worktree dirs)."""
    _read_env_file(root / ".env")
    pfr_root = root
    while pfr_root.parent != pfr_root and pfr_root.name != "PrivateFundsRadar":
        pfr_root = pfr_root.parent
    _read_env_file(pfr_root / ".env.nport")


def create_supabase_client():
    load_dotenv()
    url = os.environ.get("SUPABASE_URL_NPORT")
    key = os.environ.get("SUPABASE_SERVICE_KEY_NPORT")
    if not url or not key:
        raise NCenBackfillError(
            "SUPABASE_URL_NPORT and SUPABASE_SERVICE_KEY_NPORT are required"
        )
    try:
        from supabase import create_client  # type: ignore
    except ImportError as exc:
        raise NCenBackfillError(
            "supabase-py is required. Install with: pip install '.[supabase]'"
        ) from exc
    return create_client(url, key)


def cik_variants(cik: str) -> list[str]:
    raw = str(cik or "").strip()
    if not raw:
        return []
    trimmed = raw.lstrip("0") or "0"
    padded = trimmed.zfill(10)
    return list(dict.fromkeys([raw, trimmed, padded]))


def cik10(cik: str) -> str:
    return (str(cik or "").strip().lstrip("0") or "0").zfill(10)


def normalize_crd(crd: Optional[str]) -> Optional[str]:
    if crd is None:
        return None
    text = str(crd).strip()
    if not text or text.upper() == "N/A":
        return None
    if text.isdigit():
        return text.lstrip("0") or "0"
    return text


def clean_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def link_key(accession: str, role: str, adviser: Adviser) -> str:
    identity = (
        normalize_crd(adviser.crd)
        or clean_text(adviser.lei)
        or clean_text(adviser.name)
        or "unknown"
    )
    return "|".join(
        [
            accession,
            role,
            clean_text(adviser.series_id) or "",
            clean_text(identity) or "unknown",
            clean_text(adviser.name) or "",
        ]
    )


def latest_ncen_metadata(payload: dict[str, Any]) -> Optional[dict[str, Any]]:
    recent = payload.get("filings", {}).get("recent", {})
    forms = recent.get("form") or []
    for index, form in enumerate(forms):
        if form not in {"N-CEN", "N-CEN/A"}:
            continue
        return {
            "form": form,
            "filing_date": (recent.get("filingDate") or [None])[index],
            "report_date": (recent.get("reportDate") or [None])[index],
            "accession_number": (recent.get("accessionNumber") or [None])[index],
            "primary_document": (recent.get("primaryDocument") or [None])[index],
        }
    return None


_RETRY_DELAYS = (2, 4, 8, 16)  # seconds; exponential backoff
_RETRY_AFTER_MAX = 60  # seconds; cap honoring of large Retry-After values


def _fetch_with_retry(
    session: requests.Session,
    url: str,
    *,
    headers: dict[str, str],
    timeout: int,
    max_retries: int = 4,
) -> requests.Response:
    """GET with exponential backoff on 429, 5xx (including 503), and connection errors.

    On 429, honors Retry-After header but CAPS it at _RETRY_AFTER_MAX (60s) to
    prevent a hostile or malformed header from freezing the run. After max_retries,
    returns the final Response (caller should raise_for_status or check explicitly).
    """
    response: Optional[requests.Response] = None
    for attempt in range(max_retries + 1):
        try:
            response = session.get(url, headers=headers, timeout=timeout)
        except (requests.ConnectionError, requests.Timeout):
            if attempt >= max_retries:
                raise
            time.sleep(_RETRY_DELAYS[attempt])
            continue
        if response.status_code == 429:
            if attempt >= max_retries:
                return response  # caller will raise_for_status
            retry_after_raw = response.headers.get("Retry-After")
            if retry_after_raw and retry_after_raw.isdigit():
                # Honor Retry-After but cap to prevent hour-long sleeps on
                # malformed/hostile headers (witness audit MEDIUM finding).
                sleep_for = min(
                    max(int(retry_after_raw), _RETRY_DELAYS[attempt]),
                    _RETRY_AFTER_MAX,
                )
            else:
                sleep_for = _RETRY_DELAYS[attempt]
            print(f"  429 from SEC at {url[:80]} — retrying in {sleep_for}s (attempt {attempt + 1}/{max_retries})")
            time.sleep(sleep_for)
            continue
        if response.status_code >= 500:
            if attempt >= max_retries:
                return response
            print(f"  {response.status_code} from SEC at {url[:80]} — retrying in {_RETRY_DELAYS[attempt]}s")
            time.sleep(_RETRY_DELAYS[attempt])
            continue
        return response
    # Should be unreachable, but mypy needs the explicit return
    assert response is not None
    return response


def fetch_latest_ncen(
    cik: str,
    *,
    session: requests.Session,
    headers: dict[str, str],
    sleep_seconds: float,
) -> Optional[tuple[dict[str, Any], NCenFiling, str]]:
    padded = cik10(cik)
    time.sleep(sleep_seconds)
    submissions = _fetch_with_retry(
        session,
        EDGAR_SUBMISSIONS_URL.format(cik10=padded),
        headers=headers,
        timeout=30,
    )
    if submissions.status_code == 404:
        return None
    submissions.raise_for_status()
    metadata = latest_ncen_metadata(submissions.json())
    if not metadata:
        return None
    accession = metadata["accession_number"]
    if not accession:
        return None
    url = EDGAR_ARCHIVES_URL.format(
        cik_int=int(padded),
        acc_no_dashes=str(accession).replace("-", ""),
    )
    time.sleep(sleep_seconds)
    doc = _fetch_with_retry(session, url, headers=headers, timeout=90)
    doc.raise_for_status()
    return metadata, parse_ncen_xml(doc.content), url


def shape_summary_row(
    cik: str,
    metadata: dict[str, Any],
    filing: NCenFiling,
) -> dict[str, Any]:
    primary = filing.investment_adviser_links[0] if filing.investment_adviser_links else None
    sub_names = "; ".join(
        a.name for a in filing.sub_advisers if a.name
    ) or None
    sub_crds = "; ".join(
        normalize_crd(a.crd) for a in filing.sub_advisers if normalize_crd(a.crd)
    ) or None
    sub_leis = "; ".join(a.lei for a in filing.sub_advisers if a.lei) or None
    return {
        "accession_number": metadata["accession_number"],
        "registrant_cik": cik10(filing.registrant_cik or cik),
        "series_id": None,
        "fiscal_year_end": filing.report_period_end or metadata.get("report_date"),
        "filing_date": metadata["filing_date"],
        "investment_adviser_name": primary.name if primary else None,
        "investment_adviser_crd": normalize_crd(primary.crd) if primary else None,
        "investment_adviser_lei": primary.lei if primary else None,
        "subadviser_name": sub_names,
        "subadviser_crd": sub_crds,
        "subadviser_lei": sub_leis,
        "fund_type": filing.investment_company_type,
        "is_etf": None,
        "is_money_market": None,
    }


def shape_link_rows(
    cik: str,
    metadata: dict[str, Any],
    filing: NCenFiling,
    source_url: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    accession = metadata["accession_number"]
    for role, advisers in (
        ("investment_adviser", filing.investment_adviser_links),
        ("subadviser", filing.sub_adviser_links),
    ):
        for adviser in advisers:
            rows.append(
                {
                    "link_key": link_key(accession, role, adviser),
                    "accession_number": accession,
                    "registrant_cik": cik10(filing.registrant_cik or cik),
                    "series_id": adviser.series_id,
                    "series_name": adviser.series_name,
                    "series_lei": adviser.series_lei,
                    "filing_date": metadata["filing_date"],
                    "fiscal_year_end": filing.report_period_end or metadata.get("report_date"),
                    "adviser_role": role,
                    "adviser_name": adviser.name,
                    "adviser_crd_raw": adviser.crd,
                    "adviser_crd_normalized": normalize_crd(adviser.crd),
                    "adviser_lei": adviser.lei,
                    "adviser_file_no": adviser.file_no,
                    "adviser_rssd_id": adviser.rssd_id,
                    "adviser_country": adviser.country,
                    "adviser_state": adviser.state,
                    "is_affiliated": adviser.is_affiliated,
                    "fund_type": filing.investment_company_type,
                    "source_url": source_url,
                }
            )
    return rows


def chunks(rows: list[dict[str, Any]], size: int = BATCH_SIZE) -> Iterable[list[dict[str, Any]]]:
    for index in range(0, len(rows), size):
        yield rows[index : index + size]


def count_relation(client, table: str, column: str = "*", *, filters: Optional[dict[str, Any]] = None) -> int:
    query = client.table(table).select(column, count="exact").limit(1)
    for key, value in (filters or {}).items():
        if value is None:
            query = query.is_(key, "null")
        else:
            query = query.eq(key, value)
    response = query.execute()
    return int(response.count or 0)


def count_relation_not_null(client, table: str, column: str) -> int:
    response = (
        client.table(table)
        .select(column, count="exact")
        .not_.is_(column, "null")
        .limit(1)
        .execute()
    )
    return int(response.count or 0)


def safe_count_relation(client, table: str) -> int:
    try:
        return count_relation(client, table)
    except Exception:  # noqa: BLE001 - dry-runs should still reveal planned rows
        return -1


def snapshot_counts(client) -> dict[str, int]:
    return {
        "fund_ncen_records": count_relation(client, "fund_ncen_records"),
        "fund_ncen_adviser_links": safe_count_relation(client, "fund_ncen_adviser_links"),
        "nport_registrants": count_relation(client, "nport_registrants"),
        "nport_registrants_adv_crd": count_relation_not_null(
            client, "nport_registrants", "adv_crd"
        ),
    }


def get_company_ciks(client, slug: str, *, limit: Optional[int] = None) -> list[str]:
    ciks: list[str] = []
    seen: set[str] = set()
    last_holding_id = 0
    while True:
        query = (
            client.table("nport_company_positions_mv")
            .select("holding_id_internal,registrant_cik")
            .eq("company_slug", slug)
            .order("holding_id_internal")
            .limit(1000)
        )
        if last_holding_id:
            query = query.gt("holding_id_internal", last_holding_id)
        response = query.execute()
        batch = response.data or []
        for row in batch:
            last_holding_id = int(row.get("holding_id_internal") or last_holding_id)
            cik = clean_text(row.get("registrant_cik"))
            if cik and cik not in seen:
                seen.add(cik)
                ciks.append(cik)
                if limit and len(ciks) >= limit:
                    return ciks
        if len(batch) < 1000:
            break
    return ciks


def get_registrant_ciks(client, *, limit: Optional[int] = None, only_missing: bool = True) -> list[str]:
    ciks: list[str] = []
    last_cik = ""
    while True:
        query = (
            client.table("nport_registrants")
            .select("cik,adv_crd")
            .order("cik")
            .limit(1000)
        )
        if last_cik:
            query = query.gt("cik", last_cik)
        response = query.execute()
        batch = response.data or []
        for row in batch:
            last_cik = str(row["cik"])
            if only_missing and row.get("adv_crd"):
                continue
            ciks.append(str(row["cik"]))
            if limit and len(ciks) >= limit:
                return ciks
        if len(batch) < 1000:
            break
    return ciks


def existing_link_accessions(client, accessions: Iterable[str]) -> set[str]:
    values = sorted({str(a) for a in accessions if a})
    found: set[str] = set()
    for index in range(0, len(values), READ_CHUNK_SIZE):
        chunk = values[index : index + READ_CHUNK_SIZE]
        response = (
            client.table("fund_ncen_adviser_links")
            .select("accession_number")
            .in_("accession_number", chunk)
            .limit(1000)
            .execute()
        )
        for row in response.data or []:
            if row.get("accession_number"):
                found.add(str(row["accession_number"]))
    return found


def backup_registrants(client, ciks: list[str], path: Path) -> int:
    rows: list[dict[str, Any]] = []
    for index in range(0, len(ciks), READ_CHUNK_SIZE):
        variants: list[str] = []
        for cik in ciks[index : index + READ_CHUNK_SIZE]:
            variants.extend(cik_variants(cik))
        response = (
            client.table("nport_registrants")
            .select("*")
            .in_("cik", list(dict.fromkeys(variants)))
            .execute()
        )
        rows.extend(response.data or [])
    payload = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "row_count": len(rows),
        "rows": rows,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, default=str))
    return len(rows)


def upsert_batches(client, table: str, rows: list[dict[str, Any]], on_conflict: str) -> int:
    total = 0
    for batch in chunks(rows):
        first_keys = set(batch[0].keys())
        if any(set(row.keys()) != first_keys for row in batch):
            raise NCenBackfillError(f"{table} batch has inconsistent row keys")
        client.table(table).upsert(batch, on_conflict=on_conflict).execute()
        total += len(batch)
    return total


# NOTE: The registrant-level adviser cache (`nport_registrants.adv_crd`) is
# resolved by the companion script `reconcile_live.py`, NOT here. This script
# is now pure ingest: it scrapes SEC EDGAR and writes raw N-CEN records and
# series-level adviser links. Resolution + validation + writes to the
# registrant cache happen in the reconciliation phase, where they can be
# re-run independently of the (slow) scrape.


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill live N-CEN adviser links")
    parser.add_argument("--cik", action="append", default=[], help="CIK to ingest; can repeat")
    parser.add_argument("--company-slug", help="Restrict to holders for a company slug")
    parser.add_argument("--limit", type=int, help="Maximum CIKs to process")
    parser.add_argument("--include-existing", action="store_true", help="Do not skip registrants with adv_crd already set")
    parser.add_argument("--execute", action="store_true", help="Perform live writes")
    parser.add_argument("--sleep", type=float, default=DEFAULT_SLEEP_SECONDS)
    parser.add_argument("--user-agent", default=os.environ.get("SEC_USER_AGENT", DEFAULT_USER_AGENT))
    parser.add_argument(
        "--backup-path",
        default=f"/tmp/nport_ncen_registrants_backup_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json",
    )
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=100,
        help="In --execute mode, flush accumulated rows to Supabase every N CIKs (default 100, 0 disables checkpointing)",
    )
    return parser.parse_args(argv)


def _flush_batch(
    client,
    summary_rows: list[dict[str, Any]],
    link_rows: list[dict[str, Any]],
) -> None:
    """Upsert accumulated raw N-CEN records + series-level adviser links.

    No registrant-level adv_crd writes here — that's reconcile_live.py's job.
    """
    if summary_rows:
        upsert_batches(client, "fund_ncen_records", summary_rows, "accession_number")
    if link_rows:
        upsert_batches(client, "fund_ncen_adviser_links", link_rows, "link_key")


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    client = create_supabase_client()
    before = snapshot_counts(client)
    print("Before counts:", json.dumps(before, sort_keys=True))

    if args.cik:
        ciks = args.cik
    elif args.company_slug:
        ciks = get_company_ciks(client, args.company_slug, limit=args.limit)
    else:
        ciks = get_registrant_ciks(
            client,
            limit=args.limit,
            only_missing=not args.include_existing,
        )
    ciks = list(dict.fromkeys(ciks))
    if args.limit:
        ciks = ciks[: args.limit]
    print(f"Target CIKs: {len(ciks)}")
    if not ciks:
        return 0

    # Backup upfront when executing — protects against mid-run crashes that would
    # otherwise leave the DB in a partial state after the first checkpoint flush.
    if args.execute:
        backup_count = backup_registrants(client, ciks, Path(args.backup_path))
        print(f"Backed up {backup_count} registrant rows to {args.backup_path}")

    headers = {"User-Agent": args.user_agent}
    session = requests.Session()
    summary_rows: list[dict[str, Any]] = []
    link_rows: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    skipped_no_ncen = 0
    flushes = 0
    fetched_total = 0  # total summary rows produced (across all flushes)
    links_total = 0    # total link rows produced (across all flushes)

    def _maybe_checkpoint(at_index: int, *, force: bool = False) -> None:
        nonlocal summary_rows, link_rows, flushes
        if not args.execute:
            return
        if not (summary_rows or link_rows):
            return
        if not force:
            if not args.checkpoint_every:
                return
            if at_index % args.checkpoint_every != 0:
                return
        _flush_batch(client, summary_rows, link_rows)
        flushes += 1
        label = "Final flush" if force else f"Checkpoint #{flushes}"
        print(
            f"  {label} at CIK {at_index}: flushed {len(summary_rows)} summaries, "
            f"{len(link_rows)} links"
        )
        summary_rows = []
        link_rows = []

    for index, cik in enumerate(ciks, 1):
        try:
            fetched = fetch_latest_ncen(
                cik,
                session=session,
                headers=headers,
                sleep_seconds=args.sleep,
            )
            if fetched is None:
                skipped_no_ncen += 1
            else:
                metadata, filing, source_url = fetched
                new_links = shape_link_rows(cik, metadata, filing, source_url)
                summary_rows.append(shape_summary_row(cik, metadata, filing))
                link_rows.extend(new_links)
                fetched_total += 1
                links_total += len(new_links)
        except Exception as exc:  # noqa: BLE001 - preserve per-CIK failures
            failures.append({"cik": str(cik), "error": str(exc)})

        if index % 25 == 0:
            print(f"Fetched {index}/{len(ciks)} CIKs...")

        # Checkpoint flush every N CIKs (only in --execute mode)
        _maybe_checkpoint(index)

    # Pre-summary print (rows pending in current buffer + cumulative)
    print(
        "Run summary:",
        json.dumps(
            {
                "ciks_processed": len(ciks),
                "summary_rows_pending": len(summary_rows),
                "link_rows_pending": len(link_rows),
                "summary_rows_total": fetched_total,
                "link_rows_total": links_total,
                "skipped_no_ncen": skipped_no_ncen,
                "failures": len(failures),
                "flushes_so_far": flushes,
            },
            sort_keys=True,
        ),
    )
    if failures[:5]:
        print("Sample failures:", json.dumps(failures[:5], indent=2))
    if summary_rows[:2]:
        print("Sample pending summary:", json.dumps(summary_rows[:2], indent=2, default=str))
    if link_rows[:3]:
        print("Sample pending links:", json.dumps(link_rows[:3], indent=2, default=str))

    # Failure-rate guard: if more than 5% of CIKs failed, the run did not
    # succeed even if it completed. This prevents "exit 0 with hundreds of
    # silent failures" (Codex bug A).
    failure_rate = (len(failures) / len(ciks)) if ciks else 0
    failure_threshold = 0.05
    if failure_rate > failure_threshold:
        print(
            f"\nFAILURE: {len(failures)}/{len(ciks)} CIKs failed "
            f"({failure_rate:.1%} > {failure_threshold:.0%} threshold). "
            f"Run did NOT complete cleanly. Inspect failures and re-run "
            f"the failed CIKs.",
            file=sys.stderr,
        )
        return 1

    if not args.execute:
        print("Dry run only. Re-run with --execute after reviewing planned rows.")
        print(
            "\nAfter execute, run `python -m nport.enrichment.ncen_ingest.reconcile_live "
            "--execute` to populate nport_registrants.adv_crd from the ingested data."
        )
        return 0

    # Final flush for any rows accumulated since the last checkpoint
    _maybe_checkpoint(len(ciks), force=True)

    after = snapshot_counts(client)
    print("After counts:", json.dumps(after, sort_keys=True))
    print(
        f"\nIngest complete: {fetched_total} N-CEN records + {links_total} "
        f"adviser links written across {flushes} flushes."
    )
    print(
        "\nNow run `python -m nport.enrichment.ncen_ingest.reconcile_live "
        "--execute` to update nport_registrants.adv_crd from the ingested data."
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
