# Private Company Reference Sources — Research Report
*Generated: 2026-05-11*

---

## Task A — What Is "Position.so"?

**Confirmed: the service is [position.so](https://position.so)** (not "positions.so").

Position.so is a private-market intelligence platform that tracks unicorn and high-growth private companies. The homepage publicly displays a ranked table of the largest unicorns by valuation (SpaceX $1.25T, OpenAI $852B, Anthropic $380B, etc.) with:
- Current valuation + 2-year change
- Headcount and YoY growth
- Share price history
- Funding rounds (type, amount, date, price per share)
- Investor lists
- Open roles count

Access is **freemium**: the ranked list is viewable without login, but filtering, deeper company pages, and presumably export/API require authentication. There is no public API documentation or CSV export visible in the unauthenticated view. The service competes with Caplight MarketPrice and PM Insights in the "private company pricing intelligence" niche.

**The user's mental model is correct** — position.so is exactly the kind of curated, curated-universe service that is used in secondary-market / VC-intelligence circles as a reference for "which private companies matter."

---

## Task B — Top Reference Sources Compared

| Source | Universe Size | Metadata Quality | Free Public List? | CSV/API? | License |
|--------|--------------|------------------|-------------------|----------|---------|
| **CB Insights Unicorn Tracker** | ~1,345 unicorns | Name, valuation, date joined, country, city, industry, select investors | Yes — full table visible; download requires form submit (email gate) | No API; form-gated CSV | Proprietary; "Research" attribution expected; no redistribution rights stated |
| **Crunchbase Unicorn List** | ~1,763 companies ($1B+) | Name, post-money valuation, total funding, lead investors, country | Yes — freely browsable; full data needs Pro ($99/mo) | API: Pro plan, $99/mo, 2K rows/month export | Proprietary; derivative DB not permitted without license |
| **position.so** | Unknown exact count (hundreds of tracked co's shown) | Valuation + 2yr change, headcount, funding rounds, share price, investors, open roles | Partial — ranked list visible unauthenticated | Not publicly documented; likely gated | Proprietary; no stated redistribution |
| **Forge Global** | ~200 priced companies; ~60 in Accuidity Index | Indicative price, funding rounds, last mark, sector | Browse UI is public; ~200 co's with pricing | No public API; no CSV export | Proprietary |
| **Caplight MarketPrice** | ~100 priced; data on 450+ | Price/share, valuation, bid/ask, fund marks, 15,000+ data points | Only 9 companies shown on marketing page without login | Enterprise API only; "Book a demo" | Proprietary; institutional license required |
| **Forbes Cloud 100** | 100 (annual) | Name, rank, sector | Yes — freely readable on forbes.com/cloud100 | No official CSV; third-party aggregation (readycontacts.com, TrueUp.io) | Copyrighted; list names themselves are not copyrightable |
| **Forbes AI 50** | 50 (annual) | Name, sector, funding, investors | Yes — freely readable on forbes.com/lists/ai50 | No official CSV | Copyrighted list, but company names are public facts |
| **Wikipedia Unicorn List** | 1,500+ (active) | Name, valuation, country, industry, founded, notable investors | Yes — fully public | Scrapable/downloadable; CC BY-SA license | CC BY-SA — derivative use permitted with attribution |
| **PitchBook Unicorn Tracker** | ~1,680 globally | Name, valuation, date, investors, geography | Marketing pages only; full data behind paywall | Paid enterprise; no free tier | Proprietary |
| **Kaggle "list-of-all-unicorns"** | Historical snapshot | Name, valuation, country, city, industry, founded, investors, funding | Freely downloadable CSV | CSV download, no API | Dataset-specific; typically CC or similar |

---

## Task C — Caplight Specifically

Caplight's public-facing data is extremely thin. The marketing page at `framer.caplight.com/marketprice` shows only **9 companies** (SpaceX, OpenAI, xAI, Anduril, CoreWeave, Scale AI, Figure AI, Ramp, Ripple) without login.

Key facts:
- Prices ~100 companies via their MarketPrice engine; has data on 450+ with marks
- 15,000+ transactional data points; $300B+ in volume
- No free tier; everything behind "Book a demo" / enterprise contract
- No public list of all tracked companies
- **Not usable as a seed list** without an enterprise agreement

The most useful Caplight URL for reference: `https://caplight.dev/companies` (returned 404 in testing — may require auth).

---

## Task D — Other Publicly-Published Lists

| List | URL | Year Updated | Count | Notes |
|------|-----|--------------|-------|-------|
| CB Insights Unicorn Tracker | cbinsights.com/research-unicorn-companies | Ongoing | ~1,345 | Email-gate download; most widely cited |
| Crunchbase Unicorn Board | news.crunchbase.com/unicorn-company-list/ | Ongoing | ~1,763 | Browsable free; export costs $49-99/mo |
| Wikipedia Unicorn List | en.wikipedia.org/wiki/List_of_unicorn_startup_companies | Community-maintained | 1,500+ | CC BY-SA — best license for derivative use |
| Forbes Cloud 100 | forbes.com/cloud100 | Annual (Aug/Sep) | 100 | Company names are public facts; freely scrapable |
| Forbes AI 50 | forbes.com/lists/ai50 | Annual | 50 | Same — scrapable, names are public |
| Failory US Unicorns | failory.com/startups/united-states-unicorns | 2026 | 818 (US) | Free sheet for top 100; rest browsable |
| Arête Unicorn Index | areteindex.com/unicorns | Ongoing | 1,700+ | Publicly browsable ranking |
| Kaggle unicorn dataset | kaggle.com/datasets/battle11king/list-of-all-unicorns | Historical | snapshot | Freely downloadable CSV |
| Tracxn Unicorn Tracker | tracxn.com/d/unicorns/unicorn-tracker | Ongoing | 2,014 | Sector/country filters; some free data |

---

## Recommendation

**Use the Wikipedia Unicorn List as the primary seed.** It is:
1. The only major source with an explicitly permissive license (CC BY-SA) that allows building a derivative database
2. Community-maintained with 1,500+ companies
3. Structured HTML table — trivially scrapable or available as Wikidata export
4. Includes name, valuation, country, industry, founded date, investors

**Layer on top:**
- **CB Insights list** (email-gate CSV) for 1,345 unicorns with clean industry classification and "date joined" — useful for temporal filtering
- **Forbes Cloud 100 + AI 50** company names as high-signal quality signals for the cloud/AI segments you'll see most in N-PORT private holdings — these 150 names are public facts and add no licensing burden
- **position.so** as a manually-referenced cross-check for the most actively traded companies (~200-300) but not suitable as an automated ingest source given its proprietary/gated nature

**Do not rely on** Crunchbase (expensive API, restrictive terms on derivatives), PitchBook (enterprise only), or Caplight (enterprise only) as seed sources.

