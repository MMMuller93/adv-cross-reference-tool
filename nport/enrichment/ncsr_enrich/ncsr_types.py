"""Shared types for N-CSR / N-CSRS acquisition-cost extraction."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Optional


@dataclass
class AcquisitionEntry:
    """A single (security, share_class, acquisition cost, acquisition date) row."""

    security_name: str
    share_class: Optional[str] = None  # e.g. "Series C-1", "Class F-1", "Common Stock"
    acquisition_date: Optional[str] = None  # ISO date string YYYY-MM-DD, or YYYY-MM if month-only
    acquisition_date_raw: Optional[str] = None  # original raw text like "3/31/23"
    acquisition_cost_usd: Optional[float] = None
    fair_value_usd: Optional[float] = None
    shares: Optional[float] = None
    is_multiple_tranches: bool = False
    tranche_start_date: Optional[str] = None  # ISO date
    tranche_end_date: Optional[str] = None    # ISO date
    footnotes: Optional[str] = None
    source_filer: Optional[str] = None  # "ark" | "destiny" | "fidelity" | "trp" | "llm_fallback"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class NCsrExtractionResult:
    parser: str
    entries: list[AcquisitionEntry] = field(default_factory=list)
    confidence: float = 0.0
    notes: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "parser": self.parser,
            "entries": [e.to_dict() for e in self.entries],
            "confidence": self.confidence,
            "notes": self.notes,
        }
