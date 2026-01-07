# Agent Harness for ADV Cross-Reference Project

> **MANDATORY: Read this file at the START of every session. Follow these rules strictly.**
> **This is your operating manual. Violations will cause bugs and wasted time.**

---

## Quick Commands

```bash
# Dev
npm start                        # Start server on port 3009

# Test / Verify
curl http://localhost:3009/health       # Server health check
curl http://localhost:3009/api/funds/adv?search=founders&limit=5  # Quick API test

# Lint / Type check
node -c server.js                # Check syntax errors
node -c public/app.js            # Check frontend syntax

# Deploy
git push origin master           # Deploy to GitHub (production is privatefundsradar.com)
```

---

## Complexity Assessment (DO THIS FOR EVERY REQUEST)

Before implementing anything, classify the request:

### Quick Fix (No Approval Needed)
- Typos, one-line changes, simple bug fixes
- Clear, localized scope
- **Action**: Implement immediately, test, commit

### Standard Feature (Wait for Approval)
- Multi-file changes, new UI components, new endpoints
- Requires design decisions
- **Action**: Present plan with:
  - Files to modify
  - Approach summary
  - Edge cases considered
  - Rollback plan if something breaks
- **Wait for**: "go", "ship it", "approved", or "do it"

### Complex Project (Full Tracking Required)
- Multi-day work, architectural changes, cross-system modifications
- **Action**: Create/update `claude-progress.txt` with:
  - Task breakdown with checkboxes
  - Current phase
  - Blocked items
  - Test commands
- **Wait for**: Explicit approval before each major phase

---

## Core Rules (ALWAYS FOLLOW)

1. **One feature at a time** - Complete fully before starting another
2. **Smallest viable diff** - Don't refactor unrelated code
3. **Smoke test before commit** - Verify the change works end-to-end
4. **Rollback plan** - Know how to revert if something breaks
5. **Update state files** - project_state.md after every session

---

## Push Back / Escalate When

- Request is vague: Ask "What does 'done' look like?"
- Change could break production: Flag risk, propose safer alternative
- Scope creeping: "This is becoming Complex. Let me create a progress file."
- Missing context: "I need to see [X] before implementing this safely."

---

## Session Startup Protocol (EXECUTE FIRST)

Before doing ANY work, run these commands in order:

```bash
1. pwd                           # Confirm you're in the right directory
2. cat .claude/MEMORY.md         # READ FIRST: User corrections, feature goals, learnings
3. cat project_state.md          # Understand current state & DO NOT DO list
4. cat features.json             # Know what's done/remaining
5. git log --oneline -10         # See recent changes
6. git status                    # Check uncommitted work
```

**CRITICAL: Read MEMORY.md FIRST - it contains user feedback and corrections that must not be repeated.**

**ONLY AFTER completing these steps, begin work.**

---

## Architecture Quick Reference

### Two Supabase Databases
| Database | URL | Tables |
|----------|-----|--------|
| **ADV** | `ezuqwwffjgfzymqxsctq.supabase.co` | `funds_enriched` (185k), `advisers_enriched` (40k) |
| **Form D** | `ltdalxkhbbhmkimmogyq.supabase.co` | `form_d_filings` (330k), `cross_reference_matches` (63k), `compliance_issues` (29k) |

### Table ID Columns (CRITICAL for pagination)
| Table | ID Column | Has `id`? |
|-------|-----------|-----------|
| `funds_enriched` | `reference_id` | NO |
| `advisers_enriched` | `crd` | NO |
| `form_d_filings` | `id` | YES |
| `cross_reference_matches` | `id` | YES |
| `compliance_issues` | `id` | YES |

---

## CRITICAL Technical Constraints (MEMORIZE)

### Supabase Limits
| Constraint | Limit | Consequence |
|------------|-------|-------------|
| **Default row limit** | **1000 rows** | Queries return max 1000 unless paginated |
| **Insert batch size** | **500 rows** recommended | Larger batches timeout |
| **Query timeout** | **30 seconds** | Complex queries fail silently |
| **RLS with anon key** | Limited permissions | Use service role for bulk ops |

### Pagination Patterns

**FOR TABLES < 50k ROWS (OK to use range):**
```javascript
const BATCH_SIZE = 1000;  // NEVER exceed 1000
for (let offset = 0; offset < maxRecords; offset += BATCH_SIZE) {
    const { data } = await db.from('table')
        .select('*')
        .range(offset, offset + BATCH_SIZE - 1);

    if (!data?.length) break;
    // Process...
    if (data.length < BATCH_SIZE) break;  // Last page
}
```

