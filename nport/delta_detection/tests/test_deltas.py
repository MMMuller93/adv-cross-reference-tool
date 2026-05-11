"""
tests/test_deltas.py — Pytest fixtures and assertions for the N-PORT
quarter-over-quarter delta job and coordinated-repricing detector.

The headline fixture replays the PLAN §3.3 confirmation case: SpaceX
Q4 2025 -> Q1 2026, common shares marked from $212 -> $421 by every
holder, plus preferred from $2,120 -> $4,210.

Assertions cover:
    1. Pure markup detection — balance unchanged, price moved
    2. New-position detection (is_new_position = True)
    3. Exit detection (is_exit = True)
    4. Mixed-direction (markdown) deltas have negative markup_pct
    5. Quantity change (balance moved AND price moved) is NOT pure markup
    6. SpaceX coordinated repricing fires exactly one event with
       markup_pct rounded-1 == 98.6 and holder_count == 8
    7. Lone or two-holder repricings do NOT emit an event
    8. JSONL persistence works end-to-end (compute_deltas writes,
       db.read_writes returns the rows we expect)

Run from this directory:
    pytest -v
Or from project root:
    pytest data-pipeline/nport-scraper/delta_detection/tests/ -v
"""

from __future__ import annotations

from pathlib import Path

import pytest

from nport.delta_detection.compute_deltas import (
    PositionDelta,
    compute_deltas,
    compute_deltas_for_company,
)
from nport.delta_detection.db_client import DBClient, Position
from nport.delta_detection.email_alerts import (
    format_new_position_alert,
    format_pure_markup_alert,
    format_repricing_alert,
)
from nport.delta_detection.repricing_event_detector import detect_repricing_events


# ----------------------------------------------------------- shared fixtures
PRIOR = "2025-12-31"
CURRENT = "2026-03-31"

# SpaceX coordinated 2x repricing per PLAN §3.3 — eight holders, each marking
# common shares from $212 to $421 simultaneously. Balance unchanged so the
# detector should also classify each delta as is_pure_markup.
SPACEX_HOLDERS = [
    # (registrant_id, registrant_cik, registrant_name, series_id, series_name, balance)
    ("reg-fidelity",    "0000035315", "Fidelity Investments",      "S000001", "Fidelity Contrafund",         100_000.0),
    ("reg-fidelity",    "0000035315", "Fidelity Investments",      "S000002", "Fidelity Blue Chip Growth",    50_000.0),
    ("reg-baron",       "0000810902", "Baron Capital",             "S000003", "Baron Partners Fund",          25_000.0),
    ("reg-trp",         "0000852254", "T. Rowe Price",             "S000004", "T. Rowe Price Blue Chip Gr",   75_000.0),
    ("reg-coatue",      "0001789814", "Coatue Tactical Solutions", "S000005", "Coatue Tactical Solutions",    40_000.0),
    ("reg-privsh",      "0001592094", "Liberty Street Funds",      "S000006", "The Private Shares Fund",      15_000.0),
    ("reg-blackrock",   "0001761055", "BlackRock Funds VIII",      "S000007", "BlackRock Tech Opportunities", 30_000.0),
    ("reg-morganstanley", "0000080750", "Morgan Stanley Funds",    "S000008", "MS Insight Fund",              20_000.0),
]
SPACEX_PRIOR_PRICE  = 212.0
SPACEX_CURRENT_PRICE = 421.0


@pytest.fixture
def tmp_writes_path(tmp_path: Path) -> Path:
    """Each test gets its own JSONL sink in a tmpdir — no cross-test bleed."""
    return tmp_path / "delta_writes.jsonl"


@pytest.fixture
def db(tmp_writes_path: Path) -> DBClient:
    return DBClient(writes_path=tmp_writes_path)


def _spacex_position(
    company_id: str,
    registrant_id: str,
    registrant_cik: str,
    registrant_name: str,
    series_id: str,
    series_name: str,
    period_end: str,
    balance: float,
    price: float,
    share_class: str = "common",
    exposure_type: str = "equity",
) -> Position:
    return Position(
        company_id=company_id,
        company_slug="spacex",
        company_name="SpaceX",
        registrant_id=registrant_id,
        registrant_cik=registrant_cik,
        registrant_name=registrant_name,
        series_id=series_id,
        series_name=series_name,
        report_period_end=period_end,
        share_class_normalized=share_class,
        exposure_type=exposure_type,
        asset_cat="EC",
        balance=balance,
        currency_value_usd=balance * price,
        pct_of_nav=None,
        raw_issuer_name="SPACE EXPLORATION TECHNOLOGIES CORP",
        raw_issuer_title=f"SpaceX {share_class}",
    )


