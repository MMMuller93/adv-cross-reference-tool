#!/usr/bin/env python3
"""
Merge all private-company seed sources into one upsert-ready pair of JSON files.

Inputs (all in this directory):
  - wikipedia_unicorns.json   (run wikipedia_loader.py first)
  - wikidata_enriched.json    (optional — run wikidata_enricher.py)
  - nport_clusters.json       (static)
  - manual_curated_seed.json  (static, hand-curated)
  - lifecycle_flags.json      (static)
  - sanctioned_seed.json      (static — emitted separately, not into private_companies)

Outputs:
  - private_companies_seed.json          (one row per company → private_companies table)
  - private_company_aliases_seed.json    (one row per alias → private_company_aliases)

Merge precedence (highest wins):
  1. manual_curated_seed.json   — hand-curated, full alias list, lifecycle status
  2. lifecycle_flags.json       — overrides lifecycle / is_public / is_acquired
  3. wikidata_enriched.json     — domain, founded_year, country
  4. wikipedia_unicorns.json    — display_name, country, founders, valuation

Each output row is shaped to match the private_companies / private_company_aliases
schema in PLAN_NPORT_HOLDINGS.md §4.1. The downstream Supabase load script will
strip our `seed_source` audit field if not desired.

Usage:
  python merge_and_emit.py
  python merge_and_emit.py --input-dir . --output-dir .
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent

# --- name normalization ------------------------------------------------------
LEGAL_SUFFIXES = {
    "INC", "INCORPORATED", "LLC", "LP", "LLP", "PLC", "LTD", "LIMITED",
    "CORP", "CORPORATION", "CO", "COMPANY", "PBC", "GMBH", "AG", "AB",
    "SA", "NV", "BV", "PTY", "OY", "AS", "ASA", "SPA", "SARL",
    "HOLDINGS", "HOLDING", "GROUP",
}
# Dotted abbreviations that should be collapsed before punctuation stripping,
# e.g. "L.P." -> "LP", "L.L.C." -> "LLC". The regex captures consecutive
# single-letter+dot patterns and rejoins them so they map cleanly to the
# suffix set above.
DOTTED_ABBREV_RE = re.compile(r"\b(?:[A-Z]\.){2,}", re.IGNORECASE)
PUNCT_RE = re.compile(r"[,\.\"'\(\)\[\]/\\\-]")
WS_RE = re.compile(r"\s+")
SLUG_INVALID = re.compile(r"[^a-z0-9]+")


def normalize_name(s: str) -> str:
    """Normalize a company name for matching: upper → collapse dotted abbreviations
    → strip punct → drop legal suffixes."""
    if not s:
        return ""
    s = s.upper()
    # "L.P." -> "LP", "L.L.C." -> "LLC" before we destroy dots
    s = DOTTED_ABBREV_RE.sub(lambda m: m.group(0).replace(".", ""), s)
    s = PUNCT_RE.sub(" ", s)
    s = WS_RE.sub(" ", s).strip()
    tokens = s.split()
    # Strip trailing legal suffixes (sometimes multiple, e.g. "FOO HOLDINGS LTD")
    while tokens and tokens[-1] in LEGAL_SUFFIXES:
        tokens.pop()
    return " ".join(tokens)


def slugify(s: str) -> str:
    """Produce a URL-safe slug."""
    if not s:
        return ""
    s = s.lower().strip()
    s = SLUG_INVALID.sub("-", s).strip("-")
    return s


def country_to_iso2(name: str | None) -> str | None:
    """Best-effort map of country-name strings to ISO-2 codes. Returns input upcased if unknown."""
    if not name:
        return None
    n = name.strip().lower()
    mapping = {
        "united states": "US",
        "united states of america": "US",
        "usa": "US",
        "u.s.": "US",
        "u.s.a.": "US",
        "us": "US",
        "united kingdom": "GB",
        "uk": "GB",
        "great britain": "GB",
        "china": "CN",
        "people's republic of china": "CN",
        "prc": "CN",
        "germany": "DE",
        "france": "FR",
        "japan": "JP",
        "india": "IN",
        "canada": "CA",
        "australia": "AU",
        "israel": "IL",
        "south korea": "KR",
        "korea": "KR",
        "singapore": "SG",
        "sweden": "SE",
        "finland": "FI",
        "estonia": "EE",
        "ireland": "IE",
        "netherlands": "NL",
        "switzerland": "CH",
        "spain": "ES",
        "italy": "IT",
        "brazil": "BR",
        "mexico": "MX",
        "indonesia": "ID",
        "south africa": "ZA",
        "saudi arabia": "SA",
        "uae": "AE",
        "united arab emirates": "AE",
    }
    if n in mapping:
        return mapping[n]
    if " and " in n:
        # "United States and Ireland" -> take first
        first = n.split(" and ")[0].strip()
        if first in mapping:
            return mapping[first]
    return name.strip()[:32]  # fallback: keep first 32 chars


# --- loaders -----------------------------------------------------------------
def load_json(path: Path) -> Any | None:
    if not path.exists():
        return None
    return json.loads(path.read_text())


# --- merge -------------------------------------------------------------------
def empty_company_row(slug: str) -> dict[str, Any]:
    return {
        "slug": slug,
        "display_name": None,
        "primary_domain": None,
        "sector": None,
        "description": None,
        "founded_year": None,
        "hq_country": None,
        "hq_state": None,
        "legal_entities": None,
        "most_recent_round": None,
        "most_recent_round_date": None,
        "latest_known_valuation_usd": None,
        "latest_known_valuation_date": None,
        "total_funding_usd": None,
        "seed_source": None,
        "is_sanctioned": False,
        "is_public": False,
        "ipo_date": None,
        "is_acquired": False,
        "acquired_by": None,
        "acquired_date": None,
        "lifecycle_status": "private",
    }


def merge_into(target: dict[str, Any], src: dict[str, Any]) -> None:
    """Copy non-null values from src into target without clobbering existing values."""
    for k, v in src.items():
        if k == "slug":
            continue
        if v in (None, "", [], {}):
            continue
        if target.get(k) in (None, "", [], {}):
            target[k] = v


def build_companies(
    wikipedia: dict[str, Any] | None,
    wikidata: dict[str, Any] | None,
    nport_clusters: dict[str, Any] | None,
    manual: dict[str, Any] | None,
    lifecycle: dict[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    """Return slug → company-row dict."""
    companies: dict[str, dict[str, Any]] = {}

    # Manual seeds dominate — they get seed_source='manual' and the full alias list.
    if manual:
        for e in manual["entries"]:
            slug = e["slug"]
            row = empty_company_row(slug)
            merge_into(row, {k: v for k, v in e.items() if k != "aliases"})
            row["seed_source"] = "manual"
            companies[slug] = row

    # Lifecycle flags — override lifecycle fields and create rows for new slugs.
    if lifecycle:
        for e in lifecycle["entries"]:
            slug = e["slug"]
            row = companies.get(slug) or empty_company_row(slug)
            # explicit override of these specific fields:
            for field in ("display_name", "sector", "primary_domain", "founded_year",
                          "hq_country", "legal_entities", "lifecycle_status",
                          "is_acquired", "acquired_by", "acquired_date",
                          "is_public", "ipo_date"):
                v = e.get(field)
                if v is not None:
                    row[field] = v
            if row.get("seed_source") is None:
                row["seed_source"] = "lifecycle_flag"
            companies[slug] = row

    # N-PORT clusters — supply slugs the others might not have, with sector tagging.
    if nport_clusters:
        for c in nport_clusters["clusters"]:
            slug = c["proposed_company_slug"]
            row = companies.get(slug) or empty_company_row(slug)
            if not row.get("display_name"):
                row["display_name"] = c["cluster_name"].title()
            if not row.get("sector"):
                row["sector"] = c.get("sector")
            if not row.get("seed_source"):
                row["seed_source"] = "nport_discovery"
            companies[slug] = row

    # Wikidata enrichments — keyed by label, applied to a slug if the label matches.
    wikidata_by_label: dict[str, dict[str, Any]] = {}
    if wikidata:
        for r in wikidata.get("records", []):
            wikidata_by_label[r["label"].lower()] = r

    # Wikipedia — broadest layer, lowest priority.
    if wikipedia:
        for e in wikipedia["entries"]:
            display = e["company"]
            slug = slugify(display)
            if not slug:
                continue
            row = companies.get(slug) or empty_company_row(slug)
            if not row.get("display_name"):
                row["display_name"] = display
            # valuation_usd_billions is in $B — convert to plain USD if not set
            if (not row.get("latest_known_valuation_usd")
                    and e.get("valuation_usd_billions")):
                row["latest_known_valuation_usd"] = int(round(
                    float(e["valuation_usd_billions"]) * 1_000_000_000))
            # country
            if not row.get("hq_country") and e.get("country"):
                row["hq_country"] = country_to_iso2(e["country"])
            # exited → lifecycle status & flags
            if e.get("table") == "exited":
                if not row.get("lifecycle_status") or row["lifecycle_status"] == "private":
                    reason = (e.get("exit_reason") or "").lower()
                    if "ipo" in reason or "public" in reason:
                        row["lifecycle_status"] = "public"
                        row["is_public"] = True
                        if e.get("exit_date") and not row.get("ipo_date"):
                            row["ipo_date"] = e["exit_date"]
                    elif "acqui" in reason or "merger" in reason or "bought" in reason:
                        row["lifecycle_status"] = "acquired"
                        row["is_acquired"] = True
                        if e.get("exit_date") and not row.get("acquired_date"):
                            row["acquired_date"] = e["exit_date"]
            if not row.get("seed_source"):
                row["seed_source"] = "wikipedia"

            # Now layer Wikidata on top, if we have a record for this label
            wd = wikidata_by_label.get(display.lower())
            if wd and wd.get("lookup_status") == "ok":
                if not row.get("primary_domain") and wd.get("domain"):
                    row["primary_domain"] = wd["domain"]
                if not row.get("founded_year") and wd.get("founded_year"):
                    row["founded_year"] = wd["founded_year"]
                if not row.get("hq_country") and wd.get("country"):
                    row["hq_country"] = country_to_iso2(wd["country"])

            companies[slug] = row

    return companies


def build_aliases(
    companies: dict[str, dict[str, Any]],
    manual: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Return list of alias rows. Each row carries a `company_slug` we resolve to id at load time."""
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()  # (slug, pattern_type, pattern)

    # 1. Manual aliases — full structured patterns
    # For exact_normalized / prefix patterns we run the raw value through
    # normalize_name() so the on-disk row matches the form the resolution
    # pipeline will see at query time. We DON'T normalize regex or
    # vendor_code patterns — those are matched verbatim.
    if manual:
        for e in manual["entries"]:
            slug = e["slug"]
            for a in e.get("aliases", []):
                pt = a["pattern_type"]
                pattern = a["pattern"]
                if pt in ("exact_normalized", "prefix"):
                    pattern = normalize_name(pattern) or pattern
                key = (slug, pt, pattern)
                if key in seen:
                    continue
                seen.add(key)
                out.append({
                    "company_slug": slug,
                    "pattern_type": pt,
                    "pattern": pattern,
                    "exposure_type": a.get("exposure_type", "direct"),
                    "underlier_only": a.get("underlier_only", False),
                    "vendor_code_type": a.get("vendor_code_type"),
                    "notes": a.get("notes"),
                    "source": "manual",
                    "confidence": a.get("confidence", 100),
                })

    # 2. Auto-generate one exact_normalized alias per company that has a display_name.
    for slug, row in companies.items():
        display = row.get("display_name")
        if not display:
            continue
        norm = normalize_name(display)
        if not norm or len(norm) < 3:
            continue
        key = (slug, "exact_normalized", norm)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "company_slug": slug,
            "pattern_type": "exact_normalized",
            "pattern": norm,
            "exposure_type": "direct",
            "underlier_only": False,
            "vendor_code_type": None,
            "notes": "Auto-generated from display_name",
            "source": "auto_from_name",
            "confidence": 80,
        })

    return out


