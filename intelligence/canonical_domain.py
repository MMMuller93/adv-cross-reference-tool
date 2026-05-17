"""
canonical_domain.py — Pick a real first-party adviser website.

Given an adviser's name, primary_website, and other_websites (comma or semicolon-
separated string), returns the best canonical URL or None if no first-party domain
can be identified.

Usage:
    from canonical_domain import pick_canonical_domain
    url = pick_canonical_domain("Fidelity Management & Research", primary, other_list)
"""

from __future__ import annotations
import re
from typing import Optional
from urllib.parse import urlparse


# ---------------------------------------------------------------------------
# SKIP LIST — UGC, social, aggregator, and platform domains
# Any URL whose registered domain matches (exact or subdomain) is skipped.
# ---------------------------------------------------------------------------
SKIP_DOMAINS: set[str] = {
    # Social networks
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "threads.net",
    "tiktok.com",
    "mastodon.social",
    "bsky.app",
    "discord.gg",
    "discord.com",
    "snapchat.com",
    "pinterest.com",
    "tumblr.com",
    "vimeo.com",
    "twitch.tv",
    # Blogging / publishing platforms
    "medium.com",
    "substack.com",
    "wordpress.com",
    "wordpress.org",
    "blogspot.com",
    "blogger.com",
    "ghost.io",
    "beehiiv.com",
    # Website builders
    "wix.com",
    "squarespace.com",
    "weebly.com",
    "webflow.io",
    "webflow.com",
    "godaddy.com",
    "strikingly.com",
    # Developer / code
    "github.com",
    "github.io",
    "gitlab.com",
    "bitbucket.org",
    # Job / review aggregators
    "glassdoor.com",
    "indeed.com",
    "ziprecruiter.com",
    "linkedin.com",  # already listed but explicit
    # Business aggregators
    "crunchbase.com",
    "pitchbook.com",
    "bloomberg.com",
    "reuters.com",
    "businesswire.com",
    "prnewswire.com",
    "globenewswire.com",
    "accesswire.com",
    # SEC / regulatory
    "sec.gov",
    "edgar.gov",
    "secinfo.com",
    "adviserinfo.sec.gov",
    "finra.org",
    "iapd.sec.gov",
    # User-generated / crowd-sourced
    "reddit.com",
    "quora.com",
    "wikipedia.org",
    "wikimedia.org",
    # Link-in-bio / micro-sites
    "linktr.ee",
    "linkinbio.com",
    "beacons.ai",
    "bio.link",
    # Noisy Fidelity-affiliated UGC subsidiary (not their main site)
    "plynk.com",
    # Retirement / plan admin aggregator portals
    "retirementpartner.com",
    "retire.americanfunds.com",
    "myplanrs.com",
    "empower-retirement.com",
    "principal.com",
    # Google / Apple / Microsoft properties
    "google.com",
    "apple.com",
    "microsoft.com",
    "maps.google.com",
    "play.google.com",
    "apps.apple.com",
    # Streaming
    "spotify.com",
    "podcasts.apple.com",
    "soundcloud.com",
    # Messaging
    "wa.me",
    "t.me",
    "telegram.org",
    # Other common noise
    "yelp.com",
    "bbb.org",
    "ratingagencies.com",
    "sec.report",
    "opencorporates.com",
}

# Legal / entity suffixes to strip before name-matching
_ENTITY_SUFFIXES = re.compile(
    r"\b(LLC|L\.L\.C|LP|L\.P|LLP|L\.L\.P|INC|INCORPORATED|CORP|CORPORATION|"
    r"LTD|LIMITED|CO|COMPANY|PLC|P\.L\.C|N\.A|N\.A\.|TRUST|FUND|GROUP|"
    r"MANAGEMENT|ADVISORS|ADVISERS|ADVISORY|INVESTMENTS|CAPITAL|PARTNERS|"
    r"ASSOCIATES|FINANCIAL|SERVICES|ASSET|SECURITIES|HOLDINGS|INTERNATIONAL)\b",
    re.IGNORECASE,
)

_PUNCT = re.compile(r"[^a-z0-9\s]")
_WS = re.compile(r"\s+")


def _normalize_name(name: str) -> set[str]:
    """
    Strip entity suffixes, punctuation, collapse whitespace.
    Returns a set of alpha-numeric tokens of length >= 3.
    """
    name = _ENTITY_SUFFIXES.sub(" ", name.upper())
    name = _PUNCT.sub(" ", name.lower())
    name = _WS.sub(" ", name).strip()
    return {t for t in name.split() if len(t) >= 3}


def _registered_domain(hostname: str) -> str:
    """
    Return the eTLD+1 portion of a hostname.
    Simple heuristic: last two dot-parts for .com/.net/.org/.io/etc.,
    last three for country-code second-level domains (.co.uk, .com.au, etc.).
    """
    parts = hostname.lower().lstrip("www.").split(".")
    # Country-code SLDs: co.uk, com.au, co.jp, etc.
    if len(parts) >= 3 and parts[-2] in ("co", "com", "net", "org", "gov", "edu") and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return hostname


def _is_skip(url: str) -> bool:
    """Return True if this URL belongs to a skip-listed domain."""
    try:
        hostname = urlparse(url).hostname or ""
    except Exception:
        return True  # unparseable → skip

    reg = _registered_domain(hostname)
    if reg in SKIP_DOMAINS:
        return True
    # Check if any skip domain is a suffix (catches subdomains)
    for skip in SKIP_DOMAINS:
        if hostname == skip or hostname.endswith("." + skip):
            return True
    return False


