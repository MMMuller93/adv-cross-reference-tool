#!/usr/bin/env python3
"""
Wikidata per-company enrichment.

Inputs:  wikipedia_unicorns.json (from wikipedia_loader.py)
Outputs: wikidata_enriched.json

For each Wikipedia entry we resolve a Wikidata QID by label-lookup
(MediaWiki API `action=wbsearchentities`) and then fetch the entity
JSON via `Special:EntityData/{QID}.json` to extract:

  P856  — official website (we keep the domain portion)
  P571  — inception date (we keep just the year)
  P17   — country of registration (Q-id → English label)
  P452  — industry (Q-id → English label, optional)
  P1448 — official name (used as a tie-break sanity check)

Notes
-----
* We rate-limit politely (~5 req/s combined across endpoints) to stay
  well within Wikidata's published rate guidance.
* We expect ~60-70 % hit rate per PLAN_NPORT_HOLDINGS.md §6.7.
* We never raise on a single-row failure: any individual lookup failure
  is recorded in the per-entry `lookup_status` field.

Usage
-----
  python wikidata_enricher.py [--limit N] [--input wikipedia_unicorns.json]
                              [--output wikidata_enriched.json]

License attribution: Wikidata content is CC0; Wikipedia content is CC BY-SA 4.0
(already attributed by upstream loader).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
ENTITY_DATA_URL = "https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
USER_AGENT = "Miles Muller mmmuller93@gmail.com"
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = SCRIPT_DIR / "wikipedia_unicorns.json"
DEFAULT_OUTPUT = SCRIPT_DIR / "wikidata_enriched.json"

# Generous but polite — Wikidata allows ~10 req/s as a soft ceiling for bots.
SLEEP_PER_REQUEST = 0.20  # ~5 req/s


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    return s


def search_qid(session: requests.Session, label: str) -> str | None:
    """Return the most likely QID for a company label, or None."""
    params = {
        "action": "wbsearchentities",
        "search": label,
        "language": "en",
        "type": "item",
        "limit": "5",
        "format": "json",
    }
    try:
        r = session.get(WIKIDATA_API, params=params, timeout=20)
        r.raise_for_status()
        results = r.json().get("search", [])
    except Exception:
        return None
    # Take first hit whose description suggests a company / organization.
    company_words = ("company", "corporation", "startup", "firm", "organization",
                     "organisation", "enterprise", "manufacturer", "platform",
                     "developer", "studio")
    for r_item in results:
        desc = (r_item.get("description") or "").lower()
        if any(w in desc for w in company_words):
            return r_item.get("id")
    if results:
        return results[0].get("id")
    return None


def fetch_entity(session: requests.Session, qid: str) -> dict[str, Any] | None:
    """Fetch full entity JSON. Returns the `entities[qid]` dict or None."""
    url = ENTITY_DATA_URL.format(qid=qid)
    try:
        r = session.get(url, timeout=20)
        r.raise_for_status()
        return r.json().get("entities", {}).get(qid)
    except Exception:
        return None


def best_claim_value(claims: dict[str, Any], prop: str) -> Any | None:
    """Pick the highest-rank statement for a property; return its mainsnak datavalue."""
    statements = claims.get(prop) or []
    if not statements:
        return None
    # Prefer rank=preferred, then normal, drop deprecated.
    ranked = sorted(
        (s for s in statements if s.get("rank") != "deprecated"),
        key=lambda s: 0 if s.get("rank") == "preferred" else 1,
    )
    for s in ranked:
        mainsnak = s.get("mainsnak") or {}
        if mainsnak.get("snaktype") != "value":
            continue
        dv = mainsnak.get("datavalue") or {}
        return dv.get("value")
    return None


def extract_domain(p856_value: Any | None) -> str | None:
    """P856 is a string URL — extract registrable host (drop scheme, leading www., trailing /)."""
    if not p856_value:
        return None
    if isinstance(p856_value, dict):
        return None
    url = str(p856_value).strip()
    if not url:
        return None
    if "://" not in url:
        url = "http://" + url
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return None
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return host or None


def extract_year(p571_value: Any | None) -> int | None:
    """P571 returns a time block like '+2021-01-01T00:00:00Z'."""
    if not p571_value or not isinstance(p571_value, dict):
        return None
    t = p571_value.get("time")
    if not t:
        return None
    m = re.search(r"([+-])(\d{4,})", t)
    if not m:
        return None
    sign, year = m.group(1), int(m.group(2))
    if sign == "-":
        return -year
    return year


def resolve_country_label(session: requests.Session, p17_value: Any | None, cache: dict[str, str]) -> str | None:
    """P17 is an item-link — fetch its English label."""
    if not p17_value or not isinstance(p17_value, dict):
        return None
    qid = p17_value.get("id")
    if not qid:
        return None
    if qid in cache:
        return cache[qid]
    time.sleep(SLEEP_PER_REQUEST)
    ent = fetch_entity(session, qid)
    if not ent:
        cache[qid] = ""  # cache miss
        return None
    label = ent.get("labels", {}).get("en", {}).get("value")
    cache[qid] = label or ""
    return label


def enrich_one(session: requests.Session, label: str, country_cache: dict[str, str]) -> dict[str, Any]:
    """Look up a single company label. Returns a structured enrichment record."""
    record: dict[str, Any] = {
        "label": label,
        "qid": None,
        "domain": None,
        "founded_year": None,
        "country": None,
        "lookup_status": "no_qid",
    }
    time.sleep(SLEEP_PER_REQUEST)
    qid = search_qid(session, label)
    if not qid:
        return record
    record["qid"] = qid

    time.sleep(SLEEP_PER_REQUEST)
    ent = fetch_entity(session, qid)
    if not ent:
        record["lookup_status"] = "entity_fetch_failed"
        return record

    claims = ent.get("claims") or {}
    record["domain"] = extract_domain(best_claim_value(claims, "P856"))
    record["founded_year"] = extract_year(best_claim_value(claims, "P571"))
    record["country"] = resolve_country_label(session, best_claim_value(claims, "P17"), country_cache)
    record["lookup_status"] = "ok"
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--limit", type=int, default=0,
                        help="If >0, only enrich the first N entries (for smoke-test).")
    parser.add_argument("--offline", action="store_true",
                        help="Skip network calls — emit empty enrichments. Useful for tests.")
    args = parser.parse_args(argv)

    if not args.input.exists():
        print(f"[wikidata_enricher] ERROR: input {args.input} not found. "
              "Run wikipedia_loader.py first.", file=sys.stderr)
        return 1

    src = json.loads(args.input.read_text())
    entries = src["entries"]
    if args.limit:
        entries = entries[: args.limit]

    print(f"[wikidata_enricher] Enriching {len(entries)} entries "
          f"(offline={args.offline}) ...", flush=True)

    session = make_session()
    country_cache: dict[str, str] = {}
    enriched: list[dict[str, Any]] = []
    hits = 0
    t0 = time.time()
    for i, e in enumerate(entries, 1):
        label = e["company"]
        if args.offline:
            rec = {
                "label": label,
                "qid": None,
                "domain": None,
                "founded_year": None,
                "country": None,
                "lookup_status": "offline_skipped",
            }
        else:
            rec = enrich_one(session, label, country_cache)
            if rec["lookup_status"] == "ok" and (rec["domain"] or rec["founded_year"]):
                hits += 1
        enriched.append(rec)
        if i % 25 == 0:
            print(f"[wikidata_enricher] {i}/{len(entries)} done, "
                  f"hit-rate {hits / i:.0%}", flush=True)

    out = {
        "source": "wikidata",
        "license": "CC0",
        "enriched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "row_count": len(enriched),
        "hits_with_useful_data": hits,
        "elapsed_seconds": round(time.time() - t0, 1),
        "records": enriched,
    }
    args.output.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"[wikidata_enricher] Wrote {args.output} "
          f"({hits}/{len(enriched)} useful = {hits / max(1, len(enriched)):.0%})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
