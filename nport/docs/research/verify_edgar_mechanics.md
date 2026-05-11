# EDGAR Mechanics Verification — NPORT-P + N-CEN

**Date:** 2026-05-11
**Investigator:** Research agent (Claude Sonnet 4.6)

---

## Claim 1: NPORT-P filings appear in form.idx

### A1 — 2026 QTR1 form.idx — Confirmed

Five NPORT-P sample lines (verbatim from https://www.sec.gov/Archives/edgar/full-index/2026/QTR1/form.idx):

```
NPORT-P          1290 Funds                                                    1605941     2026-03-25  edgar/data/1605941/0002071691-26-006515.txt         
NPORT-P          Advisors Preferred Trust                                      1556505     2026-02-20  edgar/data/1556505/0000910472-26-001940.txt         
NPORT-P          Goldman Sachs ETF Trust                                       1479026     2026-01-27  edgar/data/1479026/0000940400-26-002582.txt         
NPORT-P          SPDR INDEX SHARES FUNDS                                       1168164     2026-02-26  edgar/data/1168164/0001410368-26-020047.txt         
NPORT-P          iSHARES TRUST                                                 1100663     2026-03-27  edgar/data/1100663/0002071691-26-007300.txt         
```

**Column layout (fixed-width):**
- Positions 0–11: Form type (right-padded)
- Positions 12–73: Company name (right-padded)
- Positions 74–85: CIK
- Positions 86–97: Date filed (YYYY-MM-DD) — note: extract with regex `\d{4}-\d{2}-\d{2}` for reliability
- Positions 98+: File path (`edgar/data/{CIK}/{accession}.txt`)

**Accession number parsing:** Strip the path prefix and `.txt` suffix from the filename field.
Example: `edgar/data/1605941/0002071691-26-006515.txt` → accession `0002071691-26-006515`

### A2 — Quarterly NPORT-P Filing Counts

| Quarter | NPORT-P | NPORT-P/A (Amendments) |
|---------|---------|------------------------|
| 2026 Q1 | 13,106  | 38                     |
| 2025 Q4 | 13,239  | 57                     |
| 2025 Q3 | 13,093  | 78                     |

Consistent across all three quarters, ~13,000–13,250 NPORT-P filings per quarter. No sign of gaps or structural changes.

### A3 — Definitive Form-Type Filter List

Only two NPORT form-type strings appear in form.idx across all three quarters:

| Form Type  | Description              |
|------------|--------------------------|
| `NPORT-P`  | Original N-PORT filing   |
| `NPORT-P/A`| Amendment to N-PORT      |

**Confirmed absent:** `NPORT`, `NPORT-EX`, `N-PORT`, `N-PORT/A` — none appear.

Filter pattern for scraper (analogous to Form D `D` / `D/A`):
```python
line.startswith('NPORT-P ')  or  line.startswith('NPORT-P/A ')
```

---

## Claim 2: N-CEN XML contains structured adviser CRD and LEI fields

### B1/B2 — Actual XML tags confirmed across four fund families

All four filings retrieved from:
- Fidelity CIK 0000024238: accession 0000035402-26-001453 (filed 2026-03-12)
- Vanguard CIK 0000036405: accession 0000036405-26-000103 (filed 2026-03-12)
- BlackRock CIK 0001836057: accession 0001410368-26-025372 (filed 2026-03-13)
- ARK CIK 0001905088: accession 0000940400-25-003087 (filed 2025-10-09)

**Raw XML URL pattern:** `https://www.sec.gov/Archives/edgar/data/{CIK}/{accession_no_dashes}/primary_doc.xml`
**Note:** The `xslFormN-CEN_X0n/primary_doc.xml` path serves rendered HTML — use the bare `primary_doc.xml`.

**XML namespace:** `xmlns="http://www.sec.gov/edgar/ncen"`

**Exact tag names and sample values:**

| Tag | XPath | Fidelity | Vanguard | BlackRock | ARK |
|-----|-------|----------|----------|-----------|-----|
| `investmentAdviserName` | `.//investmentAdviser/investmentAdviserName` | Fidelity Mgmt & Research Co LLC | The Vanguard Group, Inc. | BlackRock Advisors, LLC | ARK Investment Management LLC |
| `investmentAdviserCrdNo` | `.//investmentAdviser/investmentAdviserCrdNo` | 000108281 | 000105958 | 000106614 | 000169525 |
| `investmentAdviserLei` | `.//investmentAdviser/investmentAdviserLei` | 5493001Z012YSB2A0K51 | 5493002789CX3L0CJP65 | 5493001LN9MRM6A35J74 | 2549006XVFMEF9PIPN63 |
| `subAdviserName` | `.//subAdviser/subAdviserName` | FMR Investment Mgmt (UK) Ltd | N/A (no subadvisers) | N/A | N/A |
| `subAdviserCrdNo` | `.//subAdviser/subAdviserCrdNo` | 000108273, 000148045, 000148239... | — | — | — |
| `subAdviserLei` | `.//subAdviser/subAdviserLei` | 549300DJ0TLKPO1HIS84... | — | — | — |

Fidelity had 4 investmentAdviser entries and 12 subAdviser entries (multi-series fund complex).
Vanguard had 12 investmentAdviser entries (one per fund series), 0 subAdvisers.

**Additional useful tags in the investmentAdviser block:**
- `investmentAdviserFileNo` — SEC file number (e.g., `801-7884`)
- `investmentAdviserRssdId` — Federal Reserve RSSD ID (often `N/A`)
- `isInvestmentAdviserHired` — YES/NO (whether hired vs. internal)

### B3 — Schema documentation (XSD)

Source: `https://www.sec.gov/info/edgar/specifications/form-n-cen-xml-tech-specs-2.1.zip`
(linked from https://www.sec.gov/info/edgar/specifications/form-n-cen-xml-tech-specs-2.1.htm)

Relevant XSD file: `eis_NCEN_Filer.xsd` (within the zip)

**Confirmed definitions from XSD:**

```xml
<!-- investmentAdviser block — minOccurs="1" maxOccurs="1" within INVESTMENT_ADVISER_TYPE -->
<xs:element name="investmentAdviserName"  type="ns1:STRING_150_TYPE"   minOccurs="1" maxOccurs="1"/>
<xs:element name="investmentAdviserCrdNo" type="ncom:CRD_NUMBER_TYPE"  minOccurs="1" maxOccurs="1"/>
<xs:element name="investmentAdviserLei"   type="ncom:LEI_TYPE_RSS_NA"  minOccurs="1" maxOccurs="1"/>

<!-- subAdviser block — minOccurs="1" maxOccurs="1" within SUB_ADVISER_TYPE -->
<xs:element name="subAdviserName"  type="ns1:STRING_150_TYPE"   minOccurs="1" maxOccurs="1"/>
<xs:element name="subAdviserCrdNo" type="ncom:CRD_NUMBER_TYPE"  minOccurs="1" maxOccurs="1"/>
<xs:element name="subAdviserLei"   type="ncom:LEI_TYPE_RSS_NA"  minOccurs="1" maxOccurs="1"/>
```

**CRD_NUMBER_TYPE pattern:** `[0-9]{9}|N/A` (9 digits zero-padded, or literal "N/A")

**LEI_TYPE_RSS_NA pattern:** `[0-9A-Za-z]{20}|[0-9]{10}|N/A` (20-char LEI, 10-digit RSSD, or "N/A")

**investmentAdvisers container:** `minOccurs="0"` — the entire adviser section is optional at the fund level. Fields are required once the section is present.

**Schema version in live filings:** `<schemaVersion>X0505</schemaVersion>` (current as of 2026)
Tech spec version 2.1 XSD (2018) predates this schema version — field names are backward-compatible and confirmed consistent with live 2026 filings.

---

## Summary

**Claim 1 — CONFIRMED.** NPORT-P filings appear in form.idx exactly as Form D filings do. The scraper pattern is a direct mirror: filter lines starting with `NPORT-P ` or `NPORT-P/A `. Counts are stable at ~13,100–13,250 per quarter. No other form-type variants exist.

**Claim 2 — CONFIRMED and precisely specified.**
- Primary adviser: `investmentAdviserCrdNo`, `investmentAdviserLei`, `investmentAdviserName`
- Sub-adviser: `subAdviserCrdNo`, `subAdviserLei`, `subAdviserName`
- All confirmed in XSD as `minOccurs="1"` within their block; the block itself is optional (`minOccurs="0"`)
- Consistent across Fidelity, Vanguard, BlackRock, ARK — confirmed with independent XSD schema

