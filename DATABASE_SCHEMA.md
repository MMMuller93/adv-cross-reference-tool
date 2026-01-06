# Database Schema & Linkage Reference

Complete mapping of Supabase tables and their relationships for the ADV/Form D Cross-Reference Platform.

**Last Updated:** 2026-01-06

---

## Database Overview

We use **TWO separate Supabase databases**:

| Database | URL | Purpose |
|----------|-----|---------|
| **ADV Database** | `ezuqwwffjgfzymqxsctq.supabase.co` | Form ADV data (advisers, funds) |
| **Form D Database** | `ltdalxkhbbhmkimmogyq.supabase.co` | Form D filings, cross-references, compliance issues, enrichment |

---

## Entity Relationship Diagram

```
ADV DATABASE                                    FORM D DATABASE
============                                    ===============

┌─────────────────────┐                        ┌─────────────────────┐
│  advisers_enriched  │                        │   form_d_filings    │
├─────────────────────┤                        ├─────────────────────┤
│ crd (PK)            │◄───────────────────────│ cik                 │
│ adviser_name        │                        │ file_num ───────────┼──┐
│ exemption_2b1       │                        │ accessionnumber (PK)│  │
│ exemption_2b2       │                        │ entityname          │  │
│ type (RIA/ERA)      │                        │ filing_date         │  │
│ total_aum           │                        │ investmentfundtype  │  │
│ aum_2011-2025       │                        │ totalofferingamount │  │
└─────────────────────┘                        │ related_names       │  │
         │                                     │ related_roles       │  │
         │ adviser_entity_crd                  └─────────────────────┘  │
         │                                              ▲              │
         ▼                                              │              │
┌─────────────────────┐                                 │              │
│   funds_enriched    │                                 │              │
├─────────────────────┤                                 │              │
│ fund_id             │                                 │              │
│ reference_id (PK)   │                                 │              │
│ fund_name           │                                 │              │
│ adviser_entity_crd ─┼───► Links to advisers           │              │
│ form_d_file_number ─┼─────────────────────────────────┼──────────────┘
│ fund_type           │                                 │  (file_num match)
│ exclusion_3c1       │                                 │
│ exclusion_3c7       │                                 │
│ gav_2011-2025       │                                 │
└─────────────────────┘                                 │
         │                                              │
         │                    ┌─────────────────────────┘
         │                    │
         ▼                    ▼
┌─────────────────────────────────────────┐
│        cross_reference_matches          │  (FORM D DATABASE)
├─────────────────────────────────────────┤
│ id (PK)                                 │
│ adv_fund_id ────────► funds_enriched    │
│ adv_fund_name                           │
│ formd_accession ────► form_d_filings    │
│ formd_entity_name                       │
│ adviser_entity_crd ─► advisers_enriched │
│ adviser_entity_legal_name               │
│ match_score                             │
│ overdue_adv_flag                        │
│ latest_adv_year                         │
└─────────────────────────────────────────┘
         │
         │ Referenced by
         ▼
┌─────────────────────────────────────────┐
│         compliance_issues               │  (FORM D DATABASE)
├─────────────────────────────────────────┤
│ id (PK)                                 │
│ adviser_crd ────────► advisers_enriched │
│ fund_reference_id ──► funds_enriched    │
│ form_d_cik ─────────► form_d_filings    │
│ discrepancy_type                        │
│ severity                                │
│ description                             │
│ metadata (JSONB)                        │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│         enriched_managers               │  (FORM D DATABASE)
├─────────────────────────────────────────┤
│ id (PK)                                 │
│ series_master_llc (manager name)        │
│ website_url                             │
│ linkedin_company_url                    │
│ twitter_handle                          │
│ primary_contact_email                   │
│ team_members (JSONB)                    │
│ enrichment_status                       │
└─────────────────────────────────────────┘
```

---

## Table Details

### advisers_enriched (ADV Database)

