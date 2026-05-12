from __future__ import annotations

from nport.scraper.daily_scraper import _useful_identifier_rows_for_holding


def test_daily_identifier_rows_keep_only_useful_descriptors() -> None:
    rows = _useful_identifier_rows_for_holding(
        {
            "holding_id": "0000000000-26-000001:XML-000001",
            "identifiers": [
                {"other_id_desc": "LoanX ID", "value": "LX123"},
                {"other_id_desc": "USER DEFINED", "value": "INTERNAL"},
            ],
            "isin": "US0000000000",
            "ticker": "PUB",
        }
    )

    assert rows == [
        {
            "holding_id": "0000000000-26-000001:XML-000001",
            "identifiers_id": "0000000000-26-000001:XML-000001-other-1",
            "isin": None,
            "ticker": None,
            "other_identifier": "LX123",
            "other_id_desc": "LoanX ID",
            "source_bulk_quarter": "daily-scrape",
        }
    ]
