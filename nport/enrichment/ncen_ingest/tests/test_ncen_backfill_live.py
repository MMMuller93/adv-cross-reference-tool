from __future__ import annotations

from pathlib import Path

from nport.enrichment.ncen_ingest.backfill_live import (
    normalize_crd,
    shape_link_rows,
    shape_summary_row,
)
from nport.enrichment.ncen_ingest.parser import parse_ncen_xml

HERE = Path(__file__).parent.resolve()


def test_normalize_crd_strips_sec_zero_padding():
    assert normalize_crd("000108281") == "108281"
    assert normalize_crd("108281") == "108281"
    assert normalize_crd("N/A") is None
    assert normalize_crd(None) is None


def test_shape_rows_preserve_raw_and_normalized_crd():
    filing = parse_ncen_xml((HERE / "ncen_fidelity_raw.xml").read_bytes())
    metadata = {
        "accession_number": "0000035402-26-001453",
        "filing_date": "2026-03-12",
        "report_date": "2026-01-31",
    }
    summary = shape_summary_row("24238", metadata, filing)
    assert summary["investment_adviser_crd"] == "108281"
    assert summary["series_id"] is None

    links = shape_link_rows(
        "24238",
        metadata,
        filing,
        "https://www.sec.gov/Archives/edgar/data/24238/000003540226001453/primary_doc.xml",
    )
    first = next(row for row in links if row["adviser_role"] == "investment_adviser")
    assert first["adviser_crd_raw"] == "000108281"
    assert first["adviser_crd_normalized"] == "108281"
    assert first["series_id"] == "S000006036"
    assert first["link_key"].startswith("0000035402-26-001453|investment_adviser|S000006036|108281")
