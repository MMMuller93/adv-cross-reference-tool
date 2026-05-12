from __future__ import annotations

from nport.scraper.row_mapping import holding_row_for_db, parse_int


def test_parse_int_preserves_fair_value_level() -> None:
    assert parse_int("3") == 3
    assert parse_int("not-an-int") is None
    assert parse_int(None) is None


def test_holding_row_maps_fair_value_level_to_schema_column() -> None:
    row = {
        "accession_number": "0000000000-26-000001",
        "holding_id": "XML-000001",
        "issuer_name": "ANTHROPIC PBC",
        "fair_value_level": "3",
        "percentage": "1.25",
    }

    mapped = holding_row_for_db(
        row,
        {"resolution_source": "unresolved"},
        source_bulk_quarter="daily-scrape",
    )

    assert mapped["fair_value_level"] == 3
    assert mapped["pct_of_nav"] == "1.25"
