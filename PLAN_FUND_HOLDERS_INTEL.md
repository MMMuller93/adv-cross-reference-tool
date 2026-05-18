# Fund Holders Intelligence — Build Plan & Full Handoff

> **Who this is for:** An LLM coding agent (or human dev) picking up this work cold from a new session.
> **Goal:** Cross-source intelligence pipeline that produces, for any tracked private company (Anthropic, OpenAI, SpaceX, etc.), the full list of mutual funds + private funds holding it, with adviser firm contact info + named managers.
> **Read this entire doc FIRST.** Then `CLAUDE.md` + `.claude/MEMORY.md`. Do NOT ask the user to re-explain things in this doc.

**Last updated:** 2026-05-15, after adversarial stress-test (3 parallel verification agents + Codex 5.5 plan review + 4 POCs). All major V1 decisions are locked. Ready to start Phase 0.

Owner: Miles Muller (mmmuller93@gmail.com).

---

## 0. The product question this solves

> "For [Anthropic | OpenAI | SpaceX | Stripe | Databricks | …], show me every registered mutual fund/ETF and every private fund/SPV holding shares, with firm name + CRD + AUM + website + named managers + contact paths."

Output: CSV first, then optionally a thin web UI. Single-page-per-company.

Internal-use tool (no auth/paywall — the user has been explicit about this).

---

## 1. Critical context — what already exists

Three Supabase projects already populated and querying. This work is the GLUE across them, not a new ingestion pipeline.

### 1.1 ADV (existing, mature)

