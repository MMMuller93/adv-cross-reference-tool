"""Tests for the N-PORT entity-resolution module.

Validates the §5 algorithm against:
    - 15 real raw ISSUER_TITLE strings for Anthropic from PLAN §3.1
    - 5 SPV-wrapper unwrap cases from PLAN §3.1
    - 4 false-positive substring traps from PLAN §3.1
    - Sanctioned-securities short-circuit (Sberbank)

Run with:
    pytest test_resolver.py -v
"""
from __future__ import annotations

import pytest

from nport.resolver import (
    Resolver,
    extract_share_class,
    load_seed_aliases,
    normalize_issuer,
    unwrap_spv,
)


# -- Fixtures ------------------------------------------------------------------


@pytest.fixture(scope="module")
def resolver() -> Resolver:
    """A Resolver pre-seeded from aliases_seed.json (no IDENTIFIERS lookup)."""
    return Resolver(load_seed_aliases(), identifiers_lookup=None)


# -- Anthropic: the 15 ISSUER_TITLE patterns from §3.1 -------------------------
# Verbatim from PLAN_NPORT_HOLDINGS.md §3.1 lines 274-281.

ANTHROPIC_RAW_STRINGS: list[str] = [
    # Left column
    "ANTHROPIC PBC",
    "ANTHROPIC",
    "ANTHROPIC PBC SER B PC PP",
    "ANTHROPIC PBC SERIES D PC PP",
    "ANTHROPIC PBC SERIES E PC PP",
    "ANTHROPIC PBC SERIES F PC PP",
    "ANTHROPIC PBC SERIES G PC PP",
    "ANTHROPIC PBC SER F-1 CVT PFD PP",
    # Right column
    "Anthropic PBC",
    "Anthropic, Inc.",
    "Anthropic PBC, Series F",
    "Anthropic PBC, Series F1",
    "Anthropic PBC, Series G-1",
    "ANTHROPIC, PBC SERIES E-1 PREFERRED STOCK",
    "ANTHROPIC PBC CL F-1 PFD PP (PHYSICAL) (NOT LISTED OR TRADING)",
]


@pytest.mark.parametrize("raw_title", ANTHROPIC_RAW_STRINGS)
def test_anthropic_real_strings_resolve(resolver: Resolver, raw_title: str) -> None:
    """All 15 real Anthropic ISSUER_TITLE strings must resolve to 'anthropic'.

    The input is given as the title (filers commonly populate title with the
    full descriptive string and ISSUER_NAME with the shorter entity name).
    We pass it as both ISSUER_NAME and ISSUER_TITLE to exercise the most
    common case — most rows have these aligned.
    """
    row = {
        "issuer_name": raw_title,
        "issuer_title": raw_title,
        "issuer_lei": None,
        "asset_cat": "EC",
        "holding_id": "TEST_HOLDING",
    }
    result = resolver.resolve(row)
    assert result["resolved_company_id"] == "anthropic", (
        f"Expected anthropic, got {result['resolved_company_id']} "
        f"(source={result['resolution_source']}, normalized={normalize_issuer(raw_title)!r})"
    )
    assert result["resolution_source"] in {
        "alias_exact",
        "alias_prefix",
        "alias_exact_title",
        "alias_prefix_title",
        "lei",
    }


def test_anthropic_lei_resolution(resolver: Resolver) -> None:
    """Step 1: LEI exact match wins outright (POC: 50% of Anthropic rows)."""
    row = {
        "issuer_name": "SOMETHING TOTALLY UNRELATED",
        "issuer_title": "SOMETHING TOTALLY UNRELATED",
        "issuer_lei": "984500B6DEB8CEBC4Z70",  # Anthropic LEI (POC-validated)
        "asset_cat": "EC",
        "holding_id": "X",
    }
    result = resolver.resolve(row)
    assert result["resolved_company_id"] == "anthropic"
    assert result["resolution_source"] == "lei"
    assert result["resolution_confidence"] == 100


def test_anthropic_title_only_fallback(resolver: Resolver) -> None:
    """POC Row #2: ISSUER_NAME='N/A' with entity only in ISSUER_TITLE.

    The 'N/A' name path must fall back to the title for exact or prefix match.
    """
    row = {
        "issuer_name": "N/A",
        "issuer_title": "ANTHROPIC, PBC SERIES E-1 PREFERRED STOCK",
        "issuer_lei": None,
        "asset_cat": "EC",
        "holding_id": "X",
    }
    result = resolver.resolve(row)
    assert result["resolved_company_id"] == "anthropic"
    assert result["resolution_source"] in {"alias_exact_title", "alias_prefix_title"}


# -- SPV unwrap: 5 strings from §3.1 ------------------------------------------

SPV_CASES: list[tuple[str, str, str]] = [
    (
        "DXYZ OAI I LLC (economic exposure to OpenAI Global LLC, Profit Participation Units)",
        "openai",
        "spv_economic_exposure",
    ),
    (
        "AESTAS LLC dba OPENAI LLC EV UNITS Class A",
        "openai",
        "spv_aestas",
    ),
    (
        "Celadon Technology Fund VIII, LLC - Series B (economic exposure to Space Exploration Technologies Corp., Common Stock)",
        "spacex",
        "spv_economic_exposure",
    ),
    (
        "SPV EXPOSURE TO SPACEX LLC",
        "spacex",
        "spv_exposure",
    ),
    (
        "MWAM VC SpaceX-II, LLC",
        "spacex",
        "spv_mwam",
    ),
]


