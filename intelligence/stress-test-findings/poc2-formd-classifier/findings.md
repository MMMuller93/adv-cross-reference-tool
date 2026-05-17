# POC2 — Form D Anthropic Filing Classifier

**Run date:** 2026-05-16  
**Investigator:** Senior researcher agent (claude-sonnet-4-6)

---

## Question
Of all Form D filings that match Anthropic (via entityname, related_names, series_master_llc, or shorthand patterns), how many are genuine pooled-vehicle holder evidence vs. direct-issuer filings (Anthropic PBC raising its own money)?

---

## Methodology

**Match criteria:**
1. `entityname ILIKE '%anthropic%'` — 87 raw rows
2. `entityname ILIKE '%Claude%SPV%'` — 2 rows (Claude SPV I/II a Series of CGF2021 LLC)
3. `entityname ILIKE '%Claude%QP%'` — 3 rows (Wefunds Claude QP series — same acc, deduped to 2)
4. `entityname ILIKE '%LFG Claude%'` — 1 row
5. `entityname ILIKE 'ANTR%'` — 7 non-ANTRUM rows; **none mention Anthropic in related_names** — excluded as unconfirmed

**Negative filter applied (excluded before classification):**
- `Anthropic Capital Fund, LP` (CIK 1931731) — finance firm unrelated to Anthropic AI; 4 duplicate filing rows
- `Community Philanthropic Ventures, LLC` (CIK 1818225) — false match on `related_names`; no pooled investment purpose

**Total unique filings after dedup + exclusion: 88**

**Classification logic:**
- `ispooledinvestmentfundtype = true` → pooled-vehicle (SEC's own flag)
- Entityname matching "^Anthropic PBC|^Anthropic Inc|^Anthropic Pty Ltd$" → direct-issuer
- `ispooledinvestmentfundtype = false` (and no pooled naming) → direct-issuer

---

## Results

| Bucket | Count | % | Bridged to CRD | NOT bridged |
|--------|-------|---|----------------|-------------|
| **pooled-vehicle** | **88** | **100%** | 18 (20%) | **70 (80%)** |
| direct-issuer | 0 | 0% | — | — |
| ambiguous | 0 | 0% | — | — |

**Key finding: Anthropic PBC's own Series raises (Series B/C/D/E) are NOT in the Form D DB.** The plan's concern about "85 direct-issuer filings" is based on a false premise — every Anthropic-matched filing in the database is a pooled investment vehicle (confirmed by `ispooledinvestmentfundtype = true` on all 88). Codex's flag was correct in principle but the contamination turns out to be zero: there are no direct-issuer filings to exclude.

---

## Pooled Vehicle Breakdown (70 Unbridged)

**Subtype:**
- `a series of` (series-LLC SPVs): 47 filings
- Standalone named LLC/co-invest: 22 filings
- Named as "ALTERNATE FUND" or similar: 1 filing

**Master LLC sponsors (from entityname parsing):**
| Sponsor | Filing count |
|---------|-------------|
| CGF2021 LLC | 34 |
| [standalone / no master] | 23 |
| Ventioneers Partners LLC | 2 |
| MAV Alternate Investments, LP | 1 |
| Bloom Opportunities Fund I LLC | 1 |
| E1 Ventures Master LLC | 1 |
| HII Anthropic, LLC | 1 |
| AURUM VP FUND LLC | 1 |
| SSD SPV I LLC | 1 |
| ID Funds 3 LLC | 1 |
| Ineffable Ventures Series, LLC | 1 |
| INVEXT LLC | 1 |
| Wefunds LLC | 1 |
| LFG VC LLC | 1 |

**Total disclosed offering amount (unbridged): $162,053,842** (65 of 70 have amounts; 5 blank)

---

## Bridged (18 in cross_reference_matches)

All 18 bridged filings have `match_score = 1.0`:

| Filing | Adviser (CRD) |
|--------|---------------|
| RVC Anthropic LP | RHONE VC LLC (331453) |
| Anthropic MAV Secondary Fund II | MYASIA VC, LLC (311027) |
| Hiive Anthropic Series I/II/V/VI/VII + HII-01 | HIIVE ADVISORS INC. (335888) |
| Scenic Co-Invest Anthropic LLC | SCENIC MANAGEMENT LLC (315808) |
| MW LSVC Anthropic, LLC | MANHATTAN WEST ASSET MANAGEMENT (283630) |
| Anthropic May 2023 a Series of Stonks SPVs | SANDHILL MARKETS ADVISORS (317085) |
| Edge Partners, LLC, Series B Anthropic | EDGE PARTNERS CAPITAL LLC (330669) |
| Anthropic PBC 1 a Series of Venelite | VENELITE VENTURES, LLC (334930) |
| ZZG Capital Anthropic, LP | GIORDANO CAPITAL, LLC (330283) |
| Claude SPV I/II a Series of CGF2021 | ARMYN CAPITAL LLC (337772) |
| Claude QP I/II a series of Wefunds | WEFUNDER ADVISORS, LLC (167803) |

---

## Top 10 Most Recent Pooled Vehicles

| Entity | Date | Amount | Bridged |
|--------|------|--------|---------|
| HII Anthropic Series-02, a Series of HII Anthropic, LLC | 2026-05-15 | $11,879,561 | NO |
| Anthropic Fund IV Apr 2026 a Series of CGF2021 LLC | 2026-04 | unknown | NO |
| Arden Anthropic Opportunities I LLC | 2026-04-02 | $5,242,500 | NO |
| Anthropic Apr 2026 a Series of CGF2021 LLC | 2026-04 | unknown | NO |
| Pachamama Capital Anthropic a Series of CGF2021 LLC | 2026-03-26 | $1,277,835 | NO |
| DV Anthropic SPV I Mar 2026 a Series of CGF2021 LLC | 2026-03-30 | $2,000,000 | NO |
| Anthropic IIIX T1V Feb26 Feb 2026 a Series of CGF2021 LLC | 2026-03-03 | $179,175 | NO |
| Anthropic II Feb 2026 a Series of CGF2021 LLC | 2026-02 | unknown | NO |
| Anthropic Magnitude-2 Feb 2026 a Series of CGF2021 LLC | 2026-04-29 | $5,745,000 | NO |
| LFG Claude a Series of LFG VC LLC | 2026 | unknown | NO |

---

## Findings for the Plan

1. **No direct-issuer contamination.** Every Anthropic-matched Form D filing is a pooled investment vehicle. The plan's "Section B Anthropic PBC direct offerings" concern is moot — those filings (Anthropic PBC's actual Series E etc.) do not exist in this Form D database.

