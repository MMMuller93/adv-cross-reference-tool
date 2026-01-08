# Product Backlog & Feature Requests

This document tracks feature requests, bugs, and enhancements with full context to preserve institutional knowledge across sessions.

---

## Status Legend
- **DONE** - Completed and deployed
- **IN_PROGRESS** - Currently being worked on
- **BACKLOG** - Approved, ready for development
- **IDEA** - Needs discussion/prioritization

---

## Intelligence Radar / Compliance Detection

### DONE: Fix VC Exemption Violation Detection (2026-01-06)
**Problem**: VC exemption violations were flagging managers who don't claim VC exemption (e.g., Southern Cross Investment Partners who claims 2b2 private fund exemption, not 2b1 VC exemption).

**Root Cause**: Detection code was checking `exemption_2b2` (private fund adviser, Rule 203(m)-1, under $150M) instead of `exemption_2b1` (VC exemption, Rule 203(l)-1).

**Data Format Issue**: `exemption_2b1` has mixed formats in database:
- String: `"Y"`, `"N"`
- Boolean: `true`, `false`
- `null`

This is because data comes from different sources (SEC vs state ERA data).

**Fix**: Query for both `exemption_2b1 = 'Y'` AND `exemption_2b1 = true`, dedupe by CRD.

**Files Changed**: `detect_compliance_issues.js`

---

### DONE: Fix Needs Initial ADV Filing Detector (2026-01-06)
**Problem**: Detector was returning 0 results because it tried to match Form D `cik` to non-existent `sec_file_number` column in `advisers_enriched`.

**Root Cause**: Fundamentally broken logic - CIK and SEC file numbers are different identifier systems, and the column didn't even exist.

**Original (Broken) Logic**:
```javascript
// WRONG: sec_file_number doesn't exist, and CIK ≠ file number
const { data: adviser } = await advDb
    .from('advisers_enriched')
    .select('crd, adviser_name')
    .eq('sec_file_number', filing.cik)
```

**Fix**: Use anti-join pattern against `cross_reference_matches`:
1. Get recent Form D filings (last 6 months)
2. Get all matched accessions from `cross_reference_matches`
3. Find Form D filings NOT in matches = no ADV filing exists
4. Filter to those filed >60 days ago (grace period)

**Key Insight**: `cross_reference_matches` only contains MATCHED records. Unmatched Form D filings aren't stored there, so the anti-join pattern works.

**Files Changed**: `detect_compliance_issues.js` - `detectNeedsInitialADVFiling()` function

---

### DONE: Improved Needs Initial ADV Filing Detection (2026-01-07)

**Problem**: Original detection had high false positive rate (399 issues) because:
1. Only used series LLC pattern ("a series of X") for firm name extraction
2. Simple fuzzy matching missed legitimate matches (e.g., "Ulu Ventures Fund IV" should match "ULU VENTURES MANAGEMENT COMPANY, LLC")
3. Didn't check against our advisers_enriched database effectively

**Solution**: Created `detect_needs_adv_improved.js` with:

**1. Better Firm Name Extraction:**
- Series LLC pattern: "Fund A, a series of Manager LLC" → "Manager LLC"
- Related names extraction: Find company names (LLC, LP, Management, Capital, etc.) from Form D related parties
- Entity name cleaning: Strip fund numbers, series indicators, legal suffixes

**2. Smarter Fuzzy Matching:**
- Filter out generic words (FUND, MANAGEMENT, CAPITAL, PARTNERS, etc.)
- Focus on distinctive words (e.g., "ULU" is distinctive, "VENTURES" is generic)
- Prefix matching: If first 2 words match, high confidence match
- 80%+ similarity threshold on distinctive words

**3. Company vs Person Detection:**
- Uses legal suffixes (LLC, LP, Inc) to identify companies
- Uses name patterns (First Last) to skip person names
- Filters out service providers (admin, custodian, legal, accountant)

**Results:**
- Before improvement: 399 unique managers flagged
- After improvement: 122 unique managers flagged
- Reduction of 69% false positives

**Files Created:**
- `detect_needs_adv_improved.js` - Improved detection script
- `scripts/validate_iapd_playwright.js` - Playwright-based IAPD validation (for future use)

**Future Enhancement:** Use Playwright script to validate remaining 122 candidates against SEC's live IAPD search.

---

### DONE: Fix Missing Fund in ADV Detector (2026-01-06)
**Problem**: Detector queried `cross_reference_matches` for `adv_fund_name IS NULL`, but that table only contains matched records where both sides have data.

**Root Cause**: Misunderstanding of table structure - assumed unmatched Form Ds would have NULL ADV fields, but those records simply don't exist.

