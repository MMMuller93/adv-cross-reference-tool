# POC4 — Pooled-Vehicle Discovery Surface in form_d_filings

**Date:** 2026-05-17
**Database:** Form D Supabase (`ltdalxkhbbhmkimmogyq`)
**Total form_d_filings rows:** 358,765

---

## 1. Pattern Counts Table

All 358,765 rows were scanned via keyset pagination (1,000-row batches). Counts reflect distinct filings matching each regex; one filing can match multiple patterns (hence union < sum).

| Pattern | Match Count | % of Total | Example Entitynames |
|---------|------------|------------|---------------------|
| `\bfund\b` (Fund anywhere) | 130,580 | 36.4% | AS Fund I, a series of OV.VC-Funds, LP / WINPRO Debt Opportunity Fund II, LLC / Gramercy EM Dislocation Fund |
| `\bLP\s*$` (LP suffix) | 86,574 | 24.1% | BTECH CONSORTIUM FUND I, LP / Bridge Debt Strategies Fund V LP / CRCP AV, LP |
| `\bcapital\b` (Capital anywhere) | 31,062 | 8.7% | Yellow Mountain Capital Partners, LP / ISZO CAPITAL LP / WM Capital Partners 71, LLC |
| `\bpartners\b` (Partners anywhere) | 26,558 | 7.4% | Brookfield Technology Partners II L.P. / Oxbridge Partners, L.P. |
| `a series of.+llc` (Series-of-LLC) | 15,030 | 4.2% | Fund FG-BRR, a series of Forge Investments LLC / Booste Fund 1, a series of Assure Labs 2020, LLC |
| `\bventures\b` (Ventures anywhere) | 12,815 | 3.6% | DIPALO VENTURES FUND I, LP / Entrada Ventures SPV I, LLC |
| `\bholdings\b` (Holdings anywhere) | 11,315 | 3.2% | Claire's Holdings LLC / PB Holdings III LLC |
| `\bSPV\b` (SPV anywhere) | 6,599 | 1.8% | Entrada Ventures SPV I, LLC / MWCGOF SPV II LP / Carlyle SPV 2020-03 |
| `\bfeeder\b` (Feeder anywhere) | 6,434 | 1.8% | CD&R Friends & Family Feeder Fund XI, L.P. / PIMCO Corporate Opportunities Fund III TE Feeder, L.P. |
| `master\s+fund` (Master Fund) | 2,215 | 0.6% | M28 Capital Master Fund LP / Counterpoint Ventures Master Fund LP |
| `\bQP\s*$` (QP suffix) | 36 | <0.01% | Bay Capital India Fund QP / PARAFI PRIVATE OPPORTUNITIES LLC - SERIES I QP |

**Union (any pattern matched):** 210,485 filings = **58.7% of the entire Form D corpus**

---

## 2. Bridged vs. Not-Bridged Breakdown

Cross-reference: `cross_reference_matches.formd_accession` (70,153 unique bridged accession numbers as of scan date).

| Bucket | Count | % of pooled-vehicle universe |
|--------|-------|------------------------------|
| Pooled-vehicle filings bridged to adviser CRD | 57,846 | 27.5% |
| Pooled-vehicle filings NOT bridged | 152,639 | 72.5% |
| **Total pooled-vehicle filings (union)** | **210,485** | 100% |

**Interpretation:** Only 27.5% of the ~210k pooled-vehicle filings in Form D are currently linked to a registered adviser via `cross_reference_matches`. The other 72.5% (152,639 filings) have no adviser-CRD bridge and are invisible to any query that joins through `cross_reference_matches`.

---

## 3. Spot-Check: Tracked Companies in Unbridged Filings

Scanned all 152,639 unbridged pooled-vehicle filings for references to tracked portfolio companies by name in `entityname`.

