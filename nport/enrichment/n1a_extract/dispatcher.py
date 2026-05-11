"""Dispatch a 485BPOS / N-1A / N-2 HTML to the right per-filer parser.

Given a registrant CIK and the filing HTML, classify the filer (Fidelity,
T. Rowe Price, Baron, ARK, or "unknown" → LLM fallback) and run the matching
parser against the located PM section.

The CIK-based classification table covers the canonical anchor CIKs we know
from research samples. For unknown CIKs we additionally use the company name
shown in the SEC submissions feed (if provided) as a backup classifier.
"""
from __future__ import annotations

import re
from typing import Optional

from .pm_types import PmExtractionResult, PortfolioManager
from .section_finder import PmSection, find_pm_section

# CIK → parser id mapping for the known fund families.
# These are the CIKs verified against real 485BPOS / N-2 filings in PLAN §1.4
# and /tmp/nport_research/n1a_findings.md.
KNOWN_CIK_TO_PARSER: dict[str, str] = {
    "0000024238": "fidelity",   # Fidelity Contrafund
    "0001116626": "trp",        # T. Rowe Price Global Technology Fund
    "0001217673": "baron",      # Baron Select Funds
    "0001905088": "ark",        # ARK Venture Fund
}

# Substring patterns for filer-family classification when CIK is unrecognized
NAME_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bfidelity\b", re.IGNORECASE), "fidelity"),
    (re.compile(r"\bt\.?\s*rowe\s*price\b", re.IGNORECASE), "trp"),
    (re.compile(r"\bbaron\b", re.IGNORECASE), "baron"),
    (re.compile(r"\bark\b", re.IGNORECASE), "ark"),
]


def classify(cik: str | None = None, registrant_name: str | None = None) -> str:
    """Return a parser id: 'fidelity'|'trp'|'baron'|'ark'|'llm_fallback'."""
    if cik:
        padded = _pad_cik(cik)
        if padded in KNOWN_CIK_TO_PARSER:
            return KNOWN_CIK_TO_PARSER[padded]
    if registrant_name:
        for pat, pid in NAME_PATTERNS:
            if pat.search(registrant_name):
                return pid
    return "llm_fallback"


def _pad_cik(cik: str | int) -> str:
    try:
        return f"{int(cik):010d}"
    except (ValueError, TypeError):
        return str(cik)


def dispatch(
    html_content: str | bytes,
    *,
    cik: Optional[str] = None,
    registrant_name: Optional[str] = None,
    dry_run_llm: bool = False,
) -> PmExtractionResult:
    """Run the right parser against the filing and return a PmExtractionResult.

    Args:
        html_content: full filing HTML
        cik: registrant CIK (preferred classifier)
        registrant_name: backup classifier when CIK is unknown
        dry_run_llm: if dispatcher falls through to LLM, run in dry-run mode
            (no API call). Returns empty PMs with notes="dry_run".

    Returns: PmExtractionResult — `parser` field tells you what was tried.
    """
    parser_id = classify(cik=cik, registrant_name=registrant_name)
    section = find_pm_section(html_content)

    if section is None:
        return PmExtractionResult(
            parser=parser_id,
            portfolio_managers=[],
            confidence=0.0,
            notes="no_pm_section_found",
        )

    text = section.text
    if parser_id == "fidelity":
        from .pm_parsers import fidelity
        return fidelity.parse(text)
    if parser_id == "trp":
        from .pm_parsers import trp
        return trp.parse(text, full_html=section.html)
    if parser_id == "baron":
        from .pm_parsers import baron
        return baron.parse(text)
    if parser_id == "ark":
        from .pm_parsers import ark
        return ark.parse(text)

    # Fallback
    from .pm_parsers import llm_fallback
    return llm_fallback.parse(text, dry_run=dry_run_llm)


# ---------------------------------------------------------------------------
# CLI shim — `python3 -m nport.enrichment.n1a_extract.dispatcher`
# ---------------------------------------------------------------------------
def main(argv: Optional[list[str]] = None) -> int:
    """Parse a single N-1A / 485BPOS / N-2 HTML file from disk and print PMs.

    This is a thin debug shim — production use will call ``dispatch()``
    directly from a higher-level pipeline.
    """
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="N-1A portfolio-manager extractor")
    parser.add_argument("--html", required=True, help="Path to filing HTML")
    parser.add_argument("--cik", help="Registrant CIK (preferred classifier)")
    parser.add_argument("--name", help="Registrant name (backup classifier)")
    parser.add_argument(
        "--dry-run-llm",
        action="store_true",
        help="Skip LLM API calls in fallback parser",
    )
    args = parser.parse_args(argv)

    with open(args.html, "r", encoding="utf-8") as fh:
        html = fh.read()
    result = dispatch(
        html,
        cik=args.cik,
        registrant_name=args.name,
        dry_run_llm=args.dry_run_llm,
    )
    print(
        json.dumps(
            {
                "parser": result.parser,
                "confidence": result.confidence,
                "notes": result.notes,
                "portfolio_managers": [
                    pm.__dict__ if hasattr(pm, "__dict__") else pm
                    for pm in result.portfolio_managers
                ],
            },
            indent=2,
            default=str,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