Primary table for investment adviser information from Form ADV filings.

| Column | Type | Description | Source |
|--------|------|-------------|--------|
| `crd` | TEXT (PK) | Central Registration Depository number - unique adviser ID | ADV Part 1A, Item 1E1 |
| `adviser_name` | TEXT | Business name | ADV Part 1A, Item 1C |
| `legal_name` | TEXT | Legal entity name | ADV Part 1A |
| `type` | TEXT | `RIA` (registered) or `ERA` (exempt reporting) | Derived |
| `exemption_2b1` | TEXT/BOOL | VC exemption claim (Rule 203(l)-1) - **MIXED FORMAT** | ADV Part 1A, Item 2B1 |
| `exemption_2b2` | TEXT/BOOL | Private fund exemption claim (Rule 203(m)-1, <$150M) - **MIXED FORMAT** | ADV Part 1A, Item 2B2 |
| `exemption_2b3` | TEXT/BOOL | Foreign private adviser exemption | ADV Part 1A, Item 2B3 |
| `total_aum` | NUMERIC | Total regulatory AUM | ADV Part 1A, Item 5F |
| `aum_2011` - `aum_2025` | NUMERIC | Historical AUM by year | Computed from filings |
| `cco_email` | TEXT | Chief Compliance Officer email | ADV Part 1A |
| `primary_website` | TEXT | Main website URL | ADV Part 1A, Item 1I |
| `phone_number` | TEXT | Main phone | ADV Part 1A |
| `owner_full_legal_name` | TEXT | Owner names (semicolon-separated) | Schedule A/B |
| `control_person_name` | TEXT | Control person names | Schedule D, 10A |

**Data Format Issues:**
- `exemption_2b1` and `exemption_2b2` have MIXED formats: `'Y'`/`'N'` strings vs `true`/`false` booleans
- Must query for BOTH formats when checking exemption status

---

### funds_enriched (ADV Database)

Private fund information from Form ADV Schedule D, Section 7.B.

| Column | Type | Description | Source |
|--------|------|-------------|--------|
| `fund_id` | TEXT | Fund identifier within adviser | ADV Schedule D |
| `reference_id` | TEXT (PK) | Unique fund reference (PFID) | ADV Schedule D |
| `fund_name` | TEXT | Fund legal name | ADV Schedule D, 7B1 |
| `adviser_entity_crd` | TEXT (FK) | Links to `advisers_enriched.crd` | ADV Schedule D |
| `fund_type` | TEXT | Fund strategy: PE, VC, Hedge, Real Estate, etc. | ADV Schedule D, 7B1 |
| `exclusion_3c1` | TEXT | 3(c)(1) exemption (up to 100 investors) | ADV Schedule D |
| `exclusion_3c7` | TEXT | 3(c)(7) exemption (qualified purchasers only) | ADV Schedule D |
| `minimum_investment` | NUMERIC | Minimum investment amount | ADV Schedule D |
| `form_d_file_number` | TEXT | SEC file number linking to Form D | ADV Schedule D, 7B1A22 |
| `latest_gross_asset_value` | NUMERIC | Most recent GAV | ADV Schedule D |
| `gav_2011` - `gav_2025` | NUMERIC | Historical GAV by year | Computed |
| `auditing_firm_name` | TEXT | Auditor name | ADV Schedule D, 7B1A23 |
| `prime_broker_name` | TEXT | Prime broker | ADV Schedule D, 7B1A24 |
| `custodian_name` | TEXT | Custodian | ADV Schedule D, 7B1A25 |
| `administrator_name` | TEXT | Administrator | ADV Schedule D, 7B1A26 |
| `partner_names` | TEXT | General partner names | ADV Schedule D, 7B1A3a |

**Key Linkage:**
- `form_d_file_number` links to `form_d_filings.file_num` for ADV↔Form D matching

---

### form_d_filings (Form D Database)

SEC Form D filings for Regulation D private placements.

