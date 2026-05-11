"""LLM-based fallback extractor for the long tail of N-CSR / N-CSRS filers.

Universe of N-CSR filings mentioning private placements is ~700/year per
/tmp/nport_research/ncsr_findings.md. Of those, the 5-8 largest fund families
(Fidelity, ARK, T. Rowe Price, Baron, BlackRock, Destiny) have dedicated
parsers. The long tail uses this LLM fallback.

Cost estimate: gpt-4o-mini at ~$0.15 / 1M input tokens. A typical N-CSR has
~50–200 restricted-securities rows; we feed the schedule-of-investments section
only (truncated). Cost per filing: $0.50-2 per filing × ~500 long-tail
filings/yr = $250-1000/yr.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Optional

from ..ncsr_types import AcquisitionEntry, NCsrExtractionResult

LOG = logging.getLogger(__name__)

DEFAULT_MODEL = "gpt-4o-mini"

NCSR_EXTRACTION_PROMPT = """You are extracting restricted-security acquisition data from this SEC Form N-CSR / N-CSRS filing.

Return STRICT JSON only — no commentary, no markdown. Schema:

{
  "entries": [
    {
      "security_name": "<company name as written>",
      "share_class": "<Series A / Class B / Common Stock / null>",
      "acquisition_date": "<YYYY-MM-DD if single date, or null>",
      "acquisition_date_raw": "<verbatim text from filing>",
      "acquisition_cost_usd": <number or null>,
      "fair_value_usd": <number or null>,
      "shares": <number or null>,
      "is_multiple_tranches": <true|false>,
      "tranche_start_date": "<YYYY-MM-DD or null>",
      "tranche_end_date": "<YYYY-MM-DD or null>",
      "footnotes": "<comma-separated footnote codes or null>"
    }
  ]
}

Rules:
- Only include private/restricted securities. Skip public equities.
- If date is a range like "7/2/2024 - 6/16/2025", set is_multiple_tranches=true and fill tranche_start/end.
- If no restricted-security rows are present, return {"entries": []}.

Text to extract from:
---
{section_text}
---
"""


class MissingOpenAIKey(RuntimeError):
    """Raised when OPENAI_API_KEY is needed but not set."""


def _build_prompt(section_text: str) -> str:
    return NCSR_EXTRACTION_PROMPT.replace("{section_text}", section_text or "")


def parse(
    section_text: str,
    *,
    dry_run: bool = False,
    model: str = DEFAULT_MODEL,
    max_section_chars: int = 30000,
) -> NCsrExtractionResult:
    text = (section_text or "")[:max_section_chars]
    prompt = _build_prompt(text)

    if dry_run:
        LOG.info("[dry_run] Would call %s with %d chars of section text", model, len(text))
        return NCsrExtractionResult(
            parser="llm_fallback",
            entries=[],
            confidence=0.0,
            notes="dry_run",
        )

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise MissingOpenAIKey(
            "OPENAI_API_KEY environment variable is required for llm_fallback.parse(). "
            "Set it in .env or the shell, or pass dry_run=True."
        )

    response_text = _call_openai(api_key, model, prompt)
    entries = _parse_response(response_text)
    return NCsrExtractionResult(
        parser="llm_fallback",
        entries=entries,
        confidence=0.7 if entries else 0.0,
    )


def _call_openai(api_key: str, model: str, prompt: str) -> str:
    """Direct OpenAI Chat Completions call — kept as a tiny shim so tests can monkey-patch it."""
    import requests

    url = "https://api.openai.com/v1/chat/completions"
    body = {
        "model": model,
        "messages": [
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    resp = requests.post(url, headers=headers, json=body, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def _parse_response(response_text: str) -> list[AcquisitionEntry]:
    try:
        data = json.loads(response_text)
    except (TypeError, json.JSONDecodeError):
        LOG.warning("LLM returned non-JSON content: %r", response_text[:200])
        return []
    raw = data.get("entries", [])
    out: list[AcquisitionEntry] = []
    for item in raw:
        if not isinstance(item, dict) or not item.get("security_name"):
            continue
        out.append(
            AcquisitionEntry(
                security_name=str(item["security_name"]).strip(),
                share_class=item.get("share_class") or None,
                acquisition_date=item.get("acquisition_date") or None,
                acquisition_date_raw=item.get("acquisition_date_raw") or None,
                acquisition_cost_usd=_safe_float(item.get("acquisition_cost_usd")),
                fair_value_usd=_safe_float(item.get("fair_value_usd")),
                shares=_safe_float(item.get("shares")),
                is_multiple_tranches=bool(item.get("is_multiple_tranches")),
                tranche_start_date=item.get("tranche_start_date") or None,
                tranche_end_date=item.get("tranche_end_date") or None,
                footnotes=item.get("footnotes") or None,
                source_filer="llm_fallback",
            )
        )
    return out


def _safe_float(v) -> Optional[float]:
    if v is None or v == "null":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
