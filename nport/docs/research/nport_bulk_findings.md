# SEC Form N-PORT Bulk Dataset — Research Findings
**Dataset:** 2026 Q1 (covering period ending December 31, 2025, filed ~April 3, 2026)
**Source URL:** https://www.sec.gov/files/dera/data/form-n-port-data-sets/2026q1_nport.zip
**ZIP size:** 442 MB compressed / 1.6 GB uncompressed (32 files)

---

## 1. Schema — FUND_REPORTED_HOLDING.tsv

**File size:** 938 MB uncompressed  
**Row count:** 5,941,068 rows (5,941,067 data rows + 1 header)

| # | Column | Example values |
|---|--------|----------------|
| 1 | ACCESSION_NUMBER | `0001410368-26-023536`, `0000035402-26-002034` |
| 2 | HOLDING_ID | `166198577`, `166198581` |
| 3 | ISSUER_NAME | `Accenture PLC`, `ANTHROPIC PBC`, `DATABRICKS INC` |
| 4 | ISSUER_LEI | `5493000EWHDSR3MZWH98`, `N/A` |
| 5 | ISSUER_TITLE | `Accenture PLC`, `ANTHROPIC PBC SERIES G PC PP` |
| 6 | ISSUER_CUSIP | `110122108`, `000000000`, `N/A` |
| 7 | BALANCE | `1141`, `587`, `393051` |
| 8 | UNIT | `NS` (number of shares), `PA` (principal amount) |
| 9 | OTHER_UNIT_DESC | (usually blank) |
| 10 | CURRENCY_CODE | `USD`, `JPY`, `GBP` |
| 11 | CURRENCY_VALUE | `300813.24`, `107589850.23` |
| 12 | EXCHANGE_RATE | (blank for USD; e.g. `156.14` for JPY) |
| 13 | PERCENTAGE | `2.297055964623`, `0.0749337053` |
| 14 | PAYOFF_PROFILE | `Long`, `Short`, `N/A` |
| 15 | ASSET_CAT | `EC` (equity common), `EP` (equity pref), `LON` (loan), `DE` (derivative), `DBT` (debt), `OTHER` |
| 16 | OTHER_ASSET | (description when ASSET_CAT=OTHER) |
| 17 | ISSUER_TYPE | `CORP`, `RF` (registered fund), `OTHER`, `ABS` |
| 18 | OTHER_ISSUER | (description when ISSUER_TYPE=OTHER) |
| 19 | INVESTMENT_COUNTRY | `US`, `IE`, `JP`, `GB` |
| 20 | IS_RESTRICTED_SECURITY | `Y`, `N` |
| 21 | FAIR_VALUE_LEVEL | `1` (quoted), `2` (observable inputs), `3` (unobservable/illiquid) |
| 22 | DERIVATIVE_CAT | (e.g. `SWP` for swap; usually blank for equities) |

**Key join:** ACCESSION_NUMBER links to REGISTRANT.tsv (fund family name, CIK, address) and FUND_REPORTED_INFO.tsv (series name, total assets, net assets).

**Other tables in ZIP:** SUBMISSION.tsv, REGISTRANT.tsv, FUND_REPORTED_INFO.tsv, DEBT_SECURITY.tsv (157MB), IDENTIFIERS.tsv (282MB), SECURITIES_LENDING.tsv (114MB), plus 20 derivative tables.

---

## 2. Heuristic Filters — "Private-Looking" Holdings

Applied to all 5,941,068 rows:

| Heuristic | Row Count | % of total |
|-----------|-----------|------------|
| IS_RESTRICTED_SECURITY = Y | 1,781,543 | 30.0% |
| FAIR_VALUE_LEVEL = 3 | 1,680,456 | 28.3% |
| Bad/missing CUSIP (blank, 000000000, N/A, non-9-char) | 2,657,923 | 44.7% |
| ISSUER_TITLE contains keyword (Series/Preferred/Class/LLC/SPV/LP/Units/Private/Restricted/Membership) | 494,914 | 8.3% |
| **Any of (Restricted OR FVL=3 OR title keyword)** | **2,252,577** | **37.9%** |

**Notes:**
- Bad CUSIP alone is too broad (44.7%) — many foreign equities legitimately lack US CUSIPs
- The combined filter (restricted OR FVL=3 OR title keyword) gives a 2.25M row "private universe"
- FVL=3 is the strongest single signal: these are positions where the fund cannot mark to a market price, i.e., truly illiquid/private

---

## 3. Tracked Private Company Match Counts

