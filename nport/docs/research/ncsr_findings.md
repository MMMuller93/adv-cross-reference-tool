# N-CSR / N-CSRS as Enrichment Layer for Private Company Holdings
## Research Date: 2026-05-11

---

## Task A — Example Filings with Private Company Disclosures

### Filing 1: ARK Venture Fund, N-CSR, Period July 31 2024
**Accession:** 0001213900-24-086293  
**URL:** https://www.sec.gov/Archives/edgar/data/1905088/000121390024086293/ea0212303-01_ncsr.htm

**Anthropic entry (actual text from SOI):**
```
SOFTWARE 11.7%
Anthropic, Inc., Series C-1* (a)(b) 3/31/23  89,078  1,049,998  2,672,340
```
Columns: Security Name, Footnote Codes, **Acquisition Date**, Shares/Units, **Cost**, **Fair Value**

**SpaceX entry:**
```
AEROSPACE DEFENSE 11.4%
Space Exploration Technologies Corp.* (a)(b)(c) 10/31/23  75,356  $ 6,999,961  $ 7,309,485
```

**OpenAI entry:**
```
OpenAI Global LLC* (a)(b)(c) 7/31/24  5,797  1,000,000  1,000,000
```

**Footnote definitions (actual text):**
```
(a) Level 3.
(b) Restricted security; security may not be publicly sold without registration under the Securities Act
    of 1933, as amended. As of July 31, 2024, total investments in restricted securities were 
    $53,945,640 and are classified as Level 3.
(c) All or a portion of these securities have been purchased through unaffiliated Special Purpose 
    Vehicles (SPVs) in which the Fund has a direct investment of ownership units of the SPVs.
```

**Level 3 roll-forward table (actual text):**
```
                        Common Stocks   Preferred Stocks   SAFE   Conv. Note   Warrant   Total
Balance at July 31, 2023  $ 4,632,310   $ 6,530,789   $ 740,120   $ —   $ —   $ 11,903,219
Purchases                   13,464,082    16,300,058    4,600,000   2,925,000   —    37,289,140
Sales                       —             —
Transfer into Level 3       —
Transfer out of Level 3     —
Conversion                  1,050,000    (1,050,000)
Net Realized Gain (Loss)    —
Net Change in Unrealized Appreciation  2,097,845  1,211,201  336,485  119,388  988,362  4,753,281
Ending Balance at July 31, 2024  $ 20,194,237  $ 25,092,048  $ 5,676,605  $ 1,994,388  $ 988,362  $ 53,945,640
```

**Valuation methodology table (actual text):**
```
Asset type              Fair Value     Valuation Approach     Significant Unobservable Inputs
Preferred Stocks        $25,092,048    Market Approach        Precedent Transactions / Market Movement / Estimated Transaction Price
Common Stocks           $20,194,237    Market Approach        Precedent Transactions / Market Movement
```

---

### Filing 2: Fidelity Contrafund, N-CSR, Period December 31 2025
**Accession:** 0000024238-26-000023  
**URL:** https://www.sec.gov/Archives/edgar/data/24238/000002423826000023/filing10969.htm

**Anthropic entries (actual text from SOI):**
```
Software - 0.4%
Anthropic PBC Series E (c)(d)  14,900  3,476,170
Anthropic PBC Series F (c)(d)  46,814  10,921,706
```
Columns: Security Name, Footnote Codes, **Shares**, **Value ($)**  
NOTE: No acquisition date or cost in the SOI main table.

**Restricted securities table (separate footnote table — actual text):**
```
Security                    Acquisition Date    Acquisition Cost ($)
Anthropic PBC Series E      2/14/2025           835,689
Anthropic PBC Series F      8/18/2025           6,599,257
```

**Footnote definitions (actual text):**
```
(c) Level 3 security.
(d) Restricted securities (including private placements) - Investment in securities not registered 
    under the Securities Act of 1933 (excluding 144A issues). At the end of the period, the value 
    of restricted securities (excluding 144A issues) amounted to $566,653,749 or 4.2% of net assets.
```

---

### Filing 3: T. Rowe Price Global Technology Fund, N-CSR, Period December 31 2025
**Accession:** 0001193125-26-063127  
**URL:** https://www.sec.gov/Archives/edgar/data/1116626/000119312526063127/d76116dncsr.htm

**Anthropic entry (actual text from SOI):**
```
Front-Office Applications Software 1.2%
Anthropic, Series F-1, Acquisition Date: 8/29/25, Cost $38,695 (1)(2)(3)  274,498  69,840
```
Column structure: Security Name (WITH embedded Acquisition Date and Cost), Shares, Value ($)  
T. Rowe Price embeds acquisition date and cost INLINE in the security name field.

**OpenAI entry (actual text):**
```
0.8% Aestas DBA OpenAI, Class A, Acquisition Date: 10/3/25, Cost $38,692 (1)(2)(3)  89,982  43,472
```

