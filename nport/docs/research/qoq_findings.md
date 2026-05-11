# SEC Form N-PORT — Quarter-over-Quarter Markup Analysis
**Periods:** Q4 2025 (period ending Sep 30, 2025) vs Q1 2026 (period ending Dec 31, 2025)
**Source:** SEC DERA N-PORT bulk data sets — `2025q4_nport.zip` (398 MB) and `2026q1_nport.zip` (442 MB)
**Dataset row counts:** Q4 2025: 5,105,506 holding rows | Q1 2026: 5,941,068 holding rows

**Data quality notes:** Three false-positive categories were filtered from the raw results:
- "Under Canvas Inc" (a glamping company) matched on "Canva"
- "Pinstripes Holdings" (restaurant chain) and "Stripes VI Rainier" (PE fund) matched on "Stripe"
- "Anyscale Inc" (Ray/MLflow startup) matched on "Scale AI"

---

## 1. Q4 2025 Match Counts

| Company | Rows | Fund Families | Total Value (USD) | Asset Cat Breakdown |
|---------|------|---------------|-------------------|---------------------|
| Anthropic | 84 | 39 | $1.44B | EC:3 / EP:74 / LON:1 / OTHER:6 |
| OpenAI | 78 | 35 | $1.68B | EC:14 / EP:39 / LON:1 / OTHER:24 |
| SpaceX | 139 | 31 | $12.56B | EC:74 / EP:50 / LON:3 / OTHER:12 |
| Stripe | 94 | 32 | $1.21B | EC:20 / EP:37 / LON:35 / OTHER:2 |
| Databricks | 291 | 90 | $4.31B | EC:18 / EP:145 / LON:114 / OTHER:14 |
| Anduril | 117 | 26 | $474.3M | EC:13 / EP:96 / LON:8 |
| Canva | 180 | 44 | $1.00B | EC:95 / EP:73 / LON:8 / OTHER:4 |
| xAI | 229 | 99 | $2.21B | EC:18 / EP:40 / LON:166 / OTHER:5 |
| Perplexity | 7 | 6 | $42.8M | EP:7 |
| Scale AI | 0 | 0 | $0 | — |

**Total Q4 2025 disclosed AUM across tracked companies: $24.92B**

### Q4 2025 Example Issuer Titles per Company

**Anthropic:**
- `ANTHROPIC PBC SERIES D PC PP`
- `ANTHROPIC PBC SERIES E PC PP`
- `ANTHROPIC, PBC SERIES E-1 PREFERRED STOCK`
- `Anthropic, Inc.`
- `Anthropic PBC, Series F-1`

**OpenAI:**
- `OPEN AI GLOBAL LLC CONVERTIBLE INTEREST RT 2 PP`
- `OPENAI GLOBAL, LLC`
- `AESTAS LLC dba OPENAI LLC EV UNITS Class A`
- `DXYZ OAI I LLC (economic exposure to OpenAI Global LLC, Profit Participation Units)`
- `OpenAI Global, LLC`

**SpaceX:**
- `SPACE EXPLORATION TECH CORP PP`
- `SPACE EXPLORATION TECHNOLOGIES`
- `SPACE EXPLORATION TECH CORP SER N PC PP`
- `SPACE EXPLORATION TECHNOLOGIES CORP. COMMON SHARES`
- `SPACE EXPLORATION TECH CLASS A`

**Stripe:**
- `STRIPE INC SERIES I PREF STOCK`
- `STRIPE INC CL B COMMON PP`
- `Stripe, Inc., Class B`
- `STRIPE`
- `STRIPE INC`

**Databricks:**
- `DATABRICKS INC SER J PFD PP`
- `DATABRICKS, INC. SERIES H PREFERRED SHARES`
- `DATABRICKS INC`
- `DATABRICKS, INC. TERM LOAN`
- `Databricks Inc Last Out Term Loan`

**Anduril:**
- `ANDURIL INDUSTRIES INC SER F PFD PP`
- `ANDURIL INC SER G PC PP`
- `ANDURIL INDUSTRIES INC CLASS B PP`
- `ANDURIL INDUSTRIES SERIES F`
- `ANDURIL IND SER F PC PP`

**Canva:**
- `CANVA INC CL A`
- `CANVA COMMON STOCK`
- `CANVA INC COMMON A RESTRICTED`
- `CANVA INC SER A-2 PC PERP PP`
- `CANVA INC SER A PC PERP PP`

**xAI:**
- `X.AI HOLDINGS CORP CLASS A P/P`
- `X.AI, HOLDINGS CORP. CLASS B`
- `XAI CORP` (term loan)
- `X.AI LLC / X.AI CO ISSUER CO 12.5% 06/30/2030` (term loan)
- `X.AI HOLDINGS CORP SER B PC PP`

