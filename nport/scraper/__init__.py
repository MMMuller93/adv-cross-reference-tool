"""N-PORT scraper package.

Ingestion modules for SEC Form N-PORT private-company holdings:
- backfill_bulk:   historical bulk quarterly TSV backfill
- daily_scraper:   daily NPORT-P / NPORT-P/A delta scraper with alerts
- load_identifiers: IDENTIFIERS.tsv per-quarter loader (filtered to useful rows)

See PLAN_NPORT_HOLDINGS.md sections 6.1, 6.2, 6.3 for design rationale.
"""
