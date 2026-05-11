"""
repricing_event_detector.py — Detects coordinated repricing events.

Definition (PLAN §3.3, §6.8): a "coordinated repricing event" occurs when
>= MIN_FUND_COUNT funds report the SAME implied $/share for the SAME company on
the same reporting period in both quarters of the comparison window. In
plain English: "every holder marked SpaceX from $212 to $421 simultaneously."

Confirmation case (PLAN §3.3): SpaceX Q4 2025 -> Q1 2026, common shares went
$212 -> $421 across every single holder (Fidelity, Baron, T. Rowe, Coatue,
The Private Shares Fund). The test fixture in tests/test_deltas.py replays
this exact case and asserts one event is emitted with markup_pct ~ 98.6.

Why exact-match (and not "approximately the same %"):
    The SpaceX 2x signal is striking precisely because the prices match to
    the cent — every fund's price desk applied the identical mark on the
    same date, which means they took it from the same primary-issuance round.
    A near-miss bucket would dilute the signal and produce false positives
    from coincidental similar markups. We use a tight epsilon (1 cent) to
    absorb float roundtrips, not to fuzzy-match.

Output row shape:
    repricing_events: company_id, period_end (current), exposure_type,
    share_class_normalized, prior_price, current_price, markup_pct,
    holder_count, holder_registrant_ids[], holder_series_ids[], detected_at.

Caller pattern:
    from compute_deltas import compute_deltas
    from repricing_event_detector import detect_repricing_events

    deltas = compute_deltas('all', '2025-12-31', '2026-03-31', db=db)
    events = detect_repricing_events(deltas, db=db)
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from .compute_deltas import PositionDelta
from .db_client import DBClient, get_default_client


log = logging.getLogger("nport.repricing")


# Minimum number of distinct holders that must all mark to the same exact
# (prior_price, current_price) pair for the repricing to count as
# "coordinated". 3 keeps the floor low enough to catch smaller companies
# while excluding two-holder coincidences.
MIN_FUND_COUNT = 3

# Tolerance in dollars when comparing implied prices. value/balance pulled
# from numeric(20,4) / numeric(28,8) can roundtrip to a float that differs
# from the analytic value by < 1e-6 in normal cases; 1e-2 absorbs that
# without ever conflating an actual $0.01 mark difference at the round.
PRICE_EPSILON = 1e-2


@dataclass
class RepricingEvent:
    company_id: str
    period_end: str  # current_period_end
    exposure_type: str | None
    share_class_normalized: str | None
    prior_price: float
    current_price: float
    markup_pct: float
    holder_count: int
    holder_registrant_ids: list[str]
    holder_series_ids: list[str]
    detected_at: str


def _bucket_key(d: PositionDelta) -> tuple | None:
    """Group key for a coordinated event: (company, period, exposure type,
    share class, rounded prior price, rounded current price). Returns None
    if the delta has no implied price (we can't reason about it).

    Rounding to cents (PRICE_EPSILON precision) lets float-roundtripped
    values from the DB bucket together while still distinguishing a $212
    mark from a $212.50 mark.
    """
    if d.implied_price_prior is None or d.implied_price_current is None:
        return None
    if d.markup_pct is None:
        return None
    return (
        d.company_id,
        d.current_period_end,
        d.exposure_type,
        d.share_class_normalized,
        round(float(d.implied_price_prior), 2),
        round(float(d.implied_price_current), 2),
    )


def detect_repricing_events(
    deltas: list[PositionDelta],
    db: DBClient | None = None,
    min_fund_count: int = MIN_FUND_COUNT,
) -> list[RepricingEvent]:
    """Scan a batch of PositionDelta rows and emit one RepricingEvent per
    coordinated-repricing cluster.

    A cluster is a set of >= min_fund_count deltas that share the same
    bucket key (see _bucket_key). The "fund count" is counted as distinct
    (registrant_id, series_id) pairs — two share classes of the same fund
    series both marking the same way count once, not twice.

    Side effect: persists each event to the `repricing_events` table via the
    db stub.
    """
    db = db or get_default_client()

    buckets: dict[tuple, list[PositionDelta]] = defaultdict(list)
    for d in deltas:
        key = _bucket_key(d)
        if key is None:
            continue
        # An unchanged mark (markup_pct ~ 0) is not a "repricing event".
        if abs(d.markup_pct or 0) < PRICE_EPSILON:
            continue
        buckets[key].append(d)

    events: list[RepricingEvent] = []
    for key, members in buckets.items():
        distinct_holders = {(m.registrant_id, m.series_id) for m in members}
        if len(distinct_holders) < min_fund_count:
            continue

        company_id, period_end, exposure_type, share_class, prior_price, current_price = key
        # Use the first member's markup_pct (all members share the same
        # rounded prices, so the markup_pct is identical up to float noise).
        # Recompute from the rounded prices to avoid embedding float drift
        # in the emitted event.
        if prior_price == 0:
            log.warning("skipping repricing bucket with prior_price=0: %s", key)
            continue
        markup_pct = (current_price - prior_price) / prior_price * 100.0

        # Stable ordering so test assertions / DB upserts are deterministic.
        holder_registrant_ids = sorted({m.registrant_id for m in members})
        holder_series_ids = sorted({m.series_id for m in members})

        events.append(RepricingEvent(
            company_id=company_id,
            period_end=period_end,
            exposure_type=exposure_type,
            share_class_normalized=share_class,
            prior_price=float(prior_price),
            current_price=float(current_price),
            markup_pct=round(markup_pct, 4),
            holder_count=len(distinct_holders),
            holder_registrant_ids=holder_registrant_ids,
            holder_series_ids=holder_series_ids,
            detected_at=datetime.now(timezone.utc).isoformat(),
        ))

    if events:
        db.upsert(
            "repricing_events",
            [asdict(e) for e in events],
            on_conflict="company_id,period_end,exposure_type,share_class_normalized,prior_price,current_price",
        )
        log.info(
            "emitted %d coordinated_repricing event(s); largest holder_count=%d",
            len(events), max(e.holder_count for e in events),
        )
    return events
