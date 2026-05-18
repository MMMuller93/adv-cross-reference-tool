# Fund Holders Intelligence — Codex 5.5 Review Brief

**Author:** Claude (Sonnet 4.7, 1M context)
**Reviewer:** Codex 5.5 / staff engineer
**Date:** 2026-05-17
**Status:** Phase 0a code changes complete, dry-run blocked on credential refresh, awaiting your review before continuing.

This brief is a self-contained handoff. Read it cold and tell me what I got wrong, what assumptions are load-bearing without evidence, and what would break in production.

---

## 1. Product goal in one sentence

For any tracked private company (Anthropic, OpenAI, SpaceX, Stripe, Databricks, …), produce a single CSV that lists every registered mutual fund/ETF (via N-PORT) and every pooled investment vehicle (via Form D) holding shares in that company, with adviser firm name + CRD + AUM + canonical website + named contact paths.

Internal tool. No auth/paywall. CSV-first; UI is V1.1 if at all.

---

## 2. Data sources — four Supabase projects (verified live, 2026-05-15)

| DB | Project ref | Role | Key tables |
|---|---|---|---|
| **ADV** | `ezuqwwffjgfzymqxsctq` | SEC adviser registration data | `advisers_enriched` (40,916 rows / 54 cols), `funds_enriched` (185,525), `adviser_owners` |
| **Form D** | `ltdalxkhbbhmkimmogyq` | Private fund offerings | `form_d_filings` (~330k), `cross_reference_matches` (72,558 — the existing bridge), `compliance_issues` (~150k), `enriched_managers` (3.4k) |
| **N-PORT** | `figvonwrlcpveyceengf` | Registered-fund holdings | `nport_holdings` (315,872), `nport_filings` (57,407), `nport_registrants` (1,589), `nport_identifiers` (667,711), `private_companies` (843), `private_company_aliases` (924), `nport_company_positions_mv` (52,453), `fund_ncen_records` (**41 — needs backfill**), `fund_ncen_adviser_links` (series-level — populated), `fund_portfolio_managers` (0 — empty, deferred to V1.1) |
| **MCP-legacy** | `cmhzafgyixdcnpvkldkg` | DO NOT USE | Legacy. MCP Supabase tools route here by default — must use direct curl for prod work |

**Identifier topology:**
- Three identifier systems intentionally kept distinct: CIK ≠ CRD ≠ SEC file number. The plan crashes if you conflate them.
- `advisers_enriched.cik` is only populated for ~13% of advisers (5,304/40,916), so direct CIK joins between N-PORT and ADV fail at scale. This is why the N-CEN bridge (registrant CIK → CRD via N-CEN filing) is necessary.

---

## 3. Architecture — the intel pipeline

```
Sources (read-only):
  N-PORT DB   →   Section A evidence  (registered-fund holdings)
  Form D DB   →   Section B evidence  (pooled-vehicle offerings)
  ADV DB      →   firm-level enrichment  (CCO, AUM, signatory, website, owners)

Bridge layer:
  N-PORT registrants  ↔  ADV advisers
    via fund_ncen_records (registrant-level latest N-CEN)
    + fund_ncen_adviser_links (series-level — Codex previously flagged
       this as the authoritative table)
    written by nport/enrichment/ncen_ingest/backfill_live.py

  Form D filings  ↔  ADV advisers
    Path 1: cross_reference_matches.formd_accession → adviser_entity_crd
       (existing bridge — but only 27.5% coverage corpus-wide, 20% on
        Anthropic specifically)
    Path 2: direct entityname alias matching against private_company_aliases
       (new in V1 — added because Path 1 leaks 80% of Anthropic pooled
        vehicles)

Typed evidence model (V1 schema — to be created):
  nport_position                       — N-PORT holding row
  formd_direct_issuer_offering         — Form D where filer = tracked company
                                         (NOT holder evidence; offering context)
  formd_pooled_vehicle_offering        — Form D where filer = pooled vehicle
                                         (SPV/fund/series LLC/feeder — IS holder)
  adv_private_fund_match               — ADV Schedule D ↔ Form D bridge
  adviser_resolution_link              — (source_key, crd, method, confidence, status)
       method ∈ {ncen_xref, ncen_most_common, cross_ref_match,
                 entityname_alias, series_master_parse, manual}
       confidence ∈ {100, 75, 50}
       status ∈ {auto, reviewed, rejected}

Output:
  intelligence/fund_holders_query.py --company <slug> --output csv
  intelligence/export_csv.py --company <slug>
```

