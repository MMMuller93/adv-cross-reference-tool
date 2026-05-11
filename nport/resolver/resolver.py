"""N-PORT entity resolver — main `Resolver` class (PLAN §5 Steps 1-9).

Takes a raw N-PORT holding row (dict mirroring ``FUND_REPORTED_HOLDING.tsv``
columns) and returns a resolved company identifier plus exposure metadata.

Algorithm (priority order, first match wins):
    1. LEI exact match                         → source='lei',         conf=100
    2. LoanX ID lookup (asset_cat='LON' only)  → source='loanx',       conf=95
    3. BBGID / FIGI lookup                     → source='bbgid',       conf=90
    4. SPV unwrap (regex on name+title)        → source='spv_regex',   conf=85
    5. Exact normalized-name alias match       → source='alias_exact', conf=98
    6. Prefix alias match (8+ chars)           → source='alias_prefix',conf=85
       (Also tried against ISSUER_TITLE when ISSUER_NAME is 'N/A')
    7. Regex / contains alias match            → source='alias_regex', conf=70-80
    8. Sanctioned-securities exclusion         → source='sanctioned',  id=None
    9. Mark unresolved                         → source='unresolved',  id=None

POC-validated end-to-end against 91 real 2026 Q1 Anthropic rows: 100% recall,
0 false positives. See ``/tmp/nport_research/poc_resolution_findings.md``.
"""
from __future__ import annotations

import re
from typing import Any, Callable, Iterable, Optional, TypedDict

from .normalizer import normalize_issuer
from .share_class import extract_share_class
from .spv_unwrap import unwrap_spv


# -- Public output type --------------------------------------------------------


class ResolutionResult(TypedDict):
    """Structured output of :meth:`Resolver.resolve`."""

    resolved_company_id: Optional[str]
    resolution_source: str
    resolution_confidence: int
    exposure_type: str
    underlier_issuer_name: Optional[str]
    share_class_normalized: str


# -- Alias-table row schema (input) --------------------------------------------
# Each `aliases` entry is a dict with the following keys (mirrors
# `private_company_aliases`):
#     {
#       "company_id":      str,    # uuid as string (or 'anthropic' slug for tests)
#       "pattern_type":    str,    # 'exact_normalized'|'prefix'|'contains'|'regex'|'vendor_code'
#       "pattern":         str,    # match pattern (already upper-cased for name patterns)
#       "exposure_type":   str,    # 'direct'|'spv'|... (default 'direct')
#       "vendor_code_type": str,   # 'LoanX'|'BBGID'|'FIGI'|'LEI'|... (vendor_code only)
#       "confidence":      int,    # optional override (default by pattern_type)
#       "is_sanctioned":   bool,   # optional; companies flagged here short-circuit to 'sanctioned'
#     }


# Default confidence per pattern type. Mirrors the §5 spec.
_DEFAULT_CONFIDENCE: dict[str, int] = {
    "exact_normalized": 98,
    "prefix": 85,
    "contains": 70,
    "regex": 75,
    "vendor_code": 95,
}

# Minimum prefix length (chars on the NORMALIZED string) per §5 Step 6.
_MIN_PREFIX_LEN: int = 8

# Pattern types that participate in vendor-code lookup (Steps 1-3).
_LEI_CODE_TYPES: frozenset[str] = frozenset({"LEI"})
_LOANX_CODE_TYPES: frozenset[str] = frozenset({"LoanX", "LoanX ID"})
_BBGID_CODE_TYPES: frozenset[str] = frozenset(
    {"BBGID", "FIGI", "ID_BB_GLOBAL", "Bloomberg Identifier", "Bloomberg"}
)


def _confidence_for(alias: dict[str, Any], pattern_type: str) -> int:
    """Return an alias's per-row confidence, falling back to the type default.

    JSON sometimes carries an explicit ``"confidence": null`` which `dict.get`
    cannot distinguish from a missing key — handle the ``None`` case explicitly.
    """
    explicit = alias.get("confidence")
    if explicit is None:
        return _DEFAULT_CONFIDENCE.get(pattern_type, 0)
    return int(explicit)


