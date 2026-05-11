"""IDENTIFIERS.tsv per-quarter loader.

Per PLAN_NPORT_HOLDINGS.md §6.3: the raw IDENTIFIERS.tsv is 282 MB / 7.16M
rows per quarter. 82% of rows are filer-internal noise (`USER DEFINED`,
`Internal`, `Inhouse Asset ID`) that won't help with entity resolution.
We filter to the ~200K-500K rows that carry vendor cross-reference codes.

Usage:
    python load_identifiers.py --tsv /tmp/nport_staging/2026q1_extracted/IDENTIFIERS.tsv

The TSV is expected to live next to the other extracted quarter files;
the backfill module can invoke this between its `extract` and `cleanup`
steps. Stand-alone CLI is also supported for re-runs.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from .config import UPSERT_BATCH_SIZE
from .db_client import DBClient

# Whitelist of useful descriptors per §6.3.
USEFUL_DESCRIPTORS = {
    "BlackRock Identifier",
    "BBGID",
    "ID_BB_GLOBAL",
    "Bloomberg Identifier",
    "Bloomberg",
    "LoanX ID",
}

# Explicit deny-list of filer-internal noise. Kept for clarity even though
# whitelist already implies these are dropped.
NOISE_DESCRIPTORS = {
    "USER DEFINED",
    "Internal",
    "Inhouse Asset ID",
}

# CSV's default field size limit can be exceeded — set explicitly.
csv.field_size_limit(min(2**31 - 1, sys.maxsize))


def _normalize_keys(row: Dict[str, str]) -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {}
    for k, v in row.items():
        kl = k.lower().strip()
        if v is None:
            out[kl] = None
            continue
        s = v.strip() if isinstance(v, str) else v
        if s in ("", "N/A"):
            out[kl] = None
        else:
            out[kl] = s
    return out


def is_useful_row(row: Dict[str, Optional[str]]) -> bool:
    """Keep rows that carry a useful descriptor, an ISIN, or a ticker.

    Per §6.3 the filter is `desc in USEFUL_DESCRIPTORS or isin or ticker`.
    """
    desc = row.get("other_id_desc") or row.get("otheridentifierdesc")
    if desc and desc in USEFUL_DESCRIPTORS:
        return True
    if row.get("isin"):
        return True
    if row.get("ticker"):
        return True
    return False


def stream_identifiers(
    tsv_path: Path,
) -> Iterable[Dict[str, Optional[str]]]:
    """Yield normalized identifier rows one at a time. Streaming — flat memory."""
    with open(tsv_path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        for raw in reader:
            yield _normalize_keys(raw)


def load_identifiers(
    tsv_path: Path,
    db: Optional[DBClient] = None,
    batch_size: int = UPSERT_BATCH_SIZE,
) -> Dict[str, int]:
    """Stream + filter + upsert. Returns counts for visibility."""
    db = db or DBClient()
    seen = 0
    kept_batch: List[Dict[str, Optional[str]]] = []
    total_kept = 0
    for row in stream_identifiers(Path(tsv_path)):
        seen += 1
        if not is_useful_row(row):
            continue
        kept_batch.append(row)
        if len(kept_batch) >= batch_size:
            db.upsert_identifier(kept_batch)
            total_kept += len(kept_batch)
            kept_batch = []
    if kept_batch:
        db.upsert_identifier(kept_batch)
        total_kept += len(kept_batch)
    return {"rows_seen": seen, "rows_kept": total_kept}


def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Load filtered IDENTIFIERS.tsv")
    p.add_argument(
        "--tsv",
        required=True,
        help="Path to an extracted IDENTIFIERS.tsv from a quarterly bulk ZIP",
    )
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = _parse_args(argv)
    stats = load_identifiers(Path(args.tsv))
    print(stats)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
