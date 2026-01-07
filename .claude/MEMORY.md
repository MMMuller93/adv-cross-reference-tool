# Project Memory - Private Funds Radar

> **Purpose**: Persistent storage for user feedback, corrections, feature requirements, and learnings.
> **Rule**: Claude MUST read this file at session start and update it when receiving new guidance.

---

## User Corrections (DO NOT REPEAT THESE MISTAKES)

### Production Verification
- **NEVER say "done" without verifying on production** - User caught me claiming fixes were complete when they weren't deployed
- Always check: code pushed → deployment complete → live site tested → feature works end-to-end
- Production domain: `privatefundsradar.com` (currently not resolving - needs investigation)

### Data & Schema
- `cross_reference_matches` only contains MATCHED records - querying for NULL values returns 0
- `sec_file_number` column DOES NOT EXIST in advisers_enriched - don't query it
- CIK ≠ CRD ≠ SEC file number - these are different identifier systems
- exemption_2b1/2b2 have MIXED formats: can be 'Y', 'N', true, false, or null - must query both
- ReferenceID = PFID (Private Fund ID), NOT adviser CRD - don't confuse them
- FilingID groups all funds from one adviser's filing

### Code Quality
- Don't truncate prompts to LLMs - quality degrades
- Don't use cheap models (Haiku) for complex tasks
- Pagination: Use keyset (`.gt('id', lastId)`) not OFFSET for large tables (>50k rows)
- Supabase batch limits: 1000 for reads, 500 for inserts

### Process Failures (User Frustration Points)
- **Context Loss**: User has repeatedly given info that gets forgotten - CAPTURE EVERYTHING IN THIS FILE
- **Repeated Explanations**: User said "i constantly give you a ton of good info and feedback, you remember it for like 4 min, and then it disappears"
- **Not Updating State**: Failed to update project_state.md during sessions - DO IT IMMEDIATELY
- **NOT USING AGENTS**: We created specialized agents (Mayor, Data Architect, Compliance, Enrichment, Witness) - USE THEM!
  - Schema issues → Call Data Architect agent
  - Production verification → Call Witness agent
  - Enrichment problems → Call Enrichment agent
  - Compliance detection → Call Compliance agent
  - Multi-concern orchestration → Call Mayor agent
  - **Don't manually inspect when an agent exists for the domain**

---

## Feature Requirements & Goals

### Intelligence Radar (Compliance Detection)
- **Goal**: Surface compliance issues advisers should know about
- **6 detector types** (all working as of 2026-01-06):
  1. `needs_initial_adv_filing` - Form D filed >60 days ago, no ADV match (777 issues)
  2. `overdue_annual_amendment` - Form D activity but ADV not updated (2,123 issues)
  3. `vc_exemption_violation` - Claims VC exemption but has non-VC funds (25 issues)
  4. `fund_type_mismatch` - Form D and ADV fund types don't match (16,154 issues)
  5. `missing_fund_in_adv` - Form D not reflected in ADV Schedule D (407 issues)
  6. `exemption_mismatch` - 3(c)(1) vs 3(c)(7) differences (9,900 issues)
- Results should link back to source data (Form D EDGAR links, ADV IAPD links)
- **Database**: 149,979 compliance issues in `compliance_issues` table

### New Managers Tab
- Shows recently filed Form D managers not yet in ADV
- Should help users discover emerging managers before they're widely known
- Uses "a series of X LLC" pattern to extract master manager names

