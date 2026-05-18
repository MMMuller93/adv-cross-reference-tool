"""Tests for reconcile_live.py's pure resolution logic.

These tests cover compute_desired_state and diff_states — the deterministic
heart of the reconciliation phase. No Supabase access required.
"""
from __future__ import annotations

from nport.enrichment.ncen_ingest.reconcile_live import (
    compute_desired_state,
    diff_states,
)


# ----------------------------------------------------------------------------
# compute_desired_state — the pure resolution function
# ----------------------------------------------------------------------------

def test_single_adviser_across_series_resolves_when_in_adv():
    """One unique CRD across all series + CRD in advisers_enriched -> write it."""
    links = [
        {"registrant_cik": "0000024238", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "108281", "series_id": "S001"},
        {"registrant_cik": "0000024238", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "108281", "series_id": "S002"},
        {"registrant_cik": "0000024238", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "108281", "series_id": "S003"},
    ]
    adv_crds = {"108281", "106614", "105496"}
    desired = compute_desired_state(links, adv_crds)
    assert desired == {
        "0000024238": {
            "adv_crd": "108281",
            "method": "ncen_xref",
            "bucket": "resolved_single",
        }
    }


def test_single_adviser_clears_when_crd_not_in_adv():
    """Single CRD parsed but not in advisers_enriched -> leave NULL."""
    links = [
        {"registrant_cik": "0000099999", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "999999", "series_id": "S001"},
    ]
    adv_crds = {"108281", "106614"}
    desired = compute_desired_state(links, adv_crds)
    assert desired["0000099999"] == {
        "adv_crd": None,
        "method": None,
        "bucket": "cleared_not_in_adv",
    }


def test_multi_adviser_clears_to_null():
    """Multiple distinct CRDs across series -> leave NULL (no tie-break)."""
    links = [
        {"registrant_cik": "0000012345", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "106614", "series_id": "S001"},
        {"registrant_cik": "0000012345", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "105247", "series_id": "S002"},
        {"registrant_cik": "0000012345", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "106614", "series_id": "S003"},
    ]
    adv_crds = {"106614", "105247"}
    desired = compute_desired_state(links, adv_crds)
    assert desired["0000012345"] == {
        "adv_crd": None,
        "method": None,
        "bucket": "cleared_multi_adviser",
    }


def test_no_primary_adviser_returns_no_entry():
    """Registrant with only sub-advisers, no investment_adviser link -> no entry
    in desired state at all (we don't try to clear something that was never set)."""
    links = [
        {"registrant_cik": "0000088888", "adviser_role": "subadviser",
         "adviser_crd_normalized": "111111", "series_id": "S001"},
        {"registrant_cik": "0000088888", "adviser_role": "subadviser",
         "adviser_crd_normalized": "111111", "series_id": "S002"},
    ]
    adv_crds = {"108281"}
    desired = compute_desired_state(links, adv_crds)
    assert "0000088888" not in desired


def test_sub_advisers_dont_count_for_primary_resolution():
    """Sub-adviser CRDs must NOT influence the investment_adviser determination.

    Codex bug C: original code was counting raw link rows; sub-advisers should
    be filtered out entirely.
    """
    links = [
        # 1 primary adviser for series S001
        {"registrant_cik": "0000077777", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "200000", "series_id": "S001"},
        # 5 sub-advisers with a DIFFERENT CRD across multiple series
        {"registrant_cik": "0000077777", "adviser_role": "subadviser",
         "adviser_crd_normalized": "111111", "series_id": "S001"},
        {"registrant_cik": "0000077777", "adviser_role": "subadviser",
         "adviser_crd_normalized": "111111", "series_id": "S002"},
        {"registrant_cik": "0000077777", "adviser_role": "subadviser",
         "adviser_crd_normalized": "111111", "series_id": "S003"},
        {"registrant_cik": "0000077777", "adviser_role": "subadviser",
         "adviser_crd_normalized": "111111", "series_id": "S004"},
        {"registrant_cik": "0000077777", "adviser_role": "subadviser",
         "adviser_crd_normalized": "111111", "series_id": "S005"},
    ]
    adv_crds = {"200000", "111111"}
    desired = compute_desired_state(links, adv_crds)
    # Should resolve to 200000, not be confused by the sub-adviser count
    assert desired["0000077777"] == {
        "adv_crd": "200000",
        "method": "ncen_xref",
        "bucket": "resolved_single",
    }


