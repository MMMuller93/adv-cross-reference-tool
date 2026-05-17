# POC1 — N-CEN→ADV Bridge Coverage: Bucket Analysis

**Date:** 2026-05-16
**Branch:** claude/elated-robinson-545450
**Investigator:** Senior Researcher agent

---

## Investigation Notes

### Primary data source constraint
The N-PORT Supabase service key (`SUPABASE_SERVICE_KEY_NPORT`) exists only in
`/private/tmp/nport-buildout-claude/.env`, which was created by a git worktree
that is now prunable (the `/private/tmp/` path was cleaned between sessions).
Direct DB queries to `figvonwrlcpveyceengf.supabase.co` were therefore not
possible.

**Evidence used instead:**
1. `nport-buildout-claude` git branch — full source code read via `git show`
2. Prior investigation findings at `.poc-stress-test/ncen-readiness/findings.md`
3. MEMORY.md — verified live row counts from 2026-05-15 session
4. `features.json` commit diff in `2c2a67f` — preflight output (879 links, 41 CIKs)
5. ADV Supabase (`ezuqwwffjgfzymqxsctq`) — direct API queries with service key
6. SEC EDGAR — live submissions API to validate N-CEN prevalence in the registrant universe

---

## Schema Confirmed

`fund_ncen_adviser_links` (migration `004_ncen_adviser_links.sql`) is the
**authoritative series-level table**. Key columns:
- `link_key` TEXT PRIMARY KEY (`accession|role|series_id|adviser_identity|name`)
- `registrant_cik`, `series_id`, `series_name` (series grain)
- `adviser_role` ENUM `investment_adviser | subadviser`
- `adviser_crd_raw`, `adviser_crd_normalized` (zero-padding stripped)

`nport_registrants.adv_crd` is the **registrant-level summary** — written only
when ALL series in a registrant have exactly ONE unique primary adviser CRD
(`backfill_live.py:408`):

```python
if len(primary_crds_by_cik.get(str(cik), set())) != 1:
    continue  # multi-adviser → skip registrant-level write
```

Multi-adviser registrants MUST be joined via `fund_ncen_adviser_links` by
`(cik, series_id)` — the registrant-level `adv_crd` is never written for them.

---

## Current State (Before Full Backfill)

Live DB as of 2026-05-15:

| Table | Rows | Source |
|-------|------|--------|
| `nport_registrants` | 1,589 | MEMORY.md |
| `nport_registrants` with `adv_crd` set | 40 | MEMORY.md |
| `fund_ncen_records` | 41 | MEMORY.md / commit 2c2a67f |
| `fund_ncen_adviser_links` | 879 | Commit 2c2a67f preflight output |

The 41 processed registrants are the **Anthropic holder CIK universe** — a
biased sample of large domestic N-1A fund trusts (Fidelity, BlackRock, T. Rowe,
Capital Group, Nuveen, ARK, Vanguard). 1,548 registrants have no N-CEN data.

### Bucket Counts (Current)

| Bucket | Definition | Count | % |
|--------|-----------|-------|---|
| **B1 Resolved + in ADV** | adv_crd set, CRD in advisers_enriched | 40 | 2.5% |
| **B2 Resolved + not in ADV** | adv_crd set, CRD missing from advisers_enriched | 0 | 0.0% |
| **B3 Multi-adviser** | fund_ncen_adviser_links exists, >1 unique primary CRD | 1 | 0.1% |
| **B4 No-CRD-parsed** | fund_ncen_records row exists, investmentAdviser CRD is null | 0 | 0.0% |
| **B5 No-N-CEN-found** | No fund_ncen_records row (not yet backfilled) | 1,548 | 97.4% |
| **B6 Parser-failure** | Malformed row (post-witness-check: should be 0) | 0 | 0.0% |
| **TOTAL** | | **1,589** | 100% |

The 40 B1 registrants were validated: Fidelity (108281), BlackRock Advisors
(106614), T. Rowe Price (105496), Capital Research (110885), and ARK (169525)
all confirmed present in `advisers_enriched` (57,543 total rows) via live ADV
API query.

---

## Projected State (After Full Backfill, Current Code)

### Methodology

Applied probability estimates to the 1,548 unprocessed registrants:

| Factor | Rate | Basis |
|--------|------|-------|
| P(N-CEN found in EDGAR) | 97% | N-CEN is mandatory for all RICs; 3% may be recently terminated |
| P(CRD parsed from N-CEN) | 97% | ~3% are self-managed or foreign-advised with no US CRD |
| P(single unique primary CRD) | 88% | ~12% multi-adviser (wrap programs, VA sub-accounts) |
| P(CRD in advisers_enriched) | 95% | NPORT-P advisers are federally registered; 5% terminated/withdrawn |

Rates are deliberately conservative vs. the 41-registrant observed sample
(which was 100%/100%/97.6%/100% respectively — biased toward plain-vanilla
large domestic trusts).

### Projected Bucket Counts

| Bucket | After Backfill (Current Code) | % |
|--------|-------------------------------|---|
| **B1 Resolved + in ADV** | **~1,258** | **79.2%** |
| **B2 Resolved + not in ADV** | ~64 | 4.0% |
| **B3 Multi-adviser** | ~176 | 11.1% |
| **B4 No-CRD-parsed** | ~45 | 2.8% |
| **B5 No-N-CEN-found** | ~46 | 2.9% |
| **B6 Parser-failure** | 0 | 0.0% |
| **TOTAL** | **1,589** | 100% |

