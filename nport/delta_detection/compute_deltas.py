"""
compute_deltas.py — Quarter-over-quarter position-delta detection (PLAN §6.8).

Compares two adjacent N-PORT reporting periods for one (or all) tracked private
companies and writes one row per match-key to `position_deltas`:

    - markup_pct      : (current_price - prior_price) / prior_price * 100
    - balance_delta   : current_balance - prior_balance
    - value_delta_usd : current_value_usd - prior_value_usd
    - is_pure_markup  : balance unchanged AND value changed (per PLAN §6.8)
    - is_new_position : no prior-period row for this match key
    - is_exit         : no current-period row for this match key

Match key (PLAN §6.8): (registrant_id, series_id, share_class_normalized,
exposure_type). All matching happens within a single company_id.

Usage:
    python compute_deltas.py --company all \
        --prior 2025-12-31 --current 2026-03-31

Imported by the daily scraper after a bulk-load batch completes (PLAN §6.8
"Trigger: After every bulk-load or daily-scrape batch completes").
"""

from __future__ import annotations

import argparse
import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Iterable

from .db_client import DBClient, Position, get_default_client


log = logging.getLogger("nport.compute_deltas")


# --------------------------------------------------------------------- types
@dataclass
class PositionDelta:
    """One row written to the `position_deltas` table (schema §4.1).

    Field names match the SQL column names verbatim so the upsert payload
    can be passed straight through with no key remapping.
    """

    company_id: str
    registrant_id: str
    series_id: str
    share_class_normalized: str | None
    exposure_type: str | None
    prior_period_end: str | None
    current_period_end: str | None
    prior_balance: float | None
    current_balance: float | None
    prior_value_usd: float | None
    current_value_usd: float | None
    balance_delta: float | None
    value_delta_usd: float | None
    implied_price_prior: float | None
    implied_price_current: float | None
    markup_pct: float | None
    is_pure_markup: bool
    is_new_position: bool
    is_exit: bool
    detected_at: str


# --------------------------------------------------------------- math helpers
def _implied_price(value_usd: float | None, balance: float | None) -> float | None:
    """value / balance, guarding against zero / None.

    Returned as float (not Decimal) because position deltas are downstream-only
    analytics; the source of truth is balance + value_usd on the holding row.
    """
    if value_usd is None or balance is None:
        return None
    if balance == 0:
        return None
    return float(value_usd) / float(balance)


def _markup_pct(prior_price: float | None, current_price: float | None) -> float | None:
    """Percent change in implied price. Signed. None if either side is None
    or prior is zero.
    """
    if prior_price is None or current_price is None:
        return None
    if prior_price == 0:
        return None
    return (current_price - prior_price) / prior_price * 100.0


def _is_pure_markup(prior: Position, current: Position) -> bool:
    """Pure markup = balance unchanged AND value moved (PLAN §6.8).

    Handles the None-balance case conservatively (returns False) — if we
    don't know the balance, we can't say it's unchanged.
    """
    if prior.balance is None or current.balance is None:
        return False
    if prior.balance != current.balance:
        return False
    if prior.currency_value_usd is None or current.currency_value_usd is None:
        return False
    return prior.currency_value_usd != current.currency_value_usd


# ---------------------------------------------------------------- core logic
def _index_by_match_key(positions: Iterable[Position]) -> dict[tuple, Position]:
    """Build a {match_key: Position} dict. If duplicates exist within the
    same period (shouldn't happen — the MV is one row per holding) the last
    wins; we log a warning so the upstream resolution bug surfaces.
    """
    out: dict[tuple, Position] = {}
    for p in positions:
        if p.match_key in out:
            log.warning(
                "duplicate match_key in single period: company=%s key=%s — keeping last",
                p.company_id, p.match_key,
            )
        out[p.match_key] = p
    return out