---

## 4. The universe — 153 target CRDs

File: `/private/tmp/adv-part2b-scraping/target_crds.json` (37KB, 2026-05-14)

153 adviser CRDs derived from:
- N-PORT registrants holding tracked private companies (83)
- Form D SPV sponsors via `cross_reference_matches` (70)
- Form D shorthand patterns (`antr*`, `claude*`) (2)
- In multiple sources (2)

**Top 10 by breadth (tracked-companies held):**

| CRD | Adviser | Tracked cos |
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

---

## 5. What was actually done this session

### 5.1 Stress-test (2026-05-15)

Ran the `/stress-test` skill — six phases. Spawned 3 parallel verification agents + the `/codex` skill for an adversarial review of the original plan. Then 4 POCs based on the findings. All artifacts preserved at `intelligence/stress-test-findings/`.

**Codex's earlier verdict on the original plan:** NEEDS WORK. Three substantive bugs my agents missed:
1. `nport_registrants.adv_crd` is the wrong grain for the bridge — `backfill_live.py:407-414` skips multi-adviser registrants entirely (~11% of universe). Authoritative table is `fund_ncen_adviser_links` (series-level).
2. `backfill_live.py:418` writes CRDs without validating against `advisers_enriched`. Confidence hardcoded to 100. Silent data corruption.
3. The plan's Section B ("Anthropic PBC direct offerings") would have mislabeled the issuer's own Form Ds as holder evidence. Direct-issuer filings are offering context, NOT a holder list.

### 5.2 POCs run (live data verification)

| POC | Finding |
|---|---|
| POC1 — N-CEN bridge ceiling | Current code: 79.2% max. With "pick most-common CRD" fallback: **89.1%** (above 85% target). |
| POC2 — Anthropic Form D classifier | **All 88 matched filings are pooled vehicles** (`ispooledinvestmentfundtype=TRUE`). Zero direct-issuer contamination in our DB. **70/88 (80%) are NOT bridged via `cross_reference_matches`** — the existing pipeline drops them. CGF2021 LLC dominant Sydecar series-master (34 filings). |
| POC3 — Canonical-domain selector | Coverage agent claimed 87.6% but Codex challenged. Real recovery: **88.2%** (45/51 noisy CRDs). Production-ready selector at `intelligence/canonical_domain.py`. Fidelity → fidelity.com, BlackRock → blackrock.com, T. Rowe → troweprice.com, Capital Group → pro.capitalgroup.com. Caught a real silent-data-loss bug in the original (case-sensitive `startswith("http")`). |
| POC4 — Pooled-vehicle universe sizing | 210,485 pooled-vehicle filings in Form D corpus (58.7% of all filings). 152,639 NOT bridged. Spot-check: 403+ unbridged filings reference tracked companies — SpaceX 113, Anthropic 70, Figure/Scale AI 49 each, OpenAI 30, Stripe 16. **V1 seeded-only is leaving major coverage on the table.** |

### 5.3 Plan revisions (6, all applied to PLAN_FUND_HOLDERS_INTEL.md)

- **R1: Phase 0** — 3 backfill_live.py fixes (429 retry, checkpoint every 100 CIKs, multi-adviser fallback). Wall-clock revised 5h → 1.5-2.5h. Target raised from "≥80% N-PORT→ADV resolution" to "≥85% in (B1 + B3-validated)" with 6 explicit failure buckets.
- **R2: Phase 1** — typed evidence model (4 tables + adviser_resolution_link). Direct-entityname alias matching elevated to CORE Phase 1 (was deferred). PM column dropped from V1.
- **R3: Phase 1.5** — alias curation corrected per POC2 (added Claude SPV I/II, Claude QP, LFG Claude, CGF2021 LLC; excluded ANTR-*).
- **R4: Phase 3+4** — use canonical_domain.py. Enrichment target rescoped 500 → 23 firms. Cost $1.50 → $0.07. Write to new `intel_enrichment` table.
- **R5: Phase 7+8** renamed to "V1 Limits" + "V1.1 Backlog" with explicit deferrals.
- **R6: Target metric** updated.

### 5.4 Phase 0a code changes (in `nport/enrichment/ncen_ingest/backfill_live.py`)

**File:** `/Users/Miles/projects/PrivateFundsRadar/.claude/worktrees/nport-buildout-claude/nport/enrichment/ncen_ingest/backfill_live.py`

