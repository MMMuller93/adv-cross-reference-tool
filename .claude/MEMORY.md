# Project Memory — Private Funds Radar

> **Rule**: Read at session start. Update immediately on user feedback.
> **Archives**: Detailed session history and learnings in `.llm/archive/`. Verbose narrative for 2026-05-11 → 05-14 work lives in `PLAN_FUND_HOLDERS_INTEL.md` + `PLAN_NPORT_HOLDINGS.md`.

---

## DO NOT REPEAT (Critical Corrections)

### Process
- **NEVER say "done" without verifying production** — check: pushed → deployed → live tested
- **NEVER speculate about data without querying it** — if you haven't run a query, say "I don't know yet, let me check"
- **NEVER skip the dispatch pipeline** for non-trivial work
- **Spawn a witness/reviewer agent for non-trivial work** — separate one from the implementer. The witness in the 2026-05-11→14 session caught 6+ critical bugs the implementing agents called "verified". Self-validation is unreliable.
- **No arbitrary scope caps** (user direct quote: *"dont randomly limit to five fund families"*) — process all unless there's a concrete justification
- **No old-school month/quarter timelines** (user: *"dont randomly assign old school engineering team timelines"*) — phases are dependency order, not calendar

### Data & Schema
- **NEVER use OFFSET pagination** for large tables — use keyset `.gt('id', lastId)`
- **DO NOT use MCP Supabase tools for production databases** — MCP connects to legacy `cmhzafgyixdcnpvkldkg`, not ADV/Form D/N-PORT
- **DO NOT strip business descriptors** (capital, ventures, fund, partners, etc.) in name normalization — only strip legal suffixes (LLC/LP/Inc/Ltd)
- **DO NOT truncate LLM prompts** — quality degrades
- **DO NOT confuse CIK/CRD/SEC file number** — different identifier systems
- `cross_reference_matches` only contains MATCHED records — NULL queries return 0
- `sec_file_number` column DOES NOT EXIST in advisers_enriched
- ReferenceID = PFID (Private Fund ID), NOT adviser CRD
- exemption_2b1/2b2 have MIXED formats: 'Y', 'N', true, false, or null
- `advisers_enriched.cik` populated for only 13% (5,304/40k) — direct CIK joins fail at scale
- `advisers_enriched.primary_website` is **noisy** — Fidelity's primary returns a Plynk Instagram URL; real `fidelity.com` is in `other_websites`. Use a canonical-domain selector when extracting websites.
- `advisers_enriched` has **NO business address fields** — only phone, websites, CCO/regulatory/signatory contacts, owners. Address gap may matter for outreach.
- `advisers_enriched` has **NO PM bios** (ADV Part 2B has never been scraped)
- `linked_adviser_crd` in `form_d_filings` is a **dead column** (NULL for all 330k rows). Use `cross_reference_matches` instead.
- `fund_ncen_records` in N-PORT DB is essentially empty (41 rows as of 2026-05-15 — validation batch only). Without backfill, N-PORT→ADV bridge resolves only ~2.5% of registrants (40/1,589).

### Environment quirks
- **macOS Python 3.14 has broken pyexpat** (`Symbol not found: _XML_SetAllocTrackerActivationThreshold`) — use `uv venv` (Python 3.12)
- **macOS Postgres 17 initdb needs** `LC_ALL=C` + `--locale=C` — otherwise `postmaster became multithreaded during startup`
- **Anthropic API 529 Overloaded** is common at peak — fall back to writing code in main context, don't loop retries
- **Codex CLI on ChatGPT accounts**: gpt-5/5-codex/5.1 not authorized; gpt-5.5 works only with CLI ≥ 0.100.0
- **SEC bulk URL patterns vary by month** — `/files/adv-brochures-2024-december.zip` vs `/adv-brochures-2024-september.zip`; some months split into N parts. HEAD-check candidates, don't trust a single pattern.

---

## Four Supabase Databases

| Database | Project ID | Key Tables (verified live counts 2026-05-15) |
|----------|------------|----------------------------------------------|
| **ADV (PROD)** | `ezuqwwffjgfzymqxsctq` | `advisers_enriched` (40,916 / 54 cols), `funds_enriched` (185,525), `adviser_owners` |
| **Form D** | `ltdalxkhbbhmkimmogyq` | `form_d_filings` (~330k), `cross_reference_matches` (**72,558** — the bridge), `compliance_issues` (~150k), `enriched_managers` (3.4k), `external_investor_reference` (8k) |
| **N-PORT** | `figvonwrlcpveyceengf` | `nport_holdings` (315,872), `nport_filings` (57,407), `nport_registrants` (1,589 — only 40 with `adv_crd`), `nport_identifiers` (667,711), `private_companies` (843), `private_company_aliases` (924), `nport_company_positions_mv` (52,453), `fund_ncen_records` (**41 — needs backfill**), `fund_portfolio_managers` (0) |
| **MCP-Connected (legacy)** | `cmhzafgyixdcnpvkldkg` | `advisers_master_list`, `funds_master_list` — do not use |