- **Project:** `ezuqwwffjgfzymqxsctq.supabase.co`
- **Anon key (hardcoded in server.js line 190 — fine for reads):**
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE`
- **Key tables:**
  - `advisers_enriched` — 40,000 rows, 54 columns. Structured Form ADV Part 1 + Schedule A/B data
  - `funds_enriched` — 185k rows, private funds from ADV Schedule D
  - `adviser_owners` — Schedule A/B owners
- **What's structured already in advisers_enriched (full 54-column list):**
  ```
  Identity:    crd, cik, adviser_name, adviser_entity_legal_name, registration_type, type
  Filing:      filing_id, form_adv_url, execution_date, execution_type, initial_sec_era_report
  AUM:         total_aum, aum_2011..aum_2026 (16 years of history)
  Contact:     phone_number, primary_website, other_websites, other_business_names
  CCO:         cco_name, cco_email
  Signatory:   signatory_name, signatory_title
  Reg contact: regulatory_contact_name, regulatory_contact_email, regulatory_contact_title
  Owners:      owner_full_legal_name (semicolon-delimited),
               owner_title_or_status, ownership_amount,
               owner_is_control_person, control_person_name,
               direct_or_indirect_owner, owner_legal_name,
               when_owner_status_acquired
  Other:       exemption_2b1/2/3, miscellaneous
  ```
- **CRITICAL: what's NOT in advisers_enriched:**
  - No business street/city/state address columns (only phone)
  - No CEO (have CCO, signatory, owners — not CEO)
  - No PM bios (Part 2B never scraped — see §6 for the side-quest status)
  - No `sec_file_number` column despite what some code might suggest
- **CIK ≠ CRD ≠ SEC file number** (different identifier systems — don't conflate)
- **`advisers_enriched.cik` is populated for only 13%** of rows (5,304 of 40k) — direct CIK joins fail at scale

### 1.2 Form D (existing, mature)

- **Project:** `ltdalxkhbbhmkimmogyq.supabase.co`
- **Key tables:**
  - `form_d_filings` — 358,765 rows (live count 2026-05-17 via POC4)
  - `cross_reference_matches` — 72,558 rows. **This is the working bridge from Form D filings → ADV adviser CRD**
  - `compliance_issues` — 150,000 (different use case, ignore for intel)
  - `enriched_managers` — 3,400 rows (where the existing enrichment engine writes)
- **Critical column gotchas:**
  - `linked_adviser_crd` is **a dead column** (NULL for all 330k rows). Do NOT use.
  - The working bridge is:
    ```sql
    form_d_filings.accessionnumber
      → cross_reference_matches.formd_accession
      → cross_reference_matches.adviser_entity_crd
      → advisers_enriched.crd
    ```
  - Anthropic-specific coverage: only 14 of 85 Anthropic-matched filings (16%) appear in `cross_reference_matches`. Other 71 need other resolution (or accept unresolved).
- **Useful fields on `form_d_filings`:**
  ```
  entityname, sec_number, cik (= filer CIK, NOT adviser CIK),
  filing_date (mixed formats: "25-APR-2025" for old rows, ISO "2026-04-14" for new),
  totalofferingamount, related_names (pipe-separated list),
  related_roles (pipe-separated, parallel to related_names),
  series_master_llc (extracted from "a series of X LLC" pattern),
  accessionnumber
  ```

### 1.3 N-PORT (built this session, isolated subsystem)

- **Project:** `figvonwrlcpveyceengf.supabase.co` (created by ChatGPT during this session)
- **Service key:** in `/private/tmp/nport-buildout-claude/.env` as `SUPABASE_SERVICE_KEY_NPORT` (git-ignored, owner-read-only)
- **Branch:** `nport-buildout-claude` on github.com/MMMuller93/adv-cross-reference-tool
  (5+ commits beyond what's on GitHub — local-only after my last push at `cd6ad01`; ChatGPT made further commits up to `b737de7`)
- **Live row counts** (verified via REST API, 2026-05-14):
  ```
  nport_holdings:           315,872
  nport_filings:             57,407
  nport_registrants:          1,589
  nport_identifiers:        667,711 (after dedup — was 1.04M with broad-filter noise, now narrowed)
  private_companies:            843 (seeded from Wikipedia unicorn list + manual curation)
  private_company_aliases:      924 (exact_normalized + prefix + regex + vendor_code patterns)
  sanctioned_securities:         30 (OFAC Russia exclusion list)
  ```
- **Critical N-PORT gotchas:**
  - **`fund_ncen_records` is EMPTY (0 rows)** — the N-CEN scraper code exists but never ran. This breaks the N-PORT→ADV bridge.
  - **`nport_registrants.adv_crd` is NULL on every row** (same root cause)
  - **`nport_company_positions_mv` was 0 rows** for a while; later refreshed to 52,453 rows. Verify status before relying on it.
  - **`fund_portfolio_managers` is empty** — N-1A scraper code exists but never ran.
- **All 26 historical quarters loaded:** 2019Q4 → 2026Q1, plus 762 daily-scrape filings.
- **Resolver achieves 100% recall on Anthropic** (91/91 rows resolve correctly across 15 distinct ISSUER_TITLE strings).

---

## 2. The 153 target CRDs (the universe)

File: `/private/tmp/adv-part2b-scraping/target_crds.json`

153 adviser CRDs identified as holders of tracked private companies (top 25 companies considered). Sources:

| Source | Count |
|---|---|
| N-PORT registrants (large institutional managers) | 83 |
| Form D SPV sponsors (via `cross_reference_matches`) | 70 |
| Form D shorthand patterns (`antr*`, `claude*`) | 2 |
| In multiple sources | 2 |

**Top 10 advisers by tracked-company breadth (verified):**

| CRD | Adviser | # tracked companies |
|---|---|---|
| 108281 | Fidelity Management & Research Co LLC | 23 |
| 106614 | BlackRock Advisors, LLC | 13 |
| 131181 | Lincoln Investment Advisers, LLC | 13 |
| 105496 | T. Rowe Price Associates, Inc. | 12 |
| 107312 | Brighthouse Investment Advisers, LLC | 12 |
| 104517 | Franklin Advisers, Inc. | 11 |
| 110885 | Capital Research and Management Company | 10 |
| 105247 | BlackRock Fund Advisors | 9 |
| 107338 | SunAmerica Asset Management, LLC | 9 |
| 108934 | Voya Investment Management LLC | 8 |

**Quality issues** (already verified):
- 2 CRDs (339778, 334454) have NULL `adviser_name` in `advisers_enriched` — minor data quality gap
- 289 of 750 N-PORT registrant CIKs unresolved to CRDs — N-CEN backfill would add ~50-150 more CRDs

---

## 3. The build plan (5 phases, with stress-test corrections baked in)

Original plan from user's spec, refined after Codex review (NEEDS WORK verdict) and verification agents. **Phases are NOT calendar timeline — they're dependency order. Do all in parallel where possible.**

### Phase 0 — PREREQUISITES (must happen before Phase 1)

**Revised after stress-test (2026-05-15)** — the original "26 quarters / ~84K filings / ~5h" framing was wrong. The actual scraper at `nport/enrichment/ncen_ingest/backfill_live.py` is CIK-by-CIK, fetching the **latest** N-CEN per registrant from SEC submissions JSON. Real wall-clock: **1.5–2.5h for ~1,549 unprocessed CIKs**. The 41 N-CEN rows already in `fund_ncen_records` came from commit `2c2a67f`'s `--execute` preflight run (commit message: "live preflight with fund_ncen_adviser_links=879"). Those 41 CIKs should be SKIPPED by the next run (use `--include-existing` only if you want to refresh them).

**Three load-bearing bugs in the current `backfill_live.py` that MUST be fixed before a full-scale run** (stress-test verified):
1. `backfill_live.py:407-414` only writes `nport_registrants.adv_crd` when **EXACTLY ONE** unique primary adviser CRD exists across all series for a CIK. Multi-adviser registrants are silently skipped — caps ceiling at ~79.2%.
2. `backfill_live.py:418` writes the parsed CRD to `nport_registrants.adv_crd` **without validating it exists in `advisers_enriched`**. Confidence is hardcoded to 100. Silent data corruption at scale.
3. 429 rate-limit responses become per-CIK exceptions in `backfill_live.py:147` and `:493` — logged and skipped. Under SEC's 10 req/s ceiling on a 1,549-CIK run, this silently drops CIKs.

**Tasks (in order):**

- [ ] **0a. Code fixes to `backfill_live.py`:**
  - 429 retry with exponential backoff + `Retry-After` header parsing (wrap the two `requests.get` calls in `fetch_latest_ncen`)
  - Checkpoint to Supabase every 100 CIKs (currently holds everything in memory until final upsert — mid-run crash discards all work)
  - **Multi-adviser fallback:** when multiple primary CRDs exist for a CIK, pick the most-common (`method='ncen_most_common', confidence=75`) rather than skip. Series-level detail remains in `fund_ncen_adviser_links`. Lifts ceiling from 79.2% → **89.1%** (POC1 projection).
- [ ] **0b. Run the backfill with `--execute`** against all 1,549 unprocessed N-PORT registrants (latest-N-CEN-per-CIK mode). Estimated wall-clock: 1.5–2.5h.
- [ ] **0c. Post-backfill validation pass.** For every row in `nport_registrants` with `adv_crd` populated, verify the CRD exists in `advisers_enriched`. Buckets:
  - **B1: Resolved-and-in-ADV** (target metric)
  - **B2: Resolved-not-in-ADV** (foreign/terminated/retired — flag for cleanup)
  - **B3: Multi-adviser-fallback** (most-common pick, confidence=75)
  - **B4: No-CRD-parsed** (N-CEN exists but no `investmentAdviserCrdNo`)
  - **B5: No-N-CEN-found** (CIK has no submissions)
  - **B6: Parser-failure** (XML malformed or scraper bug)
- [ ] **0d. Target metric:** **≥85% in (B1 + B3-validated)** for the 1,589 N-PORT registrants. POC1 projects 89.1% achievable with multi-adviser fallback; 79.2% without. The series-level `fund_ncen_adviser_links` table remains available for downstream queries needing the full multi-adviser detail.
- [ ] **0e.** N-CEN service key check before kickoff: confirm `SUPABASE_SERVICE_KEY_NPORT` at `/private/tmp/nport-buildout-claude/.env` is still readable. If not, re-fetch from Supabase dashboard before starting.

**Removed from scope (was previously here):**
- 26-quarter historical N-CEN backfill — not implemented in current scraper, also not needed for the bridge. Moved to V1.1 backlog.
- Path B "fuzzy stub" — rejected. R1 above hits ≥85% cleanly with ~2h of work.

### Phase 1 — Typed evidence model + cross-source join

**Architecture (stress-test revised, 2026-05-15):** Codex flagged that the previous "two sections + cross-link" approach was still semantically leaky. Adopting Codex's typed evidence model — four separate evidence tables, one adviser_resolution_link table — to prevent confusing issuers, holders, advisers, sponsors, and funds:

```
Evidence tables (raw, immutable):
  nport_position                       — N-PORT holding row (registrant + issuer + value)
  formd_direct_issuer_offering         — Form D where filer IS the tracked company
                                         (NOT holder evidence — offering context only)
  formd_pooled_vehicle_offering        — Form D where filer is a pooled vehicle holding
                                         the tracked company (SPV, fund, series LLC,
                                         feeder, fund-of-funds — all holder evidence)
  adv_private_fund_match               — ADV Schedule D fund record matching Form D
                                         (via cross_reference_matches)

