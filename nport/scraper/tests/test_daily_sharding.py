from __future__ import annotations

import pytest

from nport.scraper.daily_scraper import (
    exclude_bulk_loaded_filings,
    shard_filings,
    validate_aggregate_sec_rate,
)


def test_shard_filings_covers_each_filing_once() -> None:
    filings = [{"accession_number": str(i)} for i in range(10)]

    shards = [
        shard_filings(filings, shard_index=i, shard_count=3)
        for i in range(3)
    ]

    flattened = [row["accession_number"] for shard in shards for row in shard]
    assert sorted(flattened, key=int) == [str(i) for i in range(10)]
    assert len(flattened) == len(set(flattened))


def test_shard_filings_rejects_invalid_args() -> None:
    with pytest.raises(ValueError):
        shard_filings([], shard_index=0, shard_count=0)

    with pytest.raises(ValueError):
        shard_filings([], shard_index=2, shard_count=2)


def test_exclude_bulk_loaded_filings_skips_only_bulk_accessions() -> None:
    filings = [
        {"accession_number": "0000000000-26-000001"},
        {"accession_number": "0000000000-26-000002"},
    ]

    filtered = exclude_bulk_loaded_filings(
        filings,
        {"0000000000-26-000001"},
    )

    assert filtered == [{"accession_number": "0000000000-26-000002"}]


def test_validate_aggregate_sec_rate_rejects_unsafe_shards() -> None:
    validate_aggregate_sec_rate(shard_count=1, per_process_interval=0.12)
    validate_aggregate_sec_rate(shard_count=4, per_process_interval=0.50)

    with pytest.raises(ValueError, match="unsafe aggregate SEC request rate"):
        validate_aggregate_sec_rate(shard_count=4, per_process_interval=0.12)