### Credentials
**ADV (service role):** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzMyNjQ0MCwiZXhwIjoyMDc4OTAyNDQwfQ.Rq2lPQ1Uy_zTAPuY7VmEHA0I802vvEV9mm-br3M8aKM`
**Form D (anon):** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc`
**N-PORT:** at `/private/tmp/nport-buildout-claude/.env` as `SUPABASE_URL_NPORT` + `SUPABASE_SERVICE_KEY_NPORT` (gitignored, owner-read-only)

```python
# Python boilerplate (fixes SSL on macOS)
from supabase import create_client
import os, certifi
os.environ['SSL_CERT_FILE'] = certifi.where()
```

---

## Table ID Columns (for pagination)

| Table | ID Column | Has `id`? |
|-------|-----------|-----------|
| `advisers_enriched` | `crd` | NO |
| `funds_enriched` | `reference_id` | NO |
| `form_d_filings` | `id` | YES |

Batch limits: 1000 reads, 500 inserts.

---

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Main API server |
| `public/app.js` | Frontend React app |
| `detect_compliance_issues.js` | Compliance detection (6 types) |
| `enrichment/enrichment_engine_v2.js` | Manager enrichment pipeline (entry points: `enrichManager` line 1330, `enrichAndSaveManager` line 1951) |
| `data-pipeline/formd-scraper/` | Form D daily scraper |
| `nport/` (branch `nport-buildout-claude`) | N-PORT subsystem — 132 files, 180 tests, isolated from main PFR |

---

## User Preferences

- Prefers direct, concise responses
- Wants verification before claiming "done"
- Values context retention — gets frustrated when info is forgotten (*"i constantly give you a ton of good info and feedback, you remember it for like 4 min, and then it disappears"*)
- Wants evidence, not speculation
- Don't make UI styling decisions without asking
- Internal tool — *"dont worry any user features like accounts/paywall, this is for our use"*
- CSV-first output (*"csv fine for now, unless UI easy"*); weekly refresh cadence fine
- Branch isolation — new work goes on isolated branches/subfolders; don't touch existing PFR files unless explicitly approved
- Production: `https://privatefundsradar.com`
- GitHub: `https://github.com/MMMuller93/adv-cross-reference-tool`

---

## External dataset available: BrokerCheck (added 2026-04-22)

A local dataset of 626,366 active FINRA-registered brokers is available at `/Users/Miles/Desktop/VS backup/Baselin Claude with cockpit folder 4.20 copy/brokercheck_extract/data/brokercheck.sqlite`.

The firm CRD (`employments.firm_id`) joins directly to `advisers_enriched.crd` for dually-registered firms (verified). Read `BROKERCHECK_DATASET_REFERENCE.md` in this project root for integration patterns before doing work that involves broker data.

---

## Active project: Fund Holders Intelligence (added 2026-05-15)

**Goal:** Per private company (Anthropic, OpenAI, SpaceX, …), produce the full list of mutual funds (N-PORT) + private fund SPVs (Form D) holding shares, with firm name + CRD + AUM + website + named managers + contact paths.

**Handoff doc:** `PLAN_FUND_HOLDERS_INTEL.md` (read first — has 16 sections, full setup, decisions still open).

**Universe:** 153 target CRDs at `/private/tmp/adv-part2b-scraping/target_crds.json`. Top 10 by breadth: Fidelity (23 cos), BlackRock (13), Lincoln (13), T. Rowe (12), Brighthouse (12), Franklin (11), Capital Group (10), BlackRock Fund Advisors (9), SunAmerica (9), Voya (8).

**Branch:** `fund-holders-intel` (to be created off master). New subfolder `intelligence/`. Do NOT modify existing PFR files (`server.js`, `public/app.js`, etc.).

**Key gotchas to remember:**
- N-PORT→ADV bridge needs `fund_ncen_records` backfill (currently 41 rows; needs ~84k for full coverage). 4 of top-10 advisers (Fidelity, BlackRock, T. Rowe, Capital Group) already have N-CEN records from validation batch.
- ADV Part 2 scraping branch (`adv-part2b-scraping`) has witness-flagged bugs; **probably not needed for V1** — `advisers_enriched`'s 54 columns already cover most contact needs.
- Form D `cross_reference_matches` is the working bridge: `form_d_filings.accessionnumber → cross_reference_matches.formd_accession → adviser_entity_crd → advisers_enriched.crd`. Only 14/85 Anthropic-matched filings (16%) appear in `cross_reference_matches` — rest need other resolution.
- Cross-source aliases need `pattern_source` column (`nport_issuer` vs `formd_spv` vs `formd_codename`) — Codex flagged these need different rules.
- Materialize `company_formd_matches` table for performance (live ILIKE on 330k rows is slow). Add trigram index on `form_d_filings.entityname`.

**Witness pattern (from 2026-05-11→14 lessons):** spawn an independent witness agent on any non-trivial code. Self-validation missed 6+ real bugs last session.