### Enrichment System
- **Goal**: Add contact info, websites, LinkedIn to managers for outreach
- **Database**: 3,379 enriched managers in `enriched_managers` table
- API quotas: Brave 2000/month, Google 100/day, Serper often exhausted
- Skip patterns:
  - AngelList profiles (require login)
  - Sydecr profiles (no useful contact data - they're a platform, not managers)
  - Fund admin umbrella platforms (their contacts are platform contacts, not fund contacts)
- Fallback: Extract team from Form D `related_names`/`related_roles` when web search fails
- **Current Issues**:
  - Team extraction only works when website has clear /team page
  - LinkedIn personal profiles can't be scraped directly (blocked)
  - Twitter validation is weak (finds unrelated accounts)

### Cross-Reference Matching
- **Database**: 63,096 matches in `cross_reference_matches` table
- Links ADV funds to Form D filings
- Uses file_num matching first (100% accurate), then normalized name matching (fallback)
- Only stores successful matches - use anti-join pattern to find unmatched Form Ds
- `compute_cross_reference.py` runs weekly via GitHub Actions

---

## Data Display Preferences

- All data values should have consistent black text styling (not colored)
- "Indefinite" offering amounts should display same as other values (not orange)
- Don't make UI styling decisions without asking first

---

## Feature Status & Known Issues

### Working (Verified in Database)
- Compliance detection: 6 types, 149,979 total issues
- Cross-reference matching: 63,096 matches
- Manager enrichment: 3,379 managers processed
- Form D search: Works for any query length (5-char minimum removed)
- Form D adviser enrichment: Real-time matching via related_names parsing

### Needs Work / Investigation
- **Production site** (`privatefundsradar.com`) not resolving - DNS/deployment issue?
- LinkedIn as discovery fallback (when website not found, use LinkedIn company page)
- Contact info in Intelligence Radar (show team contacts like New Managers does)
- Multi-select severity filter for Intelligence Radar
- Stripe billing integration ($99/month)

### Known Bugs
- Server occasionally crashes/hangs (no PM2 auto-restart configured)
- Incomplete cross-reference matches (~28% coverage - need better algorithm)

---

## Recent Fixes (Dec 2025 - Jan 2026)

### Intelligence Radar Fixes
1. **Fix entity_name display** (0a2a335) - Entity names now show in UI from metadata
2. **Fix broken compliance detectors** (de26d0c) - needs_initial_adv_filing and missing_fund_in_adv were returning 0
3. **Fix VC exemption detection** (890a389) - Was checking wrong exemption field (2b2 instead of 2b1)
4. **Multi-select filter** (15d74b5) - Can now filter by multiple discrepancy types
5. **Enhanced compliance with fund links** (65aef64) - Clickable links to specific funds

### Enrichment Fixes
1. **Website discovery** (8ba5c2b) - Fixed for companies like Renn Global Ventures
2. **LinkedIn validation** (8ba5c2b) - Stricter matching to avoid wrong people
3. **Team member extraction** (913ff51) - Better accuracy, stricter validation
4. **Skip fund admin platforms** (c6c81bd) - Don't use platform contacts as fund contacts
5. **LinkedIn team search fallback** (64f7c48) - Form D related parties cross-reference
6. **URL validation** (9690cfb) - Prevent bad URLs (PDFs, documents)

### UI/UX Fixes
1. **Blank adviser page** (fb7b9bb) - Fixed navigation and error handling
2. **Twitter/email display** (71971fc) - Added to API and UI
3. **Adviser page loading** (c42f0c5) - Fixed loading states

### Data/Schema Fixes
1. **Correct column names** (1f11ce5) - Adviser lookup in discrepancies API
2. **Save to correct database** (dde936a) - Compliance issues go to Form D DB, not ADV
3. **Form D cross-reference** (810e85a) - Removed non-existent columns

---

## Enrichment Learnings

### What Works
- Brave Search for finding company websites (best free tier)
- Google Search as backup (100/day limit)
- LinkedIn company page detection from website HTML
- Form D `related_names` as fallback for team members
- `parseFundName()` to extract "Series Master LLC" from entity names

### What Doesn't Work
- AngelList profiles (require authentication)
- Sydecr profiles (no useful contact data - platform, not manager)
- Generic social media profiles without company context
- LinkedIn personal profile scraping (blocked)
- Twitter search (often finds wrong accounts)
- Short search queries (too broad, wrong results)

### Improvement Ideas (From User)
- Use LinkedIn company page as primary discovery when website not found
- Cross-reference Form D related_parties more aggressively
- Add email/phone extraction from Form D XML (currently not stored)
- Smarter LinkedIn search with better validation

---

## Architecture Reference

### Two Supabase Databases
| Database | URL | Key Tables |
|----------|-----|------------|
| ADV | `ezuqwwffjgfzymqxsctq.supabase.co` | advisers_enriched (40k), funds_enriched (185k) |
| Form D | `ltdalxkhbbhmkimmogyq.supabase.co` | form_d_filings (330k), cross_reference_matches (63k), compliance_issues (150k), enriched_managers (3.4k) |

### Key Files
- `server.js` - Main API server
- `public/app.js` - React frontend
- `detect_compliance_issues.js` - Compliance detection (6 detectors)
- `enrichment/enrichment_engine_v2.js` - Manager enrichment pipeline
- `scripts/compute_cross_reference.py` - ADV ↔ Form D matching

### GitHub Repo
- https://github.com/MMMuller93/adv-cross-reference-tool

---

## Session History (Recent)

### Session - 2026-01-07
- **Work Done**:
  - Created Gastown agent architecture (Mayor, Compliance, Enrichment, Witness, Data Architect)
  - Created MEMORY.md persistent memory system
  - Updated CLAUDE.md with memory protocol
  - Comprehensive audit of recent fixes and database state
- **Key Decisions**:
  - Agents stored in `.claude/agents/`
  - Full schema embedded in data-architect.md
  - MEMORY.md must be read FIRST at session start
  - Update MEMORY.md IMMEDIATELY when user gives feedback (not at session end)
- **User Feedback**: "i constantly give you a ton of good info and feedback, you remember it for like 4 min, and then it disappears"
- **Database Stats**:
  - Compliance Issues: 149,979
  - Cross-Reference Matches: 63,096
  - Enriched Managers: 3,379
- **Production Issue**: privatefundsradar.com not resolving - needs investigation

### Session - 2026-01-06 (Late Evening)
- Fixed broken compliance detectors (needs_initial_adv_filing, missing_fund_in_adv)
- Created DATABASE_SCHEMA.md
- Detection results: 29,386 total issues

### Session - 2026-01-06 (Earlier)
- Enhanced compliance detection with actionable fund links
- Fixed blank adviser page
- Added multi-select filter for discrepancy types

---

## How to Use This File

### At Session Start
1. Read this ENTIRE file FIRST
2. Check "DO NOT REPEAT" section for corrections
3. Review "Feature Status & Known Issues"
4. Note any pending user feedback to address

### During Session (IMMEDIATELY when user gives feedback)
1. User says "don't do X" → Add to "DO NOT REPEAT THESE MISTAKES"
2. User explains how feature should work → Add to "Feature Requirements & Goals"
3. User shares improvement idea → Add to "Enrichment Learnings" or relevant section
4. User expresses frustration → Add prominently with context
5. Bug discovered → Add to "Known Bugs"

### At Session End
- Update "Session History" with what was done
- Add any new learnings
- Note pending items for next session

---

## User Communication Preferences

- Prefers direct, concise responses
- Wants verification before claiming "done"
- Values context retention across sessions
- **Gets frustrated when same explanations need repeating** - CAPTURE EVERYTHING
- Wants to see actual data/evidence, not speculation

---

*Last Updated: 2026-01-07*