@pytest.mark.parametrize("raw,expected_slug,expected_pattern", SPV_CASES)
def test_spv_unwrap_pattern(
    resolver: Resolver, raw: str, expected_slug: str, expected_pattern: str
) -> None:
    """SPV unwrap must extract the underlier AND resolve it to the right company."""
    # 1. Raw pattern match.
    underlier, pattern_name = unwrap_spv(raw)
    assert underlier is not None, f"unwrap failed for: {raw}"
    assert pattern_name == expected_pattern

    # 2. End-to-end resolution.
    row = {
        "issuer_name": raw,
        "issuer_title": raw,
        "issuer_lei": None,
        "asset_cat": "EC",
        "holding_id": "X",
    }
    result = resolver.resolve(row)
    assert result["resolved_company_id"] == expected_slug, (
        f"SPV {raw!r} expected={expected_slug} got={result['resolved_company_id']}"
    )
    assert result["resolution_source"] == "spv_regex"
    assert result["exposure_type"] == "spv"
    assert result["underlier_issuer_name"] is not None


def test_mwam_multiword_capture() -> None:
    """POC fix: \\w+ truncates multi-word names. Confirm we now capture them."""
    # SpaceX is a single token so the bug doesn't surface there, but the fix
    # uses .+? up to dash/comma/LLC which handles compound names. Build a
    # synthetic compound case to lock the regex behavior.
    underlier, pattern_name = unwrap_spv("MWAM VC Space Exploration Tech-II, LLC")
    assert pattern_name == "spv_mwam"
    assert underlier == "Space Exploration Tech"


# -- False-positive substring traps from §3.1 ---------------------------------

FALSE_POSITIVE_CASES: list[tuple[str, str]] = [
    ("Under Canvas Inc", "canva"),               # glamping company, not Canva
    ("Pinstripes Holdings", "stripe"),           # entertainment, not Stripe
    ("Stripes VI Rainier", "stripe"),            # PE fund, not Stripe
    ("Anyscale Inc", "scale-ai"),                # not Scale AI
]


@pytest.mark.parametrize("raw,wrong_slug", FALSE_POSITIVE_CASES)
def test_false_positive_substring(resolver: Resolver, raw: str, wrong_slug: str) -> None:
    """Naive substring matches must NOT resolve to the named slug."""
    row = {
        "issuer_name": raw,
        "issuer_title": raw,
        "issuer_lei": None,
        "asset_cat": "EC",
        "holding_id": "X",
    }
    result = resolver.resolve(row)
    assert result["resolved_company_id"] != wrong_slug, (
        f"FALSE POSITIVE: {raw!r} incorrectly resolved to {wrong_slug}"
    )


# -- Sanctioned-securities short-circuit --------------------------------------


def test_sanctioned_sberbank(resolver: Resolver) -> None:
    """Sberbank must be flagged as sanctioned, not resolved as a tradeable company."""
    row = {
        "issuer_name": "Sberbank of Russia",
        "issuer_title": "Sberbank of Russia ADR",
        "issuer_lei": None,
        "asset_cat": "EC",
        "holding_id": "X",
    }
    result = resolver.resolve(row)
    assert result["resolution_source"] == "sanctioned"
    assert result["resolved_company_id"] is None


# -- Normalizer unit checks ---------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Anthropic, PBC", "ANTHROPIC"),
        ("ANTHROPIC PBC SERIES E PC PP", "ANTHROPIC PBC SERIES E"),
        ("ANTHROPIC PBC SER F-1 CVT PFD PP", "ANTHROPIC PBC SER F 1"),
        (
            "ANTHROPIC PBC CL F-1 PFD PP (PHYSICAL) (NOT LISTED OR TRADING)",
            "ANTHROPIC PBC CL F 1 PFD",
        ),
        ("Anthropic, Inc.", "ANTHROPIC"),
        ("Space Exploration Technologies Corp.", "SPACE EXPLORATION TECHNOLOGIES"),
        (None, ""),
        ("", ""),
    ],
)
def test_normalize_issuer(raw: str | None, expected: str) -> None:
    assert normalize_issuer(raw) == expected


# -- Share-class extraction ---------------------------------------------------


@pytest.mark.parametrize(
    "title,exp_normalized,exp_type",
    [
        ("ANTHROPIC PBC SER F-1 CVT PFD PP", "Series F-1", "convertible_preferred"),
        ("ANTHROPIC, PBC SERIES E-1 PREFERRED STOCK", "Series E-1", "preferred"),
        ("Anthropic PBC, Series G-1", "Series G-1", "unspecified"),
        ("ANTHROPIC PBC CL F-1 PFD PP", "Class F-1", "preferred"),
        ("Space Exploration Technologies Corp., Common Stock", "Common", "common"),
        (None, "unspecified", "unspecified"),
    ],
)
def test_extract_share_class(
    title: str | None, exp_normalized: str, exp_type: str
) -> None:
    info = extract_share_class(title)
    assert info["normalized"] == exp_normalized
    assert info["security_type"] == exp_type