def _delta_for_match(prior: Position | None, current: Position | None) -> PositionDelta:
    """Produce a PositionDelta from a (prior, current) pair. Exactly one
    side may be None for new-entry / exit rows.
    """
    assert prior is not None or current is not None, "delta requires at least one side"

    ref = current or prior  # for company / registrant / series identifiers
    assert ref is not None  # for type-checkers

    prior_balance = prior.balance if prior else None
    current_balance = current.balance if current else None
    prior_value = prior.currency_value_usd if prior else None
    current_value = current.currency_value_usd if current else None

    balance_delta = None
    if prior_balance is not None and current_balance is not None:
        balance_delta = current_balance - prior_balance
    elif prior_balance is None and current_balance is not None:
        balance_delta = current_balance
    elif prior_balance is not None and current_balance is None:
        balance_delta = -prior_balance

    value_delta = None
    if prior_value is not None and current_value is not None:
        value_delta = current_value - prior_value
    elif prior_value is None and current_value is not None:
        value_delta = current_value
    elif prior_value is not None and current_value is None:
        value_delta = -prior_value

    implied_prior = _implied_price(prior_value, prior_balance)
    implied_current = _implied_price(current_value, current_balance)
    markup = _markup_pct(implied_prior, implied_current)

    is_pure_markup = (
        prior is not None and current is not None and _is_pure_markup(prior, current)
    )
    is_new = prior is None
    is_exit = current is None

    return PositionDelta(
        company_id=ref.company_id,
        registrant_id=ref.registrant_id,
        series_id=ref.series_id,
        share_class_normalized=ref.share_class_normalized,
        exposure_type=ref.exposure_type,
        prior_period_end=prior.report_period_end if prior else None,
        current_period_end=current.report_period_end if current else None,
        prior_balance=prior_balance,
        current_balance=current_balance,
        prior_value_usd=prior_value,
        current_value_usd=current_value,
        balance_delta=balance_delta,
        value_delta_usd=value_delta,
        implied_price_prior=implied_prior,
        implied_price_current=implied_current,
        markup_pct=markup,
        is_pure_markup=is_pure_markup,
        is_new_position=is_new,
        is_exit=is_exit,
        detected_at=datetime.now(timezone.utc).isoformat(),
    )


def compute_deltas_for_company(
    db: DBClient,
    company_id: str,
    prior_period_end: str,
    current_period_end: str,
) -> list[PositionDelta]:
    """Produce delta rows for one company across two adjacent periods.

    Does NOT upsert — caller decides. Returns the list so the repricing
    detector can chain off it.
    """
    prior = _index_by_match_key(db.query_mv(company_id, prior_period_end))
    current = _index_by_match_key(db.query_mv(company_id, current_period_end))

    deltas: list[PositionDelta] = []
    all_keys = set(prior.keys()) | set(current.keys())
    for key in all_keys:
        deltas.append(_delta_for_match(prior.get(key), current.get(key)))
    return deltas


def upsert_deltas(db: DBClient, deltas: list[PositionDelta]) -> int:
    """Write deltas to the position_deltas table via the stub.

    on_conflict matches the UNIQUE constraint defined in the schema
    (PLAN §4.1): (company_id, registrant_id, series_id,
    share_class_normalized, exposure_type, current_period_end).
    """
    if not deltas:
        return 0
    return db.upsert(
        "position_deltas",
        [asdict(d) for d in deltas],
        on_conflict=(
            "company_id,registrant_id,series_id,"
            "share_class_normalized,exposure_type,current_period_end"
        ),
    )


def compute_deltas(
    company_id: str,
    prior_period_end: str,
    current_period_end: str,
    db: DBClient | None = None,
) -> list[PositionDelta]:
    """End-to-end entry point used by the daily scraper.

    Accepts company_id="all" to fan out across every company that has a row
    in either period. Returns the full delta set (also persisted via
    upsert_deltas).
    """
    db = db or get_default_client()

    if company_id in (None, "all"):
        company_ids = sorted(
            set(db.distinct_company_ids_for_period(prior_period_end))
            | set(db.distinct_company_ids_for_period(current_period_end))
        )
    else:
        company_ids = [company_id]

    all_deltas: list[PositionDelta] = []
    for cid in company_ids:
        d = compute_deltas_for_company(db, cid, prior_period_end, current_period_end)
        all_deltas.extend(d)

    upsert_deltas(db, all_deltas)
    log.info(
        "computed %d deltas across %d companies (prior=%s current=%s)",
        len(all_deltas), len(company_ids), prior_period_end, current_period_end,
    )
    return all_deltas


# ----------------------------------------------------------------------- CLI
def _main() -> None:
    parser = argparse.ArgumentParser(description="Compute N-PORT position deltas (PLAN §6.8)")
    parser.add_argument("--company", default="all",
                        help="company_id (uuid) or 'all' to fan out across every company")
    parser.add_argument("--prior", required=True,
                        help="prior_period_end (YYYY-MM-DD)")
    parser.add_argument("--current", required=True,
                        help="current_period_end (YYYY-MM-DD)")
    parser.add_argument("--mv-jsonl", default=None,
                        help="optional path to a JSONL fixture loaded into the MV store")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    db = get_default_client()
    if args.mv_jsonl:
        db.load_mv_from_jsonl(args.mv_jsonl)

    deltas = compute_deltas(args.company, args.prior, args.current, db=db)
    print(f"computed {len(deltas)} delta rows")


if __name__ == "__main__":
    _main()