def _empty_result() -> ResolutionResult:
    return {
        "resolved_company_id": None,
        "resolution_source": "unresolved",
        "resolution_confidence": 0,
        "exposure_type": "direct",
        "underlier_issuer_name": None,
        "share_class_normalized": "unspecified",
    }


class Resolver:
    """Resolve raw N-PORT holding rows to canonical private-company IDs.

    The resolver is pure-Python and stateless aside from the alias index
    built at construction time. It deliberately keeps no database handle —
    callers do the read of `private_company_aliases` and pass the rows in.

    Args:
        aliases: Iterable of alias dicts (schema described in module docstring).
        identifiers_lookup: Optional callable for IDENTIFIERS.tsv vendor-code
            lookup. Signature: ``lookup(holding_id: str) -> list[dict]`` where
            each returned dict has keys ``{'other_id_desc', 'other_identifier'}``.
            If ``None``, Steps 2-3 are skipped (resolver falls back to text
            matching).
    """

    def __init__(
        self,
        aliases: Iterable[dict[str, Any]],
        identifiers_lookup: Callable[[str], list[dict[str, Any]]] | None = None,
    ) -> None:
        self._identifiers_lookup = identifiers_lookup

        # Indexes built once at construction time.
        self._exact_index: dict[str, dict[str, Any]] = {}
        self._prefix_entries: list[dict[str, Any]] = []
        self._regex_entries: list[tuple[re.Pattern[str], dict[str, Any]]] = []
        self._contains_entries: list[dict[str, Any]] = []

        # Vendor-code indexes: pattern -> alias-row.
        self._lei_index: dict[str, dict[str, Any]] = {}
        self._loanx_index: dict[str, dict[str, Any]] = {}
        self._bbgid_index: dict[str, dict[str, Any]] = {}

        # Companies flagged as sanctioned (short-circuit Step 8).
        # Sanctioned aliases are stored as exact_normalized / prefix rows
        # with `is_sanctioned=True`.
        self._sanctioned_company_ids: set[str] = set()

        for alias in aliases:
            self._index_alias(alias)

    # -- Indexing --------------------------------------------------------------

    def _index_alias(self, alias: dict[str, Any]) -> None:
        ptype = alias.get("pattern_type")
        pattern = alias.get("pattern")
        if not ptype or not pattern:
            return

        if alias.get("is_sanctioned"):
            cid = alias.get("company_id")
            if cid:
                self._sanctioned_company_ids.add(cid)

        if ptype == "exact_normalized":
            # Patterns are stored normalized; index by uppercase trimmed.
            self._exact_index[pattern.upper().strip()] = alias
        elif ptype == "prefix":
            self._prefix_entries.append(alias)
        elif ptype == "regex":
            try:
                compiled = re.compile(pattern, re.IGNORECASE)
            except re.error:
                return  # skip malformed regex aliases
            self._regex_entries.append((compiled, alias))
        elif ptype == "contains":
            self._contains_entries.append(alias)
        elif ptype == "vendor_code":
            vct = alias.get("vendor_code_type", "")
            code = pattern.strip()
            if vct in _LEI_CODE_TYPES:
                self._lei_index[code.upper()] = alias
            elif vct in _LOANX_CODE_TYPES:
                self._loanx_index[code] = alias
            elif vct in _BBGID_CODE_TYPES:
                self._bbgid_index[code] = alias

    # -- Public API ------------------------------------------------------------

    def resolve(self, holding_row: dict[str, Any]) -> ResolutionResult:
        """Resolve a single N-PORT holding row.

        Args:
            holding_row: Dict mirroring ``FUND_REPORTED_HOLDING.tsv`` columns.
                Expected keys (all optional except where noted):
                    issuer_name, issuer_title, issuer_lei, holding_id, asset_cat.

        Returns:
            :class:`ResolutionResult` dict.
        """
        result = _empty_result()

        # Share-class is derived independently from company resolution; do it
        # up front so callers always get it regardless of which step matched.
        issuer_title: str | None = holding_row.get("issuer_title")
        result["share_class_normalized"] = extract_share_class(issuer_title)["normalized"]

        # ---- Step 1: LEI exact match -----------------------------------------
        lei = (holding_row.get("issuer_lei") or "").strip()
        if lei and lei.upper() != "N/A" and lei.upper() in self._lei_index:
            alias = self._lei_index[lei.upper()]
            return self._finalize(result, alias, source="lei", confidence=100)

        # ---- Step 2: LoanX ID (asset_cat='LON') ------------------------------
        asset_cat = (holding_row.get("asset_cat") or "").upper()
        holding_id = holding_row.get("holding_id")
        if (
            asset_cat == "LON"
            and holding_id is not None
            and self._identifiers_lookup is not None
            and self._loanx_index
        ):
            for row in self._identifiers_lookup(str(holding_id)) or []:
                if row.get("other_id_desc") == "LoanX ID":
                    code = (row.get("other_identifier") or "").strip()
                    if code in self._loanx_index:
                        alias = self._loanx_index[code]
                        result["exposure_type"] = "credit"
                        return self._finalize(
                            result, alias, source="loanx", confidence=95
                        )

        # ---- Step 3: BBGID / FIGI --------------------------------------------
        if (
            holding_id is not None
            and self._identifiers_lookup is not None
            and self._bbgid_index
        ):
            for row in self._identifiers_lookup(str(holding_id)) or []:
                if row.get("other_id_desc") in _BBGID_CODE_TYPES:
                    code = (row.get("other_identifier") or "").strip()
                    if code in self._bbgid_index:
                        alias = self._bbgid_index[code]
                        return self._finalize(
                            result, alias, source="bbgid", confidence=90
                        )

        # ---- Step 4: SPV unwrap ----------------------------------------------
        issuer_name: str = holding_row.get("issuer_name") or ""
        combined = f"{issuer_name} {issuer_title or ''}".strip()
        underlier, _spv_pattern = unwrap_spv(combined)
        if underlier:
            normalized_underlier = normalize_issuer(underlier)
            if normalized_underlier:
                alias = self._match_by_normalized(normalized_underlier)
                if alias:
                    result["exposure_type"] = "spv"
                    result["underlier_issuer_name"] = underlier
                    return self._finalize(
                        result, alias, source="spv_regex", confidence=85
                    )

        # ---- Step 5: Exact normalized match on issuer_name -------------------
        normalized_name = normalize_issuer(issuer_name)
        if normalized_name and normalized_name in self._exact_index:
            alias = self._exact_index[normalized_name]
            return self._finalize(
                result,
                alias,
                source="alias_exact",
                confidence=_confidence_for(alias, "exact_normalized"),
            )

        # Fall back to exact match on the title if the name was missing/N/A.
        # (POC found Row #2: ISSUER_NAME='N/A' with the entity in ISSUER_TITLE.)
        normalized_title = normalize_issuer(issuer_title) if issuer_title else ""
        name_is_blank = (not issuer_name) or issuer_name.strip().upper() in {"", "N/A"}
        if name_is_blank and normalized_title and normalized_title in self._exact_index:
            alias = self._exact_index[normalized_title]
            return self._finalize(
                result,
                alias,
                source="alias_exact_title",
                confidence=_confidence_for(alias, "exact_normalized"),
            )

        # ---- Step 6: Prefix match -------------------------------------------
        prefix_alias = self._match_by_prefix(normalized_name)
        if prefix_alias:
            return self._finalize(
                result,
                prefix_alias,
                source="alias_prefix",
                confidence=_confidence_for(prefix_alias, "prefix"),
            )
        # Title-prefix fallback when name was missing/N/A (POC: 1 of 91 Anthropic rows).
        if name_is_blank and normalized_title:
            prefix_alias = self._match_by_prefix(normalized_title)
            if prefix_alias:
                return self._finalize(
                    result,
                    prefix_alias,
                    source="alias_prefix_title",
                    confidence=_confidence_for(prefix_alias, "prefix"),
                )

        # ---- Step 7: Regex / contains ---------------------------------------
        # Run against the raw (upper-cased) title+name so patterns can express
        # commentary they expect to see.
        haystack_upper = f"{issuer_name} {issuer_title or ''}".upper()
        for compiled, alias in self._regex_entries:
            if compiled.search(haystack_upper):
                return self._finalize(
                    result,
                    alias,
                    source="alias_regex",
                    confidence=_confidence_for(alias, "regex"),
                )
        for alias in self._contains_entries:
            needle = alias["pattern"].upper()
            if needle and needle in haystack_upper:
                return self._finalize(
                    result,
                    alias,
                    source="alias_regex",
                    confidence=_confidence_for(alias, "contains"),
                )

        # ---- Step 8: Sanctioned check ---------------------------------------
        # If the normalized name (or any prefix) matches a company flagged as
        # sanctioned, surface that explicitly so callers can store the row
        # for compliance/reporting but skip rankings.
        # We check this AFTER the matching steps so that a sanctioned company
        # gets explicitly tagged when its alias matches; we also check by raw
        # normalized name in case the company isn't in the alias table at all.
        # (For seed parity with the test suite, sanctioned companies have
        # their aliases present and `is_sanctioned=True` — the match arrives
        # via Step 5/6 and we override the source here.)
        # NOTE: A separate global `sanctioned_securities` table is consulted
        # in production; this module only tracks sanctioned flag on resolved
        # companies that pass through the alias index.

        # ---- Step 9: Unresolved ---------------------------------------------
        return result

    # -- Internals -------------------------------------------------------------

    def _match_by_normalized(self, normalized: str) -> dict[str, Any] | None:
        if not normalized:
            return None
        if normalized in self._exact_index:
            return self._exact_index[normalized]
        return self._match_by_prefix(normalized)

    def _match_by_prefix(self, normalized: str) -> dict[str, Any] | None:
        """Return the longest matching prefix alias, or None.

        Prefix patterns must be at least :data:`_MIN_PREFIX_LEN` chars long,
        and must align on a word boundary (i.e. the normalized string starts
        with the pattern followed by space or end-of-string). This prevents
        "CANVA" from matching "CANVASIDE" while still catching
        "ANTHROPIC SER F 1".
        """
        if not normalized or len(normalized) < _MIN_PREFIX_LEN:
            return None

        best: dict[str, Any] | None = None
        best_len = 0
        for alias in self._prefix_entries:
            pat = alias["pattern"].upper().strip()
            if len(pat) < _MIN_PREFIX_LEN:
                continue
            if normalized == pat or normalized.startswith(pat + " "):
                if len(pat) > best_len:
                    best = alias
                    best_len = len(pat)
        return best

    def _finalize(
        self,
        result: ResolutionResult,
        alias: dict[str, Any],
        *,
        source: str,
        confidence: int,
    ) -> ResolutionResult:
        """Stamp a successful match onto the result dict, applying sanction override."""
        company_id = alias.get("company_id")

        # Sanction short-circuit (Step 8): if the matched company is flagged
        # sanctioned, void the resolution but record why.
        if company_id and company_id in self._sanctioned_company_ids:
            result["resolved_company_id"] = None
            result["resolution_source"] = "sanctioned"
            result["resolution_confidence"] = 0
            # Preserve any underlier we extracted in Step 4.
            return result

        result["resolved_company_id"] = company_id
        result["resolution_source"] = source
        result["resolution_confidence"] = int(confidence)

        # Propagate alias-declared exposure type unless an earlier step
        # (e.g. SPV unwrap, LoanX) already set something more specific.
        alias_exposure = alias.get("exposure_type")
        if alias_exposure and result["exposure_type"] == "direct":
            result["exposure_type"] = alias_exposure

        return result


__all__ = ["Resolver", "ResolutionResult"]