Adviser resolution (link table, reviewable):
  adviser_resolution_link(
    source_key,        — fk to one of the evidence tables above
    crd,               — resolved CRD (must exist in advisers_enriched)
    method,            — 'ncen_xref' | 'ncen_most_common' | 'cross_ref_match'
                       | 'entityname_alias' | 'series_master_parse' | 'manual'
    confidence,        — 100 / 75 / 50 (per method)
    status             — 'auto' | 'reviewed' | 'rejected'
  )
```

**POC2 finding that simplifies V1:** Zero direct-issuer Form D filings exist for Anthropic in our current DB (`ispooledinvestmentfundtype = TRUE` on all 88 matched filings). Anthropic PBC's own raises (CIK 1839804) return 0 rows. So `formd_direct_issuer_offering` will be empty for V1's seeded companies — the table exists for future-proofing but doesn't need population logic today.

**Output report (per company) labels everything by evidence type:**
```
Company: Anthropic
├── Section A — Registered-fund holders (N-PORT)
│   ├── Fidelity Contrafund                 $187M   Series E,F   Manager: FMR
│   ├── T. Rowe Price Global Technology     $89M    Series F-1   Manager: TRPA
│   └── ...41 registrants total             (NO PM names in V1 — fund_portfolio_managers empty)
├── Section B — Pooled-vehicle holders (Form D)
│   ├── CGF2021 LLC series (Sydecar)         34 filings, $X total       Bridged: yes (1 adviser)
│   ├── Claude SPV I / II (Armyn Capital)    2 filings                  Bridged: yes
│   ├── Claude QP I / I QP (Wefunder)        2 filings                  Bridged: yes
│   ├── Hiive Advisors series                6 filings                  Bridged: yes
│   ├── (70 additional pooled vehicles)      $162M+ disclosed           Bridged: no — V1.1 work
│   └── ...
└── Section C — Cross-linked advisers (same firm in BOTH source families)
    └── Advisers appearing in both N-PORT (as registered-fund mgr) AND Form D (as
        pooled-vehicle sponsor), linked by CRD. Labeled "same firm in both source
        families" — NOT "same fund" (Codex warning: cross_reference_matches doesn't
        link to N-PORT positions; would be a false claim).