**Footnote definitions (actual text):**
```
(1) See Note 2. Level 3 in fair value hierarchy.
(2) Non-income producing
(3) Security cannot be offered for public resale without first being registered under the Securities 
    Act of 1933 and related regulations.
```

---

### Filing 4: Destiny Tech100 (DXYZ), N-CSR, Period December 31 2024
**Accession:** 0001398344-25-005937  
**URL:** https://www.sec.gov/Archives/edgar/data/1843974/000139834425005937/fp0092321-2_ncsrixbrl.htm

**SpaceX entry (actual text):**
```
Celadon Technology Fund VIII, LLC - Series B (economic exposure to Space Exploration Technologies 
Corp., Common Stock) (a)(b)(c)(g)  06/09/22  618,618  [fair value]
```
Columns: Security Name, Acquisition Date, Cost, Fair Value  
Note: Destiny holds SpaceX via SPVs, not direct shares.

**Format note:** This filing includes iXBRL tags. XBRL-tagged numeric values confirmed at positions 1768–2021.

---

## Task B — Parsing Difficulty

### Format Breakdown by Fund Family

| Fund Family | Underlying Format | Column Structure | XBRL Tagged |
|---|---|---|---|
| ARK Venture | HTML table (no absolute positioning) | Columns: Name, Footnotes, Date, Units, Cost, Value | No |
| Fidelity | Absolute-position HTML (PDF→HTML) | Main SOI: Name, Footnotes, Shares, Value only; Restricted table: Name, Date, Cost separately | No |
| T. Rowe Price | Absolute-position HTML (PDF→HTML) | Embedded inline: "Name, Acquisition Date: X, Cost $Y (footnotes)" | No |
| Destiny Tech100 | HTML table with inline iXBRL tags | Columns: Name, Date, Cost, Value | Yes (iXBRL) |
| Fundrise | Absolute-position HTML (PDF→HTML) | Name, Footnotes, Shares, Value only | No |

**Key observation:** Three distinct structural approaches exist across just five filers. No industry-wide consistency.

### Field-by-Field Disclosure Survey

| Field | ARK Venture | Fidelity | T. Rowe Price | Destiny Tech100 | Fundrise |
|---|---|---|---|---|---|
| Acquisition cost | Yes (column) | Yes (separate restricted table) | Yes (inline in name field) | Yes (column) | No |
| Acquisition date | Yes (column) | Yes (separate restricted table) | Yes (inline in name field) | Yes (column) | No |
| Level 3 classification | Yes (footnote "a") | Yes (footnote "c") | Yes (footnote "1") | Yes (footnote "b") | No explicit |
| Restricted security legend | Yes (footnote "b") | Yes (footnote "d") | Yes (footnote "3") | Yes (footnote "c") | Yes (footnote) |
| Valuation methodology | Yes (separate table) | In notes only | In notes only | In footnote | No |
| Level 3 roll-forward | Yes (by asset class) | Yes (in notes) | In notes | Yes (in notes) | No |
| Affiliate status | No | No | No | No | No |

### Parsing Difficulty Assessment

**Regex-parseable with moderate effort:**
- ARK Venture: clean HTML table. Columns are consistent. Regex or BeautifulSoup works well.
- Destiny Tech100: iXBRL tags actually make structured extraction easier — can parse ix:nonFraction elements directly.

**Requires LLM extraction or per-filer parsers:**
- Fidelity: absolute-position HTML means elements appear in document order by visual position, not logical order. The restricted securities table (which contains acquisition date/cost) is a separate block that must be matched back to the main SOI by security name. Mismatches happen (e.g., "Applied Intuition Inc Class A 7/2/2024 - 6/16/2025" — multiple acquisition tranches).
- T. Rowe Price: cost and acquisition date are embedded as free text inside the security name string with no fixed delimiter. Example: "Anthropic, Series F-1, Acquisition Date: 8/29/25, Cost $38,695 (1)(2)(3)". A regex pattern `Acquisition Date: (\S+), Cost \$([0-9,]+)` would work for TRP specifically, but this pattern does not generalize.
- Fundrise: minimal structured data; most private holding detail is in narrative text.

**Level 3 roll-forward tables:** Structured enough for regex in ARK-style HTML tables. Fidelity and TRP embed them in the Notes section which uses absolute positioning — LLM extraction recommended for those two.

---

## Task C — Universe Size

**Direct evidence from EDGAR full-text search (2025–2026 calendar year filings):**
- Filings mentioning "Anthropic": 90 (N-CSR + N-CSRS combined)
- Filings mentioning "OpenAI": 134
- Filings mentioning "Space Exploration Technologies": 90  
- Filings mentioning "Stripe": 130
- Filings mentioning "Databricks": 325
- Total N-CSR with "schedule of investments": 3,151 (2025)
- Total N-CSRS with "schedule of investments": 3,036 (2025)
- N-CSR/N-CSRS filings containing "restricted securities" + "private placement": 699 (2025)

