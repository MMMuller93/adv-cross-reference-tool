from __future__ import annotations

import json

from nport.scraper.db_client import DBClient


def test_insert_missing_registrants_does_not_write_address_nulls(tmp_path) -> None:
    stub = tmp_path / "writes.jsonl"
    db = DBClient(stub_path=stub, force_stub=True)

    db.insert_missing_registrants(
        [
            {
                "cik": "0001496608",
                "name": "AB Active ETFs, Inc.",
                "lei": "2549006ZG5WBMZRI5P66",
                "address_street1": None,
                "address_city": None,
                "phone": None,
                "last_filed_at": "2026-04-24",
            }
        ]
    )

    payload = json.loads(stub.read_text().splitlines()[0])
    assert payload["on_conflict"] == "cik:do_nothing"
    assert payload["row"] == {
        "cik": "0001496608",
        "name": "AB Active ETFs, Inc.",
        "lei": "2549006ZG5WBMZRI5P66",
        "last_filed_at": "2026-04-24",
    }