```

**Tasks:**

- [ ] **1a.** Create the 4 evidence tables + adviser_resolution_link table (migration). Tables live in the N-PORT Supabase project (since it's where the join orchestration lives).
- [ ] **1b.** Python script `intelligence/fund_holders_query.py --company anthropic --output csv`
- [ ] **1c. N-PORT section:** Query `nport_company_positions_mv` → resolve registrant via `fund_ncen_adviser_links` (series-level) → fallback to `nport_registrants.adv_crd` → join `advisers_enriched`. Write rows to `nport_position` evidence table.
- [ ] **1d. Form D section — DUAL resolution path** (critical, addresses POC2/POC4 findings):
  - **Path 1: cross_reference_matches** (existing bridge — only 20% of Anthropic pooled vehicles, 27.5% corpus-wide)
  - **Path 2: direct entityname alias matching** (NEW — was previously deferred but moved to CORE Phase 1 because POC2 showed 80% of Anthropic pooled vehicles are NOT in cross_ref). For each unbridged Form D filing with entityname matching a curated alias, write to `formd_pooled_vehicle_offering` with `method='entityname_alias'`. These rows are surfaced as holder evidence in V1 even when we can't yet identify which adviser manages them — the adviser slot is just left empty. **Adviser resolution for these rows (related_names parse, series_master_llc lookup, etc.) is V1.1 work**, not V1.
- [ ] **1e. Cross-link** at adviser-CRD level only. Label clearly as "same firm in both source families." Cross-link at FUND level is NOT supported (cross_reference_matches links Form D ↔ ADV private fund records, NOT to N-PORT positions — false positive risk).
- [ ] **1f.** Output: structured JSON + CSV. Visual inspection before continuing.

**Dropped from V1 schema:** `pm_name` column. `fund_portfolio_managers` is empty (N-1A scraper code exists but never ran). Adding PM names requires Phase 0 add-on (N-1A backfill, ~3-4h). Moved to V1.1 backlog.

### Phase 1.5 — Source-scoped aliases (stress-test revised)

POC2 corrections: ANTR-* shorthand should NOT be included (no corroborating Anthropic reference in related_names — ALEXTAR VC series are unrelated). Add Claude SPV I/II and LFG Claude patterns. Add CGF2021 LLC as a known Sydecar series-master.

- [ ] Add `pattern_source` column to `private_company_aliases`: `'nport_issuer'` | `'formd_pooled_vehicle'` | `'formd_codename'` | `'formd_series_master'`
- [ ] Curate Form D-specific patterns (POC2-verified to be real Anthropic holders):
  - `^Claude\s+SPV(\s+(I|II))?` (Claude SPV, Claude SPV I, Claude SPV II — Armyn Capital)
  - `^Claude\s+(QP|I QP)` (Claude QP, Claude I QP — Wefunder Advisors)
  - `^LFG\s+Claude` (LFG Claude pooled vehicle)
  - `CGF2021\s+LLC` as `formd_series_master` (dominant Sydecar series-master, 34 Anthropic filings unlocked by bridging this one entity)
  - **DO NOT include** `^ANTR-\d+` (ALEXTAR VC series — not Anthropic-related per POC2)
  - **DO NOT include** `^ANTR\s+CC\s+\d{4}` until corroborating evidence found
- [ ] **Negative-pattern exclusions** (POC2-validated):
  - "Anthropic Capital Fund, LP" (CIK 1931731) — different entity, finance not AI
  - "ANTRUM, INC." — biotech
  - "Claude Preval LLC" — personal name
  - "Carbon Revolution PLC" — Australian auto parts
  - "Recursion Pharmaceuticals" — public biotech
  - "Stripes VI Rainier" — Stripes PE fund (different from Stripe payments)
  - "Pinstripes Holdings" — entertainment
  - "Anyscale Inc" — different AI company
  - "Under Canvas Inc" — glamping
  - "Community Philanthropic Ventures" — false match from regex
- [ ] Verify against 5-company gold set: Anthropic, OpenAI, SpaceX, Stripe, Databricks. Track precision/recall per alias pattern.

### Phase 2 — Materialize `company_formd_matches` table (Codex revision)

Codex flagged: live `ILIKE ANY` on 330K Form D rows = slow. Materialize.

- [ ] Add a trigram index on `form_d_filings.entityname`: `CREATE INDEX idx_formd_entityname_trgm ON form_d_filings USING gin (entityname gin_trgm_ops)` — drops 0.7s queries to <50ms
- [ ] Create `company_formd_matches` table: `(company_id, accessionnumber, matched_field, matched_alias, confidence, reviewer_status)`
- [ ] Weekly refresh job (user said "weekly updates fine for refresh")

### Phase 3 — ADV structured-data extraction (stress-test verified)

**POC1 confirmed:** the coverage check (now in `intelligence/stress-test-findings/coverage-check/findings.md`) verified that 153/153 target CRDs exist in `advisers_enriched`, with **82.4% "fully usable"** (any-website + named contact + AUM > 0) using only structured Part 1 fields. **ADV Part 2 scraping is NOT needed for V1.**

- [ ] Use the **canonical-domain selector** from POC3 (production-ready function at `intelligence/stress-test-findings/poc3-canonical-domain/canonical_domain.py`) as the website resolver instead of trusting `primary_website` raw. **POC3 verified: 88.2% of noisy CRDs recover their first-party website** — Fidelity → fidelity.com, BlackRock → blackrock.com, T. Rowe → troweprice.com, Capital Group → pro.capitalgroup.com. The selector handles the case-sensitivity bug (uppercase HTTP://) that the original coverage logic was silently dropping.
- [ ] Build extractor that pulls these fields from `advisers_enriched` for each resolved CRD:
  - `adviser_name`, `crd`, `total_aum`, `phone_number`, `cco_name`, `cco_email`, `signatory_name`, `owner_full_legal_name`
  - **canonical_website** (via selector — falls through to `other_websites` when primary is noisy)
  - `form_adv_url` for source linking
- [ ] Output: per-firm structured-data block in the report. NO web enrichment needed for these firms — they ship with V1.

**Coverage projection (POC1+POC3-validated, stress-test witness corrected):**
- **Any-usable-website:** 134/153 CRDs (87.6%) — using the canonical-domain selector to fall back to `other_websites` when `primary_website` is noisy. POC3 verified.
- **Fully usable (website + named contact + AUM > 0):** 126/153 CRDs (82.4%). POC1 coverage check.
- **Real Phase 4 enrichment targets:** 17 zero-website advisers + 6 social-only advisers = ~23 firms. These are the only CRDs needing web enrichment.

### Phase 4 — Targeted web-enrichment for the gap (POC3-scoped)

**Stress-test rescoped:** the original "~500 firms" estimate was wrong. POC3 identified the real target: **23 firms** (17 zero-website + 6 social-only). Highest-impact firm in this set: **Lincoln Investment Advisers (CRD 131181)** — 13 tracked companies, completely empty across all contact fields, possibly a nominee/shell entity (AUM only $1.9M).

- [ ] Identify intel rows where canonical-domain selector returned None or no contact email exists in `advisers_enriched`. Expected size: ~23 firms.
- [ ] Trigger enrichment via `enrichManager(name)` (NOT `enrichAndSaveManager`) — we control persistence, the engine doesn't write to `enriched_managers` directly.
- [ ] **Write results to a NEW `intel_enrichment` table** in the N-PORT Supabase project (where the intel join orchestration lives). Codex was explicit: writing to `enriched_managers` would collide with the realtime_enrichment daemon polling `form_d_filings WHERE potential_new_manager=true`. Schema: `(crd, firm_name, website, contact_paths jsonb, source, enriched_at)`.
- [ ] Parallel pool of 4 workers, 3s delay each, ~3 min for 23 firms.
- [ ] **Cost: ~$0.07** (23 firms × $0.003) — within Brave free tier (2000/month).

**Engine quirks to know:**
- Brave 2000/month → Google 100/day → Serper (often exhausted, auto-disabled after 3 failures)
- Skip patterns: AngelList, Sydecar, fund admin platforms
- LinkedIn personal profile scraping is blocked; LinkedIn company page discovery from website HTML works
- Twitter validation is weak (site-specific search often finds wrong accounts)
- Engine entry points: `enrichManager(name, options)` at `enrichment/enrichment_engine_v2.js:1330` (pure name input, no CRD needed, doesn't write).

### Phase 5 — Gold-set evaluation (Codex revision — do this BEFORE UI)

- [ ] Run end-to-end on Anthropic, OpenAI, SpaceX, Stripe, Databricks
- [ ] Measure: total firms found, % with website, % with named PM/CCO, % with email, false-positive count
- [ ] Spot-check 20 rows manually vs SEC filings
- [ ] Document failures: which firms didn't resolve, which got wrong data

### Phase 6 — CSV export + thin UI

User's call: **"csv fine for now, unless UI easy based on PFR website/UI"**

- [ ] `intelligence/export_csv.py --company anthropic` produces standalone CSV
- [ ] If existing PFR UI patterns (or ChatGPT's 3010 UI) reusable: lightweight web page with search-by-company, table, filters, CSV download
- [ ] Else: skip UI, ship CSV-only

### Phase 7 — V1 Limits (document explicitly)

V1 ships with these explicit, documented limits — they are NOT bugs:

- **Seeded-only company universe.** V1 covers the 843 companies in `private_companies` + 924 aliases. New companies require adding aliases + re-running the join. Dynamic onboarding deferred to V1.1.
- **No portfolio manager names.** `fund_portfolio_managers` is empty (N-1A scraper exists but never ran). Reports show fund manager firm + signatory, not individual PM bios. PM names deferred to V1.1 (needs N-1A backfill, ~3-4h).
- **No 26-quarter historical N-CEN.** Phase 0 backfills the LATEST N-CEN per registrant only (sufficient for the bridge). Historical backfill not implemented in current scraper.
- **No Form D series-LLC parsing.** The "a series of [X] LLC" pattern (15,030 filings in corpus) is not parsed in V1 — these are handled via direct entityname alias matching when the entity name itself contains a tracked company. Deferred to V1.1.
- **No 13F/13D/G/144/N-CSR/N-PX/N-Q.** Codex confirmed N-PORT is the right primary source for registered-fund holders. Other forms either don't apply to private companies (13F's Section 13(f) list is exchange-traded only; 13D/G only for >5% in registered securities) or are deferred (N-CSR text mining).
- **No ADV Part 2 brochures.** POC1 verified 82.4% coverage from Part 1 structured fields alone. Part 2 scraping deferred indefinitely (the existing `adv-part2b-scraping` branch has witness-flagged bugs and the marginal value is low).

### Phase 8 — V1.1 Backlog (post-V1 priorities, in rough order)

Stress-test surfaced specific high-yield items to add after V1 ships:

1. **Form D `a series of [X] LLC` extraction** (~15K filings). Pure string parse, no API calls. Unlocks the Sydecar/Republic/Wefunder pooled-vehicle ecosystem at scale. POC4 spot-check found 403+ filings with direct tracked-company references in entityname that V1's alias matching may miss.
2. **Adviser resolution for entityname-matched unbridged Form D filings.** V1 surfaces the pooled-vehicle holder evidence via entityname matching (Phase 1, Path 2) but leaves the adviser slot empty when neither `cross_reference_matches` nor the entityname pattern lets us identify the manager. V1.1 closes those gaps: parse `related_names` for adviser CRDs, look up `series_master_llc` against `advisers_enriched`, hit external sources where SEC data is insufficient. The Form D rows themselves are already in V1; V1.1 just adds the "managed by X" attribution.
3. **PM names via N-1A backfill.** Wire up the N-1A scraper (exists at `nport/enrichment/n1a_ingest/` on `nport-buildout-claude`, never ran). Populate `fund_portfolio_managers`. Adds "PM: Danoff" style attribution.
4. **Dynamic company onboarding CLI.** `intelligence/add_company.py --name "Foo Inc" --aliases "Foo,Foo Inc"` that inserts to `private_companies` + `private_company_aliases` + re-runs the join. ~30 min to build, makes the tool self-service for new tracked companies.
5. **Multi-adviser registrant improvement.** Beyond the most-common fallback in Phase 0, allow per-series resolution (use `fund_ncen_adviser_links` directly when querying specific fund positions). Improves precision on variable-annuity sub-account complexes (SunAmerica, Voya).
6. **Historical 26-quarter N-CEN backfill.** Wire `daily_ncen.py` (which already walks form.idx) to a Supabase upsert loop. Enables time-series queries ("how has Anthropic ownership shifted across funds since 2020?"). ~5h wall-clock.
7. **Email pattern matching** for known firms (firstname.lastname@domain.com heuristic) — only after verifying it doesn't produce hallucinated addresses. User said earlier this is open; revisit when V1 data is in.
8. **LP counts from ADV Section 7.B(1).** Available data, but framing matters — those describe the adviser's *other* private funds, NOT the N-PORT registered fund itself. Surface in UI only with correct labeling.
9. **UI** (lightweight web page) if ChatGPT's localhost:3010 patterns turn out to be reusable. Else CSV-only is fine.

---

## 4. Where it lives, how to set up

### Branch & location

- **New branch off master:** `fund-holders-intel` (NOT off `nport-buildout-claude`; keep separate)
- **New top-level subfolder:** `intelligence/` (matches existing pattern of `enrichment/`, `data-pipeline/`)
- **Language:** Python for join + enrichment trigger. Node for API endpoint (matches existing `server.js`). React for UI (matches existing `public/app.js`).

### Suggested file structure

```
PrivateFundsRadar/
├── intelligence/                          (NEW)
│   ├── fund_holders_query.py              (Phase 1: the core join)
│   ├── enrichment_trigger.py              (Phase 4: thin wrapper around engine)
│   ├── company_formd_matches_refresh.py   (Phase 2: weekly MV refresh)
│   ├── export_csv.py                      (Phase 6: CSV output)
│   ├── gold_set_eval.py                   (Phase 5: quality measurement)
│   ├── tests/
│   └── README.md
├── routes/
│   └── intel.js                           (Phase 6: API endpoints, optional)
└── public/
    └── intel_pages.js                     (Phase 6: React UI, optional)
