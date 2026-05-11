"""Form N-CEN XML parser.

Per the SEC N-CEN XSD (2.2 technical spec), the `<investmentAdvisers>` block
has `minOccurs="0"` — some self-managed funds (a small number of closed-end /
internal-management trusts) omit it entirely. Always null-guard.

CRD numbers in the XML follow the pattern `[0-9]{9}|N/A`. Already zero-padded
to 9 digits. Treat `N/A` as None.
LEIs follow `[0-9A-Za-z]{20}|[0-9]{10}|N/A`. Treat `N/A` as None.

A single N-CEN filing can contain multiple `<investmentAdvisers>` blocks (one
per series/class). Fidelity's Contrafund N-CEN had 4 adviser blocks and 12
sub-adviser blocks. We collect ALL of them and dedupe at the caller.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Optional

from lxml import etree

# N-CEN XML default namespace
NCEN_NS = "http://www.sec.gov/edgar/ncen"
NS = {"n": NCEN_NS}


# ---------------------------------------------------------------------------


@dataclass
class Adviser:
    """An <investmentAdviser> or <subAdviser> entry."""

    name: Optional[str] = None
    crd: Optional[str] = None  # 9-digit zero-padded, or None
    lei: Optional[str] = None
    file_no: Optional[str] = None  # SEC file number, e.g. "801-7884"
    rssd_id: Optional[str] = None
    country: Optional[str] = None
    state: Optional[str] = None
    is_subadviser: bool = False
    is_affiliated: Optional[bool] = None  # only meaningful for sub-advisers

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class NCenFiling:
    """Parsed N-CEN filing summary."""

    schema_version: Optional[str] = None
    submission_type: Optional[str] = None
    registrant_cik: Optional[str] = None  # zero-padded 10-digit as stored in XML
    registrant_name: Optional[str] = None
    registrant_lei: Optional[str] = None
    investment_company_type: Optional[str] = None
    report_period_end: Optional[str] = None  # "YYYY-MM-DD"
    file_number: Optional[str] = None
    investment_advisers: list[Adviser] = field(default_factory=list)
    sub_advisers: list[Adviser] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["investment_advisers"] = [a for a in d["investment_advisers"]]
        d["sub_advisers"] = [a for a in d["sub_advisers"]]
        return d


# ---------------------------------------------------------------------------


def _text(node, xpath: str) -> Optional[str]:
    """Safe namespaced findtext that returns None for missing or 'N/A' values."""
    if node is None:
        return None
    val = node.findtext(xpath, namespaces=NS)
    if val is None:
        return None
    val = val.strip()
    if not val or val == "N/A":
        return None
    return val


def _yn(node, xpath: str) -> Optional[bool]:
    val = _text(node, xpath)
    if val is None:
        return None
    return val.upper() == "Y"


def _parse_state_country(node, attr_state: str, attr_country: str) -> tuple[Optional[str], Optional[str]]:
    """Some N-CEN blocks store state/country as XML attributes on a child node
    (e.g., investmentAdviserStateCountry investmentAdviserState='US-MA'
    investmentAdviserCountry='US')."""
    if node is None:
        return None, None
    state = node.get(attr_state)
    country = node.get(attr_country)
    if state == "N/A":
        state = None
    if country == "N/A":
        country = None
    return state, country


def _parse_adviser(node, *, is_sub: bool) -> Adviser:
    """Parse a single <investmentAdviser> or <subAdviser> element."""
    if is_sub:
        prefix = "subAdviser"
    else:
        prefix = "investmentAdviser"

    name = _text(node, f"n:{prefix}Name")
    crd = _text(node, f"n:{prefix}CrdNo")
    lei = _text(node, f"n:{prefix}Lei")
    file_no = _text(node, f"n:{prefix}FileNo")
    rssd_id = _text(node, f"n:{prefix}RssdId")

    # State/country: investmentAdviser uses StateCountry sub-element with attrs;
    # subAdviser typically just has subAdviserCountry as a child text element.
    state, country = None, None
    if is_sub:
        country = _text(node, "n:subAdviserCountry")
    else:
        sc_node = node.find("n:investmentAdviserStateCountry", namespaces=NS)
        state, country = _parse_state_country(
            sc_node, "investmentAdviserState", "investmentAdviserCountry"
        )

    is_affiliated = None
    if is_sub:
        is_affiliated = _yn(node, "n:isSubAdviserAffiliated")

    return Adviser(
        name=name,
        crd=crd,
        lei=lei,
        file_no=file_no,
        rssd_id=rssd_id,
        country=country,
        state=state,
        is_subadviser=is_sub,
        is_affiliated=is_affiliated,
    )


# ---------------------------------------------------------------------------


def parse_ncen_xml(xml_bytes: bytes | str) -> NCenFiling:
    """Parse a Form N-CEN primary_doc.xml.

    Accepts either bytes or a string. Returns NCenFiling with deduplicated
    adviser and sub-adviser lists.
    """
    if isinstance(xml_bytes, str):
        xml_bytes = xml_bytes.encode("utf-8")

    # Strip BOM if present
    if xml_bytes.startswith(b"\xef\xbb\xbf"):
        xml_bytes = xml_bytes[3:]

    tree = etree.fromstring(xml_bytes)

    filing = NCenFiling()

    # Header / registrant
    filing.schema_version = _text(tree, "n:schemaVersion")
    filing.submission_type = _text(tree, "n:headerData/n:submissionType")
    filing.investment_company_type = _text(
        tree, "n:headerData/n:filerInfo/n:investmentCompanyType"
    )

    # registrantCik may live inside headerData filer/issuerCredentials/cik OR
    # under formData/registrantInfo/registrantCik (the latter is the canonical
    # value per Fidelity sample). Prefer the formData one.
    filing.registrant_cik = _text(
        tree, "n:formData/n:registrantInfo/n:registrantCik"
    ) or _text(
        tree,
        "n:headerData/n:filerInfo/n:filer/n:issuerCredentials/n:cik",
    )
    filing.registrant_name = _text(
        tree, "n:formData/n:registrantInfo/n:registrantFullName"
    )
    filing.registrant_lei = _text(
        tree, "n:formData/n:registrantInfo/n:registrantLei"
    )
    filing.file_number = _text(
        tree, "n:formData/n:registrantInfo/n:investmentCompFileNo"
    )

    general_info = tree.find(".//n:formData/n:generalInfo", namespaces=NS)
    if general_info is not None:
        filing.report_period_end = general_info.get("reportEndingPeriod")

    # Investment advisers: <investmentAdvisers> wraps one-or-more <investmentAdviser>.
    # CRITICAL: <investmentAdvisers> has minOccurs="0" — null-guard.
    # Multiple <investmentAdvisers> blocks can appear (one per series); collect all.
    for adv_node in tree.findall(".//n:investmentAdvisers/n:investmentAdviser", namespaces=NS):
        filing.investment_advisers.append(_parse_adviser(adv_node, is_sub=False))

    # Sub-advisers — same wrapping pattern, multiple sub-advisers per fund possible
    for sub_node in tree.findall(".//n:subAdvisers/n:subAdviser", namespaces=NS):
        filing.sub_advisers.append(_parse_adviser(sub_node, is_sub=True))

    # Dedup by (crd, name, lei) tuple — Fidelity repeats the same adviser block
    # across multiple series within the same filing.
    filing.investment_advisers = _dedupe(filing.investment_advisers)
    filing.sub_advisers = _dedupe(filing.sub_advisers)

    return filing


def _dedupe(advisers: list[Adviser]) -> list[Adviser]:
    seen: set[tuple] = set()
    out: list[Adviser] = []
    for a in advisers:
        key = (a.crd, a.name, a.lei)
        if key in seen:
            continue
        seen.add(key)
        out.append(a)
    return out
