"""Validate the Form D abbreviation-gap matcher.

Usage:
  python intelligence/validate_anth_matcher.py [--company anthropic|openai] [--show-misses]

Steps:
  1. Pull every form_d_filings row whose entityname contains a word-boundary
     short-code for the company (e.g. '\\mANTH', '\\mOAI').
  2. Run each row through formd_company_matcher.evaluate_filing(company).
  3. Partition into auto_include / candidate / excluded.
  4. Spot-check against known TP/FP samples.

Acceptance:
  - All sample TRUE-POSITIVES must land in auto_include or already be caught
    by the company's long-name alias (e.g., 'ANTHROPIC' / 'OPENAI').
  - No sample FALSE-POSITIVE name should land in auto_include.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

# Make `intelligence` package importable when run as a script.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from intelligence.materialize_holders import (  # noqa: E402
    create_formd_client,
    load_credentials,
)
from intelligence.formd_company_matcher import (  # noqa: E402
    evaluate_filing,
    get_rules,
)


PROFILES: dict[str, dict] = {
    "anthropic": {
        "short_code_regex": r"\mANTH",
        "long_alias_token": "ANTHROPIC",
        "true_positives": [
            "ANTH FUND I",                 # Altra Venture / HF Scale
            "ANTH FUND IV",                # Altra FrontierTech
            "Anth V Aug 2025",             # CGF2021 Sydecar
            "Anth IV Jul 2025",            # CGF2021 Sydecar
            "CC ANTH I",                   # CGF2021 Sydecar
            "CC ANTH II",                  # CGF2021 Sydecar
        ],
        "false_positives": [
            "Pantheon", "Pantheum", "Panthera", "Panther",
            "Anthony", "Anthem", "Anthology",
            "Anthropy Master", "ANTHR SYND",
        ],
    },
    "openai": {
        "short_code_regex": r"\mOAI",
        "long_alias_token": "OPENAI",
        "true_positives": [
            "OAI Fund I",                  # Altra Venture II
            "OAI Fund II",                 # Altra FrontierTech
            "OAI Sunshine Eureka",         # CGF2021 Sydecar
            "LFG OAI",                     # CGF2021 Sydecar
            "Khosla Ventures OAI",         # Khosla SPV
            "Type One OAI",                # Type One SPV
        ],
        # Pre-emptive: no known FPs in current universe.
        "false_positives": [],
    },
    "spacex": {
        "short_code_regex": r"\mSP(CX|X)\M",
        "long_alias_token": "SPACEX",
        "true_positives": [
            "SPCX SYND I",                 # Alt Financial
            "OurCrowd (Investment in SpcX)",
            "DCP SPX XIV",                 # CGF2021 Sydecar
            "DPV SPX V",                   # DataPower + Sydecar
            "LFG SPX",                     # Sydecar
            "VELVET SPX Opportunity II",   # Sydecar
        ],
        # Ambiguous SPX hits that should NOT auto-include (no Sydecar guard).
        "false_positives": [
            "SPX MGMT LLC",
            "Global Eagle",
            "Hawker",
        ],
    },
    "canva": {
        "short_code_regex": r"\mCNVA\M",
        "long_alias_token": "CANVA",
        "true_positives": [
            "OurCrowd (Investment in Cnva)",
        ],
        "false_positives": [],
    },
}


def fetch_shortcode_universe(formd, short_code_regex: str) -> list[dict]:
    """Pull every form_d_filings row matching the given short-code regex,
    excluding D/A amendments.
    """
    SELECT = (
        "id,accessionnumber,entityname,cik,series_master_llc,"
        "filing_date,totalofferingamount,related_names,isamendment"
    )
    rows: list[dict] = []
    last_id = 0
    while True:
        response = (
            formd.table("form_d_filings")
            .select(SELECT)
            .filter("entityname", "imatch", short_code_regex)
            .neq("isamendment", "true")
            .gt("id", last_id)
            .order("id")
            .limit(1000)
            .execute()
        )
        batch = response.data or []
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        last_id = int(batch[-1]["id"])
    return rows


# Backwards-compat alias for older callers.
fetch_anth_universe = lambda formd: fetch_shortcode_universe(formd, r"\mANTH")


def has_keyword_match(text: str, samples: list[str]) -> bool:
    if not text:
        return False
    upper = text.upper()
    return any(s.upper() in upper for s in samples)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--company",
        default="anthropic",
        choices=sorted(PROFILES.keys()),
        help="Which company profile to validate.",
    )
    parser.add_argument(
        "--show-misses",
        action="store_true",
        help="Print all 'excluded' rows for manual inspection.",
    )
    parser.add_argument(
        "--show-includes",
        action="store_true",
        help="Print all 'auto_include' rows.",
    )
    args = parser.parse_args(argv)

    profile = PROFILES[args.company]
    if not get_rules(args.company):
        print(f"ERROR: no rules registered for {args.company!r}")
        return 2

    load_credentials()
    formd = create_formd_client()

    rows = fetch_shortcode_universe(formd, profile["short_code_regex"])
    print(
        f"Pulled {len(rows)} rows where entityname matches "
        f"{profile['short_code_regex']!r} (amendments excluded)."
    )

    auto = []
    candidate = []
    excluded = []
    rule_counter: Counter = Counter()
    for row in rows:
        result = evaluate_filing(args.company, row)
        if not result:
            excluded.append(row)
            continue
        rule_counter[result["rule_key"]] += 1
        if result["decision"] == "auto_include":
            auto.append((row, result))
        else:
            candidate.append((row, result))

    print()
    print(f"auto_include: {len(auto)}")
    print(f"candidate:    {len(candidate)}")
    print(f"excluded:     {len(excluded)}")
    print()
    print("Rule hit counts:")
    for rule_key, count in rule_counter.most_common():
        print(f"  {rule_key}: {count}")

    long_token = profile["long_alias_token"]
    long_in_excluded = [
        r for r in excluded if long_token in (r.get("entityname") or "").upper()
    ]
    print(
        f"\n{long_token!r} in excluded (covered by long-name alias matcher): "
        f"{len(long_in_excluded)}"
    )

    print("\nTrue-positive coverage check:")
    missing_tp = []
    for sample in profile["true_positives"]:
        in_auto = any(
            has_keyword_match(row.get("entityname"), [sample]) for row, _ in auto
        )
        in_alias_cover = any(
            has_keyword_match(row.get("entityname"), [sample])
            and long_token in (row.get("entityname") or "").upper()
            for row in rows
        )
        ok = in_auto or in_alias_cover
        marker = "OK" if ok else "MISS"
        print(f"  [{marker}] '{sample}' -> auto={in_auto} alias={in_alias_cover}")
        if not ok:
            missing_tp.append(sample)

    print("\nFalse-positive containment check (auto_include should be EMPTY):")
    fp_leaks = []
    for sample in profile["false_positives"]:
        leaked = [
            row.get("entityname")
            for row, _ in auto
            if has_keyword_match(row.get("entityname"), [sample])
        ]
        marker = "OK" if not leaked else "LEAK"
        print(f"  [{marker}] '{sample}' -> {len(leaked)} leaks")
        if leaked:
            fp_leaks.extend(leaked)

    if args.show_includes:
        print("\n--- auto_include rows ---")
        for row, result in auto:
            print(f"  [{result['rule_key']}] {row.get('entityname')!r}  "
                  f"({row.get('filing_date')})")

    if args.show_misses:
        non_alias_excluded = [
            r for r in excluded
            if long_token not in (r.get("entityname") or "").upper()
        ]
        print(
            f"\n--- excluded rows (non-{long_token}): "
            f"{len(non_alias_excluded)} ---"
        )
        for row in non_alias_excluded[:50]:
            print(f"  {row.get('entityname')!r}")
        if len(non_alias_excluded) > 50:
            print(f"  ... +{len(non_alias_excluded) - 50} more")

    print()
    if missing_tp:
        print(f"FAIL: {len(missing_tp)} true positives missing: {missing_tp}")
        return 1
    if fp_leaks:
        print(f"FAIL: {len(fp_leaks)} false-positive leaks: {fp_leaks[:5]}")
        return 1
    print("PASS: all true positives covered, no false-positive leaks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
