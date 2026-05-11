"""
email_alerts.py — Format and dispatch SMTP alerts for N-PORT delta events.

Four alert types (PLAN §3.3, §6.8, and the task brief):
    - new_tracked_company_position : a tracked private company appeared in
        a fund's holdings for the first time
    - pure_markup_over_25          : balance unchanged, mark moved up >25%
    - new_fund_family              : a fund-family (registrant) appeared
        as a holder of a tracked company for the first time
    - coordinated_repricing        : >= MIN_FUND_COUNT funds marked the same
        company to the same exact $/share on the same period (SpaceX 2x)

SMTP transport mirrors data-pipeline/formd-scraper/daily_scraper_with_alerts.py
(Gmail over SMTP_SSL on 465 with an App Password) but with one CRITICAL
difference: the App Password is loaded from the GMAIL_APP_PASSWORD env var.
NEVER hardcoded. NEVER committed. If the env var is missing, the module
falls back to a "dry-run" mode that prints the email payload to stdout so
local tests still work.
"""

from __future__ import annotations

import logging
import os
import smtplib
from dataclasses import dataclass
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Iterable

from .compute_deltas import PositionDelta
from .repricing_event_detector import RepricingEvent


log = logging.getLogger("nport.email_alerts")


# Threshold in PERCENT (not fraction) for the pure-markup alert. PLAN §3.3
# observed a 35:1 markup:markdown ratio with most markups in the 50-100%
# range; 25% picks up meaningful re-marks without firing on routine valuation
# noise on illiquid positions.
PURE_MARKUP_THRESHOLD_PCT = 25.0


@dataclass
class AlertPayload:
    """Plain shape passed to the sender. Tests assert on this directly
    instead of inspecting MIME output."""

    alert_type: str
    subject: str
    html_body: str
    plain_body: str


# --------------------------------------------------------------- formatters
def _company_name(d: PositionDelta, company_name_lookup: dict[str, str] | None) -> str:
    if company_name_lookup and d.company_id in company_name_lookup:
        return company_name_lookup[d.company_id]
    return d.company_id  # fallback: raw uuid


def format_new_position_alert(
    new_positions: list[PositionDelta],
    company_name_lookup: dict[str, str] | None = None,
) -> AlertPayload | None:
    """One email summarizing all new tracked-company positions in the batch."""
    if not new_positions:
        return None

    rows_html = []
    rows_text = []
    for d in new_positions:
        cname = _company_name(d, company_name_lookup)
        val = f"${d.current_value_usd:,.0f}" if d.current_value_usd is not None else "n/a"
        rows_html.append(
            f"<tr><td>{cname}</td><td>{d.registrant_id}</td><td>{d.series_id}</td>"
            f"<td>{d.exposure_type or ''}</td><td>{d.share_class_normalized or ''}</td>"
            f"<td>{val}</td><td>{d.current_period_end}</td></tr>"
        )
        rows_text.append(
            f"  - {cname} / registrant={d.registrant_id} / series={d.series_id} / "
            f"value={val} / period={d.current_period_end}"
        )

    subject = f"N-PORT: {len(new_positions)} new tracked-company position(s)"
    html = (
        "<html><body>"
        f"<h2>{subject}</h2>"
        "<table border='1' cellpadding='6' cellspacing='0' style='border-collapse:collapse'>"
        "<thead><tr><th>Company</th><th>Registrant</th><th>Series</th>"
        "<th>Exposure</th><th>Share class</th><th>Value (USD)</th><th>Period</th></tr></thead>"
        f"<tbody>{''.join(rows_html)}</tbody></table>"
        "</body></html>"
    )
    text = f"{subject}\n\n" + "\n".join(rows_text)
    return AlertPayload("new_tracked_company_position", subject, html, text)


