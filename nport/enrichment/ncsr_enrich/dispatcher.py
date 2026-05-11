"""Dispatch an N-CSR / N-CSRS HTML to the right per-filer parser.

Classification uses CIK plus a registrant-name substring backup. Falls back
to the LLM extractor for unknown filers.
"""
from __future__ import annotations

import re
from typing import Optional

from .ncsr_types import NCsrExtractionResult

# Per-filer CIK anchors (from PLAN_NPORT_HOLDINGS §1.3 + ncsr_findings.md):
KNOWN_CIK_TO_PARSER: dict[str, str] = {
    "0001905088": "ark",       # ARK Venture Fund
    "0001843974": "destiny",   # Destiny Tech100 (DXYZ)
    "0000024238": "fidelity",  # Fidelity Contrafund (representative — many CIKs in trust)
    "0001116626": "trp",       # T. Rowe Price Global Tech (representative)
}

NAME_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bark\s+venture\b", re.IGNORECASE), "ark"),
    # Destiny Tech100, Destiny Tech 100, Destiny Tech 100 Inc., etc.
    (re.compile(r"\bdestiny\s+tech\d*\b", re.IGNORECASE), "destiny"),
    (re.compile(r"\bfidelity\b", re.IGNORECASE), "fidelity"),
    (re.compile(r"\bt\.?\s*rowe\s*price\b", re.IGNORECASE), "trp"),
]


def classify(cik: Optional[str] = None, registrant_name: Optional[str] = None) -> str:
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
) -> NCsrExtractionResult:
    """Route an N-CSR HTML to the correct parser and return entries."""
    parser_id = classify(cik=cik, registrant_name=registrant_name)

    if parser_id == "ark":
        from .ncsr_parsers import ark
        return ark.parse(html_content)
    if parser_id == "destiny":
        from .ncsr_parsers import destiny
        return destiny.parse(html_content)
    if parser_id == "fidelity":
        from .ncsr_parsers import fidelity
        return fidelity.parse(html_content)
    if parser_id == "trp":
        from .ncsr_parsers import trp
        return trp.parse(html_content)

    # Long tail → LLM. We pass the full doc text; truncated inside the LLM module.
    from .ncsr_parsers import llm_fallback
    text = html_content.decode("utf-8", errors="replace") if isinstance(html_content, bytes) else html_content
    return llm_fallback.parse(text, dry_run=dry_run_llm)


# ---------------------------------------------------------------------------
# CLI shim — `python3 -m nport.enrichment.ncsr_enrich.dispatcher`
# ---------------------------------------------------------------------------
def main(argv: Optional[list[str]] = None) -> int:
    """Parse a single N-CSR HTML file from disk and print extracted entries."""
    import argparse
    import json

    parser = argparse.ArgumentParser(description="N-CSR acquisition-cost extractor")
    parser.add_argument("--html", required=True, help="Path to N-CSR HTML")
    parser.add_argument("--cik", help="Registrant CIK")
    parser.add_argument("--name", help="Registrant name")
    parser.add_argument("--dry-run-llm", action="store_true")
    args = parser.parse_args(argv)

    with open(args.html, "r", encoding="utf-8") as fh:
        html = fh.read()
    result = dispatch(
        html,
        cik=args.cik,
        registrant_name=args.name,
        dry_run_llm=args.dry_run_llm,
    )
    print(json.dumps(result.__dict__ if hasattr(result, "__dict__") else result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
