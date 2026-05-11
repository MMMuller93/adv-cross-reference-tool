"""Tests for form.idx parsing in daily_scraper.parse_form_idx.

The five sample NPORT-P lines come verbatim from
/tmp/nport_research/verify_edgar_mechanics.md A1 (2026 QTR1 form.idx).
"""
from __future__ import annotations

from datetime import datetime

from nport.scraper.daily_scraper import parse_form_idx

# Build a minimal form.idx — 9 header lines + the 5 NPORT-P samples + a
# few decoys that must be filtered out (Form D, N-CEN, NPORT-EX).
HEADER_BLOCK = "\n".join(
    [
        "Description:           Master Index of EDGAR Dissemination Feed",
        "Last Data Received:    March 31, 2026",
        "Comments:              webmaster@sec.gov",
        "Anonymous FTP:         ftp://ftp.sec.gov/edgar/",
        "",
        "",
        " ",
        "Form Type   Company Name                                                  CIK         Date Filed  File Name",
        "----------  --------------------------------------------------------------  ----------  ----------  ----------------------------------------",
    ]
)

# Each line is left-padded to fixed positions; the form.idx file uses
# multi-space separation between columns.
NPORT_LINES = [
    "NPORT-P          1290 Funds                                                    1605941     2026-03-25  edgar/data/1605941/0002071691-26-006515.txt",
    "NPORT-P          Advisors Preferred Trust                                      1556505     2026-02-20  edgar/data/1556505/0000910472-26-001940.txt",
    "NPORT-P          Goldman Sachs ETF Trust                                       1479026     2026-01-27  edgar/data/1479026/0000940400-26-002582.txt",
    "NPORT-P          SPDR INDEX SHARES FUNDS                                       1168164     2026-02-26  edgar/data/1168164/0001410368-26-020047.txt",
    "NPORT-P          iSHARES TRUST                                                 1100663     2026-03-27  edgar/data/1100663/0002071691-26-007300.txt",
]

# Amendments — should also be included
AMEND_LINE = (
    "NPORT-P/A        Example Trust                                                 9999999     2026-03-20  edgar/data/9999999/0009999999-26-000001.txt"
)

# Decoys — should be skipped
DECOY_LINES = [
    "D                Some Issuer LLC                                               1234567     2026-03-25  edgar/data/1234567/0001234567-26-000001.txt",
    "N-CEN            Vanguard Whatever                                             0000036405  2026-03-12  edgar/data/36405/0000036405-26-000103.txt",
    "NPORT-EX         Should Not Match                                              7777777     2026-03-30  edgar/data/7777777/0007777777-26-000007.txt",
]

SAMPLE_IDX = (
    HEADER_BLOCK
    + "\n"
    + "\n".join(NPORT_LINES + [AMEND_LINE] + DECOY_LINES)
    + "\n"
)


def _ref_now():
    """Pin "now" so the days_back window deterministically includes all sample dates."""
    return datetime(2026, 4, 5)


def test_target_form_types_are_kept():
    filings = parse_form_idx(SAMPLE_IDX, days_back=120, now=_ref_now())
    types = [f["form_type"] for f in filings]
    # 5 NPORT-P + 1 NPORT-P/A == 6
    assert len(filings) == 6
    assert types.count("NPORT-P") == 5
    assert types.count("NPORT-P/A") == 1


def test_decoy_forms_are_skipped():
    filings = parse_form_idx(SAMPLE_IDX, days_back=120, now=_ref_now())
    for f in filings:
        assert f["form_type"] in {"NPORT-P", "NPORT-P/A"}, (
            f"unexpected form type: {f['form_type']}"
        )


def test_accession_extraction():
    filings = parse_form_idx(SAMPLE_IDX, days_back=120, now=_ref_now())
    by_cik = {f["cik"]: f for f in filings}
    # Spot-check the per-cik accession extraction
    assert by_cik["1605941"]["accession_number"] == "0002071691-26-006515"
    assert by_cik["1100663"]["accession_number"] == "0002071691-26-007300"
    assert by_cik["9999999"]["accession_number"] == "0009999999-26-000001"


def test_company_name_extraction():
    filings = parse_form_idx(SAMPLE_IDX, days_back=120, now=_ref_now())
    names = {f["cik"]: f["company_name"] for f in filings}
    assert names["1605941"] == "1290 Funds"
    assert names["1100663"] == "iSHARES TRUST"


def test_days_back_window_excludes_old_filings():
    """With a 5-day window pinned to 2026-04-05, only filings >= 2026-03-31
    should remain. None of our sample lines qualify -> 0 results."""
    filings = parse_form_idx(SAMPLE_IDX, days_back=5, now=_ref_now())
    assert filings == []


def test_filing_date_preserved():
    filings = parse_form_idx(SAMPLE_IDX, days_back=120, now=_ref_now())
    by_cik = {f["cik"]: f for f in filings}
    assert by_cik["1605941"]["date_filed"] == "2026-03-25"
    assert by_cik["1479026"]["date_filed"] == "2026-01-27"
