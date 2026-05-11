#!/usr/bin/env python3
"""
Staleness tripwire for cross_reference_matches.

Exits non-zero if the most recent computed_at is older than the threshold.
Designed to run on a daily cron from GitHub Actions; if it fires, we know
the weekly refresh-cross-reference workflow has been disabled or is failing.

Background: GitHub Actions auto-disables scheduled workflows after extended
periods of inactivity. On 2026-05-11, the refresh-cross-reference workflow
was found disabled with the table 30 days stale (last refresh 2026-04-12).
This tripwire catches that condition earlier.

Usage:
    python scripts/check_cross_reference_freshness.py [--max-days N]

Env vars (or fallbacks):
    FORMD_URL  - Form D Supabase URL
    FORMD_KEY  - Form D anon or service key

Exit codes:
    0   table is fresh
    1   table is stale (older than threshold)
    2   table is empty or unreachable
    3   bad arguments / config
"""

import argparse
import os
import sys
import urllib.parse
import urllib.request
import json
from datetime import datetime, timezone


DEFAULT_FORMD_URL = 'https://ltdalxkhbbhmkimmogyq.supabase.co'
DEFAULT_FORMD_KEY = (
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFs'
    'eGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3'
    'NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc'
)


def parse_iso(ts):
    if not ts:
        return None
    # Supabase timestamps look like '2026-04-12T05:23:43.123456+00:00' or no tz
    s = ts.strip()
    # Handle trailing 'Z'
    if s.endswith('Z'):
        s = s[:-1] + '+00:00'
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--max-days', type=int, default=14, help='Max allowed days since last refresh (default 14)')
    parser.add_argument('--quiet', action='store_true', help='Suppress success output')
    args = parser.parse_args()

    base = os.environ.get('FORMD_URL') or DEFAULT_FORMD_URL
    key = os.environ.get('FORMD_KEY') or DEFAULT_FORMD_KEY

    url = f"{base}/rest/v1/cross_reference_matches?select=computed_at&order=computed_at.desc&limit=1"
    req = urllib.request.Request(url, headers={
        'apikey': key,
        'Authorization': f'Bearer {key}',
    })

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except Exception as e:
        print(f"[CHECK] FAIL: cannot query cross_reference_matches: {e}", file=sys.stderr)
        return 2

    if not isinstance(data, list) or not data:
        print(f"[CHECK] FAIL: cross_reference_matches is empty (no rows)", file=sys.stderr)
        return 2

    latest_raw = data[0].get('computed_at')
    latest = parse_iso(latest_raw)
    if latest is None:
        print(f"[CHECK] FAIL: cannot parse computed_at: {latest_raw!r}", file=sys.stderr)
        return 2

    now = datetime.now(timezone.utc)
    delta_days = (now - latest).total_seconds() / 86400.0

    if delta_days > args.max_days:
        print(f"[CHECK] STALE: cross_reference_matches.computed_at = {latest_raw}")
        print(f"[CHECK]        age = {delta_days:.1f} days (threshold = {args.max_days} days)")
        print(f"[CHECK]        ACTION: enable the workflow:")
        print(f"[CHECK]          gh workflow enable refresh-cross-reference.yml")
        print(f"[CHECK]          gh workflow run refresh-cross-reference.yml")
        return 1

    if not args.quiet:
        print(f"[CHECK] OK: cross_reference_matches.computed_at = {latest_raw} ({delta_days:.1f} days ago, threshold {args.max_days})")
    return 0


if __name__ == '__main__':
    sys.exit(main())
