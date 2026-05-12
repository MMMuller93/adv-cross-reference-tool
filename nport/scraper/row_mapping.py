"""Schema-aware row mapping for N-PORT ingestion.

The scraper-level parsers work with SEC-native names (``CURRENCY_VALUE``,
``PERCENTAGE``, XML ``valUSD``/``pctVal``). This module is the single place
that maps those rows into the live Postgres column names from
``nport/migrations/001_create_schema.sql``.
"""
from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping


REGISTRANT_COLUMNS = (
    "cik",
    "name",
    "lei",
    "address_street1",
    "address_street2",
    "address_city",
    "address_state",
    "address_zip",
    "address_country",
    "phone",
    "last_filed_at",
)

FILING_COLUMNS = (
    "accession_number",
    "cik",
    "registrant_name",
    "registrant_lei",
    "series_id",
    "series_name",
    "series_lei",
    "report_period_end",
    "report_period_date",
    "is_amendment",
    "is_final_filing",
    "filing_date",
    "net_assets_usd",
    "total_assets_usd",
    "fund_type",
    "is_interval_fund",
    "is_variable_insurance",
    "source_bulk_quarter",
    "source_url",
)

HOLDING_COLUMNS = (
    "accession_number",
    "holding_id",
    "issuer_name",
    "issuer_title",
    "issuer_lei",
    "issuer_cusip",
    "balance",
    "unit",
    "other_unit_desc",
    "currency_code",
    "currency_value_usd",
    "exchange_rate",
    "pct_of_nav",
    "payoff_profile",
    "asset_cat",
    "other_asset",
    "issuer_type",
    "other_issuer",
    "investment_country",
    "is_restricted_security",
    "fair_value_level",
    "derivative_cat",
    "resolved_company_id",
    "resolution_source",
    "resolution_confidence",
    "exposure_type",
    "underlier_issuer_name",
    "share_class_normalized",
    "source_bulk_quarter",
)

IDENTIFIER_COLUMNS = (
    "holding_id",
    "identifiers_id",
    "isin",
    "ticker",
    "other_identifier",
    "other_id_desc",
    "source_bulk_quarter",
)

TABLE_COLUMNS = {
    "nport_registrants": REGISTRANT_COLUMNS,
    "nport_filings": FILING_COLUMNS,
    "nport_holdings": HOLDING_COLUMNS,
    "nport_identifiers": IDENTIFIER_COLUMNS,
}

_DATE_FORMATS = ("%Y-%m-%d", "%d-%b-%Y", "%d-%B-%Y")
_VI_RE = re.compile(r"(variable insurance|vip|sub-account|separate account)", re.I)


def clean_value(value: Any, *, na_is_null: bool = True) -> Any:
    """Normalize blank SEC strings to ``None`` while preserving real values."""
    if value is None:
        return None
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text:
        return None
    if na_is_null and text.upper() == "N/A":
        return None
    return text


def normalize_keys(row: Mapping[str, Any]) -> dict[str, Any]:
    """Lower-case SEC column names and normalize empty/N/A values."""
    return {str(k).lower().strip(): clean_value(v) for k, v in row.items() if k is not None}


def parse_sec_date(value: Any) -> str | None:
    """Parse SEC date strings into ISO ``YYYY-MM-DD`` dates."""
    text = clean_value(value)
    if text is None:
        return None
    if not isinstance(text, str):
        text = str(text)
    text = text.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text.title(), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_bool(value: Any) -> bool | None:
    text = clean_value(value)
    if text is None:
        return None
    if isinstance(text, bool):
        return text
    return str(text).strip().upper() in {"Y", "YES", "TRUE", "T", "1"}


def parse_int(value: Any) -> int | None:
    text = clean_value(value)
    if text is None:
        return None
    try:
        return int(str(text))
    except ValueError:
        return None


def schema_safe_pct_of_nav(value: Any) -> str | None:
    """Return a pct_of_nav value that fits ``numeric(12,8)``, else ``None``.

    A real 2024Q4 row reports ``-13123.0414480384`` for Altaba, which cannot
    fit the schema and is not a meaningful percent-of-NAV value. Preserve the
    holding but null the anomalous percentage rather than dropping the row.
    """
    text = clean_value(value)
    if text is None:
        return None
    try:
        parsed = Decimal(str(text))
    except (InvalidOperation, ValueError):
        return None
    if abs(parsed) >= Decimal("10000"):
        return None
    return str(text)