| Company | Rows | Fund Families | Total Reported Value (USD) |
|---------|------|---------------|---------------------------|
| Databricks | 360 | 99 | $6,329,266,866 |
| Canva | 179 | 47 | $1,445,529,597 |
| Anduril | 119 | 25 | $562,311,735 |
| SpaceX | 125 | 30 | $21,473,030,883 |
| OpenAI | 110 | 39 | $2,722,901,874 |
| Anthropic | 91 | 41 | $2,561,487,022 |
| xAI (X.AI Corp) | 76 | 52 | $278,221,854 |
| Stripe | 82 | 32 | $1,324,493,474 |
| Perplexity AI | 7 | 6 | $58,724,976 |
| Scale AI | 0 | 0 | $0 |

**Total across all tracked companies:** $36.8 billion disclosed AUM in these names.

### Concrete examples per company

**Anthropic (91 rows):** All ASSET_CAT=EP (preferred) or EC (common), ISSUER_TYPE=CORP, Restricted=Y, FVL=3, CUSIP=N/A. Example: "ANTHROPIC PBC SERIES D PC PP" — 393,051 shares, $107.6M. Another: "ANTHROPIC PBC SERIES G PC PP" — 34,700 shares, $9.0M.

**SpaceX (125 rows):** Mix of common (EC) and preferred (EP). Examples: "SPACE EXPLORATION TECH CORP SER J PC PP" ($22.6M), "SPACE EXPLORATION TECH CLASS C" (unlabeled PP rows), plus SPV wrappers like "SPV EXPOSURE TO SPACEX LLC" and "MWAM VC SpaceX-II, LLC". All Restricted=Y, FVL=3, CUSIP=N/A.

**OpenAI (110 rows):** Filed as "OPENAI GROUP PBC" (new legal name post-conversion). Also some legacy LLC units: "AESTAS LLC dba OPENAI LLC EV UNITS Class A", "DXYZ OAI I LLC (economic exposure to OpenAI Global LLC, Profit Participation Units)". Mix of Class A, A-2, A-3 share classes.

**Databricks (360 rows):** Largest hit count by far. Includes both equity preferred (EP, FVL=3) and leveraged loans (LON, FVL=2/3). Loan CUSIPs like `BA000D1C1`, `BA000TDP4` (Bloomberg synthetic). Series G, J, K preferred.

**Anduril (119 rows):** Series F, G preferred and Class B common. Entirely Restricted=Y, FVL=3.

**Canva (179 rows):** Issuer filed as "CANVA AUSTRALIA HOLDINGS PTY LTD" (parent entity). Titles reference "CANVA INC" — a US subsidiary. Series A, A-2 preferred plus Class A common.

**xAI (76 rows):** Dominated by leveraged loans (FVL=2, not equity). "X.AI LLC SR SEC 1ST LIEN 12.5% 06-30-30" — term loan held by 40+ CLO/credit funds. Only 3 equity/preferred rows (Series C, Series E CVT PFD, FVL=3). xAI is primarily showing up as a credit borrower, not a VC-style equity investment.

**Perplexity AI (7 rows):** Small universe. All "PERPLEXITY AI SER E-1 CVT PFD PP", Restricted=Y, FVL=3, CUSIP=000000000. One outlier: "Perplexity AI, Inc." with Restricted=N, FVL=3.

**Scale AI (0 rows):** Not present in 2026 Q1 N-PORT data under any name variant (checked "Scale Inc", "Scale AI", bare "Scale" excluding noise terms).

---

## 4. Anthropic Title Messiness Sample (15 distinct titles in dataset)

```
'ANTHROPIC'
'ANTHROPIC PBC'
'ANTHROPIC PBC CL F-1 PFD PP (PHYSICAL) (NOT LISTED OR TRADING)'
'ANTHROPIC PBC SER B PC PP'
'ANTHROPIC PBC SER F-1 CVT PFD PP'
'ANTHROPIC PBC SERIES D PC PP'
'ANTHROPIC PBC SERIES E PC PP'
'ANTHROPIC PBC SERIES F PC PP'
'ANTHROPIC PBC SERIES G PC PP'
'ANTHROPIC, PBC SERIES E-1 PREFERRED STOCK'
'Anthropic PBC'
'Anthropic PBC, Series F'
'Anthropic PBC, Series F1'
'Anthropic PBC, Series G-1'
'Anthropic, Inc.'
```

**Key observations:**
- No CUSIP or LEI — matching must be done purely on text
- Series labels are inconsistent: "SER B", "SERIES B", "Series F", "Series F1", "SER F-1" all appear
- Case is inconsistent (upper vs. title case)
- Legal entity name is inconsistent: "Anthropic PBC", "ANTHROPIC PBC", "Anthropic, Inc.", "ANTHROPIC"
- "PP" suffix = private placement marker added by the data vendor (not from the filer)
- "PC" = perpetual/convertible preferred; "CVT PFD" = convertible preferred
- "(PHYSICAL) (NOT LISTED OR TRADING)" annotations appear on some rows

---

## 5. Fund Family Distribution

