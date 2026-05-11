# Build Plan — N-PORT Private-Company Holdings Database

**Status:** V1 code complete on 8 unmerged worktree branches; verification green; nothing pushed; no live Supabase project yet.
**Owner:** Miles Muller (mmmuller93@gmail.com)
**Project:** Private Funds Radar (privatefundsradar.com)
**Last updated:** 2026-05-11

This doc is **self-contained**. A coding agent (human or AI) should be able to pick this up cold and either (a) review/merge what's already built or (b) extend it. Where research data is cited, raw findings live in `docs/nport_research/*.md` (preserved from the planning phase) and the worktree-built code lives on the branches listed in §0.5.

---

## 0.1 Build Status — what's done, what's not

### What's complete (8 worktree branches, ~10,500 LOC, ~161 pytest + 27 node:test + 3 Playwright tests, all green)

| Branch | Commit | Module | Spec section | Tests |
|---|---|---|---|---|
| `worktree-agent-a50e51b187889bb94` | `97dfe81` | Schema migrations + sanctioned seed | §4 | Postgres 17.9 verification (all FKs + cascades exercised) |
| `worktree-agent-afa15e66919225a12` | `7d5083c` | Entity resolver Python module | §5 | 42/42 pytest |
| `worktree-agent-aa16d7a52f53e8d7d` | `ccd06ec` | Private-company seed (Wikipedia + Wikidata + manual) | §6.7 | 22/22 pytest (843 companies + 924 aliases produced) |
| `worktree-agent-ac7a57a07c68d0380` | `4314919` | N-PORT scrapers (bulk + daily + IDENTIFIERS) | §6.1-6.3 | 17/17 pytest, dry-run validated against live SEC |
| `worktree-agent-a802ea18d013e227d` | `9c81c57` | N-CEN + N-1A PM + N-CSR parsers | §6.4-6.6 | 38/38 pytest, real PM names + CRDs extracted |
| `worktree-agent-a9422c266e3e49324` | `c007ea4` | Position-delta + repricing event detection | §6.8 | 15/15 pytest (SpaceX 2x event detected from fixture) |
| `worktree-agent-a1bec54bae5b2a959` | `e30b007` | API endpoints (15 routes) | §7 | 27/27 node:test |
| `worktree-agent-a2dfa08043b9cb627` | `b0d3195` | Frontend (Company + Fund + Admin pages) | §8 | 3 Playwright e2e on localhost:3019 |

All 8 branches are local to `.claude/worktrees/agent-*/` — **not pushed** to `master`, **not merged** to the active feature branch.

### Verification log

Before code was written, the plan itself was stress-tested via 4 parallel verification agents + 1 hands-on POC. Findings already integrated into this plan:
- All 26 quarterly N-PORT bulk URLs (2019 Q4 → 2026 Q1) HEAD-checked, all return 200. Total volume 10.27 GB compressed.
- NPORT-P + NPORT-P/A confirmed as form types in EDGAR `form.idx` (~13K/quarter)
- N-CEN XSD verified: `investmentAdviserCrdNo`, `subAdviserCrdNo` etc. exist as documented
- Filter F1 dropped 6/91 Anthropic rows due to inconsistent `IS_RESTRICTED` flag → switched to F4
- lxml vs xmltodict benchmarked: lxml is 8.5x faster, recommended for prod
- Wikipedia unicorn table has 823 rows (617 active + 206 exited), not 1500+; Wikidata SPARQL for unicorns returns wrong data — use wikitext API instead
- POC: §5 resolver tested against real 2026 Q1 data → 100% recall on Anthropic (91/91), 0 false positives. Validates the algorithm as-written.

### What's NOT done (intentional gaps for the next agent)

1. **Live Supabase project does not exist.** All worktree code writes to `./.stub_writes.jsonl` via abstracted `db_client.py`. Schema migration is a ready-to-run SQL file. **Next: provision Supabase project named `nport`, set env vars, run migration.**
2. **No branches pushed, no merges yet.** See §0.3 merge plan.
3. **No historical backfill run.** Daily scraper is ready; the 26-quarter bulk backfill is ~10 GB / hours of processing — must run after Supabase is live.
4. **No cron entries.** Mirror `data-pipeline/formd-scraper/` cron config.
5. **Form ADV Part 2B** (individual PM bios beyond the N-1A name) — intentionally out of V1.
6. **Some N-CSR fixtures are synthetic** (Fidelity, T. Rowe, Destiny) — built to match field values from `docs/nport_research/ncsr_findings.md`. Parsers should be re-validated against fresh real filings before production. ARK is the only fully-real fixture.

### Outstanding issues raised by build agents (worth addressing before merge)

- **Schema §4.1 has forward FK declaration order** in the plan doc; the migration file reorders correctly. The plan's SQL in §4.1 should match the migration.
- **MV indices are non-UNIQUE per the plan** → `REFRESH MATERIALIZED VIEW CONCURRENTLY` won't work. Add a unique index on `(holding_id_internal)` later or live with non-concurrent refresh.
- **No RLS policies** designed for the `nport` Supabase project. Decide once access shape is finalized.
- **Anthropic, Inc. → Anthropic PBC predecessor** naming in `manual_curated_seed.json` — verify corporate history before showing in UI.
- **Manual seed valuations** (Klarna $14.6B, Cerebras $4.25B, etc.) are best-known estimates — QA against position.so or fresh press before production.
- **nport_clusters.json ranks 21-50** carry plausible estimates not real numbers — should be regenerated from a real F4 scan of 2026 Q1 once Supabase is live.
- **Backport Gmail-app-password-from-env** to the existing Form D scraper (currently hardcoded). The new modules already read from env.

## 0.2 The product question (why this exists)

> "For Anthropic (or OpenAI, SpaceX, Databricks, Stripe, Epic Games, Fanatics, Zipline, …) — show me every registered mutual fund and ETF that holds a position. Show how many shares, at what mark, since when, in which series. Show the portfolio manager responsible. Show how the mark has moved quarter-over-quarter. Cross-link to Form D filings and Form ADV adviser records where overlap exists."

This third leg combines with ADV (already built — 40k advisers) and Form D (already built — 330k filings + daily scraper) so any single private company can be viewed across all three SEC filer universes. No competitor consolidates all three.

## 0.3 Merge plan (recommended order)

```
1. wt-schema           → foundation, zero shared-file changes
2. wt-resolver         → adds resolver/ subdir only
3. wt-seed-loader      → adds private-companies/ subdir; depends on schema upsert format
4. wt-nport-scrapers   → adds nport-scraper/ subdir + .gitignore (additive)
5. wt-adviser-ingest   → adds ncen-ingest/, n1a-pm-extract/, ncsr-enrich/, sec_filing_utils/
6. wt-delta-job        → adds delta_detection/ under nport-scraper (merge after #4)
7. wt-api              → modifies server.js + package.json (additive — adds `app.use('/api/nport', …)` + test script)
8. wt-frontend         → modifies server.js + public/app.js + public/index.html (additive)
```

Expected trivial 3-way conflict on `server.js` between #7 and #8 — both add a single `app.use(...)` line. Other shared-file changes are purely additive.

## 0.4 Next steps to take this live

```
1. Provision Supabase project `nport`. Get URL + service_role key.

2. Add to .env (alongside existing ADV/Form D credentials):
     SUPABASE_URL_NPORT=https://....supabase.co
     SUPABASE_SERVICE_KEY_NPORT=...
     GMAIL_APP_PASSWORD=...   # already in env if Form D scraper is running

3. Run schema migration:
     psql $DATABASE_URL_NPORT -f migrations/nport/001_create_schema.sql
     psql $DATABASE_URL_NPORT -f migrations/nport/002_seed_sanctioned.sql

4. Load curated seed:
     # Either write a 30-line loader or extend data-pipeline/private-companies/merge_and_emit.py
     # Upserts private_companies_seed.json + private_company_aliases_seed.json

5. Replace stub Supabase calls in data-pipeline/nport-scraper/db_client.py
   and data-pipeline/nport-scraper/delta_detection/db_client.py with live
   supabase-py calls (the _upsert_live method is already sketched in both)

6. First integration test on ONE quarter:
     python3 data-pipeline/nport-scraper/backfill_bulk.py --quarter 2026q1
   Expected: ~88 Anthropic rows resolved, ~13K filings + ~14K F4-passing
   holdings written. Verify against docs/nport_research/nport_bulk_findings.md.

7. Full historical backfill (~10 GB / hours):
     python3 data-pipeline/nport-scraper/backfill_bulk.py --start 2019q4 --end 2026q1

8. Wire daily scraper cron (mirror data-pipeline/formd-scraper/ entry):
     0 9 * * * cd /path/to/repo && python3 data-pipeline/nport-scraper/daily_scraper.py >> /var/log/nport_daily.log 2>&1

9. Smoke test the live frontend:
     https://privatefundsradar.com/company/anthropic
     # Should show 41 fund families, $2.6B exposure, top holders with PM names.
```

## 0.5 What a fresh coding agent needs to read

1. This file (`PLAN_NPORT_HOLDINGS.md`) — the full spec
2. `docs/nport_research/*.md` — all stress-test findings and POC results (committed)
3. `docs/nport_research/sample_xml/*.xml` — real NPORT-P and N-CEN sample filings (committed)
4. The 8 worktree branches listed in §0.1 — the built code
5. `CLAUDE.md` (project root) — conventions, DO-NOT-DOs, technical constraints
6. `data-pipeline/formd-scraper/daily_scraper_with_alerts.py` — the Python pattern being mirrored
7. `server.js` — the Express server being extended

Everything else (Wikipedia API responses, IDENTIFIERS.tsv schema, etc.) is summarized in the research docs above.

---

## 0. Why This Exists / What Success Looks Like

### The product question

> "For Anthropic (or OpenAI, SpaceX, Databricks, Stripe, Epic Games, Fanatics, Zipline, …) — show me every registered mutual fund and ETF that holds a position. Show how many shares, at what mark, since when, in which series. Show the portfolio manager responsible. Show how the mark has moved quarter-over-quarter. Cross-link to Form D filings and Form ADV adviser records where overlap exists."

### Why no one else has this consolidated

Three SEC filer universes are typically scraped in isolation:

| DB | Filer | Discloses | Bias |
|---|---|---|---|
| ADV (already built, 40k advisers + 185k Sched-D funds) | Registered investment advisers | Private fund AUM, structure, fees | VC, PE, hedge, family offices |
| Form D (already built, 330k filings + daily scraper) | Issuers of private offerings | Capital raises, exemptions, fund formation | New manager discovery |
| **N-PORT (this plan)** | **'40 Act registered funds** (mutual funds, ETFs, CEFs, interval funds) | **Position-level holdings, marks, % NAV** | **Crossover public-fund investors into private companies** |

The three are **disjoint filer populations** — N-PORT does NOT see VC/PE/family-office holdings, and ADV/Form D do not see mutual fund positions. The product moat is **the cross-source company view**: any single private company is shown across all three.

### Success criteria

