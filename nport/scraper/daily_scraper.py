"""Daily NPORT-P / NPORT-P/A scraper + email alerts.

Modeled on data-pipeline/formd-scraper/daily_scraper_with_alerts.py. Same
skeleton: pull form.idx for the current quarter, parse out lines for the
target form types, skip already-ingested accessions, fetch + parse the
per-filing primary_doc.xml, apply the F4 filter, resolve, upsert.

Per PLAN_NPORT_HOLDINGS.md §6.2:
- Form types: NPORT-P, NPORT-P/A (only two variants exist — see
  verify_edgar_mechanics.md A3)
- Parser: lxml with namespace {"n": "http://www.sec.gov/edgar/nport"}
  (8.5x faster than xmltodict per the parsing seed benchmark)
- Email alerts: new tracked-company positions, >25% QoQ markups,
  new fund families holding a tracked company

Usage:
    python daily_scraper.py            # last 7 days
    python daily_scraper.py --days 1   # yesterday only
"""
from __future__ import annotations

import argparse
import re
import smtplib
import sys
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from lxml import etree

from .config import (
    EDGAR_BASE,
    GMAIL_APP_PASSWORD,
    GMAIL_USER,
    SEC_FORM_IDX_FMT,
)
from .db_client import DBClient
from .filter_f4 import (
    confidence_tag,
    normalize_issuer_name,
    passes_alias_branch,
    passes_f4,
    passes_loan_branch,
)
from .sec_client import SECClient

NPORT_NS = {"n": "http://www.sec.gov/edgar/nport"}
TARGET_FORM_TYPES = {"NPORT-P", "NPORT-P/A"}


# -----------------------------------------------------------------------------
# form.idx parsing
# -----------------------------------------------------------------------------
def parse_form_idx(
    content: str,
    days_back: int = 7,
    now: Optional[datetime] = None,
    target_forms: Set[str] = TARGET_FORM_TYPES,
) -> List[Dict[str, str]]:
    """Parse a form.idx file and return target-form filings within `days_back`.

    EDGAR form.idx has a 9-line header and is fixed-width-ish; the existing
    Form D scraper uses `re.split(r'\\s{2,}', line)` and that works here too.
    Accession is extracted from the file path with a regex.
    """
    now = now or datetime.now()
    cutoff = now - timedelta(days=days_back)
    filings: List[Dict[str, str]] = []

    lines = content.split("\n")
    # Skip header rows; data starts after the dashes line. Form D scraper
    # uses lines[9:] which works for both form indices.
    data_lines = lines[9:]

    for line in data_lines:
        if not line.strip():
            continue
        parts = re.split(r"\s{2,}", line.strip())
        if len(parts) < 5:
            continue
        form_type = parts[0].strip()
        if form_type not in target_forms:
            continue
        company_name = parts[1].strip()
        cik = parts[2].strip()
        date_filed = parts[3].strip()
        file_name = parts[4].strip()

        try:
            filing_date = datetime.strptime(date_filed, "%Y-%m-%d")
            if filing_date < cutoff:
                continue
        except ValueError:
            # If the date doesn't parse, keep the row — we'd rather over-ingest
            # than silently drop. The DB upsert is idempotent.
            pass

        # Accession from file_name. Most rows look like:
        #   edgar/data/{cik}/{accession_no_dashes}.txt  -> need to add dashes
        # The path may also use the dashed form already. Try both.
        accession: Optional[str] = None
        m = re.search(r"/(\d{10}-\d{2}-\d{6})\.txt$", file_name)
        if m:
            accession = m.group(1)
        else:
            m2 = re.search(r"/(\d{18})\.txt$", file_name)
            if m2:
                bare = m2.group(1)
                # Insert dashes: NNNNNNNNNN-NN-NNNNNN
                accession = f"{bare[:10]}-{bare[10:12]}-{bare[12:]}"
        if not accession:
            tail = file_name.rsplit("/", 1)[-1]
            accession = tail.replace(".txt", "")

        filings.append(
            {
                "form_type": form_type,
                "company_name": company_name,
                "cik": cik,
                "date_filed": date_filed,
                "accession_number": accession,
                "file_path": file_name,
            }
        )
    return filings