**FOR TABLES > 50k ROWS (USE KEYSET):**
```javascript
// Keyset pagination - O(1) regardless of position
let lastId = 0;
while (true) {
    const { data } = await db
        .from('table')
        .select('*')
        .gt('id', lastId)  // Use correct ID column!
        .order('id')
        .limit(1000);

    if (!data?.length) break;
    lastId = data[data.length - 1].id;
    // Process batch...
}
```

### Batched Inserts (ALWAYS use for > 100 rows)
```javascript
const INSERT_BATCH = 500;  // NEVER exceed 500
for (let i = 0; i < items.length; i += INSERT_BATCH) {
    const batch = items.slice(i, i + INSERT_BATCH);
    const { error } = await db.from('table').insert(batch);
    if (error) throw error;  // Don't swallow errors!
}
```

---

## DO NOT DO (Project-Specific Violations)

### Data & Queries
1. **DO NOT use batchSize > 1000** for Supabase reads
2. **DO NOT insert > 500 rows at once** (timeout risk)
3. **DO NOT use OFFSET pagination for tables > 50k rows**
4. **DO NOT assume columns exist** - verify schema first:
   ```bash
   curl -s "$URL/rest/v1/TABLE?limit=1&select=*" -H "apikey: $KEY"
   ```
5. **DO NOT conflate different data sources** - Form D amounts ≠ ADV amounts
6. **DO NOT fetch all rows for counts** - use `{ count: 'exact', head: true }`

### Data Mapping (CRITICAL)
7. **DO NOT edit schema/mapping files without full investigation**
   - Read schema docs first
   - Query actual data to verify assumptions
   - Get user approval before changes
8. **DO NOT assume what fields mean** - verify against SEC documentation

### UI/UX
9. **DO NOT make styling decisions without asking**
10. **DO NOT add/remove features without explicit request**
11. **DO NOT use semi-transparent backgrounds for loading overlays**

### Process
12. **DO NOT skip git commits after completing features**
13. **DO NOT claim data doesn't exist without querying database**
14. **DO NOT mark features done without end-to-end testing**
15. **DO NOT speculate about bugs** - investigate with actual data first

---

## Pre-Flight Checklist (Before ANY Code Change)

### For Database Queries
- [ ] Verified table schema exists (queried actual data)
- [ ] Checked row count - need pagination if > 1000?
- [ ] Using batch size ≤ 1000 for reads
- [ ] Using batch size ≤ 500 for inserts
- [ ] Using correct ID column for keyset pagination
- [ ] Handling errors and empty results

### For New Features
- [ ] Read existing code patterns first
- [ ] Considered edge cases (empty data, nulls, errors)
- [ ] Designed for scale (what if 10x data?)
- [ ] Added to features.json tracking

### For Bug Fixes
- [ ] Reproduced the bug first
- [ ] Identified root cause (not just symptoms)
- [ ] Verified fix doesn't break other things
- [ ] Added to DO NOT DO if it's a pattern to avoid

---

## Incremental Progress Pattern

### The Golden Rule
**Work on ONE feature at a time. Complete it fully before starting another.**

### Workflow
1. Select highest-priority incomplete feature from features.json
2. Understand what success looks like (acceptance criteria)
3. Implement the feature completely
4. Test end-to-end (not just the function - the whole flow)
5. Only mark as passing after verification
6. Git commit with descriptive message
7. Update project_state.md
8. Then move to next feature

### Quality Gates Before "Done"
1. **Happy path works?** Test with normal data
2. **Edge cases handled?** Empty arrays, nulls, errors
3. **Scales properly?** What happens with 10x, 100x data?
4. **End-to-end tested?** Full user flow, not just unit
5. **Consistent with codebase?** Matches existing patterns

---

## Common Patterns in This Codebase

### Cross-Database Lookups
```javascript
// Query Form D DB, then enrich from ADV DB
const formDData = await formDDb.from('table').select('*');
const crdList = formDData.map(d => d.adviser_crd).filter(Boolean);
const advData = await advDb.from('advisers_enriched').select('*').in('crd', crdList);
const advMap = new Map(advData.map(a => [a.crd, a]));
// Merge using map...
```

### Name Matching
The `normalize_name_for_match()` function:
1. Uppercase
2. Remove punctuation (commas, periods, quotes, parens, hyphens, slashes)
3. Collapse whitespace
4. Strip entity suffixes (LLC, LP, INC, LTD, CO, CORP, etc.)

