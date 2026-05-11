"""Generic LLM-based portfolio-manager extractor.

Used as a fallback for filers without a dedicated parser (e.g., DXYZ's N-2,
smaller advisers, boutique closed-end funds). Calls OpenAI gpt-4o-mini with a
structured JSON-output prompt.

Configuration:
- Reads OPENAI_API_KEY from environment. If missing, raises a clear error.
- Accepts dry_run=True to log the prompt without making the API call.
- Cost per call at gpt-4o-mini pricing (~$0.15 / 1M input tokens) is well
  under $0.01 per filing for the small PM section we feed it.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Optional

from ..pm_types import PmExtractionResult, PortfolioManager

LOG = logging.getLogger(__name__)

DEFAULT_MODEL = "gpt-4o-mini"
PM_EXTRACTION_PROMPT = """You are extracting portfolio manager information from a US mutual fund or closed-end fund prospectus / SAI section.

Return STRICT JSON only — no commentary, no markdown. Schema:

{
  "portfolio_managers": [
    {
      "name": "<full name as written>",
      "role": "<Lead Portfolio Manager | Co-Portfolio Manager | Portfolio Manager | Chief Investment Officer | Investment Committee Member | other>",
      "managed_since": "<YYYY year only, or null>",
      "joined_firm": "<YYYY year only, or null>",
      "notes": "<one-sentence note on tenure or biography, or null>"
    }
  ]
}

If no portfolio manager is named, return {"portfolio_managers": []}.

For closed-end funds (N-2) where the decision-maker is identified only via an
"Investment Committee" or corporate-ownership prose (no labeled "Portfolio
Manager"), name the human(s) actually identified and set role to
"Investment Committee Member".

Text to extract from:
---
{section_text}
---
"""


class MissingOpenAIKey(RuntimeError):
    """Raised when OPENAI_API_KEY is needed but not set."""


def _build_prompt(section_text: str) -> str:
    return PM_EXTRACTION_PROMPT.replace("{section_text}", section_text or "")


def parse(
    section_text: str,
    *,
    dry_run: bool = False,
    model: str = DEFAULT_MODEL,
    max_section_chars: int = 8000,
) -> PmExtractionResult:
    """Call (or simulate) the LLM extractor.

    Args:
        section_text: the PM section as plain text (already narrowed by section_finder)
        dry_run: if True, build the prompt and log it; do NOT call the API.
                 Returns a result with empty portfolio_managers and notes="dry_run".
        model: OpenAI model id (default gpt-4o-mini)
        max_section_chars: truncate the section text to bound LLM cost

    Returns:
        PmExtractionResult with parser="llm_fallback".
    """
    text = (section_text or "")[:max_section_chars]
    prompt = _build_prompt(text)

    if dry_run:
        LOG.info("[dry_run] Would call %s with %d chars of section text", model, len(text))
        return PmExtractionResult(
            parser="llm_fallback",
            portfolio_managers=[],
            confidence=0.0,
            raw_excerpt=text[:400],
            notes="dry_run",
        )

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise MissingOpenAIKey(
            "OPENAI_API_KEY environment variable is required for llm_fallback.parse(). "
            "Set it in .env or the shell, or pass dry_run=True to inspect the prompt without calling the API."
        )

    response_text = _call_openai(api_key, model, prompt)
    pms = _parse_response(response_text)
    return PmExtractionResult(
        parser="llm_fallback",
        portfolio_managers=pms,
        confidence=0.75 if pms else 0.0,
        raw_excerpt=text[:400],
    )


def _call_openai(api_key: str, model: str, prompt: str) -> str:
    """Call the OpenAI Chat Completions API; return the raw JSON text content.

    Kept as a tiny shim so the test suite can monkey-patch it.
    """
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
    resp = requests.post(url, headers=headers, json=body, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def _parse_response(response_text: str) -> list[PortfolioManager]:
    try:
        data = json.loads(response_text)
    except (TypeError, json.JSONDecodeError):
        LOG.warning("LLM returned non-JSON content: %r", response_text[:200])
        return []
    raw = data.get("portfolio_managers", [])
    pms: list[PortfolioManager] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not name:
            continue
        pms.append(
            PortfolioManager(
                name=str(name).strip(),
                role=(item.get("role") or None),
                managed_since=_year_or_none(item.get("managed_since")),
                joined_firm=_year_or_none(item.get("joined_firm")),
                notes=item.get("notes") or None,
                source_filer="llm_fallback",
            )
        )
    return pms


def _year_or_none(val) -> Optional[str]:
    if val is None or val == "null":
        return None
    s = str(val).strip()
    if not s or len(s) < 4:
        return None
    # accept "2014" or "2014-01" → "2014"
    if len(s) >= 4 and s[:4].isdigit():
        return s[:4]
    return None