**Perplexity:**
- `PERPLEXITY AI SER E-1 CVT PFD PP`
- `PERPLEXITY AI SER D-1 CVT PFD PP`
- `Perplexity AI, Inc.`

---

## 2. Q4 2025 → Q1 2026 Delta Table

| Company | Q4 Fam | Q1 Fam | Fam Δ | Q4 Value | Q1 Value | Value Δ | Δ% | Matched Pairs | Pure-Markup Median | Best Markup | Best Markdown |
|---------|--------|--------|-------|---------|---------|---------|-----|--------------|-------------------|-------------|--------------|
| Anthropic | 39 | 41 | +2 | $1.44B | $2.56B | +$1.13B | +78.5% | 54 | +0.1% | +84.3% (Fidelity Blue Chip Growth) | none |
| OpenAI | 35 | 39 | +4 | $1.68B | $2.72B | +$1.04B | +61.7% | 54 | +7.5% | +55.4% | -17.2% (ARK) |
| SpaceX | 31 | 30 | -1 | $12.56B | $21.47B | +$8.92B | +71.0% | 50 | +89.5% | +100.0% (NB Quality Equity) | none |
| Stripe | 32 | 33 | +1 | $1.21B | $1.34B | +$132.5M | +11.0% | 35 | +16.7% | +52.8% | -31.0% (BlackRock Private Investments) |
| Databricks | 90 | 99 | +9 | $4.31B | $6.33B | +$2.02B | +46.8% | 121 | +26.7% | +44.1% | -1.5% (Ares) |
| Anduril | 26 | 25 | -1 | $474.3M | $562.3M | +$88.0M | +18.5% | 42 | +10.5% | +32.8% | none |
| Canva | 44 | 47 | +3 | $1.00B | $1.45B | +$444.4M | +44.4% | 64 | +0.0% | +27.5% | -6.1% (Fidelity Capital Appreciation) |
| xAI | 99 | 105 | +6 | $2.21B | $4.20B | +$2.00B | +90.5% | 141 | +78.3% | +106.4% (multiple Fidelity + Baron) | none |
| Perplexity | 6 | 6 | 0 | $42.8M | $58.7M | +$15.9M | +37.1% | 6 | +41.3% | +41.3% (T. Rowe Price) | -0.1% (ARK) |
| Scale AI | 0 | 0 | 0 | $0 | $0 | $0 | N/A | 0 | N/A | N/A | N/A |
| **TOTAL** | | | | **$24.92B** | **$40.70B** | **+$15.78B** | **+63.3%** | | | | |

### Implied per-share price movement (validated against actual balance×price checks)

| Company | Q4 Price | Q1 Price | Implied Δ% | Note |
|---------|---------|---------|----------|------|
| SpaceX common | $212/sh | $421/sh | +98.6% | All funds uniformly repriced |
| SpaceX preferred (Ser N) | $2,120/sh | $4,210/sh | +98.6% | Same ratio — 10x par |
| xAI equity (Class A/B) | $36-37/sh | $65-75/sh | +76-106% | Ser B→C round repricing |
| Databricks equity | $112-155/sh | $142-192/sh | +26-27% | Series J/H preferred |
| Anthropic equity | $141-167/sh | $141-274/sh | flat→+64% | Older series flat; new Ser G at $259-274 |
| Canva common | $1,646/sh | $1,546/sh | -6.1% | Modest markdown |
| Stripe equity | $30-47/sh | $26-54/sh | mixed | Wide dispersion; no clean repricing |

---

## 3. Top 10 Individual Pure Markups (Unchanged Balance, Value Increased)

*A "pure markup" means the fund held the IDENTICAL number of shares both quarters but reported a higher USD value. This is the cleanest valuation-mark signal — no buying or selling occurred.*

1. **Fidelity Securities Fund** — *Fidelity OTC K6 Portfolio*
   - Company: **xAI** | Title: `X.AI HOLDINGS CORP CLASS A P/P`
   - Q4: $5.9M → Q1: $12.1M | Change: **+106.4%** (+$6.2M) | Shares: 160,551

2. **Fidelity Securities Fund** — *Fidelity Series Blue Chip Growth Fund*
   - Company: **xAI** | Title: `X.AI HOLDINGS CORP SER B PC PP`
   - Q4: $29.3M → Q1: $60.5M | Change: **+106.4%** (+$31.2M) | Shares: 801,609