def format_pure_markup_alert(
    deltas: Iterable[PositionDelta],
    threshold_pct: float = PURE_MARKUP_THRESHOLD_PCT,
    company_name_lookup: dict[str, str] | None = None,
) -> AlertPayload | None:
    """Pure-markup events above the threshold (PLAN §3.3 markup signal).

    Pure markup = balance unchanged, value moved. Threshold defaults to 25%
    to match the brief.
    """
    flagged = [d for d in deltas if d.is_pure_markup and (d.markup_pct or 0) > threshold_pct]
    if not flagged:
        return None

    flagged.sort(key=lambda d: d.markup_pct or 0, reverse=True)

    rows_html = []
    rows_text = []
    for d in flagged:
        cname = _company_name(d, company_name_lookup)
        rows_html.append(
            f"<tr><td>{cname}</td><td>{d.registrant_id}</td><td>{d.series_id}</td>"
            f"<td>{d.share_class_normalized or ''}</td><td>{d.exposure_type or ''}</td>"
            f"<td style='text-align:right'>{d.markup_pct:.2f}%</td>"
            f"<td>${d.prior_value_usd:,.0f}</td><td>${d.current_value_usd:,.0f}</td>"
            f"<td>{d.current_period_end}</td></tr>"
        )
        rows_text.append(
            f"  - {cname}: {d.markup_pct:.2f}% (${d.prior_value_usd:,.0f} -> "
            f"${d.current_value_usd:,.0f}) — registrant={d.registrant_id} "
            f"series={d.series_id} period={d.current_period_end}"
        )

    subject = f"N-PORT: {len(flagged)} pure markup(s) > {threshold_pct:.0f}%"
    html = (
        "<html><body>"
        f"<h2>{subject}</h2>"
        "<p>Pure markup = balance unchanged, only valuation moved.</p>"
        "<table border='1' cellpadding='6' cellspacing='0' style='border-collapse:collapse'>"
        "<thead><tr><th>Company</th><th>Registrant</th><th>Series</th>"
        "<th>Share class</th><th>Exposure</th><th>Markup %</th>"
        "<th>Prior value</th><th>Current value</th><th>Period</th></tr></thead>"
        f"<tbody>{''.join(rows_html)}</tbody></table>"
        "</body></html>"
    )
    text = f"{subject}\n\n" + "\n".join(rows_text)
    return AlertPayload("pure_markup_over_25", subject, html, text)


def format_new_fund_family_alert(
    new_pairs: list[tuple[str, str, str]],  # (company_id, registrant_id, registrant_name)
    company_name_lookup: dict[str, str] | None = None,
) -> AlertPayload | None:
    """A fund family (registrant) appeared as a holder for the first time.

    The caller decides which (company, registrant) pairs are "new" by
    comparing against the prior period's distinct registrant set. We accept
    the result as input rather than recomputing here, because the prior
    period's roster is a DB query, not delta-row data.
    """
    if not new_pairs:
        return None

    rows_html = []
    rows_text = []
    for company_id, registrant_id, registrant_name in new_pairs:
        cname = company_name_lookup.get(company_id, company_id) if company_name_lookup else company_id
        rows_html.append(
            f"<tr><td>{cname}</td><td>{registrant_name}</td><td>{registrant_id}</td></tr>"
        )
        rows_text.append(f"  - {cname}: new holder {registrant_name} ({registrant_id})")

    subject = f"N-PORT: {len(new_pairs)} new fund-family holder(s)"
    html = (
        "<html><body>"
        f"<h2>{subject}</h2>"
        "<table border='1' cellpadding='6' cellspacing='0' style='border-collapse:collapse'>"
        "<thead><tr><th>Company</th><th>New holder (fund family)</th>"
        "<th>Registrant ID</th></tr></thead>"
        f"<tbody>{''.join(rows_html)}</tbody></table>"
        "</body></html>"
    )
    text = f"{subject}\n\n" + "\n".join(rows_text)
    return AlertPayload("new_fund_family", subject, html, text)