**Three changes:**

1. **`_fetch_with_retry()` helper + updated `fetch_latest_ncen()`** (lines ~131-220 after edit)
   - Exponential backoff: 2s, 4s, 8s, 16s
   - Honors `Retry-After` header on 429 (uses max of header value and scheduled delay)
   - Retries on 429, 5xx, ConnectionError, Timeout
   - Returns final response on max retries (caller calls `raise_for_status()`)

2. **`update_registrant_adv_links()` — multi-adviser fallback** (lines ~440-500)
   - Changed `primary_crds_by_cik: dict[str, set[str]]` → `dict[str, Counter]` to track CRD counts per CIK
   - If `len(crd_counts) == 1`: `method='ncen_xref', confidence=100` (unchanged behavior for single-adviser case)
   - If `len(crd_counts) > 1`: pick `crd_counts.most_common(1)[0][0]`, write with `method='ncen_most_common', confidence=75`
   - If `len(crd_counts) == 0`: skip the registrant (no primary investment_adviser link found)
   - Sub-adviser CRDs are filtered out before counting (only `adviser_role == 'investment_adviser'`)

3. **`main()` — checkpointing** (lines ~560-650)
   - Added `--checkpoint-every N` flag (default 100, 0 disables)
   - Added `_flush_batch()` helper
   - `_maybe_checkpoint()` closure inside main() flushes when index%N==0 (in --execute mode only)
   - Backup is now done UPFRONT (before the fetch loop) since checkpoints may flush before the loop ends
   - Final flush handled via `_maybe_checkpoint(len(ciks), force=True)` after the loop

### 5.5 Tests

**Existing (still pass):** 11/11 — `test_normalize_crd_strips_sec_zero_padding`, `test_shape_rows_preserve_raw_and_normalized_crd`, 9 parser tests covering Fidelity/BlackRock/Vanguard/ARK fixtures.

**New (added):** 4 tests in `test_ncen_backfill_live.py`:
- `test_single_adviser_writes_with_full_confidence` — single CRD across 3 series → `method=ncen_xref, confidence=100`
- `test_multi_adviser_picks_most_common_with_reduced_confidence` — 3× CRD A, 2× CRD B across 5 series → picks A with `method=ncen_most_common, confidence=75`
- `test_no_primary_crd_skips_registrant` — only sub-advisers present → no write
- `test_subadviser_links_ignored_for_registrant_resolution` — sub-adviser CRDs do NOT contaminate the primary most-common calculation

Total: **15/15 passing** with mocked Supabase client.

### 5.6 Git state

```
master:
  5f4a812  plan(fund-holders-intel): adversarial stress-test + Codex review locks V1 scope
           (PLAN_FUND_HOLDERS_INTEL.md +662, .claude/MEMORY.md slim merge)

fund-holders-intel (new branch off master, in external worktree):
  a6a29d1  scaffold(intelligence): initial intelligence/ subfolder + stress-test artifacts
  5f4a812  ...plan + MEMORY.md...

nport-buildout-claude (existing branch, NOT yet committed):
  UNCOMMITTED CHANGES in:
    nport/enrichment/ncen_ingest/backfill_live.py
    nport/enrichment/ncen_ingest/tests/test_ncen_backfill_live.py
```

The backfill_live.py edits + tests live on `nport-buildout-claude` because that's where the scraper code lives. They're uncommitted pending dry-run verification.

---

## 6. What's PENDING

| Step | Status | Blocker |
|---|---|---|
| Dry-run backfill_live.py on 5 known multi-adviser CIKs | Pending | N-PORT service key — .env was lost when macOS auto-cleaned /private/tmp/ |
| Commit Phase 0a code changes | Pending dry-run | — |
| Full backfill (1,549 unprocessed CIKs, 1.5-2.5h wall-clock) | Pending dry-run | — |
| Phase 0c: post-backfill ADV validation pass | Pending Phase 0b | — |
| Phase 1: typed evidence tables migration | Pending Phase 0 | — |
| Phase 1: fund_holders_query.py implementation | Pending Phase 0 | — |
| Phase 5: gold-set eval on 5 companies | Pending Phase 1-4 | — |
| Phase 6: CSV export | Pending Phase 5 | — |

---

## 7. Key assumptions (load-bearing, request review)

Each assumption marked with verification status: ✅ verified by POC / 🟡 plausible but not directly verified / 🔴 unverified.

