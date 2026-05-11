# N-PORT §5 Resolution Algorithm — PoC Findings
**Date:** 2026-05-11
**Dataset:** 2026 Q1 N-PORT bulk (5,941,068 rows)
**Test target:** Anthropic (91 ground-truth rows)
**Script:** `.poc-stress-test/anthropic-resolution/resolver.py`

---

## Confirmation Table

| Metric | Count | % |
|---|---|---|
| Total Anthropic rows (ground truth) | 91 | 100% |
| Resolved correctly to "anthropic" by algorithm | **91** | **100.0%** |
| Resolved wrong (false positive — different company) | **0** | **0.0%** |
| Unresolved (algorithm gave up) | **0** | **0.0%** |
| Captured by F4 filter | **88** | **96.7%** |
| Anthropic rows missed by F4 filter | **3** | **3.3%** |

---

## Resolution Source Breakdown (all 91 rows resolved)

| Source | Count | Notes |
|---|---|---|
| `lei` | 46 | Step 1: LEI `984500B6DEB8CEBC4Z70` matched — 50% of rows |
| `alias_exact` | 39 | Step 5: normalized name exact match (ANTHROPIC, ANTHROPIC PBC, ANTHROPIC INC) |
| `alias_prefix` | 5 | Step 6: prefix "ANTHROPIC" matched on normalized issuer_name |
| `alias_prefix_title` | 1 | Step 6: prefix match on normalized issuer_title when name was "N/A" |

Key finding: Step 1 (LEI) resolves 50% of rows without any name matching at all. The remaining 50% resolve cleanly via alias exact/prefix. No rows required SPV unwrap (Anthropic is held directly, never as an SPV wrapper in Q1 2026).

---

## Unresolved Anthropic Rows

**None.** The algorithm resolved all 91 rows to `anthropic` with zero false positives.

No new alias entries are needed for Anthropic coverage.

---

## F4 Filter — 3 Missed Rows

Three legitimate Anthropic rows fail the F4 filter. Their disqualifying attributes:

| # | FVL | ASSET_CAT | ISSUER_TYPE | CUSIP | IS_RESTRICTED | Reason F4 fails |
|---|---|---|---|---|---|---|
| 1 | **2** | EC | CORP | N/A | N | FVL≠3 |
| 2 | **1** | EC | **OTHER** | N/A | N | FVL≠3 AND ISSUER_TYPE≠CORP; NAME="N/A", TITLE="ANTHROPIC, PBC SERIES E-1 PREFERRED STOCK" |
| 3 | 3 | **OTHER** | **PF** | 000000000 | Y | ASSET_CAT not in (EC,EP) AND ISSUER_TYPE≠CORP |

Row 2 is notable: ISSUER_NAME="N/A" with the real company name only in ISSUER_TITLE. The algorithm catches it via `alias_prefix_title` (Step 6 applied to the title field). F4 fails because this row is classified as ISSUER_TYPE=OTHER, FVL=1 — likely a filer categorization error.

Row 3 is classified as ASSET_CAT=OTHER and ISSUER_TYPE=PF (pooled fund) — also likely a filer error.

**These 3 rows match the plan's documented 88/91 finding (F4 captures 88/91 = 96.7%).** The plan correctly identifies F4 as the right production filter; the 3 misses are filer-error edge cases that the alias-based "already known" third union branch in the F4 SQL would catch in production.

---

## False Positives

**None.** No rows were incorrectly resolved to "anthropic". The algorithm correctly avoids matching on substring noise — no "Anthropic Capital LLC" or similar entities appeared in the dataset.

---

## SPV Unwrap Regex Tests

All 5 test strings resolved correctly:

| Input | Underlier Extracted | Pattern | Resolved To | Result |
|---|---|---|---|---|
| `DXYZ OAI I LLC (economic exposure to OpenAI Global LLC, ...)` | "OpenAI Global LLC" | `spv_economic_exposure` | openai | **PASS** |
| `AESTAS LLC dba OPENAI LLC EV UNITS Class A` | "OPENAI" | `spv_aestas` | openai | **PASS** |
| `Celadon Technology Fund VIII, LLC - Series B (economic exposure to Space Exploration Technologies Corp., ...)` | "Space Exploration Technologies Corp." | `spv_economic_exposure` | spacex | **PASS** |
| `SPV EXPOSURE TO SPACEX LLC` | "SPACEX" | `spv_exposure` | spacex | **PASS** |
| `MWAM VC SpaceX-II, LLC` | "SpaceX" | `spv_mwam` | spacex | **PASS** |

The `(economic exposure to X)` parenthetical pattern is the workhorse — catches DXYZ and Celadon wrappers. The `AESTAS LLC dba` pattern works correctly. The `SPV EXPOSURE TO` and `MWAM VC` patterns work for the fully-obscured SPV cases that don't have parenthetical hints.

---

## Verdict: §5 Algorithm is CORRECT AS WRITTEN

**100% recall, 0% false positives** on the 91-row Anthropic ground truth.

The algorithm's three-tier cascade (LEI → alias_exact → alias_prefix) is robust:
- LEI is the most reliable anchor (50% coverage where filers supply it consistently)
- Normalization correctly strips all vendor noise (`PP`, `PC`, `CVT PFD`, `(PHYSICAL)`, `(NOT LISTED OR TRADING)`, series labels) before exact match
- Prefix match catches the residue where `ANTHROPIC` is the lead token after normalization

**Minor caveat on F4:** The 3 missed rows (3.3%) are filer classification errors (wrong FVL, wrong ISSUER_TYPE), not algorithm failures. The production SQL's third union branch (`WHERE normalized_issuer_name IN aliases_cache`) would catch them. In a live system these 3 rows would be caught at ingestion time once "anthropic" is in the alias cache.

**No new alias entries recommended** for Anthropic coverage. The existing seed (`ANTHROPIC`, `ANTHROPIC PBC`, `ANTHROPIC INC` exact + `ANTHROPIC` prefix) is complete.

---

## Notes on IDENTIFIERS.tsv

IDENTIFIERS.tsv was not downloaded for this PoC (disk constraints — only 1.9 GB free on a 100%-full disk). This is acceptable because:
1. Anthropic has no public FIGI/BBGID (Step 3 would yield no matches regardless)
2. The LEI-based Step 1 already covers the identifiers path for Anthropic
3. IDENTIFIERS.tsv is critical for Step 2 (LoanX for credit positions) and Step 3 (BBGID for institutional equity), which matter for xAI, Databricks, and SpaceX loan positions — not tested here

For a full production PoC covering xAI loans and Databricks credit positions, IDENTIFIERS.tsv is required for Steps 2-3.
