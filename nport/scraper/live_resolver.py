"""Build the production resolver from live Supabase seed tables."""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Callable, Iterable

from nport.resolver import Resolver, normalize_issuer

from .filter_f4 import normalize_issuer_name


def _page_all(client, table: str, select: str, *, page_size: int = 1000) -> list[dict[str, Any]]:
    """Fetch a small/medium table from Supabase using range pages."""
    rows: list[dict[str, Any]] = []
    start = 0
    while True:
        response = client.table(table).select(select).range(start, start + page_size - 1).execute()
        batch = response.data or []
        rows.extend(batch)
        if len(batch) < page_size:
            return rows
        start += page_size


def load_live_aliases(client) -> list[dict[str, Any]]:
    """Return Resolver-compatible aliases with real private_companies UUIDs."""
    companies = {
        row["id"]: {
            "is_sanctioned": bool(row.get("is_sanctioned")),
            "is_public": bool(row.get("is_public")),
            "is_acquired": bool(row.get("is_acquired")),
        }
        for row in _page_all(client, "private_companies", "id,is_sanctioned,is_public,is_acquired")
    }
    aliases: list[dict[str, Any]] = []
    last_id = 0
    while True:
        response = (
            client.table("private_company_aliases")
            .select("id,company_id,pattern_type,pattern,exposure_type,vendor_code_type,confidence")
            .gt("id", last_id)
            .order("id")
            .limit(1000)
            .execute()
        )
        batch = response.data or []
        for row in batch:
            last_id = max(last_id, int(row["id"]))
            aliases.append(
                {
                    "company_id": row.get("company_id"),
                    "pattern_type": row.get("pattern_type"),
                    "pattern": row.get("pattern"),
                    "exposure_type": row.get("exposure_type") or "direct",
                    "vendor_code_type": row.get("vendor_code_type"),
                    "confidence": row.get("confidence"),
                    **companies.get(
                        row.get("company_id"),
                        {"is_sanctioned": False, "is_public": False, "is_acquired": False},
                    ),
                }
            )
        if len(batch) < 1000:
            break
    if not aliases:
        raise RuntimeError("private_company_aliases is empty; refusing to ingest without resolver aliases")
    return aliases


def load_alias_cache(aliases: Iterable[dict[str, Any]]) -> set[str]:
    """Build the exact-name alias branch cache used by the F4 filter."""
    cache: set[str] = set()
    for alias in aliases:
        if alias.get("is_sanctioned") or alias.get("is_public") or alias.get("is_acquired"):
            continue
        if alias.get("pattern_type") == "exact_normalized" and alias.get("pattern"):
            cache.add(normalize_issuer_name(str(alias["pattern"])))
    return cache


def load_sanctioned_patterns(client) -> set[str]:
    patterns: set[str] = set()
    for row in _page_all(client, "sanctioned_securities", "pattern"):
        pattern = row.get("pattern")
        if pattern:
            normalized = normalize_issuer(str(pattern))
            if normalized:
                patterns.add(normalized)
    return patterns


def matches_sanctioned_pattern(row: dict[str, Any], patterns: set[str]) -> bool:
    if not patterns:
        return False
    for raw in (row.get("issuer_name"), row.get("issuer_title")):
        normalized = normalize_issuer(raw)
        if not normalized:
            continue
        for pattern in patterns:
            if normalized == pattern or normalized.startswith(pattern + " "):
                return True
    return False


def build_resolver(
    client,
    *,
    identifiers_lookup: Callable[[str], list[dict[str, Any]]] | None = None,
) -> tuple[Resolver, set[str], set[str]]:
    """Return ``(resolver, alias_cache, sanctioned_patterns)`` for ingestion."""
    aliases = load_live_aliases(client)
    return (
        Resolver(aliases=aliases, identifiers_lookup=identifiers_lookup),
        load_alias_cache(aliases),
        load_sanctioned_patterns(client),
    )


def identifiers_lookup_from_rows(
    rows: Iterable[dict[str, Any]],
) -> Callable[[str], list[dict[str, Any]]]:
    by_holding: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        holding_id = row.get("holding_id")
        if holding_id:
            by_holding[str(holding_id)].append(row)
    return lambda holding_id: by_holding.get(str(holding_id), [])


__all__ = [
    "build_resolver",
    "identifiers_lookup_from_rows",
    "load_alias_cache",
    "load_live_aliases",
    "load_sanctioned_patterns",
    "matches_sanctioned_pattern",
]