1. ✅ `advisers_enriched` has 82.4% coverage on the 153 target CRDs for (website + contact + AUM>0). POC1 verified.
2. ✅ POC1's "current scraper hits 79.2%, multi-adviser fallback hits 89.1%" is a probabilistic projection (not a live measurement) with ±5pp uncertainty driven by wrap-program prevalence in unprocessed registrants. Live numbers will narrow this.
3. ✅ 88.2% of noisy `primary_website` advisers recover a clean canonical URL via `intelligence/canonical_domain.py`. POC3 directly verified on all 51 noisy CRDs.
4. ✅ Zero direct-issuer Form D filings exist for Anthropic in our Form D DB (`ispooledinvestmentfundtype=TRUE` on all 88 matched filings). POC2 directly verified.
5. 🟡 The multi-adviser most-common pick is "the right firm 99% of the time" — based on the observation that most multi-adviser fund families use related sub-firms of the same parent (BlackRock Advisors LLC + BlackRock Fund Advisors). NOT verified at scale; could fail for genuinely independent multi-adviser structures (unitary trusts with truly distinct sub-advisers).
6. 🟡 SEC EDGAR honors the 10 req/s rate limit with our 0.12s sleep (~8.3 req/s). No live testing of the 429 retry logic — the 41 existing rows were ingested without throttling.
7. 🟡 The Anthropic-classifier POC (POC2) generalizes to other tracked companies. Only Anthropic was directly classified — extrapolating "0 direct-issuer contamination" to SpaceX/OpenAI/Stripe/etc. is unverified.
8. 🟡 The 153-CRD universe is "complete enough for V1" given the seeded-only scope. POC4 confirmed it leaves 403+ tracked-company-referenced unbridged filings on the table, but those go to V1.1.
9. 🔴 The new `intel_enrichment` table schema (proposed for Phase 4) has not been designed in detail. Just sketched as `(crd, firm_name, website, contact_paths jsonb, source, enriched_at)`.
10. 🔴 The typed evidence model schema (4 tables + adviser_resolution_link) has not been written as a migration. Just specified in plan prose.
11. 🔴 Lincoln Investment Advisers (CRD 131181, 13 tracked cos, AUM only $1.9M) is described as "possibly a nominee/shell entity" — needs investigation. Could be 13 false-positive tracked-co assignments.
12. 🔴 Tests for `_fetch_with_retry()` not yet added (only the multi-adviser fallback has new tests).

---

## 8. Specific things to pressure-test

### 8.1 Phase 0a code (backfill_live.py changes)

- Does `_fetch_with_retry` handle the case where SEC returns 429 with no Retry-After header AND the body indicates abuse? (Probably falls through to scheduled delay — confirm acceptable.)
- The 4-attempt cap: with delays 2/4/8/16, total worst-case wait is 30s per request. If SEC throttles aggressively, this could create cascading slowdowns. Is 4 attempts the right cap?
- `update_registrant_adv_links`: in the multi-adviser case with a 50/50 tie, `Counter.most_common(1)` returns one arbitrarily based on insertion order. Should ties go to a different bucket or fall back to a deterministic tiebreaker (lowest CRD)?
- Checkpoint flush + `update_registrant_adv_links`: each checkpoint flush calls `update_registrant_adv_links` on ONLY the batch's CIKs. If a later batch produces additional series-level rows for the same CIK (shouldn't happen, but…), the registrant adv_crd write might overwrite an earlier flush's decision with stale data. Confirm CIKs don't span batches.
- The `_maybe_checkpoint` closure mutates the outer scope's `summary_rows`, `link_rows`, `registrants_updated_total`, `flushes` via `nonlocal`. Python semantics OK but is the readability acceptable?

### 8.2 Plan coherence

- The plan claims V1 = "seeded-only" but POC4 found 403+ tracked-company hits that the current alias matching MISSES (in unbridged filings). Does the V1 promise of "complete coverage of seeded companies" hold when the alias matching itself is leaky? Should we add the unbridged-entityname-scan to V1 instead of deferring to V1.1?
- Phase 3 promises "82.4% fully usable from advisers_enriched alone." That's the population-level average. But the 17 zero-website advisers include Lincoln Investment Advisers (CRD 131181, 13 tracked cos). If Lincoln is truly empty, that one adviser knocks 13 tracked-cos' coverage down significantly. Should we weight target metrics by tracked-co count rather than CRD count?
- The PM column drop is final, but the original plan example showed "PM: Danoff" — make sure the output schema and any UI mockups don't still reference PM.