# -----------------------------------------------------------------------------
# Per-filing XML parsing
# -----------------------------------------------------------------------------
def parse_nport_xml(
    xml_bytes: bytes,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Parse a single primary_doc.xml. Returns (filing_meta, holdings_rows).

    `filing_meta` has the registrant + period fields needed for the
    `nport_filings` row. `holdings_rows` is one dict per `invstOrSec`.
    """
    root = etree.fromstring(xml_bytes)
    if not root.tag.endswith("edgarSubmission"):
        raise ValueError(f"unexpected root element: {root.tag}")

    def t(xpath: str) -> Optional[str]:
        return _text(root.findtext(xpath, namespaces=NPORT_NS))

    submission_type = t(".//n:submissionType")
    reg_cik = t(".//n:regCik")
    reg_name = t(".//n:regName")
    reg_lei = t(".//n:regLei")
    series_name = t(".//n:seriesName")
    series_lei = t(".//n:seriesLei")
    rep_pd_end = t(".//n:repPdEnd")
    rep_pd_date = t(".//n:repPdDate")
    tot_assets = t(".//n:fundInfo/n:totAssets")
    net_assets = t(".//n:fundInfo/n:netAssets")

    filing_meta = {
        "submission_type": submission_type,
        "registrant_cik": reg_cik,
        "registrant_name": reg_name,
        "registrant_lei": reg_lei,
        "series_name": series_name,
        "series_lei": series_lei,
        "period_end": rep_pd_end,
        "period_date": rep_pd_date,
        "total_assets": tot_assets,
        "net_assets": net_assets,
    }

    holdings: List[Dict[str, Any]] = []
    for sec in root.findall(".//n:invstOrSec", namespaces=NPORT_NS):
        def st(xpath: str) -> Optional[str]:
            return _text(sec.findtext(xpath, namespaces=NPORT_NS))

        # Per-filing identifiers block (free-form `<other otherDesc=...>`)
        ids: List[Dict[str, Optional[str]]] = []
        for other in sec.findall("n:identifiers/n:other", namespaces=NPORT_NS):
            ids.append(
                {
                    "other_id_desc": other.get("otherDesc"),
                    "value": other.get("value"),
                }
            )
        isin_node = sec.find("n:identifiers/n:isin", namespaces=NPORT_NS)
        isin = _text(isin_node.get("value")) if isin_node is not None else None
        ticker_node = sec.find("n:identifiers/n:ticker", namespaces=NPORT_NS)
        ticker = _text(ticker_node.get("value")) if ticker_node is not None else None

        holdings.append(
            {
                "registrant_cik": reg_cik,
                "period_end": rep_pd_end,
                "issuer_name": st("n:name"),
                "issuer_lei": st("n:lei"),
                "issuer_title": st("n:title"),
                "cusip": st("n:cusip"),
                "balance": st("n:balance"),
                "unit": st("n:units"),
                "currency_code": st("n:curCd"),
                "currency_value": st("n:valUSD"),
                "percentage": st("n:pctVal"),
                "payoff_profile": st("n:payoffProfile"),
                "asset_cat": st("n:assetCat"),
                "issuer_type": st("n:issuerCat"),
                "investment_country": st("n:invCountry"),
                "is_restricted": st("n:isRestrictedSec"),
                "fair_value_level": st("n:fairValLevel"),
                "identifiers": ids,
                "isin": isin,
                "ticker": ticker,
            }
        )
    return filing_meta, holdings


def _text(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    s = v.strip()
    return s or None


# -----------------------------------------------------------------------------
# Main scraper class
# -----------------------------------------------------------------------------
class DailyNPORTScraper:
    """Mirrors DailyFormDScraperWithAlerts structure exactly."""

    def __init__(
        self,
        sec_client: Optional[SECClient] = None,
        db_client: Optional[DBClient] = None,
        aliases_cache: Optional[Set[str]] = None,
        tracked_companies: Optional[Set[str]] = None,
        markup_threshold: float = 0.25,
        resolver=None,
    ):
        self.sec = sec_client or SECClient()
        self.db = db_client or DBClient()
        self.aliases_cache = aliases_cache or set()
        # Normalized issuer-name set for "new tracked-company position" alerts.
        # Empty by default — wire to a curated list in production.
        self.tracked_companies = tracked_companies or set()
        self.markup_threshold = markup_threshold
        # Bug 2 fix: pass a real seed-backed Resolver in. Was previously
        # `Resolver()` with no args which fed back a pass-through resolver
        # via the swallowing try/except.
        if resolver is None:
            from nport.scraper.backfill_bulk import _build_seed_resolver
            resolver = _build_seed_resolver()
        self._resolver = resolver
        self._alert_accumulator: Dict[str, List[Dict[str, Any]]] = {
            "new_tracked_positions": [],
            "large_markups": [],
            "new_fund_families": [],
        }

    def _get_resolver(self):
        return self._resolver

    # -- Top-level orchestration --------------------------------------------
    def get_current_quarter_info(self, now: Optional[datetime] = None):
        today = now or datetime.now()
        return today.year, (today.month - 1) // 3 + 1

    def download_index_file(self, year: int, quarter: int) -> Optional[str]:
        url = SEC_FORM_IDX_FMT.format(year=year, q=quarter)
        resp = self.sec.get(url)
        if resp.status_code == 200:
            return resp.text
        print(f"  index download returned HTTP {resp.status_code}")
        return None

    def download_primary_doc(
        self, cik: str, accession_number: str
    ) -> Tuple[Optional[bytes], Optional[str]]:
        """Fetch primary_doc.xml. Returns (bytes, error_message)."""
        cik_clean = cik.lstrip("0") if cik else accession_number.split("-")[0].lstrip("0")
        acc_clean = accession_number.replace("-", "")
        url = (
            f"{EDGAR_BASE}/Archives/edgar/data/{cik_clean}/{acc_clean}/primary_doc.xml"
        )
        resp = self.sec.get(url)
        if resp.status_code == 200:
            return resp.content, None
        return None, f"HTTP {resp.status_code}"

    # -- Per-filing handling ------------------------------------------------
    def process_filing(self, filing: Dict[str, str]) -> Optional[Dict[str, int]]:
        xml_bytes, err = self.download_primary_doc(
            filing["cik"], filing["accession_number"]
        )
        if xml_bytes is None:
            print(
                f"  download error for {filing['accession_number']}: {err}"
            )
            return None
        try:
            meta, holdings = parse_nport_xml(xml_bytes)
        except (etree.XMLSyntaxError, ValueError) as exc:
            print(f"  parse error for {filing['accession_number']}: {exc}")
            return None

        meta["accession_number"] = filing["accession_number"]
        meta["form_type"] = filing["form_type"]
        meta["filing_date"] = filing["date_filed"]
        self.db.upsert_filing(meta)

        resolver = self._get_resolver()
        kept_rows: List[Dict[str, Any]] = []
        for row in holdings:
            if (
                passes_f4(row)
                or passes_loan_branch(row)
                or passes_alias_branch(row, self.aliases_cache)
            ):
                row["accession_number"] = filing["accession_number"]
                row["confidence"] = confidence_tag(row)
                resolved = resolver.resolve(row)
                # Bug 3 fix: merge resolver output into the raw row so the
                # holding's raw fields survive alongside resolver-added fields.
                merged = {**row, **resolved}
                kept_rows.append(merged)
                self._maybe_collect_alerts(merged, filing)

        upserted = self.db.upsert_holding(kept_rows) if kept_rows else 0
        return {
            "holdings_total": len(holdings),
            "holdings_kept": upserted,
        }

    def _maybe_collect_alerts(
        self, row: Dict[str, Any], filing: Dict[str, str]
    ) -> None:
        """Stash anything noteworthy for the end-of-run email summary."""
        nname = normalize_issuer_name(row.get("issuer_name"))
        if nname and nname in self.tracked_companies:
            self._alert_accumulator["new_tracked_positions"].append(
                {
                    "issuer": row.get("issuer_name"),
                    "fund_cik": row.get("registrant_cik"),
                    "accession": filing["accession_number"],
                    "value_usd": row.get("currency_value"),
                }
            )
        # Markup detection is a stub — real QoQ comparison requires reading
        # the previous-period row from the DB. Surface the hook now so the
        # alert plumbing is in place when the DB is live.
        # See PLAN §6.2 alert requirement #2.
        # self._alert_accumulator["large_markups"].append(...)

    # -- Email ---------------------------------------------------------------
    def send_email_alert(self, totals: Dict[str, int]) -> None:
        """Send summary email. No-op if GMAIL_APP_PASSWORD isn't set."""
        if not GMAIL_APP_PASSWORD:
            print(
                "[daily] GMAIL_APP_PASSWORD not set in env — skipping email"
            )
            return

        tracked = self._alert_accumulator["new_tracked_positions"]
        markups = self._alert_accumulator["large_markups"]
        families = self._alert_accumulator["new_fund_families"]

        subject = (
            f"N-PORT Daily: "
            f"{totals.get('filings_parsed', 0)} filings, "
            f"{len(tracked)} new tracked positions, "
            f"{len(markups)} markup alerts"
        )
        html_parts = [
            "<html><body>",
            f"<h2>N-PORT Daily Report</h2>",
            f"<p>Filings parsed: {totals.get('filings_parsed', 0)}</p>",
            f"<p>Holdings kept (F4 + loan + alias): "
            f"{totals.get('holdings_kept', 0)}</p>",
        ]
        if tracked:
            html_parts.append("<h3>New tracked-company positions</h3><ul>")
            for t in tracked:
                html_parts.append(
                    f"<li>{t['issuer']} held by CIK {t['fund_cik']} "
                    f"(accession {t['accession']}, ${t.get('value_usd') or 'N/A'})</li>"
                )
            html_parts.append("</ul>")
        if markups:
            html_parts.append("<h3>Large QoQ markups (>25%)</h3><ul>")
            for m in markups:
                html_parts.append(f"<li>{m}</li>")
            html_parts.append("</ul>")
        if families:
            html_parts.append("<h3>New fund families holding tracked companies</h3><ul>")
            for fam in families:
                html_parts.append(f"<li>{fam}</li>")
            html_parts.append("</ul>")
        html_parts.append("</body></html>")
        body = "".join(html_parts)

        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = GMAIL_USER
            msg["To"] = GMAIL_USER
            msg.attach(MIMEText(body, "html"))
            with smtplib.SMTP_SSL("smtp.gmail.com", 465) as srv:
                srv.login(GMAIL_USER, GMAIL_APP_PASSWORD)
                srv.send_message(msg)
            print(f"[daily] alert email sent ({len(tracked)} tracked positions)")
        except Exception as exc:  # noqa: BLE001
            print(f"[daily] email send failed: {exc}")

    # -- Main run ------------------------------------------------------------
    def run(self, days_back: int = 7, now: Optional[datetime] = None) -> Dict[str, int]:
        year, q = self.get_current_quarter_info(now=now)
        print("=" * 80)
        print(f"DAILY N-PORT SCRAPER (LAST {days_back} DAYS) -- {year}Q{q}")
        print("=" * 80)

        idx = self.download_index_file(year, q)
        if idx is None:
            print("ERROR: could not download form.idx")
            return {"filings_seen": 0}

        filings = parse_form_idx(idx, days_back=days_back, now=now)
        print(f"Found {len(filings)} NPORT-P / NPORT-P/A filings in window")

        # In a stubbed run we don't have a DB to dedupe against; live mode
        # would query `nport_filings` by accession before processing. Keep
        # the call site explicit so the swap is obvious.
        new_filings = filings

        totals = {"filings_seen": len(filings), "filings_parsed": 0, "holdings_kept": 0}
        for i, f in enumerate(new_filings, 1):
            res = self.process_filing(f)
            if res:
                totals["filings_parsed"] += 1
                totals["holdings_kept"] += res.get("holdings_kept", 0)
            if i % 25 == 0 or i == len(new_filings):
                print(f"  {i}/{len(new_filings)} processed")

        self.send_email_alert(totals)
        print("=" * 80)
        print(f"DONE. {totals}")
        return totals


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------
def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Daily N-PORT scraper + alerts")
    p.add_argument("--days", type=int, default=7, help="Look-back window in days")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = _parse_args(argv)
    scraper = DailyNPORTScraper()
    scraper.run(days_back=args.days)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
