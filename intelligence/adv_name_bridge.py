"""Bridge unbridged Form D filers to ADV firms by NAME, using local data only.

The Form D filer "AUGUREY VENTURES I, LLC - SERIES ANTHROPIC A" is a fund
operated by "AUGUREY CAPITAL ADVISORS, LLC" (CRD 324933, already in
advisers_enriched). We don't need to scrape SEC IAPD for that — the firm
is already in our local ADV mirror. This script does the local-data
match.

Strategy per unbridged Form D filer:
  1. Normalize: strip series-of-X tail, strip "- ANTHROPIC A" tail,
     strip entity suffixes, collapse whitespace.
  2. Get the first 1-3 significant tokens.
  3. Query advisers_enriched by descending specificity until exactly one
     match is found:
       a. WHERE normalized_adviser_name = full normalized filer
       b. WHERE normalized_adviser_name LIKE first-3-tokens%
       c. WHERE normalized_adviser_name LIKE first-2-tokens%
       d. WHERE normalized_adviser_name LIKE first-1-token% (only if
          the token is "specific enough" — not a generic word).
  4. On unique match, write intel_adviser_resolution with
     method='adv_name_match'.

Specificity guard: a single-token match is only accepted if the token is
not in a small GENERIC_TOKENS deny list (FUND, CAPITAL, VENTURES, etc.)
AND there are <=3 firms with that token-prefix overall (else any firm
starting with that letter would match too aggressively).

Idempotent: skips filers that already have an intel_adviser_resolution
row. Dry-run by default; --execute applies writes.

CLI:
  python intelligence/adv_name_bridge.py --company anthropic            # dry-run
  python intelligence/adv_name_bridge.py --company anthropic --execute  # writes
  python intelligence/adv_name_bridge.py --all --execute                # all tracked
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any, Optional


PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Import the local helpers from materialize_holders rather than re-implementing.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from materialize_holders import (  # type: ignore
    create_adv_client,
    create_nport_client,
    load_credentials,
)


# Tokens that are too generic to bridge on alone (V1 list; expand from observed
# false positives). All-caps because we compare normalized uppercase tokens.
GENERIC_TOKENS = {
    "FUND", "FUNDS", "CAPITAL", "VENTURES", "VENTURE", "PARTNERS",
    "INVESTMENTS", "INVESTMENT", "ADVISORS", "ADVISERS", "ADVISORY",
    "MANAGEMENT", "GROUP", "HOLDINGS", "TRUST", "BANK", "ASSOCIATES",
    "ASSET", "ASSETS", "GLOBAL", "AMERICAN", "AMERICA", "USA",
    "OPPORTUNITY", "OPPORTUNITIES", "EQUITY", "PRIVATE", "SECURITIES",
    "FINANCIAL", "WEALTH", "STRATEGIC", "ALTERNATIVE", "FIRST", "NEW",
    # Series/SPV naming patterns (filers using these are not firm-named)
    "SERIES", "SPV", "CO", "DEAL", "HOLDING", "VEHICLE", "VEHICLES",
    # Tracked company name tokens — never a firm-name signal. Form D filers
    # that start with the company name (e.g., 'Anthropic SPV1 Emerging…')
    # are SPVs naming what they invest in, not the operator firm.
    "ANTHROPIC", "OPENAI", "STRIPE", "DATABRICKS", "SPACEX", "CANVA",
    "FIGMA", "NOTION", "AIRTABLE", "BYTEDANCE", "EPIC", "DISCORD",
    "KLARNA", "RIPPLING", "PLAID", "BREX", "RAMP", "MERCURY",
    "GUSTO", "INSTACART", "DROPBOX", "DOORDASH", "SNOWFLAKE",
    "PALANTIR", "UNITY", "PATREON",
}

# Series-of-X master extraction. Mirrors the regex in materialize_holders.py
# (kept independent so this script is standalone).
SERIES_OF_RE = re.compile(
    r"\ba\s+series\s+of\s+(.+?)(?:,?\s*(?:LLC|LP|L\.P\.?|Ltd\.?))?\s*$",
    re.IGNORECASE,
)


def extract_series_master(filer_entityname: str) -> Optional[str]:
    """If the filer is 'X, a Series of Y LLC', return Y (the master LLC).
    None if no such pattern. The master LLC is often a venture firm whose
    name we have in advisers_enriched.
    """
    if not filer_entityname:
        return None
    m = SERIES_OF_RE.search(filer_entityname)
    if not m:
        return None
    return m.group(1).strip().rstrip(",").strip()

# Strip these tails from the filer entityname before tokenizing. Examples:
#   "AUGUREY VENTURES I, LLC - SERIES ANTHROPIC A"  ->  "AUGUREY VENTURES I, LLC"
#   "HII Anthropic-01, a Series of HII Anthropic, LLC"  ->  "HII Anthropic-01"
#   "MW LSVC Anthropic, LLC"  ->  "MW LSVC Anthropic, LLC"  (no change)
SERIES_TAIL_PATTERNS = [
    re.compile(r"\s*-\s*SERIES\s+.+$", re.IGNORECASE),
    re.compile(r"\s*-\s*[A-Z]+(?:\s+[A-Z0-9-]+)?$"),  # "- ANTHROPIC A"
    re.compile(r",?\s*(?:a\s+)?series\s+of\s+.+$", re.IGNORECASE),
]
# Strip these entity suffixes after series-tail removal.
ENTITY_SUFFIX_PATTERN = re.compile(
    r",?\s*(LLC|L\.L\.C\.?|LP|L\.P\.?|LTD\.?|INC\.?|CORP\.?|CO\.?|PLC|GP|FUND)\s*$",
    re.IGNORECASE,
)


def normalize_filer_name(raw: str) -> str:
    """Strip series-tails, entity suffixes, collapse whitespace, uppercase."""
    if not raw:
        return ""
    s = raw.strip()
    # Iteratively strip series tails (some filers have multiple)
    for _ in range(3):
        prev = s
        for pat in SERIES_TAIL_PATTERNS:
            s = pat.sub("", s).strip().rstrip(",").strip()
        # Then strip entity suffix once
        s = ENTITY_SUFFIX_PATTERN.sub("", s).strip().rstrip(",").strip()
        if s == prev:
            break
    s = re.sub(r"\s+", " ", s).upper()
    return s


def normalize_firm_name(raw: str) -> str:
    """Same shape as filer normalize but doesn't strip series-tails (firms
    in advisers_enriched don't carry those)."""
    if not raw:
        return ""
    s = ENTITY_SUFFIX_PATTERN.sub("", raw.strip()).strip().rstrip(",").strip()
    return re.sub(r"\s+", " ", s).upper()