@pytest.fixture
def spacex_two_quarter_mv() -> list[Position]:
    """Eight SpaceX-common holders + matching preferred for the first two
    holders (to cover the share-class dimension of the schema).
    """
    rows: list[Position] = []
    for (reg_id, reg_cik, reg_name, series_id, series_name, balance) in SPACEX_HOLDERS:
        rows.append(_spacex_position(
            "co-spacex", reg_id, reg_cik, reg_name, series_id, series_name,
            PRIOR, balance, SPACEX_PRIOR_PRICE,
        ))
        rows.append(_spacex_position(
            "co-spacex", reg_id, reg_cik, reg_name, series_id, series_name,
            CURRENT, balance, SPACEX_CURRENT_PRICE,
        ))
    # Preferred shares — exactly 10x prices ($2,120 -> $4,210) for two holders.
    # Only two holders, so this should NOT trigger a coordinated event (below
    # the MIN_FUND_COUNT=3 floor).
    for (reg_id, reg_cik, reg_name, series_id, series_name, balance) in SPACEX_HOLDERS[:2]:
        rows.append(_spacex_position(
            "co-spacex", reg_id, reg_cik, reg_name, series_id, series_name,
            PRIOR, balance / 10.0, SPACEX_PRIOR_PRICE * 10.0, share_class="preferred",
        ))
        rows.append(_spacex_position(
            "co-spacex", reg_id, reg_cik, reg_name, series_id, series_name,
            CURRENT, balance / 10.0, SPACEX_CURRENT_PRICE * 10.0, share_class="preferred",
        ))
    return rows


@pytest.fixture
def mixed_mv() -> list[Position]:
    """A second company with: a pure markup (xAI equity +106%), an exit,
    a new entry, a markdown, and a balance-change-with-price-change (so
    is_pure_markup must be False).
    """
    def pos(reg_id: str, period: str, balance: float | None, value: float | None,
            company: str = "co-xai", slug: str = "xai", name: str = "xAI",
            share_class: str = "common", exposure: str = "equity") -> Position:
        return Position(
            company_id=company, company_slug=slug, company_name=name,
            registrant_id=reg_id, registrant_cik="0000000000",
            registrant_name=reg_id, series_id="S001", series_name=reg_id,
            report_period_end=period, share_class_normalized=share_class,
            exposure_type=exposure, asset_cat="EC",
            balance=balance, currency_value_usd=value,
        )

    return [
        # Pure markup: same balance, value moves up
        pos("reg-A", PRIOR,   1000.0, 100_000.0),
        pos("reg-A", CURRENT, 1000.0, 206_400.0),  # 106.4% markup

        # Exit: present prior, absent current
        pos("reg-B", PRIOR,   500.0, 50_000.0),

        # New entry: absent prior, present current
        pos("reg-C", CURRENT, 800.0, 80_000.0),

        # Markdown: same balance, value down
        pos("reg-D", PRIOR,   200.0, 40_000.0),
        pos("reg-D", CURRENT, 200.0, 30_000.0),  # -25% markdown

        # Quantity change + price change → NOT pure markup
        pos("reg-E", PRIOR,   100.0, 10_000.0),
        pos("reg-E", CURRENT, 150.0, 18_000.0),
    ]


