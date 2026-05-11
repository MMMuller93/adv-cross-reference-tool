"""N-PORT entity-resolution module.

Public surface:
    - :func:`normalize_issuer`       (normalizer)
    - :func:`unwrap_spv`             (spv_unwrap)
    - :func:`extract_share_class`    (share_class)
    - :class:`Resolver`              (resolver)
    - :func:`load_seed_aliases`      (this module)

The :func:`load_seed_aliases` helper flattens ``aliases_seed.json`` into the
list-of-dicts shape that :class:`Resolver` expects, using the company ``slug``
as the ``company_id``. Production callers should replace this with a query
against ``private_company_aliases`` and pass real UUIDs instead.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .normalizer import normalize_issuer
from .resolver import ResolutionResult, Resolver
from .share_class import ShareClassInfo, extract_share_class
from .spv_unwrap import unwrap_spv


_SEED_PATH = Path(__file__).parent / "aliases_seed.json"


def load_seed_aliases(
    path: Path | str | None = None,
) -> list[dict[str, Any]]:
    """Load and flatten the bundled seed JSON into Resolver-compatible rows.

    Args:
        path: Optional override for the seed file location. Defaults to
            ``aliases_seed.json`` sitting next to this module.

    Returns:
        Flat list of alias dicts, one per (company, alias-pattern) pair. Each
        dict carries ``company_id`` (the company's slug) and ``is_sanctioned``
        (propagated from the company-level flag).
    """
    seed_path = Path(path) if path else _SEED_PATH
    with seed_path.open("r", encoding="utf-8") as f:
        seed = json.load(f)

    out: list[dict[str, Any]] = []
    for company in seed.get("companies", []):
        slug = company["slug"]
        is_sanctioned = bool(company.get("is_sanctioned", False))
        for alias in company.get("aliases", []):
            out.append(
                {
                    "company_id": slug,
                    "pattern_type": alias["pattern_type"],
                    "pattern": alias["pattern"],
                    "exposure_type": alias.get("exposure_type", "direct"),
                    "vendor_code_type": alias.get("vendor_code_type"),
                    "confidence": alias.get("confidence"),
                    "is_sanctioned": is_sanctioned,
                }
            )
    return out


__all__ = [
    "Resolver",
    "ResolutionResult",
    "ShareClassInfo",
    "extract_share_class",
    "load_seed_aliases",
    "normalize_issuer",
    "unwrap_spv",
]
