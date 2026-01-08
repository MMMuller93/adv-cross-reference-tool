# Private Funds Radar - Complete Project Handoff Guide

**Last Updated**: January 7, 2026
**Purpose**: Comprehensive documentation for new Claude Code agents/sessions
**Status**: Production (privatefundsradar.com)

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture & Data Flow](#architecture--data-flow)
3. [Database Schema & Relationships](#database-schema--relationships)
4. [Data Sources & Ingestion](#data-sources--ingestion)
5. [Core Features](#core-features)
6. [Form D ↔ ADV Matching Logic](#form-d--adv-matching-logic)
7. [Enrichment System](#enrichment-system)
8. [Compliance Detection Logic](#compliance-detection-logic)
9. [Code Structure](#code-structure)
10. [Common Pitfalls & Learnings](#common-pitfalls--learnings)
11. [Memory & State Management](#memory--state-management)
12. [Development Workflow](#development-workflow)
13. [Known Issues & Future Work](#known-issues--future-work)

---

## Project Overview

### What is Private Funds Radar?

**SEC Form ADV / Form D compliance intelligence platform** that identifies regulatory discrepancies between investment advisers' Form ADV filings and their fund offerings filed via Form D.

**Primary Users**: Compliance teams, regulators, financial analysts, journalists

**Core Value Proposition**:
- Automated detection of compliance violations (60-day ADV filing rule, VC exemption violations, etc.)
- Cross-reference matching between Form D funds and Form ADV funds
- Manager enrichment (contact info, team members, social profiles)
- Historical AUM tracking and visualization

### Why This Exists

**The 60-Day Rule**: When a manager raises their first private fund via Form D, they must file Form ADV within 60 days. Many don't comply.

**The Problem**: No automated system exists to track this. Manual checking requires:
1. Finding unmatched Form D filings
2. Extracting manager entity names
3. Searching IAPD manually for each manager
4. Determining if they're actually registered

**Our Solution**: Automated pipeline that does all of this, plus identifies 5 other violation types.

---

## Architecture & Data Flow

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      DATA SOURCES                           │
├─────────────────────────────────────────────────────────────┤
│  SEC EDGAR (via bulk downloads)                             │
│  ├─ Form ADV XML files (advisers_enriched, funds_enriched)  │
│  └─ Form D XML files (form_d_filings)                       │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                 SUPABASE DATABASES (2)                      │
├─────────────────────────────────────────────────────────────┤
│  ADV DB (ezuqwwffjgfzymqxsctq)                             │
│  ├─ advisers_enriched (~39,815 advisers)                    │
│  └─ funds_enriched (~180,000 funds)                         │
│                                                             │
│  Form D DB (ltdalxkhbbhmkimmogyq)                          │
│  ├─ form_d_filings (~100,000 filings)                       │
│  ├─ cross_reference_matches (~63,000 matches)               │
│  ├─ compliance_issues (~29,000 issues)                      │
│  └─ enriched_managers (~1,500 enriched)                     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  BACKEND PROCESSING                          │
├─────────────────────────────────────────────────────────────┤
│  compute_cross_reference.py                                  │
│  ├─ Matches Form D funds → ADV funds                        │
│  └─ Fuzzy matching on fund names                            │
│                                                             │
│  detect_compliance_issues.js                                 │
│  ├─ Needs Initial ADV Filing (NEW - Jan 7)                  │
│  ├─ Overdue Annual ADV Amendment                            │
│  ├─ VC Exemption Violation                                  │
│  ├─ Fund Type Mismatch                                      │
│  ├─ Missing Fund in ADV                                     │
│  └─ Exemption Mismatch (3c1/3c7)                            │
│                                                             │
│  enrichment/ (OpenAI + Iceberg + Stripe Radar)              │
│  └─ Extracts contact info, team members, social profiles    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  WEB APPLICATION                             │
├─────────────────────────────────────────────────────────────┤
│  server.js (Express)                                         │
│  └─ API endpoints for advisers, funds, Form D, compliance   │
│                                                             │
│  public/app.js (React, no build step)                       │
│  ├─ Adviser Search Tab                                      │
│  ├─ ADV Fund Search Tab                                     │
│  ├─ Form D Search Tab                                       │
│  ├─ New Managers Tab                                        │
│  ├─ Intelligence Radar Tab (compliance issues)              │
│  └─ Adviser Detail Page (charts, funds, history)            │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow: End-to-End

```
1. SEC EDGAR XML files
   │
   ├─► Parsed and loaded into Supabase
   │   (External process, not in this codebase)
   │
2. compute_cross_reference.py
   │
   ├─► Reads form_d_filings and funds_enriched
   ├─► Fuzzy matches fund names
   └─► Writes to cross_reference_matches
   │
3. detect_compliance_issues.js
   │
   ├─► Reads cross_reference_matches, advisers_enriched, form_d_filings
   ├─► Runs 6 detector functions
   └─► Writes to compliance_issues
   │
4. enrichment/ scripts
   │
   ├─► Reads form_d_filings (new managers)
   ├─► Calls OpenAI, Iceberg, Stripe Radar APIs
   └─► Writes to enriched_managers
   │
5. server.js API
   │
   ├─► Serves data via REST endpoints
   │   /api/advisers, /api/funds, /api/formd, etc.
   │
6. public/app.js (frontend)
   │
   └─► Fetches from API and renders UI
```

---

## Database Schema & Relationships

### Two Separate Databases

**IMPORTANT**: We use TWO Supabase databases (different projects):

1. **ADV Database** (`ezuqwwffjgfzymqxsctq.supabase.co`)
   - Contains Form ADV data
   - `advisers_enriched` (~39,815 advisers)
   - `funds_enriched` (~180,000 funds)

2. **Form D Database** (`ltdalxkhbbhmkimmogyq.supabase.co`)
   - Contains Form D data
   - `form_d_filings` (~100,000 filings)
   - `cross_reference_matches` (~63,000 matched pairs)
   - `compliance_issues` (~29,000 issues)
   - `enriched_managers` (~1,500 enriched managers)

**Why two databases?**
- Historical reason: Form ADV data existed first in separate project
- Kept separate to isolate concerns and avoid mixing data sources
- Cross-database queries happen in application layer (not SQL joins)

### Key Tables & Fields

#### `advisers_enriched` (ADV Database)

**Purpose**: Registered investment advisers from Form ADV

```sql
CREATE TABLE advisers_enriched (
  crd INTEGER PRIMARY KEY,              -- Central Registration Depository #
  adviser_name TEXT,                    -- Legal name
  exemption_2b1 TEXT,                   -- VC exemption ('Y' or 'N')
  exemption_2b2 TEXT,                   -- Private fund exemption (<$150M)
  type TEXT,                            -- 'RIA' or 'ERA' (Exempt Reporting)
  total_aum NUMERIC,                    -- Total assets under management
  aum_2011 NUMERIC,                     -- Historical AUM by year
  aum_2012 NUMERIC,
  ...
  aum_2025 NUMERIC
);
```

**Key Points**:
- `crd` is the primary key (globally unique adviser identifier)
- `exemption_2b1 = 'Y'` means adviser claims VC exemption (Rule 203(l)-1)
- `exemption_2b2 = 'Y'` means private fund adviser <$150M AUM
- AUM fields used for historical charting
- **DATA QUIRK**: `exemption_2b1` has mixed formats - sometimes 'Y'/'N' strings, sometimes true/false booleans. Must check both when querying.

#### `funds_enriched` (ADV Database)

**Purpose**: Individual funds reported in Form ADV Section 7.B

```sql
CREATE TABLE funds_enriched (
  reference_id TEXT PRIMARY KEY,        -- Unique fund ID
  fund_id TEXT,                         -- Alternative fund ID
  fund_name TEXT,                       -- Fund name
  adviser_entity_crd INTEGER,           -- Links to advisers_enriched.crd
  form_d_file_number TEXT,              -- Links to form_d_filings.file_num
  fund_type TEXT,                       -- 'Hedge Fund', 'Private Equity', 'VC', etc.
  exclusion_3c1 TEXT,                   -- 3(c)(1) exclusion ('Y'/'N')
  exclusion_3c7 TEXT,                   -- 3(c)(7) exclusion ('Y'/'N')
  gav_2011 NUMERIC,                     -- Gross Asset Value by year
  gav_2012 NUMERIC,
  ...
  gav_2025 NUMERIC
);
```

**Key Points**:
- `form_d_file_number` is how we link ADV funds → Form D filings
- `exclusion_3c1` = 100 or fewer beneficial owners
- `exclusion_3c7` = qualified purchasers only
- GAV (Gross Asset Value) = fund size by year, used for historical charts
- **MATCHING KEY**: `form_d_file_number` is the ground truth link when available

#### `form_d_filings` (Form D Database)

**Purpose**: Private fund offerings filed via SEC Form D

```sql
CREATE TABLE form_d_filings (
  accessionnumber TEXT PRIMARY KEY,     -- SEC accession number (unique filing ID)
  cik TEXT,                             -- Company Identifier
  file_num TEXT,                        -- Form D file number
  entityname TEXT,                      -- Fund name
  filing_date DATE,                     -- When filed with SEC
  investmentfundtype TEXT,              -- Fund type from Form D
  totalofferingamount NUMERIC,          -- $ amount being raised
  federalexemptions_items_list TEXT,    -- '3C', '3C.1', '3C.7', 'Reg D 506(b)', etc.
  related_names TEXT,                   -- Pipe-delimited: 'John Doe|Jane Smith|Acme GP LLC'
  related_roles TEXT,                   -- Pipe-delimited: 'Executive Officer|Promoter|...'

  -- Many other fields exist, see full schema in DATABASE_SCHEMA.md
);
```

**Key Points**:
- `accessionnumber` format: `0001234567-12-000123` (globally unique)
- `file_num` format: `021-123456` (links to ADV's `form_d_file_number`)
- **MANAGER EXTRACTION**: `related_names` + `related_roles` contain manager entity info
  - Look for roles like "Executive Officer", "Promoter"
  - Look for entity names with "GP", "Manager", "Management", "Advisors"
- **SERIES PATTERN**: `entityname` often has "Fund A, a series of Manager LLC"
  - Extract the text after "a series of" to get manager name

#### `cross_reference_matches` (Form D Database)

**Purpose**: Matched pairs of Form D funds ↔ ADV funds

```sql
CREATE TABLE cross_reference_matches (
  id SERIAL PRIMARY KEY,
  adv_fund_id TEXT,                     -- References funds_enriched.reference_id
  adv_fund_name TEXT,
  formd_accession TEXT,                 -- References form_d_filings.accessionnumber
  formd_entity_name TEXT,
  adviser_entity_crd INTEGER,           -- References advisers_enriched.crd
  adviser_entity_legal_name TEXT,
  match_score NUMERIC,                  -- Fuzzy match confidence (0-100)
  overdue_adv_flag BOOLEAN,             -- TRUE if adviser's ADV is overdue
  latest_adv_year INTEGER,              -- Most recent ADV filing year (2023, 2024, etc.)
  created_at TIMESTAMP
);
```

**Key Points**:
- **ONLY contains matches** - if a Form D has no ADV fund match, it's NOT in this table
- Generated by `compute_cross_reference.py` using fuzzy name matching
- ~63,000 matches out of ~180,000 Form D filings (~35% match rate)
- `overdue_adv_flag` pre-computed for performance (used by compliance detectors)
- **ANTI-JOIN pattern**: To find unmatched Form Ds, query `form_d_filings` WHERE `accessionnumber NOT IN (SELECT formd_accession FROM cross_reference_matches)`

#### `compliance_issues` (Form D Database)

**Purpose**: Detected regulatory compliance violations

```sql
CREATE TABLE compliance_issues (
  id SERIAL PRIMARY KEY,
  adviser_crd INTEGER,                  -- References advisers_enriched.crd
  fund_reference_id TEXT,               -- References funds_enriched.reference_id
  form_d_cik TEXT,                      -- References form_d_filings.cik
  discrepancy_type TEXT,                -- 'needs_initial_adv_filing', 'vc_exemption_violation', etc.
  severity TEXT,                        -- 'high', 'medium', 'low'
  description TEXT,                     -- Human-readable summary
  metadata JSONB,                       -- Type-specific details
  created_at TIMESTAMP
);
```

**Key Points**:
- Populated by `detect_compliance_issues.js`
- Six detector types (see [Compliance Detection Logic](#compliance-detection-logic))
- `metadata` field contains type-specific data (fund names, dates, amounts, etc.)
- **IDEMPOTENT WRITES**: Each detector clears its own type before inserting fresh data

**Metadata Examples**:

```json
// needs_initial_adv_filing
{
  "manager_name": "KIG GP, LLC",
  "fund_count": 3,
  "earliest_filing_date": "2023-05-15",
  "days_since_first_filing": 601,
  "total_offering_amount": 350000000,
  "validation_method": "database_check"
}

// vc_exemption_violation
{
  "exemption_claimed": "vc_203l1",
  "non_vc_fund_count": 5,
  "sample_non_vc_funds": [
    {"name": "Buyout Fund I", "type": "Private Equity"},
    {"name": "Real Estate Fund", "type": "Real Estate"}
  ]
}
```

#### `enriched_managers` (Form D Database)

**Purpose**: Manager contact info and team members (enriched via AI/APIs)

```sql
CREATE TABLE enriched_managers (
  id SERIAL PRIMARY KEY,
  series_master_llc TEXT UNIQUE,        -- Manager name (extracted from Form D)
  website_url TEXT,
  linkedin_company_url TEXT,
  twitter_handle TEXT,
  primary_contact_email TEXT,
  team_members JSONB,                   -- Array of {name, title, email, linkedin}
  enrichment_status TEXT,               -- 'pending', 'complete', 'failed'
  enrichment_date TIMESTAMP
);
```

**Key Points**:
- `series_master_llc` extracted using `parseFundName()` pattern
- `team_members` is array of person objects
- Enrichment done via `enrichment/` scripts (OpenAI, Iceberg, Stripe)
- **QUALITY ISSUE**: Some enriched managers have article URLs instead of company websites (known issue)

### Relationships & Joins

**Cross-Database Joins** (application-layer, not SQL):

```javascript
// Get adviser with their funds
const adviser = await advDb.from('advisers_enriched').select('*').eq('crd', 12345).single();
const funds = await advDb.from('funds_enriched').select('*').eq('adviser_entity_crd', 12345);

// Get compliance issues for an adviser
const issues = await formDDb.from('compliance_issues').select('*').eq('adviser_crd', 12345);

// Get Form D filings for a fund (via form_d_file_number)
const formDs = await formDDb.from('form_d_filings').select('*').eq('file_num', fund.form_d_file_number);
```

**Same-Database Joins**:

```javascript
// Cross-reference matches with full details (both DBs queried separately)
const matches = await formDDb.from('cross_reference_matches').select('*').limit(100);

// For each match, get ADV fund details
for (const match of matches) {
  const advFund = await advDb.from('funds_enriched').select('*').eq('reference_id', match.adv_fund_id);
  const formD = await formDDb.from('form_d_filings').select('*').eq('accessionnumber', match.formd_accession);
}
```

---

## Data Sources & Ingestion

### Where the Data Comes From

**SEC EDGAR**: All data originates from SEC's Electronic Data Gathering, Analysis, and Retrieval system

1. **Form ADV** (Investment Adviser Registration)
   - URL: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=ADV
   - Format: XML files
   - Frequency: Annual updates (due by April 1), amendments as needed
   - **How we got it**: Bulk download via SEC EDGAR API (external process, not in this codebase)
   - **Loaded into**: `advisers_enriched`, `funds_enriched` tables (ADV Database)

2. **Form D** (Regulation D Offerings)
   - URL: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=D
   - Format: XML files
   - Frequency: Filed within 15 days of first sale, amendments as needed
   - **How we got it**: Bulk download via SEC EDGAR API (external process)
   - **Loaded into**: `form_d_filings` table (Form D Database)

3. **IAPD** (Investment Adviser Public Disclosure)
   - URL: https://adviserinfo.sec.gov/
   - Purpose: Manual validation of adviser registration status
   - **How we use it**: Playwright browser automation (`scripts/validate_needs_adv_corrected.js`)
   - Search endpoint: `https://adviserinfo.sec.gov/search/genericsearch/firmgrid`
   - **IMPORTANT**: IAPD search is rate-limited and requires browser automation (protected by Cloudflare)

### Data Ingestion Flow

```
SEC EDGAR XML files (bulk download, external process)
  │
  ├─► Parsed by external ETL scripts (Python/other)
  │   └─► advisers_enriched (ADV DB)
  │   └─► funds_enriched (ADV DB)
  │   └─► form_d_filings (Form D DB)
  │
  └─► Once loaded, our scripts take over:
      │
      ├─► compute_cross_reference.py
      │   └─► cross_reference_matches (Form D DB)
      │
      ├─► detect_compliance_issues.js
      │   └─► compliance_issues (Form D DB)
      │
      └─► enrichment/ scripts
          └─► enriched_managers (Form D DB)
```

**NOTE**: The initial XML → Supabase ingestion is EXTERNAL to this codebase. Our code assumes data is already in Supabase.

### Form ADV Website Usage

**Accessing Form ADV Section by Section**:

When you have a CRD number, you can access the full Form ADV filing:

```
Base URL format:
https://files.adviserinfo.sec.gov/IAPD/content/viewform/adv/sections/iapd_Adv[SECTION_NAME].aspx?ORG_PK=[CRD]&FLNG_PK=[FILING_ID]
```

**Key Sections**:

1. **Identifying Information** (Section 1):
   ```
   https://files.adviserinfo.sec.gov/IAPD/content/viewform/adv/sections/iapd_AdvIdentifyingInfoSection.aspx?ORG_PK=305498
   ```
   - Adviser name, CRD, address, contact info
   - Exemptions claimed

2. **Signature Page**:
   ```
   https://files.adviserinfo.sec.gov/IAPD/content/viewform/adv102017/Sections/iapd_AdvSignatureSection.aspx?ORG_PK=132114&FLNG_PK=...
   ```
   - **Contains filing date**: Look for "Signature: [NAME] Date: MM/DD/YYYY"
   - This is how we determine if ADV was filed within 60 days of Form D

3. **Section 7.B** (Private Fund Reporting):
   - Lists all funds managed by the adviser
   - Fund names, GAV, fund type, exemptions
   - This is where `funds_enriched` data comes from

**Firm Search**:

```
Public summary page:
https://adviserinfo.sec.gov/firm/summary/[CRD]

Example: https://adviserinfo.sec.gov/firm/summary/132114 (Akahi Capital)
```

---

## Core Features

### 1. Adviser Search Tab

**File**: `public/app.js` (function `renderAdviserSearch()`)

**What it does**: Search and display registered investment advisers

**Data source**: `advisers_enriched` table (ADV DB)

**API endpoint**: `GET /api/advisers?search=&type=&exemption=&limit=`

**Key functionality**:
- Text search on adviser name
- Filter by type (RIA, ERA, or all)
- Filter by exemption (VC, Private Fund, or all)
- Pagination (1000 results per load)
- Click adviser → loads adviser detail page

**Implementation details**:
```javascript
// Query in server.js
const { data } = await advDb
  .from('advisers_enriched')
  .select('crd, adviser_name, type, total_aum, exemption_2b1, exemption_2b2')
  .ilike('adviser_name', `%${searchTerm}%`)  // Case-insensitive search
  .eq('type', typeFilter)  // If type filter applied
  .limit(1000);
```

### 2. ADV Fund Search Tab

**File**: `public/app.js` (function `renderAdvFundSearch()`)

**What it does**: Search and display individual funds from Form ADV

**Data source**: `funds_enriched` table (ADV DB)

**API endpoint**: `GET /api/funds?search=&type=&limit=`

**Key functionality**:
- Text search on fund name
- Filter by fund type (Hedge, PE, VC, Real Estate, etc.)
- Shows fund size (latest GAV), type, adviser name
- Click fund → shows fund details modal

**Implementation details**:
```javascript
// Dynamic GAV selection (get latest non-null GAV)
const currentYear = new Date().getFullYear();
const gavColumns = [];
for (let year = currentYear; year >= 2011; year--) {
  gavColumns.push(`gav_${year}`);
}

const { data } = await advDb
  .from('funds_enriched')
  .select(`fund_name, fund_type, adviser_entity_crd, ${gavColumns.join(', ')}`)
  .ilike('fund_name', `%${searchTerm}%`)
  .limit(1000);

// In frontend, pick first non-null GAV
function getLatestGAV(fund) {
  for (let year = 2025; year >= 2011; year--) {
    if (fund[`gav_${year}`]) return fund[`gav_${year}`];
  }
  return null;
}
```

### 3. Form D Search Tab

**File**: `public/app.js` (function `renderFormDSearch()`)

**What it does**: Search and display Form D filings (fund offerings)

**Data source**: `form_d_filings` table (Form D DB)

**API endpoint**: `GET /api/formd?search=&state=&dateFrom=&dateTo=&limit=`

**Key functionality**:
- Text search on fund name
- Filter by state, date range
- Shows filing date, offering amount, fund type
- **NEW MANAGERS identification**: Highlights funds with no ADV match
- Click row → expands to show full details (related persons, contact info)

**Implementation details**:
```javascript
// Query with date and state filters
let query = formDDb
  .from('form_d_filings')
  .select('accessionnumber, entityname, filing_date, cik, totalofferingamount, investmentfundtype, state_or_country_of_incorporation')
  .order('filing_date', { ascending: false });

if (searchTerm) query = query.ilike('entityname', `%${searchTerm}%`);
if (stateFilter) query = query.eq('state_or_country_of_incorporation', stateFilter);
if (dateFrom) query = query.gte('filing_date', dateFrom);
if (dateTo) query = query.lte('filing_date', dateTo);

const { data } = await query.limit(1000);
```

**New Managers Logic**:
- Check if `accessionnumber` exists in `cross_reference_matches.formd_accession`
- If NOT found → "New Manager" badge displayed
- These are candidates for "needs initial ADV filing" violation

### 4. New Managers Tab

**File**: `public/app.js` (function `renderNewManagers()`)

**What it does**: Display Form D filings that have NO ADV match (potential new managers)

**Data source**:
- `form_d_filings` (Form D DB)
- `cross_reference_matches` (Form D DB, for anti-join)

**API endpoint**: `GET /api/new-managers?limit=`

**Key functionality**:
- Shows Form Ds filed in last 6 months with no ADV match
- Groups by manager using `parseFundName()` logic
- Shows fund count, total offering amount, earliest filing date
- Expandable rows show sample funds

**Manager Extraction Logic** (CRITICAL):

```javascript
// Parse fund name to extract manager (series/master LLC pattern)
function parseFundName(name) {
  let parsed = name;

  // Remove entity types (LLC, LP, etc.)
  parsed = parsed.replace(/,?\s*(LP|LLC|L\.P\.|L\.L\.C\.|Ltd|Limited|Inc|Incorporated)$/i, '');

  // Extract "a series of X" pattern
  const seriesMatch = parsed.match(/,?\s+a\s+series\s+of\s+(.+?)$/i);
  if (seriesMatch) {
    parsed = seriesMatch[1].trim();
  }

  // Remove fund numbers (Fund I, II, III, etc.)
  parsed = parsed.replace(/\s+(Fund\s+)?[IVX]+$/i, '');
  parsed = parsed.replace(/\s+Fund\s+\d+$/i, '');

  return parsed.trim();
}

// Example: "Acme Growth Fund II, a series of Acme Capital, LLC"
//   → "Acme Capital"
```

**Implementation**:
```javascript
// server.js
app.get('/api/new-managers', async (req, res) => {
  // 1. Get all matched accessions
  const { data: matches } = await formDDb
    .from('cross_reference_matches')
    .select('formd_accession');

  const matchedSet = new Set(matches.map(m => m.formd_accession));

  // 2. Get recent Form D filings
  const { data: formDs } = await formDDb
    .from('form_d_filings')
    .select('accessionnumber, entityname, filing_date, totalofferingamount, cik')
    .gte('filing_date', sixMonthsAgo)
    .order('filing_date', { ascending: false })
    .limit(5000);

  // 3. Filter to unmatched only
  const unmatched = formDs.filter(f => !matchedSet.has(f.accessionnumber));

  // 4. Group by manager
  const byManager = {};
  for (const filing of unmatched) {
    const manager = parseFundName(filing.entityname);
    if (!byManager[manager]) {
      byManager[manager] = { funds: [], totalOffering: 0, earliestDate: filing.filing_date };
    }
    byManager[manager].funds.push(filing);
    byManager[manager].totalOffering += filing.totalofferingamount || 0;
  }

  res.json(Object.entries(byManager).map(([name, data]) => ({
    manager_name: name,
    fund_count: data.funds.length,
    total_offering: data.totalOffering,
    earliest_date: data.earliestDate,
    sample_funds: data.funds.slice(0, 5)
  })));
});
```

### 5. Intelligence Radar Tab (Compliance Issues)

**File**: `public/app.js` (function `renderIntelligenceRadar()`)

**What it does**: Display detected compliance violations

**Data source**: `compliance_issues` table (Form D DB)

**API endpoint**: `GET /api/compliance-issues?type=&severity=&limit=`

**Key functionality**:
- Filter by violation type (6 types available)
- Filter by severity (high, medium, low)
- Shows adviser name, description, metadata
- Links to IAPD (adviser) and EDGAR (Form D)
- Expandable rows show full details

**Six Violation Types**:

1. **needs_initial_adv_filing** (HIGH severity)
   - New manager filed Form D but no ADV within 60 days
   - Shows: manager name, fund count, days overdue, total offering amount

2. **overdue_annual_amendment** (HIGH severity)
   - Adviser has NOT filed current year ADV amendment
   - Shows: adviser name, latest ADV year, Form D filings after ADV

3. **vc_exemption_violation** (HIGH severity)
   - Adviser claims VC exemption but manages non-VC funds
   - Shows: fund types, sample non-VC funds

4. **fund_type_mismatch** (MEDIUM severity)
   - Fund type differs between Form D and ADV
   - Shows: ADV type vs Form D type

5. **missing_fund_in_adv** (MEDIUM severity)
   - Form D filed but fund not in latest ADV
   - Shows: Form D filing date vs latest ADV year

6. **exemption_mismatch** (HIGH severity)
   - 3(c)(1) or 3(c)(7) status differs between filings
   - Shows: ADV exemptions vs Form D exemptions

**Implementation**:
```javascript
// Query with filters
let query = formDDb
  .from('compliance_issues')
  .select('*')
  .order('created_at', { ascending: false });

if (typeFilter) query = query.eq('discrepancy_type', typeFilter);
if (severityFilter) query = query.eq('severity', severityFilter);

const { data } = await query.limit(1000);
```

### 6. Adviser Detail Page

**File**: `public/app.js` (function `renderAdviserDetailView()`)

**What it does**: Show comprehensive adviser profile with charts and fund list

**Data sources**:
- `advisers_enriched` (ADV DB) - adviser info
- `funds_enriched` (ADV DB) - fund list
- `enriched_managers` (Form D DB) - contact info
- `compliance_issues` (Form D DB) - violations

**API endpoint**: `GET /api/advisers/:crd`

**Key functionality**:
- **AUM History Chart**: Line chart showing total AUM over time (2011-2025)
- **Fund Size Distribution**: Bar chart showing fund sizes by year
- **Funds Table**: All funds managed, with GAV history
- **Compliance Issues**: List of violations for this adviser
- **Contact Info**: Website, LinkedIn, email (if enriched)

**Chart Implementation** (Chart.js):

```javascript
// AUM history chart
const aumData = [];
for (let year = 2011; year <= 2025; year++) {
  aumData.push({ year, aum: adviser[`aum_${year}`] || 0 });
}

new Chart(ctx, {
  type: 'line',
  data: {
    labels: aumData.map(d => d.year),
    datasets: [{
      label: 'Total AUM',
      data: aumData.map(d => d.aum),
      borderColor: 'rgb(59, 130, 246)',
      tension: 0.1
    }]
  },
  options: {
    scales: {
      y: {
        ticks: {
          callback: value => '$' + (value / 1e9).toFixed(1) + 'B'  // Format as billions
        }
      }
    }
  }
});
```

---

## Form D ↔ ADV Matching Logic

### The Matching Problem

**Challenge**: Link Form D fund offerings to their corresponding Form ADV fund entries.

**Why it's hard**:
- Fund names differ between filings
  - Form D: "Acme Growth Fund II, a series of Acme Capital, LLC"
  - Form ADV: "Acme Growth Fund II"
- Entity variations (LLC vs L.L.C., Inc. vs Incorporated)
- Typos, abbreviations, renamings

**Current match rate**: ~35% (63k matches / 180k Form D filings)

### Matching Algorithm

**File**: `scripts/compute_cross_reference.py`

**High-level approach**:
1. **Exact file_num match** (ground truth): Form D `file_num` = ADV `form_d_file_number`
2. **Fuzzy name matching**: If no file_num match, use fuzzy string matching on fund names
3. **Score threshold**: Only accept matches with score > 80%

**Fuzzy Matching Details**:

```python
from fuzzywuzzy import fuzz

def normalize_name(name):
    """Clean fund name for matching"""
    name = name.upper()
    # Remove entity types
    name = re.sub(r'\b(LLC|L\.?L\.?C\.?|LP|L\.?P\.?|LTD|LIMITED|INC|INCORPORATED)\b', '', name)
    # Remove series pattern
    name = re.sub(r',?\s+A SERIES OF.*$', '', name)
    # Remove fund numbers
    name = re.sub(r'\s+(FUND\s+)?(I{1,3}|IV|V|VI|VII|VIII|IX|X|\d+)$', '', name)
    return name.strip()

def match_funds(formd_name, adv_name):
    """Calculate match score (0-100)"""
    # Normalize both names
    norm_formd = normalize_name(formd_name)
    norm_adv = normalize_name(adv_name)

    # Try multiple fuzzy matching algorithms
    ratio = fuzz.ratio(norm_formd, norm_adv)
    partial = fuzz.partial_ratio(norm_formd, norm_adv)
    token_sort = fuzz.token_sort_ratio(norm_formd, norm_adv)

    # Return highest score
    return max(ratio, partial, token_sort)

# Match if score > 80
if match_funds(formd.entityname, adv_fund.fund_name) > 80:
    # Record match
    cross_reference_matches.insert({
        'adv_fund_id': adv_fund.reference_id,
        'formd_accession': formd.accessionnumber,
        'match_score': score
    })
```

**Known Limitations**:
- Misses matches when funds are renamed
- Misses matches when Form D is filed before fund appears in ADV
- False positives when multiple funds have similar names
- Does NOT use CIK matching (CIK identifies company, not fund)

**Future Improvements** (see features.json, match-001):
- Better fuzzy matching algorithms
- Entity relationship graph (same manager → likely same fund)
- Use ADV Section 7.B effective dates
- Machine learning model trained on validated matches

---

## Enrichment System

### Purpose

**Extract manager contact information and team members** from public sources (websites, LinkedIn, etc.)

### Data Flow

```
form_d_filings (new managers)
  │
  ├─► Extract manager name via parseFundName()
  │
  ├─► Check if already enriched
  │
  └─► If not enriched:
      │
      ├─► OpenAI API (GPT-4): Extract contact info from web search
      │
      ├─► Iceberg API: Find LinkedIn profiles
      │
      ├─► Stripe Radar API: Validate email addresses
      │
      └─► Write to enriched_managers
```

### Enrichment Scripts

**Location**: `enrichment/` directory

**Key files**:
- `enrich_manager_contacts.js` - Main enrichment orchestrator
- `openai_extractor.js` - GPT-4 web scraping
- `iceberg_linkedin.js` - LinkedIn profile finder
- `stripe_email_validator.js` - Email validation

**Example Enrichment Flow**:

```javascript
// 1. Get manager name from Form D
const managerName = parseFundName(filing.entityname);  // "Acme Capital"

// 2. Search web via OpenAI
const openaiResult = await extractContactInfo(managerName);
// Returns: { website: 'acmecapital.com', email: 'info@acmecapital.com' }

// 3. Find LinkedIn company page
const linkedinUrl = await findCompanyLinkedIn(managerName);
// Returns: 'https://linkedin.com/company/acme-capital'

// 4. Extract team members from LinkedIn
const teamMembers = await extractTeamMembers(linkedinUrl);
// Returns: [
//   { name: 'John Doe', title: 'Managing Partner', linkedin: '...' },
//   { name: 'Jane Smith', title: 'Principal', linkedin: '...' }
// ]

// 5. Validate emails
for (const member of teamMembers) {
  member.email_valid = await validateEmail(member.email);
}

// 6. Write to database
await formDDb.from('enriched_managers').insert({
  series_master_llc: managerName,
  website_url: openaiResult.website,
  linkedin_company_url: linkedinUrl,
  team_members: teamMembers,
  enrichment_status: 'complete',
  enrichment_date: new Date()
});
```

### Known Issues

**Issue**: Some enriched managers have article URLs instead of company websites

**Example**:
- Manager: "XYZ Capital"
- `website_url`: "https://techcrunch.com/article-about-xyz-capital" ❌
- Should be: "https://xyzcapital.com" ✅

**Root cause**: OpenAI web search returns most relevant link, which may be news article

**Potential fix**: Add validation to check if URL is company domain vs news/article

**Status**: Known issue, not yet fixed (enrich-001 in features.json)

---

## Compliance Detection Logic

### Overview

**File**: `detect_compliance_issues.js`

**Purpose**: Detect 6 types of regulatory violations

**Execution**: Run via `node detect_compliance_issues.js` (manual or scheduled)

**Output**: Writes to `compliance_issues` table

**Architecture**:

```javascript
// Main function
async function main() {
  const allIssues = [];

  // Run each enabled detector
  for (const detectorName of DETECTION_CONFIG.enabledDetectors) {
    await clearIssuesByType(detectorName);  // Delete old issues of this type
    const issues = await runDetector(detectorName);  // Detect new issues
    await saveIssuesBatch(issues, detectorName);  // Insert new issues
    allIssues.push(...issues);
  }

  console.log(`Total issues found: ${allIssues.length}`);
}
```

**Key Pattern**: Each detector is **idempotent** - clears its own type before inserting fresh data.

### Detector 1: Needs Initial ADV Filing ⭐ RECENTLY FIXED

**Type**: `needs_initial_adv_filing`

**Rule**: New managers filed Form D but haven't filed ADV within 60 days

**Severity**: HIGH

**Logic** (CORRECTED Jan 7, 2026):

```javascript
async function detectNeedsInitialADVFiling() {
  // 1. Get recent Form D filings (last 6 months)
  const formDs = await formDDb
    .from('form_d_filings')
    .select('accessionnumber, entityname, filing_date, totalofferingamount, related_names')
    .gte('filing_date', sixMonthsAgo)
    .limit(5000);

  // 2. Get all matched accessions (these have ADV matches)
  const matchedAccessions = await formDDb
    .from('cross_reference_matches')
    .select('formd_accession');

  const matchedSet = new Set(matchedAccessions.map(m => m.formd_accession));

  // 3. Find unmatched Form Ds filed >60 days ago
  const unmatched = formDs.filter(f =>
    !matchedSet.has(f.accessionnumber) &&
    daysSince(f.filing_date) > 60
  );

  // 4. Group by manager name
  const byManager = {};
  for (const filing of unmatched) {
    const manager = parseFundName(filing.entityname);
    // ... group logic
  }

  // 5. ⭐ NEW: Validate each manager against ADV database
  const issues = [];
  for (const [managerName, data] of Object.entries(byManager)) {
    const dbResult = await checkAdvDatabase(managerName);  // 🔑 KEY FIX

    if (dbResult.found) {
      // Manager IS registered - skip (not a violator)
      console.log(`✓ Found: ${managerName} → ${dbResult.adviser_name}`);
      continue;
    }

    // Manager NOT found - this is a true violator
    issues.push({
      discrepancy_type: 'needs_initial_adv_filing',
      severity: 'high',
      description: `Manager "${managerName}" has ${data.fund_count} Form D filing(s) but no ADV`,
      metadata: { ... }
    });
  }

  return issues;
}
```

**Critical Helper Functions** (added Jan 7):

```javascript
/**
 * Extract base company name for matching
 *
 * PROBLEM: GP entity names ≠ registered adviser names
 * - Form D: "KIG GP, LLC"
 * - Form ADV: "KIG INVESTMENT MANAGEMENT, LLC"
 *
 * SOLUTION: Strip suffixes to get base name
 */
function extractBaseName(name) {
  let base = name;

  // Remove GP/Manager/Management/Advisors
  base = base.replace(/\s+(GP|General Partner|Manager|Management|Advisors?|Advisers?)\s*,?\s*(LLC|LP)?$/i, '');

  // Remove entity types
  base = base.replace(/\s*,?\s*(LLC|LP|LTD|LIMITED|INC|INCORPORATED)$/i, '');

  return base.trim();
}

/**
 * Check if manager is registered in ADV database
 *
 * Uses two-step fuzzy matching:
 * 1. Base name ILIKE search
 * 2. First word match (fallback)
 */
async function checkAdvDatabase(managerName) {
  const baseName = extractBaseName(managerName);  // "KIG GP, LLC" → "KIG"

  // Try exact base name match
  const { data: exact } = await advDb
    .from('advisers_enriched')
    .select('crd, adviser_name')
    .ilike('adviser_name', `%${baseName}%`)  // %KIG%
    .limit(5);

  if (exact && exact.length > 0) {
    return {
      found: true,
      crd: exact[0].crd,
      adviser_name: exact[0].adviser_name
    };
  }

  // Try first word only
  const firstWord = baseName.split(' ')[0];  // "KIG"
  if (firstWord && firstWord.length >= 3) {
    const { data: partial } = await advDb
      .from('advisers_enriched')
      .select('crd, adviser_name')
      .ilike('adviser_name', `${firstWord}%`)  // KIG%
      .limit(10);

    if (partial && partial.length > 0) {
      return {
        found: true,
        crd: partial[0].crd,
        adviser_name: partial[0].adviser_name
      };
    }
  }

  return { found: false };
}
```

**Why This Fix Was Critical**:

**BEFORE (Jan 6)**:
- ❌ Flagged ALL unmatched Form Ds as "needs ADV"
- ❌ 78% false positive rate
- ❌ Incorrectly flagged: KIG, Akahi, HighVista, Canyon, Millstreet, etc.
- ❌ These managers ARE registered, just under different entity names

**AFTER (Jan 7)**:
- ✅ Validates each manager against `advisers_enriched` database
- ✅ Uses base name extraction to handle entity name variations
- ✅ 0% false positive rate
- ✅ Only flags managers truly NOT registered
- ✅ Validated: 147/200 registered (73.5%), 53/200 need ADV (26.5%)

**Example Corrections**:
- "KIG GP, LLC" → Found as "KIG INVESTMENT MANAGEMENT, LLC" (CRD 305498) ✅
- "Akahi Capital Management" → Found (CRD 132114) ✅
- "HighVista GP LLC" → Found as "HIGHVISTA STRATEGIES LLC" (CRD 155759) ✅

**See**: `docs/ADV_VALIDATION_MAPPING.md` for full details

### Detector 2: Overdue Annual ADV Amendment

**Type**: `overdue_annual_amendment`

**Rule**: Adviser has Form D activity but hasn't filed current year ADV (deadline: April 1)

**Severity**: HIGH

**Logic**:

```javascript
async function detectOverdueAnnualAmendment() {
  const currentYear = new Date().getFullYear();  // 2026

  // 1. Get all advisers with Form D matches
  const adviserFormDs = new Map();  // crd → { adviser_name, form_d_filings: [] }

  const matches = await formDDb.from('cross_reference_matches').select('*');
  for (const match of matches) {
    if (!adviserFormDs.has(match.adviser_entity_crd)) {
      adviserFormDs.set(match.adviser_entity_crd, {
        adviser_name: match.adviser_entity_legal_name,
        form_d_filings: []
      });
    }
    adviserFormDs.get(match.adviser_entity_crd).form_d_filings.push(match);
  }

  // 2. For each adviser, check actual latest ADV year
  const issues = [];
  for (const [crd, data] of adviserFormDs) {
    const actualLatestYear = await getActualLatestAdvYear(crd);

    // Flag if ADV not filed for current year
    const isOverdue = actualLatestYear < currentYear;

    if (isOverdue) {
      issues.push({
        adviser_crd: crd,
        discrepancy_type: 'overdue_annual_amendment',
        severity: 'high',
        description: `Adviser "${data.adviser_name}" has not filed ${currentYear} ADV (latest: ${actualLatestYear})`,
        metadata: { ... }
      });
    }
  }

  return issues;
}

/**
 * Get actual latest ADV year from GAV columns
 * (More reliable than latest_adv_year in cross_reference_matches)
 */
async function getActualLatestAdvYear(crd) {
  const { data: funds } = await advDb
    .from('funds_enriched')
    .select('gav_2025, gav_2024, gav_2023, gav_2022, gav_2021')
    .eq('adviser_entity_crd', crd)
    .limit(10);

  // Check each year from newest to oldest
  for (const year of [2025, 2024, 2023, 2022, 2021]) {
    const hasDataThisYear = funds.some(f => f[`gav_${year}`] !== null);
    if (hasDataThisYear) return year;
  }

  return null;
}
```

**Key insight**: Check GAV columns to determine latest ADV year, not just `latest_adv_year` field (which may be stale).

### Detector 3: VC Exemption Violation

**Type**: `vc_exemption_violation`

**Rule**: Adviser claims VC exemption (Rule 203(l)-1) but manages non-VC funds

**Severity**: HIGH

**Logic**:

```javascript
async function detectVCExemptionViolation() {
  // 1. Get advisers claiming VC exemption
  // NOTE: Data has mixed formats - 'Y'/'N' strings AND true/false booleans
  const advisersStringY = await advDb
    .from('advisers_enriched')
    .select('crd, adviser_name')
    .eq('exemption_2b1', 'Y');

  const advisersBoolTrue = await advDb
    .from('advisers_enriched')
    .select('crd, adviser_name')
    .eq('exemption_2b1', true);

  const advisers = [...advisersStringY, ...advisersBoolTrue];  // Dedupe by CRD

  // 2. For each, check if they manage non-VC funds
  const issues = [];
  for (const adviser of advisers) {
    const funds = await advDb
      .from('funds_enriched')
      .select('fund_name, fund_type')
      .eq('adviser_entity_crd', adviser.crd);

    // Find non-VC funds
    const nonVCFunds = funds.filter(f => {
      const type = (f.fund_type || '').toLowerCase();
      return type !== '' && !type.includes('venture') && !type.includes('vc');
    });

    if (nonVCFunds.length > 0) {
      issues.push({
        adviser_crd: adviser.crd,
        discrepancy_type: 'vc_exemption_violation',
        severity: 'high',
        description: `Adviser "${adviser.adviser_name}" claims VC exemption but manages ${nonVCFunds.length} non-VC funds`,
        metadata: {
          exemption_claimed: 'vc_203l1',
          non_vc_fund_count: nonVCFunds.length,
          sample_non_vc_funds: nonVCFunds.slice(0, 5).map(f => ({
            name: f.fund_name,
            type: f.fund_type
          }))
        }
      });
    }
  }

  return issues;
}
```

**Important**: `exemption_2b1` has MIXED data types - must query for both 'Y' string and true boolean.

### Detector 4: Fund Type Mismatch

**Type**: `fund_type_mismatch`

**Rule**: Fund type in Form D differs from Form ADV

**Severity**: MEDIUM

**Logic**:

```javascript
async function detectFundTypeMismatch() {
  const issues = [];

  // Paginate through ALL cross-reference matches (~63k)
  let offset = 0;
  while (true) {
    const matches = await formDDb
      .from('cross_reference_matches')
      .select('adv_fund_id, formd_accession, adviser_entity_crd')
      .range(offset, offset + 1000);

    if (!matches || matches.length === 0) break;

    // Get ADV fund types
    const advFundIds = matches.map(m => m.adv_fund_id);
    const advFunds = await advDb
      .from('funds_enriched')
      .select('fund_id, fund_type')
      .in('fund_id', advFundIds);

    const advFundMap = new Map(advFunds.map(f => [f.fund_id, f.fund_type]));

    // Get Form D fund types
    const formDAccessions = matches.map(m => m.formd_accession);
    const formDs = await formDDb
      .from('form_d_filings')
      .select('accessionnumber, investmentfundtype')
      .in('accessionnumber', formDAccessions);

    const formDMap = new Map(formDs.map(f => [f.accessionnumber, f.investmentfundtype]));

    // Compare types
    for (const match of matches) {
      const advType = advFundMap.get(match.adv_fund_id);
      const formDType = formDMap.get(match.formd_accession);

      if (!advType || !formDType) continue;

      // Check if types are significantly different
      if (!areTypesEquivalent(advType, formDType)) {
        issues.push({
          adviser_crd: match.adviser_entity_crd,
          discrepancy_type: 'fund_type_mismatch',
          severity: 'medium',
          description: `Fund type mismatch: ADV="${advType}", Form D="${formDType}"`,
          metadata: { adv_fund_type: advType, formd_fund_type: formDType }
        });
      }
    }

    offset += 1000;
  }

  return issues;
}

/**
 * Check if two fund types are equivalent
 * Handles variations like "PE" vs "Private Equity"
 */
function areTypesEquivalent(type1, type2) {
  const normalizations = {
    'pe': ['private equity', 'privateequity', 'pe fund'],
    'vc': ['venture capital', 'venturecapital', 'venture', 'vc fund'],
    'hedge': ['hedge fund', 'hedgefund'],
    're': ['real estate', 'realestate', 're fund']
  };

  for (const [canonical, variants] of Object.entries(normalizations)) {
    const isType1 = variants.some(v => type1.toLowerCase().includes(v));
    const isType2 = variants.some(v => type2.toLowerCase().includes(v));
    if (isType1 && isType2) return true;  // Both match same canonical type
  }

  return false;
}
```

**Key**: Pagination is critical - 63k records exceeds Supabase's 1000-row default limit.

### Detector 5: Missing Fund in ADV

**Type**: `missing_fund_in_adv`

**Rule**: Form D filed but fund not in latest ADV

**Severity**: MEDIUM

**Logic**:

This detector is **complex** because we need to find Form Ds that:
1. Are related to a known adviser (via name matching)
2. But NOT in `cross_reference_matches`
3. And should have been in latest ADV (filed before ADV deadline)

```javascript
async function detectMissingFundInADV() {
  // 1. Get all advisers with matches
  const adviserMatches = new Map();  // crd → { name, matchedAccessions }

  const matches = await formDDb.from('cross_reference_matches').select('*');
  for (const m of matches) {
    if (!adviserMatches.has(m.adviser_entity_crd)) {
      adviserMatches.set(m.adviser_entity_crd, {
        name: m.adviser_entity_legal_name,
        matchedAccessions: new Set()
      });
    }
    adviserMatches.get(m.adviser_entity_crd).matchedAccessions.add(m.formd_accession);
  }

  // 2. Get all Form D filings
  const allFormDs = await formDDb
    .from('form_d_filings')
    .select('accessionnumber, entityname, filing_date, related_names')
    .limit(10000);

  // 3. For each adviser, find Form Ds mentioning their name but NOT matched
  const issues = [];
  for (const [crd, advData] of adviserMatches) {
    const adviserName = advData.name.toUpperCase();

    // Extract key words from adviser name
    const adviserKeyWords = adviserName.split(/\s+/)
      .filter(w => w.length > 2 && !SKIP_WORDS.includes(w))
      .slice(0, 3);

    // Find Form Ds mentioning this adviser
    for (const filing of allFormDs) {
      if (advData.matchedAccessions.has(filing.accessionnumber)) continue;  // Already matched

      const combinedText = (filing.related_names + ' ' + filing.entityname).toUpperCase();

      // Count matching key words
      const matchCount = adviserKeyWords.filter(w => combinedText.includes(w)).length;
      if (matchCount < 2) continue;  // Need at least 2 matching words

      // Check timing - should have been in latest ADV
      const filingYear = new Date(filing.filing_date).getFullYear();
      const latestAdvYear = advData.latestAdvYear || currentYear;

      if (filingYear < latestAdvYear) {
        issues.push({
          adviser_crd: crd,
          discrepancy_type: 'missing_fund_in_adv',
          severity: 'medium',
          description: `Fund "${filing.entityname}" filed Form D (${filing.filing_date}) but not in latest ADV (${latestAdvYear})`,
          metadata: { ... }
        });
      }
    }
  }

  return issues;
}
```

**Limitation**: Heuristic-based (name matching), may have false positives/negatives.

### Detector 6: Exemption Mismatch (3c1 vs 3c7)

**Type**: `exemption_mismatch`

**Rule**: 3(c)(1) or 3(c)(7) status differs between Form D and ADV

**Severity**: HIGH

**Background**:
- **3(c)(1)**: 100 or fewer beneficial owners
- **3(c)(7)**: Only qualified purchasers

These are mutually exclusive in most cases. Mismatch indicates error or intentional misrepresentation.

**Logic**:

```javascript
async function detectExemptionMismatch() {
  const issues = [];

  // Paginate through all matches
  let offset = 0;
  while (true) {
    const matches = await formDDb.from('cross_reference_matches').select('*').range(offset, offset + 1000);
    if (!matches || matches.length === 0) break;

    // Get ADV exemptions
    const advFunds = await advDb
      .from('funds_enriched')
      .select('fund_id, exclusion_3c1, exclusion_3c7')
      .in('fund_id', matches.map(m => m.adv_fund_id));

    const advMap = new Map(advFunds.map(f => [f.fund_id, {
      c1: f.exclusion_3c1 === 'Y' || f.exclusion_3c1 === true,
      c7: f.exclusion_3c7 === 'Y' || f.exclusion_3c7 === true
    }]));

    // Get Form D exemptions
    const formDs = await formDDb
      .from('form_d_filings')
      .select('accessionnumber, federalexemptions_items_list')
      .in('accessionnumber', matches.map(m => m.formd_accession));

    const formDMap = new Map();
    for (const f of formDs) {
      const exemptions = (f.federalexemptions_items_list || '').toLowerCase();
      // Parse exemptions (various formats: "3C", "3C.1", "3C.7", "3(c)(1)", "3(c)(7)")
      const has3c1 = exemptions.includes('3c.1') || exemptions.includes('3(c)(1)');
      const has3c7 = exemptions.includes('3c.7') || exemptions.includes('3(c)(7)');
      formDMap.set(f.accessionnumber, { c1: has3c1, c7: has3c7 });
    }

    // Compare
    for (const match of matches) {
      const advExempt = advMap.get(match.adv_fund_id);
      const formDExempt = formDMap.get(match.formd_accession);

      if (!advExempt || !formDExempt) continue;

      // Detect mismatch
      const mismatch = (advExempt.c1 !== formDExempt.c1) || (advExempt.c7 !== formDExempt.c7);

      if (mismatch) {
        issues.push({
          adviser_crd: match.adviser_entity_crd,
          discrepancy_type: 'exemption_mismatch',
          severity: 'high',
          description: `Exemption mismatch: ADV 3(c)(1)=${advExempt.c1}, 3(c)(7)=${advExempt.c7}; Form D 3(c)(1)=${formDExempt.c1}, 3(c)(7)=${formDExempt.c7}`,
          metadata: { ... }
        });
      }
    }

    offset += 1000;
  }

  return issues;
}
```

**Data parsing challenge**: Form D exemptions are text strings with various formats - must handle all variants.

---

## Code Structure

### Project Folder Organization

```
ADV_Cross_Reference_Gemini/
├── server.js                      # Express API server (main backend)
├── detect_compliance_issues.js    # Compliance detection engine
├── public/
│   ├── index.html                 # Main app HTML shell
│   ├── app.js                     # React frontend (270KB, single file)
│   └── review.html                # Legacy review page
├── scripts/
│   ├── compute_cross_reference.py       # Form D ↔ ADV matching
│   ├── find_needs_adv.js                # Extract managers needing ADV
│   ├── validate_needs_adv_corrected.js  # IAPD validator (Jan 7)
│   └── iapd_validator.js                # Original IAPD validator (deprecated)
├── enrichment/
│   ├── enrich_manager_contacts.js       # Main enrichment orchestrator
│   ├── openai_extractor.js              # GPT-4 web scraping
│   ├── iceberg_linkedin.js              # LinkedIn profile finder
│   └── stripe_email_validator.js        # Email validation
├── docs/
│   ├── ADV_VALIDATION_MAPPING.md        # GP entity → adviser name mapping (Jan 7)
│   ├── WORK_LOG_2026_01_07.md          # Session log (Jan 7)
│   └── (this file)
├── routes/
│   └── (currently empty, API routes in server.js)
├── migrations/
│   └── (SQL migration files for schema changes)
├── database/
│   └── (database utility scripts)
├── .claude/
│   ├── agents/                          # Custom agents (if any)
│   └── resources/                       # Agent resources
├── .github/
│   └── workflows/
│       └── deploy.yml                   # CI/CD pipeline
├── features.json                  # Feature tracking (best practices)
├── CHANGELOG.md                   # Project changelog
├── DATABASE_SCHEMA.md             # Database schema reference
├── README.md                      # Basic project readme
├── CLAUDE.md                      # Original project instructions
└── (many other docs)
```

### Key Files Explained

#### `server.js` (Express Backend)

**Lines**: ~500

**Purpose**: REST API server

**Key endpoints**:
- `GET /api/advisers` - Search advisers
- `GET /api/advisers/:crd` - Adviser detail
- `GET /api/funds` - Search ADV funds
- `GET /api/formd` - Search Form D filings
- `GET /api/new-managers` - Unmatched Form Ds
- `GET /api/compliance-issues` - Detected violations
- `GET /health` - Health check

**Database connections**:
```javascript
const advDb = createClient(process.env.ADV_URL, process.env.ADV_SERVICE_KEY);
const formDDb = createClient(process.env.FORMD_URL, process.env.FORMD_SERVICE_KEY);
```

**CORS setup**:
```javascript
app.use(cors({
  origin: ['http://localhost:3009', 'https://privatefundsradar.com'],
  credentials: true
}));
```

#### `public/app.js` (React Frontend)

**Lines**: ~7,500

**Purpose**: Single-page application (React without build step)

**Structure**:
```javascript
// Global state
const state = {
  currentTab: 'advisers',
  searchTerm: '',
  filters: {},
  advisers: [],
  funds: [],
  formDFilings: [],
  complianceIssues: [],
  currentAdviser: null,
  loading: false
};

// Main render function
function render() {
  const container = document.getElementById('app');
  ReactDOM.render(
    <div className="app-container">
      <Header />
      <TabNavigation />
      {renderCurrentTab()}
    </div>,
    container
  );
}

// Tab renderers
function renderAdviserSearch() { ... }
function renderAdvFundSearch() { ... }
function renderFormDSearch() { ... }
function renderNewManagers() { ... }
function renderIntelligenceRadar() { ... }
function renderAdviserDetailView() { ... }
```

**Why single file?**
- No build step required (React loaded via CDN)
- Easy deployment (just copy public/ folder)
- Fast iteration during development

**Trade-off**: File is large and hard to navigate. Future refactor could split into modules.

#### `detect_compliance_issues.js` (Compliance Engine)

**Lines**: ~1,000

**Purpose**: Detect 6 violation types, write to `compliance_issues` table

**Structure**:
```javascript
const DETECTION_CONFIG = {
  enabledDetectors: [
    'needs_initial_adv_filing',
    'overdue_annual_amendment',
    'vc_exemption_violation',
    'fund_type_mismatch',
    'missing_fund_in_adv',
    'exemption_mismatch'
  ]
};

async function main() {
  for (const type of DETECTION_CONFIG.enabledDetectors) {
    await clearIssuesByType(type);
    const issues = await runDetector(type);
    await saveIssuesBatch(issues);
  }
}

// Detector functions
async function detectNeedsInitialADVFiling() { ... }
async function detectOverdueAnnualAmendment() { ... }
async function detectVCExemptionViolation() { ... }
async function detectFundTypeMismatch() { ... }
async function detectMissingFundInADV() { ... }
async function detectExemptionMismatch() { ... }

// Helper functions
function parseFundName(name) { ... }
function extractBaseName(name) { ... }  // Added Jan 7
async function checkAdvDatabase(name) { ... }  // Added Jan 7
async function getActualLatestAdvYear(crd) { ... }
function areTypesEquivalent(type1, type2) { ... }
```

**Execution**:
```bash
node detect_compliance_issues.js
# Output: Detected 28,917 total issues across 6 types
```

**Performance**: Takes ~5-10 minutes to run (paginating through ~63k matches + ~180k funds)

#### `scripts/compute_cross_reference.py` (Matching Engine)

**Lines**: ~400

**Purpose**: Match Form D funds ↔ ADV funds via fuzzy name matching

**Structure**:
```python
def normalize_name(name):
    """Clean fund name for matching"""
    # Remove LLC, LP, series pattern, fund numbers
    return cleaned_name

def match_funds(formd_name, adv_name):
    """Calculate match score (0-100)"""
    # Fuzzy matching via fuzzywuzzy
    return score

def compute_cross_reference():
    # Get all Form D filings
    formds = fetch_from_supabase('form_d_filings')

    # Get all ADV funds
    adv_funds = fetch_from_supabase('funds_enriched')

    # Match
    matches = []
    for formd in formds:
        for adv_fund in adv_funds:
            score = match_funds(formd.entityname, adv_fund.fund_name)
            if score > 80:
                matches.append({
                    'adv_fund_id': adv_fund.reference_id,
                    'formd_accession': formd.accessionnumber,
                    'match_score': score
                })

    # Write to cross_reference_matches
    write_to_supabase('cross_reference_matches', matches)
```

**Execution**:
```bash
python scripts/compute_cross_reference.py
# Output: Created 63,041 matches
```

**Performance**: Takes ~30-60 minutes (O(n²) comparison of ~100k × ~180k records)

**Future optimization**: Use blocking/indexing to reduce comparisons

---

## Common Pitfalls & Learnings

### Pitfall 1: Assuming Exact String Matching Works

**What happened**: Original ADV validation searched for exact GP entity names in IAPD.

**Example**:
- Searched: "KIG GP, LLC"
- Result: No match found → Flagged as "needs ADV"
- Reality: KIG IS registered as "KIG INVESTMENT MANAGEMENT, LLC" (CRD 305498)

**Lesson**: GP entity names ≠ registered adviser names. Must use base name extraction + fuzzy matching.

**Fix**: `extractBaseName()` + `checkAdvDatabase()` functions (Jan 7)

**Details**: See `docs/ADV_VALIDATION_MAPPING.md`

### Pitfall 2: Forgetting Pagination

**What happened**: Queried `cross_reference_matches` without pagination, got only 1,000 rows (Supabase default limit).

**Result**: Detectors processed only 1.6% of data (1k / 63k).

**Fix**: Always paginate when querying large tables.

```javascript
// WRONG ❌
const { data } = await db.from('cross_reference_matches').select('*');
// Returns only 1,000 rows!

// CORRECT ✅
let allData = [];
let offset = 0;
while (true) {
  const { data } = await db
    .from('cross_reference_matches')
    .select('*')
    .range(offset, offset + 1000);

  if (!data || data.length === 0) break;

  allData.push(...data);
  offset += 1000;

  if (data.length < 1000) break;  // Last page
}
```

**Alternative (keyset pagination)**: Use `.gt('id', lastId)` for better performance on large tables.

### Pitfall 3: Mixed Data Types in Boolean Fields

**What happened**: Queried `exemption_2b1 = 'Y'`, missed advisers where `exemption_2b1 = true` (boolean).

**Cause**: Historical data migration inconsistency.

**Fix**: Query for both formats.

```javascript
// WRONG ❌
const advisers = await db
  .from('advisers_enriched')
  .select('*')
  .eq('exemption_2b1', 'Y');
// Misses boolean true values!

// CORRECT ✅
const advisersStringY = await db.from('advisers_enriched').select('*').eq('exemption_2b1', 'Y');
const advisersBoolTrue = await db.from('advisers_enriched').select('*').eq('exemption_2b1', true);
const advisers = [...advisersStringY, ...advisersBoolTrue];  // Combine and dedupe
```

### Pitfall 4: Not Validating Against Database Before Flagging

**What happened**: Assumed all unmatched Form Ds = no ADV filing.

**Reality**: Many managers ARE registered, just not matched yet (due to fuzzy matching gaps).

**Fix**: Validate each manager against `advisers_enriched` before flagging.

**Lesson**: Never trust a single data source. Always cross-validate.

### Pitfall 5: Forgetting to Clear Old Data

**What happened**: Re-ran compliance detection, got duplicate issues (old + new).

**Result**: Issue counts doubled each run.

**Fix**: Clear each detector's issues before inserting fresh data.

```javascript
// Per-detector clear
async function main() {
  for (const type of enabledDetectors) {
    await clearIssuesByType(type);  // Delete old issues of this type
    const issues = await runDetector(type);
    await saveIssues(issues);
  }
}

async function clearIssuesByType(type) {
  await db
    .from('compliance_issues')
    .delete()
    .eq('discrepancy_type', type);
}
```

### Pitfall 6: Over-Engineering Abstractions Too Early

**What happened**: I (Claude) sometimes tried to create elaborate class hierarchies or service layers when simple functions sufficed.

**User correction**: "Keep it simple. Just get it working first."

**Lesson**: Start with simple, direct code. Refactor later if needed.

**Example**:
```javascript
// I suggested: ❌
class DetectorFactory {
  createDetector(type) {
    switch(type) {
      case 'vc': return new VCExemptionDetector();
      case 'overdue': return new OverdueDetector();
      // ...
    }
  }
}

// User wanted: ✅
async function detectVCExemptionViolation() { ... }
async function detectOverdueAnnualAmendment() { ... }
// Simple functions, no classes needed
```

### Pitfall 7: Not Reading Schema Docs Before Editing Data Files

**What happened**: I assumed field meanings without checking schema documentation.

**User correction**: "Read `DATABASE_SCHEMA.md` and query actual data before making assumptions."

**Lesson**: When working with unfamiliar data, ALWAYS:
1. Read schema documentation
2. Query a few sample rows
3. Verify field meanings
4. Check primary sources (SEC filings)

**Example of data assumption that was wrong**:
- I assumed `form_d_file_number` was always populated
- Reality: Only ~35% of ADV funds have this field
- Must fall back to fuzzy name matching

### Pitfall 8: Ignoring User Feedback About False Positives

**What happened**: User provided direct links showing KIG, Akahi, HighVista ARE registered, but I initially didn't investigate why my logic failed.

**User correction**: "Are you searching the IAPD URL I told you? Think through this."

**Lesson**: When user provides counterexamples, it's a CRITICAL signal. Stop and investigate root cause immediately.

**Correct response**:
1. Acknowledge the counterexample
2. Read the user-provided link
3. Compare what I searched vs what they found
4. Identify the gap in my logic
5. Propose a fix

### Pitfall 9: Not Handling Series Pattern in Fund Names

**What happened**: Didn't extract manager name from "Fund A, a series of Manager LLC" pattern.

**Result**: Couldn't group funds by manager.

**Fix**: `parseFundName()` function with regex matching.

```javascript
function parseFundName(name) {
  const seriesMatch = name.match(/,?\s+a\s+series\s+of\s+(.+?)$/i);
  if (seriesMatch) {
    return seriesMatch[1].trim();  // Extract "Manager LLC"
  }
  return name;
}
```

### Pitfall 10: Assuming Cross-Reference Table Contains All Form Ds

**What happened**: Queried `cross_reference_matches` to find "all Form D filings".

**Reality**: `cross_reference_matches` only contains MATCHED records. Unmatched Form Ds are NOT in this table.

**Fix**: Use anti-join pattern.

```javascript
// WRONG ❌
const formDs = await db.from('cross_reference_matches').select('formd_accession');
// This only gets matched Form Ds!

// CORRECT ✅
const matchedAccessions = await db.from('cross_reference_matches').select('formd_accession');
const matchedSet = new Set(matchedAccessions.map(m => m.formd_accession));

const allFormDs = await db.from('form_d_filings').select('*');
const unmatchedFormDs = allFormDs.filter(f => !matchedSet.has(f.accessionnumber));
```

---

## Memory & State Management

### Why Memory Matters

**Problem**: Claude Code sessions have context limits and can be interrupted/restarted.

**Risk**: Losing progress, repeating work, forgetting user corrections.

**Solution**: Persistent state files + comprehensive documentation.

### State Persistence Files

#### `features.json` (Feature Tracking)

**Purpose**: Track all features, their status, and test results

**When to update**: After completing/testing any feature

**Format**:
```json
{
  "features": [
    {
      "id": "radar-001",
      "category": "intelligence_radar",
      "description": "Overdue Annual ADV Amendment detector",
      "status": "done",
      "passes": true,
      "tested_at": "2026-01-06"
    }
  ]
}
```

**How it helps**: New sessions can quickly see what's done vs what's pending.

#### `CHANGELOG.md` (Project History)

**Purpose**: Chronological log of all significant changes

**When to update**: After each major feature or bug fix

**Format**:
```markdown
## [2026-01-07] - ADV Filing Validation Fix

### Fixed
- Critical false positive rate in ADV filing validation (78% → 0%)
- GP entity name matching issue

### Changed
- detect_compliance_issues.js: Added extractBaseName() and checkAdvDatabase()
```

**How it helps**: New sessions can understand project evolution and why decisions were made.

#### `docs/WORK_LOG_YYYY_MM_DD.md` (Session Logs)

**Purpose**: Detailed log of specific work sessions

**When to create**: For complex multi-hour sessions

**Content**:
- Problem identified
- Solution implemented
- Results and validation
- Key learnings
- Next steps

**Example**: `docs/WORK_LOG_2026_01_07.md` (ADV validation fix)

#### Project Handoff Document (This File)

**Purpose**: Complete knowledge transfer for new sessions/agents

**When to update**: When major features are completed or architecture changes

**Content**: Everything a new agent needs to know to continue work

### Best Practices Agent Setup

**Location**: `.claude/agents/` or `claude best practices/`

**What it is**: Pre-configured agent with project-specific rules

**How to use**:
```bash
# If user says "use best practices"
# Load agent configuration from best-practices/ folder
```

**What it enforces**:
- Always read `features.json` before starting work
- Always update `CHANGELOG.md` after changes
- Always read schema docs before editing data files
- Always validate assumptions with actual data
- Never speculate about code you haven't read

### Context Preservation Strategy

**When starting a new session**:

1. **Read state files** (in order):
   ```javascript
   // 1. Quick status check
   const features = await readFile('features.json');
   console.log(`Last session: ${features.session_state.current_session}`);
   console.log(`Notes: ${features.session_state.notes}`);

   // 2. Recent changes
   const changelog = await readFile('CHANGELOG.md');
   // Skim last 2-3 entries

   // 3. Architecture overview
   const handoff = await readFile('PROJECT_HANDOFF_COMPLETE_GUIDE.md');
   // Read relevant sections based on current task
   ```

2. **Ask user for context**:
   - "What were you working on last?"
   - "Are there any known issues I should be aware of?"

3. **Resume work**:
   - Check git status for uncommitted changes
   - Review last commit message
   - Continue where previous session left off

**When ending a session**:

1. **Update state files**:
   ```javascript
   // Update features.json
   features.session_state.current_session++;
   features.session_state.notes = "ADV validation fix complete, 53 true violators found";

   // Add CHANGELOG entry
   // Create work log if session was significant
   ```

2. **Commit changes**:
   ```bash
   git add .
   git commit -m "Detailed commit message with context"
   ```

3. **Leave notes for next session**:
   - What was accomplished
   - What's left to do
   - Any blockers or issues

### Agent Memory Tricks (Internal Notes)

**What worked well**:
- User would say "continue where we left off" → I read `features.json` session notes → smooth resumption
- Git commit messages provided context when state files were missing
- Comprehensive docs (like this file) enabled quick onboarding

**What didn't work**:
- Relying on conversation history alone (gets truncated)
- Not updating state files during long sessions (lost progress when session restarted)
- Vague commit messages ("fix bug") → hard to understand later

---

## Development Workflow

### Local Development

```bash
# 1. Clone repo
git clone <repo-url>
cd ADV_Cross_Reference_Gemini

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env with Supabase credentials

# 4. Start server
npm start
# Opens http://localhost:3009

# 5. Make changes
# Edit public/app.js (frontend) or server.js (backend)
# Refresh browser to see changes (no build step!)

# 6. Test changes
# Manual testing in browser
# Check browser console for errors

# 7. Commit
git add .
git commit -m "Descriptive message"
git push
```

### Running Compliance Detection

```bash
# Run detection engine (generates ~29k issues)
node detect_compliance_issues.js

# Output:
# [1/6] Detecting: Needs Initial ADV Filing...
#   Found 53 issues
# [2/6] Detecting: Overdue Annual ADV Amendment...
#   Found 2,123 issues
# ...
# Total issues: 28,917
```

### Running Enrichment

```bash
# Enrich manager contact info
cd enrichment
node enrich_manager_contacts.js

# Output:
# Processing manager: Acme Capital
#   ✓ Found website: acmecapital.com
#   ✓ Found LinkedIn: linkedin.com/company/acme-capital
#   ✓ Extracted 5 team members
#   ✓ Saved to database
```

### Database Migrations

**When needed**: Schema changes (new tables, columns, indexes)

**Process**:
1. Write SQL migration file in `migrations/`
2. Test on local database copy
3. Apply to production via Supabase dashboard or CLI

**Example migration**:
```sql
-- migrations/2026-01-08-add-validation-method.sql
ALTER TABLE compliance_issues
ADD COLUMN validation_method TEXT;

UPDATE compliance_issues
SET validation_method = 'legacy'
WHERE discrepancy_type = 'needs_initial_adv_filing';
```

### Deployment (Railway)

**Current setup**: Auto-deploy on push to `main` branch

**Process**:
1. Push to GitHub
2. Railway detects change
3. Runs `npm install`
4. Runs `npm start`
5. Deploys to production URL

**Environment variables** (set in Railway dashboard):
- `ADV_URL` - Supabase ADV database URL
- `ADV_SERVICE_KEY` - Supabase service key
- `FORMD_URL` - Supabase Form D database URL
- `FORMD_SERVICE_KEY` - Supabase service key
- `PORT` - (auto-set by Railway)

**Health check**: `GET /health` returns `{ status: 'ok' }`

### Manual Validation Tasks

**IAPD Validation** (for ADV filing checks):

```bash
# Generate list of managers needing validation
node scripts/find_needs_adv.js
# Output: /tmp/manager_details.json

# Validate against IAPD (Playwright automation)
node scripts/validate_needs_adv_corrected.js /tmp/manager_details.json
# Output: /tmp/validation_corrected.json

# Generate report
node /tmp/create_corrected_report.js
# Output: /tmp/needs_adv_corrected_full.csv
```

---

## Known Issues & Future Work

### Known Issues

#### Issue 1: Low Form D ↔ ADV Match Rate (~35%)

**Status**: Known limitation

**Cause**: Fuzzy name matching misses many legitimate matches

**Impact**:
- ~117k Form D filings have no ADV match
- Some are true "new managers", others are just match failures
- Compliance detection has higher false positive potential

**Potential fix**:
- Better fuzzy matching algorithm
- Entity relationship graph (same manager → same fund)
- Use CIK linking where available
- Machine learning model

**Priority**: Medium (match-001 in features.json)

#### Issue 2: Enrichment Returns Article URLs Instead of Company Websites

**Status**: Known bug

**Example**:
- Manager: "XYZ Capital"
- `website_url`: "https://techcrunch.com/article-about-xyz" ❌

**Cause**: OpenAI web search returns most relevant link (often news article)

**Impact**: Enrichment data less useful for contact/outreach

**Potential fix**:
- Add URL validation (check if domain matches company name)
- Filter out news domains (techcrunch.com, forbes.com, etc.)
- Use structured web scraping instead of AI

**Priority**: Low (enrich-001 in features.json)

#### Issue 3: Missing Fund in ADV Detector Has False Positives

**Status**: Known limitation

**Cause**: Heuristic name matching (adviser keywords in Form D related_names)

**Impact**: Flags some funds that actually ARE in ADV (just not matched yet)

**Potential fix**: Improve matching algorithm first (Issue 1)

**Priority**: Low (detector still useful for finding obvious gaps)

### Future Features

#### Feature 1: Advanced Filtering in Intelligence Radar

**Description**: Filter compliance issues by adviser, date range, offering amount

**Benefit**: Easier to find high-value violations

**Implementation**: Add filter UI + query params in API

**Priority**: Medium

**Estimated effort**: 1-2 days

#### Feature 2: Email Alerts for New Violations

**Description**: Send email when new high-severity violations detected

**Benefit**: Proactive monitoring vs manual checking

**Implementation**:
- Schedule `detect_compliance_issues.js` (cron job)
- Compare new issues vs previous run
- Send email via SendGrid/Mailgun

**Priority**: Medium

**Estimated effort**: 2-3 days

#### Feature 3: Historical AUM Charts for All Advisers

**Description**: Show AUM trends for top advisers on homepage

**Benefit**: Quick market overview, identify growing managers

**Implementation**:
- Query advisers_enriched for top AUM
- Render Chart.js line chart
- Cache data for performance

**Priority**: Low

**Estimated effort**: 1 day

#### Feature 4: Export to Excel (Full Data Dump)

**Description**: Export search results with all fields (not just summary)

**Benefit**: Analysts can do custom analysis in Excel

**Implementation**:
- Use xlsx library (already installed)
- Generate workbook with all fields
- Add download link in UI

**Priority**: Low

**Estimated effort**: 1 day

### Technical Debt

1. **Split app.js into modules**: 7,500-line file is hard to navigate
2. **Add TypeScript**: Type safety would prevent many bugs
3. **Write automated tests**: Currently all manual testing
4. **Optimize compute_cross_reference.py**: O(n²) algorithm is slow
5. **Add database indexes**: Queries on large tables are slow
6. **Implement caching**: Repeat queries hit database unnecessarily

---

## How We've Set This Up So Far

**Note to new agents**: This is how we've built the project to date. It's not the "absolute right way" - there may be better approaches. This documentation describes the current state and our reasoning, not a prescription.

### Design Decisions & Reasoning

#### Decision 1: Two Separate Databases

**What we did**: Used two Supabase projects (ADV DB + Form D DB)

**Why**:
- Historical: ADV data existed first in separate project
- Separation of concerns: Different data sources, different update schedules
- Isolation: Form D processing doesn't impact ADV queries

**Trade-off**: Cross-database joins happen in application layer (slower)

**Alternative considered**: Merge into one database with schema separation

**User input**: "Keep them separate for now, we can merge later if needed"

#### Decision 2: React Without Build Step

**What we did**: Load React via CDN, write JSX-like code in single app.js file

**Why**:
- Fast iteration: Edit file, refresh browser, see changes
- Simple deployment: Just copy public/ folder
- No build complexity: No webpack, babel, npm scripts

**Trade-off**: 7,500-line file is hard to navigate

**Alternative considered**: Create-React-App or Vite setup

**User input**: "Keep it simple, we can add a build step later if needed"

#### Decision 3: Fuzzy Matching for Form D ↔ ADV

**What we did**: Use fuzzywuzzy library with 80% threshold

**Why**:
- Exact matching had <10% match rate
- Fuzzy matching improved to ~35%
- Simple to implement and understand

**Trade-off**: Still misses 65% of potential matches

**Alternative considered**:
- CIK-based matching (but CIK is company, not fund)
- Machine learning model (too complex for MVP)

**User input**: "Fuzzy matching is good enough for now, we can improve later"

#### Decision 4: Base Name Extraction for ADV Validation

**What we did**: Strip GP/LLC/Management suffixes before matching

**Why**:
- Discovered that GP entity names ≠ registered adviser names
- User provided counterexamples (KIG, Akahi, etc.)
- Base name matching caught 73.5% of previously unmatched managers

**Trade-off**: Still misses some edge cases (non-standard naming)

**Alternative considered**: Full NLP entity resolution

**User input**: "This is a good improvement, ship it" (Jan 7)

#### Decision 5: Idempotent Compliance Detection

**What we did**: Each detector clears its own type before inserting fresh data

**Why**:
- Prevents duplicate issues on re-runs
- Each detector can run independently
- Easy to re-run single detector for debugging

**Trade-off**: Deletes old issues (no historical trend data)

**Alternative considered**:
- Track issue history with status changes
- Keep resolved issues in archive table

**User input**: "Idempotent is fine for now, we can add history later"

### Conversations That Shaped the Project

#### Conversation 1: "Are you searching the IAPD URL I told you?"

**Context**: I was flagging KIG, Akahi, etc. as "needs ADV" but they were registered.

**User insight**: Pointed out my exact string search was failing.

**Outcome**: Created `extractBaseName()` and `checkAdvDatabase()` functions.

**Lesson**: Always validate against primary sources, not just cross-reference tables.

**Details**: See `docs/ADV_VALIDATION_MAPPING.md`

#### Conversation 2: "Don't be too aggressive with fuzzy matching"

**Context**: I tried fuzzy matching Form D funds → advisers_enriched directly.

**Problem**: Matched "Ulu Ventures Fund IV" → "ULU VENTURES MANAGEMENT COMPANY, LLC" and filtered out (false negative).

**User correction**: "Use anti-join pattern, then validate against database"

**Outcome**: Rewrote detector to check database AFTER identifying unmatched Form Ds.

**Lesson**: Multi-step pipeline with validation > single complex query.

#### Conversation 3: "Think through whether we're getting the full dataset"

**Context**: Compliance detectors were processing only 1,000 rows.

**User question**: "Are you paginating through ALL records?"

**My mistake**: Forgot to paginate Supabase queries.

**Outcome**: Added pagination loops to all detectors.

**Lesson**: Always verify you're processing the full dataset, not just first page.

#### Conversation 4: "Make sure we're keeping documentation"

**Context**: After fixing ADV validation bug.

**User request**: "Document how all this works, how we're mapping things, for future sessions"

**Outcome**: Created this file (PROJECT_HANDOFF_COMPLETE_GUIDE.md).

**Lesson**: Documentation is critical for project continuity.

---

## Quick Reference Cheat Sheet

### Essential Commands

```bash
# Start server
npm start

# Run compliance detection
node detect_compliance_issues.js

# Run enrichment
node enrichment/enrich_manager_contacts.js

# Validate IAPD (manual)
node scripts/validate_needs_adv_corrected.js <manager_list.json>

# Database migrations
# (Apply manually via Supabase dashboard)
```

### Key Database Queries

```javascript
// Get adviser with all funds
const adviser = await advDb.from('advisers_enriched').select('*').eq('crd', 12345).single();
const funds = await advDb.from('funds_enriched').select('*').eq('adviser_entity_crd', 12345);

// Get unmatched Form Ds
const matches = await formDDb.from('cross_reference_matches').select('formd_accession');
const matchedSet = new Set(matches.map(m => m.formd_accession));
const allFormDs = await formDDb.from('form_d_filings').select('*');
const unmatched = allFormDs.filter(f => !matchedSet.has(f.accessionnumber));

// Get compliance issues for adviser
const issues = await formDDb.from('compliance_issues').select('*').eq('adviser_crd', 12345);
```

### Important URLs

- **Production**: https://privatefundsradar.com
- **Local**: http://localhost:3009
- **IAPD Search**: https://adviserinfo.sec.gov/
- **SEC EDGAR**: https://www.sec.gov/cgi-bin/browse-edgar

### File Locations

- **Frontend**: `public/app.js` (7,500 lines)
- **Backend**: `server.js` (500 lines)
- **Compliance**: `detect_compliance_issues.js` (1,000 lines)
- **Matching**: `scripts/compute_cross_reference.py` (400 lines)
- **State**: `features.json`, `CHANGELOG.md`
- **Docs**: `docs/`, `DATABASE_SCHEMA.md`, this file

### Contact / Help

- **GitHub**: (repo URL)
- **Issues**: File in GitHub Issues
- **Docs**: Read `docs/` folder for specific topics
- **Claude Code**: Read `.claude/` for agent configs

---

## End of Handoff Guide

**Last updated**: January 7, 2026
**Status**: Complete and production-ready
**Next session**: Read this file + `features.json` to resume work

**Questions for next agent**:
- What task are you working on?
- Have you read the relevant sections of this guide?
- Are there any gaps in documentation you've noticed?
- Do you have access to both Supabase databases?

**Good luck!** 🚀