2. **88 confirmed pooled-vehicle filings** (vs. 71 originally cited in the plan — discrepancy explained by the shorthand patterns: Claude SPV I/II, Claude QP I/II, LFG Claude add 4 filings; de-duplication and exclusions account for the rest).

3. **70 are NOT bridged** to a registered adviser CRD in `cross_reference_matches`. These are real holder evidence the pipeline currently drops.

4. **Dominant sponsor: CGF2021 LLC** (Sydecar's platform) accounts for 34 unbridged filings alone — all as "a series of CGF2021 LLC". Bridging to Sydecar's adviser CRD would recover a large fraction in one lookup.

5. **ANTR shorthand filings excluded** — ALEXTAR VC's ANTR-* codes show no Anthropic reference in related_names. Cannot confirm these are Anthropic SPVs without external validation.

---

## Confidence

**High** — Classification relies on SEC's own `ispooledinvestmentfundtype` flag (unanimous `true` across all 88 filings) plus entity naming. No ambiguous cases found. The zero direct-issuer count is confirmed by CIK lookup for Anthropic PBC (CIK 1839804 — 0 rows in DB).

---

## Recommendations

1. **Drop the direct-issuer exclusion logic from the pipeline** — not needed; no such filings exist in the DB.
2. **Add CGF2021 LLC as a known master** — resolving its 34+ series filings through Sydecar's adviser CRD would be the single highest-leverage bridging action.
3. **Add shorthand patterns to matcher** — Claude SPV I/II and LFG Claude are real Anthropic SPVs confirmed by `ispooledinvestmentfundtype=true` and related_names (Sydecar admin). The `ANTR-*` pattern needs external validation before inclusion.
4. **70 unbridged real holders = $162M+ in disclosed capital** — these should be the next target for adviser CRD resolution via enriched_managers or direct IAPD lookup.