```

### Environment setup

```bash
# Use uv venv (system Python 3.14 on macOS has broken pyexpat — see learnings)
uv venv .venv && source .venv/bin/activate
uv pip install requests supabase pydantic instructor anthropic pymupdf4llm pytest

# Existing .env at repo root has SUPABASE_URL + SUPABASE_SERVICE_KEY (for Form D)
# Hardcoded ADV anon key in server.js:190 (fine for reads)
# N-PORT credentials at /private/tmp/nport-buildout-claude/.env (SUPABASE_SERVICE_KEY_NPORT)
# Anthropic key: $ANTHROPIC_API_KEY required for enrichment trigger
```

---

## 5. Tooling, credentials, and gotchas the new session WILL hit

### macOS Python quirk
**System Python 3.14 (Homebrew) on macOS has a broken pyexpat** (`Symbol not found: _XML_SetAllocTrackerActivationThreshold`). Pip install fails on many packages. Use `uv venv` (creates a Python 3.12 venv automatically).

### Postgres locale quirk (if testing schemas locally)
**Homebrew Postgres 17 needs `LC_ALL=C` and `--locale=C` for initdb** or it fails with `postmaster became multithreaded during startup`. Example:
```bash
export LC_ALL=C
/opt/homebrew/opt/postgresql@17/bin/initdb -D /tmp/pgtest --auth=trust --username=test --locale=C
```

### Codex CLI on ChatGPT account
- Models gpt-5, gpt-5-codex, gpt-5.1 are NOT authorized on ChatGPT accounts
- gpt-5.5 works only with CLI ≥ 0.100.0
- Earlier in the session we hit `codex-cli 0.41.0` errors; user upgraded to 0.130.0
- If `/codex` fails, write the code in main context instead

### Anthropic API 529 Overloaded
**Common during peak hours.** Multiple agent retries failed in this session (schema build, pipeline build). Two mitigations:
1. Wait 30 min + retry
2. Fall back to writing code in main context (no API dependency)

### SEC bulk file URL patterns vary by month
Some months: `https://www.sec.gov/files/adv-brochures-2024-december.zip`
Other months: `https://www.sec.gov/adv-brochures-2024-september.zip` (no `/files/` prefix)
Some are split into N parts: `adv_brochures_2024_mar_{1..10}_of_10.zip`
Some use abbreviations: `jan` instead of `january`