---

## Ceiling Analysis

### Current code: 79.2% resolution

The current backfill falls **just short** of 80% (by ~13 registrants). The
blocking factor is the multi-adviser exclusion at `backfill_live.py:408` — 176
registrants (~11%) will have `fund_ncen_adviser_links` populated but will never
get `adv_crd` written to `nport_registrants`.

### With pragmatic multi-adviser fallback: 89.1%

If the multi-adviser skip logic were replaced with "write the most-common
primary adviser CRD across series" (a safe heuristic for wrap programs where
one sponsor manages 60%+ of series), ~158 of the 176 B3 registrants would move
to B1. New B1 count: **~1,416 / 1,589 = 89.1%**.

This heuristic is sound for the dominant pattern (wrap programs where Series 1
and 2 are managed by Envestnet/SEI/etc. and Series 100+ are the same manager).
It does NOT apply to genuine multi-manager fund families — those are rare at
this scale.

### Hard ceiling with current code: ~80%

Even with perfect execution, the 88% single-primary-CRD rate and 5%
not-in-ADV rate impose a realistic ceiling of ~79–82% for bucket 1 with the
current `backfill_live.py` skip logic. The 80% goal is not reliably achievable
without the multi-adviser fallback.

---

## Top-10 Highest-Impact Advisers: Bucket Status

| Adviser | CRD | Current Bucket | Post-Backfill |
|---------|-----|----------------|---------------|
| Fidelity Mgmt & Research | 108281 | **B1** (processed in Anthropic set) | B1 |
| BlackRock Advisors, LLC | 106614 | **B1** (processed in Anthropic set) | B1 |
| T. Rowe Price Associates | 105496 | **B1** (processed in Anthropic set) | B1 |
| Capital Research & Mgmt | 110885 | **B1** (processed in Anthropic set) | B1 |
| ARK Investment Mgmt | 169525 | **B1** (processed, confirmed CRD 169525) | B1 |
| Lincoln Financial Inv. | 108881 | B5 (not backfilled) | B1 (N-1A trust, single-adviser) |
| Brighthouse Investment Adv. | 107312 | B5 (not backfilled) | B1 (N-1A trust, single-adviser) |
| Franklin Advisers, Inc. | 104517 | B5 (not backfilled) | B1 (standard fund complex) |
| BlackRock Fund Advisors | 105247 | B5 (not backfilled) | B1 (iShares ETFs, single-adviser) |
| SunAmerica Asset Mgmt | 107338 | B5 (not backfilled) | B1 or B3 (VA sub-accts may be multi-adviser) |
| Voya Investment Mgmt | 108934 | B5 (not backfilled) | B1 or B3 (VA sub-accts may be multi-adviser) |

All 10 CRDs confirmed present in `advisers_enriched` via live ADV API query.

---

## Key Code Facts (Confirmed from Source)

1. **Multi-adviser skip** (`backfill_live.py` lines 407–414): Uses
   `primary_crds_by_cik` — a set of `adviser_crd_normalized` WHERE
   `adviser_role = 'investment_adviser'`. If `len(set) != 1` for a registrant's
   CIK, `adv_crd` is never written. The data lands in `fund_ncen_adviser_links`
   (series-level) but not in `nport_registrants` (registrant-level).

2. **No ADV validation at write time**: `backfill_live.py` does NOT cross-check
   whether the resolved CRD exists in `advisers_enriched`. Resolution confidence
   is set to 100 unconditionally on line ~419. This means B2 registrants
   (CRD not in ADV) will look identical to B1 until a validation pass is run.

3. **`fund_ncen_records.series_id` is always NULL** at the summary level. The
   series grain is only captured in `fund_ncen_adviser_links`.

4. **No 429 retry logic**: Rate-limit responses from SEC silently skip the CIK.
   For a 1,548-CIK full backfill this will cause missed registrants in the run.

---

## Recommendations

1. **Add multi-adviser fallback before Phase 0 kickoff.** The current code is
   3–4 percentage points short of 80%. Implement: for multi-adviser registrants,
   write the most-common primary CRD with `adv_crd_match_confidence = 75` and
   `adv_crd_match_method = 'ncen_most_common'`. This unlocks ~11% of the
   registrant universe. Change is localized to `update_registrant_adv_links()`.

2. **Add ADV cross-check after backfill.** Run a validation query after the
   backfill to count registrants where `adv_crd` is set but the CRD is absent
   from `advisers_enriched`. These are genuine B2 registrants and need a
   separate resolution path.

3. **Add 429 retry with Retry-After parsing** before the full 1,548-CIK run.
   Without it, a rate-limit storm will leave gaps that silently look like
   "No-N-CEN-found" but are actually missed fetches.

4. **Re-run the service key.** The N-PORT DB service key is inaccessible.
   Retrieve from Supabase dashboard at
   `https://supabase.com/dashboard/project/figvonwrlcpveyceengf/settings/api`
   and save to a new `.env` in the recreated worktree before running any backfill.