def shape_row(table: str, row: Mapping[str, Any]) -> dict[str, Any]:
    """Return a stable-key row for a table, rejecting unknown table names."""
    if table not in TABLE_COLUMNS:
        raise KeyError(f"no schema column mapping registered for {table}")
    shaped = {column: row.get(column) for column in TABLE_COLUMNS[table]}
    if table == "nport_filings":
        for key in ("is_amendment", "is_final_filing", "is_interval_fund", "is_variable_insurance"):
            if shaped.get(key) is None:
                shaped[key] = False
    return shaped


def registrant_row_for_db(
    raw_registrant: Mapping[str, Any],
    *,
    filing_date: Any = None,
) -> dict[str, Any]:
    row = normalize_keys(raw_registrant)
    return shape_row(
        "nport_registrants",
        {
            "cik": row.get("cik"),
            "name": row.get("registrant_name") or row.get("name"),
            "lei": row.get("lei"),
            "address_street1": row.get("address1") or row.get("address_street1"),
            "address_street2": row.get("address2") or row.get("address_street2"),
            "address_city": row.get("city") or row.get("address_city"),
            "address_state": row.get("state") or row.get("address_state"),
            "address_zip": row.get("zip") or row.get("address_zip"),
            "address_country": row.get("country") or row.get("address_country"),
            "phone": row.get("phone"),
            "last_filed_at": parse_sec_date(filing_date),
        },
    )


def classify_fund(registrant_name: Any, series_name: Any) -> dict[str, Any]:
    text = f"{registrant_name or ''} {series_name or ''}"
    lower = text.lower()
    is_vi = bool(_VI_RE.search(text))
    is_interval = "interval" in lower
    if is_interval:
        fund_type = "interval"
    elif "closed-end" in lower or "closed end" in lower or "term trust" in lower:
        fund_type = "closed_end"
    elif "etf" in lower or "exchange-traded" in lower:
        fund_type = "etf"
    else:
        fund_type = "unknown"
    return {
        "fund_type": fund_type,
        "is_interval_fund": is_interval,
        "is_variable_insurance": is_vi,
    }


def filing_row_from_bulk(
    accession_number: str,
    *,
    registrant: Mapping[str, Any] | None,
    fund_info: Mapping[str, Any] | None,
    submission: Mapping[str, Any] | None,
    source_bulk_quarter: str,
    source_url: str | None = None,
) -> dict[str, Any]:
    reg = normalize_keys(registrant or {})
    fund = normalize_keys(fund_info or {})
    sub = normalize_keys(submission or {})
    report_period_end = parse_sec_date(sub.get("report_ending_period"))
    report_period_date = parse_sec_date(sub.get("report_date")) or report_period_end
    filing_date = parse_sec_date(sub.get("filing_date")) or report_period_end
    sub_type = (sub.get("sub_type") or "").upper()
    classification = classify_fund(reg.get("registrant_name"), fund.get("series_name"))
    return shape_row(
        "nport_filings",
        {
            "accession_number": accession_number,
            "cik": reg.get("cik"),
            "registrant_name": reg.get("registrant_name"),
            "registrant_lei": reg.get("lei"),
            "series_id": fund.get("series_id"),
            "series_name": fund.get("series_name"),
            "series_lei": fund.get("series_lei"),
            "report_period_end": report_period_end,
            "report_period_date": report_period_date,
            "is_amendment": sub_type.endswith("/A"),
            "is_final_filing": parse_bool(sub.get("is_last_filing")) or False,
            "filing_date": filing_date,
            "net_assets_usd": fund.get("net_assets"),
            "total_assets_usd": fund.get("total_assets"),
            "source_bulk_quarter": source_bulk_quarter,
            "source_url": source_url,
            **classification,
        },
    )


def filing_row_from_daily(
    meta: Mapping[str, Any],
    filing: Mapping[str, Any],
    *,
    source_url: str | None = None,
) -> dict[str, Any]:
    report_period_end = parse_sec_date(meta.get("period_end"))
    report_period_date = parse_sec_date(meta.get("period_date")) or report_period_end
    filing_date = parse_sec_date(filing.get("date_filed")) or report_period_end
    form_type = (filing.get("form_type") or meta.get("submission_type") or "").upper()
    classification = classify_fund(meta.get("registrant_name"), meta.get("series_name"))
    return shape_row(
        "nport_filings",
        {
            "accession_number": filing.get("accession_number"),
            "cik": meta.get("registrant_cik") or filing.get("cik"),
            "registrant_name": meta.get("registrant_name") or filing.get("company_name"),
            "registrant_lei": meta.get("registrant_lei"),
            "series_id": meta.get("series_id"),
            "series_name": meta.get("series_name"),
            "series_lei": meta.get("series_lei"),
            "report_period_end": report_period_end,
            "report_period_date": report_period_date,
            "is_amendment": form_type.endswith("/A"),
            "is_final_filing": False,
            "filing_date": filing_date,
            "net_assets_usd": meta.get("net_assets"),
            "total_assets_usd": meta.get("total_assets"),
            "source_bulk_quarter": "daily-scrape",
            "source_url": source_url,
            **classification,
        },
    )