def format_repricing_alert(
    events: list[RepricingEvent],
    company_name_lookup: dict[str, str] | None = None,
) -> AlertPayload | None:
    """The SpaceX-style alert: 'every holder marked the same'. PLAN §3.3."""
    if not events:
        return None

    rows_html = []
    rows_text = []
    for e in events:
        cname = company_name_lookup.get(e.company_id, e.company_id) if company_name_lookup else e.company_id
        rows_html.append(
            f"<tr><td>{cname}</td><td>{e.period_end}</td>"
            f"<td>{e.share_class_normalized or ''}</td><td>{e.exposure_type or ''}</td>"
            f"<td>${e.prior_price:,.2f}</td><td>${e.current_price:,.2f}</td>"
            f"<td style='text-align:right'>{e.markup_pct:.2f}%</td>"
            f"<td style='text-align:right'>{e.holder_count}</td></tr>"
        )
        rows_text.append(
            f"  - {cname} ({e.share_class_normalized or '?'}, {e.exposure_type or '?'}): "
            f"${e.prior_price:.2f} -> ${e.current_price:.2f} ({e.markup_pct:.2f}%) "
            f"across {e.holder_count} holders on {e.period_end}"
        )

    subject = f"N-PORT: {len(events)} coordinated repricing event(s)"
    html = (
        "<html><body>"
        f"<h2>{subject}</h2>"
        "<p>>= 3 holders marked the same company to the same exact $/share simultaneously. "
        "This is the SpaceX-2x pattern (PLAN §3.3) — a public-signal-grade event.</p>"
        "<table border='1' cellpadding='6' cellspacing='0' style='border-collapse:collapse'>"
        "<thead><tr><th>Company</th><th>Period</th><th>Share class</th>"
        "<th>Exposure</th><th>Prior $</th><th>Current $</th>"
        "<th>Markup %</th><th>Holders</th></tr></thead>"
        f"<tbody>{''.join(rows_html)}</tbody></table>"
        "</body></html>"
    )
    text = f"{subject}\n\n" + "\n".join(rows_text)
    return AlertPayload("coordinated_repricing", subject, html, text)


# ---------------------------------------------------------------- transport
def _smtp_config() -> tuple[str, str, str] | None:
    """Return (user, app_password, recipient) from env, or None if missing.

    Env vars (App Password is NEVER hardcoded — PLAN constraint & task brief):
        GMAIL_USER             — sender / recipient if no GMAIL_ALERT_TO set
        GMAIL_APP_PASSWORD     — 16-char Gmail app password
        GMAIL_ALERT_TO         — optional override recipient
    """
    user = os.environ.get("GMAIL_USER")
    app_password = os.environ.get("GMAIL_APP_PASSWORD")
    if not user or not app_password:
        return None
    recipient = os.environ.get("GMAIL_ALERT_TO", user)
    return user, app_password, recipient


def send_alert(payload: AlertPayload, dry_run: bool | None = None) -> bool:
    """Send one AlertPayload via Gmail SMTP_SSL.

    Returns True on success, False on transport failure. When credentials
    are missing or dry_run=True, prints the payload and returns True
    (treated as "delivered" for the local-dev path so callers don't have
    to special-case the missing-creds branch).
    """
    cfg = _smtp_config()
    if dry_run is None:
        dry_run = cfg is None or os.environ.get("NPORT_ALERTS_DRY_RUN") == "1"

    if dry_run or cfg is None:
        log.info("DRY RUN — would send alert: %s", payload.subject)
        print(f"[DRY RUN] {payload.subject}\n{payload.plain_body}")
        return True

    user, app_password, recipient = cfg
    msg = MIMEMultipart("alternative")
    msg["Subject"] = payload.subject
    msg["From"] = user
    msg["To"] = recipient
    msg.attach(MIMEText(payload.plain_body, "plain"))
    msg.attach(MIMEText(payload.html_body, "html"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(user, app_password)
            server.send_message(msg)
        log.info("sent alert: %s", payload.subject)
        return True
    except Exception as exc:  # noqa: BLE001 - log and continue; callers retry
        log.error("SMTP send failed for alert %s: %s", payload.subject, exc)
        return False


def build_and_send_all_alerts(
    deltas: list[PositionDelta],
    events: list[RepricingEvent],
    new_fund_family_pairs: list[tuple[str, str, str]] | None = None,
    company_name_lookup: dict[str, str] | None = None,
    dry_run: bool | None = None,
) -> list[AlertPayload]:
    """Convenience entry point: format all four alert types from a batch and
    send those that have content. Returns the list of payloads built (NOT
    only the successfully delivered ones — caller can inspect transport
    failures from the log).
    """
    new_positions = [d for d in deltas if d.is_new_position]
    payloads: list[AlertPayload] = []

    for builder in (
        lambda: format_new_position_alert(new_positions, company_name_lookup),
        lambda: format_pure_markup_alert(deltas, company_name_lookup=company_name_lookup),
        lambda: format_new_fund_family_alert(new_fund_family_pairs or [], company_name_lookup),
        lambda: format_repricing_alert(events, company_name_lookup),
    ):
        p = builder()
        if p is not None:
            payloads.append(p)
            send_alert(p, dry_run=dry_run)

    return payloads
