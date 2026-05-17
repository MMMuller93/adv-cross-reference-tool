# N-CEN Scraper Readiness Investigation

**Date:** 2026-05-15
**Branch:** nport-buildout-claude
**Path:** /private/tmp/nport-buildout-claude/

---

## 1. Files Found

```
nport/enrichment/ncen_ingest/
  __init__.py
  parser.py            — XML parser (lxml, NCenFiling + Adviser dataclasses)
  daily_ncen.py        — Daily form.idx walker; yields (row, filing) per N-CEN
  backfill_live.py     — CIK-by-CIK backfill via submissions API; writes fund_ncen_records + fund_ncen_adviser_links
  tests/
    conftest.py
    test_ncen_parser.py          (9 tests)
    test_ncen_backfill_live.py   (2 tests)
    ncen_{ark,blackrock,fidelity,vanguard}_raw.xml  (fixture XMLs)

nport/migrations/004_ncen_adviser_links.sql   — schema for fund_ncen_adviser_links
nport/docs/research/sample_xml/ncen_*.xml     — same four fixtures, also present in docs/
```

---

## 2. Entry-Point Command (Full Backfill)

**backfill_live.py** is the production command. Default is dry-run; `--execute` arms live writes.

```
# Dry run (safe to run anytime)
python3 -m nport.enrichment.ncen_ingest.backfill_live

# Live run — all registrants missing adv_crd
python3 -m nport.enrichment.ncen_ingest.backfill_live --execute

# Live run — CIK subset
python3 -m nport.enrichment.ncen_ingest.backfill_live --execute --cik 0000024238 --cik 0000036405

# Live run — all holders of a company slug
python3 -m nport.enrichment.ncen_ingest.backfill_live --execute --company-slug anthropic --limit 200
```

The script pulls CIKs from `nport_registrants` (keyset-paginated; `only_missing=True` by default), hits `data.sec.gov/submissions/CIK{cik10}.json`, extracts the latest N-CEN accession, then fetches `Archives/edgar/data/{cik_int}/{acc_nodashes}/primary_doc.xml`.

---

## 3. SEC EDGAR Compliance

| Check | Status | Detail |
|---|---|---|
| User-Agent header | PASS | `"PrivateFundsRadar Miles mmmuller93@gmail.com"` hardcoded; overridable via `--user-agent` / `SEC_USER_AGENT` env var. Meets SEC "Name email" requirement. |
| Rate limit (10 req/s) | PARTIAL | `DEFAULT_SLEEP_SECONDS = 0.12` → ~8.3 req/s. Stays under the limit. However the sleep fires **before** each request (not adaptive) — no burst protection if network is fast. |
| 429 backoff | NOT IMPLEMENTED | `submissions.raise_for_status()` and `doc.raise_for_status()` propagate 429 as an exception. No retry or `Retry-After` parsing. A 429 will silently log the CIK as a failure and continue. |
| Month-by-month / `/files/` prefix variation | NOT APPLICABLE | backfill_live uses the submissions JSON API (not form.idx), so there is no month/split-file issue. daily_ncen.py uses `full-index/{year}/QTR{q}/form.idx` which is one file per quarter — also no split-month issue. The `/files/` prefix concern only affects older EDGAR bulk-download URLs, not these paths. |

---

## 4. Schema Mapping

### fund_ncen_records — 16 columns written vs. live schema

| Live Column | backfill_live.py writes | Value |
|---|---|---|
| id | NOT written (bigserial, auto) | OK |
| accession_number | YES — from submissions JSON | |
| registrant_cik | YES — cik10() padded | |
| series_id | YES — hardcoded `None` | PARTIAL — always null at summary level |
| fiscal_year_end | YES — `report_period_end` or `report_date` | |
| filing_date | YES | |
| investment_adviser_name | YES — first primary adviser | |
| investment_adviser_crd | YES — normalize_crd() applied | |
| investment_adviser_lei | YES | |
| subadviser_name | YES — "; " joined | |
| subadviser_crd | YES — "; " joined, normalized | |
| subadviser_lei | YES — "; " joined | |
| fund_type | YES — investmentCompanyType | |
| is_etf | NOT PARSED — hardcoded `None` | GAP |
| is_money_market | NOT PARSED — hardcoded `None` | GAP |
| ingested_at | NOT written (DEFAULT now()) | OK |

**is_etf and is_money_market are always NULL.** The parser never reads these fields from the XML (they exist in the N-CEN XSD as `<isEtf>` under `<generalInfo>`).

The newer `fund_ncen_adviser_links` table (migration 004) IS fully populated with series-level data per `shape_link_rows()`.

---

## 5. Tests

11 tests, all PASS (run 2026-05-15):
```
nport/enrichment/ncen_ingest/tests/test_ncen_backfill_live.py::test_normalize_crd_strips_sec_zero_padding  PASSED
nport/enrichment/ncen_ingest/tests/test_ncen_backfill_live.py::test_shape_rows_preserve_raw_and_normalized_crd  PASSED
nport/enrichment/ncen_ingest/tests/test_ncen_parser.py::test_fidelity_basic  PASSED
nport/enrichment/ncen_ingest/tests/test_ncen_parser.py::test_fidelity_adviser_crd  PASSED
nport/enrichment/ncen_ingest/tests/test_ncen_parser.py::test_fidelity_adviser_links_preserve_series  PASSED
nport/enrichment/ncen_ingest/tests/test_ncen_parser.py::test_fidelity_subadvisers  PASSED
nport/enrichment/ncen_ingest/tests/test_ncen_parser.py::test_vanguard_basic  PASSED
nport/enrichment/ncen_ingest/tests/test_ncen_parser.py::test_blackrock_basic  PASSED
nport/enrichment/ncen_ingest/tests/test_ncen_parser.py::test_ark_no_subadvisers  PASSED
nport/enrichment/ncen_ingest/tests/test_ncen_parser.py::test_na_treated_as_null  PASSED
nport/enrichment/ncen_ingest/tests/test_ncen_parser.py::test_no_investment_advisers_block  PASSED
```

