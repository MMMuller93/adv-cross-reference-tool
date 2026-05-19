"""Validate the Anthropic Form D matcher against the 363 ANTH-prefix rows.

Usage:
  python intelligence/validate_anth_matcher.py [--show-misses]

Steps:
  1. Pull every form_d_filings row whose entityname contains a word-boundary
     'ANTH' (Postgres regex ~* '\\mANTH').
  2. Run each row through formd_company_matcher.evaluate_filing('anthropic').
  3. Partition into:
       - auto_include
       - candidate
       - excluded (no rule matched)
  4. Spot-check the excluded bucket: known-Anthropic names should appear in
     auto_include, known-non-Anthropic names should appear in excluded.

Acceptance:
  - All sample TRUE-POSITIVES from the design review must land in auto_include
    or be already caught by the ANTHROPIC alias (we don't need to double-cover).
  - No sample FALSE-POSITIVE name (Pantheon/Panthera/Anthony/Anthem/Anthropy)
    should land in auto_include.
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


TRUE_POSITIVE_SAMPLES = [
    "ANTH FUND I",                 # Altra Venture / HF Scale
    "ANTH FUND IV",                # Altra FrontierTech
    "Anth V Aug 2025",             # CGF2021 Sydecar series
    "Anth IV Jul 2025",            # CGF2021 Sydecar
    "CC ANTH I",                   # CGF2021 Sydecar
    "CC ANTH II",                  # CGF2021 Sydecar
]

FALSE_POSITIVE_SAMPLES = [
    "Pantheon",
    "Pantheum",
    "Panthera",
    "Panther",
    "Anthony",
    "Anthem",
    "Anthology",
    "Anthropy Master",
    "ANTHR SYND",
]


def fetch_anth_universe(formd) -> list[dict]:
    """Pull every form_d_filings row with a word-boundary ANTH in entityname,
    excluding D/A amendments. Mirrors the matcher's server-side query.
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
            .filter("entityname", "imatch", r"\mANTH")
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


def has_keyword_match(text: str, samples: list[str]) -> bool:
    if not text:
        return False
    upper = text.upper()
    return any(s.upper() in upper for s in samples)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
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

    if not get_rules("anthropic"):
        print("ERROR: no rules registered for 'anthropic'")
        return 2

    load_credentials()
    formd = create_formd_client()

    rows = fetch_anth_universe(formd)
    print(f"Pulled {len(rows)} rows where entityname has word-boundary ANTH "
          f"(amendments excluded).")

    auto = []
    candidate = []
    excluded = []
    rule_counter: Counter = Counter()
    for row in rows:
        result = evaluate_filing("anthropic", row)
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

    # Check ANTHROPIC keyword (already covered by alias matcher).
    anth_in_excluded = [r for r in excluded if "ANTHROPIC" in (r.get("entityname") or "").upper()]
    print(f"\n'ANTHROPIC' in excluded (covered by alias matcher): {len(anth_in_excluded)}")

    # True-positive coverage check: known TP names should appear in auto_include
    # OR be already covered by ANTHROPIC alias.
    print("\nTrue-positive coverage check:")
    missing_tp = []
    for sample in TRUE_POSITIVE_SAMPLES:
        in_auto = any(
            has_keyword_match(row.get("entityname"), [sample]) for row, _ in auto
        )
        in_alias_cover = any(
            has_keyword_match(row.get("entityname"), [sample])
            and "ANTHROPIC" in (row.get("entityname") or "").upper()
            for row in rows
        )
        ok = in_auto or in_alias_cover
        marker = "OK" if ok else "MISS"
        print(f"  [{marker}] '{sample}' -> auto={in_auto} alias={in_alias_cover}")
        if not ok:
            missing_tp.append(sample)

    # False-positive containment check: NONE of these should appear in auto.
    print("\nFalse-positive containment check (auto_include should be EMPTY):")
    fp_leaks = []
    for sample in FALSE_POSITIVE_SAMPLES:
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
        # Filter to non-ANTHROPIC excluded (the others are alias-covered already).
        non_alias_excluded = [
            r for r in excluded
            if "ANTHROPIC" not in (r.get("entityname") or "").upper()
        ]
        print(f"\n--- excluded rows (non-ANTHROPIC): {len(non_alias_excluded)} ---")
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
