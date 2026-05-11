"""
db_client.py — Stubbed Supabase client for the N-PORT delta-detection pipeline.

Mirrors the upsert/query surface used elsewhere in the repo (see
data-pipeline/formd-scraper/daily_scraper_with_alerts.py) but writes to a local
JSONL file instead of hitting Supabase. This lets the delta job, repricing
detector, and tests all run hermetically without network or credentials.

When the real Supabase wiring lands (PLAN §4, separate N-PORT project), swap the
internals of `upsert` for `self.client.table(...).upsert(...).execute()` and
hand back the same shape. The call sites do not need to change.

JSONL location: ./.delta_writes.jsonl in the working directory.
Each line is:
    {"table": "...", "on_conflict": "...", "row": {...}, "written_at": "ISO"}

`query_mv` reads from an in-memory store (`load_mv_fixture` for tests, or
`load_mv_from_jsonl` for ad-hoc runs). The real implementation hits the
`nport_company_positions_mv` materialized view.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


DEFAULT_WRITES_PATH = Path(os.environ.get("NPORT_DELTA_WRITES_PATH", ".delta_writes.jsonl"))


@dataclass
class Position:
    """One row from nport_company_positions_mv.

    Field names intentionally mirror the materialized view column list (PLAN
    §4.1) so a future swap to the real DB requires no rename pass.
    """

    company_id: str
    company_slug: str
    company_name: str
    registrant_id: str
    registrant_cik: str
    registrant_name: str
    series_id: str
    series_name: str | None
    report_period_end: str  # ISO date
    share_class_normalized: str | None
    exposure_type: str | None
    asset_cat: str | None
    balance: float | None
    currency_value_usd: float | None
    pct_of_nav: float | None = None
    raw_issuer_name: str | None = None
    raw_issuer_title: str | None = None

    @property
    def match_key(self) -> tuple[str, str, str | None, str | None]:
        """Key used to align a position across two adjacent periods.

        Per PLAN §6.8: (registrant_id, series_id, share_class_normalized,
        exposure_type). company_id is implicit (we only compare within a
        company) so it is not part of the key.
        """
        return (self.registrant_id, self.series_id, self.share_class_normalized, self.exposure_type)


class DBClient:
    """In-process stub. Thread-safe append to JSONL + per-process MV store."""

    def __init__(self, writes_path: Path | str | None = None) -> None:
        self.writes_path = Path(writes_path) if writes_path else DEFAULT_WRITES_PATH
        self._mv: list[Position] = []
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ MV
    def load_mv_fixture(self, positions: Iterable[Position]) -> None:
        """Replace the in-memory MV with the provided rows (tests use this)."""
        with self._lock:
            self._mv = list(positions)

    def load_mv_from_jsonl(self, path: Path | str) -> None:
        """Load MV rows from a JSONL file (one Position per line)."""
        rows: list[Position] = []
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rows.append(Position(**json.loads(line)))
        self.load_mv_fixture(rows)

    def query_mv(self, company_id: str | None, period_end: str) -> list[Position]:
        """Return MV rows for (company_id, period_end). company_id=None or
        the literal string 'all' returns every company for that period.
        """
        with self._lock:
            mv = list(self._mv)
        out: list[Position] = []
        for p in mv:
            if p.report_period_end != period_end:
                continue
            if company_id not in (None, "all") and p.company_id != company_id:
                continue
            out.append(p)
        return out

    def distinct_company_ids_for_period(self, period_end: str) -> list[str]:
        with self._lock:
            return sorted({p.company_id for p in self._mv if p.report_period_end == period_end})

    # ------------------------------------------------------------- Writes
    def upsert(self, table: str, rows: list[dict[str, Any]], on_conflict: str) -> int:
        """Persist `rows` to the JSONL sink. Returns count of rows written.

        Idempotency: in the real Supabase client, on_conflict drives the
        ON CONFLICT clause. Here we just record on_conflict so a downstream
        replay tool can deduplicate. We do NOT dedupe on write — tests assert
        on the row stream directly.
        """
        if not rows:
            return 0
        ts = datetime.now(timezone.utc).isoformat()
        # Ensure parent dir exists when caller passed a nested path.
        self.writes_path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, open(self.writes_path, "a", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps({
                    "table": table,
                    "on_conflict": on_conflict,
                    "row": row,
                    "written_at": ts,
                }, default=str) + "\n")
        return len(rows)

    def read_writes(self, table: str | None = None) -> list[dict[str, Any]]:
        """Helper for tests/inspection: read back the JSONL sink."""
        if not self.writes_path.exists():
            return []
        out: list[dict[str, Any]] = []
        with open(self.writes_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                if table is None or rec.get("table") == table:
                    out.append(rec)
        return out

    def reset_writes(self) -> None:
        """Truncate the JSONL sink. Tests call this in fixtures."""
        if self.writes_path.exists():
            self.writes_path.unlink()


# Convenience module-level default instance (mirrors the formd-scraper pattern
# where a single client is instantiated at module load). Callers that need
# isolation (tests) should construct their own DBClient.
_default_client: DBClient | None = None


def get_default_client() -> DBClient:
    global _default_client
    if _default_client is None:
        _default_client = DBClient()
    return _default_client