| Column | Type | Description | Source |
|--------|------|-------------|--------|
| `accessionnumber` | TEXT (PK) | SEC accession number - unique filing ID | EDGAR |
| `cik` | TEXT | SEC Central Index Key - entity identifier | EDGAR |
| `file_num` | TEXT | SEC file number (e.g., 021-12345) | Form D |
| `entityname` | TEXT | Issuer/fund name as filed | Form D, Item 1 |
| `filing_date` | DATE | Date of filing with SEC | EDGAR |
| `sale_date` | DATE | Date of first sale | Form D, Item 8 |
| `totalofferingamount` | NUMERIC | Total offering amount | Form D, Item 13 |
| `totalamountsold` | NUMERIC | Amount sold to date | Form D, Item 13 |
| `investmentfundtype` | TEXT | Fund type declared on Form D | Form D, Item 3 |
| `federalexemptions_items_list` | TEXT | Exemptions claimed (3(c)(1), 3(c)(7), etc.) | Form D, Item 6 |
| `related_names` | TEXT | Pipe-separated names (executives, promoters) | Form D, Item 3 |
| `related_roles` | TEXT | Pipe-separated roles corresponding to names | Form D, Item 3 |
| `stateorcountryofinc` | TEXT | State/country of incorporation | Form D, Item 1 |

**Key Linkages:**
- `file_num` links to `funds_enriched.form_d_file_number`
- `cik` used for EDGAR URL: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=D`

---

### cross_reference_matches (Form D Database)

Pre-computed matches between ADV funds and Form D filings. **Only contains MATCHED records.**

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT (PK) | Auto-increment ID |
| `adv_fund_id` | TEXT | Links to `funds_enriched.fund_id` |
| `adv_fund_name` | TEXT | Fund name from ADV |
| `formd_accession` | TEXT | Links to `form_d_filings.accessionnumber` |
| `formd_entity_name` | TEXT | Entity name from Form D |
| `formd_filing_date` | DATE | Form D filing date |
| `formd_offering_amount` | NUMERIC | Total offering from Form D |
| `adviser_entity_crd` | TEXT | Links to `advisers_enriched.crd` (**CAN BE NULL**) |
| `adviser_entity_legal_name` | TEXT | Adviser name |
| `match_score` | NUMERIC | Always 1.0 (exact matches only) |
| `overdue_adv_flag` | BOOLEAN | True if ADV filing is overdue |
| `latest_adv_year` | INTEGER | Year of most recent ADV filing |
| `computed_at` | TIMESTAMP | When match was computed |

**Important Notes:**
- **Only contains MATCHED records** - unmatched Form Ds are NOT stored here
- `adviser_entity_crd` can be NULL if the ADV fund has no linked adviser
- Refreshed weekly by `scripts/compute_cross_reference.py`
- Matching uses: file_num (primary) + normalized name (fallback)

---

### compliance_issues (Form D Database)

Detected regulatory compliance discrepancies.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT (PK) | Auto-increment ID |
| `adviser_crd` | TEXT | Links to `advisers_enriched.crd` |
| `fund_reference_id` | TEXT | Links to `funds_enriched.reference_id` |
| `form_d_cik` | TEXT | Links to `form_d_filings.cik` for EDGAR link |
| `discrepancy_type` | TEXT | Issue type (see below) |
| `severity` | TEXT | `low`, `medium`, `high`, `critical` |
| `status` | TEXT | `active`, `resolved`, `ignored`, `reviewing` |
| `description` | TEXT | Human-readable issue description |
| `metadata` | JSONB | Type-specific details |
| `detected_date` | TIMESTAMP | When issue was detected |

**Discrepancy Types:**
| Type | Description | Severity |
|------|-------------|----------|
| `needs_initial_adv_filing` | Form D filed >60 days ago, no ADV on file | High |
| `overdue_annual_amendment` | No ADV amendment in current year | High |
| `vc_exemption_violation` | Claims VC exemption but manages non-VC funds | High |
| `fund_type_mismatch` | Fund type differs between ADV and Form D | Medium |
| `missing_fund_in_adv` | Form D filed but fund not in latest ADV | Medium |
| `exemption_mismatch` | 3(c)(1) vs 3(c)(7) differs between filings | High |

---

### enriched_managers (Form D Database)

Contact enrichment data for new/emerging managers.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT (PK) | Auto-increment ID |
| `series_master_llc` | TEXT | Manager name (parsed from fund name) |
| `website_url` | TEXT | Discovered website |
| `linkedin_company_url` | TEXT | LinkedIn company page |
| `twitter_handle` | TEXT | Twitter/X handle |
| `primary_contact_email` | TEXT | Primary email found |
| `team_members` | JSONB | Array of team member objects |
| `enrichment_status` | TEXT | `pending`, `auto_enriched`, `manual_review_needed`, `no_data_found`, `platform_spv` |
| `enrichment_source` | TEXT | How data was found |
| `enriched_at` | TIMESTAMP | When enrichment completed |

---

## Key Linkages for Compliance Detection

### ADV Fund → Form D Filing
```
funds_enriched.form_d_file_number = form_d_filings.file_num
```

### Adviser → Funds
```
advisers_enriched.crd = funds_enriched.adviser_entity_crd
```

### Pre-computed Match → ADV Fund
```
cross_reference_matches.adv_fund_id = funds_enriched.fund_id
```

### Pre-computed Match → Form D Filing
```
cross_reference_matches.formd_accession = form_d_filings.accessionnumber
```

### Compliance Issue → EDGAR Link
```
Form D EDGAR URL: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={form_d_cik}&type=D
```

---

## Query Patterns

### Find advisers claiming VC exemption (handle mixed data formats)
```javascript
// Must query for BOTH formats due to data inconsistency
const { data: stringY } = await db.from('advisers_enriched').select('crd').eq('exemption_2b1', 'Y');
const { data: boolTrue } = await db.from('advisers_enriched').select('crd').eq('exemption_2b1', true);
// Combine and dedupe by CRD
```

### Find Form D filings NOT matched to any ADV
```javascript
// 1. Get all matched accessions
const { data: matches } = await db.from('cross_reference_matches').select('formd_accession');
const matchedSet = new Set(matches.map(m => m.formd_accession));