# ==========================================================================
# 1. Core delta math
# ==========================================================================
class TestDeltaMath:
    def test_pure_markup_is_detected(self, db: DBClient, mixed_mv: list[Position]) -> None:
        db.load_mv_fixture(mixed_mv)
        deltas = compute_deltas_for_company(db, "co-xai", PRIOR, CURRENT)
        reg_a = next(d for d in deltas if d.registrant_id == "reg-A")
        assert reg_a.is_pure_markup is True
        assert reg_a.balance_delta == 0
        assert reg_a.value_delta_usd == pytest.approx(106_400.0)
        assert reg_a.markup_pct == pytest.approx(106.4, rel=1e-3)

    def test_quantity_and_price_change_is_not_pure_markup(self, db: DBClient, mixed_mv: list[Position]) -> None:
        db.load_mv_fixture(mixed_mv)
        deltas = compute_deltas_for_company(db, "co-xai", PRIOR, CURRENT)
        reg_e = next(d for d in deltas if d.registrant_id == "reg-E")
        assert reg_e.is_pure_markup is False  # balance changed → cannot be "pure"
        assert reg_e.balance_delta == pytest.approx(50.0)
        assert reg_e.value_delta_usd == pytest.approx(8_000.0)

    def test_new_position_flag(self, db: DBClient, mixed_mv: list[Position]) -> None:
        db.load_mv_fixture(mixed_mv)
        deltas = compute_deltas_for_company(db, "co-xai", PRIOR, CURRENT)
        reg_c = next(d for d in deltas if d.registrant_id == "reg-C")
        assert reg_c.is_new_position is True
        assert reg_c.is_exit is False
        assert reg_c.prior_balance is None
        assert reg_c.current_balance == 800.0

    def test_exit_flag(self, db: DBClient, mixed_mv: list[Position]) -> None:
        db.load_mv_fixture(mixed_mv)
        deltas = compute_deltas_for_company(db, "co-xai", PRIOR, CURRENT)
        reg_b = next(d for d in deltas if d.registrant_id == "reg-B")
        assert reg_b.is_exit is True
        assert reg_b.is_new_position is False
        assert reg_b.current_balance is None
        assert reg_b.prior_balance == 500.0

    def test_markdown_has_negative_markup_pct(self, db: DBClient, mixed_mv: list[Position]) -> None:
        db.load_mv_fixture(mixed_mv)
        deltas = compute_deltas_for_company(db, "co-xai", PRIOR, CURRENT)
        reg_d = next(d for d in deltas if d.registrant_id == "reg-D")
        assert reg_d.markup_pct is not None
        assert reg_d.markup_pct < 0
        assert reg_d.markup_pct == pytest.approx(-25.0)

    def test_implied_price_division_by_zero_is_none(self, db: DBClient) -> None:
        """Balance=0 must not throw; implied_price returns None."""
        zero_balance = Position(
            company_id="co-x", company_slug="x", company_name="X",
            registrant_id="r1", registrant_cik="0", registrant_name="r1",
            series_id="s1", series_name="s1",
            report_period_end=PRIOR, share_class_normalized="common",
            exposure_type="equity", asset_cat="EC",
            balance=0.0, currency_value_usd=0.0,
        )
        nonzero = Position(
            company_id="co-x", company_slug="x", company_name="X",
            registrant_id="r1", registrant_cik="0", registrant_name="r1",
            series_id="s1", series_name="s1",
            report_period_end=CURRENT, share_class_normalized="common",
            exposure_type="equity", asset_cat="EC",
            balance=10.0, currency_value_usd=1000.0,
        )
        db.load_mv_fixture([zero_balance, nonzero])
        deltas = compute_deltas_for_company(db, "co-x", PRIOR, CURRENT)
        assert len(deltas) == 1
        assert deltas[0].implied_price_prior is None
        assert deltas[0].implied_price_current == 100.0
        assert deltas[0].markup_pct is None  # cannot compute pct from None prior


# ==========================================================================
# 2. Persistence — JSONL sink
# ==========================================================================
class TestPersistence:
    def test_compute_deltas_writes_to_jsonl(self, db: DBClient, mixed_mv: list[Position]) -> None:
        db.load_mv_fixture(mixed_mv)
        compute_deltas("co-xai", PRIOR, CURRENT, db=db)

        writes = db.read_writes("position_deltas")
        # Five distinct match keys in the mixed fixture: reg-A, reg-B, reg-C,
        # reg-D, reg-E.
        assert len(writes) == 5
        for rec in writes:
            assert rec["table"] == "position_deltas"
            assert "current_period_end" in rec["on_conflict"]

    def test_compute_deltas_all_companies(self, db: DBClient,
                                          mixed_mv: list[Position],
                                          spacex_two_quarter_mv: list[Position]) -> None:
        """company_id='all' fans out across every company in the MV."""
        db.load_mv_fixture(mixed_mv + spacex_two_quarter_mv)
        deltas = compute_deltas("all", PRIOR, CURRENT, db=db)

        company_ids = {d.company_id for d in deltas}
        assert company_ids == {"co-xai", "co-spacex"}