Example: `"Tiger Fund, L.P."` → `"TIGER FUND"`

---

## Key Files Reference

| File | Purpose | Read Frequency |
|------|---------|----------------|
| `CLAUDE.md` | This file - agent harness | Every session start |
| `.claude/MEMORY.md` | **User feedback, corrections, learnings** | **Every session start (READ FIRST)** |
| `.claude/agents/*.md` | Specialized agent instructions | When doing related work |
| `project_state.md` | Current state, session log, DO NOT DO | Every session start |
| `features.json` | Feature tracking | When working on features |
| `server.js` | Main API server | When modifying API |
| `public/app.js` | Frontend React app | When modifying UI |
| `detect_compliance_issues.js` | Compliance detection | When modifying detection |

---

## Session End Protocol

Before ending ANY session:
- [ ] No half-implemented features
- [ ] All changes committed with descriptive messages
- [ ] **MEMORY.md updated with any new:**
  - User corrections (add to "DO NOT REPEAT" section)
  - Feature requirements or goals explained
  - Improvement ideas shared
  - Learnings about data, enrichment, or bugs
  - User preferences expressed
- [ ] project_state.md updated with:
  - What was completed
  - What remains
  - Any blockers or issues discovered
  - Context for next session
- [ ] features.json status updated if features completed

## Memory Update Protocol (DURING SESSION)

**When user gives correction or feedback, IMMEDIATELY update MEMORY.md:**

1. User says "don't do X" → Add to "DO NOT REPEAT THESE MISTAKES" section
2. User explains how feature should work → Add to "Feature Requirements & Goals"
3. User shares improvement idea → Add to relevant section
4. User expresses frustration about repeated issue → Add prominently to corrections
5. You discover a bug or data issue → Add to "Known Bugs" or "Known Issues"

**Don't wait until session end** - capture feedback as it happens so it's not lost.

---

## Production Verification Protocol (MANDATORY)

**CRITICAL: Never say "done" without verifying production.**

### After ANY Code Change That Affects Production:

```bash
# 1. Commit and push
git add . && git commit -m "descriptive message" && git push

# 2. Wait for deployment (Railway auto-deploys from master)
# Check: https://github.com/MMMuller93/adv-cross-reference-tool/actions

# 3. Verify production is serving new code
curl -s "https://privatefundsradar.com/api/health" # or equivalent endpoint

# 4. Test the actual feature on the live site
# - Open browser to privatefundsradar.com
# - Navigate to affected feature
# - Verify it works as expected
```

### Verification Checklist

Before marking ANY production-affecting change as complete:
- [ ] Code pushed to GitHub (not just committed locally)
- [ ] Deployment completed (check GitHub Actions or Railway dashboard)
- [ ] Live site tested in browser (not just localhost)
- [ ] Feature works end-to-end on production
- [ ] If API change: curl production endpoint to verify response

### Red Flags - STOP and Verify

If you're about to say any of these, STOP and verify first:
- "The fix is deployed" → Did you actually check the live site?
- "This should now work" → Did you test on production?
- "I've pushed the changes" → Did deployment succeed?

### Production URLs

| Environment | URL |
|-------------|-----|
| Production | https://privatefundsradar.com |
| GitHub | https://github.com/MMMuller93/adv-cross-reference-tool |
| Railway | Check Railway dashboard for deployment status |

---

## Emergency Recovery

### If You Break Something
```bash
git status              # See what changed
git diff                # See the changes
git checkout -- FILE    # Revert specific file
git stash               # Save changes temporarily
```

### If Server Won't Start
```bash
node -c server.js       # Check syntax errors
lsof -i :3009           # Check port in use
pkill -f "node server"  # Kill existing process
```

---

## When in Doubt

1. **Query the actual data** before making assumptions
2. **Read existing code** before writing new code
3. **Ask the user** if requirements are unclear
4. **Test end-to-end** before marking done
5. **Check this file** for patterns and constraints

---

*Based on Anthropic's best practices for long-running agents.*
*Last updated: 2026-01-06*

---

## Project-Specific Knowledge (PRESERVE THIS SECTION)

### Database Nomenclature - CRITICAL DISTINCTION

The project has **TWO different enrichment concepts** - don't conflate them:

| Term | Database | Table | Description |
|------|----------|-------|-------------|
| **Adviser Enrichment** | ADV (ezuqww...) | `advisers_enriched` | 40k registered investment advisers from Form ADV |
| **Fund Enrichment** | ADV (ezuqww...) | `funds_enriched` | 185k private funds from Form ADV Schedule D |
| **Manager Enrichment** | Form D (ltdalx...) | `enriched_managers` | ~4k NEW managers discovered from Form D "a series of X LLC" pattern |

**The "a series of X LLC" Pattern:**
When a Form D filing has an entity name like "Fund ABC, a series of Master Manager LLC", we extract "Master Manager LLC" as the `series_master_llc`. This identifies the managing entity behind multiple SPV funds. This is stored in `enriched_managers` table and represents NEW managers not necessarily in Form ADV.

### Form D Data Limitations

**Related Parties Field:**
- Form D `related_names` and `related_roles` fields are often limited
- Sometimes contains only fund administrators (not the actual investment team)
- Should NOT be trusted as the primary source for team members
- Use as a **fallback/cross-reference** when website extraction fails

**Key Form D Fields:**
```
entityname          - Fund name (may contain "a series of X" pattern)
series_master_llc   - Extracted master manager name
related_names       - Pipe-separated list of related party names
related_roles       - Pipe-separated list of their roles
filing_date         - When filed with SEC
totalofferingamount - Offering size (can be null for indefinite)
```

### Enrichment Architecture

**enrichment_engine_v2.js** processes managers through:
1. **Form ADV lookup** - Check if manager exists in advisers_enriched
2. **Web search** - Brave (2000/mo) > Google (100/day) > Serper (often quota issues)
3. **Website extraction** - Find website, validate with AI, extract team/contact
4. **LinkedIn extraction** - From website HTML (no API needed), then search as fallback
5. **Twitter search** - Site-specific search (often finds wrong accounts)
6. **AI classification** - Fund type and investment stage

**Current Gaps (User Requested Fixes):**
- Team extraction only works when website has clear /team page
- LinkedIn personal profiles can't be scraped directly (blocked)
- Form D related_parties not being used as fallback
- Twitter validation is weak (finds unrelated accounts)

### API Quotas & Priorities

| API | Quota | Priority | Notes |
|-----|-------|----------|-------|
| Brave Search | 2000/month | 1st | Best free tier |
| Google CSE | 100/day | 2nd | Limited but reliable |
| Serper | Often exhausted | 3rd | Auto-disabled after 3 failures |
| OpenAI (gpt-4o-mini) | Pay-per-use | Always | For validation/extraction |

### File Locations

**Enrichment Scripts:**
- `/enrichment/enrichment_engine_v2.js` - Main enrichment logic
- `/enrichment/enrich_recent.js` - Process recent managers
- `/enrichment/reenrich_linkedin.js` - Re-enrich for missing LinkedIn
- `/enrichment/cleanup_bad_urls.js` - Remove PDF/document URLs

**Daily Scraper:**
- `/Users/Miles/Desktop/FormD_Project/active/daily_scraper_with_alerts.py` - Python scraper with email alerts

**Frontend:**
- `server.js` - API server (production at privatefundsradar.com)
- `public/app.js` - React frontend

### User Preferences Learned

1. **Don't ignore requests** - User has asked multiple times about team member extraction, LinkedIn as fallback, cross-referencing related_parties
2. **Preserve knowledge** - User explicitly requested documenting learnings so future Claude sessions don't need re-explanation
3. **Smart enrichment** - Current approach is "dumb and bad" per user - needs smarter LinkedIn search and fallbacks
4. **Deploy regularly** - Changes don't show on privatefundsradar.com until deployed

### Compliance Issues Detection

The `compliance_issues` table tracks discrepancies between Form ADV and Form D:
- **VC Exemption Violation** - Non-VC fund using VC exemption (3c1 only)
- **Overdue Amendment** - Form D filed but no recent ADV amendment
- **Fund Type Mismatch** - Stated fund type doesn't match characteristics
- **Missing Fund in ADV** - Form D exists but fund not in ADV Schedule D

User requested improvements to show **specific funds** causing each violation, not just adviser-level flags.

### Cross-Reference Matching

`cross_reference_matches` table links Form ADV funds to Form D filings:
- `adv_fund_id` → references `funds_enriched`
- `formd_accession` → references `form_d_filings`
- `match_score` (0-1) indicates confidence
- ~63k matches exist

### Deployment Notes

The app runs at **privatefundsradar.com** - changes to server.js or public/app.js require deployment to take effect. Local testing can use `node server.js` on port 3009.
