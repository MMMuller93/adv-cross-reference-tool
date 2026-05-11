"""Regression tests for the Bug 2 fix — scraper Resolver bootstrap.

The pre-fix scraper called `Resolver()` with no aliases inside a
swallowing try/except, which silently produced a pass-through resolver
in production. The fix:

1. Pass real `aliases=load_seed_aliases()` at construction time.
2. Drop the swallowing try/except — fail loudly on a missing/empty seed.

This test reaches into the bootstrap helper to verify both behaviors.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from nport.scraper.backfill_bulk import _build_seed_resolver


def test_seed_resolver_is_real_not_passthrough() -> None:
    """Bootstrap returns a Resolver wired to real aliases."""
    resolver = _build_seed_resolver()
    # Verify it's a real Resolver, not the old `_Pass` shim.
    assert resolver.__class__.__name__ == "Resolver"

    # Verify it actually resolves Anthropic (the bundled seed has 5+ aliases).
    row = {
        "issuer_name": "ANTHROPIC PBC",
        "issuer_title": "ANTHROPIC PBC SER F PC PP",
        "issuer_lei": None,
        "asset_cat": "EC",
        "holding_id": "X",
    }
    result = resolver.resolve(row)
    assert result["resolved_company_id"] == "anthropic", (
        f"bootstrap resolver isn't really resolving — result was {result}"
    )


def test_seed_resolver_fails_loud_on_missing_file(monkeypatch, tmp_path) -> None:
    """Pointing the seed loader at a missing file must FileNotFoundError —
    NOT silently fall back to a pass-through resolver.

    We patch the resolver's seed-file path to point somewhere that doesn't
    exist, then check that _build_seed_resolver raises FileNotFoundError.
    """
    from nport import resolver as resolver_mod

    bad_path = tmp_path / "does_not_exist.json"
    monkeypatch.setattr(resolver_mod, "_SEED_PATH", bad_path)

    with pytest.raises(FileNotFoundError):
        _build_seed_resolver()