# ==========================================================================
# 3. SpaceX coordinated repricing — the headline assertion
# ==========================================================================
class TestSpaceXRepricing:
    def test_eight_holders_at_same_price_emit_one_event(
        self, db: DBClient, spacex_two_quarter_mv: list[Position],
    ) -> None:
        """The exact PLAN §3.3 case: 8 holders mark $212 -> $421 → 1 event."""
        db.load_mv_fixture(spacex_two_quarter_mv)
        deltas = compute_deltas("co-spacex", PRIOR, CURRENT, db=db)

        # Every SpaceX common delta must be a pure markup
        common_deltas = [d for d in deltas if d.share_class_normalized == "common"]
        assert len(common_deltas) == 8
        assert all(d.is_pure_markup for d in common_deltas)

        # Each markup_pct ≈ 98.585%
        for d in common_deltas:
            assert d.markup_pct == pytest.approx(98.5849, abs=1e-3)

        events = detect_repricing_events(deltas, db=db)
        # Exactly ONE coordinated event (the common-share cluster). The
        # two-holder preferred cluster is below the MIN_FUND_COUNT=3 floor.
        assert len(events) == 1
        event = events[0]

        assert event.company_id == "co-spacex"
        assert event.period_end == CURRENT
        assert event.share_class_normalized == "common"
        assert event.exposure_type == "equity"
        assert event.prior_price == pytest.approx(212.0)
        assert event.current_price == pytest.approx(421.0)
        # The headline brief assertion: rounded to 1 decimal place == 98.6
        assert round(event.markup_pct, 1) == 98.6
        assert event.holder_count == 8
        assert len(event.holder_registrant_ids) == 7  # Fidelity has 2 series
        # Persisted to repricing_events
        events_written = db.read_writes("repricing_events")
        assert len(events_written) == 1
        assert events_written[0]["row"]["holder_count"] == 8

    def test_two_holder_preferred_does_not_emit_event(
        self, db: DBClient, spacex_two_quarter_mv: list[Position],
    ) -> None:
        """Only 2 preferred holders → below MIN_FUND_COUNT=3 → no event."""
        db.load_mv_fixture(spacex_two_quarter_mv)
        deltas = compute_deltas("co-spacex", PRIOR, CURRENT, db=db)
        events = detect_repricing_events(deltas, db=db)
        # The single emitted event must be the common-share cluster, not preferred
        preferred_events = [e for e in events if e.share_class_normalized == "preferred"]
        assert preferred_events == []

    def test_independent_markups_do_not_cluster(self, db: DBClient) -> None:
        """Three holders, each at a different exact (prior, current) price.
        They share the company + period but NOT the bucket key → no event.
        """
        mv = [
            _spacex_position("co-spacex", "reg-1", "0", "r1", "s1", "S1", PRIOR,   100.0, 200.0),
            _spacex_position("co-spacex", "reg-1", "0", "r1", "s1", "S1", CURRENT, 100.0, 400.0),
            _spacex_position("co-spacex", "reg-2", "0", "r2", "s2", "S2", PRIOR,   100.0, 210.0),
            _spacex_position("co-spacex", "reg-2", "0", "r2", "s2", "S2", CURRENT, 100.0, 415.0),
            _spacex_position("co-spacex", "reg-3", "0", "r3", "s3", "S3", PRIOR,   100.0, 220.0),
            _spacex_position("co-spacex", "reg-3", "0", "r3", "s3", "S3", CURRENT, 100.0, 430.0),
        ]
        db.load_mv_fixture(mv)
        deltas = compute_deltas("co-spacex", PRIOR, CURRENT, db=db)
        events = detect_repricing_events(deltas, db=db)
        assert events == []


# ==========================================================================
# 4. Email alert formatters
# ==========================================================================
class TestAlerts:
    def test_new_position_alert_renders(self, db: DBClient, mixed_mv: list[Position]) -> None:
        db.load_mv_fixture(mixed_mv)
        deltas = compute_deltas_for_company(db, "co-xai", PRIOR, CURRENT)
        new = [d for d in deltas if d.is_new_position]
        payload = format_new_position_alert(new, company_name_lookup={"co-xai": "xAI"})
        assert payload is not None
        assert payload.alert_type == "new_tracked_company_position"
        assert "xAI" in payload.html_body
        assert "reg-C" in payload.plain_body

    def test_pure_markup_alert_filters_below_threshold(
        self, db: DBClient, mixed_mv: list[Position],
    ) -> None:
        """The markdown (-25%) must NOT appear in the markup alert."""
        db.load_mv_fixture(mixed_mv)
        deltas = compute_deltas_for_company(db, "co-xai", PRIOR, CURRENT)
        payload = format_pure_markup_alert(deltas, threshold_pct=25.0)
        assert payload is not None
        # Only reg-A (+106.4% pure markup) survives the filter; reg-D is a
        # markdown (negative) and reg-E is not pure (balance changed).
        assert "reg-A" in payload.plain_body
        assert "reg-D" not in payload.plain_body
        assert "reg-E" not in payload.plain_body

    def test_repricing_alert_renders_spacex(
        self, db: DBClient, spacex_two_quarter_mv: list[Position],
    ) -> None:
        db.load_mv_fixture(spacex_two_quarter_mv)
        deltas = compute_deltas("co-spacex", PRIOR, CURRENT, db=db)
        events = detect_repricing_events(deltas, db=db)
        payload = format_repricing_alert(events, company_name_lookup={"co-spacex": "SpaceX"})
        assert payload is not None
        assert payload.alert_type == "coordinated_repricing"
        assert "SpaceX" in payload.html_body
        assert "$212.00" in payload.html_body
        assert "$421.00" in payload.html_body
        assert "98.58" in payload.html_body or "98.59" in payload.html_body

    def test_empty_inputs_return_none(self) -> None:
        """No content → no payload. The dispatcher uses this to skip sends."""
        assert format_new_position_alert([]) is None
        assert format_pure_markup_alert([]) is None
        assert format_repricing_alert([]) is None