# --- main --------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, default=SCRIPT_DIR)
    parser.add_argument("--output-dir", type=Path, default=SCRIPT_DIR)
    parser.add_argument("--require-wikipedia", action="store_true",
                        help="Fail if wikipedia_unicorns.json is missing.")
    args = parser.parse_args(argv)

    in_dir = args.input_dir
    out_dir = args.output_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    wikipedia = load_json(in_dir / "wikipedia_unicorns.json")
    wikidata = load_json(in_dir / "wikidata_enriched.json")
    nport_clusters = load_json(in_dir / "nport_clusters.json")
    manual = load_json(in_dir / "manual_curated_seed.json")
    lifecycle = load_json(in_dir / "lifecycle_flags.json")

    if args.require_wikipedia and wikipedia is None:
        print("[merge_and_emit] ERROR: wikipedia_unicorns.json missing "
              "and --require-wikipedia set.", file=sys.stderr)
        return 1

    companies = build_companies(wikipedia, wikidata, nport_clusters, manual, lifecycle)
    aliases = build_aliases(companies, manual)

    # Final sanity normalization
    for row in companies.values():
        # lifecycle_status fallback
        if not row.get("lifecycle_status"):
            row["lifecycle_status"] = "private"
        # flag harmonization
        if row.get("is_public"):
            if row["lifecycle_status"] == "private":
                row["lifecycle_status"] = "public"
        if row.get("is_acquired"):
            if row["lifecycle_status"] == "private":
                row["lifecycle_status"] = "acquired"

    company_rows = sorted(companies.values(), key=lambda r: r["slug"])
    alias_rows = sorted(aliases, key=lambda r: (r["company_slug"], r["pattern_type"], r["pattern"]))

    company_path = out_dir / "private_companies_seed.json"
    alias_path = out_dir / "private_company_aliases_seed.json"
    company_path.write_text(json.dumps({
        "_comment": "One row per private company — upsert into private_companies (PLAN §4.1).",
        "row_count": len(company_rows),
        "rows": company_rows,
    }, indent=2, ensure_ascii=False))
    alias_path.write_text(json.dumps({
        "_comment": "One row per alias — upsert into private_company_aliases (PLAN §4.1). Resolve company_slug → company_id at load time.",
        "row_count": len(alias_rows),
        "rows": alias_rows,
    }, indent=2, ensure_ascii=False))

    print(f"[merge_and_emit] companies: {len(company_rows)} → {company_path.name}", flush=True)
    print(f"[merge_and_emit] aliases:   {len(alias_rows)} → {alias_path.name}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