3. **BARON INVESTMENT FUNDS TRUST** — *Baron Asset Fund*
   - Company: **xAI** | Title: `X.AI, HOLDINGS CORP. CLASS B`
   - Q4: $122.2M → Q1: $252.2M | Change: **+106.4%** (+$130.0M) | Shares: 3,341,687

4. **BARON SELECT FUNDS** — *Baron Focused Growth Fund*
   - Company: **xAI** | Title: `X.AI, HOLDINGS CORP. CLASS B`
   - Q4: $61.1M → Q1: $126.1M | Change: **+106.4%** (+$65.0M) | Shares: 1,670,843

5. **Variable Insurance Products Fund III** — *VIP Growth Opportunities Portfolio*
   - Company: **xAI** | Title: `X.AI HOLDINGS CORP CLASS A P/P`
   - Q4: $9.4M → Q1: $19.3M | Change: **+106.4%** (+$9.9M) | Shares: 255,918

6. **NEUBERGER BERMAN ADVISERS MANAGEMENT TRUST** — *Quality Equity Portfolio*
   - Company: **SpaceX** | Title: `SPACE EXPLORATION TECH CLASS A`
   - Q4: $16.4M → Q1: $32.9M | Change: **+100.0%** (+$16.5M) | Shares: 46,637

7. **Fidelity Securities Fund** — *Fidelity Blue Chip Growth Fund*
   - Company: **Anthropic** | Title: `ANTHROPIC PBC SERIES E PC PP`
   - Q4: $104.4M → Q1: $192.3M | Change: **+84.3%** (+$87.9M) | Shares: 720,051

8. **Fidelity Securities Fund** — *Fidelity Blue Chip Growth K6 Fund*
   - Company: **Anthropic** | Title: `ANTHROPIC PBC SERIES E PC PP`
   - Q4: $23.7M → Q1: $43.7M | Change: **+84.3%** (+$20.0M) | Shares: 163,322

9. **Franklin Strategic Series** — *Franklin Growth Opportunities Fund*
   - Company: **Anthropic** | Title: `Anthropic PBC, Series F-1`
   - Q4: $7.0M → Q1: $12.9M | Change: **+83.8%** (+$5.9M) | Shares: 49,656

10. **T. ROWE PRICE INTERNATIONAL FUNDS** — *T. Rowe Price Global Stock Fund*
    - Company: **Anthropic** | Title: `ANTHROPIC PBC SER F-1 CVT PFD PP`
    - Q4: $10.4M → Q1: $19.0M | Change: **+83.7%** (+$8.6M) | Shares: 73,486

### Top 5 Pure Markdowns

1. **BlackRock Private Investments Fund** — *BlackRock Private Investments Fund*
   - Company: **Stripe** | Q4: $3.7M → Q1: $2.6M | Change: **-31.0%** | Title: `STRIPE INC`

2. **Fidelity Capital Trust** — *Fidelity Capital Appreciation Fund*
   - Company: **Canva** | Q4: $1.3M → Q1: $1.2M | Change: **-6.1%** | Title: `CANVA INC SER A PC PERP PP`

3. **Fidelity Concord Street Trust** — *Fidelity Founders Fund*
   - Company: **Canva** | Q4: $342K → Q1: $322K | Change: **-6.1%** | Title: `CANVA INC CL A`

4. **Ares Dynamic Credit Allocation Fund** — *Ares Dynamic Credit Allocation Fund*
   - Company: **Databricks** | Q4: $4.2M → Q1: $4.1M | Change: **-1.5%** | Title: `Databricks Inc Last Out Term Loan`

5. **BlackRock Funds II** — *BlackRock Multi-Asset Income Portfolio*
   - Company: **Stripe** | Q4: $3.5M → Q1: $3.5M | Change: **-0.6%** | Title: `Stripe, Inc.`

---

## 4. New Entrants and Exits per Company

### Anthropic
**New entrants (Q1 2026, absent Q4 2025):** Fidelity Concord Street Trust, Fidelity Securities Fund (new series), Growth Fund of America, New Economy Fund
**Exits:** Fidelity Advisor Series VII

### OpenAI
**New entrants (5 fund families):** J.P. Morgan Mutual Fund Investment Trust, NEW YORK LIFE INVESTMENTS VP FUNDS TRUST, Nuveen Investment Trust II, T. ROWE PRICE EQUITY SERIES INC, T. ROWE PRICE SPECTRUM FUNDS II INC
**Exits:** Fidelity Advisor Series VII

### SpaceX
**New entrants:** BARON SELECT FUNDS (new series)
**Exits:** BARON SELECT FUNDS (different series), Blackstone Alternative Investment Funds, EntrepreneurShares Series Trust