1. Backfill every quarterly N-PORT release from 2019 Q4 → present, plus a daily EDGAR scraper for new NPORT-P filings.
2. Resolve ~1,900 distinct private-company entities in the data (real number — see §3.2) to a curated `private_companies` table with full alias coverage.
3. Roll up to a single denormalized company-positions view that powers a "who holds X?" company page.
4. Enrich with **acquisition cost + date** from N-CSR/N-CSRS shareholder reports.
5. Identify the **portfolio manager** for each fund × position from N-1A prospectus + N-CEN fund census, cross-linked to the existing ADV adviser DB by CRD.
6. Quarter-over-quarter delta detection for markups, markdowns, new entries, exits — emit email alerts for tracked-company changes.

There is no V1/V2/V3. The work is parallelizable; AI agents in worktrees build pieces simultaneously. Phasing is only used below to **express dependencies**, not timelines.

---

## 1. Data Sources — What We're Pulling From

### 1.1 Primary: SEC N-PORT bulk quarterly datasets

- **Index page:** https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets
- **URL pattern:** `https://www.sec.gov/files/dera/data/form-n-port-data-sets/{year}q{q}_nport.zip`
- **Coverage:** 2019 Q4 → current quarter. Each ZIP is filed 60-120 days after period end.
- **Size:** 2026 Q1 ZIP = 442 MB compressed / 1.6 GB uncompressed. Expect similar for each backfill quarter.
- **User-Agent header REQUIRED:** `User-Agent: Miles Muller mmmuller93@gmail.com`

**Files in the ZIP (32 total). Critical ones:**

| File | Size (2026 Q1) | Purpose |
|---|---|---|
| `FUND_REPORTED_HOLDING.tsv` | 938 MB / **5,941,068 rows** | Fact table: one row per position |
| `REGISTRANT.tsv` | small | Fund family metadata (CIK, name, address) |
| `FUND_REPORTED_INFO.tsv` | small | Series metadata, net assets, total assets |
| `SUBMISSION.tsv` | small | Submission metadata per accession |
| `IDENTIFIERS.tsv` | 282 MB / **7,160,000+ rows** | Vendor cross-reference codes (FIGI, LoanX, SEDOL, BlackRock IDs) |
| `DEBT_SECURITY.tsv` | 157 MB | Bond-specific fields (not needed for equity tracking) |
| `SECURITIES_LENDING.tsv` | 114 MB | Securities lending detail |
| 20+ derivative tables | varies | Swaps, futures, options — not needed for V1 |

**Join keys:**

```
FUND_REPORTED_HOLDING.ACCESSION_NUMBER → REGISTRANT.ACCESSION_NUMBER (NOT CIK)
FUND_REPORTED_HOLDING.ACCESSION_NUMBER → FUND_REPORTED_INFO.ACCESSION_NUMBER
FUND_REPORTED_HOLDING.HOLDING_ID       → IDENTIFIERS.HOLDING_ID
```

### 1.2 Primary: Daily EDGAR NPORT-P filings (live delta)

- **Index URL:** `https://www.sec.gov/Archives/edgar/full-index/{year}/QTR{q}/form.idx`
- **Per-filing payload:** `https://www.sec.gov/Archives/edgar/data/{cik}/{accession_nodashes}/primary_doc.xml`
- **XML schema:** `xmlns="http://www.sec.gov/edgar/nport"` — clean structured XML
- **Form types to watch:** `NPORT-P`, `NPORT-P/A` (amendments)
- **Lag:** Public filings appear ~60 days after period end. So daily scraping gives ~60-day-stale data, which is fresher than waiting for the quarterly bulk release.

**XML structure of `primary_doc.xml`:**

```xml
<edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <headerData>
    <submissionType>NPORT-P</submissionType>
    <filerInfo>
      <filer><issuerCredentials><cik>0001836057</cik></issuerCredentials></filer>
    </filerInfo>
  </headerData>
  <formData>
    <genInfo>
      <regName>BlackRock Technology and Private Equity Term Trust</regName>
      <regCik>0001836057</regCik>
      <regLei>549300G3XFQ7175KM723</regLei>
      <seriesName>...</seriesName>
      <seriesLei>...</seriesLei>
      <repPdEnd>2025-12-31</repPdEnd>
      <repPdDate>2025-09-30</repPdDate>
    </genInfo>
    <fundInfo>
      <totAssets>933067238.86</totAssets>
      <netAssets>914944885.68</netAssets>
      <!-- borrowers, returns, etc -->
    </fundInfo>
    <!-- Holdings: -->
    <invstOrSec>
      <name>ANTHROPIC PBC</name>
      <lei>N/A</lei>
      <title>ANTHROPIC PBC</title>
      <cusip>000000000</cusip>
      <identifiers>
        <other otherDesc="BlackRock Identifier" value="BYDP5QT36"/>
      </identifiers>
      <balance>120595.00000000</balance>
      <units>NS</units>
      <curCd>USD</curCd>
      <valUSD>17000277.15000000</valUSD>
      <pctVal>1.858065706041</pctVal>
      <payoffProfile>Long</payoffProfile>
      <assetCat>EC</assetCat>
      <issuerCat>CORP</issuerCat>
      <invCountry>US</invCountry>
      <isRestrictedSec>Y</isRestrictedSec>
      <fairValLevel>3</fairValLevel>
    </invstOrSec>
    <!-- many more invstOrSec elements -->
  </formData>
</edgarSubmission>
```

The XML element names map 1:1 onto the bulk TSV columns. Same data, different format.

### 1.3 Secondary: Form N-CSR / N-CSRS (enrichment — acquisition cost + date)

- **Filed:** Annually (N-CSR) and semi-annually (N-CSRS), 50-70 days after fund's fiscal period end
- **Universe:** ~30-50 fund families file these with private-company holdings; ~700 N-CSR/N-CSRS per year mention "restricted securities + private placement"
- **Format:** Inconsistent HTML — at least four structurally different schemas observed in 5 filers:

| Filer | Format | Example acquisition data |
|---|---|---|
| **ARK Venture** | Clean HTML table | `Anthropic, Inc., Series C-1* (a)(b) 3/31/23 89,078 1,049,998 2,672,340` (columns: Name, Footnotes, Acq Date, Shares, Cost, Value) |
| **Fidelity** (Contrafund etc.) | Absolute-position HTML (PDF→HTML); separate Restricted Securities footnote table | Main SOI lacks cost; restricted table has `Anthropic PBC Series E  2/14/2025  $835,689` |
| **T. Rowe Price** | Absolute-position HTML, inline free-text | `Anthropic, Series F-1, Acquisition Date: 8/29/25, Cost $38,695 (1)(2)(3) 274,498 69,840` |
| **Destiny Tech100** | HTML + iXBRL tags | iXBRL `<ix:nonFraction>` elements carry structured numeric data |
| **Fundrise** | Absolute-position HTML, no cost data | (cost/date not disclosed) |

**Parser strategy:** Regex-based parsers for ARK, Destiny iXBRL. LLM extraction for Fidelity (absolute-position with separate tables), T. Rowe (inline free-text), and the long tail. Don't write a custom parser per filer — write a regex parser for the easy cases and let an LLM handle the rest.

### 1.4 Secondary: Form N-1A / N-2 (portfolio manager identity)

- **N-1A:** Mutual fund / ETF prospectus + SAI. Form variants: `N-1A`, `485APOS`, `485BPOS`
- **N-2:** Closed-end + interval fund prospectus. Form variants: `N-2`, `N-2/A`
- **Filed:** Annual updates + as-needed amendments

**Real PM names extracted from sample filings** (use these to verify your extractor):

| Fund | CIK | Filing accession | Portfolio Manager(s) |
|---|---|---|---|
| Fidelity Contrafund | 0000024238 | 0000024238-26-000028 (485BPOS, 2026-02-24) | William Danoff (Co-PM since 2012, retiring Dec 2026); Matthew Drukker (Co-PM since 2025); Nidhi Gupta (Co-PM since 2025) |
| T. Rowe Price Global Technology | 0001116626 | 0001999371-26-004107 (485BPOS, 2026-02-25) | Dom Rizzo (sole PM since 2023, co-PM since 2022) |
| ARK Venture Fund | 0001905088 | 0001104659-22-086787 (N-2/A, 2022-08-08) | Catherine D. Wood (CIO) |
| Destiny Tech100 (DXYZ) | 0001843974 | 0001575872-25-000447 (N-2/A, 2025-07-10) | Sohail Prasad (President & CEO; identity in corporate ownership prose, not labeled "PM") |
| Baron Partners | (within Baron Select Funds) | 0001193125-26-195805 (485BPOS, 2026-04-30) | Ronald Baron (Lead PM since 1992/2003); Michael Baron (co-manager since Aug 2018) |

**Parser difficulty by filer:** Fidelity / T. Rowe / Baron — regex-parseable (look for `Name (Role) has managed the fund since YEAR` patterns + structured tables). ARK — prose paragraph, medium. DXYZ + other N-2 filers — LLM extraction required.

The N-1A doc itself is 4-14 MB of HTML per filing. Fund-management section is small fraction. Extract it first by section heading, then parse.

### 1.5 Secondary: Form N-CEN (annual fund census — structured XBRL)

- **Filed:** Annually, within 75 days of fund's fiscal year end
- **Form type:** `N-CEN`
- **Format:** Structured XML/XBRL — **machine-readable, no parser ambiguity**
- **What it gives us:**
  ```xml
  <investmentAdviserCrdNo>108281</investmentAdviserCrdNo>
  <subAdviserCrdNo>...</subAdviserCrdNo>
  <subAdviserLei>...</subAdviserLei>
  ```
- **What it does NOT give us:** portfolio manager names. Those are only in N-1A.

**Use N-CEN as the primary source for the (fund CIK → adviser CRD → subadviser CRD) graph.** Then cross-link `adviser_crd` to the existing `advisers_enriched.crd` column in the ADV DB — instant adviser context for every N-PORT fund.

### 1.6 Tertiary: Form ADV Part 2B — individual PM bios

- **Where:** Brochure supplement filed by each adviser, available via IAPD or EDGAR
- **What:** Education, prior employers + dates, certifications, individual contact paths
- **Use:** Bridge from "PM name from N-1A" to "PM identity for outreach" (already have this data partially via existing enrichment engine)

### 1.7 Reference: Private-company seed list

The user referred to **position.so** — confirmed: it's a freemium private-market intelligence platform showing rankings, valuations, headcount growth, funding rounds, investors for ~1,000+ unicorns. No public API, gated CSV export. Useful for manual cross-reference but not automated ingest.

**Seed strategy for the `private_companies` table:**

1. **Wikipedia "List of unicorn startup companies"** (CC BY-SA license — only source legally redistributable). ~1,500+ companies, includes funding round metadata. Scrape as structured HTML or query Wikidata via SPARQL.
2. **CB Insights Unicorn Tracker** (`cbinsights.com/research-unicorn-companies`) — email-gated list of ~1,345 unicorns with clean sector taxonomy and "date joined unicorn" timestamps.
3. **Forbes Cloud 100 + AI 50** — small high-signal lists for sector tagging.
4. **Our own N-PORT enumeration** — 1,909 entity clusters from the strict private-equity filter, already a tractable list (see §3.2).

Use Wikipedia as the legally clean seed, augment with N-PORT-discovered entities for ones Wikipedia misses (it does), and use position.so manually for sanity-checks of secondary-market trading interest.

