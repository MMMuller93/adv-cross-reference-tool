# Witness Audit — Plan Accuracy vs Stress-Test Findings

**Auditor:** Independent witness agent (claude-sonnet-4-6)
**Date:** 2026-05-17
**Verdict: NEEDS WORK**

Plan file: `/Users/Miles/projects/PrivateFundsRadar/PLAN_FUND_HOLDERS_INTEL.md` (commit 5f4a812)
Source-of-truth: `intelligence/stress-test-findings/` (7 subdirectories)

---

## Verdict Summary

The plan correctly applies most findings and the revisions are substantively sound.
However, **4 verifiable issues** were found — one is a methodological fabrication
(a method name that appears nowhere in the findings), one is a stale row count that
POC4 corrected, one is an incorrect attribution about the origin of 41 N-CEN rows,
and one is a subtle mismatch in how 87.6% is characterized. None are
catastrophic, but two of them will cause real confusion for the next implementing
agent.

---

## Issue 1 — FABRICATED METHOD NAME: `ncen_xref` vs `ncen_unanimous` (PLAN LINE 201)

**Plan (line 201):**
```
method,  — 'ncen_unanimous' | 'ncen_most_common' | ...
```

**Evidence:**
- POC1 findings (`poc1-ncen-buckets/findings.md`): **no mention of either `ncen_xref` or `ncen_unanimous`**. The document describes the fallback behavior in prose but does not propose specific method-name strings.
- CODEX_REVIEW_BRIEF.md §5.4 (the Phase 0a code changes section) explicitly states:
  > `method='ncen_xref', confidence=100` for the single-adviser case
  > `method='ncen_most_common', confidence=75` for multi-adviser

- The implemented backfill_live.py changes (per the Codex brief §5.4 and §5.5 tests) use `ncen_xref`, not `ncen_unanimous`.
- The tests added (`test_single_adviser_writes_with_full_confidence`) verify `method=ncen_xref, confidence=100`.

**Divergence:** The plan's typed evidence model (Phase 1) lists `ncen_unanimous` as a method enum value. The actual Phase 0a code, the Codex brief, and the new tests all use `ncen_xref`. This will cause a constraint violation or silent mismatch when Phase 1 is implemented and tries to insert `ncen_xref` rows into a table whose method enum only includes `ncen_unanimous`.

**Severity: HIGH** — Will break Phase 1 migration if the schema is created verbatim from the plan.

---

## Issue 2 — STALE ROW COUNT: `form_d_filings` is 358,765, not 330,000 (PLAN LINE 64)

**Plan (line 64):**
> `form_d_filings` — 330,000 rows

**Plan (line 271):**
> `ILIKE ANY` on 330K Form D rows

**Evidence:** POC4 findings (`poc4-pooled-vehicle-universe/findings.md` line 5):
> **Total form_d_filings rows:** 358,765

POC4 scanned all 358,765 rows via keyset pagination — this is a live, verified count from the Form D Supabase project, measured 2026-05-17.

**Divergence:** The plan's row count for `form_d_filings` is 8.7% low (28,765 rows understated). This doesn't affect the architecture but the "330K" figure appears twice in the plan and will mislead the implementing agent on scale estimates and query cost projections.

**Severity: LOW** — Cosmetic staleness, not a functional error.

---

## Issue 3 — INCORRECT ATTRIBUTION: "41 N-CEN rows came from commit 2c2a67f witness check" (PLAN LINE 154)

**Plan (line 154):**
> The 41 N-CEN rows already in `fund_ncen_records` came from commit `2c2a67f` witness check, not a real backfill.

**Evidence:** N-CEN readiness findings (`ncen-readiness/findings.md` §6):
> The commit message explicitly states: **"live preflight with fund_ncen_adviser_links=879"**
> This means the preflight_live.py was run with `--execute` as part of validating the commit.
> The 41 rows in `fund_ncen_records` + 879 rows in `fund_ncen_adviser_links` came from running
> `backfill_live.py --execute` against the live Supabase project as a **pre-commit regression
> check**, not from a separate test seed.

**ChatGPT branch findings** (`chatgpt-branch/findings.md`) additionally noted:
> The 41 rows must have come from a different source (a separate script, manual insertion,
> or another agent session with different credentials)

The plan characterizes the origin as a "witness check" — but the ncen-readiness findings say it was a live `--execute` preflight run as part of commit `2c2a67f`. The ChatGPT branch had no mechanism to produce these rows (no live credentials, no upsert code).

**Divergence:** Mislabeling a `--execute` preflight backfill as a "witness check" suggests the 41 rows are a narrow probe artifact. They're not — they represent a real partial backfill of the first ~41 CIKs returned by `nport_registrants`. This distinction matters for Phase 0: those 41 CIKs are already processed and the backfill should skip them (idempotency).

**Severity: MEDIUM** — Functional confusion about what is already backfilled and what needs to be run.

---

## Issue 4 — MISLEADING ATTRIBUTION of 87.6% (PLAN LINE 288)

**Plan (line 288):**
> **Coverage projection (POC3-validated):** ~134/153 target CRDs (87.6%) get a verified
> canonical website + named contact + AUM directly from `advisers_enriched`.

**Evidence:**
- The 87.6% figure comes from the **coverage-check findings** (`coverage-check/findings.md` §1):
  > any usable website (canonical derivable): 134/153 = **87.6%**
  This means 87.6% have "any usable website" — it is a website-only metric, NOT "website + named contact + AUM."

- POC3 findings (`poc3-canonical-domain/findings.md` §1) validated that the *canonical selector* recovers 45/51 noisy CRDs (88.2%). This is the POC3 number.

- The "82.4% fully usable" metric (website + contact + AUM) is the accurate three-condition metric from coverage-check §2.

