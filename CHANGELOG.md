# Changelog - Private Funds Radar

## [2026-01-07] - ADV Filing Validation Fix

### Fixed
- **Critical**: Fixed false positive rate in ADV filing validation (reduced from 78% to 0%)
  - GP entity names in Form D (e.g., "KIG GP, LLC") now properly match registered adviser names (e.g., "KIG INVESTMENT MANAGEMENT, LLC")
  - Added `extractBaseName()` function to strip entity suffixes for matching
  - Added `checkAdvDatabase()` function to validate managers against `advisers_enriched` database
  - Updated `detectNeedsInitialADVFiling()` to validate each manager before flagging

### Changed
- `detect_compliance_issues.js`: Integrated corrected validation logic with base name extraction
- Previously flagged managers (KIG, Akahi, HighVista, Canyon, Millstreet, etc.) are now correctly identified as registered

### Added
- `docs/ADV_VALIDATION_MAPPING.md`: Comprehensive documentation of mapping methodology
- `scripts/validate_needs_adv_corrected.js`: Corrected IAPD validator with two-step validation
- `scripts/find_needs_adv.js`: Manager entity extraction from Form D filings

### Validation Results
- Validated top 200 managers by offering amount
- **147 registered (73.5%)** - Found in database or IAPD
- **53 NOT registered (26.5%)** - True violators needing ADV filing
- **$6.30B** in total offerings from violators
- **198 fund filings** affected

### Technical Details
- Database: `advisers_enriched` table (39,815 registered advisers)
- Matching: Base name extraction + fuzzy ILIKE search
- Fallback: First word matching for edge cases
- Manual validation: Playwright-based IAPD search for confirmation

---

## Previous Entries

[Add earlier changelog entries here as needed]