---

## 2. Existing Repo — What to Reuse

### 2.1 Form D daily scraper pattern (copy this almost verbatim)

**File:** `data-pipeline/formd-scraper/daily_scraper_with_alerts.py`

Pattern to mirror for the N-PORT daily scraper:

```python
class DailyFormDScraperWithAlerts:
    def __init__(self, user_agent="Miles mmmuller93@gmail.com"):
        self.index_base = "https://www.sec.gov/Archives/edgar/full-index"
        self.headers = {'User-Agent': user_agent}
        self.rate_limit = 0.11  # SEC limits to 10 req/s
        self.supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

    def download_index_file(self, year, quarter):
        url = f"{self.index_base}/{year}/QTR{quarter}/form.idx"
        time.sleep(self.rate_limit)
        return requests.get(url, headers=self.headers, timeout=30).text

    def parse_index_file(self, content, days_back=7):
        # filter form_type in ['D', 'D/A']  ← swap for ['NPORT-P', 'NPORT-P/A']
        ...
```

The N-PORT scraper is the same skeleton with:
- Form type filter: `D, D/A` → `NPORT-P, NPORT-P/A`
- Per-filing URL: fetch `primary_doc.xml`, parse via the NPORT XML schema (§1.2)
- Output: `nport_filings` + `nport_holdings` (see §4)
- Email alerts: same SMTP setup, alert on new tracked-company positions, large position changes, new fund families discovered

Reuse: rate limit, User-Agent, durable failed-row capture (`daily_failed_rows.jsonl`), service-key Supabase client, .env loader.

### 2.2 Entity normalization pattern (`normalize_name_for_match`)

Lives in the existing codebase (see CLAUDE.md §"Name Matching"). Steps: uppercase → strip punctuation → collapse whitespace → strip legal suffixes. Reuse for N-PORT issuer name normalization, with two new additions specific to N-PORT (see §3.1):
1. Strip vendor annotations: ` PP`, ` PC`, ` CVT PFD`, `(PHYSICAL)`, `(NOT LISTED OR TRADING)`
2. Standardize series labels: `SER B` → `Series B`, `CL F-1` → `Class F-1`

### 2.3 External investor reference pattern

`external_investor_reference` table in the Form D DB shows the pattern for curated alias lookup. Mirror this for `private_company_aliases` (see §4).

### 2.4 Supabase keyset pagination + 500-row batched upsert

Already documented in CLAUDE.md as the standard. Same pattern applies to all N-PORT ingestion.

### 2.5 Existing API server pattern

`server.js` is Node/Express with Supabase client. Add N-PORT endpoints alongside existing `/api/funds/*` and `/api/advisers/*`. Cross-database joins happen in the API layer (the new N-PORT Supabase project is separate from ADV and Form D — see §4.1).

### 2.6 React frontend

`public/app.js` is the React app. Add a Company page route `/company/:slug` and Fund page route `/fund/:cik/:series`.

---

## 3. The Data — Real Numbers and Concrete Findings

All numbers below are from running the actual 2026 Q1 N-PORT bulk dataset (5,941,068 rows) and 2025 Q4 dataset, plus pulling real N-1A/N-CSR/N-CEN filings. Source agents and findings files referenced.

### 3.1 The entity-resolution problem (this is the hard part)

**Anthropic appears under 15 distinct ISSUER_TITLE strings in 2026 Q1 alone:**

```
'ANTHROPIC PBC'                       'Anthropic PBC'
'ANTHROPIC'                           'Anthropic, Inc.'
'ANTHROPIC PBC SER B PC PP'           'Anthropic PBC, Series F'
'ANTHROPIC PBC SERIES D PC PP'        'Anthropic PBC, Series F1'
'ANTHROPIC PBC SERIES E PC PP'        'Anthropic PBC, Series G-1'
'ANTHROPIC PBC SERIES F PC PP'        'ANTHROPIC, PBC SERIES E-1 PREFERRED STOCK'
'ANTHROPIC PBC SERIES G PC PP'        'ANTHROPIC PBC CL F-1 PFD PP (PHYSICAL) (NOT LISTED OR TRADING)'
'ANTHROPIC PBC SER F-1 CVT PFD PP'
```

No CUSIP. No LEI. No ticker. Pure text matching.

**SPV unwrapping — OpenAI / SpaceX are the worst offenders:**

```
"DXYZ OAI I LLC (economic exposure to OpenAI Global LLC, Profit Participation Units)"
"AESTAS LLC dba OPENAI LLC EV UNITS Class A"
"Celadon Technology Fund VIII, LLC - Series B (economic exposure to Space Exploration Technologies Corp., Common Stock)"
"SPV EXPOSURE TO SPACEX LLC"
"MWAM VC SpaceX-II, LLC"
"G Squared Special Situations Fund, LLC - Series H-1 (invested in Brex, Inc.)"
"Artist Edge Partners IV, LP (invested in Discord, Inc. Common Stock)"
```

**The `(economic exposure to X)` and `(invested in X)` parenthetical patterns are regex-extractable** — use these as primary SPV unwrappers. Fully obscured SPVs (e.g., "MWAM VC SpaceX-II, LLC" with no parenthetical) require the curated alias table.

**False-positive matches discovered during research (do NOT match on naive substring):**

| Wrong company | Real entity matching | Why |
|---|---|---|
| Canva | "Under Canvas Inc" (glamping company) | substring `canva` matches `Canvas` |
| Stripe | "Pinstripes Holdings" (entertainment) | substring `stripe` |
| Stripe | "Stripes VI Rainier" (PE continuation fund) | substring `stripe` |
| Scale AI | "Anyscale Inc" | substring `scale` |
| Revolut | "Revolution Medicines", "Carbon Revolution PLC" | substring `revolut` |
| Recursion | "Recursion Pharmaceuticals" (public) | direct match but public, exclude |

**Use prefix/word-boundary matching + exclusion lists, never raw `LIKE %name%`.**

### 3.2 Tracked private companies — real distribution

**Strict 5-way AND filter** (`IS_RESTRICTED_SECURITY='Y' AND FAIR_VALUE_LEVEL='3' AND ASSET_CAT IN ('EC','EP') AND ISSUER_TYPE='CORP' AND CUSIP NULL/zero/N/A`) yields **6,383 rows clustering into 1,909 normalized entities** in 2026 Q1.

**Top 20 by distinct-filer count** (each filer = a fund × period filing). These should be the V1 curated alias table:

| Rank | Entity | Distinct Filers | Total $ (filtered set) |
|---|---|---|---|
| 1 | Databricks | 68 | $2.37B |
| 2 | Anthropic | 52 | $1.69B |
| 3 | Canva (Canva Australia parent) | 43 | $856.9M |
| 3 | SpaceX (Space Exploration Tech) | 43 | $20.16B |
| 5 | Epic Games | 43 | $623.6M |
| 6 | xAI | 37 | $2.59B |
| 7 | Douyin (ByteDance subsidiary) | 36 | $880.1M |
| 8 | OpenAI | 36 | $814.4M |
| 9 | Anduril | 33 | $413.0M |
| 10 | Stripe | 22 | $879.3M |
| 11 | Zipline (autonomous delivery) | 20 | $658M |
| 12 | iCapital (alt-investments wealthtech) | 18 | $264M |
| 13 | Revolut (genuine) | 18 | $232M |
| 14 | Skyryse (autonomous aviation) | 18 | $125M |
| 15 | Oura Health | 17 | $600M |
| 16 | Physical Intelligence (robotics) | 16 | $60M |
| 17 | Sila Nano (battery materials) | 15 | $65M |
| 18 | Kardigan Inc | 15 | $52M |
| 19 | Juul Labs | 14 | $291M |
| 20 | Diamond Foundry (lab diamonds) | 13 | $188M |

**Largest by USD value (2026 Q1):**
SpaceX $20.2B • xAI $2.6B • Databricks $2.4B • Anthropic $1.7B • Fanatics $1.1B • ByteDance Series E $981M • Douyin $880M • Stripe $879M • Canva $857M • OpenAI $814M • Epic Games $624M • Oura $600M • Zipline $658M

**Coverage gaps confirmed (zero N-PORT presence):**
- Scale AI — never raised from mutual/VA funds
- Notion — consumer SaaS, no institutional public-fund presence
- Carta — 2 rows, $3.2M (effectively absent)
- Discord — only 22 rows ($47M), mostly via SPVs

These companies must be tracked via Form D / ADV signals, not N-PORT.

**Russian sanctioned securities pollute rankings** — Sberbank, Lukoil, Polyus, Norilsk Nickel, Gazprom, Novatek, Evraz, etc. score high on filer count (15-30 filers each) but are at zero book value since 2022. **Add an explicit exclusion list** for sanctioned securities — they're noise.

### 3.3 Quarter-over-quarter dynamics (the markup signal)

Comparing 2025 Q4 → 2026 Q1:
- **88.4% fund-family persistence** (372 of 421 fund-family positions persisted unchanged in identity)
- Total private AUM across 10 tracked companies: $24.92B → $40.70B (+63.3%)
- **246 pure markup events vs 7 pure markdowns** — 35:1 upside ratio in this period

**SpaceX exact-2x repricing event:** Common shares went from $212 → $421 per share, and preferred from $2,120 → $4,210, applied **simultaneously by every holder** (Fidelity, Baron, T. Rowe, Coatue, The Private Shares Fund). This single repricing event accounted for $8.92B of the $15.78B quarterly total. **A repricing event signal — "all holders moved on the same date" — is a real product feature.**

**xAI equity +106.4% markup** while xAI loans traded sideways at $0.97-1.05/par — same company, very different signals depending on the position type. This justifies the `exposure_type` schema column (§4).

### 3.4 IDENTIFIERS.tsv coverage (entity resolution helper)

The IDENTIFIERS table has 7.16M rows joining to FUND_REPORTED_HOLDING by `HOLDING_ID`. Field distribution:
- **82% of `OTHER_IDENTIFIER` rows are filer-internal codes** (`USER DEFINED`, `Internal`, `Inhouse Asset ID`) — useless for cross-filer resolution.
- **177K SEDOL rows** — mostly non-US public equities, not useful for US private companies.
- **~14K Bloomberg/BBGID/FIGI rows** — useful for institutional filers (Fidelity, T. Rowe, Capital Group) but covers <10% of private-equity rows overall.
- **5.4K LoanX ID rows** (Markit syndicated-loan identifiers) — **very high value for credit positions** (xAI loans, Databricks term loans). Every CLO holding the same loan shares the same LoanX ID.
- **6.5K BlackRock Identifier rows** — BlackRock-specific, can resolve their own positions only.

