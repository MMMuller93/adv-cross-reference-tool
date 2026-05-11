"""Shared types for N-1A / N-2 portfolio manager extraction."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Optional


@dataclass
class PortfolioManager:
    """A single named portfolio manager extracted from a prospectus."""

    name: str
    role: Optional[str] = None  # e.g. "Co-Portfolio Manager", "Lead Portfolio Manager"
    managed_since: Optional[str] = None  # year as string, e.g. "2012"
    joined_firm: Optional[str] = None    # year as string, e.g. "2015"
    source_filer: Optional[str] = None   # parser identifier: "fidelity", "trp", etc.
    notes: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PmExtractionResult:
    """Result of running a parser against one PM section / prospectus."""

    parser: str  # "fidelity" | "trp" | "baron" | "ark" | "llm_fallback"
    portfolio_managers: list[PortfolioManager] = field(default_factory=list)
    confidence: float = 0.0
    raw_excerpt: Optional[str] = None
    notes: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "parser": self.parser,
            "portfolio_managers": [pm.to_dict() for pm in self.portfolio_managers],
            "confidence": self.confidence,
            "raw_excerpt": self.raw_excerpt,
            "notes": self.notes,
        }
