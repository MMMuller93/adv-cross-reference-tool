"""Form D company matcher — rule-based discovery for non-obvious filings.

Background. The alias-based matcher in materialize_holders.fetch_formd_via_cross_reference
catches Form D filings whose entityname contains a curated alias (e.g.,
'ANTHROPIC'). It does NOT catch filings that reference the company only via a
short-code abbreviation that would be unsafe to add as a normal alias — raw
'ANTH' is 4 chars and matches 363 Form D rows, ~81% of which are false
positives (Pantheon, Panthera, Anthony, etc.).

Approach. A small rule evaluator runs alongside the alias matcher. Each rule
is a structured object with:
  - entity_regex                 (required)         word-boundary pattern in entityname
  - required_series_master_regexes (optional)       AND-list against entityname/series_master_llc
  - required_related_names_regexes (optional)       AND-list against related_names
  - negative_entity_regexes        (optional)       any match disqualifies
  - decision                     ('auto_include' | 'candidate')
  - notes                        free-form documentation

Rules are evaluated per company. Rules with decision='auto_include' produce
filings that are merged into the alias-match output (same evidence channel).
Rules with decision='candidate' produce a separate audit-only list that is
NOT auto-published — surfaced for manual review in the manifest.

Reference. The Sydecar/CGF2021 detection mirrors lib/platform_detection.js
(JS pipeline). Mirrored here in Python so the materialize_holders pipeline
doesn't need to spawn a node subprocess.

Status. V1: rules hardcoded by company. V2 (future): move into a Postgres
table `private_company_formd_rules` with the same column shape.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class FormDRule:
    """A single discovery rule.

    All regexes are compiled with re.IGNORECASE. Word-boundary anchors are
    expressed with Python's \\b rather than Postgres's \\m\\M because these
    run in Python against fetched rows, not as a server-side filter.
    """
    rule_key: str
    entity_regex: re.Pattern
    decision: str  # 'auto_include' | 'candidate'
    required_series_master_regexes: list[re.Pattern] = field(default_factory=list)
    required_related_names_regexes: list[re.Pattern] = field(default_factory=list)
    negative_entity_regexes: list[re.Pattern] = field(default_factory=list)
    notes: str = ""


def _compile(pattern: str) -> re.Pattern:
    return re.compile(pattern, re.IGNORECASE)


# ---------------------------------------------------------------------------
# Rule library — V1 hardcoded by company.
# ---------------------------------------------------------------------------

ANTHROPIC_RULES: list[FormDRule] = [
    FormDRule(
        rule_key="anth_fund_phrase",
        # 'ANTH FUND I/II/III/IV' (Altra Venture Partners / HF Scale series)
        # Two-word phrase is specific enough to avoid Pantheon/Panthera noise.
        entity_regex=_compile(r"\bANTH\s+FUND\b"),
        decision="auto_include",
        notes="Catches Altra Venture / HF Scale 'ANTH FUND N' series.",
    ),
    FormDRule(
        rule_key="cc_anth_phrase",
        # 'CC ANTH I/II' — Sydecar/CGF2021 platform-hosted Anthropic SPVs.
        # 'CC ANTH' is two distinct tokens, no Pantheon/Anthony collision.
        entity_regex=_compile(r"\bCC\s+ANTH\b"),
        decision="auto_include",
        notes="Catches CGF2021-hosted 'CC ANTH N' SPVs.",
    ),
    FormDRule(
        rule_key="anth_word_with_cgf2021_or_sydecar",
        # Exact word 'ANTH' but only when the filing also carries a Sydecar
        # platform signal: CGF2021 in entityname/series_master OR Sydecar in
        # related_names. Catches 'Anth V Aug 2025 a Series of CGF2021 LLC'.
        # IMPORTANT: CGF2021 is a generic Sydecar platform shell used across
        # many companies, NOT an Anthropic-specific master. The safe rule is
        # 'exact word ANTH + Sydecar platform context = Anthropic'.
        entity_regex=_compile(r"\bANTH\b"),
        required_series_master_regexes=[],  # OR-logic below: handled in evaluate()
        required_related_names_regexes=[],
        decision="auto_include",
        negative_entity_regexes=[
            _compile(r"\bANTHROPY\b"),       # 'Anthropy Master LLC' (different company)
            _compile(r"\bANTHRACITE\b"),
            _compile(r"\bANTHEM\b"),
            _compile(r"\bANTHONY\b"),
            _compile(r"\bANTHOLOGY?\b"),
            _compile(r"\bANTHR\s+SYND\b"),   # 'ANTHR SYND' (different Synd)
        ],
        notes=(
            "Exact word ANTH, requires Sydecar/CGF2021 context. Negatives "
            "exclude Anthropy, Anthrax, Anthony, Anthem, Anthology, Anthr Synd."
        ),
    ),
]


# Sydecar/CGF2021 platform context regexes — used as OR-of-ORs for the
# 'anth_word_with_cgf2021_or_sydecar' rule. Filing must match ONE of these
# in addition to passing the entity_regex.
SYDECAR_CONTEXT_ENTITY_REGEXES = [
    _compile(r"\bCGF2021\b"),
    _compile(r"\ba\s+series\s+of\s+CGF2021\b"),
    _compile(r"\bSYDECAR\b"),
]

SYDECAR_CONTEXT_RELATED_REGEXES = [
    _compile(r"\bSYDECAR\b"),
    _compile(r"\bBRETT\s+SAGAN\b"),
    _compile(r"\bTAYLOR\s+HUGHES\b"),
    _compile(r"\bNIK\s+TALREJA\b"),
]


OPENAI_RULES: list[FormDRule] = [
    FormDRule(
        rule_key="oai_fund_phrase",
        # 'OAI FUND I/II' (Altra Venture / HF Scale) — exact mirror of the
        # ANTH FUND pattern: same Altra/HF Scale series operators use both
        # 'ANTH FUND N' and 'OAI FUND N' naming.
        entity_regex=_compile(r"\bOAI\s+FUND\b"),
        decision="auto_include",
        notes="Catches Altra Venture / HF Scale 'OAI FUND N' series.",
    ),
    FormDRule(
        rule_key="oai_word",
        # 'OAI' at a word boundary OR followed immediately by digits (e.g.,
        # 'OAI1025'). Universe survey (2026-05-19, n=22 after digit relax)
        # showed 100% precision: every hit was a real OpenAI SPV (Khosla,
        # Type One, ATHOS, OPEN OAI, Sydecar/CGF2021, DataPower, Altra,
        # AVKV, Cloverfield, OV, T1V, West Star, SLRTE, etc.).
        # MORE permissive than the ANTH analog because OAI universe is
        # small and clean. Negatives are pre-emptive.
        entity_regex=_compile(r"\bOAI(?=\d|\b)"),
        decision="auto_include",
        negative_entity_regexes=[
            # Pre-emptive: known unrelated entities that COULD match OAI in
            # the future. Empty today; populate as false positives appear.
        ],
        notes=(
            "OAI at word boundary or followed by digits. 100% precision on "
            "22-row universe (2026-05-19). Negatives are pre-emptive."
        ),
    ),
]


# Map slug -> rules. Add new companies here.
RULES_BY_COMPANY: dict[str, list[FormDRule]] = {
    "anthropic": ANTHROPIC_RULES,
    "openai": OPENAI_RULES,
}


def get_rules(company_slug: str) -> list[FormDRule]:
    return RULES_BY_COMPANY.get(company_slug.lower(), [])


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def _has_sydecar_context(filing: dict[str, Any]) -> bool:
    """True if the filing carries any Sydecar/CGF2021 platform signal."""
    entityname = filing.get("entityname") or ""
    series_master = filing.get("series_master_llc") or ""
    related_names = filing.get("related_names") or ""
    combined_entity_text = f"{entityname} {series_master}"
    for pat in SYDECAR_CONTEXT_ENTITY_REGEXES:
        if pat.search(combined_entity_text):
            return True
    for pat in SYDECAR_CONTEXT_RELATED_REGEXES:
        if pat.search(related_names):
            return True
    return False


def _matches_negatives(filing: dict[str, Any], rule: FormDRule) -> bool:
    entityname = filing.get("entityname") or ""
    for pat in rule.negative_entity_regexes:
        if pat.search(entityname):
            return True
    return False


def evaluate_rule(rule: FormDRule, filing: dict[str, Any]) -> Optional[str]:
    """Return rule.decision ('auto_include'/'candidate') if the filing passes,
    else None.

    Special case: the 'anth_word_with_cgf2021_or_sydecar' rule requires
    Sydecar/CGF2021 context as documented in its rule_key. We encode that
    here rather than expanding the data model further for V1.
    """
    entityname = filing.get("entityname") or ""
    if not rule.entity_regex.search(entityname):
        return None
    if _matches_negatives(filing, rule):
        return None
    # AND-logic for required_series_master_regexes (against entityname OR
    # series_master_llc — Form D parsers vary on where the master shows up).
    if rule.required_series_master_regexes:
        haystack = f"{entityname} {filing.get('series_master_llc') or ''}"
        for pat in rule.required_series_master_regexes:
            if not pat.search(haystack):
                return None
    # AND-logic for related_names.
    if rule.required_related_names_regexes:
        related = filing.get("related_names") or ""
        for pat in rule.required_related_names_regexes:
            if not pat.search(related):
                return None
    # Special-case Sydecar guard for the short-code rule.
    if rule.rule_key == "anth_word_with_cgf2021_or_sydecar":
        if not _has_sydecar_context(filing):
            return None
    return rule.decision


def evaluate_filing(
    company_slug: str, filing: dict[str, Any]
) -> Optional[dict[str, str]]:
    """Run all rules for a company against a filing. Return the first match.

    Returns: {'rule_key', 'decision'} or None.

    Rules are evaluated in declared order; auto_include rules fire before
    candidate rules in the same list, so callers don't need to sort.
    """
    for rule in get_rules(company_slug):
        decision = evaluate_rule(rule, filing)
        if decision:
            return {"rule_key": rule.rule_key, "decision": decision}
    return None


# ---------------------------------------------------------------------------
# Fetch helpers — used by materialize_holders to pull candidate rows.
# ---------------------------------------------------------------------------

def fetch_candidate_filings(formd, company_slug: str) -> list[dict[str, Any]]:
    """Pull the universe of Form D rows that *could* match any rule for this
    company, using a permissive server-side regex. Final filtering happens
    in Python via evaluate_filing().

    For Anthropic: any entityname containing the 4-char token 'ANTH' (with
    word boundaries) — 363 rows as of 2026-05-19. Cheap to fetch and filter.
    """
    rules = get_rules(company_slug)
    if not rules:
        return []

    # Build a single OR'd Postgres regex from all entity_regex patterns.
    # We extract the Python regex source and convert \b to \m/\M (Postgres
    # word-boundary anchors). Same conversion the alias matcher does.
    py_to_pg = lambda src: src.replace(r"\b", r"\m")  # \m as both-side anchor approx
    # Simpler: just OR the raw alternatives without anchors; Python will
    # re-test with proper \b semantics.
    or_pattern = "|".join(rule.entity_regex.pattern for rule in rules)
    # Strip \b for the server query so we get a superset, then filter in py.
    server_pattern = or_pattern.replace(r"\b", "")

    matched: list[dict[str, Any]] = []
    seen: set[str] = set()
    last_id = 0
    SELECT = (
        "id,accessionnumber,entityname,cik,series_master_llc,"
        "filing_date,totalofferingamount,related_names,isamendment"
    )
    while True:
        response = (
            formd.table("form_d_filings")
            .select(SELECT)
            .filter("entityname", "imatch", server_pattern)
            .neq("isamendment", "true")
            .gt("id", last_id)
            .order("id")
            .limit(1000)
            .execute()
        )
        batch = response.data or []
        if not batch:
            break
        for row in batch:
            acc = row.get("accessionnumber")
            if acc and acc not in seen:
                seen.add(acc)
                matched.append(row)
        if len(batch) < 1000:
            break
        last_id = int(batch[-1]["id"])
    return matched


def discover_via_rules(formd, company_slug: str) -> dict[str, Any]:
    """End-to-end: fetch candidates, evaluate rules, partition into
    auto_include vs candidate buckets.

    Returns:
      {
        'auto_include': [filings...],     # ready to merge into alias output
        'candidate':    [filings...],     # audit-only; not auto-published
        'rule_hits':    {rule_key: hit_count},
      }
    """
    if not get_rules(company_slug):
        return {"auto_include": [], "candidate": [], "rule_hits": {}}

    candidates = fetch_candidate_filings(formd, company_slug)
    auto_include: list[dict[str, Any]] = []
    candidate_bucket: list[dict[str, Any]] = []
    rule_hits: dict[str, int] = {}

    for filing in candidates:
        result = evaluate_filing(company_slug, filing)
        if not result:
            continue
        rule_key = result["rule_key"]
        rule_hits[rule_key] = rule_hits.get(rule_key, 0) + 1
        annotated = dict(filing)
        annotated["_rule_key"] = rule_key
        annotated["_resolution_method"] = "formd_rule_match"
        annotated["_resolved_crd"] = None  # downstream propagation may fill
        # parse_series_master is materialize_holders responsibility.
        if result["decision"] == "auto_include":
            auto_include.append(annotated)
        else:
            candidate_bucket.append(annotated)

    return {
        "auto_include": auto_include,
        "candidate": candidate_bucket,
        "rule_hits": rule_hits,
    }