**Divergence:** The plan conflates two separate metrics:
1. 87.6% = any usable website (coverage-check), attributed as "website + contact + AUM" in Phase 3 prose
2. 82.4% = actual fully usable (website + contact + AUM) stated elsewhere in the plan

Line 288 says "87.6% get a verified canonical website + named contact + AUM" — this is wrong. The 87.6% figure is website-only. The "named contact + AUM" part is an addition that makes this figure appear stronger than it is.

**Severity: MEDIUM** — The 23-firm enrichment target (17 zero-website + 6 social-only) derived from the website metric is correct, but the claim that those 134 CRDs have "website + named contact + AUM" overstates what the data shows.

---

## R1–R6 Revision Checklist

| Revision | Applied? | Notes |
|----------|----------|-------|
| R1: 429 retry, checkpoint, multi-adviser fallback; wall-clock 5h→1.5-2.5h; target ≥85% with 6 buckets | YES | All present at lines 162–175. Bucket definitions correct. |
| R2: Typed evidence model (4 tables + adviser_resolution_link); direct entityname alias as CORE Phase 1; PM dropped | YES | Phase 1 restructured correctly. PM drop explicit at line 242. One method-name error (Issue 1). |
| R3: Phase 1.5 alias corrections (Claude SPV I/II, Claude QP, LFG Claude, CGF2021 LLC; exclude ANTR-*) | YES | Lines 249–256. Negative exclusion list matches POC2 §5 exactly. |
| R4: canonical_domain.py; enrichment 500→23 firms; cost $1.50→$0.07; intel_enrichment table | YES | Lines 280–297. Cost math ($0.003×23=$0.069) is defensible. |
| R5: Phase 7+8 renamed to V1 Limits + V1.1 Backlog | YES | Phases 7 and 8 present with explicit deferrals. |
| R6: Target metric updated to ≥85% | YES | Lines 175, 650. |

---

## Numerical Claim Spot-Check

| Claim | Source Finding | Verdict |
|-------|---------------|---------|
| "82.4% fully usable" | coverage-check/findings.md §2: "126/153 = 82.4%" | CONFIRMED |
| "88.2% canonical-domain recovery" | poc3-canonical-domain/findings.md §1: "45/51 = 88.2%" | CONFIRMED |
| "89.1% achievable with multi-adviser fallback" | poc1-ncen-buckets/findings.md: "~1,416/1,589 = 89.1%" — explicitly labeled a projection | CONFIRMED (projection, not measured) |
| "Total V1 cost ~$0.07 OpenAI" | 23 × $0.003 = $0.069; POC3 identified 23 firms | CONFIRMED — math is correct |
| "70 unbridged Anthropic pooled vehicles representing $162M+" | poc2-formd-classifier/findings.md: "70 (80%) NOT bridged; $162,053,842 disclosed" | CONFIRMED |
| "Lincoln Investment Advisers (CRD 131181, 13 tracked companies, AUM $1.9M)" | coverage-check/findings.md §4 and §5: CRD 131181 confirmed, 13 tracked companies, AUM=1,900,000.0 | CONFIRMED |
| "CGF2021 LLC, 34 Anthropic filings, Sydecar platform" | poc2-formd-classifier/findings.md: "CGF2021 LLC: 34 filings" | CONFIRMED |
| "Claude's own commit 2c2a67f source of 41 N-CEN rows" | ncen-readiness/findings.md §6: confirmed as `--execute` preflight run | CONFIRMED (but plan mislabels the mechanism — see Issue 3) |
| "ChatGPT's parallel branch is clean, no fund-holders-intel work" | chatgpt-branch/findings.md: "None. Zero references to fund_holders..." | CONFIRMED |
| "210,485 pooled-vehicle filings in Form D corpus" | poc4-pooled-vehicle-universe/findings.md §1: "Union: 210,485 filings = 58.7% of corpus" | CONFIRMED |

---

## Findings Not Incorporated (or Only Partially)

**POC1 finding about N-PORT service key loss:**
The plan addresses this at line 176 (step 0e) — confirmed: partially addressed. The plan says "confirm it is still readable; if not, re-fetch from Supabase dashboard." POC1 findings §0 noted the key was already inaccessible during the POC itself, meaning the POC ran without live DB access. The plan's treatment is adequate but soft — it could be more explicit that the `/private/tmp/` path is likely cleaned between macOS sessions and should be treated as always-regenerate, not just check-if-present.

**POC4 finding that V1 seeded-only scope misses 403+ tracked-company filings:**
Correctly deferred to Phase 8 V1.1 Backlog (plan line 337). The deferral reasoning is explicit. This is properly handled.

**Codex typed evidence model:**
Adopted faithfully. The four tables plus adviser_resolution_link match the Codex specification in the brief §3 exactly (with the one method-name issue noted above).

---

## Final Verdict: NEEDS WORK

**Fix required before Phase 1 migration is written:**

1. **Line 201:** Change `ncen_unanimous` to `ncen_xref` in the adviser_resolution_link method enum. This must match the Phase 0a code and tests, which use `ncen_xref` for single-adviser resolution.

2. **Line 288:** Correct the 87.6% characterization. Change "87.6% get a verified canonical website + named contact + AUM" to "87.6% have at least one usable website URL (canonical derivable)." The full three-condition metric (website + contact + AUM) is 82.4%.

Optional (low-severity):
3. **Line 64/271:** Update `form_d_filings` row count from 330,000 to ~358,765 (POC4 live measurement).
4. **Line 154:** Clarify that the 41 N-CEN rows came from a `--execute` preflight run as part of commit `2c2a67f`, not a "witness check" test artifact. Implication: those 41 CIKs are already backfilled and the full-backfill run should produce 0 new rows for them (idempotency should handle this, but framing matters).
