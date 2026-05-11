"""Configuration loader for the N-PORT scraper.

Mirrors the env-loading pattern used by data-pipeline/formd-scraper/
daily_scraper_with_alerts.py: read .env from project root, fall back to
process environment, never hardcode credentials.

Required env vars (when actually connecting):
    SUPABASE_URL_NPORT       -- N-PORT Supabase project URL
    SUPABASE_SERVICE_KEY_NPORT -- service role key (bypasses RLS for ingest)

Optional env vars:
    SEC_USER_AGENT           -- defaults to "Miles Muller mmmuller93@gmail.com"
    GMAIL_USER               -- for daily alerts (default mmmuller93@gmail.com)
    GMAIL_APP_PASSWORD       -- for daily alerts (NEVER hardcoded)
    NPORT_STAGING_DIR        -- staging dir for bulk downloads (default /tmp/nport_staging)
    NPORT_STUB_WRITES_PATH   -- where db_client.py stub writes JSONL
                                (default ./.stub_writes.jsonl)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional


def _load_dotenv() -> None:
    """Best-effort .env load matching the Form D scraper pattern.

    Walks up to four parents looking for a `.env` file (the Form D scraper
    uses two; we use four to tolerate the worktree directory depth).
    """
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents[:5]]:
        candidate = parent / ".env"
        if candidate.exists():
            for line in candidate.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(
                    k.strip(),
                    v.strip().strip('"').strip("'"),
                )
            return


_load_dotenv()


# -----------------------------------------------------------------------------
# SEC client config
# -----------------------------------------------------------------------------
SEC_USER_AGENT: str = os.environ.get(
    "SEC_USER_AGENT", "Miles Muller mmmuller93@gmail.com"
)
SEC_RATE_LIMIT_SEC: float = 0.11   # ~9 req/s, well under the 10/s SEC ceiling

EDGAR_BASE: str = "https://www.sec.gov"
SEC_BULK_NPORT_URL_FMT: str = (
    "https://www.sec.gov/files/dera/data/form-n-port-data-sets/{year}q{q}_nport.zip"
)
SEC_FORM_IDX_FMT: str = (
    "https://www.sec.gov/Archives/edgar/full-index/{year}/QTR{q}/form.idx"
)


# -----------------------------------------------------------------------------
# Supabase (N-PORT project)
# -----------------------------------------------------------------------------
SUPABASE_URL_NPORT: Optional[str] = os.environ.get("SUPABASE_URL_NPORT")
SUPABASE_SERVICE_KEY_NPORT: Optional[str] = os.environ.get(
    "SUPABASE_SERVICE_KEY_NPORT"
)


# -----------------------------------------------------------------------------
# Email alerts (optional — daily_scraper.py)
# -----------------------------------------------------------------------------
GMAIL_USER: str = os.environ.get("GMAIL_USER", "mmmuller93@gmail.com")
# NEVER hardcoded. Read from env at runtime; if missing, the scraper will
# print a warning and skip the email step rather than crashing the run.
GMAIL_APP_PASSWORD: Optional[str] = os.environ.get("GMAIL_APP_PASSWORD")


# -----------------------------------------------------------------------------
# Local paths
# -----------------------------------------------------------------------------
NPORT_STAGING_DIR: Path = Path(
    os.environ.get("NPORT_STAGING_DIR", "/tmp/nport_staging")
)
NPORT_STUB_WRITES_PATH: Path = Path(
    os.environ.get(
        "NPORT_STUB_WRITES_PATH",
        str(Path(__file__).resolve().parent / ".stub_writes.jsonl"),
    )
)


# -----------------------------------------------------------------------------
# Quarter range for historical backfill
# -----------------------------------------------------------------------------
BACKFILL_START = (2019, 4)   # 2019 Q4 — first quarter SEC publishes N-PORT bulk
BACKFILL_END = (2026, 1)     # current as of plan date; tune per release schedule


# -----------------------------------------------------------------------------
# Ingestion knobs
# -----------------------------------------------------------------------------
UPSERT_BATCH_SIZE: int = 500   # Supabase recommends <=500 for inserts
READ_PAGE_SIZE: int = 1000     # Supabase default-row-limit ceiling


def require_supabase_env() -> None:
    """Raise SystemExit with a useful message if Supabase env is missing.

    Called by code paths that need real DB access. The stubbed db_client.py
    does NOT call this — stub writes work without env config.
    """
    missing = [
        name
        for name in ("SUPABASE_URL_NPORT", "SUPABASE_SERVICE_KEY_NPORT")
        if not os.environ.get(name)
    ]
    if missing:
        print(
            "ERROR: required env vars not set: " + ", ".join(missing),
            file=sys.stderr,
        )
        sys.exit(1)
