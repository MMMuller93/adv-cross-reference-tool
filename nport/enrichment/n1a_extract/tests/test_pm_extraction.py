"""Per-filer tests for portfolio-manager extraction.

Fixtures (in tests/fixtures/) are real EDGAR-pulled samples:
  fidelity_contrafund_n1a.html  → Danoff + Drukker + Gupta
  trowe_global_tech_n1a.html    → Dom Rizzo
  ark_venture_n2.html           → Cathie Wood (Catherine D. Wood)
  baron_partners_n1a.html       → Ronald Baron + Michael Baron
  dxyz_n2.html                  → Sohail Prasad (LLM fallback territory)
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

HERE = Path(__file__).parent.resolve()

from nport.enrichment.n1a_extract.dispatcher import classify, dispatch
from nport.enrichment.n1a_extract.pm_parsers import ark, baron, fidelity, trp
from nport.enrichment.n1a_extract.pm_parsers import llm_fallback
from nport.enrichment.n1a_extract.section_finder import find_pm_section

FIXTURES = HERE / "fixtures"


def _load(name: str) -> str:
    p = FIXTURES / name
    if not p.exists():
        pytest.skip(f"Fixture {p} not present; copy from /tmp/nport_research/n1a_samples/")
    return p.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Fidelity Contrafund — Danoff, Drukker, Gupta


def test_fidelity_section_found():
    html = _load("fidelity_contrafund_n1a.html")
    section = find_pm_section(html)
    assert section is not None
    assert "portfolio manager" in section.text.lower()


def test_fidelity_extracts_three_pms():
    html = _load("fidelity_contrafund_n1a.html")
    section = find_pm_section(html)
    assert section is not None
    result = fidelity.parse(section.text)
    names = {pm.name for pm in result.portfolio_managers}
    assert "William Danoff" in names
    assert "Matthew Drukker" in names
    assert "Nidhi Gupta" in names
    # Years
    by_name = {pm.name: pm for pm in result.portfolio_managers}
    assert by_name["William Danoff"].managed_since == "2012"
    assert by_name["Matthew Drukker"].managed_since == "2025"
    assert by_name["Nidhi Gupta"].managed_since == "2025"


def test_fidelity_dispatcher_routing():
    html = _load("fidelity_contrafund_n1a.html")
    result = dispatch(html, cik="0000024238", registrant_name="Fidelity Contrafund")
    assert result.parser == "fidelity"
    assert len(result.portfolio_managers) >= 3


# ---------------------------------------------------------------------------
# T. Rowe Price Global Technology Fund — Dom Rizzo


def test_trp_extracts_rizzo():
    html = _load("trowe_global_tech_n1a.html")
    section = find_pm_section(html)
    assert section is not None
    result = trp.parse(section.text, full_html=section.html)
    names = {pm.name for pm in result.portfolio_managers}
    assert "Dom Rizzo" in names


def test_trp_dispatcher_routing():
    html = _load("trowe_global_tech_n1a.html")
    result = dispatch(html, cik="0001116626", registrant_name="T. Rowe Price Global Technology Fund")
    assert result.parser == "trp"
    assert any(pm.name == "Dom Rizzo" for pm in result.portfolio_managers)


# ---------------------------------------------------------------------------
# Baron Partners — Ronald + Michael Baron


def test_baron_extracts_pms():
    html = _load("baron_partners_n1a.html")
    section = find_pm_section(html)
    assert section is not None
    result = baron.parse(section.text)
    names = {pm.name for pm in result.portfolio_managers}
    # The Baron Select Funds first-occurring fund summary is Baron Partners Fund
    # which lists Ronald Baron (Lead PM) + Michael Baron (co-manager).
    assert "Ronald Baron" in names
    assert "Michael Baron" in names


# ---------------------------------------------------------------------------
# ARK Venture — Catherine D. Wood


def test_ark_extracts_wood():
    html = _load("ark_venture_n2.html")
    section = find_pm_section(html)
    assert section is not None
    result = ark.parse(section.text)
    names = {pm.name for pm in result.portfolio_managers}
    # ARK uses "Catherine D. Wood" (formal) in the prospectus, even though she's
    # publicly known as Cathie Wood. Match the prospectus form.
    matched_wood = any("Wood" in n for n in names)
    assert matched_wood, f"Expected a Wood PM, got: {names}"


def test_ark_dispatcher_routing():
    html = _load("ark_venture_n2.html")
    result = dispatch(html, cik="0001905088", registrant_name="ARK Venture Fund")
    assert result.parser == "ark"
    assert any("Wood" in pm.name for pm in result.portfolio_managers)


# ---------------------------------------------------------------------------
# DXYZ — LLM fallback (we don't actually call the API; just verify the
# dispatcher routes to llm_fallback and dry_run produces a stable result)


def test_dxyz_routes_to_llm_fallback():
    html = _load("dxyz_n2.html")
    result = dispatch(html, cik="0001843974", dry_run_llm=True)
    assert result.parser == "llm_fallback"
    # dry_run returns empty PMs with notes="dry_run"
    assert result.notes == "dry_run"


def test_llm_fallback_dry_run_no_api_call():
    """dry_run=True must NOT require OPENAI_API_KEY (no API call made)."""
    saved_key = os.environ.pop("OPENAI_API_KEY", None)
    try:
        result = llm_fallback.parse("sample PM text", dry_run=True)
        assert result.parser == "llm_fallback"
        assert result.notes == "dry_run"
    finally:
        if saved_key is not None:
            os.environ["OPENAI_API_KEY"] = saved_key


def test_llm_fallback_missing_key_raises():
    """Without dry_run and without API key, must raise a clear error."""
    saved_key = os.environ.pop("OPENAI_API_KEY", None)
    try:
        with pytest.raises(llm_fallback.MissingOpenAIKey):
            llm_fallback.parse("sample PM text", dry_run=False)
    finally:
        if saved_key is not None:
            os.environ["OPENAI_API_KEY"] = saved_key


def test_llm_fallback_parses_mocked_response(monkeypatch):
    """Patch the OpenAI call to verify our JSON-response parsing path."""
    fake_response = """{
        "portfolio_managers": [
            {
                "name": "Sohail Prasad",
                "role": "Investment Committee Member",
                "managed_since": null,
                "joined_firm": null,
                "notes": "Sole member of the Adviser's Investment Committee"
            }
        ]
    }"""
    monkeypatch.setattr(llm_fallback, "_call_openai", lambda key, model, prompt: fake_response)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-fake")
    result = llm_fallback.parse("Sohail Prasad serves on the Investment Committee", dry_run=False)
    assert result.parser == "llm_fallback"
    assert len(result.portfolio_managers) == 1
    assert result.portfolio_managers[0].name == "Sohail Prasad"


# ---------------------------------------------------------------------------
# Classifier table


def test_classify_known_ciks():
    assert classify(cik="0000024238") == "fidelity"
    assert classify(cik="1116626") == "trp"  # un-padded should still match
    assert classify(cik="0001217673") == "baron"
    assert classify(cik="0001905088") == "ark"


def test_classify_falls_back_to_llm():
    assert classify(cik="0000000999") == "llm_fallback"
    assert classify(cik=None, registrant_name="Unknown Tiny Fund LP") == "llm_fallback"


def test_classify_by_name():
    assert classify(cik=None, registrant_name="Fidelity Contrafund") == "fidelity"
    assert classify(cik=None, registrant_name="T. Rowe Price Tech Fund") == "trp"