def test_distinct_series_counted_not_raw_link_rows():
    """Codex bug C fix: when the parser emits multiple investment_adviser
    rows for the SAME series, we count distinct series — not raw row count.

    Here, series S001 has two investment_adviser entries (same CRD, same series)
    and series S002 has one. The 'across distinct series' count for CRD 100000
    is 2 (S001, S002), which is what we want — not 3 (raw rows)."""
    links = [
        # Same series, two parser-emitted adviser rows (same CRD)
        {"registrant_cik": "0000066666", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "100000", "series_id": "S001"},
        {"registrant_cik": "0000066666", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "100000", "series_id": "S001"},
        # Different series, same CRD
        {"registrant_cik": "0000066666", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "100000", "series_id": "S002"},
    ]
    adv_crds = {"100000"}
    desired = compute_desired_state(links, adv_crds)
    assert desired["0000066666"]["adv_crd"] == "100000"
    assert desired["0000066666"]["bucket"] == "resolved_single"


def test_multi_adviser_within_same_series_still_clears_to_null():
    """If one series legitimately has two different investment_adviser CRDs
    in N-CEN (rare but possible), the registrant has multiple distinct CRDs
    across its data -> clear to NULL."""
    links = [
        {"registrant_cik": "0000055555", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "100000", "series_id": "S001"},
        {"registrant_cik": "0000055555", "adviser_role": "investment_adviser",
         "adviser_crd_normalized": "200000", "series_id": "S001"},
    ]
    adv_crds = {"100000", "200000"}
    desired = compute_desired_state(links, adv_crds)
    assert desired["0000055555"] == {
        "adv_crd": None,
        "method": None,
        "bucket": "cleared_multi_adviser",
    }


# ----------------------------------------------------------------------------
# diff_states — idempotency check
# ----------------------------------------------------------------------------

def test_diff_states_skips_when_already_correct():
    """If current state matches desired, no diff."""
    current = {
        "0000024238": {"adv_crd": "108281", "adv_crd_match_method": "ncen_xref"},
    }
    desired = {
        "0000024238": {"adv_crd": "108281", "method": "ncen_xref", "bucket": "resolved_single"},
    }
    diffs = diff_states(current, desired)
    assert diffs == []


def test_diff_states_emits_diff_when_value_changes():
    current = {
        "0000024238": {"adv_crd": "999999", "adv_crd_match_method": "ncen_xref"},
    }
    desired = {
        "0000024238": {"adv_crd": "108281", "method": "ncen_xref", "bucket": "resolved_single"},
    }
    diffs = diff_states(current, desired)
    assert len(diffs) == 1
    assert diffs[0]["cik"] == "0000024238"
    assert diffs[0]["target_adv_crd"] == "108281"
    assert diffs[0]["current_adv_crd"] == "999999"


def test_diff_states_emits_diff_to_clear_stale_value():
    """A registrant currently set to 108281 but now resolving to NULL (multi-adviser
    became ambiguous after new series data arrived) must be cleared, not skipped."""
    current = {
        "0000024238": {"adv_crd": "108281", "adv_crd_match_method": "ncen_xref"},
    }
    desired = {
        "0000024238": {"adv_crd": None, "method": None, "bucket": "cleared_multi_adviser"},
    }
    diffs = diff_states(current, desired)
    assert len(diffs) == 1
    assert diffs[0]["target_adv_crd"] is None
    assert diffs[0]["target_method"] is None
    assert diffs[0]["current_adv_crd"] == "108281"