// 2. Get Form D filings
const { data: filings } = await db.from('form_d_filings').select('*');

// 3. Filter to unmatched
const unmatched = filings.filter(f => !matchedSet.has(f.accessionnumber));
```

### Find funds for a specific adviser
```javascript
const { data: funds } = await db
    .from('funds_enriched')
    .select('*')
    .eq('adviser_entity_crd', adviserCrd);
```

---

## Data Refresh Schedule

| Table | Refresh Frequency | Script/Action |
|-------|-------------------|---------------|
| `advisers_enriched` | Quarterly | Manual upload from SEC data |
| `funds_enriched` | Quarterly | Manual upload from SEC data |
| `form_d_filings` | Weekly | Automated SEC scraper |
| `cross_reference_matches` | Weekly (Sunday 3am UTC) | `scripts/compute_cross_reference.py` |
| `compliance_issues` | Daily (9am UTC) | `detect_compliance_issues.js` |
| `enriched_managers` | Daily (9am UTC) | `enrichment/enrich_recent.js` |

---

## Raw CSV Source Files (Reference)

For the raw Form ADV CSV file mapping showing which files feed into `advisers_enriched` and `funds_enriched`, see:
- Your detailed CSV mapping document (92 files)
- Key files: `IA_ADV_Base_A`, `ERA_ADV_Base`, `IA_Schedule_D_7B1`, `ERA_Schedule_D_7B1`

---

*This document should be referenced whenever building features that require cross-database queries or data linkages.*
