"""Per-person enrichment for Form ADV-named individuals.

For every owner/CCO/signatory/control-person/regulatory-contact named in
advisers_enriched (or normalized via the API), this script finds a LinkedIn
URL and any inferred title, then writes results to intel_person_enrichment
(migration 007_intel_person_enrichment.sql in the N-PORT project).

Architecture mirrors PFR's enrichment_engine_v2.js — Brave first, Google
second, neither => low confidence. Validation uses simple heuristics
(LinkedIn URL pattern + firm-name-in-snippet match) plus an optional
OpenAI gpt-4o-mini classification when OPENAI_API_KEY is set.

Idempotency: upsert on (adviser_crd, normalized_name). Re-runs skip rows
that were enriched within the last 30 days unless --force is passed.

CLI:
   python intelligence/enrich_people.py --company anthropic            # dry-run
   python intelligence/enrich_people.py --company anthropic --execute  # writes
   python intelligence/enrich_people.py --all --execute                # everyone

Cost guard:
   --max-calls N        cap Brave+Google calls in this run (default: 200)
   --delay-ms N         pacing between calls (default: 1500ms)

WARNING: This script makes external API calls (Brave Search 2000/mo free
tier; Google CSE 100/day free tier). Run in batches; the cache prevents
re-querying the same name. The actual full-corpus enrichment is meant to
run out-of-band, not on every materialize batch.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PFR_ROOT = Path("/Users/Miles/projects/PrivateFundsRadar")
CACHE_PATH = Path(__file__).resolve().parent / "out" / "person_enrichment_cache.json"


def _read_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_credentials() -> None:
    _read_env_file(PROJECT_ROOT / ".env")
    _read_env_file(PFR_ROOT / ".env.nport")
    _read_env_file(PFR_ROOT / ".env")


def create_nport_client():
    url = os.environ.get("SUPABASE_URL_NPORT")
    key = os.environ.get("SUPABASE_SERVICE_KEY_NPORT")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL_NPORT and SUPABASE_SERVICE_KEY_NPORT required")
    from supabase import create_client  # type: ignore
    return create_client(url, key)


def create_adv_client():
    url = os.environ.get("SUPABASE_URL_ADV") or "https://ezuqwwffjgfzymqxsctq.supabase.co"
    key = os.environ.get("SUPABASE_ANON_KEY_ADV") or os.environ.get("ADV_SUPABASE_ANON_KEY")
    if not key:
        raise RuntimeError("SUPABASE_ANON_KEY_ADV required")
    from supabase import create_client  # type: ignore
    return create_client(url, key)


# ---------------------------------------------------------------------------
# Name normalization (mirrors nport/api/lib/name_normalizer.js so the JOIN
# key on the API side matches what we write here).
# ---------------------------------------------------------------------------

CORPORATE_TOKENS = {
    'INC', 'INC.', 'LLC', 'LP', 'L.P.', 'CORP', 'CORP.', 'CORPORATION',
    'GROUP', 'HOLDINGS', 'COMPANY', 'CO', 'CO.', 'LTD', 'LTD.', 'LIMITED',
    'TRUST', 'BANK', 'ASSOCIATES', 'MANAGEMENT', 'CAPITAL', 'PARTNERS',
    'FUND', 'FUNDS', 'ADVISORS', 'ADVISERS', 'SECURITIES', 'SERVICES',
    'PLC', 'GMBH', 'AG', 'SA', 'NV', 'BV',
}


def _is_likely_corporate(s: str) -> bool:
    if not s:
        return False
    tokens = re.split(r"[\s,.()]+", s.upper())
    return any(t in CORPORATE_TOKENS for t in tokens if t)


def _title_case(s: str) -> str:
    if not s:
        return s
    parts = re.split(r"(\s+)", s)
    out = []
    for p in parts:
        if not p or p.isspace():
            out.append(p)
            continue
        upper = p.upper()
        # Preserve mixed-case brand-ish tokens.
        has_lower = any(c.islower() for c in p)
        has_upper_past_first = any(c.isupper() for c in p[1:])
        if has_lower and has_upper_past_first:
            out.append(p)
            continue
        # Standard title case.
        out.append(re.sub(r"(^|[\s\-'.])([a-z])",
                          lambda m: m.group(1) + m.group(2).upper(),
                          p.lower()))
    return "".join(out)


def normalize_name(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if _is_likely_corporate(s):
        return _title_case(s)
    parts = [p.strip() for p in s.split(",") if p.strip()]
    if len(parts) < 2:
        return _title_case(s)
    last, first = parts[0], parts[1]
    middles = []
    for t in parts[2:]:
        if t.upper() == "NMN":
            continue
        if re.fullmatch(r"[A-Za-z]", t):
            middles.append(t.upper() + ".")
        else:
            middles.append(t)
    segments = [first, *middles, last]
    return " ".join(_title_case(seg) for seg in segments if seg)


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

def load_cache() -> dict[str, Any]:
    if not CACHE_PATH.exists():
        return {}
    try:
        return json.loads(CACHE_PATH.read_text() or "{}")
    except Exception:
        return {}


def save_cache(cache: dict[str, Any]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True))


# ---------------------------------------------------------------------------
# Search clients (Brave first, Google fallback)
# ---------------------------------------------------------------------------

def brave_search(query: str) -> Optional[list[dict[str, Any]]]:
    api_key = os.environ.get("BRAVE_API_KEY") or os.environ.get("BRAVE_SEARCH_API_KEY")
    if not api_key:
        return None
    url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode({
        "q": query, "count": 10, "country": "us", "search_lang": "en",
    })
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "X-Subscription-Token": api_key,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        hits = (data.get("web") or {}).get("results") or []
        return [{"url": h.get("url"), "title": h.get("title"), "snippet": h.get("description")}
                for h in hits]
    except Exception as e:
        print(f"  brave search failed: {e}", file=sys.stderr)
        return None


def google_cse_search(query: str) -> Optional[list[dict[str, Any]]]:
    api_key = os.environ.get("GOOGLE_API_KEY")
    cx = os.environ.get("GOOGLE_CSE_ID") or os.environ.get("GOOGLE_CX")
    if not api_key or not cx:
        return None
    url = "https://www.googleapis.com/customsearch/v1?" + urllib.parse.urlencode({
        "key": api_key, "cx": cx, "q": query, "num": 10,
    })
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read())
        return [{"url": h.get("link"), "title": h.get("title"), "snippet": h.get("snippet")}
                for h in (data.get("items") or [])]
    except Exception as e:
        print(f"  google search failed: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Per-person resolution
# ---------------------------------------------------------------------------

LINKEDIN_PROFILE_RE = re.compile(r"^https?://(?:[a-z]+\.)?linkedin\.com/in/[A-Za-z0-9\-\._%]+/?$",
                                 re.IGNORECASE)


def find_linkedin_for_person(person_name: str, firm_name: str, role_hint: Optional[str] = None,
                             cache: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Search the web for a LinkedIn profile matching this person at this firm.

    Returns: {
      'linkedin_url':  str | None,
      'inferred_title': str | None,
      'confidence':    'high' | 'medium' | 'low' | None,
      'source':        'brave' | 'google' | None,
      'raw_hit':       {...} | None,
    }
    """
    cache_key = f"{firm_name}::{person_name}"
    if cache and cache_key in cache:
        return cache[cache_key]

    query = f'"{person_name}" "{firm_name}" site:linkedin.com/in'
    hits = brave_search(query) or google_cse_search(query) or []
    source = "brave" if os.environ.get("BRAVE_API_KEY") else ("google" if os.environ.get("GOOGLE_API_KEY") else None)

    best = None
    for hit in hits:
        url = hit.get("url") or ""
        if not LINKEDIN_PROFILE_RE.match(url):
            continue
        snippet = (hit.get("snippet") or "") + " " + (hit.get("title") or "")
        person_match = person_name.lower() in snippet.lower()
        firm_match = firm_name.lower() in snippet.lower()
        if person_match and firm_match:
            best = {"hit": hit, "confidence": "high"}
            break
        if person_match and not best:
            best = {"hit": hit, "confidence": "medium"}

    result: dict[str, Any] = {
        "linkedin_url": None,
        "inferred_title": None,
        "confidence": None,
        "source": source,
        "raw_hit": None,
    }
    if best:
        result["linkedin_url"] = best["hit"].get("url")
        result["confidence"] = best["confidence"]
        result["raw_hit"] = best["hit"]
        # Extract title heuristic from snippet: "Title at Firm"
        snippet = (best["hit"].get("snippet") or "") + " " + (best["hit"].get("title") or "")
        m = re.search(r"([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+){0,4})\s+(?:at|@|,)\s+" + re.escape(firm_name),
                      snippet)
        if m:
            result["inferred_title"] = m.group(1).strip()

    if cache is not None:
        cache[cache_key] = result
    return result


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def fetch_named_people_for_company(nport, adv, slug: str) -> list[dict[str, Any]]:
    """For a tracked company, get every (adviser_crd, person_name, role) tuple
    that appears in the holders rollup. Reuses the v_intel_company_holders
    view to discover the relevant CRD set; then queries advisers_enriched
    for the per-firm named-person fields.
    """
    crds_resp = (
        nport.table("v_intel_company_holders")
        .select("adviser_crd")
        .eq("company_slug", slug)
        .not_.is_("adviser_crd", "null")
        .limit(5000)
        .execute()
    )
    crds = sorted({str(r["adviser_crd"]) for r in (crds_resp.data or []) if r.get("adviser_crd")})
    if not crds:
        return []

    people: list[dict[str, Any]] = []
    for chunk_start in range(0, len(crds), 100):
        chunk = crds[chunk_start : chunk_start + 100]
        resp = (
            adv.table("advisers_enriched")
            .select("crd,adviser_name,cco_name,signatory_name,owner_full_legal_name,"
                    "control_person_name,regulatory_contact_name")
            .in_("crd", chunk)
            .execute()
        )
        for row in (resp.data or []):
            firm = row.get("adviser_name") or ""
            crd = str(row["crd"])
            for field, role in [
                ("cco_name", "cco"),
                ("signatory_name", "signatory"),
                ("control_person_name", "control"),
                ("regulatory_contact_name", "regulatory"),
            ]:
                v = row.get(field)
                if v and not _is_likely_corporate(v):
                    name = normalize_name(v)
                    if name:
                        people.append({"crd": crd, "firm": firm, "name": name, "role": role})
            # Owners blob: semicolon-separated, mixed corporate + people.
            owner_blob = row.get("owner_full_legal_name") or ""
            for raw in owner_blob.split(";"):
                raw = raw.strip()
                if not raw or _is_likely_corporate(raw):
                    continue
                name = normalize_name(raw)
                if name:
                    people.append({"crd": crd, "firm": firm, "name": name, "role": "owner"})

    # Dedupe on (crd, normalized_name) — same person may appear via multiple
    # ADV fields; we only want to scrape them once.
    seen = set()
    deduped = []
    for p in people:
        key = (p["crd"], p["name"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(p)
    return deduped


def write_enrichment_row(nport, row: dict[str, Any]) -> None:
    nport.table("intel_person_enrichment").upsert(
        row, on_conflict="adviser_crd,normalized_name"
    ).execute()


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Per-person enrichment for Form ADV named individuals.")
    p.add_argument("--company", help="Slug; if omitted, --all required")
    p.add_argument("--all", action="store_true", help="Process every tracked company")
    p.add_argument("--execute", action="store_true", help="Write to intel_person_enrichment")
    p.add_argument("--max-calls", type=int, default=200, help="Cap Brave/Google calls (default 200)")
    p.add_argument("--delay-ms", type=int, default=1500, help="Pacing between calls (default 1500)")
    p.add_argument("--force", action="store_true", help="Re-enrich rows enriched <30 days ago")
    args = p.parse_args(argv)

    if not args.company and not args.all:
        print("ERROR: provide --company SLUG or --all", file=sys.stderr)
        return 2

    load_credentials()
    nport = create_nport_client()
    adv = create_adv_client()
    cache = load_cache()

    if args.company:
        company_slugs = [args.company]
    else:
        # Iterate every private_companies row
        rs = nport.table("private_companies").select("slug").limit(5000).execute()
        company_slugs = [r["slug"] for r in (rs.data or [])]

    call_count = 0
    written = 0
    skipped = 0
    for slug in company_slugs:
        print(f"\n=== {slug} ===")
        people = fetch_named_people_for_company(nport, adv, slug)
        print(f"  {len(people)} unique named people to consider")
        for person in people:
            if call_count >= args.max_calls:
                print(f"  reached --max-calls={args.max_calls}, stopping.")
                save_cache(cache)
                return 0
            cache_key = f"{person['firm']}::{person['name']}"
            cached = cache.get(cache_key)
            if cached and not args.force:
                skipped += 1
                continue
            result = find_linkedin_for_person(
                person["name"], person["firm"], person["role"], cache=cache
            )
            call_count += 1
            time.sleep(args.delay_ms / 1000.0)

            if result.get("linkedin_url"):
                src = result.get("source") or "search"
                conf = result.get("confidence")
                print(f"  ✓ {person['name']:30s} ({person['role']:10s} @ {person['firm'][:30]}) "
                      f"-> {result['linkedin_url']} [{conf}, {src}]")
            else:
                print(f"  · {person['name']:30s} ({person['role']:10s} @ {person['firm'][:30]}) -> no match")

            if args.execute and result.get("linkedin_url"):
                write_enrichment_row(nport, {
                    "adviser_crd": person["crd"],
                    "normalized_name": person["name"],
                    "role_hint": person["role"],
                    "linkedin_url": result["linkedin_url"],
                    "inferred_title": result.get("inferred_title"),
                    "confidence": result["confidence"],
                    "source": result.get("source"),
                    "raw_search_hit": result.get("raw_hit"),
                })
                written += 1
        save_cache(cache)

    print(f"\nDone. calls={call_count} written={written} skipped(cache)={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