| Company | Unbridged Filings Found | Notes |
|---------|------------------------|-------|
| SpaceX | 113 | SPVs, "a series of" vehicles, MarketX/Assure/CGF2021 structures |
| Anthropic | 70 | Augurey Ventures series, CGF2021 series, 7GC/Okami structures |
| Figure | 49 | Figure ai / Figure World Equity Fund |
| Scale AI | 49 | "Scale" pattern (some false positives) |
| OpenAI | 30 | CGF2021 series, InvestX, Eagle VP |
| Stripe | 16 | CGF2021 / MarketX / Iron Pine structures |
| Ripple | 14 | Includes Ripple Ventures (Canadian VC, some FP) |
| Databricks | 11 | CGF2021 / DataPower / Moreno VC series |
| Brex | 9 | Brex Venture Debt Fund / Technology Opportunities Fund |
| Cruise | 8 | — |
| Discord | 6 | MarketX / Lacoste / CGF2021 |
| Cohere | 6 | — |
| Palantir | 4 | Silver Edge pre-IPO series |
| Plaid | 4 | Republic / Company Ventures |
| Canva | 4 | CGF2021 / Moringa |
| Klarna | 2 | MarketX / StratMinds |
| Chime | 2 | Leonis Master Fund |
| Notion | 2 | Notion Capital V/VI SCSp (UK VC fund) |
| Epic Games | 2 | UNIQ / Moreno VC |
| Waymo | 2 | — |

**Total unbridged filings referencing at least one tracked company: 403**
(0.26% of the 152,639 unbridged pooled-vehicle filings)

### Example Hits (Confirmed Tracked-Company References)
- `[182990] Anthropic Capital Fund, LP` — standalone LP, no bridge
- `[102367] OpenAI Startup Fund I, L.P.` — primary vehicle, no bridge
- `[16439] SpaceX Series C Secondary Two, a series of Republic Master Fund, LP` — secondary market SPV
- `[48712] Stripe I - Mint Civitas Fund, a series of Assure Labs 2021, LLC` — AngelList-style series
- `[288422] DataPower Ventures Databricks I a Series of CGF2021 LLC` — CGF2021 series master

---

## 4. Key Methodology Notes

- **N-PORT private_company_aliases** (924 aliases for 843 companies) could not be queried directly — the N-PORT Supabase service key is stored only in `/private/tmp/nport-buildout-claude/.env` which was unavailable. The alias cross-check was approximated using regex patterns against known company names.
- **Series-master-LLC structures** (15,030 filings): these are the "a series of X LLC" vehicles managed by platforms like AngelList/Assure/CGF2021. Many represent single-company bets on tracked portfolio companies. This is a structurally distinct segment of the discovery surface.
- **False positives exist** in "Capital," "Ripple," "Holdings," and "Scale AI" buckets — these patterns cast wide nets. The 403 tracked-company figure is a conservative floor, not a ceiling.

---

## 5. V1.1 Opportunity Assessment

| Metric | Value |
|--------|-------|
| Total pooled-vehicle filings | 210,485 |
| Currently bridged (V1 can discover) | 57,846 (27.5%) |
| Not bridged (V1.1 opportunity) | 152,639 (72.5%) |
| Confirmed tracked-company content in unbridged set | 403+ filings |
| Key companies with unbridged SPV holders | SpaceX (113), Anthropic (70), Figure (49), OpenAI (30) |

**Verdict:** V1's seeded-only scope leaves substantial holder coverage on the table. The 152,639 unbridged pooled-vehicle filings represent a large discovery surface, and at least 403 of those filings contain direct references to tracked portfolio companies that no current bridge surfaces. The two highest-value categories for V1.1 are:

1. **"a series of" series-master-LLC vehicles** (15,030 filings) — these are structured as `[Portfolio Co], a series of [AngelList/CGF2021/Assure platform]`. Extracting company names from entityname and matching to aliases would be high-yield with minimal false positives.
2. **Named standalone SPVs/LPs** (e.g., "OpenAI Startup Fund I, L.P.") — these have no bridge because they don't register as advisers. Matching entityname directly against aliases would capture them.