**Don't trust a single URL pattern.** HEAD-check candidates.

### EDGAR rate limits
SEC requires `User-Agent: Name email`. Max 10 req/sec. Honor 429 backoff (exponential).
Pattern in `data-pipeline/formd-scraper/daily_scraper_with_alerts.py:53` is the reference implementation.

---

## 6. Side-quest status: ADV Part 2 brochure scraping

**Branch:** `adv-part2b-scraping` (3 commits on it, local-only — not pushed)
- `70937ea` schema migration (3 new tables, verified vs local Postgres)
- `f23dd61` Phase 1+2 pipeline (bulk-ZIP download + selective extract + text)
- `eecfc7e` Phase 3+4 (LLM extract with Pydantic + Supabase upsert + CLI)

**Witness agent found multiple critical bugs — DO NOT DEPLOY AS-IS:**

1. **Mapping CSV scarcity** — SEC publishes the brochure mapping CSV for only ONE month (March 2024). The pipeline silently does nothing for any other month.
   - **Fix:** Use the PDF filename convention `{CRD}_{filingid}_{seq}_{date}.pdf` to extract CRD directly — no mapping CSV needed.
2. **Classifier silent drops** — `normalize_brochure_part` regex misses 30 of 108 target-CRD brochures (28%), including Coatue, BlackRock Fund Advisors, T. Rowe Price, PGIM, General Atlantic. Names like `"PART 2 BROCHURE"`, `"ADV PART II"`, `"MFS BROCHURE"`, `"BLACKROCK FUND ADVISORS - BROCHURE"` don't match.
   - **Fix:** Stop pre-filtering by brochure_part. Let the LLM tell us what type it is from the content.
