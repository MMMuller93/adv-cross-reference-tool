"""Seed company_lifecycle_events with the verified IPO/founding dates for
companies the audit flagged + a handful of well-known public-then-private
cases that the static lifecycle_status field can't model correctly.

Codex 5.5 xhigh verified the IPO dates from SEC filings on 2026-05-18.
Founding dates from company filings + Wikipedia/Crunchbase (lower confidence).

Idempotent: uses upsert on (company_slug, event_date, event_type).
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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


# ---------------------------------------------------------------------------
# Seed data (Codex 5.5 xhigh verified IPO dates from SEC filings, 2026-05-18)
# ---------------------------------------------------------------------------
#
# Each tuple: (slug, event_date, event_type, status_after, source, confidence, notes)
#
# IPO/listing/take-private events are HIGH CONFIDENCE (SEC-verified by Codex).
# Founding events are MEDIUM CONFIDENCE (Wikipedia/Crunchbase, date-of-year
# accuracy only — set to Jan 1 of founding year as a conservative baseline).
# ---------------------------------------------------------------------------

EVENTS: list[dict[str, Any]] = [
    # ----- Dana (NYSE: DAN) — already public for all of our N-PORT data -----
    # Codex chose 2008-02-01 as the post-bankruptcy emergence baseline.
    {
        "company_slug": "dana",
        "event_date": "2008-02-01",
        "event_type": "unknown",
        "status_after": "public",
        "source_name": "SEC EDGAR",
        "source_url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000026780",
        "confidence": 90,
        "notes": "Dana Incorporated (NYSE:DAN). Codex baseline: post-Ch.11 emergence Feb 2008. For our N-PORT data (2019+) Dana is always public.",
    },

    # ----- CoreWeave (NASDAQ: CRWV) -----
    {
        "company_slug": "coreweave",
        "event_date": "2017-01-01",
        "event_type": "founded",
        "status_after": "private",
        "source_name": "Wikipedia",
        "confidence": 50,
        "notes": "Founded 2017 (originally Atlantic Crypto). Day-of-year unverified.",
    },
    {
        "company_slug": "coreweave",
        "event_date": "2025-03-28",
        "event_type": "ipo",
        "status_after": "public",
        "source_name": "SEC EDGAR — CoreWeave 424B4 / IPO pricing",
        "source_url": "https://investors.coreweave.com/news/news-details/2025/CoreWeave-Announces-Pricing-of-Initial-Public-Offering/default.aspx",
        "confidence": 95,
        "notes": "IPO pricing 2025-03-28. Codex-verified.",
    },

    # ----- HeartFlow (NASDAQ: HTFL) -----
    {
        "company_slug": "heartflow",
        "event_date": "2007-01-01",
        "event_type": "founded",
        "status_after": "private",
        "source_name": "Wikipedia",
        "confidence": 50,
        "notes": "Founded 2007. Day-of-year unverified.",
    },
    {
        "company_slug": "heartflow",
        "event_date": "2025-08-08",
        "event_type": "ipo",
        "status_after": "public",
        "source_name": "SEC EDGAR — HeartFlow 424B4",
        "confidence": 90,
        "notes": "IPO 2025-08-08. Codex-verified.",
    },

    # ----- Cerebras (NASDAQ: CBRS) -----
    {
        "company_slug": "cerebras",
        "event_date": "2015-01-01",
        "event_type": "founded",
        "status_after": "private",
        "source_name": "Wikipedia",
        "confidence": 50,
        "notes": "Founded 2015. Day-of-year unverified.",
    },
    {
        "company_slug": "cerebras",
        "event_date": "2026-05-14",
        "event_type": "ipo",
        "status_after": "public",
        "source_name": "SEC EDGAR — Cerebras 424B4",
        "confidence": 95,
        "notes": "IPO 2026-05-14. Codex-verified.",
    },

    # ----- Klarna (NYSE: KLAR) -----
    {
        "company_slug": "klarna",
        "event_date": "2005-01-01",
        "event_type": "founded",
        "status_after": "private",
        "source_name": "Wikipedia",
        "confidence": 50,
        "notes": "Founded 2005 in Stockholm. Day-of-year unverified.",
    },
    {
        "company_slug": "klarna",
        "event_date": "2025-09-10",
        "event_type": "ipo",
        "status_after": "public",
        "source_name": "SEC EDGAR — Klarna 424B4",
        "confidence": 95,
        "notes": "IPO 2025-09-10. Codex-verified.",
    },

    # ----- Wise (LSE / NASDAQ: WSE) -----
    {
        "company_slug": "wise",
        "event_date": "2011-01-01",
        "event_type": "founded",
        "status_after": "private",
        "source_name": "Wikipedia",
        "confidence": 50,
        "notes": "Founded 2011 as TransferWise. Day-of-year unverified.",
    },
    {
        "company_slug": "wise",
        "event_date": "2021-07-07",
        "event_type": "direct_listing",
        "status_after": "public",
        "source_name": "LSE RNS — Wise direct listing",
        "confidence": 95,
        "notes": "LSE direct listing 2021-07-07. Codex-verified. Do NOT model 2026 Nasdaq listing as a separate lifecycle event.",
    },

    # ----- Squarespace (was NYSE: SQSP → take-private Permira Oct 2024) -----
    # The "public-then-private-again" case Codex specifically called out.
    {
        "company_slug": "squarespace",
        "event_date": "2003-01-01",
        "event_type": "founded",
        "status_after": "private",
        "source_name": "Wikipedia",
        "confidence": 50,
        "notes": "Founded 2003.",
    },
    {
        "company_slug": "squarespace",
        "event_date": "2021-05-19",
        "event_type": "direct_listing",
        "status_after": "public",
        "source_name": "Squarespace press release / NYSE trading commencement",
        "source_url": "https://newsroom.squarespace.com/blog/squarespace-to-commence-trading-on-nyse",
        "confidence": 95,
        "notes": "Direct listing on NYSE (NOT an IPO). Codex-verified.",
    },
    {
        "company_slug": "squarespace",
        "event_date": "2024-10-17",
        "event_type": "take_private",
        "status_after": "acquired_private",
        "source_name": "Permira completion press release",
        "source_url": "https://www.permira.com/news-and-insights/announcements/permira-completes-tender-offer-for-outstanding-shares-of-squarespace/",
        "confidence": 95,
        "notes": "Take-private completion by Permira. Codex-verified.",
    },
]


def upsert_events(nport, events: list[dict[str, Any]]) -> int:
    """Upsert event rows. Unique key is (company_slug, event_date, event_type)."""
    if not events:
        return 0
    now_iso = datetime.now(timezone.utc).isoformat()
    rows = [{**e, "verified_at": now_iso} for e in events]
    response = (
        nport.table("company_lifecycle_events")
        .upsert(rows, on_conflict="company_slug,event_date,event_type")
        .execute()
    )
    return len(response.data or rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="Apply seed writes")
    args = parser.parse_args(argv)

    load_credentials()
    nport = create_nport_client()

    # Sanity: verify the slugs exist in private_companies before upserting
    # (so the FK constraint won't reject).
    slugs = sorted({e["company_slug"] for e in EVENTS})
    response = (
        nport.table("private_companies")
        .select("slug")
        .in_("slug", slugs)
        .execute()
    )
    existing = {row["slug"] for row in (response.data or [])}
    missing = [s for s in slugs if s not in existing]
    if missing:
        print(f"WARN: these slugs are NOT in private_companies (will be skipped):")
        for s in missing:
            print(f"  - {s}")

    seedable = [e for e in EVENTS if e["company_slug"] not in missing]
    print(f"\nPlanning to upsert {len(seedable)} lifecycle events across "
          f"{len({e['company_slug'] for e in seedable})} companies:")
    for slug in sorted({e["company_slug"] for e in seedable}):
        events_for_slug = [e for e in seedable if e["company_slug"] == slug]
        events_for_slug.sort(key=lambda e: e["event_date"])
        print(f"\n  {slug}:")
        for e in events_for_slug:
            print(f"    {e['event_date']}  {e['event_type']:>15s}  -> {e['status_after']}  ({e['source_name']})")

    if not args.execute:
        print("\nDry run only. Re-run with --execute to upsert.")
        return 0

    n = upsert_events(nport, seedable)
    print(f"\nUpserted {n} rows into company_lifecycle_events.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
