"""Database client abstraction for the N-PORT scraper.

The real N-PORT Supabase project doesn't exist yet. Until it does, this
module writes every would-be upsert to a JSONL file as a single line per
row, prefixed with the table name. That gives us:

- A reviewable artifact during dry-runs
- Fast unit tests that exercise the upsert codepath without DB
- A trivial swap-point: replace the body of each `upsert_*` method with
  `self._client.table(name).upsert(rows, on_conflict=...).execute()`
  once the project is provisioned.

Stub-write format (one JSON object per line):
    {"table": "nport_filings", "row": {...}, "on_conflict": "accession_number"}
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .config import (
    NPORT_STUB_WRITES_PATH,
    SUPABASE_SERVICE_KEY_NPORT,
    SUPABASE_URL_NPORT,
    UPSERT_BATCH_SIZE,
)
from .row_mapping import shape_row


class DBClient:
    """Abstract upsert surface for the N-PORT ingestion modules.

    Two operating modes:
    - Stub mode (default): write JSONL to `NPORT_STUB_WRITES_PATH`. No DB.
    - Live mode (when both Supabase env vars are set): construct a
      supabase-py client and route upserts there.

    Live mode is not exercised yet — the project doesn't exist. The method
    bodies are sketched but guarded behind `self._supabase is not None`.
    """

    def __init__(
        self,
        stub_path: Optional[Path] = None,
        force_stub: bool = False,
    ) -> None:
        self.stub_path: Path = Path(stub_path or NPORT_STUB_WRITES_PATH)
        self._supabase = None
        has_live_env = bool(SUPABASE_URL_NPORT or SUPABASE_SERVICE_KEY_NPORT)
        if not force_stub and has_live_env:
            if not (SUPABASE_URL_NPORT and SUPABASE_SERVICE_KEY_NPORT):
                raise RuntimeError(
                    "partial Supabase config: both SUPABASE_URL_NPORT and "
                    "SUPABASE_SERVICE_KEY_NPORT are required for live mode"
                )
            # Lazy import so the stub path has zero dependency on supabase-py.
            try:
                from supabase import create_client  # type: ignore

                self._supabase = create_client(
                    SUPABASE_URL_NPORT, SUPABASE_SERVICE_KEY_NPORT
                )
            except Exception as exc:  # noqa: BLE001 - include original init error
                raise RuntimeError(
                    "Supabase env is present but live client initialization "
                    "failed; refusing to fall back to stub writes"
                ) from exc

        if self._supabase is None:
            # Ensure stub file parent exists. Touch the file for clarity.
            self.stub_path.parent.mkdir(parents=True, exist_ok=True)
            if not self.stub_path.exists():
                self.stub_path.touch()

    # -- Public upsert methods -------------------------------------------------

    def upsert_filing(self, row: Dict[str, Any]) -> int:
        """Upsert one filing-level row (one accession) → nport_filings.

        Conflicts on `accession_number` (PRIMARY KEY).
        """
        return self.upsert_filings([row])

    def upsert_filings(self, rows: Iterable[Dict[str, Any]]) -> int:
        """Bulk upsert filing-level rows → nport_filings."""
        return self._upsert(
            "nport_filings",
            [shape_row("nport_filings", row) for row in rows],
            "accession_number",
        )

    def upsert_holding(self, rows: Iterable[Dict[str, Any]]) -> int:
        """Bulk upsert holdings rows → nport_holdings.

        Conflicts on the composite key ``(accession_number, holding_id)``
        per the schema's UNIQUE constraint. Bug 4 fix — was previously
        ``'holding_id'`` alone, which doesn't match any DB constraint and
        would fail on Postgres (or worse, silently duplicate rows when
        the upsert client falls back to insert semantics).
        """
        shaped = [shape_row("nport_holdings", row) for row in rows]
        return self._upsert("nport_holdings", shaped, "accession_number,holding_id")

    def upsert_registrant(self, row: Dict[str, Any]) -> int:
        """Upsert one registrant row → nport_registrants.

        Conflicts on ``cik`` per the schema (one row per fund family,
        across all filings). Bug 4 fix — was previously
        ``'accession_number'``, but the schema models registrants as
        per-CIK entities, not per-filing.

        We do NOT include columns that are managed server-side
        (``first_seen_at`` defaulting on INSERT) — only ``last_filed_at``
        is freshened on conflict.
        """
        return self.upsert_registrants([row])

    def upsert_registrants(self, rows: Iterable[Dict[str, Any]]) -> int:
        """Bulk upsert registrant rows → nport_registrants."""
        return self._upsert(
            "nport_registrants",
            [shape_row("nport_registrants", row) for row in rows],
            "cik",
        )

    def insert_missing_registrants(self, rows: Iterable[Dict[str, Any]]) -> int:
        """Insert daily-discovered registrants without touching existing rows.

        Daily XML lacks address/phone metadata. A normal upsert would pad those
        columns to ``NULL`` and overwrite richer bulk-loaded registrant rows.
        This method uses ``ON CONFLICT DO NOTHING`` semantics in live mode.
        """
        shaped = []
        for row in rows:
            full = shape_row("nport_registrants", row)
            if not full.get("cik") or not full.get("name"):
                continue
            shaped.append(
                {
                    "cik": full.get("cik"),
                    "name": full.get("name"),
                    "lei": full.get("lei"),
                    "last_filed_at": full.get("last_filed_at"),
                }
            )
        if not shaped:
            return 0
        if self._supabase is not None:
            return self._upsert_live(
                "nport_registrants",
                shaped,
                "cik",
                ignore_duplicates=True,
            )
        return self._upsert_stub("nport_registrants", shaped, "cik:do_nothing")

    def upsert_identifier(self, rows: Iterable[Dict[str, Any]]) -> int:
        """Bulk upsert IDENTIFIERS.tsv rows → nport_identifiers.

        Conflicts on the composite key ``(holding_id, identifiers_id)``
        per the schema's UNIQUE constraint. Bug 4 fix — was previously
        ``'holding_id,other_id_desc'``, which is not a schema constraint.
        """
        shaped = [shape_row("nport_identifiers", row) for row in rows]
        return self._upsert("nport_identifiers", shaped, "holding_id,identifiers_id")

    # -- Internals -------------------------------------------------------------

    def _upsert(
        self,
        table: str,
        rows: List[Dict[str, Any]],
        on_conflict: str,
    ) -> int:
        """Route to live Supabase if configured, else write JSONL stub."""
        if not rows:
            return 0
        if self._supabase is not None:
            return self._upsert_live(table, rows, on_conflict)
        return self._upsert_stub(table, rows, on_conflict)

    def _upsert_live(
        self,
        table: str,
        rows: List[Dict[str, Any]],
        on_conflict: str,
        *,
        ignore_duplicates: bool = False,
    ) -> int:
        """Real Supabase upsert path. Untested — project not yet provisioned."""
        assert self._supabase is not None
        total = 0
        for i in range(0, len(rows), UPSERT_BATCH_SIZE):
            batch = rows[i : i + UPSERT_BATCH_SIZE]
            first_keys = set(batch[0].keys())
            if any(set(row.keys()) != first_keys for row in batch):
                raise ValueError(
                    f"upsert batch for {table} has inconsistent keys; "
                    "map rows to a stable table schema before writing"
                )
            self._supabase.table(table).upsert(
                batch,
                on_conflict=on_conflict,
                ignore_duplicates=ignore_duplicates,
            ).execute()
            total += len(batch)
        return total

    def accessions_with_daily_holdings(self, accessions: Iterable[str]) -> set[str]:
        """Return accessions that already have daily-scrape holdings."""
        if self._supabase is None:
            return set()
        values = sorted({str(a) for a in accessions if a})
        found: set[str] = set()
        for i in range(0, len(values), 100):
            batch = values[i : i + 100]
            response = (
                self._supabase.table("nport_holdings")
                .select("accession_number")
                .in_("accession_number", batch)
                .eq("source_bulk_quarter", "daily-scrape")
                .limit(1000)
                .execute()
            )
            for row in response.data or []:
                if row.get("accession_number"):
                    found.add(str(row["accession_number"]))
        return found

    def accessions_with_bulk_data(self, accessions: Iterable[str]) -> set[str]:
        """Return accessions already loaded from a non-daily source.

        Daily XML uses synthetic per-filing holding IDs, while SEC bulk data
        uses ``HOLDING_ID``. If the same accession is loaded through both
        paths, the `(accession_number, holding_id)` upsert key cannot reconcile
        them. Daily ingestion must skip these bulk-loaded accessions.
        """
        if self._supabase is None:
            return set()
        values = sorted({str(a) for a in accessions if a})
        found: set[str] = set()

        for i in range(0, len(values), 100):
            batch = values[i : i + 100]
            response = (
                self._supabase.table("nport_filings")
                .select("accession_number")
                .in_("accession_number", batch)
                .neq("source_bulk_quarter", "daily-scrape")
                .limit(1000)
                .execute()
            )
            for row in response.data or []:
                if row.get("accession_number"):
                    found.add(str(row["accession_number"]))

        remaining = [value for value in values if value not in found]
        for i in range(0, len(remaining), 20):
            batch = remaining[i : i + 20]
            response = (
                self._supabase.table("nport_holdings")
                .select("accession_number")
                .in_("accession_number", batch)
                .neq("source_bulk_quarter", "daily-scrape")
                .limit(1000)
                .execute()
            )
            for row in response.data or []:
                if row.get("accession_number"):
                    found.add(str(row["accession_number"]))
        return found

    def count_rows(self, table: str, *, filters: Optional[Dict[str, Any]] = None) -> int:
        """Return an exact row count for a table or filtered relation."""
        if self._supabase is None:
            return 0
        query = self._supabase.table(table).select("*", count="exact").limit(1)
        for key, value in (filters or {}).items():
            query = query.eq(key, value)
        response = query.execute()
        return int(response.count or 0)

    def _upsert_stub(
        self,
        table: str,
        rows: List[Dict[str, Any]],
        on_conflict: str,
    ) -> int:
        """JSONL stub path. One line per row, includes table + conflict key."""
        ts = datetime.now(timezone.utc).isoformat()
        with open(self.stub_path, "a", encoding="utf-8") as fh:
            for row in rows:
                fh.write(
                    json.dumps(
                        {
                            "ts": ts,
                            "table": table,
                            "on_conflict": on_conflict,
                            "row": row,
                        },
                        default=str,
                    )
                    + "\n"
                )
        return len(rows)