**Original (Broken) Logic**:
```javascript
// WRONG: Returns 0 rows because table only has matched records
.is('adv_fund_name', null)
```

**Fix**: Use name-based heuristic to find related Form Ds:
1. Get all advisers from `cross_reference_matches` with their matched Form Ds
2. Get all Form D filings
3. For each adviser, find Form Ds that mention their name (in `related_names` or `entityname`) but aren't in matches
4. Filter by timing: Form D should have been filed before latest ADV year

**Files Changed**: `detect_compliance_issues.js` - `detectMissingFundInADV()` function

---

### DONE: Form D Links in Intelligence Radar (2026-01-06)
**Request**: All compliance issue types should link to the relevant Form D filing on EDGAR.

**Implementation**:
- VC Exemption: Shows non-VC funds (per ADV) with optional Form D link if `formd_cik` exists
- Fund Type Mismatch: Clickable fund name + Form D EDGAR link
- Missing Fund in ADV: Fund name + Form D EDGAR link
- Needs Initial ADV: Entity name + Form D EDGAR link
- Overdue Amendment: List of Form Ds filed since last ADV with EDGAR links

**Data Sources**:
- `formd_cik` in compliance_issues metadata
- EDGAR URL format: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=D&dateb=&owner=include&count=10`

**Files Changed**: `detect_compliance_issues.js`, `public/app.js`

---

### BACKLOG: Contact Info in Intelligence Radar
**Request**: Show team contacts (email, phone, website) in Intelligence Radar the same way we do for New Managers.

**Concern**: Adding contact enrichment for every compliance issue manager would significantly increase API/scraping costs given rate limits on:
- Brave Search: 2,000/month free tier
- Serper: 2,500 free credits
- Google Custom Search: 100/day

**Suggested Approach**:
1. First, check if manager already exists in `enriched_managers` table (may already be enriched)
2. If not, check `advisers_enriched` for existing contact data (cco_email, primary_website, phone_number)
3. Only trigger new enrichment if neither exists (batch overnight, not real-time)

**Alternative**: Show link to manager's enriched profile if it exists, rather than inline contacts.

**Priority**: Low - defer to roadmap

---

### BACKLOG: Differentiate ADV vs Form D Source for Violations
**Request**: For VC exemption violations, show whether the non-VC fund was identified from Form ADV, Form D, or both.

**Current State**: Already implemented in metadata:
- `source: 'form_adv'` indicates the non-VC fund type came from ADV filing
- `formd_type` in sample_non_vc_funds shows Form D fund type if available

**UI Enhancement Needed**: Add visual indicator in UI showing source (e.g., "per ADV" badge, "per Form D" badge, or "both" badge).

**Database Fields**:
- ADV fund type: `funds_enriched.fund_type`
- Form D fund type: `form_d_filings.investmentfundtype`
- Linkage: `funds_enriched.form_d_file_number` -> `form_d_filings.file_num`

---

## New Managers / Enrichment

### DONE: Fix Website Discovery (2026-01-06)
**Problem**: Renn Global Ventures website (rennglobal.com) not being found despite being first Google result.

**Root Causes**:
1. Search strategy too strict: `"Renn Global Ventures" venture capital fund` returns 0 results
2. `isValidHomepage()` rejected paths >15 chars (e.g., `/technology-ventures/`)

**Fix**:
- Start with unquoted search first (most results), then try quoted
- Accept paths <20 chars and single-level paths
- Add more VC-relevant subpaths: `/technology`, `/venture`, `/private-equity`, etc.

**Files Changed**: `enrichment/enrichment_engine_v2.js`

---

### DONE: Fix LinkedIn Team Search (2026-01-06)
**Problem**: LinkedIn search returning wrong people (e.g., "Noor Sweid - Global Ventures" matching for "Renn Global Ventures" because generic words like "global" and "ventures" matched).

**Fix**: Strict validation requiring:
1. Full fund name match, OR
2. Distinctive 2-word prefix (e.g., "renn global"), OR
3. At least 2 non-generic word matches

**Generic words filtered**: ventures, capital, partners, fund, investment, management, holdings, group, equity, global

**Files Changed**: `enrichment/enrichment_engine_v2.js` - `searchTeamLinkedIn()` function

---

### BACKLOG: LinkedIn as Discovery Fallback
**Current Flow**: Website first -> team from website -> LinkedIn search only for team names

**Requested Flow**: If website not found, use LinkedIn company page as fallback to discover:
- Company website (from LinkedIn profile)
- Team members (from LinkedIn company page employees)
- Company description

**Implementation Notes**:
- Use search `site:linkedin.com/company "${fund_name}"`
- Parse company page for website URL
- May need LinkedIn API for employee list (scraping is against ToS)

**Priority**: Medium

---

### BACKLOG: Form D Contact Lookup Fallback
**Request**: Use Form D `related_names`/`related_roles` as fallback for team member discovery when website and LinkedIn fail.

**Current State**: Already implemented as fallback in `extractRelatedPartiesFromFormD()`:
- Filters out service providers (admin, custodian, legal, accountant)
- Keeps investment team (managing member, GP, director, founder, principal)
- Skips admin umbrella platforms (their contacts are platform contacts)

**Data Fields**:
- `form_d_filings.related_names` - Pipe-separated list of names
- `form_d_filings.related_roles` - Pipe-separated list of roles

**Enhancement Needed**: Add email/phone lookup from Form D if available (currently not stored in our form_d_filings table - would need to extract from XML).

---

## Database & Data Quality

### BACKLOG: Standardize Exemption Field Format
**Problem**: `exemption_2b1` and `exemption_2b2` have mixed formats (`"Y"`/`"N"` strings vs `true`/`false` booleans).

**Root Cause**: Different data sources (SEC vs state ERA) use different formats.

**Options**:
1. Database migration to standardize all to boolean
2. Application-level normalization (current workaround)
3. View/materialized view that normalizes on query

**Priority**: Low - current workaround handles it

---

## UI/UX

### BACKLOG: Multi-Select Severity Filter
**Request**: Add severity filter (low, medium, high, critical) to Intelligence Radar.

**Implementation**: Same pattern as discrepancy type multi-select checkboxes.

---

### IDEA: Compliance Issue Detail Modal
**Request**: Clicking a compliance issue opens a detail modal with:
- Full issue context
- Manager profile (if enriched)
- All affected funds
- Historical filings timeline
- Resolution actions/notes

**Priority**: Future enhancement

---

## API / Infrastructure

### BACKLOG: Rate Limit Monitoring Dashboard
**Request**: Track API usage across search providers to avoid hitting limits.

**Providers**:
- Brave Search: 2,000/month
- Serper: 2,500 free credits (one-time?)
- Google Custom Search: 100/day (3,000/month)
- OpenAI: Usage-based

**Implementation**: Log API calls with timestamps, show dashboard in admin panel.

---

## Notes on Database Schema

### advisers_enriched (ADV database)
Key fields for compliance:
- `crd` - Unique adviser identifier
- `exemption_2b1` - VC exemption (Y/N or true/false) - Rule 203(l)-1
- `exemption_2b2` - Private fund adviser exemption (Y/N or true/false) - Rule 203(m)-1
- `type` - RIA (registered), ERA (exempt reporting adviser)
- `cco_email`, `primary_website`, `phone_number` - Contact info

### funds_enriched (ADV database)
Key fields:
- `fund_id`, `reference_id` - Identifiers
- `adviser_entity_crd` - Links to adviser
- `fund_type` - PE, VC, Hedge, Real Estate, etc.
- `exclusion_3c1`, `exclusion_3c7` - Investment Company Act exemptions
- `form_d_file_number` - Links to Form D filing

### form_d_filings (Form D database)
Key fields:
- `accessionnumber` - Unique filing identifier
- `file_num` - SEC file number (links to funds_enriched.form_d_file_number)
- `cik` - Entity identifier for EDGAR links
- `entityname` - Fund/issuer name
- `investmentfundtype` - Fund type reported to SEC
- `federalexemptions_items_list` - 3(c)(1), 3(c)(7), etc.
- `related_names`, `related_roles` - People associated with filing

### cross_reference_matches (Form D database)
Pre-computed matches between ADV funds and Form D filings:
- `adv_fund_id`, `adv_fund_name` - ADV side
- `formd_accession`, `formd_entity_name` - Form D side
- `match_score` - Confidence of match
- `overdue_adv_flag` - Pre-computed flag for overdue amendments
- `latest_adv_year` - Year of most recent ADV filing

### compliance_issues (Form D database)
Detected issues:
- `discrepancy_type` - Type of issue
- `severity` - low, medium, high, critical
- `adviser_crd`, `fund_reference_id`, `form_d_cik` - Links
- `metadata` - JSON with type-specific details

### enriched_managers (Form D database)
Contact enrichment for new managers:
- `series_master_llc` - Manager name (from parseFundName())
- `website_url`, `linkedin_company_url`, `twitter_handle`
- `primary_contact_email`
- `team_members` - JSON array
- `enrichment_status` - pending, auto_enriched, manual_review_needed, no_data_found, platform_spv

---

*Last updated: 2026-01-06*
