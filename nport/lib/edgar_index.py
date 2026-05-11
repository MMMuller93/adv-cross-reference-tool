"""EDGAR submissions helper.

Given (cik, form_type, period_window), find the matching filing accession on EDGAR
via https://data.sec.gov/submissions/CIK{padded}.json.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date, datetime
from typing import Iterable, Optional

import requests

SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
SEC_ARCHIVE_BASE = "https://www.sec.gov/Archives/edgar/data"

DEFAULT_USER_AGENT = "PrivateFundsRadar Miles mmmuller93@gmail.com"
DEFAULT_RATE_LIMIT_SECS = 0.11  # SEC limits to ~10 req/s

# ---------------------------------------------------------------------------


@dataclass
class FilingRef:
    """A single EDGAR filing reference."""

    cik: str  # zero-padded 10-digit
    accession_number: str  # "0000024238-26-000028" format
    form_type: str
    filing_date: date
    primary_doc: Optional[str] = None  # e.g. "primary_doc.xml" or "filing10952.htm"
    report_date: Optional[date] = None
    is_xbrl: bool = False
    is_inline_xbrl: bool = False

    @property
    def accession_nodashes(self) -> str:
        return self.accession_number.replace("-", "")

    @property
    def archive_url(self) -> str:
        """URL of the filing index folder (no trailing slash)."""
        return f"{SEC_ARCHIVE_BASE}/{int(self.cik)}/{self.accession_nodashes}"

    def doc_url(self, doc: Optional[str] = None) -> str:
        doc = doc or self.primary_doc
        if not doc:
            raise ValueError("FilingRef has no primary_doc set and no doc was passed")
        return f"{self.archive_url}/{doc}"


# ---------------------------------------------------------------------------


def pad_cik(cik: str | int) -> str:
    """Return CIK zero-padded to 10 digits."""
    return f"{int(cik):010d}"


def _to_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def fetch_submissions(
    cik: str | int,
    *,
    user_agent: str = DEFAULT_USER_AGENT,
    rate_limit_secs: float = DEFAULT_RATE_LIMIT_SECS,
    session: Optional[requests.Session] = None,
    timeout: int = 30,
) -> dict:
    """Fetch the SEC submissions JSON for a CIK.

    Returns the parsed JSON dict. Raises requests.HTTPError on non-200.
    """
    padded = pad_cik(cik)
    url = SEC_SUBMISSIONS_URL.format(cik=padded)
    time.sleep(rate_limit_secs)
    s = session or requests
    resp = s.get(url, headers={"User-Agent": user_agent}, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def iter_filings(submissions: dict) -> Iterable[FilingRef]:
    """Iterate FilingRef objects from a submissions JSON.

    Only walks the `recent` block (which holds up to ~1000 most recent filings).
    For older filings, you'd need to also walk submissions["filings"]["files"];
    not implemented here as the use case is recent filings only.
    """
    cik = pad_cik(submissions.get("cik", "0"))
    recent = submissions.get("filings", {}).get("recent", {})
    if not recent:
        return

    forms = recent.get("form", [])
    accs = recent.get("accessionNumber", [])
    dates = recent.get("filingDate", [])
    primary_docs = recent.get("primaryDocument", [])
    report_dates = recent.get("reportDate", [])
    xbrl_flags = recent.get("isXBRL", [])
    inline_xbrl_flags = recent.get("isInlineXBRL", [])

    n = len(forms)
    for i in range(n):
        try:
            yield FilingRef(
                cik=cik,
                form_type=forms[i],
                accession_number=accs[i],
                filing_date=_to_date(dates[i]),
                primary_doc=primary_docs[i] if i < len(primary_docs) else None,
                report_date=_to_date(report_dates[i]) if i < len(report_dates) and report_dates[i] else None,
                is_xbrl=bool(xbrl_flags[i]) if i < len(xbrl_flags) else False,
                is_inline_xbrl=bool(inline_xbrl_flags[i]) if i < len(inline_xbrl_flags) else False,
            )
        except (IndexError, ValueError):
            continue


def find_filing(
    cik: str | int,
    form_types: Iterable[str],
    *,
    period_window: Optional[tuple[date, date]] = None,
    submissions: Optional[dict] = None,
    user_agent: str = DEFAULT_USER_AGENT,
    rate_limit_secs: float = DEFAULT_RATE_LIMIT_SECS,
    session: Optional[requests.Session] = None,
) -> Optional[FilingRef]:
    """Find the most-recent filing matching form_types within optional period_window.

    Args:
        cik: registrant CIK
        form_types: e.g. {"N-CEN"} or {"485BPOS","N-1A","N-2"}
        period_window: if given, (start, end) inclusive on filing_date

    Returns the latest FilingRef matching the criteria, or None.
    """
    form_set = {f.upper() for f in form_types}
    subs = submissions or fetch_submissions(
        cik, user_agent=user_agent, rate_limit_secs=rate_limit_secs, session=session
    )
    candidates: list[FilingRef] = []
    for f in iter_filings(subs):
        if f.form_type.upper() not in form_set:
            continue
        if period_window is not None:
            start, end = period_window
            if not (start <= f.filing_date <= end):
                continue
        candidates.append(f)

    if not candidates:
        return None
    candidates.sort(key=lambda r: r.filing_date, reverse=True)
    return candidates[0]


def fetch_document(
    url: str,
    *,
    user_agent: str = DEFAULT_USER_AGENT,
    rate_limit_secs: float = DEFAULT_RATE_LIMIT_SECS,
    session: Optional[requests.Session] = None,
    timeout: int = 60,
) -> bytes:
    """Fetch a single document from EDGAR archives. Returns raw bytes."""
    time.sleep(rate_limit_secs)
    s = session or requests
    resp = s.get(url, headers={"User-Agent": user_agent}, timeout=timeout)
    resp.raise_for_status()
    return resp.content