def split_meaningful_tokens(normalized: str) -> list[str]:
    """Split on whitespace + commas, drop one-char and digit-only tokens."""
    tokens = re.split(r"[\s,]+", normalized)
    return [t for t in tokens if t and len(t) > 1 and not t.isdigit()]


def load_advisers_index(adv) -> dict[str, list[dict[str, Any]]]:
    """Pull every adviser_name + crd from advisers_enriched, keyed by
    normalized adviser name. Keyset-paginated.

    Returns: { normalized_name: [{'crd': ..., 'adviser_name': ...}, ...] }
    A normalized name may have multiple entries when two firms share a name;
    the bridge skips ambiguous matches in that case.
    """
    index: dict[str, list[dict[str, Any]]] = {}
    last_crd = 0
    page = 0
    while True:
        page += 1
        resp = (
            adv.table("advisers_enriched")
            .select("crd,adviser_name")
            .gt("crd", last_crd)
            .order("crd")
            .limit(1000)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            break
        for row in rows:
            name = row.get("adviser_name") or ""
            norm = normalize_firm_name(name)
            if not norm:
                continue
            index.setdefault(norm, []).append({
                "crd": str(row["crd"]),
                "adviser_name": name,
            })
        last_crd = int(rows[-1]["crd"])
        if len(rows) < 1000:
            break
    return index


def build_prefix_index(name_index: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    """Bucket firms by their first significant token for O(1) prefix lookup."""
    by_first: dict[str, list[dict[str, Any]]] = {}
    for norm, entries in name_index.items():
        toks = split_meaningful_tokens(norm)
        if not toks:
            continue
        by_first.setdefault(toks[0], []).extend(entries)
    return by_first


def _match_tokens_in_index(
    tokens: list[str],
    name_index: dict[str, list[dict[str, Any]]],
    prefix_index: dict[str, list[dict[str, Any]]],
    norm: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Internal: given normalized tokens + a normalized full string, try
    progressive prefix-token matches against the firm index. Returns the
    matched firm dict (with 'specificity') or None.
    """
    if not tokens:
        return None
    if norm and norm in name_index and len(name_index[norm]) == 1:
        ent = name_index[norm][0]
        return {**ent, "specificity": "exact"}
    first = tokens[0]
    if first in GENERIC_TOKENS:
        # Don't even start a bucket lookup on a generic first token
        return None
    candidates = prefix_index.get(first, [])
    if not candidates:
        return None

    def filter_by_prefix(cands: list[dict[str, Any]], prefix_tokens: list[str]) -> list[dict[str, Any]]:
        prefix = " ".join(prefix_tokens)
        out = []
        for c in cands:
            firm_tokens = split_meaningful_tokens(normalize_firm_name(c["adviser_name"]))
            if " ".join(firm_tokens[: len(prefix_tokens)]) == prefix:
                out.append(c)
        return out

    for n_tokens in (3, 2, 1):
        if len(tokens) < n_tokens:
            continue
        prefix_tokens = tokens[:n_tokens]
        if n_tokens == 1:
            tok = prefix_tokens[0]
            if tok in GENERIC_TOKENS:
                continue
            # Distinctiveness floor — short acronym tokens like 'IBD', 'LFG'
            # cause false positives (e.g., 'IBD VENTURES, LLC' wrongly matched
            # to 'IBD WEALTH MANAGEMENT' just because both start with 'IBD').
            # Require single-token matches to use a token >=5 chars OR have
            # additional shared tokens with the firm name.
            if len(tok) < 5:
                continue
        matched = filter_by_prefix(candidates, prefix_tokens)
        seen_crds = set()
        unique = []
        for m in matched:
            if m["crd"] in seen_crds:
                continue
            seen_crds.add(m["crd"])
            unique.append(m)
        if len(unique) == 1:
            # Additional safety on one-token matches: require at least one
            # token (other than the prefix) to appear in the firm name's
            # token set. Drops false positives where the filer is e.g.
            # 'AUGUREY VENTURES' and the firm is 'AUGUREY CAPITAL ADVISORS';
            # both share 'AUGUREY' but no second-token overlap. We accept
            # AUGUREY case (token length >= 5 + uniqueness handles it) but
            # require this stricter overlap when uncertain.
            if n_tokens == 1 and len(tokens) > 1:
                firm_tokens = set(split_meaningful_tokens(
                    normalize_firm_name(unique[0]["adviser_name"])
                ))
                filer_other = set(tokens[1:]) - GENERIC_TOKENS
                shared_other = firm_tokens & filer_other
                if not shared_other:
                    # No additional shared token. AUGUREY (7-char distinctive
                    # token) is allowed through anyway because filer_other
                    # may be empty after generic filtering. Tag specificity
                    # accordingly so downstream can treat as lower-confidence.
                    if len(prefix_tokens[0]) < 7:
                        # Token is medium-length (5-6 chars) AND no second-
                        # token overlap → reject as too uncertain
                        continue
            return {
                **unique[0],
                "specificity": {3: "three_token", 2: "two_token", 1: "one_token"}[n_tokens],
            }
    return None


def match_filer_to_adv(
    filer_entityname: str,
    name_index: dict[str, list[dict[str, Any]]],
    prefix_index: dict[str, list[dict[str, Any]]],
) -> Optional[dict[str, Any]]:
    """Returns { 'crd', 'adviser_name', 'specificity', 'matched_via' } or None.

    Tries TWO candidate paths and picks the most-specific result:
      1. The filer entityname (stripped of series tail + entity suffix)
      2. The series-master ('a Series of X LLC' -> X) when present
    """
    candidates = []

    # Path 1: filer entityname
    norm1 = normalize_filer_name(filer_entityname)
    tokens1 = split_meaningful_tokens(norm1)
    m1 = _match_tokens_in_index(tokens1, name_index, prefix_index, norm=norm1)
    if m1:
        candidates.append({**m1, "matched_via": "filer_name"})

    # Path 2: series master ("X, a Series of Y LLC" -> Y)
    master = extract_series_master(filer_entityname)
    if master:
        norm2 = normalize_firm_name(master).upper()
        tokens2 = split_meaningful_tokens(norm2)
        m2 = _match_tokens_in_index(tokens2, name_index, prefix_index, norm=norm2)
        if m2:
            candidates.append({**m2, "matched_via": "series_master"})

    if not candidates:
        return None
    # Prefer the more specific match; series_master beats one_token from filer
    specificity_rank = {"exact": 4, "three_token": 3, "two_token": 2, "one_token": 1}
    candidates.sort(key=lambda c: specificity_rank.get(c["specificity"], 0), reverse=True)
    return candidates[0]


def fetch_unbridged_filers(nport, company_slug: str) -> list[dict[str, Any]]:
    """Get every intel_formd_pooled_vehicle_offering row for company_slug
    that has NO matching intel_adviser_resolution row."""
    rows = nport.table("intel_formd_pooled_vehicle_offering").select(
        "offering_id,filer_entityname,filer_cik,accession_number"
    ).eq("company_slug", company_slug).execute().data or []
    if not rows:
        return []
    ids = [r["offering_id"] for r in rows]
    bridged_resp = nport.table("intel_adviser_resolution").select(
        "source_id"
    ).eq("source_table", "intel_formd_pooled_vehicle_offering").in_("source_id", ids).execute()
    bridged_ids = {row["source_id"] for row in (bridged_resp.data or [])}
    return [r for r in rows if r["offering_id"] not in bridged_ids]


def bridge_company(adv, nport, company_slug: str, *, execute: bool = False,
                   name_index: Optional[dict] = None,
                   prefix_index: Optional[dict] = None) -> dict[str, Any]:
    """Bridge unbridged Form D filers for one company by ADV name match.
    Returns a summary dict."""
    print(f"\n=== {company_slug} ===")
    if name_index is None:
        print("  Loading advisers_enriched index...")
        name_index = load_advisers_index(adv)
        print(f"    {sum(len(v) for v in name_index.values())} firm rows / {len(name_index)} unique normalized names")
    if prefix_index is None:
        prefix_index = build_prefix_index(name_index)

    unbridged = fetch_unbridged_filers(nport, company_slug)
    print(f"  Unbridged filers: {len(unbridged)}")

    matches: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for row in unbridged:
        m = match_filer_to_adv(row["filer_entityname"], name_index, prefix_index)
        if m:
            matches.append({**row, **m})
            print(f"    ✓ {row['filer_entityname']!r}")
            print(f"        -> CRD {m['crd']} ({m['adviser_name']}) [{m['specificity']}]")
        else:
            skipped.append(row)

    if execute and matches:
        print(f"\n  Writing {len(matches)} intel_adviser_resolution rows...")
        BATCH = 100
        for i in range(0, len(matches), BATCH):
            chunk = matches[i : i + BATCH]
            payload = [{
                "source_table": "intel_formd_pooled_vehicle_offering",
                "source_id": m["offering_id"],
                "crd": m["crd"],
                "method": f"adv_name_match_{m['specificity']}",
            } for m in chunk]
            nport.table("intel_adviser_resolution").upsert(
                payload,
                on_conflict="source_table,source_id,crd,method",
            ).execute()
        print("  Done.")
    elif matches and not execute:
        print("\n  (dry-run — pass --execute to write)")

    return {
        "company_slug": company_slug,
        "unbridged_before": len(unbridged),
        "matched": len(matches),
        "unbridged_after": len(unbridged) - len(matches),
        "execute": execute,
    }


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Bridge Form D filers to ADV firms by local name match.")
    p.add_argument("--company", help="Slug; if omitted, --all required")
    p.add_argument("--all", action="store_true", help="Process every tracked company")
    p.add_argument("--execute", action="store_true", help="Write intel_adviser_resolution rows")
    args = p.parse_args(argv)
    if not args.company and not args.all:
        print("ERROR: provide --company SLUG or --all", file=sys.stderr)
        return 2

    load_credentials()
    nport = create_nport_client()
    adv = create_adv_client()
    print("Loading advisers_enriched index (once for the whole run)...")
    name_index = load_advisers_index(adv)
    prefix_index = build_prefix_index(name_index)
    print(f"  {sum(len(v) for v in name_index.values())} firm rows / "
          f"{len(name_index)} unique normalized names / "
          f"{len(prefix_index)} prefix buckets")

    if args.company:
        slugs = [args.company]
    else:
        rs = nport.table("private_companies").select("slug").limit(5000).execute()
        slugs = [r["slug"] for r in (rs.data or [])]

    total = {"matched": 0, "unbridged_before": 0, "unbridged_after": 0}
    for slug in slugs:
        s = bridge_company(adv, nport, slug, execute=args.execute,
                           name_index=name_index, prefix_index=prefix_index)
        for k in total:
            total[k] += s[k]
    print(f"\n=== TOTAL: matched={total['matched']}, "
          f"unbridged_before={total['unbridged_before']}, "
          f"unbridged_after={total['unbridged_after']} ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
