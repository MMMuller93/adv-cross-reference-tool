"""Daily N-CEN scraper.

Mirrors the pattern in `data-pipeline/formd-scraper/daily_scraper_with_alerts.py`:
walk the SEC EDGAR full-index for the current quarter, filter rows whose
form-type matches `N-CEN` (or `N-CEN/A`), fetch each filing's `primary_doc.xml`,
parse, and yield records ready for upsert.

Persistence is intentionally NOT included here — the caller decides whether to
upsert to Supabase, write to a local SQLite, or just print. Keep the scraper
side-effect-free below the I/O boundary.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable, Iterator, Optional

import requests

from .parser import NCenFiling, parse_ncen_xml

LOG = logging.getLogger(__name__)

FORM_INDEX_BASE = "https://www.sec.gov/Archives/edgar/full-index"
EDGAR_BASE = "https://www.sec.gov/Archives/edgar/data"
DEFAULT_USER_AGENT = "PrivateFundsRadar Miles mmmuller93@gmail.com"
DEFAULT_RATE_LIMIT = 0.11  # SEC limits to 10 req/s

NCEN_FORM_TYPES = {"N-CEN", "N-CEN/A"}


@dataclass
class NCenIndexRow:
    form_type: str
    company_name: str
    cik: str
    date_filed: str
    file_path: str  # like "edgar/data/24238/0000024238-26-000028-index.htm"

    @property
    def accession_from_path(self) -> str:
        """Extract '0000024238-26-000028' style accession from the file_path."""
        m = re.search(r"(\d{10}-\d{2}-\d{6})", self.file_path)
        return m.group(1) if m else ""


class DailyNCenScraper:
    """Walk full-index/form.idx, find new N-CEN filings, fetch + parse."""

    def __init__(
        self,
        user_agent: str = DEFAULT_USER_AGENT,
        rate_limit: float = DEFAULT_RATE_LIMIT,
        session: Optional[requests.Session] = None,
    ):
        self.headers = {"User-Agent": user_agent}
        self.rate_limit = rate_limit
        self.session = session or requests.Session()

    # ----- helpers -----

    @staticmethod
    def current_quarter() -> tuple[int, int]:
        today = datetime.utcnow()
        return today.year, (today.month - 1) // 3 + 1

    def _get(self, url: str, timeout: int = 30) -> requests.Response:
        time.sleep(self.rate_limit)
        resp = self.session.get(url, headers=self.headers, timeout=timeout)
        resp.raise_for_status()
        return resp

    # ----- index walking -----

    def download_form_index(self, year: int, quarter: int) -> str:
        url = f"{FORM_INDEX_BASE}/{year}/QTR{quarter}/form.idx"
        return self._get(url).text

    def parse_form_index(self, content: str, *, days_back: int = 7) -> Iterator[NCenIndexRow]:
        """Yield index rows where form_type matches N-CEN and filing date is recent."""
        cutoff = datetime.utcnow() - timedelta(days=days_back)
        # form.idx header is 9 fixed lines; data follows
        for line in content.splitlines()[9:]:
            if not line.strip():
                continue
            parts = re.split(r"\s{2,}", line.strip())
            if len(parts) < 5:
                continue
            form_type = parts[0].strip()
            if form_type not in NCEN_FORM_TYPES:
                continue
            company_name = parts[1].strip()
            cik = parts[2].strip()
            date_filed = parts[3].strip()
            file_path = parts[4].strip()
            try:
                filing_date = datetime.strptime(date_filed, "%Y-%m-%d")
            except ValueError:
                continue
            if filing_date < cutoff:
                continue
            yield NCenIndexRow(
                form_type=form_type,
                company_name=company_name,
                cik=cik,
                date_filed=date_filed,
                file_path=file_path,
            )

    # ----- per-filing fetch + parse -----

    def fetch_and_parse(self, row: NCenIndexRow) -> Optional[NCenFiling]:
        accession = row.accession_from_path
        if not accession:
            LOG.warning("Could not extract accession from path: %s", row.file_path)
            return None
        accession_nodashes = accession.replace("-", "")
        # N-CEN primary doc is always primary_doc.xml per the EDGAR submission convention
        url = f"{EDGAR_BASE}/{int(row.cik)}/{accession_nodashes}/primary_doc.xml"
        try:
            resp = self._get(url, timeout=60)
        except requests.HTTPError as exc:
            LOG.error("HTTP error fetching %s: %s", url, exc)
            return None
        try:
            return parse_ncen_xml(resp.content)
        except Exception as exc:  # noqa: BLE001
            LOG.error("Parse error for %s: %s", accession, exc)
            return None

    # ----- top-level loop -----

    def run(self, *, days_back: int = 7, year: Optional[int] = None, quarter: Optional[int] = None) -> Iterator[tuple[NCenIndexRow, NCenFiling]]:
        """Run a single pass; yield (index_row, parsed_filing) for each successful filing."""
        if year is None or quarter is None:
            y, q = self.current_quarter()
            year = year or y
            quarter = quarter or q
        idx_content = self.download_form_index(year, quarter)
        for row in self.parse_form_index(idx_content, days_back=days_back):
            parsed = self.fetch_and_parse(row)
            if parsed is not None:
                yield row, parsed


def main(argv: Optional[list[str]] = None) -> int:  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="Daily N-CEN ingestor")
    parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="Look-back window in days (default: 7)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO)
    scraper = DailyNCenScraper()
    count = 0
    for row, filing in scraper.run(days_back=args.days):
        advisers = filing.investment_advisers
        subs = filing.sub_advisers
        print(
            f"{row.date_filed}  CIK={row.cik}  {filing.registrant_name!r}  "
            f"advisers={len(advisers)}  subadvisers={len(subs)}"
        )
        count += 1
    print(f"Done. {count} N-CEN filings parsed.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