### 8.3 Bridge architecture

- `nport_registrants.adv_crd` is registrant-level. But for queries like "which mutual fund holds Anthropic and who manages it," the holding row is series-level (`nport_holdings.holding_id` → series). The plan says "use `fund_ncen_adviser_links` for series-level detail" but doesn't specify the query pattern. Is series-level resolution intentional in V1 or are we always falling back to registrant-level?
- `cross_reference_matches.adviser_entity_crd` can be NULL per the schema doc. Phase 1 Section B says "resolve filer to adviser CRD via cross_reference_matches" — does the implementation handle null gracefully?

---

## 9. Files & code locations

**Plan + memory:**
- `/Users/Miles/projects/PrivateFundsRadar/PLAN_FUND_HOLDERS_INTEL.md` — the plan (committed to master at 5f4a812)
- `/Users/Miles/projects/PrivateFundsRadar/.claude/MEMORY.md` — project memory (committed)

**fund-holders-intel worktree** (where the build happens):
- `/Users/Miles/projects/PrivateFundsRadar-fund-holders-intel/intelligence/`
  - `canonical_domain.py` (production-ready)
  - `stress-test-findings/` (full audit trail, 7 subdirectories)
  - `CODEX_REVIEW_BRIEF.md` (this document)
  - `.gitignore`

**nport-buildout-claude worktree** (where the scraper code lives):
- `/Users/Miles/projects/PrivateFundsRadar/.claude/worktrees/nport-buildout-claude/`
  - `nport/enrichment/ncen_ingest/backfill_live.py` (UNCOMMITTED Phase 0a changes)
  - `nport/enrichment/ncen_ingest/parser.py` (untouched)
  - `nport/enrichment/ncen_ingest/tests/test_ncen_backfill_live.py` (UNCOMMITTED new tests)
  - `nport/migrations/004_ncen_adviser_links.sql` (defines fund_ncen_adviser_links schema)

**Existing PFR scraper to NOT touch:**
- `enrichment/enrichment_engine_v2.js` — entry points at lines 1330 (`enrichManager`) and 1951 (`enrichAndSaveManager`)

---

## 10. Database row counts to verify before any backfill kickoff

Run these and confirm against the numbers in §2 above (which were measured 2026-05-15):

```bash
# N-PORT (need SUPABASE_SERVICE_KEY_NPORT)
curl -sI "https://figvonwrlcpveyceengf.supabase.co/rest/v1/nport_registrants?select=count" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: count=exact" -H "Range: 0-0"
# Expected: content-range: 0-0/1589 (or similar)

curl -sI "https://figvonwrlcpveyceengf.supabase.co/rest/v1/fund_ncen_records?select=count" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: count=exact" -H "Range: 0-0"
# Expected: 0-0/41 (or higher if a previous run completed)

curl -sI "https://figvonwrlcpveyceengf.supabase.co/rest/v1/nport_registrants?select=count&adv_crd=not.is.null" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: count=exact" -H "Range: 0-0"
# Expected: 0-0/40 (2.5% of 1589)
```

---

## 11. What I want from you

1. **Read the Phase 0a code changes.** Open `backfill_live.py` (the worktree at `.claude/worktrees/nport-buildout-claude/...`). Look for subtle bugs I missed. The diff vs the original is in commit `2c2a67f`'s state at that path.
2. **Pressure-test the assumptions in §7.** Especially the 🟡 ones — most-common pick generalizing to "the right firm 99% of the time" is the one that worries me most.
3. **Pressure-test the architecture choices in §8.** Especially the "is 4 retry attempts enough" and "does Phase 3 metric weighting need fixing for the Lincoln case."
4. **Read the plan** at `PLAN_FUND_HOLDERS_INTEL.md` and tell me if the V1/V1.1 boundary is drawn in the right place.
5. **Audit the test coverage.** Specifically: is `test_multi_adviser_picks_most_common_with_reduced_confidence` testing the actual logic, or does it accidentally pass because of how I mocked the client?
6. **Tell me what would break in production** that I haven't flagged.

Give me a clear APPROVE / NEEDS WORK / REJECT verdict, with specific line citations and reasoning. The previous version of this plan had 6+ load-bearing bugs that this stress-test caught — assume there are more, and find them.
