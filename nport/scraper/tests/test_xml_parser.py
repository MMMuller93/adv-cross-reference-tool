"""Tests for the NPORT-P XML parser in daily_scraper.py.

Uses the real sample primary_doc.xml from /tmp/nport_research/raw_nport.xml
(BlackRock Technology and Private Equity Term Trust, period 2025-12-31)
copied to tests/fixtures/raw_nport.xml.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from nport.scraper.daily_scraper import parse_nport_xml

FIXTURE = Path(__file__).parent / "fixtures" / "raw_nport.xml"


@pytest.fixture(scope="module")
def parsed():
    xml_bytes = FIXTURE.read_bytes()
    return parse_nport_xml(xml_bytes)


def test_fixture_exists():
    assert FIXTURE.exists(), f"missing fixture: {FIXTURE}"


def test_registrant_metadata(parsed):
    meta, _ = parsed
    # Verified by direct lxml parse of /tmp/nport_research/raw_nport.xml
    assert meta["submission_type"] == "NPORT-P"
    assert meta["registrant_cik"] == "0001836057"
    assert (
        meta["registrant_name"]
        == "BlackRock Technology and Private Equity Term Trust"
    )
    assert meta["period_end"] == "2025-12-31"
    assert meta["period_date"] == "2025-09-30"
    # Fund-info numbers come through as strings — the resolver / DB layer
    # is responsible for typing them. We just confirm they are populated.
    assert meta["total_assets"] is not None
    assert meta["net_assets"] is not None


def test_holdings_count(parsed):
    """The fixture has 82 invstOrSec elements. Verified via:

        $ python3 -c "from lxml import etree; ..."
        82

    The task description mentioned 27 — that figure is the F4-filtered
    subset (see test_filter.py::test_fixture_f4_filtered_count). We assert
    the raw parser returns *all* 82 holdings unfiltered; filtering is a
    separate step.
    """
    _, holdings = parsed
    assert len(holdings) == 82


def test_first_holding_fields(parsed):
    """Smoke-check that all expected per-holding fields populate."""
    _, holdings = parsed
    first = holdings[0]
    expected_keys = {
        "registrant_cik",
        "period_end",
        "issuer_name",
        "issuer_lei",
        "issuer_title",
        "cusip",
        "balance",
        "unit",
        "currency_code",
        "currency_value",
        "percentage",
        "payoff_profile",
        "asset_cat",
        "issuer_type",
        "investment_country",
        "is_restricted",
        "fair_value_level",
        "identifiers",
        "isin",
        "ticker",
    }
    missing = expected_keys - set(first.keys())
    assert not missing, f"holding missing keys: {missing}"
    # Period + CIK should match the filing-level meta
    assert first["registrant_cik"] == "0001836057"
    assert first["period_end"] == "2025-12-31"
    # Sample assertion: first holding in this fixture is "Pure Storage Inc"
    assert first["issuer_name"] == "Pure Storage Inc"


def test_anthropic_holding_present(parsed):
    """Spot-check: BlackRock holds Anthropic in this filing (one of the
    motivating examples in PLAN_NPORT_HOLDINGS.md §1.2)."""
    _, holdings = parsed
    names = [h["issuer_name"] for h in holdings if h["issuer_name"]]
    matches = [n for n in names if "ANTHROPIC" in n.upper()]
    assert matches, "expected to find at least one ANTHROPIC issuer"
