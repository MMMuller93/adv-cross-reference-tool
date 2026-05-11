"""Historical bulk N-PORT backfill.

Per PLAN_NPORT_HOLDINGS.md §6.1: download SEC quarterly bulk ZIPs for
2019 Q4 -> 2026 Q1, extract the five TSVs we care about, stage in SQLite
to keep memory bounded over the 5.9M-row holdings table, apply the F4
filter, resolve entities via the resolver module, and upsert in 500-row
batches to Supabase (currently stubbed to JSONL via db_client.py).

Usage:
    python backfill_bulk.py --quarter 2026q1
    python backfill_bulk.py --start 2019q4 --end 2026q1
    python backfill_bulk.py --quarter 2026q1 --dry-run

`--dry-run` does the HEAD check and prints the URL but does not download.
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import shutil
import sqlite3
import sys
import zipfile
from contextlib import closing
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

from .config import (
    BACKFILL_END,
    BACKFILL_START,
    NPORT_STAGING_DIR,
    SEC_BULK_NPORT_URL_FMT,
    UPSERT_BATCH_SIZE,
)
from .db_client import DBClient
from .filter_f4 import confidence_tag, filter_rows
from .sec_client import SECClient

# CSV's default field size limit can be exceeded by N-PORT's large rows.
csv.field_size_limit(min(2**31 - 1, sys.maxsize))


# -----------------------------------------------------------------------------
# Expected TSV headers — used by the year-boundary validation (per §10 risk #15)
# -----------------------------------------------------------------------------
EXPECTED_HOLDING_COLUMNS: List[str] = [
    "ACCESSION_NUMBER",
    "HOLDING_ID",
    "ISSUER_NAME",
    "ISSUER_LEI",
    "ISSUER_TITLE",
    "ISSUER_CUSIP",
    "BALANCE",
    "UNIT",
    "OTHER_UNIT_DESC",
    "CURRENCY_CODE",
    "CURRENCY_VALUE",
    "EXCHANGE_RATE",
    "PERCENTAGE",
    "PAYOFF_PROFILE",
    "ASSET_CAT",
    "OTHER_ASSET",
    "ISSUER_TYPE",
    "OTHER_ISSUER",
    "INVESTMENT_COUNTRY",
    "IS_RESTRICTED_SECURITY",
    "FAIR_VALUE_LEVEL",
    "DERIVATIVE_CAT",
]

REQUIRED_FILES: List[str] = [
    "FUND_REPORTED_HOLDING.tsv",
    "REGISTRANT.tsv",
    "FUND_REPORTED_INFO.tsv",
    "SUBMISSION.tsv",
    "IDENTIFIERS.tsv",
]


# -----------------------------------------------------------------------------
# Resolver bootstrap — Bug 2 fix
# -----------------------------------------------------------------------------
def _build_seed_resolver():
    """Construct a Resolver wired to the bundled seed alias file.

    Fails loudly if the seed file is missing — the previous soft-fail
    silently produced a pass-through resolver that disabled all entity
    resolution. Per the fix spec we want a clear FileNotFoundError instead.
    """
    from nport.resolver import Resolver, load_seed_aliases

    aliases = load_seed_aliases()  # raises FileNotFoundError if missing
    if not aliases:
        raise RuntimeError(
            "Resolver seed file loaded but yielded zero aliases — "
            "refusing to start scraper with a silently-empty resolver."
        )
    return Resolver(aliases=aliases, identifiers_lookup=None)


# -----------------------------------------------------------------------------
# Quarter iteration
# -----------------------------------------------------------------------------
def parse_quarter(qstr: str) -> Tuple[int, int]:
    """Parse 'YYYYqQ' (e.g. '2026q1') into (year, q). Raise ValueError on bad input."""
    s = qstr.strip().lower()
    if "q" not in s:
        raise ValueError(f"bad quarter format: {qstr!r}")
    y, q = s.split("q", 1)
    return int(y), int(q)


def iter_quarters(start: Tuple[int, int], end: Tuple[int, int]):
    """Yield (year, q) pairs inclusive on both ends, in chronological order."""
    y, q = start
    ye, qe = end
    while (y, q) <= (ye, qe):
        yield y, q
        q += 1
        if q > 4:
            q = 1
            y += 1


# -----------------------------------------------------------------------------
# Schema validation
# -----------------------------------------------------------------------------
class SchemaMismatch(RuntimeError):
    """Raised when a TSV header doesn't match the expected schema.

    Per §10 risk #15: 2022 Q1 had a column-schema change. The bulk loader
    MUST fail loud at the year boundary so the operator deliberately adds
    any new column to the schema.
    """


def validate_tsv_header(
    actual: List[str],
    expected: List[str],
    filename: str,
) -> None:
    """Strict equality check on header order and content."""
    actual_norm = [c.strip().upper() for c in actual]
    expected_norm = [c.strip().upper() for c in expected]
    if actual_norm == expected_norm:
        return
    new_cols = [c for c in actual_norm if c not in expected_norm]
    missing_cols = [c for c in expected_norm if c not in actual_norm]
    msg = (
        f"TSV schema mismatch in {filename}.\n"
        f"  Expected: {expected_norm}\n"
        f"  Actual:   {actual_norm}\n"
    )
    if new_cols:
        msg += f"  New columns (add to schema deliberately): {new_cols}\n"
    if missing_cols:
        msg += f"  Missing columns: {missing_cols}\n"
    raise SchemaMismatch(msg)


# -----------------------------------------------------------------------------
# Backfill orchestrator
# -----------------------------------------------------------------------------
class BulkBackfiller:
    def __init__(
        self,
        sec_client: Optional[SECClient] = None,
        db_client: Optional[DBClient] = None,
        staging_dir: Path = NPORT_STAGING_DIR,
        aliases_cache: Optional[Set[str]] = None,
        resolver=None,
    ):
        self.sec = sec_client or SECClient()
        self.db = db_client or DBClient()
        self.staging_dir = Path(staging_dir)
        self.staging_dir.mkdir(parents=True, exist_ok=True)
        self.aliases_cache = aliases_cache or set()
        # Resolver is constructed at bootstrap (Bug 2 fix): we MUST pass real
        # aliases from `nport.resolver.aliases_seed.json` — the previous
        # soft-fail produced a pass-through resolver in production that
        # silently disabled entity resolution. If an explicit resolver is
        # injected (tests / db-backed), use that; otherwise build one from
        # the bundled seed and fail loud if anything goes wrong.
        if resolver is None:
            resolver = _build_seed_resolver()
        self._resolver = resolver

    def _get_resolver(self):
        return self._resolver

    # -- Per-quarter pipeline ------------------------------------------------
    def run_quarter(self, year: int, q: int, dry_run: bool = False) -> Dict[str, int]:
        """Run the full pipeline for one quarter. Returns row-count stats."""
        url = SEC_BULK_NPORT_URL_FMT.format(year=year, q=q)
        print(f"[{year}Q{q}] HEAD {url}")
        head = self.sec.head(url)
        if head.status_code != 200:
            print(
                f"[{year}Q{q}] HEAD returned {head.status_code} — "
                "SEC may not have published this quarter yet"
            )
            return {"skipped": 1}

        if dry_run:
            print(f"[{year}Q{q}] dry-run: HEAD OK, skipping download")
            return {"head_ok": 1}

        zip_path = self.staging_dir / f"{year}q{q}_nport.zip"
        sqlite_path = self.staging_dir / f"{year}q{q}.sqlite"
        try:
            print(f"[{year}Q{q}] downloading -> {zip_path}")
            self.sec.download(url, zip_path)

            print(f"[{year}Q{q}] extracting required TSVs")
            extract_dir = self.staging_dir / f"{year}q{q}_extracted"
            self._extract_required(zip_path, extract_dir)

            print(f"[{year}Q{q}] validating headers")
            self._validate_headers(extract_dir)

            print(f"[{year}Q{q}] loading TSVs into SQLite -> {sqlite_path}")
            stats = self._load_to_sqlite(extract_dir, sqlite_path)

            print(f"[{year}Q{q}] applying F4 filter + resolving + upserting")
            stats.update(self._filter_resolve_upsert(sqlite_path, year, q))
            return stats
        finally:
            # Critical: clean up eagerly. Disk budget per §6.1 / §10 risk #1.
            for p in (zip_path, sqlite_path):
                if p.exists():
                    try:
                        p.unlink()
                    except OSError as exc:
                        print(f"  [cleanup] could not remove {p}: {exc}")
            ed = self.staging_dir / f"{year}q{q}_extracted"
            if ed.exists():
                shutil.rmtree(ed, ignore_errors=True)

    # -- Steps ---------------------------------------------------------------
    def _extract_required(self, zip_path: Path, extract_dir: Path) -> None:
        """Extract only the five TSVs we care about. Skip derivatives etc."""
        extract_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path) as zf:
            members = {m.filename for m in zf.infolist()}
            missing = [n for n in REQUIRED_FILES if n not in members]
            if missing:
                raise FileNotFoundError(
                    f"ZIP {zip_path.name} missing required files: {missing}"
                )
            for name in REQUIRED_FILES:
                zf.extract(name, extract_dir)

    def _validate_headers(self, extract_dir: Path) -> None:
        """Per §10 risk #15 — fail loud on column changes at year boundaries.

        Only validate FUND_REPORTED_HOLDING.tsv for now; other tables have
        smaller, more stable schemas. Add more validators here as needed.
        """
        path = extract_dir / "FUND_REPORTED_HOLDING.tsv"
        with open(path, "r", encoding="utf-8", newline="") as fh:
            reader = csv.reader(fh, delimiter="\t")
            header = next(reader)
        validate_tsv_header(
            header,
            EXPECTED_HOLDING_COLUMNS,
            "FUND_REPORTED_HOLDING.tsv",
        )

    def _load_to_sqlite(self, extract_dir: Path, sqlite_path: Path) -> Dict[str, int]:
        """Stream TSV rows into SQLite staging. Memory stays flat regardless
        of input size — SQLite handles the 5.9M-row holdings table fine.
        """
        stats: Dict[str, int] = {}
        if sqlite_path.exists():
            sqlite_path.unlink()
        conn = sqlite3.connect(sqlite_path)
        try:
            # Tuning: bulk-load mode (no journaling). Safe because this DB is
            # a throwaway — we cleanup at the end of run_quarter().
            conn.execute("PRAGMA journal_mode = OFF")
            conn.execute("PRAGMA synchronous = OFF")
            conn.execute("PRAGMA temp_store = MEMORY")

            stats["holdings"] = _stream_tsv_to_table(
                conn,
                extract_dir / "FUND_REPORTED_HOLDING.tsv",
                "holdings",
                EXPECTED_HOLDING_COLUMNS,
            )
            # Smaller, less schema-volatile tables — load whatever columns
            # exist without strict validation.
            for fname, table in (
                ("REGISTRANT.tsv", "registrants"),
                ("FUND_REPORTED_INFO.tsv", "fund_info"),
                ("SUBMISSION.tsv", "submissions"),
            ):
                stats[table] = _stream_tsv_to_table(
                    conn,
                    extract_dir / fname,
                    table,
                    columns=None,
                )
            conn.commit()
        finally:
            conn.close()
        return stats

    def _filter_resolve_upsert(
        self, sqlite_path: Path, year: int, q: int
    ) -> Dict[str, int]:
        """Read holdings out of SQLite, filter via F4, resolve, upsert."""
        resolver = self._get_resolver()
        kept = 0
        batch: List[Dict] = []
        with closing(sqlite3.connect(sqlite_path)) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.execute("SELECT * FROM holdings")
            normalized_rows = (
                _normalize_holding_tsv_row(dict(row)) for row in cur
            )
            for row, conf in filter_rows(normalized_rows, self.aliases_cache):
                row["confidence"] = conf
                row["bulk_quarter"] = f"{year}Q{q}"
                resolved = resolver.resolve(row)
                # Bug 3 fix: merge resolver output into the raw row so the
                # holding's raw fields (balance, currency_value, issuer_name,
                # ...) survive alongside the resolver-added fields
                # (resolved_company_id, resolution_source, ...).
                batch.append({**row, **resolved})
                if len(batch) >= UPSERT_BATCH_SIZE:
                    self.db.upsert_holding(batch)
                    kept += len(batch)
                    batch = []
            if batch:
                self.db.upsert_holding(batch)
                kept += len(batch)

            # Registrants — dedupe to one row per CIK across the quarter.
            # The TSV has one row per accession; the schema models registrants
            # as per-CIK entities (UNIQUE (cik)). We collapse to the last
            # row seen for each CIK and stamp `last_filed_at` so callers can
            # know when this CIK last filed.
            #
            # Also try to surface a filing-date column from the SUBMISSION
            # table so `last_filed_at` is set; fall back to NULL if absent.
            sub_date_by_acc: Dict[str, Optional[str]] = {}
            try:
                for sub in conn.execute(
                    'SELECT accession_number, filing_date FROM submissions'
                ):
                    acc = (sub["accession_number"] or "").strip() if isinstance(sub, sqlite3.Row) else None
                    fd = (sub["filing_date"] or "").strip() if isinstance(sub, sqlite3.Row) else None
                    if acc:
                        sub_date_by_acc[acc] = fd or None
            except sqlite3.OperationalError:
                pass  # submissions table missing or schema-shifted; skip.

            by_cik: Dict[str, Dict[str, Any]] = {}
            for row in conn.execute("SELECT * FROM registrants"):
                d = _normalize_keys(dict(row))
                cik = (d.get("cik") or "").strip()
                if not cik:
                    continue
                # Map TSV columns to schema columns. The TSV uses
                # REGISTRANT_NAME / ADDRESS_1 / etc. — normalize to the
                # nport_registrants columns from §4.1.
                mapped = _registrant_row_for_db(d)
                acc = d.get("accession_number")
                mapped["last_filed_at"] = sub_date_by_acc.get(acc) if acc else None
                # Last write wins — keep the most recent record for this CIK.
                by_cik[cik] = mapped

            reg_count = 0
            for cik, mapped in by_cik.items():
                self.db.upsert_registrant(mapped)
                reg_count += 1
        return {"holdings_kept": kept, "registrants": reg_count}


# -----------------------------------------------------------------------------
# TSV helpers
# -----------------------------------------------------------------------------
def _stream_tsv_to_table(
    conn: sqlite3.Connection,
    tsv_path: Path,
    table: str,
    columns: Optional[List[str]],
    batch_size: int = 10_000,
) -> int:
    """Stream a TSV into a SQLite table. Returns row count.

    If `columns` is given, the schema is fixed and the header is validated
    earlier. Otherwise, the header line itself defines the columns.
    """
    with open(tsv_path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh, delimiter="\t")
        header = next(reader)
        cols = columns or [c.strip().upper() for c in header]
        col_defs = ", ".join(f'"{c.lower()}" TEXT' for c in cols)
        conn.execute(f'CREATE TABLE "{table}" ({col_defs})')
        placeholders = ",".join(["?"] * len(cols))
        insert_sql = (
            f'INSERT INTO "{table}" '
            f'({", ".join(f"\"{c.lower()}\"" for c in cols)}) '
            f"VALUES ({placeholders})"
        )

        rows_buffer: List[List[str]] = []
        total = 0
        for row in reader:
            if len(row) < len(cols):
                row = row + [""] * (len(cols) - len(row))
            elif len(row) > len(cols):
                row = row[: len(cols)]
            rows_buffer.append(row)
            if len(rows_buffer) >= batch_size:
                conn.executemany(insert_sql, rows_buffer)
                total += len(rows_buffer)
                rows_buffer.clear()
        if rows_buffer:
            conn.executemany(insert_sql, rows_buffer)
            total += len(rows_buffer)
    return total


def _registrant_row_for_db(row: Dict[str, Optional[str]]) -> Dict[str, Optional[str]]:
    """Map a REGISTRANT.tsv row (lowercased keys) to nport_registrants columns.

    The SEC TSV uses columns like REGISTRANT_NAME / ADDRESS1 / CITY; the
    schema in 001_create_schema.sql uses `name` / `address_street1` /
    `address_city`. This is a thin shim so the db_client passes a row
    shape that Postgres accepts directly.
    """
    return {
        "cik": row.get("cik"),
        "name": row.get("registrant_name") or row.get("name"),
        "lei": row.get("lei"),
        "address_street1": row.get("address1") or row.get("address_street1"),
        "address_street2": row.get("address2") or row.get("address_street2"),
        "address_city": row.get("city") or row.get("address_city"),
        "address_state": row.get("state") or row.get("address_state"),
        "address_zip": row.get("zip") or row.get("address_zip"),
        "address_country": row.get("country") or row.get("address_country"),
        "phone": row.get("phone"),
    }


def _normalize_keys(row: Dict[str, str]) -> Dict[str, Optional[str]]:
    """Lowercase keys, convert empty strings & 'N/A' to None."""
    out: Dict[str, Optional[str]] = {}
    for k, v in row.items():
        kl = k.lower()
        if v is None:
            out[kl] = None
            continue
        s = v.strip() if isinstance(v, str) else v
        if s in ("", "N/A"):
            out[kl] = None
        else:
            out[kl] = s
    return out


def _normalize_holding_tsv_row(row: Dict[str, str]) -> Dict[str, Optional[str]]:
    """Map TSV column names to the schema field names used by filter_f4."""
    row = _normalize_keys(row)
    return {
        "accession_number": row.get("accession_number"),
        "holding_id": row.get("holding_id"),
        "issuer_name": row.get("issuer_name"),
        "issuer_lei": row.get("issuer_lei"),
        "issuer_title": row.get("issuer_title"),
        "cusip": row.get("issuer_cusip"),
        "balance": row.get("balance"),
        "unit": row.get("unit"),
        "currency_code": row.get("currency_code"),
        "currency_value": row.get("currency_value"),
        "exchange_rate": row.get("exchange_rate"),
        "percentage": row.get("percentage"),
        "payoff_profile": row.get("payoff_profile"),
        "asset_cat": row.get("asset_cat"),
        "issuer_type": row.get("issuer_type"),
        "investment_country": row.get("investment_country"),
        "is_restricted": row.get("is_restricted_security"),
        "fair_value_level": row.get("fair_value_level"),
        "derivative_cat": row.get("derivative_cat"),
    }


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------
def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="N-PORT bulk historical backfill")
    p.add_argument(
        "--quarter",
        help="Single quarter to load, e.g. 2026q1 (mutually exclusive with --start/--end)",
    )
    p.add_argument(
        "--start",
        help=f"Start quarter (inclusive), default {BACKFILL_START[0]}q{BACKFILL_START[1]}",
    )
    p.add_argument(
        "--end",
        help=f"End quarter (inclusive), default {BACKFILL_END[0]}q{BACKFILL_END[1]}",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="HEAD-check each quarter URL but don't download or process",
    )
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = _parse_args(argv)
    if args.quarter and (args.start or args.end):
        print("ERROR: --quarter is mutually exclusive with --start/--end", file=sys.stderr)
        return 2
    if args.quarter:
        y, q = parse_quarter(args.quarter)
        quarters = [(y, q)]
    else:
        start = parse_quarter(args.start) if args.start else BACKFILL_START
        end = parse_quarter(args.end) if args.end else BACKFILL_END
        quarters = list(iter_quarters(start, end))

    backfiller = BulkBackfiller()
    for y, q in quarters:
        try:
            stats = backfiller.run_quarter(y, q, dry_run=args.dry_run)
            print(f"[{y}Q{q}] stats: {stats}")
        except SchemaMismatch as exc:
            print(f"[{y}Q{q}] SCHEMA MISMATCH -- aborting batch:\n{exc}", file=sys.stderr)
            return 3
        except Exception as exc:  # noqa: BLE001
            print(f"[{y}Q{q}] error: {exc}", file=sys.stderr)
            # Continue to the next quarter — one bad quarter shouldn't kill
            # a multi-year backfill. The operator can re-run the failed one.
            continue
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
