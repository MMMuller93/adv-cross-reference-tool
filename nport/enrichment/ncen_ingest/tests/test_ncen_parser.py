"""Tests for the Form N-CEN parser.

Sample XMLs are saved in this directory:
- ncen_fidelity_raw.xml (Fidelity Contrafund — CRD 000108281 + 3 sub-advisers)
- ncen_vanguard_raw.xml (Vanguard Index Funds — CRD 000105958)
- ncen_blackrock_raw.xml (BlackRock Tech & PE Term Trust — CRD 000106614)
- ncen_ark_raw.xml (ARK — CRD 000169525, no sub-advisers)

Use these as ground-truth. The CRD values are from the public XML; mirrored in
PLAN_NPORT_HOLDINGS.md and /tmp/nport_research/n1a_findings.md.
"""
from __future__ import annotations

from pathlib import Path

import pytest

HERE = Path(__file__).parent.resolve()

from nport.enrichment.ncen_ingest.parser import Adviser, NCenFiling, parse_ncen_xml

FIXTURES = HERE  # XML samples live alongside this test file


def _load(name: str) -> bytes:
    p = FIXTURES / name
    if not p.exists():
        pytest.skip(f"Sample XML not present at {p}; copy from /tmp/nport_research/")
    return p.read_bytes()


# ---------------------------------------------------------------------------
# Fidelity Contrafund


def test_fidelity_basic():
    xml = _load("ncen_fidelity_raw.xml")
    f = parse_ncen_xml(xml)
    assert f.submission_type == "N-CEN"
    assert f.registrant_name == "Fidelity Contrafund"
    assert f.registrant_cik == "0000024238"
    assert f.investment_company_type == "N-1A"


def test_fidelity_adviser_crd():
    """Confirm the CRD for FMR is 000108281 (per PLAN_NPORT_HOLDINGS §1.5)."""
    f = parse_ncen_xml(_load("ncen_fidelity_raw.xml"))
    assert len(f.investment_advisers) == 1, "FMR appears once after dedup"
    adv = f.investment_advisers[0]
    assert adv.name == "Fidelity Management & Research Company LLC"
    assert adv.crd == "000108281"
    assert adv.file_no == "801-7884"
    assert adv.lei == "5493001Z012YSB2A0K51"
    assert adv.is_subadviser is False


def test_fidelity_subadvisers():
    """Confirm sub-advisers (FMR UK, HK, Japan)."""
    f = parse_ncen_xml(_load("ncen_fidelity_raw.xml"))
    assert len(f.sub_advisers) >= 3
    names = {s.name for s in f.sub_advisers}
    assert "FMR Investment Management (UK) Limited" in names
    assert "Fidelity Management & Research (Hong Kong) Limited" in names
    assert "Fidelity Management & Research (Japan) Limited" in names

    uk = next(s for s in f.sub_advisers if "UK" in (s.name or ""))
    assert uk.crd == "000108273"
    assert uk.file_no == "801-28773"
    assert uk.country == "GB"
    assert uk.is_subadviser is True


# ---------------------------------------------------------------------------
# Vanguard


def test_vanguard_basic():
    f = parse_ncen_xml(_load("ncen_vanguard_raw.xml"))
    assert f.registrant_name == "VANGUARD INDEX FUNDS"
    assert f.registrant_cik == "0000036405"
    assert len(f.investment_advisers) == 1
    adv = f.investment_advisers[0]
    assert adv.name == "The Vanguard Group, Inc."
    assert adv.crd == "000105958"
    assert adv.file_no == "801-11953"


# ---------------------------------------------------------------------------
# BlackRock


def test_blackrock_basic():
    f = parse_ncen_xml(_load("ncen_blackrock_raw.xml"))
    assert f.registrant_name == "BlackRock Technology & Private Equity Term Trust"
    assert f.registrant_cik == "0001836057"
    advs = f.investment_advisers
    assert len(advs) == 1
    assert advs[0].name == "BlackRock Advisors, LLC"
    assert advs[0].crd == "000106614"


# ---------------------------------------------------------------------------
# ARK


def test_ark_no_subadvisers():
    f = parse_ncen_xml(_load("ncen_ark_raw.xml"))
    assert len(f.investment_advisers) == 1
    adv = f.investment_advisers[0]
    assert adv.name == "ARK Investment Management LLC"
    assert adv.crd == "000169525"
    # ARK is internally managed — no sub-advisers
    assert f.sub_advisers == []


# ---------------------------------------------------------------------------
# Null-guards and edge cases


def test_na_treated_as_null():
    """'N/A' values should be parsed as None for both CRD and LEI."""
    # Craft a minimal XML inline to assert N/A handling
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/ncen">
  <schemaVersion>X0505</schemaVersion>
  <headerData><submissionType>N-CEN</submissionType></headerData>
  <formData>
    <registrantInfo>
      <registrantFullName>Test Fund</registrantFullName>
      <registrantCik>0000000001</registrantCik>
      <investmentAdvisers>
        <investmentAdviser>
          <investmentAdviserName>SelfManaged Adv</investmentAdviserName>
          <investmentAdviserFileNo>801-99999</investmentAdviserFileNo>
          <investmentAdviserCrdNo>N/A</investmentAdviserCrdNo>
          <investmentAdviserLei>N/A</investmentAdviserLei>
          <investmentAdviserRssdId>N/A</investmentAdviserRssdId>
        </investmentAdviser>
      </investmentAdvisers>
    </registrantInfo>
  </formData>
</edgarSubmission>
"""
    f = parse_ncen_xml(xml)
    assert len(f.investment_advisers) == 1
    adv = f.investment_advisers[0]
    assert adv.name == "SelfManaged Adv"
    assert adv.crd is None
    assert adv.lei is None
    assert adv.rssd_id is None


def test_no_investment_advisers_block():
    """If <investmentAdvisers> is omitted (minOccurs=0 per XSD), parse must not crash."""
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/ncen">
  <schemaVersion>X0505</schemaVersion>
  <headerData><submissionType>N-CEN</submissionType></headerData>
  <formData>
    <registrantInfo>
      <registrantFullName>Lone Fund</registrantFullName>
      <registrantCik>0000000002</registrantCik>
    </registrantInfo>
  </formData>
</edgarSubmission>
"""
    f = parse_ncen_xml(xml)
    assert f.investment_advisers == []
    assert f.sub_advisers == []
    assert f.registrant_name == "Lone Fund"
