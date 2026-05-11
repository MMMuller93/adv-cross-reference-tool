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
        if (
            not force_stub
            and SUPABASE_URL_NPORT
            and SUPABASE_SERVICE_KEY_NPORT
        ):
            # Lazy import so the stub path has zero dependency on supabase-py.
            try:
                from supabase import create_client  # type: ignore

                self._supabase = create_client(
                    SUPABASE_URL_NPORT, SUPABASE_SERVICE_KEY_NPORT
                )
            except Exception as exc:  # noqa: BLE001 — broad to keep stub usable
                # Don't crash — fall back to stub mode and surface a warning.
                print(
                    f"[db_client] supabase init failed ({exc}); "
                    "falling back to stub writes"
                )
                self._supabase = None

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
        return self._upsert("nport_filings", [row], "accession_number")

    def upsert_holding(self, rows: Iterable[Dict[str, Any]]) -> int:
        """Bulk upsert holdings rows → nport_holdings.

        Conflicts on the composite key ``(accession_number, holding_id)``
        per the schema's UNIQUE constraint. Bug 4 fix — was previously
        ``'holding_id'`` alone, which doesn't match any DB constraint and
        would fail on Postgres (or worse, silently duplicate rows when
        the upsert client falls back to insert semantics).
        """
        return self._upsert(
            "nport_holdings", list(rows), "accession_number,holding_id"
        )

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
        return self._upsert("nport_registrants", [row], "cik")

    def upsert_identifier(self, rows: Iterable[Dict[str, Any]]) -> int:
        """Bulk upsert IDENTIFIERS.tsv rows → nport_identifiers.

        Conflicts on the composite key ``(holding_id, identifiers_id)``
        per the schema's UNIQUE constraint. Bug 4 fix — was previously
        ``'holding_id,other_id_desc'``, which is not a schema constraint.
        """
        return self._upsert(
            "nport_identifiers", list(rows), "holding_id,identifiers_id"
        )

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
    ) -> int:
        """Real Supabase upsert path. Untested — project not yet provisioned."""
        assert self._supabase is not None
        total = 0
        for i in range(0, len(rows), UPSERT_BATCH_SIZE):
            batch = rows[i : i + UPSERT_BATCH_SIZE]
            self._supabase.table(table).upsert(
                batch, on_conflict=on_conflict
            ).execute()
            total += len(batch)
        return total

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
