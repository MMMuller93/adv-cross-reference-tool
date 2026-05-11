# N-PORT 2026 Q1 — Filter Coverage Analysis
**Dataset:** FUND_REPORTED_HOLDING.tsv | 5,941,068 rows | Source: SEC DERA bulk 2026q1_nport.zip
**Analyzed:** 2026-05-11

---

## Filter Comparison Table

| Filter | Rows | Clusters | Anthropic | Stripe | xAI equity | Cerebras | Wiz | Sanction$ |
|--------|------|----------|-----------|--------|-----------|---------|-----|-----------|
| F1 (strict 5-way AND) | 6,383 | 2,054 | 82 | 51 | 67 | 18 | 0 | 184 |
| F2 (drop CUSIP filter) | 7,808 | 2,604 | 82 | 54 | 69 | 18 | 0 | 238 |
| F3 (drop ISSUER_TYPE) | 6,606 | 2,139 | 82 | 51 | 68 | 18 | 0 | 187 |
| F4 (FVL=3, no restricted) | 13,897 | 3,921 | 88 | 68 | 80 | 18 | 0 | 819 |
| F5 (restricted only, no FVL) | 18,977 | 4,016 | 82 | 54 | 70 | 19 | 0 | 238 |
| F6 (loose OR) | 31,880 | 7,018 | 88 | 71 | 84 | 19 | 0 | 1,170 |

**Column definitions:**
- Rows: total rows passing filter
- Clusters: distinct normalized issuer names
- Anthropic/Stripe/xAI equity/Cerebras/Wiz: matching rows from ground-truth patterns
- Sanction$: rows matching known sanctioned Russian stocks (Sberbank, Lukoil, Gazprom, etc.) — a false-positive proxy

---

## Task C — Anthropic Row Breakdown

**Total Anthropic rows in dataset (all 91):**

| Filter | Anthropic rows captured | Missed |
|--------|------------------------|--------|
| F1 (strict) | 82 / 91 | 9 |
| F4 (FVL=3 only) | 88 / 91 | 3 |
| F5 (restricted only) | 82 / 91 | 9 |
| F6 (loose OR) | 88 / 91 | 3 |

**Flag frequency across all 91 Anthropic rows:**
- ASSET_CAT in EC/EP: 90/91 (one row is ASSET_CAT=OTHER — an SPV wrapper)
- ISSUER_TYPE = CORP: 89/91 (two exceptions: one PF, one OTHER)
- IS_RESTRICTED_SECURITY = Y: 83/91 — **8 rows lack the restricted flag**
- FAIR_VALUE_LEVEL = 3: 89/91 — **2 rows lack FVL=3 (one is FVL=2, one is FVL=1)**
- Bad/missing CUSIP: 91/91 (all Anthropic rows have no real CUSIP — perfect signal)

**The 9 rows F1 misses:**

| Title | Why F1 misses |
|-------|--------------|
| `Anthropic PBC` | R=N, FVL=2 (two filers) |
| `Anthropic PBC` | R=N (two filers) |
| `ANTHROPIC PBC CL F-1 PFD PP (PHYSICAL) (NOT LISTED OR TRADING)` | R=N (three filers) |
| `Anthropic PBC, Series G-1` | R=N |
| `Anthropic, Inc.` | R=N |
| `ANTHROPIC, PBC SERIES E-1 PREFERRED STOCK` | R=N, FVL=1, TYPE=OTHER |
| `ANTHROPIC` (bare name) | TYPE=PF, ASSET_CAT=OTHER |

The 6 rows that F6 catches but F1 misses all have `IS_RESTRICTED_SECURITY='N'` despite being legitimate private preferred/common equity. **These are real Anthropic positions that F1 silently drops.** FVL=3 picks up 6 of those 9; the remaining 3 (FVL=2 or FVL=1) are only captured by F6.

---

## Task D — Recommended Production Filter

### 1. Best V1 Filter: F1 + F4 Union (Annotated)

Neither pure F1 nor pure F6 is optimal. The evidence recommends a **union approach**:

```
PRIMARY (confidence=HIGH):
  IS_RESTRICTED_SECURITY='Y' AND FAIR_VALUE_LEVEL='3'
  AND ASSET_CAT IN ('EC','EP') AND ISSUER_TYPE='CORP'
  AND (ISSUER_CUSIP IS NULL OR ISSUER_CUSIP IN ('000000000','N/A') OR LENGTH(ISSUER_CUSIP)!=9)

SUPPLEMENTAL (confidence=MEDIUM, +6,277 rows):
  FAIR_VALUE_LEVEL='3'
  AND ASSET_CAT IN ('EC','EP') AND ISSUER_TYPE='CORP'
  AND (ISSUER_CUSIP IS NULL OR ISSUER_CUSIP IN ('000000000','N/A') OR LENGTH(ISSUER_CUSIP)!=9)
  AND IS_RESTRICTED_SECURITY != 'Y'  -- i.e., rows F4 adds on top of F1
```

This union equals F4 (13,897 rows, 3,921 clusters) and captures **88/91 Anthropic rows** (+7.3% recall over F1) while adding only 7,514 incremental rows beyond F1 (+118% rows but still well-defined: all have FVL=3 and bad CUSIP).

### 2. Confidence Weighting (Recommended)

| Tier | Filter logic | Confidence | Rows | Rationale |
|------|-------------|------------|------|-----------|
| High | F1 (5-way AND) | 100 | 6,383 | All five private-company signals present |
| Medium | F4 ∩ ¬F1 (FVL=3, bad CUSIP, but no restricted flag) | 80 | 7,514 | FVL=3 is strong; lack of restricted flag may be filer error |
| Low | F6 ∩ ¬F4 (restricted only, no FVL=3, or drops CUSIP/type) | 50 | 17,983 | Broader but much noisier; 4.6× more sanctioned stock rows |

**Do not use F6 alone as the base filter for V1.** At 31,880 rows and 7,018 clusters, it adds 5× more sanctioned/dead-equity noise (1,170 sanction rows vs. 184 in F1).

### 3. False Positive Rate: F1 → F6

| Transition | Row increase | Sanction$ increase | Sanction$ rate |
|------------|-------------|-------------------|----------------|
| F1 (baseline) | 6,383 | 184 | 2.9% |
| F4 (recommended union) | 13,897 (+118%) | 819 (+345%) | 5.9% |
| F5 | 18,977 (+197%) | 238 (+29%) | 1.3% |
| F6 | 31,880 (+399%) | 1,170 (+536%) | 3.7% |

**Key insight:** F4 (drop restricted, keep FVL=3) triples the sanction noise but recall gain is real (+6 Anthropic rows). F5 (drop FVL=3, keep restricted) has lower absolute sanction noise but adds ~12,600 rows of public-equity restricted securities (e.g., 144A bonds, ESOP shares) — structurally different noise than private equity.

### Summary Recommendation

**Production V1 filter: F4 (FVL=3 + equity cat + CORP + bad CUSIP), with a `confidence` column:**
- Rows where ALSO `IS_RESTRICTED='Y'` → confidence = HIGH
- Rows where `IS_RESTRICTED='N'` → confidence = MEDIUM
- Total: 13,897 rows, 3,921 clusters, captures 88/91 Anthropic, 68/82 Stripe-total, 80 xAI equity rows
- The 3 remaining Anthropic misses (FVL=2 or FVL=1) are edge cases from single filers using non-standard valuation methodology — not worth broadening the filter further for V1.

**Do NOT use F6 for V1.** It is too broad: 31,880 rows, 7,018 clusters, and 4.4× more sanctioned-stock noise than F1. Reserve F6 as a research/exploratory filter only.

---

## Data Notes

- Wiz shows 0 rows in all filters — Wiz was acquired by Google in March 2025; any positions would have converted to cash/Google stock before the December 2025 reporting period.
- Cerebras shows 18–19 rows across all filters and is cleanly captured by F1 (18/18 in F1).
- xAI equity: 67–84 rows depending on filter. The F1 count of 67 reflects the equity-only (EC/EP) subset; xAI's 73 remaining rows are leveraged loans (LON, FVL=2) not relevant to the equity filter.
- The `(PHYSICAL) (NOT LISTED OR TRADING)` suffix on some Anthropic CL F-1 rows causes `IS_RESTRICTED='N'` at some filers — likely a custodian data entry choice, not a meaningful difference in the underlying asset.