def _tokenize_other_websites(raw: str | None) -> list[str]:
    """
    Split other_websites string on commas or semicolons, return clean URL list.
    """
    if not raw:
        return []
    raw = str(raw).strip()
    # Try semicolons first; if that produces only 1 token, try commas
    if ";" in raw:
        parts = [p.strip() for p in raw.split(";")]
    else:
        parts = [p.strip() for p in raw.split(",")]
    return [p for p in parts if p.lower().startswith("http")]


def _domain_score(url: str, name_tokens: set[str]) -> int:
    """
    Score a URL for likelihood of being a first-party adviser site.
    Higher is better.

    Scoring:
      +10  name token appears in registered domain (brand match)
      +5   commercial TLD (.com, .net, .org, .io)
      -3   heavy subdomain (more than 1 level under registered domain)
      -5   URL has a path segment (e.g. /company/xxx → probably social profile)
    """
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        path = parsed.path or ""
    except Exception:
        return -99

    reg = _registered_domain(hostname)
    score = 0

    # Brand match: any name token in the registered domain
    if any(tok in reg for tok in name_tokens):
        score += 10

    # Commercial TLD bonus
    tld = reg.rsplit(".", 1)[-1] if "." in reg else ""
    if tld in ("com", "net", "org", "io", "co"):
        score += 5

    # Penalize paths (social profiles, deep pages)
    path_clean = path.strip("/")
    if path_clean:
        score -= 5

    # Penalize heavy subdomains (more nesting → less likely first-party root)
    subdomain_levels = len(hostname.replace("www.", "").split(".")) - len(reg.split("."))
    if subdomain_levels > 1:
        score -= 3

    return score


def pick_canonical_domain(
    adviser_name: str,
    primary_website: str | None,
    other_websites: str | list[str] | None,
) -> Optional[str]:
    """
    Return the best canonical first-party URL for this adviser, or None.

    Strategy:
    1. Collect all candidates: primary_website + other_websites (tokenized).
    2. Drop anything on the SKIP list.
    3. If any clean candidates remain, score them by brand-match + TLD quality.
    4. Return the highest-scoring URL. If all scores <= 0 and no brand match,
       return None (nothing looks first-party enough).
    """
    name_tokens = _normalize_name(adviser_name) if adviser_name else set()

    # Gather all URLs
    candidates: list[str] = []
    if primary_website and str(primary_website).lower().startswith("http"):
        candidates.append(primary_website.strip())

    if isinstance(other_websites, list):
        candidates.extend([u.strip() for u in other_websites if u])
    else:
        candidates.extend(_tokenize_other_websites(other_websites))

    # Filter skip list
    clean = [url for url in candidates if not _is_skip(url)]

    if not clean:
        return None

    # Score and rank
    scored = [(url, _domain_score(url, name_tokens)) for url in clean]
    scored.sort(key=lambda x: x[1], reverse=True)

    best_url, best_score = scored[0]

    # Require at least a minimal positive signal:
    # either a brand match (score >= 10) or a commercial TLD with no path (score >= 5)
    if best_score < 0:
        return None

    return best_url


# ---------------------------------------------------------------------------
# CLI / batch runner
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys, json, os, certifi
    os.environ["SSL_CERT_FILE"] = certifi.where()
    from supabase import create_client

    ADV_URL = "https://ezuqwwffjgfzymqxsctq.supabase.co"
    ADV_KEY = (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6"
        "InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzMyNjQ0MCwiZXhwIjoyMDc4OTAyNDQwfQ"
        ".Rq2lPQ1Uy_zTAPuY7VmEHA0I802vvEV9mm-br3M8aKM"
    )
    db = create_client(ADV_URL, ADV_KEY)

    # ---- Noisy CRD test set ----
    # Load from the pre-fetched sample (populated by fetch step)
    if len(sys.argv) > 1:
        sample_file = sys.argv[1]
    else:
        sample_file = "/tmp/poc3_noisy_sample.json"

    with open(sample_file) as f:
        all_rows = json.load(f)

    # Known zero-website CRDs from findings
    ZERO_WEBSITE_CRDS = {
        "106466", "107312", "111242", "131181", "284722", "288374",
        "307176", "315808", "316500", "330231", "330283", "330669",
        "334275", "334454", "337298", "337587", "339778",
    }

    # Separate noisy from zero-website
    noisy_rows = [r for r in all_rows if str(r["crd"]) not in ZERO_WEBSITE_CRDS]
    zero_rows = [r for r in all_rows if str(r["crd"]) in ZERO_WEBSITE_CRDS]

    print(f"Noisy rows: {len(noisy_rows)}, Zero-website control: {len(zero_rows)}")

    results = []
    for r in noisy_rows:
        crd = str(r["crd"])
        name = r.get("adviser_name") or ""
        primary = r.get("primary_website") or ""
        other = r.get("other_websites")
        picked = pick_canonical_domain(name, primary, other)
        results.append({
            "crd": crd,
            "adviser_name": name[:60],
            "primary_website": primary[:80],
            "other_websites_raw": str(other)[:120] if other else "",
            "picked_canonical": picked or "",
        })

    # Control: zero-website CRDs — should all return None
    control_results = []
    for r in zero_rows:
        crd = str(r["crd"])
        name = r.get("adviser_name") or ""
        primary = r.get("primary_website") or ""
        other = r.get("other_websites")
        picked = pick_canonical_domain(name, primary, other)
        control_results.append({
            "crd": crd,
            "name": name[:60],
            "primary": primary,
            "other": str(other)[:80] if other else "",
            "picked": picked or "None",
        })

    with open("/tmp/poc3_results.json", "w") as f:
        json.dump({"noisy": results, "control": control_results}, f, indent=2)
    print("Results saved to /tmp/poc3_results.json")
