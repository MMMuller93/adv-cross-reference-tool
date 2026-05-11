"""Thin wrapper around SEC EDGAR HTTP endpoints.

Centralizes:
- The required User-Agent header (SEC will 403 without it)
- A floor on inter-request sleep (10 req/s ceiling)
- Streaming `download()` for large bulk ZIPs (1.6GB+ uncompressed each)

Used by backfill_bulk.py, daily_scraper.py, and load_identifiers.py.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

import requests

from .config import SEC_RATE_LIMIT_SEC, SEC_USER_AGENT


class SECClient:
    """Rate-limited SEC HTTP client.

    Single instance per process. Reuses a `requests.Session` to keep the
    TCP connection warm across the ~13K filings per backfill quarter.
    """

    def __init__(
        self,
        user_agent: str = SEC_USER_AGENT,
        rate_limit: float = SEC_RATE_LIMIT_SEC,
        timeout: int = 60,
    ):
        self.user_agent = user_agent
        self.rate_limit = rate_limit
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": user_agent})
        self._last_request_at = 0.0

    def _sleep_until_allowed(self) -> None:
        """Block until at least `self.rate_limit` seconds since the last call."""
        delta = time.monotonic() - self._last_request_at
        if delta < self.rate_limit:
            time.sleep(self.rate_limit - delta)
        self._last_request_at = time.monotonic()

    def head(self, url: str) -> requests.Response:
        """HEAD request — used by backfill to check ZIP availability cheaply."""
        self._sleep_until_allowed()
        return self._session.head(url, timeout=self.timeout, allow_redirects=True)

    def get(
        self,
        url: str,
        retries: int = 3,
        backoff_base: float = 2.0,
    ) -> requests.Response:
        """GET request with exponential backoff on 429.

        Matches the retry pattern in daily_scraper_with_alerts.py.
        Returns the final response (may still be non-2xx after retries).
        """
        last_response: Optional[requests.Response] = None
        for attempt in range(retries):
            self._sleep_until_allowed()
            try:
                resp = self._session.get(url, timeout=self.timeout)
            except requests.RequestException:
                if attempt == retries - 1:
                    raise
                time.sleep(backoff_base ** attempt)
                continue

            last_response = resp
            if resp.status_code == 429:
                time.sleep(backoff_base ** (attempt + 1))
                continue
            return resp

        # All retries returned 429 (or transient error and we ran out)
        assert last_response is not None
        return last_response

    def download(self, url: str, dest_path: Path, chunk: int = 1 << 20) -> Path:
        """Stream a (possibly very large) file to disk.

        Used for the 442MB+ quarterly bulk ZIPs. 1MB chunk keeps memory flat.
        Returns the dest path on success; raises on HTTP error.
        """
        dest_path = Path(dest_path)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        self._sleep_until_allowed()
        with self._session.get(url, stream=True, timeout=self.timeout) as resp:
            resp.raise_for_status()
            with open(dest_path, "wb") as fh:
                for block in resp.iter_content(chunk_size=chunk):
                    if block:
                        fh.write(block)
        return dest_path
