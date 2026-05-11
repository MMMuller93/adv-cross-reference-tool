# SEC N-PORT Bulk Dataset URL Verification

**Verified:** 2026-05-11  
**Source index:** https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets  
**README:** https://www.sec.gov/files/nport_readme.pdf (446 KB)

---

## 1. Quarter-by-Quarter URL Status

All URLs follow the single pattern:
`https://www.sec.gov/files/dera/data/form-n-port-data-sets/{year}q{q}_nport.zip`

| Quarter | Full URL (filename) | HTTP Status | Content-Length (bytes) | Size (MB) |
|---------|---------------------|-------------|------------------------|-----------|
| 2019 Q4 | 2019q4_nport.zip | 200 | 240,007,320 | 229 |
| 2020 Q1 | 2020q1_nport.zip | 200 | 340,462,382 | 325 |
| 2020 Q2 | 2020q2_nport.zip | 200 | 332,888,140 | 318 |
| 2020 Q3 | 2020q3_nport.zip | 200 | 371,068,711 | 354 |
| 2020 Q4 | 2020q4_nport.zip | 200 | 359,205,250 | 343 |
| 2021 Q1 | 2021q1_nport.zip | 200 | 342,516,796 | 327 |
| 2021 Q2 | 2021q2_nport.zip | 200 | 358,497,137 | 342 |
| 2021 Q3 | 2021q3_nport.zip | 200 | 380,417,219 | 363 |
| 2021 Q4 | 2021q4_nport.zip | 200 | 374,616,598 | 357 |
| 2022 Q1 | 2022q1_nport.zip | 200 | 482,447,144 | 460 |
| 2022 Q2 | 2022q2_nport.zip | 200 | 432,741,571 | 413 |
| **2022 Q3** | **2022q3_nport.zip** | **200** | **724,385,184** | **691** *** |
| 2022 Q4 | 2022q4_nport.zip | 200 | 422,189,888 | 403 |
| 2023 Q1 | 2023q1_nport.zip | 200 | 480,447,687 | 458 |
| 2023 Q2 | 2023q2_nport.zip | 200 | 427,953,767 | 408 |
| 2023 Q3 | 2023q3_nport.zip | 200 | 457,209,257 | 436 |
| 2023 Q4 | 2023q4_nport.zip | 200 | 420,320,703 | 401 |
| 2024 Q1 | 2024q1_nport.zip | 200 | 446,989,787 | 426 |
| 2024 Q2 | 2024q2_nport.zip | 200 | 506,739,574 | 483 |
| 2024 Q3 | 2024q3_nport.zip | 200 | 478,076,657 | 456 |
| 2024 Q4 | 2024q4_nport.zip | 200 | 406,008,057 | 387 |
| 2025 Q1 | 2025q1_nport.zip | 200 | 462,120,659 | 441 |
| 2025 Q2 | 2025q2_nport.zip | 200 | 435,156,377 | 415 |
| 2025 Q3 | 2025q3_nport.zip | 200 | 468,940,747 | 447 |
| 2025 Q4 | 2025q4_nport.zip | 200 | 417,802,295 | 398 |
| 2026 Q1 | 2026q1_nport.zip | 200 | 463,076,167 | 442 |

*** 2022 Q3 is a significant outlier at 691 MB — 58% larger than adjacent quarters. This likely reflects a large batch of amended filings (N-PORT-P/A) caught up in that quarter's publication window. The SEC README notes that each data set "includes any amendments to prior submissions."

---

## 2. Earliest Available Quarter

**2019 Q4** is the earliest ZIP available.

Quarters 2019 Q1, 2019 Q2, 2019 Q3, and 2018 Q4 all return HTTP 404. This is consistent with the README Scope section, which states: "The N-PORT data sets consists of XML data submitted from **October 2019** through current period." The N-PORT filing requirement took effect for large fund groups in June 2019, with the first public bulk dissemination starting with the October–December 2019 quarter.

---

## 3. URL Pattern

There is exactly **one URL pattern** across all 26 quarters — no legacy naming scheme, no sub-path changes:

```
https://www.sec.gov/files/dera/data/form-n-port-data-sets/{year}q{q}_nport.zip
```

The SEC index page (`/data-research/sec-markets-data/form-n-port-data-sets`) enumerates all 26 links using this pattern verbatim. No alternative patterns were found (e.g., no `nport-{year}q{q}.zip` variant).

---

## 4. Schema Notes (from README: https://www.sec.gov/files/nport_readme.pdf)

### File Format
- Tab-delimited flat files, UTF-8 encoding
- Each ZIP contains up to **30 TSV files** plus a W3C-tabular-data metadata JSON

### 30 Tables in Each ZIP