def holding_filter_row_from_tsv(raw_holding: Mapping[str, Any]) -> dict[str, Any]:
    row = normalize_keys(raw_holding)
    return {
        "accession_number": row.get("accession_number"),
        "holding_id": row.get("holding_id"),
        "issuer_name": row.get("issuer_name"),
        "issuer_lei": row.get("issuer_lei"),
        "issuer_title": row.get("issuer_title"),
        "cusip": row.get("issuer_cusip"),
        "balance": row.get("balance"),
        "unit": row.get("unit"),
        "other_unit_desc": row.get("other_unit_desc"),
        "currency_code": row.get("currency_code"),
        "currency_value": row.get("currency_value"),
        "exchange_rate": row.get("exchange_rate"),
        "percentage": row.get("percentage"),
        "payoff_profile": row.get("payoff_profile"),
        "asset_cat": row.get("asset_cat"),
        "other_asset": row.get("other_asset"),
        "issuer_type": row.get("issuer_type"),
        "other_issuer": row.get("other_issuer"),
        "investment_country": row.get("investment_country"),
        "is_restricted": row.get("is_restricted_security"),
        "fair_value_level": row.get("fair_value_level"),
        "derivative_cat": row.get("derivative_cat"),
    }


def holding_row_for_db(
    row: Mapping[str, Any],
    resolution: Mapping[str, Any],
    *,
    source_bulk_quarter: str,
) -> dict[str, Any]:
    issuer_name = clean_value(row.get("issuer_name")) or clean_value(row.get("issuer_title")) or "N/A"
    merged = {
        "accession_number": row.get("accession_number"),
        "holding_id": row.get("holding_id"),
        "issuer_name": issuer_name,
        "issuer_title": row.get("issuer_title"),
        "issuer_lei": row.get("issuer_lei"),
        "issuer_cusip": row.get("cusip"),
        "balance": row.get("balance"),
        "unit": row.get("unit"),
        "other_unit_desc": row.get("other_unit_desc"),
        "currency_code": row.get("currency_code"),
        "currency_value_usd": row.get("currency_value"),
        "exchange_rate": row.get("exchange_rate"),
        "pct_of_nav": schema_safe_pct_of_nav(row.get("percentage")),
        "payoff_profile": row.get("payoff_profile"),
        "asset_cat": row.get("asset_cat"),
        "other_asset": row.get("other_asset"),
        "issuer_type": row.get("issuer_type"),
        "other_issuer": row.get("other_issuer"),
        "investment_country": row.get("investment_country"),
        "is_restricted_security": parse_bool(row.get("is_restricted")),
        "fair_value_level": parse_int(row.get("fair_value_level")),
        "derivative_cat": row.get("derivative_cat"),
        "source_bulk_quarter": source_bulk_quarter,
        **dict(resolution),
    }
    return shape_row("nport_holdings", merged)


def identifier_row_for_db(
    raw_identifier: Mapping[str, Any],
    *,
    source_bulk_quarter: str,
) -> dict[str, Any] | None:
    row = normalize_keys(raw_identifier)
    identifiers_id = row.get("identifiers_id") or row.get("id")
    holding_id = row.get("holding_id")
    if not holding_id or not identifiers_id:
        return None
    return shape_row(
        "nport_identifiers",
        {
            "holding_id": holding_id,
            "identifiers_id": identifiers_id,
            "isin": row.get("isin") or row.get("identifier_isin"),
            "ticker": row.get("ticker") or row.get("identifier_ticker"),
            "other_identifier": row.get("other_identifier") or row.get("otheridentifier"),
            "other_id_desc": (
                row.get("other_id_desc")
                or row.get("otheridentifierdesc")
                or row.get("other_identifier_desc")
            ),
            "source_bulk_quarter": source_bulk_quarter,
        },
    )


__all__ = [
    "FILING_COLUMNS",
    "HOLDING_COLUMNS",
    "IDENTIFIER_COLUMNS",
    "REGISTRANT_COLUMNS",
    "TABLE_COLUMNS",
    "classify_fund",
    "clean_value",
    "filing_row_from_bulk",
    "filing_row_from_daily",
    "holding_filter_row_from_tsv",
    "holding_row_for_db",
    "identifier_row_for_db",
    "normalize_keys",
    "parse_bool",
    "parse_int",
    "parse_sec_date",
    "registrant_row_for_db",
    "shape_row",
]