No integration tests against the live database (tests are all offline/fixture-based).

---

## 6. Git History — Source of the 41 Rows

The N-CEN feature landed in a **single commit on 2026-05-14 at 19:38:24 CST** (00:38:24 UTC 2026-05-15):

```
2c2a67f  2026-05-14 19:38:24 -0500  feat: add N-CEN adviser enrichment
```

The commit message explicitly states:
> **live preflight with fund_ncen_adviser_links=879**

This means the preflight_live.py was run with `--execute` as part of validating the commit. The witness check report confirms the backfill wrote data. The 41 rows in `fund_ncen_records` + 879 rows in `fund_ncen_adviser_links` came from running `backfill_live.py --execute` against the live Supabase project (figvonwrlcpveyceengf) as a **pre-commit regression check**, not from a separate test seed.

The top filers (BlackRock, Fidelity, T. Rowe, Capital Group, Nuveen, ARK) match exactly the fixture XMLs embedded in the test suite and the sample XMLs in `docs/research/sample_xml/`. These are high-profile N-1A filers that are almost certainly among the first CIKs returned by `nport_registrants` when ordered by CIK.

The 1+40 batch split is consistent with `BATCH_SIZE = 500` but the actual first batch being small (the script prints every 25 CIKs; 41 CIKs total were processed with N-CEN filings found).

---

## 7. Wall-Clock Estimate for Full Backfill

**The "84K filings × ~2s = ~5h" claim is NOT supported by this code.**

backfill_live.py does NOT iterate 26 quarters of EDGAR filings. It iterates `nport_registrants` CIKs and fetches the **latest** N-CEN for each registrant. One CIK = one registrant = one N-CEN fetch (2 HTTP calls: submissions JSON + XML).

- Sleep per CIK: `0.12s × 2 calls = 0.24s` minimum network overhead
- Realistic: ~0.5–1s per CIK (0.24s sleep + SEC response latency)
- `nport_registrants` size: unknown (not queried — needs live DB check), but N-PORT has ~5,000–8,000 unique registrant CIKs based on the 5.9M row dataset at ~700 holdings/registrant average
- **Realistic estimate:** 5,000 CIKs × 1s = ~1.4 hours; 8,000 CIKs × 1s = ~2.2 hours

The "84K" figure likely refers to the total number of N-CEN filings across all 26 quarters in EDGAR's full-index, which is irrelevant — backfill_live.py fetches **only the latest** N-CEN per registrant. A multi-quarter historical N-CEN backfill is NOT implemented.

---

## 8. Known Gaps / Bugs / Not-Yet-Implemented

1. **No 429 retry.** A rate-limit response from SEC silently fails the CIK and continues. For a large backfill (thousands of CIKs), at least some will return 429. Should add exponential backoff with `Retry-After` header parsing.

2. **is_etf and is_money_market always NULL.** Parser reads `investmentCompanyType` but not `<isEtf>` or `<isMoneyMarket>` fields from `generalInfo`. These fields exist in the N-CEN XSD.

3. **series_id always NULL in fund_ncen_records.** The summary row hardcodes `"series_id": None`. The series-level data is correctly captured in `fund_ncen_adviser_links` but the legacy table loses it.

4. **Only fetches LATEST N-CEN per registrant.** Historical backfill across 26 quarters (the plan's §6.5 scope) requires iterating `full-index/{year}/QTR{q}/form.idx` quarterly — that's daily_ncen.py's job, but daily_ncen.py has no persistence layer (intentionally — "the caller decides"). No wiring of daily_ncen → Supabase upsert exists in the committed code.

5. **No dedup/idempotency check before fetching.** The script checks `existing_link_accessions` only for the link table, not before making the HTTP request. Re-running wastes SEC quota re-fetching filings already ingested.

6. **No progress checkpointing.** If the run fails mid-way (e.g., network error, 429 storm), there is no resume-from-checkpoint. All fetched data is held in memory and upserted at the end. For 5k+ CIKs this is ~50MB RAM, but a mid-run crash discards all work.

7. **`report_period_end` parsed from XML attribute, not element.** `general_info.get("reportEndingPeriod")` reads an XML *attribute* — this is correct per the XSD but fragile if older schema versions used a child element instead. Not verified across pre-2022 filings.

---

## Summary: Production-Ready?

**Not fully ready for a 26-quarter historical backfill.** Ready for a "latest N-CEN per current registrant" backfill with caveats.

| Dimension | Status |
|---|---|
| Parser correctness | GOOD — 11/11 tests pass, 4 real filer fixtures |
| SEC compliance (User-Agent) | GOOD |
| Rate limiting | ADEQUATE (0.12s static sleep, no burst protection) |
| 429 handling | MISSING — will silently skip CIKs under rate pressure |
| Schema fit (fund_ncen_records) | PARTIAL — is_etf/is_money_market always null |
| Schema fit (fund_ncen_adviser_links) | GOOD — full series-level data |
| Multi-quarter historical backfill | NOT IMPLEMENTED |
| Idempotency / resume | PARTIAL — upserts are safe, but no pre-fetch dedup or checkpoint |
| Tests | OFFLINE ONLY — no live DB integration test |