3. **README INSERT example uses wrong column name** (`pdf_url` doesn't exist; should be `source_zip_url` or similar).
4. **NULL ≠ NULL in UNIQUE constraint** — `brochure_version` is nullable. Two rows with NULL version + same other keys both insert. Idempotency breaks.
5. **Mixed 2A/2B regex too narrow** — `"PART 2A AND PART 2B"` misclassified as 2B only.

**Plus 11 lower-severity issues** in the witness report (page-count broken, `--llm-only` flag advertised but not implemented, `--dry-run` doesn't actually prevent Supabase writes, exception path conflates scanned vs broken PDF, etc.). Full report at `/private/tmp/claude-502/.../tasks/a06320c83e70fd5e8.output` (jsonl, parseable).

### Open decision the user is mulling

**"isn't `advisers_enriched` enough already?"** — the 54 structured columns in ADV Part 1 already give us 80% of what the intel use case needs (firm name, AUM, phone, CCO email, signatory, website, owners, Form ADV URL). What ADV Part 2 uniquely adds:
- PM bios (education, prior employers, certifications) — useful but niche
- Firm strategy/fee narrative — useful but extractable on demand
- The `key_personnel_emails` field — emails found in the brochure text

Three paths the user is choosing between:

- **(0) Don't scrape Part 2 at all** — start with `advisers_enriched` data + existing enrichment engine. Probably the right V1.
- **(1) Scrape only Part 2A** (firm brochures) — adds strategy/fee/conflict narrative. Easier than 2B.
- **(2) Scrape Part 2B** (PM supplements) — adds individual PM bios. Highest unique value. Hardest extraction (more varied formats).

**Likely answer: (0) for V1.** Test the intel pipeline against `advisers_enriched`-only first. If coverage is poor for the firms we care about, then upgrade to (1) or (2).

---

## 7. The N-PORT subsystem (separate context — may need to interact with it)

A complete self-contained N-PORT subsystem exists on branch `nport-buildout-claude`. Don't re-read all of `PLAN_NPORT_HOLDINGS.md` unless you need internals. Key facts:

- Lives at `nport/` subfolder in the PFR repo (when that branch is checked out)
- Has its own Supabase project (`pfr-nport`)
- Has its own Express server on port 3010 (`nport/api/server.js`)
- Has its own static frontend at `nport/frontend/`
- **Tested:** 180 tests (136 pytest + 27 node:test + 17 e2e Postgres integration)
- **NOT MERGED to master** — strict isolation maintained
- **Resolver achieves 100% recall on Anthropic** — 91/91 holding rows resolve correctly

The intel pipeline READS from this Supabase project for the N-PORT side of the join. Doesn't modify it.

### To start the N-PORT API for local cross-DB testing

```bash
cd /Users/Miles/projects/PrivateFundsRadar
git worktree add ~/nport-verify nport-buildout-claude
cd ~/nport-verify
cd nport/api && npm install
cd .. && set -a && source /private/tmp/nport-buildout-claude/.env && set +a && node api/server.js
# → http://localhost:3010
```

The .env in `/private/tmp/nport-buildout-claude/` has the N-PORT Supabase credentials. The Express server on 3010 has 16 routes serving the data.

---

## 8. Critical user guidance from this session (DIRECT QUOTES — these are non-negotiable)

These are the user's actual words. Internalize them; don't violate them.

### Process / scope

> "dont split out into months or quarters, we want to just build now and there no reason for splitting out it so long when we can ai code agents build much more quickly, dont randomly assign old school engineering team timelines for no reason"

> "for tracked companies we should just do as many as possible or add for any in the nPor P filings"

> "dont worry any user features like accounts/paywall, this is for our use"

> "dont randonly limit to 'five fund familtes', dont randomly take things out of scope if there are more funds/ nport filiers/funds identied in filings that we'd want to track"

> "What does success look like for a single company- dont be limiting, should try our best to find the main contact info, etc for any fund, not just some subset"

### Verification rigor (this session's hard lesson)

> "have agent or something verify your approach and final data quality"

> "reviewer/winess agent monitor work, separate one to verify at end, keep you honest"

User has caught me self-rationalizing multiple times. **Spawn a witness agent for any non-trivial work**. The witness in this session caught 6+ critical bugs the schema/pipeline agents missed.

### Output / refresh

> "csv fine for now, unless UI easy based on PFR website/UI and what chatgpt did at http://127.0.0.1:3010/"
> "weekly updates fine for refresh"
> "Standalone" (in answer to "BEHIND feature flag or standalone tool")

### Architecture isolation

> "make sure we dont break anything the existing projects or resources in Private Funds Radar uses, create a subfolder or isolated project folder or github branch/tree/whatever appropriate so we can work on this project discretely"

User has explicitly required isolation. Branch off master. New subfolder. No modifications to existing files unless explicitly approved.

### Memory rule (from existing CLAUDE.md, very important)

> "i constantly give you a ton of good info and feedback, you remember it for like 4 min, and then it disappears"

UPDATE MEMORY.md immediately when receiving user feedback. Don't batch.

---

## 9. Anti-patterns to avoid (lessons from this session)

| Anti-pattern | Why it failed | What to do instead |
|---|---|---|
| Self-validating my own work | Witness caught 6+ critical bugs I'd called "verified" | Spawn a witness agent for non-trivial work |
| Imposing phase gates with month/quarter timelines | User pushed back — "AI agents work faster than that" | Phases as dependency order only, no calendar attached |
| Picking a single URL pattern for SEC bulk files | Different months use different conventions | HEAD-check multiple candidate URLs; handle split-month patterns |
| Trusting first response from a single sub-agent | Several agents 529'd or returned wrong shapes | Multiple retries + fallback to main-context implementation |
| Assuming column existence without querying | Caught claiming `pdf_url` column exists — it doesn't | Query the live schema before referencing column names |
| Skipping the "Part 2B was never actually scraped" check | Spent time on side-quest before realizing Part 1 data might be enough | Audit existing structured data BEFORE building extraction pipelines |
| Hard-coding 5/10/100 as scope caps | User: "dont randomly limit" | Process all if scoping doesn't have a concrete justification |

---

## 10. Tools available

- **Existing PFR codebase** — full read access, mature
- **3 Supabase projects** — credentials in `.env` files (see §1)
- **Existing enrichment engine** at `enrichment/enrichment_engine_v2.js` — directly callable via `enrichAndSaveManager(name)`
- **N-PORT subsystem** at branch `nport-buildout-claude` — provides the holdings + private companies + aliases data
- **Witness/reviewer agent pattern** — use it
- **`/codex` skill** — works with CLI ≥ 0.100.0 on `gpt-5.5`. Useful for second-opinion review.
- **`/stress-test` skill** — adversarial verification of plans before building
- **`/parallel-orchestrator` skill** — for spawning multiple parallel agents
- **`docs/SEC_FORM_ADV_FORM_D_REFERENCE_GUIDE.md`** — 41KB reference doc (read if confused about SEC forms)
- **`docs/ENRICHMENT_ENGINE_LOGIC.md`** — 24KB internal docs on the existing enrichment

---

## 11. Pointers to ALL existing artifacts

| What | Where |
|---|---|
| **This handoff doc** | `/Users/Miles/projects/PrivateFundsRadar/PLAN_FUND_HOLDERS_INTEL.md` |
| Project memory | `/Users/Miles/projects/PrivateFundsRadar/.claude/MEMORY.md` (and worktree copy at `.claude/worktrees/suspicious-jennings-d82392/.claude/MEMORY.md`) |
| Project rules | `/Users/Miles/projects/PrivateFundsRadar/CLAUDE.md` |
| N-PORT V1 plan | `/Users/Miles/projects/PrivateFundsRadar/.claude/worktrees/suspicious-jennings-d82392/PLAN_NPORT_HOLDINGS.md` |
| N-PORT branch | `nport-buildout-claude` on github.com/MMMuller93/adv-cross-reference-tool |
| N-PORT worktree | `/private/tmp/nport-buildout-claude/` (with .env containing Supabase creds) |
| Target CRDs JSON | `/private/tmp/adv-part2b-scraping/target_crds.json` |
| ADV Part 2 scraping branch (partial, buggy) | `adv-part2b-scraping` (local-only, not pushed) |
| ADV Part 2 worktree | `/private/tmp/adv-part2b-scraping/` |
| Stress-test research findings | `/private/tmp/nport_research/*.md` (multiple files, may have been cleaned up — see ChatGPT's parallel branch for copies at `/Users/Miles/projects/PrivateFundsRadar-nport-stabilize/`) |
| Existing enrichment engine | `enrichment/enrichment_engine_v2.js` (entry points at lines 1330, 1951) |
| Form D daily scraper (the reference pattern to copy) | `data-pipeline/formd-scraper/daily_scraper_with_alerts.py` |
| SEC ADV mapping CSV (verified March 2024 only) | `/tmp/adv_brochures_mappings/adv-brochure-mapping-202403.csv` (2.17 MB, latin-1 encoded) |
| Existing PFR API server | `server.js` (read-only — don't modify on this branch) |
| Existing PFR React app | `public/app.js` (read-only) |

---

## 12. First steps for new session

**Stress-test completed 2026-05-15** — most of the original "first steps" are now done. The plan above incorporates the findings. If you're coming into this cold, here's the actual sequence:

1. **Read this doc completely.** The "Phase 0" → "Phase 8" sections reflect the post-stress-test plan.
2. **Read `.claude/MEMORY.md`** — slim 132-line version, has the database state + gotchas.
3. **Stress-test artifacts** are preserved at `intelligence/stress-test-findings/` on the `fund-holders-intel` branch (kept as audit trail of why decisions were made). Notable files:
   - `coverage-check/findings.md` — 153 target CRDs analyzed (82.4% fully usable)
   - `poc1-ncen-buckets/findings.md` — bridge ceiling analysis (89.1% with multi-adviser fallback)
   - `poc2-formd-classifier/findings.md` — Anthropic Form D classified (88 pooled vehicles, 0 direct-issuer)
   - `poc3-canonical-domain/canonical_domain.py` — **production-ready** website selector function
   - `poc4-pooled-vehicle-universe/findings.md` — V1.1 opportunity sizing
4. **All product decisions are locked** (see §13). Don't re-litigate — move to Phase 0.
5. **Spawn a witness agent** alongside any non-trivial code. Codex's review in this session caught 3 substantive bugs the implementing agents missed; witness pattern is non-negotiable.
6. **Update MEMORY.md as you go** — don't batch.

---

## 13. Product decisions — RESOLVED (post stress-test, 2026-05-15)

All major V1 decisions are locked. Recording them here so future sessions don't re-litigate.

- [x] **N-CEN backfill vs fuzzy-match stub:** Path A (N-CEN backfill) — with the multi-adviser fallback fix from R1, this hits 89.1% (well above the 85% target). Path B stub rejected.
- [x] **Part 2 scraping yes/no for V1:** NO. Option (0). POC1 verified 82.4% coverage from Part 1 structured fields alone. Existing `adv-part2b-scraping` branch has witness-flagged bugs and the marginal value is low. Deferred indefinitely.
- [x] **PM names for V1:** Drop. `fund_portfolio_managers` is empty. N-1A backfill is V1.1 work. V1 reports show fund manager firm + signatory, not individual PM bios.
- [x] **Typed evidence model:** Adopt now. Phase 1 restructured around 4 evidence tables + adviser_resolution_link (per Codex). Prevents the issuer-vs-holder semantic bug from recurring.
- [x] **Unseeded companies:** V1 = seeded-only. Document the limit. Dynamic onboarding deferred to V1.1.
- [x] **Where intel writes:** New `intel_enrichment` table in the N-PORT Supabase project (which is where the intel join orchestration lives). NOT `enriched_managers` in Form D DB (Codex was explicit — would collide with realtime daemon).
- [x] **Storage architecture:** All-Supabase. Was a question during NPORT design; resolved — we read from all three projects and write joined output to N-PORT project.
- [x] **UI yes/no for V1:** CSV-only for V1. Lightweight UI deferred to V1.1 pending review of ChatGPT's localhost:3010 patterns.
- [ ] **Email pattern matching** (`firstname.lastname@firm.com` heuristic): still open. Revisit after V1 ships and we see how many firms lack disclosed emails. Default for V1: only return emails actually disclosed in filings (no synthesis).

---

## 14. Cost expectations (stress-test rescoped)

- **Phase 0 (N-CEN backfill):** $0 — SEC bulk download + Python parsing. **~1.5–2.5h wall-clock** (revised from 5h — the scraper is latest-per-CIK, not 26-quarter historical).
- **Phase 1 (typed-evidence join + direct alias matching):** $0 — Python SQL queries.
- **Phase 2 (materialize Form D matches + trigram index):** $0 — SQL.
- **Phase 3 (ADV data extraction + canonical-domain selector):** $0 — pure SQL + a small Python helper.
- **Phase 4 (enrichment trigger):** ~$0.003/firm × **~23 firms = ~$0.07 OpenAI cost** (revised from $1.50 after POC3 — POC3's canonical-domain selector recovered 88.2% of noisy CRDs, leaving only 23 firms to enrich). Within all free-tier API quotas.
- **Phase 5 (gold-set eval):** $0
- **Phase 6 (CSV export):** $0
- **Phase 7 (V1 limits documentation):** $0
- **Phase 8 (V1.1 backlog):** itemized in §8 above; biggest cost is N-1A backfill compute, all SEC-free.

**Total to ship V1:** **~$0.07** OpenAI cost. Wall-clock: Phase 0 ~2h + Phase 1-6 a few hours each = ship in one to two work sessions.

---

## 15. Coordinate with parallel work

ChatGPT has been doing a parallel build on `codex/nport-stabilize` branch at `/Users/Miles/projects/PrivateFundsRadar-nport-stabilize/`. They worked on the same N-PORT subsystem (separately, both branches resolved the same 5 integration bugs). They also did the live Supabase provisioning and backfill (which is why the live data exists).

If they're still working in parallel, coordinate via:
- Distinct branch names (`fund-holders-intel-claude` vs `fund-holders-intel-chatgpt` if both want to take this on)
- Use `git diff` to compare deliverables
- Either pick one or merge selectively

---

## 16. Final checklist before declaring V1 done

- [ ] **Phase 0 metric:** ≥85% of 1,589 N-PORT registrants land in B1 + B3-validated (resolved-and-in-ADV, including multi-adviser most-common fallback). All 6 failure buckets reported.
- [ ] **Phase 1 coverage:** Cross-source join for Anthropic produces both Section A (N-PORT registered-fund holders, ~41 funds) and Section B (Form D pooled vehicles, ≥18 bridged + ≥40 alias-matched of 88 total) with NO direct-issuer rows mislabeled as holders.
- [ ] **Gold-set:** End-to-end run on all 5 (Anthropic, OpenAI, SpaceX, Stripe, Databricks). Per-company report with named coverage + false-positive count.
- [ ] **CSV spot-check:** 20 manual reviews against SEC filings. Zero false-positive holders (issuer rows showing as holders).
- [ ] **Branch isolation:** No modifications to existing PFR files (`server.js`, `public/app.js`, `enrichment_engine_v2.js`, etc.) on `fund-holders-intel` branch.
- [ ] **Witness review:** independent witness agent has audited the final pipeline (NOT the same agent that built it).
- [ ] **MEMORY.md** updated with anything learned during Phase 0–6.
- [ ] **CSV export** works for all 5 gold-set companies AND for at least one large-coverage cap company (Fidelity is #1 by tracked-co breadth at 23).
- [ ] **V1 Limits documented** in the output (CSV header note or README) — seeded-only, no PM, no historical N-CEN, no series-LLC parsing.

---

*End of handoff. Good luck. Spawn a witness early and often.*