**Distinct fund families disclosing high-profile private companies:**
- ARK Venture Fund
- Fidelity (multiple trusts: Contrafund, Securities Fund, MT Vernon Street Trust, Puritan Trust, Advisor Series I/VII/VIII, Variable Insurance Products Funds I–IV, Select Portfolios, Capital Trust, Trend Fund, Investment Trust)
- T. Rowe Price (Global Tech Fund, Science & Tech Fund, Capital Appreciation, Exchange-Traded Funds, International Funds, Growth Stock, Communications & Tech)
- BlackRock (15+ closed-end fund complexes: BCAT, ECAT, BST, BSTZ, BTX, etc.)
- Baron Funds (Investment Funds Trust, Select Funds)
- Destiny Tech100 (DXYZ)
- Fundrise Growth Tech Fund
- Powerlaw Corp (PWRL)
- Coatue Innovative Strategies Fund
- Growth Fund of America / New Economy Fund / American Funds (Capital Group)
- Baillie Gifford Funds
- Neuberger Berman (Equity Funds, Advisers Management Trust)
- StepStone Private Venture & Growth Fund
- Private Shares Fund
- Franklin Templeton Variable Insurance Trust
- Various insurance separate accounts (John Hancock, Brighthouse, SunAmerica, Nationwide, Transamerica, New York Life, MML)

**Order-of-magnitude estimate:** Approximately 50–100 distinct fund families file N-CSR or N-CSRS containing private company holdings in a given year. The total filing count (699 with "restricted securities" + "private placement") includes many duplicate filings per fund family (each sub-fund files separately). The universe of unique investment managers actively disclosing pre-IPO private positions is approximately 30–50.

---

## Task D — Filing Cadence and Data Freshness

**Statutory deadline:** SEC rules require N-CSR within 60 days of fiscal year end; N-CSRS within 60 days of the second fiscal quarter end.

**Observed actual filing delays (from real filings):**
- ARK Venture Fund (fiscal year July 31): N-CSR filed October 8 = **69 days** after period end
- ARK Venture Fund (semi-annual January 31): N-CSRS filed April 3–7 = **62–66 days** after period end
- Fidelity Contrafund (fiscal year December 31): N-CSR filed February 20 = **51 days** after period end
- Fidelity Contrafund (semi-annual June 30): N-CSRS filed August 22 = **53 days** after period end
- Fidelity Contrafund (semi-annual November 30): N-CSRS filed January 22 = **53 days** after period end

**Data freshness conclusion:** N-CSR/N-CSRS data is 50–70 days stale relative to the reporting period end. Because fiscal year ends are staggered across fund families (July 31, November 30, December 31, etc.), new N-CSR filings land throughout the year, not in a single annual batch. Semi-annual N-CSRS doubles the observation frequency to approximately every 6 months per fund.

N-CSR data is materially older than N-PORT data. N-PORT (monthly filings, due 30 days after month end) is 30–45 days stale. N-CSR is 50–70 days stale but covers a 12-month period, while N-PORT covers one month.

---

## Recommendation

**Build N-CSR as Phase 2: Yes, with caveats.**

**Strongest case for building it:**
1. N-CSR is the ONLY source for acquisition cost and acquisition date. These fields are not in N-PORT. For any investor tracking cost basis or analyzing fund entry timing, N-CSR is irreplaceable.
2. Level 3 roll-forward tables (only in N-CSR) let you reconstruct when a fund first entered and exited a private position even if you only catch one snapshot.
3. Valuation methodology disclosures (market approach, DCF, precedent transactions) provide context for why fair values changed — N-PORT just gives the number.
4. The restricted securities schedule cross-references back to N-PORT holdings and provides the cost basis that N-PORT lacks.
5. The universe is manageable: ~30–50 active fund families, ~700 filings/year mentioning private placements — this is a tractable dataset.

**Honest caveats:**
1. There is no consistent schema. Each of Fidelity, T. Rowe Price, ARK, and Destiny Tech100 uses a structurally different HTML layout. A robust ingestion pipeline needs at minimum 4 separate parsers, and likely an LLM-based fallback for absolute-position HTML (Fidelity, T. Rowe, Fundrise).
2. The "restricted securities" table with acquisition cost/date is a separate block from the main SOI in Fidelity. Matching it back to the primary SOI entry requires fuzzy name matching across potentially 50–200 securities per filing.
3. Data is 50–70 days stale versus the period end, and up to 6 months old between N-CSR filings. Private company valuations can change dramatically in that window.
4. T. Rowe Price's iXBRL is PDF-to-HTML absolute positioning — it is not structured XBRL even though the ix: namespace prefix appears. The raw HTML is visually correct but semantically unstructured.

**Phased build recommendation:**
- Phase 2A: Parse the 5–8 largest fund families (Fidelity, ARK, T. Rowe Price, Baron, BlackRock) with custom parsers. These account for the majority of private company AUM exposure.
- Phase 2B: LLM-based extraction as a fallback for the long tail of smaller/unusual filers.
- Skip for now: Fundrise (minimal structured data) and variable insurance sub-accounts (they hold pass-through positions that mirror the underlying fund).