| # | Table Name | Primary Key(s) |
|---|-----------|----------------|
| 1 | SUBMISSION | ACCESSION_NUMBER |
| 2 | REGISTRANT | ACCESSION_NUMBER |
| 3 | FUND_REPORTED_INFO | ACCESSION_NUMBER |
| 4 | INTEREST_RATE_RISK | ACCESSION_NUMBER + INTEREST_RATE_RISK_ID |
| 5 | BORROWER | ACCESSION_NUMBER + BORROWER_ID |
| 6 | BORROW_AGGREGATE | ACCESSION_NUMBER + BORROW_AGGREGATE_ID |
| 7 | MONTHLY_TOTAL_RETURN | ACCESSION_NUMBER + MONTHLY_TOTAL_RETURN_ID |
| 8 | MONTHLY_RETURN_CAT_INSTRUMENT | ACCESSION_NUMBER + ASSET_CAT + INSTRUMENT_KIND |
| 9 | FUND_VAR_INFO | ACCESSION_NUMBER |
| 10 | FUND_REPORTED_HOLDING | ACCESSION_NUMBER + HOLDING_ID |
| 11 | IDENTIFIERS | HOLDING_ID + IDENTIFIERS_ID |
| 12 | DEBT_SECURITY | HOLDING_ID (no surrogate key) |
| 13 | DEBT_SECURITY_REF_INSTRUMENT | HOLDING_ID + DEBT_SECURITY_REF_ID |
| 14 | CONVERTIBLE_SECURITY_CURRENCY | HOLDING_ID + CONVERTIBLE_SECURITY_ID |
| 15 | REPURCHASE_AGREEMENT | HOLDING_ID |
| 16 | REPURCHASE_COUNTERPARTY | HOLDING_ID + REPURCHASE_COUNTERPARTY_ID |
| 17 | REPURCHASE_COLLATERAL | HOLDING_ID + REPURCHASE_COLLATERAL_ID |
| 18 | DERIVATIVE_COUNTERPARTY | HOLDING_ID + DERIVATIVE_COUNTERPARTY_ID |
| 19 | SWAPTION_OPTION_WARNT_DERIV | HOLDING_ID |
| 20 | DESC_REF_INDEX_BASKET | HOLDING_ID |
| 21 | DESC_REF_INDEX_COMPONENT | HOLDING_ID + DESC_REF_INDEX_COMPONENT_ID |
| 22 | DESC_REF_OTHER | HOLDING_ID + DESC_REF_OTHER_ID |
| 23 | FUT_FWD_NONFOREIGNCUR_CONTRACT | HOLDING_ID |
| 24 | FWD_FOREIGNCUR_CONTRACT_SWAP | HOLDING_ID |
| 25 | NONFOREIGN_EXCHANGE_SWAP | HOLDING_ID |
| 26 | FLOATING_RATE_RESET_TENOR | HOLDING_ID + RATE_RESET_TENOR_ID |
| 27 | OTHER_DERIV | HOLDING_ID |
| 28 | OTHER_DERIV_NOTIONAL_AMOUNT | HOLDING_ID + OTHER_DERIV_NOTIONAL_AMOUNT_ID |
| 29 | SECURITIES_LENDING | HOLDING_ID |
| 30 | EXPLANATORY_NOTE | ACCESSION_NUMBER + EXPLANATORY_NOTE_ID |

### Schema Stability Warning

The README is a **single undated document** covering the current schema. There is no versioning section, no changelog, and no indication of which release introduced which fields. Known external history:

- N-PORT reporting began for large funds in **June 2019** (first public data: 2019 Q4)
- The SEC amended Form N-PORT rules in **2022** (Investment Company Act Release IC-34512), expanding certain risk disclosure items. This may explain the jump in file sizes starting with 2022 Q1 (460 MB vs 357 MB in 2021 Q4 — a 29% increase).
- The 2022 Q3 outlier (691 MB) is unexplained by the README. Treat it as potentially containing restatements of prior quarters' holdings (amendments are included per the README).

**Practical implication for backfill:** Because the README describes one schema with no explicit changelog, you should validate column headers on the first unzip of each year boundary (2019, 2020, 2021, 2022) rather than assuming identical headers across all 26 quarters. Specifically, watch for:
  - New columns added to FUND_REPORTED_HOLDING or FUND_REPORTED_INFO around 2022
  - DEBT_SECURITY having no primary key (noted in README) — deduplication logic must handle this
  - BORROW_AGGREGATE.OTHER_DESC is typed CLOB — some parsers treat this differently from VARCHAR

---

## 5. Total Expected Ingestion Volume

| Metric | Value |
|--------|-------|
| Quarters available | 26 |
| Total compressed size | 10,521 MB (10.27 GB) |
| Smallest quarter (2019 Q4) | 229 MB |
| Largest quarter (2022 Q3) | 691 MB |
| Typical recent quarter | ~420–460 MB |
| Uncompressed estimate* | ~80–120 GB |

*ZIP compression ratio for TSV data is typically 7–10x. A 440 MB ZIP likely expands to ~3.5–4.5 GB of raw TSV. Across 26 quarters, expect 90–110 GB uncompressed.

---

## Sources

- Index page: https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets
- README PDF: https://www.sec.gov/files/nport_readme.pdf
- Base ZIP path: https://www.sec.gov/files/dera/data/form-n-port-data-sets/
- HEAD checks performed: 2026-05-11, User-Agent: Miles Muller mmmuller93@gmail.com
