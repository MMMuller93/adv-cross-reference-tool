# Form D / ADV Matching Investigation Summary

**Date:** January 5, 2026
**Investigators:** Claude (AI Assistant) + User

---

## Issues Investigated

### 1. ✅ Founders Fund (CRD 155462) - RESOLVED

**Reported Issue:**
73 funds showing with Don Quixote character names: GRISOSTOMO, ROQUE GUINART, SANCHO PANZA, DOROTEA, ALTISIDORA, etc.

**User Question:**
"Why are these getting tagged to Founders Fund?"

**Finding: NO BUG**
These are **legitimate** Founders Fund funds according to SEC Form ADV filings.

**Evidence:**
- SEC FilingID 675331 (Oct 25, 2012) contains 17 Don Quixote-themed funds, all filed by FOUNDERS FUND LLC (CRD 155462)
- GRISOSTOMO (ReferenceID 35306) appears in 5 separate Founders Fund filings:
  - FilingID 628399, 675331, 717886, 804650, 835567
  - ALL list FOUNDERS FUND LLC as the adviser
- Literary-themed naming convention is unusual but legal
- Database correctly attributes all funds to Founders Fund

**Documented:**
`BUG_INVESTIGATION_FINDINGS_2026-01-05.md`
`SESSION_NOTES_2026-01-05.md`

**Status:** ✅ Confirmed correct, no action needed

---

### 2. ⏳ DataPower Ventures (CRD 334379) - NEEDS INVESTIGATION

**Database Record:**
```json
{
  "crd": "334379",
  "adviser_name": "DATAPOWER VENTURES ADVISORS LLC"
}
```

**Status:** ✅ Found in database

**Next Steps:**
1. Get specific issue details from user
2. Check Form D filings for this CRD
3. Compare Form D vs Form ADV fund lists
4. Investigate any discrepancies

**Potential Questions:**
- Are funds missing from ADV that appear in Form D?
- Are there fund name mismatches?
- Is there a fund type discrepancy?

---

### 3. ⏳ Riverside Ventures - NEEDS CLARIFICATION

**Database Records Found:**
```json
[
  { "crd": "323300", "adviser_name": "RIVERSIDE MANAGEMENT LLC" },
  { "crd": "331721", "adviser_name": "RIVERSIDE BLOCKCHAIN, LLC" },
  { "crd": "160523", "adviser_name": "RIVERSIDE PARTNERS, LLC" },
  { "crd": "160754", "adviser_name": "RIVERSIDE PARTNERS, LLC" },
  { "crd": "156339", "adviser_name": "RIVERSIDE ADVISORS, LLC" },
  { "crd": "150759", "adviser_name": "RIVERSIDE PORTFOLIO MANAGEMENT, LLC" }
]
```

**Observations:**
- Multiple "Riverside" entities exist
- **Potential duplicate:** CRD 160523 and 160754 both show "RIVERSIDE PARTNERS, LLC"

**Next Steps:**
1. Clarify which "Riverside" entity the issue applies to
2. Investigate duplicate CRDs for RIVERSIDE PARTNERS, LLC
   - Are they the same entity registered twice?
   - Are they different entities with the same name?
   - Check SEC registration history
3. Get specific discrepancy details from user

---

## Matching System Overview

### Current Approach

**1. Direct CIK Match (~2% coverage)**
- Match Form D `cik` to ADV `sec_file_number` or `cik`
- High accuracy but very sparse (only ~2,854 funds have CIK)

**2. Cross-Reference Table (~28% coverage)**
- Pre-computed fuzzy matches in `cross_reference_matches` table
- Normalized fund names (Roman numerals → Arabic, punctuation removed)
- Match scores indicate confidence

**3. Real-Time Enrichment (Server-side)**
- Server extracts adviser names from Form D `related_names` field
- Batch lookup in `advisers_enriched` table
- Filters out filing agents (Sydecr, AngelList)
- Attaches CRD and adviser details

### Known Limitations

**Low CIK Coverage:**
- Only 2% of funds have CIK linkage
- Most funds rely on fuzzy name matching

**Cross-Reference Gaps:**
- 28% coverage means 72% of funds have no pre-computed match
- Need to improve matching algorithm

**Name Variations:**
- "RIVERSIDE PARTNERS" vs "RIVERSIDE PARTNERS, LLC"
- Fund series with Roman numerals (I, II, III vs 1, 2, 3)
- Special characters and punctuation differences

---

## Discrepancy Types Detected

### Currently Working:
✅ **VC Exemption Violation** (740 issues found)
- Managers claiming VC exemption but managing non-VC funds

### Needs Column Additions:
❌ **Needs Initial ADV Filing**
- Requires: `cik` or `sec_file_number` in advisers_enriched

❌ **Overdue Annual Amendment**
- Requires: `latest_filing_date` column

❌ **Fund Type Mismatch**
- Requires: Fund type columns in cross_reference_matches

❌ **Missing Fund in ADV**
- Requires: adviser_crd in cross_reference_matches

❌ **Exemption Mismatch**
- Requires: Complex fuzzy matching logic

---

## Recommended Improvements

### 1. Enhance CIK Coverage
- Backfill missing CIKs from Form D filings
- Use Edgar API to lookup CIKs by entity name
- Add CIK to advisers_enriched table

### 2. Improve Name Matching
- Add phonetic matching (Soundex, Metaphone)
- Detect and normalize common abbreviations (LLC, LP, Ltd, Inc)
- Handle series names better (Roman numeral conversion)

### 3. Add Missing Columns
- `advisers_enriched.sec_file_number` or `cik`
- `advisers_enriched.latest_filing_date`
- `cross_reference_matches.adviser_crd`
- `cross_reference_matches.adv_fund_type`
- `cross_reference_matches.formd_fund_type`

### 4. Investigate Duplicate CRDs
- Check RIVERSIDE PARTNERS, LLC (160523 vs 160754)
- Verify if other duplicates exist
- Determine correct deduplication strategy

---

## Action Items

### Immediate
1. ✅ Document Founders Fund findings (DONE)
2. ⏳ Get DataPower Ventures issue details from user
3. ⏳ Get Riverside Ventures issue details from user
4. ⏳ Investigate RIVERSIDE PARTNERS duplicate CRDs

### Short-term
1. Add missing columns to enable all discrepancy detectors
2. Backfill CIK data where possible
3. Enhance name matching algorithm

### Long-term
1. Build comprehensive Form D ↔ ADV reconciliation system
2. Add automated monitoring for new discrepancies
3. Create compliance reporting dashboard

---

**Last Updated:** 2026-01-05 18:35 UTC
**Status:** Awaiting user clarification on DataPower and Riverside issues
