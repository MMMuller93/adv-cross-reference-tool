"""Per-filer tests for the N-CSR / N-CSRS acquisition-cost extractors.

Fixtures:
- ark_venture_ncsr.htm — full real EDGAR fetch (accession 0001213900-24-086293,
  Anthropic + SpaceX + OpenAI rows present)
- fidelity_restricted_table_synthetic.html — synthetic table matching the
  documented Fidelity structure (see ncsr_findings.md Filing 2)
- trp_inline_synthetic.html — synthetic doc matching the TRP inline pattern
  (see ncsr_findings.md Filing 3)
- destiny_ixbrl_synthetic.html — synthetic doc matching the Destiny iXBRL
  layout (see ncsr_findings.md Filing 4)

The Fidelity, TRP, and Destiny synthetic fixtures use the EXACT data values
from ncsr_findings.md so the assertions correspond to real filings.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

HERE = Path(__file__).parent.resolve()

from nport.enrichment.ncsr_enrich.dispatcher import classify, dispatch
from nport.enrichment.ncsr_enrich.ncsr_parsers import (
    ark,
    destiny,
    fidelity,
    llm_fallback,
    trp,
)

FIXTURES = HERE / "fixtures"


def _load(name: str) -> str:
    p = FIXTURES / name
    if not p.exists():
        pytest.skip(f"Fixture {p} not present.")
    return p.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# ARK Venture — real N-CSR with Anthropic + SpaceX + OpenAI


def test_ark_extracts_anthropic_row():
    html = _load("ark_venture_ncsr.htm")
    result = ark.parse(html)
    # Find the Anthropic Series C-1 entry — per ncsr_findings.md it has
    # acquisition date 3/31/23 and cost $1,049,998.
    anthropic = [
        e for e in result.entries
        if "Anthropic" in e.security_name and (e.share_class or "").startswith("Series C-1")
    ]
    assert anthropic, f"No Anthropic Series C-1 row found. Got names: {[e.security_name for e in result.entries[:10]]}"
    e = anthropic[0]
    assert e.acquisition_date == "2023-03-31"
    assert e.acquisition_cost_usd == 1_049_998
    assert e.fair_value_usd == 2_672_340
    assert e.shares == 89_078
    assert e.source_filer == "ark"


def test_ark_extracts_multiple_entries():
    html = _load("ark_venture_ncsr.htm")
    result = ark.parse(html)
    assert len(result.entries) > 1, "Expected multiple acquisition entries"
    assert result.confidence > 0.5


def test_ark_dispatcher_routes_to_ark():
    html = _load("ark_venture_ncsr.htm")
    result = dispatch(html, cik="0001905088")
    assert result.parser == "ark"
    assert len(result.entries) > 0


# ---------------------------------------------------------------------------
# Fidelity — restricted-securities table extraction


def test_fidelity_extracts_anthropic_rows():
    html = _load("fidelity_restricted_table_synthetic.html")
    result = fidelity.parse(html)
    by_name = {(e.security_name, e.share_class): e for e in result.entries}
    e_series_e = by_name.get(("Anthropic PBC", "Series E"))
    assert e_series_e is not None, f"Expected Anthropic PBC Series E; got {list(by_name.keys())}"
    assert e_series_e.acquisition_date == "2025-02-14"
    assert e_series_e.acquisition_cost_usd == 835_689
    e_series_f = by_name.get(("Anthropic PBC", "Series F"))
    assert e_series_f is not None
    assert e_series_f.acquisition_date == "2025-08-18"
    assert e_series_f.acquisition_cost_usd == 6_599_257


def test_fidelity_handles_multi_tranche_date_range():
    html = _load("fidelity_restricted_table_synthetic.html")
    result = fidelity.parse(html)
    multi = [e for e in result.entries if e.is_multiple_tranches]
    assert multi, "Expected at least one multi-tranche entry (Applied Intuition)"
    e = multi[0]
    assert e.tranche_start_date == "2024-07-02"
    assert e.tranche_end_date == "2025-06-16"
    # acquisition_date defaults to end-date
    assert e.acquisition_date == "2025-06-16"


def test_fidelity_returns_empty_with_no_restricted_table():
    html = "<html><body>SOI without restricted securities footnote.</body></html>"
    result = fidelity.parse(html)
    assert result.entries == []
    assert result.notes == "no_restricted_table"


# ---------------------------------------------------------------------------
# T. Rowe Price — inline acquisition pattern


def test_trp_extracts_anthropic_inline():
    html = _load("trp_inline_synthetic.html")
    result = trp.parse(html)
    names = {e.security_name for e in result.entries}
    assert "Anthropic" in names
    e = next(e for e in result.entries if e.security_name == "Anthropic")
    assert e.share_class == "Series F-1"
    assert e.acquisition_date == "2025-08-29"
    assert e.acquisition_cost_usd == 38_695


def test_trp_extracts_aestas_openai():
    html = _load("trp_inline_synthetic.html")
    result = trp.parse(html)
    aestas = [e for e in result.entries if "Aestas" in e.security_name or "OpenAI" in e.security_name]
    assert aestas
    e = aestas[0]
    assert e.acquisition_date == "2025-10-03"
    assert e.acquisition_cost_usd == 38_692


# ---------------------------------------------------------------------------
# Destiny Tech100 — iXBRL parsing


def test_destiny_extracts_spv_rows():
    html = _load("destiny_ixbrl_synthetic.html")
    result = destiny.parse(html)
    assert len(result.entries) == 2
    # First row: Celadon SPV → SpaceX exposure
    e1 = result.entries[0]
    assert "Celadon" in e1.security_name
    assert e1.acquisition_date == "2022-06-09"
    assert e1.acquisition_cost_usd == 618_618


# ---------------------------------------------------------------------------
# Dispatcher / classifier


def test_classify_known_ciks():
    assert classify(cik="0001905088") == "ark"
    assert classify(cik="0001843974") == "destiny"
    assert classify(cik="24238") == "fidelity"
    assert classify(cik="0001116626") == "trp"


def test_classify_falls_back_to_llm():
    assert classify(cik="0000000099") == "llm_fallback"


def test_classify_by_name():
    assert classify(cik=None, registrant_name="ARK Venture Fund") == "ark"
    assert classify(cik=None, registrant_name="Destiny Tech100 Inc") == "destiny"


# ---------------------------------------------------------------------------
# LLM fallback


def test_llm_fallback_dry_run_no_api_call():
    saved = os.environ.pop("OPENAI_API_KEY", None)
    try:
        result = llm_fallback.parse("sample text", dry_run=True)
        assert result.parser == "llm_fallback"
        assert result.notes == "dry_run"
    finally:
        if saved is not None:
            os.environ["OPENAI_API_KEY"] = saved


def test_llm_fallback_raises_without_key():
    saved = os.environ.pop("OPENAI_API_KEY", None)
    try:
        with pytest.raises(llm_fallback.MissingOpenAIKey):
            llm_fallback.parse("sample text", dry_run=False)
    finally:
        if saved is not None:
            os.environ["OPENAI_API_KEY"] = saved


def test_llm_fallback_parses_mocked_response(monkeypatch):
    fake = """{
      "entries": [
        {
          "security_name": "TinyCo, Inc.",
          "share_class": "Series A",
          "acquisition_date": "2024-05-01",
          "acquisition_date_raw": "5/1/2024",
          "acquisition_cost_usd": 100000.0,
          "fair_value_usd": 250000.0,
          "shares": 1000,
          "is_multiple_tranches": false,
          "footnotes": "a,b"
        }
      ]
    }"""
    monkeypatch.setattr(llm_fallback, "_call_openai", lambda key, model, prompt: fake)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-fake")
    result = llm_fallback.parse("sample text")
    assert result.parser == "llm_fallback"
    assert len(result.entries) == 1
    e = result.entries[0]
    assert e.security_name == "TinyCo, Inc."
    assert e.acquisition_cost_usd == 100000.0
    assert e.acquisition_date == "2024-05-01"