Top registrants by number of positions across all 10 tracked companies:

| Count | Registrant Name |
|-------|----------------|
| 85 | Fidelity Securities Fund |
| 75 | Fidelity Mt. Vernon Street Trust |
| 71 | Fidelity Contrafund |
| 55 | Fidelity Advisor Series I |
| 34 | Variable Insurance Products Fund III |
| 25 | Fidelity Puritan Trust |
| 24 | PIMCO Funds |
| 21 | T. ROWE PRICE INTERNATIONAL FUNDS, INC. |
| 21 | T. ROWE PRICE EQUITY SERIES, INC. |
| 21 | T. Rowe Price Equity Funds, Inc. |
| 20 | Fidelity Investment Trust |
| 20 | T. ROWE PRICE SPECTRUM FUNDS II, INC. |
| 19 | Fidelity Select Portfolios |
| 18 | Variable Insurance Products Fund II |
| 17 | LINCOLN VARIABLE INSURANCE PRODUCTS TRUST |
| 16 | StepStone Private Venture & Growth Fund |
| 15 | AMERICAN FUNDS INSURANCE SERIES |
| 15 | Variable Insurance Products Fund / IV |
| 13 | BARON SELECT FUNDS |
| 12 | NEUBERGER BERMAN EQUITY FUNDS |
| 12 | Coatue Innovative Strategies Fund |
| 12 | Growth Fund of America |
| 11 | Franklin Strategic Series |

**Fidelity dominates** with ~330 position-records across 6+ Fidelity trusts, reflecting their large active growth funds with VC co-investment rights. T. Rowe Price is second with ~80 position-records. PIMCO appears primarily for xAI/Databricks credit positions (leveraged loans), not equity.

---

## 6. Surprises and Notable Findings

1. **SpaceX is the single largest disclosed position: $21.5B** — more than 8x Databricks ($6.3B) and nearly 10x OpenAI ($2.7B). This reflects SpaceX's very high per-share price and large institutional ownership predating Starship/Starlink IPO speculation.

2. **xAI is primarily a credit story, not equity.** 70+ of its 76 rows are leveraged loans (FVL=2, LON asset cat) — "X.AI LLC SR SEC 1ST LIEN 12.5% 06/17/30" — held by CLO-style credit funds. Only 3 rows are equity preferred. This is different from the other AI companies which are almost exclusively VC-style equity.

3. **OpenAI's corporate restructuring creates title chaos.** Rows appear under "OPENAI GROUP PBC" (new PBC entity), "OpenAI Global, LLC" (old LLC), "AESTAS LLC dba OPENAI LLC" (SPV), and "DXYZ OAI I LLC" (a Destiny Tech100 wrapper). Accurate aggregation requires fuzzy matching plus entity-type disambiguation.

4. **Databricks dwarfs other AI companies by position count (360 rows).** This reflects its early IPO anticipation and widespread adoption across growth-oriented mutual funds. It also has dual exposure: equity preferred AND leveraged loans.

5. **Scale AI is absent.** No N-PORT filings disclose Scale AI positions in Q1 2026. This likely means Scale AI has not raised from mutual funds / variable annuity funds, or is held exclusively through private funds (LP interests) not covered by N-PORT.

6. **"PP" suffix is a vendor annotation.** The "(PP)" at the end of most private company titles is added by the fund's data vendor/custodian to flag private placements — it is NOT part of the official company name and must be stripped for clean matching.

7. **CURRENCY_VALUE is the dollar value, not BALANCE.** BALANCE is shares/units; CURRENCY_VALUE is the USD equivalent. For non-USD holdings, EXCHANGE_RATE is populated.

8. **13,148 filings (fund-series level) in this quarter.** REGISTRANT.tsv has 1,938 unique registrant entities (fund families). Average ~6.8 series per registrant.

---

## 7. Database Design Recommendations

For ingesting this into a queryable system:

**Primary tables:**
- `nport_holdings` — direct load of FUND_REPORTED_HOLDING.tsv columns
- `nport_registrants` — from REGISTRANT.tsv (CIK, name, address)
- `nport_funds` — from FUND_REPORTED_INFO.tsv (series name, total assets)

**Indexing priorities:**
- `(ISSUER_NAME, FAIR_VALUE_LEVEL, IS_RESTRICTED_SECURITY)` — for private company queries
- `ACCESSION_NUMBER` — for joins
- GIN/tsvector index on ISSUER_NAME+ISSUER_TITLE for fuzzy text search

**Private company identification:**
- Filter: `FAIR_VALUE_LEVEL = '3' AND IS_RESTRICTED_SECURITY = 'Y'` is the cleanest signal (1.2M overlapping rows)
- CUSIP = 'N/A' or '000000000' combined with FVL=3 narrows further
- Text normalization required: strip " PP", " PC", normalize case, standardize series labels

