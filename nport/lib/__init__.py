"""Shared utilities for SEC filing ingestion (N-PORT, N-CEN, N-CSR, N-1A/N-2)."""

from .edgar_index import (
    DEFAULT_RATE_LIMIT_SECS,
    DEFAULT_USER_AGENT,
    FilingRef,
    fetch_document,
    fetch_submissions,
    find_filing,
    iter_filings,
    pad_cik,
)

__all__ = [
    "DEFAULT_RATE_LIMIT_SECS",
    "DEFAULT_USER_AGENT",
    "FilingRef",
    "fetch_document",
    "fetch_submissions",
    "find_filing",
    "iter_filings",
    "pad_cik",
]