**Decision: ingest IDENTIFIERS as a supporting join table, NOT a primary resolution path.** Use LoanX ID as the primary resolution key for loan positions (covers 60-80%). Use BBGID/FIGI as a secondary signal for equity (covers 10-25% but where it works it's authoritative). Curated alias table (§4) remains the backbone.

---

## 4. Schema (Single Pass — Build All Tables Together)

Use a **third dedicated Supabase project** named `nport`. Reasons: different schema cadence than ADV/Form D, different RLS profile, project-segregation already the established pattern. **Do not co-mingle with ADV or Form D.** Cross-DB joins happen in the Node API server (existing pattern).

### 4.1 Tables

```sql
-- =========================================================
-- Core fact table — one row per (filer × period × position)
-- =========================================================
CREATE TABLE nport_holdings (
  id                        bigserial PRIMARY KEY,
  accession_number          text NOT NULL,
  holding_id                text NOT NULL,

  -- Raw fields, verbatim from FUND_REPORTED_HOLDING.tsv
  issuer_name               text NOT NULL,
  issuer_title              text,
  issuer_lei                text,
  issuer_cusip              text,
  balance                   numeric(28,8),
  unit                      text,                 -- NS=number of shares, PA=principal amount
  other_unit_desc           text,
  currency_code             text,
  currency_value_usd        numeric(20,4),        -- already converted to USD by SEC
  exchange_rate             numeric(20,8),
  pct_of_nav                numeric(12,8),
  payoff_profile            text,                 -- Long, Short, N/A
  asset_cat                 text,                 -- EC, EP, LON, DBT, DE, OTHER
  other_asset               text,
  issuer_type               text,                 -- CORP, RF, ABS, OTHER
  other_issuer              text,
  investment_country        text,
  is_restricted_security    boolean,
  fair_value_level          smallint,             -- 1, 2, 3
  derivative_cat            text,

  -- Resolution (materialized at ingestion)
  resolved_company_id       uuid REFERENCES private_companies(id),
  resolution_source         text,                 -- 'alias'|'loanx'|'bbgid'|'lei'|'manual'|'unresolved'
  resolution_confidence     smallint,             -- 0-100
  exposure_type             text,                 -- 'direct'|'spv'|'feeder'|'derivative'|'credit'
  underlier_issuer_name     text,                 -- when SPV/feeder, the parsed underlier
  share_class_normalized    text,                 -- 'Series F-1', 'Common', 'Class A', 'unspecified'

  -- Trace
  source_bulk_quarter       text,                 -- '2026Q1' | 'daily-scrape' for traceability
  ingested_at               timestamptz NOT NULL DEFAULT now(),

  UNIQUE (accession_number, holding_id)
);

CREATE INDEX ix_nport_holdings_accession      ON nport_holdings (accession_number);
CREATE INDEX ix_nport_holdings_resolved       ON nport_holdings (resolved_company_id, fair_value_level)
  WHERE resolved_company_id IS NOT NULL;
CREATE INDEX ix_nport_holdings_unresolved     ON nport_holdings (issuer_name)
  WHERE resolution_source = 'unresolved' OR resolution_source IS NULL;
CREATE INDEX ix_nport_holdings_text_search    ON nport_holdings
  USING gin (to_tsvector('simple', coalesce(issuer_name,'') || ' ' || coalesce(issuer_title,'')));
CREATE INDEX ix_nport_holdings_loanx_lookup   ON nport_holdings (issuer_lei) WHERE issuer_lei IS NOT NULL AND issuer_lei != 'N/A';


-- =========================================================
-- Filing metadata — one row per accession
-- =========================================================
CREATE TABLE nport_filings (
  accession_number          text PRIMARY KEY,
  cik                       text NOT NULL,
  registrant_id             uuid REFERENCES nport_registrants(id),

  -- From genInfo
  registrant_name           text NOT NULL,
  registrant_lei            text,
  series_id                 text,                 -- SEC series ID like S000012345
  series_name               text,
  series_lei                text,
  report_period_end         date NOT NULL,        -- repPdEnd
  report_period_date        date NOT NULL,        -- repPdDate (month within quarter)
  is_amendment              boolean NOT NULL DEFAULT false,
  is_final_filing           boolean NOT NULL DEFAULT false,
  filing_date               date NOT NULL,

  -- From fundInfo
  net_assets_usd            numeric(20,4),
  total_assets_usd          numeric(20,4),

  -- Classification (computed)
  fund_type                 text,                 -- 'open_end'|'etf'|'closed_end'|'interval'|'tender_offer'|'unknown'
  is_interval_fund          boolean DEFAULT false,
  is_variable_insurance     boolean DEFAULT false,
  parent_registrant_id      uuid,                 -- for VA sub-accounts that mirror underlying

  -- Trace
  source_bulk_quarter       text,
  source_url                text,                 -- EDGAR primary_doc.xml URL
  ingested_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_nport_filings_cik          ON nport_filings (cik);
CREATE INDEX ix_nport_filings_period       ON nport_filings (report_period_end);
CREATE INDEX ix_nport_filings_fund_type    ON nport_filings (fund_type) WHERE is_interval_fund OR fund_type IN ('closed_end','interval');


-- =========================================================
-- Fund family / registrant metadata
-- =========================================================
CREATE TABLE nport_registrants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cik                 text UNIQUE NOT NULL,
  name                text NOT NULL,
  lei                 text,
  address_street1     text,
  address_street2     text,
  address_city        text,
  address_state       text,
  address_zip         text,
  address_country     text,
  phone               text,

  -- Cross-link to ADV adviser DB
  adv_crd             text,                       -- nullable; FK-by-value to advisers_enriched.crd
  adv_crd_match_confidence smallint,              -- 0-100; how confidently matched
  adv_crd_match_method text,                      -- 'cik_in_adv'|'ncen_xref'|'name_fuzzy'|'manual'

  first_seen_at       timestamptz DEFAULT now(),
  last_filed_at       date
);

CREATE INDEX ix_nport_registrants_adv      ON nport_registrants (adv_crd) WHERE adv_crd IS NOT NULL;


-- =========================================================
-- Curated private-company entity table
-- =========================================================
CREATE TABLE private_companies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text UNIQUE NOT NULL,      -- 'anthropic', 'openai', 'spacex'
  display_name         text NOT NULL,             -- 'Anthropic', 'OpenAI', 'SpaceX'
  primary_domain       text,                      -- 'anthropic.com'
  sector               text,                      -- 'ai_ml' | 'space_defense' | 'fintech' | 'biotech' | 'consumer' | 'mobility' | 'other'
  description          text,
  founded_year         smallint,
  hq_country           text,
  hq_state             text,

  -- Legal entity registry — one company can have multiple legal entities (parent, sub, PBC, LLC)
  legal_entities       jsonb,                     -- [{name, jurisdiction, role: 'parent'|'sub'|'pbc'|'llc', start_date, end_date}]

  -- Round history (manually curated or scraped from Wikipedia/CB Insights/Forge)
  most_recent_round    text,                      -- 'Series F'
  most_recent_round_date date,
  latest_known_valuation_usd numeric(20,4),
  latest_known_valuation_date date,
  total_funding_usd    numeric(20,4),

  -- Seed source attribution
  seed_source          text,                      -- 'wikipedia'|'nport_discovery'|'manual'|'cbinsights'

  is_sanctioned        boolean DEFAULT false,     -- exclude Russian etc. from rankings
  is_public            boolean DEFAULT false,     -- flag if it IPO'd (e.g. Rivian)
  ipo_date             date,                      -- if public
  is_acquired          boolean DEFAULT false,     -- e.g. Wiz acquired by Google
  acquired_by          text,                      -- acquirer name
  acquired_date        date,                      -- when N-PORT rows disappear
  lifecycle_status     text,                      -- 'private'|'public'|'acquired'|'defunct'

  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE INDEX ix_private_companies_sector  ON private_companies (sector);
CREATE INDEX ix_private_companies_active  ON private_companies (is_sanctioned, is_public, is_acquired)
  WHERE NOT is_sanctioned AND NOT is_public AND NOT is_acquired;


-- =========================================================
-- Alias patterns for entity resolution
-- =========================================================
CREATE TABLE private_company_aliases (
  id                bigserial PRIMARY KEY,
  company_id        uuid NOT NULL REFERENCES private_companies(id) ON DELETE CASCADE,
  pattern_type      text NOT NULL,                -- 'exact_normalized'|'prefix'|'contains'|'regex'|'vendor_code'
  pattern           text NOT NULL,
  exposure_type     text NOT NULL DEFAULT 'direct', -- if this alias represents an SPV, set 'spv'
  underlier_only    boolean DEFAULT false,        -- when pattern matches an SPV that wraps the company
  vendor_code_type  text,                         -- 'BlackRock'|'BBGID'|'FIGI'|'LoanX'|'LEI' if pattern_type='vendor_code'
  notes             text,
  source            text,                         -- 'manual'|'auto_cluster'|'ncen_match'
  confidence        smallint DEFAULT 100,
  created_at        timestamptz DEFAULT now(),

  UNIQUE (company_id, pattern_type, pattern)
);

CREATE INDEX ix_aliases_pattern      ON private_company_aliases (pattern_type, pattern);
CREATE INDEX ix_aliases_company      ON private_company_aliases (company_id);


-- =========================================================
-- Sanctioned-securities exclusion list
-- =========================================================
CREATE TABLE sanctioned_securities (
  id                 bigserial PRIMARY KEY,
  pattern            text NOT NULL,
  reason             text,                        -- 'OFAC Russia 2022', etc.
  added_at           timestamptz DEFAULT now()
);
-- Seed: SBERBANK, LUKOIL, POLYUS, NORILSK, GAZPROM, NOVATEK, EVRAZ, NOVOLIPETSK, TATNEFT, SURGUTNEFTEGAS, ROSNEFT, MAGNIT, etc.


-- =========================================================
-- IDENTIFIERS.tsv — vendor cross-reference table
-- =========================================================
CREATE TABLE nport_identifiers (
  id                bigserial PRIMARY KEY,
  holding_id        text NOT NULL,
  identifiers_id    text,                         -- from IDENTIFIERS.IDENTIFIERS_ID
  isin              text,
  ticker            text,
  other_identifier  text,
  other_id_desc     text,                         -- 'BlackRock Identifier'|'LoanX ID'|'BBGID'|...

  source_bulk_quarter text,
  UNIQUE (holding_id, identifiers_id)
);

CREATE INDEX ix_nport_id_holding     ON nport_identifiers (holding_id);
CREATE INDEX ix_nport_id_loanx       ON nport_identifiers (other_identifier) WHERE other_id_desc = 'LoanX ID';
CREATE INDEX ix_nport_id_bbgid       ON nport_identifiers (other_identifier)
  WHERE other_id_desc IN ('BBGID','ID_BB_GLOBAL','Bloomberg Identifier','Bloomberg');


-- =========================================================
-- N-CSR enrichment — acquisition cost / date / methodology
-- =========================================================
CREATE TABLE nport_holdings_ncsr (
  id                       bigserial PRIMARY KEY,
  holding_id_ref           bigint REFERENCES nport_holdings(id) ON DELETE CASCADE,
  acquisition_date         date,
  acquisition_cost_usd     numeric(20,4),
  is_multiple_tranches     boolean DEFAULT false,  -- Fidelity uses date ranges
  acquisition_date_range_start date,
  acquisition_date_range_end   date,
  valuation_methodology    text,                  -- 'Market Approach / Precedent Transactions'
  valuation_inputs         text,                  -- free text
  level3_movements         jsonb,                  -- {opening_balance, purchases, conversions, unrealized_appr, ending_balance}
  ncsr_accession           text NOT NULL,
  ncsr_period_end          date NOT NULL,
  ncsr_form_type           text,                  -- 'N-CSR'|'N-CSRS'
  source_field             text,                  -- 'restricted_table'|'inline_name'|'soi_column'|'roll_forward'
  extraction_method        text,                  -- 'ark_regex'|'destiny_ixbrl'|'fidelity_llm'|'trp_regex_inline'|'generic_llm'
  extraction_confidence    smallint,              -- 0-100
  raw_extracted_text       text,                  -- preserve the source snippet
  extracted_at             timestamptz DEFAULT now()
);

CREATE INDEX ix_ncsr_holding ON nport_holdings_ncsr (holding_id_ref);


-- =========================================================
-- N-1A portfolio manager enrichment
-- =========================================================
CREATE TABLE fund_portfolio_managers (
  id                       bigserial PRIMARY KEY,
  filing_accession         text NOT NULL,         -- N-1A / 485BPOS / N-2 accession
  registrant_cik           text NOT NULL,
  series_id                text,
  series_name              text,
  pm_name                  text NOT NULL,
  pm_role                  text,                  -- 'Portfolio Manager'|'Co-PM'|'Lead PM'|'CIO'
  pm_managing_since        date,
  pm_managing_since_year   smallint,              -- when only year disclosed
  pm_biography             text,
  is_currently_active      boolean DEFAULT true,
  retirement_date          date,                  -- if disclosed
  filing_form_type         text,                  -- 'N-1A'|'485BPOS'|'N-2'|'N-2/A'
  filing_date              date,
  extraction_method        text,                  -- 'fidelity_regex'|'trp_table_parser'|'baron_regex'|'generic_llm'
  extraction_confidence    smallint,
  raw_extracted_text       text,
  extracted_at             timestamptz DEFAULT now()
);

CREATE INDEX ix_fpm_registrant ON fund_portfolio_managers (registrant_cik, series_id, is_currently_active);


-- =========================================================
-- N-CEN — structured fund census (XML)
-- =========================================================
CREATE TABLE fund_ncen_records (
  id                       bigserial PRIMARY KEY,
  accession_number         text UNIQUE NOT NULL,
  registrant_cik           text NOT NULL,
  series_id                text,
  fiscal_year_end          date,
  filing_date              date NOT NULL,
  investment_adviser_name  text,
  investment_adviser_crd   text,
  investment_adviser_lei   text,
  subadviser_name          text,
  subadviser_crd           text,
  subadviser_lei           text,
  fund_type                text,                  -- from N-CEN classification
  is_etf                   boolean,
  is_money_market          boolean,
  ingested_at              timestamptz DEFAULT now()
);

CREATE INDEX ix_ncen_cik ON fund_ncen_records (registrant_cik, series_id);
CREATE INDEX ix_ncen_adviser ON fund_ncen_records (investment_adviser_crd);
CREATE INDEX ix_ncen_subadv  ON fund_ncen_records (subadviser_crd);


-- =========================================================
-- Materialized rollup view — fast company-page queries
-- =========================================================
CREATE MATERIALIZED VIEW nport_company_positions_mv AS
SELECT
  pc.id                          AS company_id,
  pc.slug                        AS company_slug,
  pc.display_name                AS company_name,
  pc.sector,
  nh.exposure_type,
  nh.share_class_normalized,
  nh.asset_cat,
  nf.report_period_end,
  nf.report_period_date,
  nr.id                          AS registrant_id,
  nr.cik                         AS registrant_cik,
  nr.name                        AS registrant_name,
  nf.series_id,
  nf.series_name,
  nf.fund_type,
  nf.is_interval_fund,
  nf.is_variable_insurance,
  nf.parent_registrant_id,
  nh.balance,
  nh.currency_value_usd,
  nh.pct_of_nav,
  nh.issuer_name                 AS raw_issuer_name,
  nh.issuer_title                AS raw_issuer_title,
  nh.accession_number,
  nh.id                          AS holding_id_internal
FROM nport_holdings nh
JOIN nport_filings    nf ON nh.accession_number = nf.accession_number
JOIN nport_registrants nr ON nf.cik = nr.cik
JOIN private_companies pc ON nh.resolved_company_id = pc.id
WHERE nh.resolved_company_id IS NOT NULL
  AND pc.is_sanctioned = false
  AND pc.is_acquired   = false;

CREATE INDEX ix_mv_company_period ON nport_company_positions_mv (company_id, report_period_end);
CREATE INDEX ix_mv_registrant     ON nport_company_positions_mv (registrant_id);
CREATE INDEX ix_mv_company_slug   ON nport_company_positions_mv (company_slug, report_period_end);


-- =========================================================
-- Quarter-over-quarter delta detection (computed)
-- =========================================================
CREATE TABLE position_deltas (
  id                       bigserial PRIMARY KEY,
  company_id               uuid NOT NULL REFERENCES private_companies(id),
  registrant_id            uuid NOT NULL REFERENCES nport_registrants(id),
  series_id                text NOT NULL,
  share_class_normalized   text,
  exposure_type            text,
  prior_period_end         date NOT NULL,
  current_period_end       date NOT NULL,
  prior_balance            numeric(28,8),
  current_balance          numeric(28,8),
  prior_value_usd          numeric(20,4),
  current_value_usd        numeric(20,4),
  balance_delta            numeric(28,8),
  value_delta_usd          numeric(20,4),
  implied_price_prior      numeric(20,6),         -- value/balance
  implied_price_current    numeric(20,6),
  markup_pct               numeric(10,4),         -- (current_price - prior_price) / prior_price * 100
  is_pure_markup           boolean,               -- balance unchanged, only value moved
  is_new_position          boolean,
  is_exit                  boolean,
  detected_at              timestamptz DEFAULT now(),

  UNIQUE (company_id, registrant_id, series_id, share_class_normalized, exposure_type, current_period_end)
);

CREATE INDEX ix_deltas_company ON position_deltas (company_id, current_period_end);
CREATE INDEX ix_deltas_markup  ON position_deltas (company_id, markup_pct) WHERE is_pure_markup = true;
```

### 4.2 Cross-DB joins (handled in API layer, not DB)

```
ADV DB (existing)      Form D DB (existing)         N-PORT DB (new)
─────────────────      ──────────────────           ──────────────
advisers_enriched.crd  ←  cross_reference_matches  ←  fund_ncen_records.investment_adviser_crd
funds_enriched         ←  form_d_filings           ←  nport_holdings.resolved_company_id
                                                      → private_companies.id
```

The Node API server fetches from each Supabase project and joins in-memory. No FDW, no cross-project FKs.

---

## 5. Resolution Pipeline — The Entity-Resolution Algorithm

Apply in priority order. First match wins. Cache result on `nport_holdings.resolved_company_id` + `resolution_source`.

```
Step 1: LEI exact match
  if issuer_lei IS NOT NULL AND issuer_lei != 'N/A':
    if LEI exists in private_companies.legal_entities[*].lei:
      → resolved, source='lei', confidence=100

Step 2: LoanX ID match (for ASSET_CAT='LON' only)
  if asset_cat = 'LON':
    look up nport_identifiers WHERE holding_id = X AND other_id_desc='LoanX ID'
    if same LoanX ID is mapped to a company in private_company_aliases:
      → resolved, source='loanx', confidence=95, exposure_type='credit'

Step 3: BBGID / FIGI match (equity)
  look up nport_identifiers WHERE holding_id = X AND other_id_desc IN ('BBGID','ID_BB_GLOBAL','Bloomberg Identifier')
  if vendor code appears in private_company_aliases:
    → resolved, source='bbgid', confidence=90

Step 4: SPV unwrap (regex on issuer_name + issuer_title concatenated)
  patterns to extract underlier:
    r'\(economic exposure to ([^,)]+?)(?:[,)])'
    r'\(invested in ([^,)]+?)(?:[,)])'
    r'^DXYZ ([A-Z]+) [IVX]+ LLC$'   # DXYZ wrappers
    r'AESTAS LLC dba (\w+)'
    r'^MWAM VC (.+?)(?:[-,]|\s+LLC)' # Morgan Stanley co-invest (POC-validated: \w+ truncates multi-word names; this captures up to the dash/comma/LLC)
    r'^SPV EXPOSURE TO (\w+)'
    r'^G Squared.*?invested in (\w+)'
  if extracted underlier matches a company alias:
    → resolved, source='spv_regex', confidence=85, exposure_type='spv', underlier_issuer_name=<extracted>

Step 5: Exact normalized name match
  normalized = normalize_issuer_name(issuer_name)
  # normalize: upper → strip punctuation → strip legal suffixes (LLC, INC, PBC, CORP, CO, LP, LTD, TRUST, FUND, HOLDINGS)
  # → strip vendor noise (' PP', ' PC', ' CVT PFD', '(PHYSICAL)', '(NOT LISTED OR TRADING)')
  if normalized matches private_company_aliases.pattern WHERE pattern_type='exact_normalized':
    → resolved, source='alias_exact', confidence=98

Step 6: Prefix match (min 8 chars)
  if normalized starts with a pattern WHERE pattern_type='prefix' AND length(pattern) >= 8:
    → resolved, source='alias_prefix', confidence=85

Step 7: Regex / contains
  apply patterns WHERE pattern_type IN ('regex','contains'):
    → resolved, source='alias_regex', confidence=70-80 depending on pattern specificity

Step 8: Sanctioned-securities exclusion
  if normalized matches any sanctioned_securities.pattern:
    → resolution_source='sanctioned', resolved_company_id=NULL
    # don't try to resolve further; these are zero-value zombie positions

Step 9: Mark unresolved
  resolved_company_id = NULL
  resolution_source = 'unresolved'
  # these rows surface in a manual triage UI for alias curation
```

**Share class normalization** is independent of company resolution. Apply after Step 7:

```
input: 'ANTHROPIC PBC SER F-1 CVT PFD PP'
regex: r'\b(SER|SERIES|CL|CLASS)\s*([A-Z]+(?:-?\d+)?)'
output: 'Series F-1' (canonicalize SER→Series, CL→Class)

if input contains 'CVT PFD' or 'CONVERTIBLE PREFERRED': share_type='convertible_preferred'
elif input contains 'PFD' or 'PREFERRED':                share_type='preferred'
elif input contains 'COMMON':                            share_type='common'
elif input contains 'WARRANT':                           share_type='warrant'
else:                                                    share_type='unspecified'
```

**Variable insurance dedupe** (avoid double-counting Fidelity Contrafund exposure 3-5x because Lincoln/Brighthouse/John Hancock VIP series mirror it):

```
nport_filings.is_variable_insurance = true if registrant name matches:
  r'(?i)(variable insurance|VIP|sub-account|separate account)'

nport_filings.parent_registrant_id = link via Form N-CEN feeder/master relationship,
  or via fuzzy match on series name + holding signature

In rollup views: GROUP BY parent_registrant_id COALESCE registrant_id
```

---

## 6. Ingestion Modules

These are parallel buildable modules — each is independent and can be assigned to its own agent / worktree.

### 6.1 Historical bulk backfill (one-time)

**Trigger:** manually invoked once at setup
**Source:** SEC quarterly ZIPs 2019 Q4 → present (25 quarters)
**Implementation language:** Python (matches Form D pipeline)
**File location:** `data-pipeline/nport-scraper/backfill_bulk.py`

```python
QUARTERS = [(y,q) for y in range(2019,2027) for q in (1,2,3,4)]
# trim to available range; SEC may not publish all early quarters

for year, quarter in QUARTERS:
    url = f"https://www.sec.gov/files/dera/data/form-n-port-data-sets/{year}q{quarter}_nport.zip"
    download_with_user_agent(url, dest=f"/tmp/nport/{year}q{quarter}.zip")
    extract_zip(...)
    # SQLite staging keeps memory bounded
    load_to_sqlite(holdings_tsv, registrants_tsv, filings_tsv, identifiers_tsv)
    apply_private_filter(sqlite, filter='restricted=Y OR fvl=3 OR title_keyword OR is_known_alias')
    resolve_entities(sqlite, aliases_from_supabase)
    upsert_to_supabase(sqlite, batch_size=500)
    cleanup_temp_files(...)  # critical — these are 1.6GB each
```

Use SQLite staging (matches Form D pipeline pattern) to avoid memory blowup on 5.9M-row TSVs. Stream filter → resolve → batch-upsert.

**Bulk filter (PRODUCTION — F4 with confidence tagging):**

A stress-test verification pass against the 5.94M-row 2026 Q1 dataset proved that the strict 5-way AND filter (originally F1) silently drops 6/91 legitimate Anthropic positions because filers inconsistently set the `IS_RESTRICTED_SECURITY` flag. **Production filter is F4 with a confidence column:**

```sql
-- F4 — captures real private equity reliably
SELECT * FROM holdings WHERE
  fair_value_level = '3'
  AND asset_cat IN ('EC','EP')
  AND issuer_type = 'CORP'
  AND (cusip IS NULL OR cusip = '000000000' OR cusip = 'N/A'
       OR LENGTH(cusip) != 9)
-- Tag confidence on each captured row:
--   HIGH   if also IS_RESTRICTED_SECURITY = 'Y'   (≈ 6,383 rows in 2026 Q1)
--   MEDIUM otherwise                              (≈ 7,514 more rows)
-- F4 total: 13,897 rows / 3,921 clusters per quarter

UNION ALL

-- Credit positions on tracked private companies (xAI loans, Databricks loans)
SELECT * FROM holdings WHERE
  fair_value_level = '3'
  AND asset_cat = 'LON'
  AND is_restricted = 'Y'

UNION ALL

-- Already known via alias (don't drop on filter)
SELECT * FROM holdings WHERE
  normalized_issuer_name IN (SELECT normalized FROM aliases_cache)
```

**Verification evidence:** F4 captures 88/91 Anthropic rows (97%); F1 captures only 82/91 (90%). The 6 rows F1 drops have `IS_RESTRICTED=N` but are legitimate VC-stage positions (e.g., `ANTHROPIC PBC CL F-1 PFD PP (PHYSICAL) (NOT LISTED OR TRADING)`). F1 produces 184 sanctioned-Russian false-positives; F4 produces 819 (still manageable with the §4 sanctioned_securities exclusion). F6 (the broader `restricted OR fvl=3` form) is rejected for production — 31,880 rows, 1,170 sanction FPs, only +3 Anthropic recall.

**Schema validation at year boundaries — REQUIRED.** SEC publishes no changelog. File sizes jump 29% at 2022 Q1 (357 MB → 460 MB), coinciding with the 2022 N-PORT rule amendments. 2022 Q3 is a 691 MB outlier (58% larger than adjacent quarters — likely a large amendment catch-up). Before parsing any quarter, diff `FUND_REPORTED_HOLDING` and `FUND_REPORTED_INFO` TSV headers against the previous quarter. Fail loud if a new column appears.

**Disk budget:** 26 quarters × 442 MB avg = 10.27 GB compressed total. Worst single ZIP = 691 MB. Uncompressed TSV peaks at ~5.5 GB for 2022 Q3. Stream + delete eagerly; do not keep raw TSVs after SQLite staging.

### 6.2 Daily NPORT-P scraper (live delta)

**Trigger:** cron, daily
**Source:** `https://www.sec.gov/Archives/edgar/full-index/{year}/QTR{q}/form.idx`
**File location:** `data-pipeline/nport-scraper/daily_scraper.py`
**Pattern:** Direct copy of `data-pipeline/formd-scraper/daily_scraper_with_alerts.py` with form-type filter `NPORT-P, NPORT-P/A`.

For each new accession:
1. Fetch `https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodashes}/primary_doc.xml`
2. Parse via **`lxml`** with namespace handling — verified 8.5x faster than `xmltodict` over 100-iteration benchmark (0.44 ms vs 3.8 ms per 80 KB file). For per-filing parsing of ~13K filings/quarter, throughput matters. Pattern:
   ```python
   from lxml import etree
   NS = {"n": "http://www.sec.gov/edgar/nport"}
   tree = etree.parse(xml_path)  # or .iterparse() for any file >1 MB
   root = tree.getroot()
   reg_cik = root.find(".//n:regCik", namespaces=NS).text
   for sec in root.findall(".//n:invstOrSec", namespaces=NS):
       name = sec.find("n:name", namespaces=NS).text
       is_restricted = sec.find("n:isRestrictedSec", namespaces=NS).text == 'Y'
       fvl = sec.find("n:fairValLevel", namespaces=NS).text
       # ...
   ```
3. Walk `formData/invstOrSec` array, apply same filter as bulk
4. Resolve entities, upsert to `nport_holdings` + `nport_filings`
5. Trigger position_deltas refresh for the affected fund
6. Email alert on:
   - Any new position in a tracked private company
   - Pure markup > 25% on any tracked-company position
   - New fund family discovered holding a tracked company

### 6.3 IDENTIFIERS.tsv ingestion

**Trigger:** Same time as bulk backfill, per-quarter
**File:** `data-pipeline/nport-scraper/load_identifiers.py`

Stream the 282MB IDENTIFIERS.tsv per quarter, filter to **only useful rows**:

```python
USEFUL_DESCRIPTORS = {
    'BlackRock Identifier', 'BBGID', 'ID_BB_GLOBAL',
    'Bloomberg Identifier', 'Bloomberg', 'LoanX ID',
    # NOT 'USER DEFINED', 'Internal', 'Inhouse Asset ID' etc — filer-internal noise
}

for row in stream(identifiers_tsv):
    if row['other_id_desc'] in USEFUL_DESCRIPTORS or row['isin'] or row['ticker']:
        upsert_to_nport_identifiers(row)
```

This reduces the 7.16M-row table to a manageable ~200K-500K relevant rows per quarter.

### 6.4 N-CSR enrichment pipeline

**Trigger:** Whenever a new fund × period appears in `nport_holdings` holding a tracked private company AND no `nport_holdings_ncsr` row exists yet
**File location:** `data-pipeline/ncsr-scraper/`

```
For each (registrant_cik, fiscal_period):
  find the corresponding N-CSR or N-CSRS filing on EDGAR
    GET https://data.sec.gov/submissions/CIK{cikpadded}.json
    filter form_type in ['N-CSR','N-CSRS'] near the fiscal period
  download the primary HTML document
  apply per-filer parser:
    if filer in ['ARK']:       run regex_parser_ark(html)
    elif filer == 'Destiny':   run ixbrl_parser(html)
    elif filer == 'Fidelity':  run llm_extractor(html, prompt=FIDELITY_PROMPT)
    elif filer == 'T. Rowe':   run regex_parser_trp_inline(html)  # 'Acquisition Date: \S+, Cost \$([0-9,]+)'
    else:                      run llm_extractor(html, prompt=GENERIC_PROMPT)
  fuzzy-match extracted acquisition rows back to nport_holdings by (issuer_name, series_class)
  upsert nport_holdings_ncsr
```

**LLM extractor prompt template** (OpenAI gpt-4o-mini or similar):

```
SYSTEM: Extract restricted-security acquisition data from this SEC Form N-CSR filing.
Return JSON array: [{security_name, share_class, acquisition_date, acquisition_cost_usd, footnotes}]
If multiple tranches are listed as a date range, return one entry with date_range_start and date_range_end.
Only include rows that are private/restricted securities. Skip public equities.

USER: [HTML content of N-CSR filing, truncated to restricted-securities section]
```

Bound cost: only enrich filings where we already know there are private holdings (§5 resolution finds them). Universe: ~700 N-CSR/N-CSRS per year mentioning "restricted securities". LLM cost at gpt-4o-mini ≈ $0.50-2 per filing × 700/year = **$350-1400/year total**.

### 6.5 N-CEN ingestion (fund census XML)

**Trigger:** Daily scraper extension — also watch form types `N-CEN`
**File location:** `data-pipeline/nport-scraper/ncen_ingest.py`

```python
from lxml import etree
NS = {"n": "http://www.sec.gov/edgar/ncen"}  # confirm exact namespace from sample filing

for accession in new_ncen_filings:
    url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodashes}/primary_doc.xml"
    xml = fetch(url)
    tree = etree.fromstring(xml.encode())

    # CRITICAL: the <investmentAdvisers> block has minOccurs="0" in the N-CEN XSD.
    # Self-managed funds (some closed-end funds, internal-management trusts) omit it.
    # Always null-guard.
    adv_node = tree.find(".//n:investmentAdvisers", namespaces=NS)
    adviser_crd = None
    adviser_name = None
    adviser_lei = None
    if adv_node is not None:
        # Per XSD: investmentAdviserCrdNo is CRD_NUMBER_TYPE pattern [0-9]{9}|N/A
        adviser_crd  = adv_node.findtext(".//n:investmentAdviserCrdNo",  namespaces=NS)
        adviser_name = adv_node.findtext(".//n:investmentAdviserName",   namespaces=NS)
        adviser_lei  = adv_node.findtext(".//n:investmentAdviserLei",    namespaces=NS)
        # Treat 'N/A' as null
        if adviser_crd == 'N/A': adviser_crd = None

    # Sub-advisers: can be multiple (Fidelity sample had 12)
    subadvisers = []
    for sub in tree.findall(".//n:subAdviser", namespaces=NS):
        subadvisers.append({
            'crd':  sub.findtext("n:subAdviserCrdNo",  namespaces=NS),
            'name': sub.findtext("n:subAdviserName",   namespaces=NS),
            'lei':  sub.findtext("n:subAdviserLei",    namespaces=NS),
        })

    record = {
        'accession_number': accession,
        'registrant_cik': cik,
        'investment_adviser_name': adviser_name,
        'investment_adviser_crd':  adviser_crd,
        'investment_adviser_lei':  adviser_lei,
        'subadvisers_json':        subadvisers,  # store JSONB
    }
    upsert_to_fund_ncen_records(record)

    # Update nport_registrants.adv_crd via N-CEN link — only if we have a valid CRD
    if adviser_crd:
        update_registrant_adv_crd(cik=cik, crd=adviser_crd, method='ncen_xref')
```

**XSD reference for N-CEN schema:** https://www.sec.gov/info/edgar/specifications/form-n-cen-xml-tech-specs-2.2.htm — confirms `investmentAdviserCrdNo` pattern `[0-9]{9}|N/A`, `investmentAdviserLei` pattern `[0-9A-Za-z]{20}|[0-9]{10}|N/A`. The 9-digit CRD is already zero-padded in the XML.

### 6.6 N-1A portfolio manager extraction

**Trigger:** When a new fund first appears in `nport_holdings`, or on each new 485BPOS / N-1A / N-2 filing
**File location:** `data-pipeline/n1a-scraper/`

```python
for fund in funds_holding_tracked_companies:
    latest_485bpos = find_latest_filing(fund.cik, forms=['485BPOS','485APOS','N-1A','N-2','N-2/A'])
    html = fetch_primary_doc(latest_485bpos)
    pm_section = extract_section(html, headings=['Portfolio Manager', 'Fund Management', 'Management of the Fund'])

    fund_family = classify_filer(fund.cik)
    if fund_family == 'fidelity':
        pms = regex_parser_fidelity(pm_section)
    elif fund_family == 'trowe':
        pms = parse_trp_pm_table(pm_section)
    elif fund_family == 'baron':
        pms = regex_parser_baron(pm_section)
    else:
        pms = llm_extractor(pm_section, prompt=PM_EXTRACTION_PROMPT)

    upsert_to_fund_portfolio_managers(fund, pms)
```

**Real PM data** (from §1.4 — use as verification ground truth during parser dev):
- Contrafund (CIK 24238) → Danoff + Drukker + Gupta
- TRP Global Tech (CIK 1116626) → Dom Rizzo
- ARK Venture (CIK 1905088) → Cathie Wood
- DXYZ (CIK 1843974) → Sohail Prasad
- Baron Partners → Ron + Michael Baron

### 6.7 Private-companies seed loader

**Trigger:** One-time at setup + periodic refresh
**File location:** `data-pipeline/private-companies/seed.py`

Sources, in priority:
1. **Wikipedia unicorn list — wikitext API** (CC BY-SA). Verified live: 618 active unicorn rows + 206 exited rows = 824 entries. Columns: Company, Valuation (US$ B), Valuation date, Industry, Country, Founders. Verified entries include SpaceX ($1,250B), OpenAI ($852B), Anthropic ($380B), ByteDance ($330B), Stripe ($159B). **Wikidata SPARQL does NOT work for this** — the `P31/P279*` "unicorn startup" type query returns 0 results because Wikidata doesn't use a unicorn class; the `P2226` market-cap field is set on public companies, not private. Use the Wikipedia wikitext route instead:
   ```python
   import requests, re
   URL = "https://en.wikipedia.org/w/api.php"
   params = {"action": "parse", "page": "List of unicorn startup companies",
             "prop": "wikitext", "format": "json"}
   r = requests.get(URL, params=params).json()
   wikitext = r["parse"]["wikitext"]["*"]
   # Split on '|-' to get rows, then regex to strip [[...]] markup
   ```
2. **N-PORT auto-discovered entities** — the 1,909 clusters from the F4 filter scan are the organic universe. Wikipedia covers the well-known unicorns but misses many AI/biotech/defense names that appear in N-PORT (e.g., Physical Intelligence, Skyryse, Kardigan, KoBold Metals, Sila Nano). **The combined Wikipedia + N-PORT-discovered set is ~2,400 candidate entities** — Wikipedia provides metadata for ~600, N-PORT supplies the rest with only the name + observed share-class strings.
3. **Wikidata per-company enrichment** — once seeded from Wikipedia, look up each entry by label to get the Wikidata QID, then fetch `P856` (domain) and `P571` (founded date). Expect ~60-70% hit rate on well-known names.
4. **Manual curation** — for the top 100-200 high-priority companies, hand-curate aliases, sector, latest round, valuation. This is one afternoon's work for a researcher.

After loading, link each Wikipedia entry to the corresponding cluster of issuer_names from the 2026 Q1 enumeration. Generate initial alias rows. Flag acquired-or-IPO'd entries (`is_public=true`, `ipo_date` set) — e.g., **Wiz** (acquired by Google before 2025-12-31 reporting period, has 0 N-PORT rows now).

### 6.8 Delta detection job

**Trigger:** After every bulk-load or daily-scrape batch completes
**File location:** `data-pipeline/nport-scraper/compute_deltas.py`

```python
def compute_deltas(company_id, prior_period, current_period):
    prior_positions  = query_mv(company_id, prior_period)
    current_positions = query_mv(company_id, current_period)

    # match by (registrant_id, series_id, share_class, exposure_type)
    for current in current_positions:
        prior = find_matching(prior_positions, current.match_key)
        if prior:
            delta = compute_delta(prior, current)
            if delta.balance_delta == 0 and delta.value_delta != 0:
                delta.is_pure_markup = True
            upsert_position_delta(delta)
        else:
            upsert_new_entry(current)

    for prior in prior_positions:
        if not find_matching(current_positions, prior.match_key):
            upsert_exit(prior)

    # detect coordinated repricing events (SpaceX-style)
    if multiple_funds_marked_same_pct_on_same_period(company_id, current_period):
        emit_event('coordinated_repricing', ...)
```

---

## 7. API Layer

Add to existing `server.js`. Three new Supabase clients (one per project) already follow the existing pattern.

### 7.1 New endpoints

```
GET /api/nport/companies                     — list private companies (filterable)
GET /api/nport/companies/:slug               — single company profile
GET /api/nport/companies/:slug/positions     — full position table for a company, across all funds and periods
GET /api/nport/companies/:slug/holders       — current holder rollup (latest period)
GET /api/nport/companies/:slug/timeseries    — quarterly position values for charting
GET /api/nport/companies/:slug/markups       — biggest QoQ markups across holders
GET /api/nport/companies/:slug/cross         — cross-DB view: Form D + ADV + N-PORT consolidated

GET /api/nport/funds/:cik                    — fund family overview
GET /api/nport/funds/:cik/:series_id         — single fund series
GET /api/nport/funds/:cik/:series_id/positions — all private positions held by this fund series
GET /api/nport/funds/:cik/:series_id/managers  — portfolio managers from N-1A
GET /api/nport/funds/:cik/:series_id/adviser   — cross-link to ADV adviser record

GET /api/nport/admin/unresolved              — admin triage UI for unresolved issuer names
POST /api/nport/admin/aliases                — add an alias (curator action)
POST /api/nport/admin/refresh_resolution     — re-run §5 algorithm for unresolved rows
```

### 7.2 Cross-DB join pattern (existing convention)

```javascript
// /api/nport/companies/:slug/cross
async function getCrossSourceCompanyView(slug) {
  const company = await nportDb.from('private_companies').select('*').eq('slug', slug).single();

  const [nportPositions, formDFilings, advAdvisers] = await Promise.all([
    nportDb.from('nport_company_positions_mv')
      .select('*').eq('company_slug', slug).order('report_period_end', { ascending: false }),

    formDDb.from('form_d_filings')
      .select('*')
      .or(`entityname.ilike.%${company.display_name}%,series_master_llc.ilike.%${company.display_name}%`),

    // For each unique fund family in nportPositions, look up its ADV record
    advDb.from('advisers_enriched')
      .select('*').in('crd', uniqueAdvCrds(nportPositions))
  ]);

  return {
    company,
    nport_positions: nportPositions,
    form_d_filings: formDFilings,
    related_advisers: advAdvisers
  };
}
```

---

## 8. Frontend — Pages to Build

Adopt the existing React app pattern in `public/app.js`. Two main new pages:

### 8.1 Company page — `/company/:slug`

```
┌─────────────────────────────────────────────────────────────────┐
│  Anthropic                                  sector: AI / ML     │
│  ────────                                   most recent: Series F│
│  $2.6B disclosed N-PORT exposure across 41 fund families        │
├─────────────────────────────────────────────────────────────────┤
│  Latest marks (Q1 2026, period 2025-12-31):                    │
│    Series E:  $231.50/sh   (median across 8 holders)            │
│    Series F:  $233.40/sh   (median across 22 holders)           │
│    Series G:  $260.10/sh   (median across 12 holders)           │
│                                                                  │
│  Q-over-Q markup: Series F +12.3%, Series G new this quarter   │
├─────────────────────────────────────────────────────────────────┤
│  Top Holders (current period)                                   │
│  ─────────────────────────────                                   │
│  Fidelity Contrafund                $187M  Series E/F  PM: Danoff│
│  T. Rowe Price Global Technology    $89M   Series F-1   PM: Rizzo│
│  ARK Venture Fund                   $14M   Series C-1   PM: Wood │
│  ...                                                             │
├─────────────────────────────────────────────────────────────────┤
│  Holdings time series                  [chart: value over time] │
│  All-tranches markup history           [chart: implied $/share] │
├─────────────────────────────────────────────────────────────────┤
│  Cross-source view (other PFR data):                            │
│    Form D filings mentioning Anthropic:   12 — view all         │
│    ADV Schedule D funds holding Anthropic: 7 — view all          │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 Fund page — `/fund/:cik/:series_id`

```
┌─────────────────────────────────────────────────────────────────┐
│  Fidelity Contrafund   (CIK 0000024238 | Series S000004007)    │
│  Adviser: Fidelity Management & Research Co (CRD 108281)        │
│  ↳ view on ADV: privatefundsradar.com/adviser/108281            │
├─────────────────────────────────────────────────────────────────┤
│  Portfolio Managers (from latest 485BPOS):                      │
│    William Danoff      Lead Co-PM since 2012  (retiring 2026)   │
│    Matthew Drukker     Co-PM since 2025                          │
│    Nidhi Gupta         Co-PM since 2025                          │
├─────────────────────────────────────────────────────────────────┤
│  Private-company exposure (Q1 2026):  $1.7B total, 4.2% of NAV │
│  ──────────────────────────────────                              │
│  Anthropic PBC          Series E,F   $187M   Acq cost $7.4M    │
│  OpenAI Group PBC       Class A      $76M    Acq cost $...      │
│  Stripe Inc             Series J     $58M                        │
│  Databricks             Series K     $43M                        │
│  SpaceX                 Series J     $32M                        │
│  ...                                                             │
├─────────────────────────────────────────────────────────────────┤
│  Q-over-Q changes:                                              │
│    Anthropic Series F: +12.3% markup (no share change)         │
│    OpenAI: NEW position (entered Q1 2026)                       │
│    [Position1]: EXITED                                          │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 Admin triage UI — `/admin/unresolved`

Shows the `nport_holdings WHERE resolution_source='unresolved'` rows grouped by normalized issuer name. One-click to create an alias linking to existing or new `private_companies` row.

---

## 9. Parallel Build Assignment (Worktrees / Agents)

These modules have **no internal dependencies** and can be built simultaneously in parallel worktrees:

| Worktree / Agent | Module | Why parallelizable |
|---|---|---|
| `wt-schema` | Supabase schema creation (all tables, indices, views, MV) | Foundation; everything else depends on it but it's a single migration script |
| `wt-bulk-loader` | §6.1 historical backfill | Self-contained, just needs schema to exist |
| `wt-daily-scraper` | §6.2 daily NPORT-P delta | Self-contained Python module |
| `wt-identifiers` | §6.3 IDENTIFIERS.tsv loader | Self-contained |
| `wt-resolver` | §5 entity resolution algorithm + alias seed | Self-contained; produces an importable Python/JS module |
| `wt-ncen-ingest` | §6.5 N-CEN XML → fund_ncen_records | Self-contained; cross-links to ADV CRD |
| `wt-ncsr-enrich` | §6.4 N-CSR scraper + per-filer parsers + LLM fallback | Self-contained; only depends on `nport_holdings` having rows |
| `wt-n1a-pm` | §6.6 portfolio manager extraction | Self-contained |
| `wt-seed-companies` | §6.7 Wikipedia + manual seed + N-PORT auto-discovery | Independent of ingestion; produces seed data |
| `wt-delta-job` | §6.8 QoQ delta detection | Depends on resolver + multiple quarters loaded |
| `wt-api` | §7 new Express endpoints | Independent module added to server.js |
| `wt-frontend` | §8 company page + fund page + admin triage | Independent React routes |

**Recommended parallelization:** schema first (5 min), then everything else simultaneously in separate worktrees, with the resolver delivering a Python module that the bulk loader and daily scraper both `from .resolver import resolve_entity`.

---

## 10. Risks / Gotchas / Open Questions

1. **Bulk data size and disk budget.** Each quarter's ZIP is 442 MB compressed, 1.6 GB uncompressed. 25 quarters of backfill = ~11 GB compressed, ~40 GB uncompressed. Use streaming + immediate cleanup. Do NOT keep raw TSVs after SQLite staging. The agent that filled `/tmp` mid-research is a real warning.

2. **Coordinated repricing events are reportable.** When every Fidelity / Baron / T. Rowe fund marks SpaceX up exactly 2x on the same date, it's a public signal. Surface these explicitly — journalists and competitors cite them. Don't bury in the position deltas table; create a `repricing_events` table or compute on the fly.

3. **Variable-insurance double-counting.** Lincoln/Brighthouse/John Hancock/SunAmerica/Nationwide/Transamerica VIP series hold pass-through positions that mirror underlying Fidelity/TRP funds. Naive sum gives 3-5× the real exposure. **Solution in schema** (§4): `is_variable_insurance` flag + `parent_registrant_id`. Default rollup view excludes VI sub-accounts unless explicitly requested.

4. **Form D entity matching is fuzzy.** When showing cross-source view, "Form D filings mentioning Anthropic" requires fuzzy matching the alias list against `form_d_filings.entityname` and `series_master_llc`. False positives possible (e.g., "Anthropic Capital LLC" is not Anthropic the AI lab). Use a curated cross-source alias.

5. **N-PORT only reports the third month of each quarter publicly.** Funds file 3 monthly reports per quarter privately, only month 3 becomes public 60 days after quarter-end. Within a single fund, you get one snapshot per quarter, not monthly. **Don't market "monthly tracking" — it's quarterly.**

6. **PM identity is point-in-time, not historical.** N-1A reports the current PM as of the latest filing. Historical PM-attribution requires tracking N-1A revisions over time. For V1, just take the most recent. Add `is_currently_active` flag + `pm_history` table later if needed.

7. **OpenAI's "OpenAI Group PBC" vs "OpenAI Global, LLC" naming.** Post-restructuring, the same underlying entity is filed under multiple legal names. Curated alias table needs explicit rows for each historical name AND a date range to disambiguate.

8. **Canva files as "CANVA AUSTRALIA HOLDINGS PTY LTD"** (parent in Australia) but funds invest in "CANVA INC" (US subsidiary). Both roll up to one `private_companies.id = canva`.

9. **Rate limits.** SEC rate limit is 10 req/s with User-Agent. Honored everywhere (existing pattern uses 0.11s sleep). At backfill scale, downloading 25 quarterly ZIPs takes ~10 minutes total (442 MB each). Per-filing scrapes for N-CSR / N-1A across ~1000+ filings take longer — budget time accordingly with the existing rate limit.

10. **Why no Form 13F.** 13F covers 13(f) securities (publicly traded only). Useless for private companies. Confirmed not in scope.

11. **xAI dual exposure: equity ≠ credit.** xAI shows 70+ rows as leveraged loans (`ASSET_CAT=LON`) held by CLOs, plus 3 rows as equity. Same company, very different signals. Default queries should filter to equity (`ASSET_CAT IN ('EC','EP')`); credit exposure surfaces as a separate explicit view. Same pattern likely applies to Databricks (also issues term loans).

12. **N-CSR data freshness lag.** N-CSR is 50-70 days behind period end, vs N-PORT's 60 days. N-CSR adds acquisition cost + date — fields that don't change after acquisition — so freshness is mostly irrelevant for those columns. But valuation methodology + Level-3 roll-forward can be stale.

13. **Auto-cluster discovery for new entities.** As N-PORT updates each quarter, new private companies appear (e.g., new Series H of an established company; or wholly new companies like Mistral). The pipeline needs a regular "discover new clusters" job that surfaces top-N unresolved normalized names by filer count, for human curation. This is exactly what §6.7 + the admin UI handle.

14. **Possible regulatory tailwind.** SEC has discussed shortening the 60-day public delay. If they implement this, data freshness improves automatically. Watch the SEC rulemaking docket.

15. **N-PORT bulk schema may change between 2021 Q4 and 2022 Q1.** File sizes jump 29% at this boundary, coinciding with the SEC's 2022 N-PORT rule amendments. Bulk loader **MUST** diff TSV column headers at year boundaries before parsing. Fail loud if a new column appears so it's added to the schema deliberately, not silently dropped.

16. **DEBT_SECURITY.tsv has no primary key** per the SEC README. Out of scope for V1 (equity-focused) but worth flagging if Phase-2 expansion includes corporate-bond holdings of private companies.

17. **Per-company lifecycle (acquired, IPO'd, defunct)** must be tracked or N-PORT data goes stale gracefully. Wiz disappears from N-PORT after Google acquisition closed (2024); Rivian appears as a public company. Curate `lifecycle_status` + `acquired_date` / `ipo_date` columns and exclude non-private companies from the default rollup view.

18. **Coverage gaps for private companies not held by '40 Act funds.** Confirmed absent from N-PORT 2026 Q1: Scale AI, Notion, Carta (effectively absent), Discord (only via tiny SPVs). These companies are held purely by VC/PE/family-office investors and won't appear. Surface this explicitly in the company page UI so users understand the coverage boundary.

---

## 11. What's Not In This Plan (Intentional Out-of-Scope)

- **Form 13F** — public securities only, not relevant
- **Form 13D/13G** — 5% beneficial ownership for public companies only
- **Real-time intraday tracking** — N-PORT is monthly at best, public only quarterly. There is no intraday data.
- **VC fund holdings beyond Form D/ADV** — those are not '40 Act filers and don't appear in N-PORT.
- **User accounts / paywall / billing** — explicitly out per the user. This is an internal-use platform.
- **PM compensation analysis** — N-1A Statement of Additional Information has this, but it's not needed for the core "who holds X" question.

---

## 12. Verification Checklist (Pre-Launch)

Before declaring V1 done, verify:

- [ ] All 26 historical quarters loaded into `nport_holdings` (count check vs SEC publication dates; 2019 Q4 → 2026 Q1)
- [ ] Header-diff check at 2022 Q1 boundary passed; any new columns were added to schema deliberately
- [ ] 2022 Q3 (691 MB outlier) ingested without OOM
- [ ] Entity resolution coverage >85% on tracked-company rows (vs. unresolved bucket); Anthropic specifically resolves to 88/91 rows minimum (verified by §5 POC)
- [ ] Sanctioned-securities exclusion list scrubs zero-value Russian rows from rankings
- [ ] Variable-insurance dedupe applied — no double-counting of Fidelity Contrafund exposure
- [ ] Daily scraper successfully ingests at least 5 new NPORT-P filings in a test run
- [ ] N-CSR enrichment populates `acquisition_cost_usd` for >50% of Fidelity / ARK / TRP tracked-company positions
- [ ] N-1A PM extraction returns correct names for the 5 reference funds in §1.4 (Danoff, Rizzo, Wood, Prasad, Baron)
- [ ] N-CEN ingestion populates `investment_adviser_crd` for >90% of registrants
- [ ] Cross-DB query for "Anthropic" returns Form D filings AND ADV adviser records AND N-PORT positions
- [ ] Position deltas correctly identify the SpaceX 2x repricing in Q4 2025 → Q1 2026 transition (244 markup events, single-day price doubling)
- [ ] Coverage gaps correctly reported: Scale AI, Notion, Carta show "no N-PORT data" with explanation
- [ ] Q-over-Q analysis stable: rerun the 2025Q4→2026Q1 comparison from `qoq_findings.md` and verify same numbers come out

---

## 13. Reference — Raw Research Outputs

All research findings from this planning phase live in `/tmp/nport_research/`:

| File | What it has |
|---|---|
| `nport_bulk_findings.md` | 2026 Q1 schema, heuristic filters, top 10 tracked-company counts |
| `ncsr_findings.md` | N-CSR format analysis across 4 filers, parsing difficulty matrix |
| `qoq_findings.md` | 2025 Q4 → 2026 Q1 delta analysis, SpaceX 2x event, markup distribution |
| `identifiers_findings.md` (partial — disk filled) | IDENTIFIERS.tsv schema, LoanX vs filer-internal distribution |
| `n1a_findings.md` | 5 sample N-1A filings, PM extraction strategy, N-CEN vs N-1A comparison |
| `private_universe.md` | Full 1,909-cluster enumeration, top 100 by filer count + USD, sector breakdown, SPV patterns, coverage gaps |
| `reference_sources.md` | position.so confirmation, Wikipedia/CB Insights/Crunchbase/Caplight comparison, licensing |

Source agents (claudable IDs from the parallel orchestration):
- `ad29b487096288e5e` — Bulk 2026 Q1 characterization
- `abb21d08e5dc6dba9` — N-CSR research
- `a2cbcf424263f9ca1` — QoQ analysis
- `a8b63f6ce41769709` — IDENTIFIERS scan
- `ac23bbf660991c7b1` — N-1A PM extraction
- `ad3fe11a25b81107b` — Full private universe enumeration
- `aaf026022516cf66c` — Private-company reference sources

---

## 14. Day-One Actions for the Coding Agent

If you're picking up this plan cold to start building:

1. Read this whole file. (You did.)
2. Read `CLAUDE.md` in the repo root.
3. Look at `data-pipeline/formd-scraper/daily_scraper_with_alerts.py` for the working pattern to mirror.
4. Create a new Supabase project named `nport`. Get URL + service key. Add to `.env`.
5. Run the schema script from §4.1 as the first migration.
6. Seed the `sanctioned_securities` table with the Russian list (§3.2).
7. Spawn worktrees per §9 and assign each module. Each agent / worktree gets §10 risks injected as DO-NOT-DO notes.
8. Backfill 2026 Q1 first (already pulled to `/tmp/nport_research/`, may need to re-download). Use it as the integration test target — you have known numbers for 10 tracked companies.
9. Verify the Anthropic page renders with 41 fund families and $2.6B before going wider.

When done, the verification checklist (§12) is the gate.

---

*End of plan.*
