# ChatGPT Branch Investigation Findings
**Investigated:** 2026-05-15  
**Branch:** `codex/nport-stabilize` at `/Users/Miles/projects/PrivateFundsRadar-nport-stabilize`

## Branch State

- **Last commit:** `5157f7c` — "add nport seed loader and live preflight tooling" — 2026-05-11 18:03 (4 days ago, nothing in last 24h)
- **Working tree:** Clean. No uncommitted changes.
- **No background processes running** (confirmed via ps aux grep for ncen/nport/backfill/scrape)

## What ChatGPT Built (~10,500 LOC across 8 worktree branches, all merged into this branch 2026-05-11)

1. **N-PORT scraper** — bulk (26 quarters) + daily + IDENTIFIERS loader (`data-pipeline/nport-scraper/`)
2. **Entity resolver** — Python module matching N-PORT holdings to private companies (`data-pipeline/nport-scraper/resolver/`)
3. **Private company seed** — 843 companies + 924 aliases from Wikipedia/Wikidata/manual (`data-pipeline/private-companies/`)
4. **N-CEN parser + daily scraper** — `data-pipeline/ncen-ingest/` (parser + daily_ncen.py). Yields records for upsert but has NO live DB writes. Side-effect-free below the I/O boundary.
5. **N-1A PM extractor** — `data-pipeline/n1a-pm-extract/` (portfolio manager names/CRDs from N-1A filings)
6. **N-CSR enricher** — `data-pipeline/ncsr-enrich/`
7. **Position-delta detection** — `data-pipeline/nport-scraper/delta_detection/`
8. **API routes** (15 routes, `routes/nport.js`) + **frontend** (`public/nport_pages.js`, company/fund/admin pages)
9. **Schema migration** — `migrations/nport/001_create_schema.sql` defines `fund_ncen_records` table and 9 others

## N-CEN Backfill Status

**No N-CEN backfill is running or scheduled from this branch.**

- `daily_ncen.py` is a scraper that yields records but explicitly has no persistence layer ("Keep the scraper side-effect-free below the I/O boundary" — line 9 of daily_ncen.py)
- `.stub_writes.jsonl` is 0 bytes — no writes ever made
- No Supabase project for N-PORT exists yet per `project_state.md`: "No live N-PORT Supabase project is provisioned yet. No live DB writes have been performed."
- The `fund_ncen_records` table schema exists in a migration SQL file but has never been run against any live DB
- No cron job configured for ncen-ingest
- GitHub Actions workflows (`auto-enrich.yml`, `refresh-cross-reference.yml`) only target the ADV and Form D Supabase projects — no N-PORT project referenced

## Fund-Holders-Intel Work

**None.** Zero references to `fund_holders`, `fund-holders`, or `company_formd_matches` anywhere in the tree. No directories named `intelligence` or `intel` beyond the pre-existing `INTELLIGENCE_RADAR_IMPLEMENTATION.md` (which is the old compliance Intelligence Radar feature, unrelated). No `PLAN_FUND_HOLDERS*.md` or `*HOLDERS*.md` files.

## The 41 N-CEN Rows Inserted (~00:09 UTC 2026-05-15)

**Source is NOT this branch.** This branch has:
- No live DB credentials for any N-PORT Supabase project
- No upsert/insert code in the ncen-ingest pipeline
- A clean working tree with last activity 2026-05-11

The 41 rows must have come from a different source (a separate script, manual insertion, or another agent session with different credentials).

## Key Artifacts to Reuse (Don't Rebuild)

| Artifact | Path | What it provides |
|---|---|---|
| N-CEN parser | `data-pipeline/ncen-ingest/parser.py` | Full XML parser with 8 tests against real Fidelity/BlackRock/ARK/Vanguard fixtures |
| N-CEN daily scraper | `data-pipeline/ncen-ingest/daily_ncen.py` | EDGAR full-index walker, filters N-CEN/N-CEN/A, rate-limited |
| fund_ncen_records schema | `migrations/nport/001_create_schema.sql` line 315 | Table definition (cik, series_id, adviser_crd, subadviser_crd, etc.) |
| Entity resolver | `data-pipeline/nport-scraper/resolver/` | Matches holdings to private companies — 100% recall on Anthropic POC |
| Private company seed | `data-pipeline/private-companies/` | 843 companies, 924 aliases |
| API routes | `routes/nport.js` | 15 N-PORT routes ready to mount |
| Frontend pages | `public/nport_pages.js` | Company/Fund/Admin pages |

