"""Baron Funds 485BPOS portfolio-manager parser.

Pattern in the wild (from Baron Select Funds 2026-04-30 filing):

  "Portfolio Manager.  Ronald Baron has been the Lead Portfolio Manager of the
   Fund since its inception on April 30, 2003."
  "Michael Baron has been the co-manager of the Fund since August 28, 2018."
  "Mr. Ronald Baron founded the Adviser in 1987."
  "Mr. Michael Baron joined the Adviser as a research analyst in September of 2004."

So the patterns we need:
  - "<Name> has been the (Lead Portfolio Manager|co-manager|portfolio manager)
     of the Fund since <DATE-PHRASE>"
  - Extract the year from the date phrase.

Baron Select Funds is multi-series; each series has its own "Portfolio Manager."
block. We accept the local section text (one fund's block) — caller should
slice by series. The parser handles all PMs in whatever block it's given.
"""
from __future__ import annotations

import re
from typing import Optional

from ..pm_types import PmExtractionResult, PortfolioManager

# Name component: a sequence of capitalized word(s), NOT preceded by a role word.
# Use a word-token alternation that excludes obvious role/title words.
# Limit each token to letters, apostrophes, hyphens and periods. Names must
# start with a capital letter and be 2-4 tokens long.
NAME_TOKEN = r"[A-Z][a-z]+(?:\.|'[a-z]+)?"
NAME_PART = rf"{NAME_TOKEN}(?:\s+{NAME_TOKEN}){{1,3}}"

# Words that should NOT appear at the start of a name capture — these are role
# words that the surrounding HTML/text often joins to the name.
# We assert a negative lookbehind for these.
ROLE_PREFIXES = (
    "Portfolio Manager.",
    "Co-Manager.",
    "Lead Portfolio Manager.",
    "co-portfolio manager",
    "portfolio manager",
)

# Baron Funds prose pattern. Constrain the name to 2–3 tokens AND require
# that it isn't a role-phrase. We disable greedy multi-token expansion by
# capturing the FIRST two-or-three capitalized tokens immediately preceding
# "has been".
# Examples we want to match:
#   "Ronald Baron has been the Lead Portfolio Manager..."
#   "Michael Baron has been the co-manager..."
#   "Mr. David Baron has been the co-manager..."
PATTERN = re.compile(
    rf"(?:Mr\.|Ms\.|Mrs\.|Dr\.|\b)\s*"
    rf"(?P<name>{NAME_TOKEN}(?:\s+{NAME_TOKEN}){{1,2}})\s+has been (?:the|a)\s+"
    rf"(?P<role>(?:Lead\s+)?(?:Co-?)?(?:Portfolio Manager|co-?manager|portfolio manager))"
    rf"\s+of\s+(?:the\s+)?(?:Fund|fund|[A-Z][^.]{{0,80}})"
    rf"\s+since\s+(?:its\s+inception\s+on\s+)?[^.]*?(?P<year>\d{{4}})",
    re.DOTALL,
)

JOINED_PATTERN = re.compile(
    rf"(?:Mr\.|Ms\.|Mrs\.|Dr\.|\b)\s*"
    rf"(?P<name>{NAME_TOKEN}(?:\s+{NAME_TOKEN}){{1,2}})\s+"
    rf"(?:joined|has been with)\s+(?:the\s+)?(?:Adviser|Firm)"
    rf"[^.]*?(?P<year>\d{{4}})",
    re.DOTALL,
)


def parse(section_text: str) -> PmExtractionResult:
    """Parse Baron-style PM disclosures from a text section."""
    section_text = _normalize_unicode(section_text or "")
    pms: list[PortfolioManager] = []
    by_name: dict[str, PortfolioManager] = {}

    for m in PATTERN.finditer(section_text):
        name = _normalize_name(m.group("name"))
        name = _strip_role_prefix(name)
        if not name or _looks_like_role_phrase(name):
            continue
        role_raw = m.group("role").strip()
        role = _normalize_role(role_raw)
        year = m.group("year")
        if name.lower() in by_name:
            continue
        pm = PortfolioManager(
            name=name,
            role=role,
            managed_since=year,
            source_filer="baron",
        )
        by_name[name.lower()] = pm
        pms.append(pm)

    # Augment with joined-firm year if mentioned for any of the same PMs
    for jm in JOINED_PATTERN.finditer(section_text):
        name = _normalize_name(jm.group("name"))
        existing = by_name.get(name.lower())
        if existing and not existing.joined_firm:
            existing.joined_firm = jm.group("year")

    conf = 0.95 if pms else 0.0
    return PmExtractionResult(
        parser="baron",
        portfolio_managers=pms,
        confidence=conf,
        raw_excerpt=_excerpt(section_text),
    )


_ROLE_WORDS = {
    "portfolio", "manager", "co-manager", "co", "lead", "chairman", "trustee",
    "president", "officer", "founder", "chief", "investment", "adviser",
    "advisor", "executive", "fund", "vice", "research", "analyst",
}


def _looks_like_role_phrase(candidate: str) -> bool:
    """Reject name-candidates that are actually role-phrase fragments."""
    tokens = candidate.lower().replace(".", "").split()
    if not tokens:
        return True
    # If half-or-more tokens look like role words, reject
    role_hits = sum(1 for t in tokens if t in _ROLE_WORDS)
    return role_hits >= max(1, len(tokens) // 2)


def _strip_role_prefix(candidate: str) -> str:
    """Strip leading role-word tokens like 'Portfolio Manager.' from a captured name.

    Example: 'Portfolio Manager. Ronald Baron' -> 'Ronald Baron'
    """
    tokens = candidate.split()
    while tokens and tokens[0].lower().replace(".", "") in _ROLE_WORDS:
        tokens.pop(0)
    return " ".join(tokens)


def _normalize_unicode(text: str) -> str:
    """Replace Unicode hyphens / dashes with ASCII '-' and NBSP with regular space.

    Baron filings use Unicode non-breaking hyphen U+2011 inside 'co-manager' which
    breaks naive regex. Normalize to ASCII before pattern matching.
    """
    return (
        text.replace("‑", "-")  # non-breaking hyphen
        .replace("–", "-")  # en-dash
        .replace("—", "-")  # em-dash
        .replace(" ", " ")  # non-breaking space
        .replace("’", "'")  # right single quotation mark (Baron uses curly apostrophes)
    )


def _normalize_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip()


def _normalize_role(role: str) -> str:
    r = role.lower()
    if "lead" in r:
        return "Lead Portfolio Manager"
    if "co" in r:
        return "Co-Manager"
    return "Portfolio Manager"


def _excerpt(text: str, n: int = 400) -> Optional[str]:
    if not text:
        return None
    return text[:n] + ("..." if len(text) > n else "")