### Stripe
**New entrants:** BlackRock Allocation Target Shares, BlackRock Funds II, T. Rowe Price Corporate/New Income/Total Return Funds (3 series)
**Exits:** BlackRock Allocation Target Shares (different series), Fidelity Advisor Series I, Fidelity Puritan Trust, Fidelity Securities Fund, Variable Insurance Products Fund III

### Databricks
**New entrants (notable):** Destiny Tech100 Inc., Fidelity Advisor Series I, Fidelity Central Investment Portfolios LLC, Fidelity Contrafund, Fidelity Mt. Vernon Street Trust
**Exits:** Fidelity Advisor Series VII, LINCOLN VARIABLE INSURANCE PRODUCTS TRUST, T. ROWE PRICE MULTI-STRATEGY TOTAL RETURN FUND

### Anduril
**Exits:** T. ROWE PRICE MULTI-STRATEGY TOTAL RETURN FUND (only exit; no new entrants)

### Canva
**New entrants (5):** Coatue Innovative Strategies Fund, Fidelity Central Investment Portfolios LLC, Fidelity Mt. Vernon Street Trust, Fidelity Puritan Trust, Fidelity Select Portfolios
**Exits (5):** Fidelity Advisor Series II, Fidelity Advisor Series VII, Franklin High Income Trust, LINCOLN VARIABLE INSURANCE PRODUCTS TRUST, T. ROWE PRICE INTERNATIONAL FUNDS

### xAI
**New entrants (5+ notable):** American Funds Core Plus Bond Fund, Baron ETF Trust (new product), BlackRock HPS Credit Strategies Fund, Capital Group Completion Fund Series, Destiny Tech100 Inc.
**Exits (5+):** American Century Investment Trust, BlackRock Credit Strategies Fund, Fidelity Advisor Series VII, Northern Funds, SIX CIRCLES TRUST

### Perplexity
No fund-family-level changes. The same 6 fund families (T. Rowe Price and ARK) held positions in both quarters.

### Scale AI
Not present in either quarter's N-PORT data.

---

## 5. Stability Verdict

**Total disclosed AUM across all 10 tracked companies:**
- Q4 2025: $24.92B
- Q1 2026: $40.70B
- Net change: +$15.78B (+63.3%)

**Universe continuity:**
- Q4 fund-family positions: 421 (across all companies)
- Q1 fund-family positions: 464
- Matched (same fund family, both quarters): 372 — continuity rate: **88.4%**
- New entrants: 92 fund-family appearances
- Exits: 49 fund-family disappearances (many are the same "Fidelity Advisor Series VII" reporting restructure)

**Pure-markup signal quality:**
- Pure markups (unchanged balance, value increased): **246**
- Pure markdowns (unchanged balance, value decreased): **7**
- Ratio: 35:1 markups vs markdowns — strongly bullish skew
- The signal is robust: only 7 markdowns across all 10 companies in the entire quarter

**Stability assessment:**

The universe is highly stable. 88.4% of Q4 fund positions persisted into Q1. The $15.78B total value increase (+63%) is driven primarily by valuation events, not fund-universe expansion:

- SpaceX alone accounts for +$8.92B (+71% of the total dollar gain) from a uniform $212→$421/share repricing applied by all holders simultaneously in Q4 2025
- xAI accounts for +$2.00B from equity repricing (~+106%) plus continued loan growth
- Databricks adds +$2.02B from ~+27% equity appreciation plus new fund entrants (9 new families)
- Anthropic adds +$1.13B primarily from new Series F/G positions being filed for the first time, plus ~+84% markup on existing Series E holdings by Fidelity

The Q1 2026 dataset was NOT an outlier — it was a continuation of the same institutional holders who made significant upward valuation marks during the October-December 2025 period. The 35:1 markup-to-markdown ratio confirms this was a broad, coordinated repricing of private AI/tech assets, not selective mark-ups by a single house.

**Consistent fund families across both quarters (the "stable core"):**
Fidelity (8+ series), T. Rowe Price (6+ series), Baron (4+ series), Variable Insurance Products (Fidelity VIP), ARK Venture Fund, Coatue Innovative Strategies, The Private Shares Fund, StepStone Private Venture & Growth Fund

---

*Analysis performed on SEC DERA N-PORT bulk data. Matching done via normalized text search on ISSUER_NAME and ISSUER_TITLE fields. Pure-markup defined as: fund-series positions where the aggregate share balance was within 0.1% between quarters but reported USD value changed. Q4 2025 data extracted January 3, 2025 (filing date per REGISTRANT.tsv). Q1 2026 data extracted April 3, 2026.*
