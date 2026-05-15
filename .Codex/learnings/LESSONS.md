# Lessons

## project-conventions

### L-001: Use project dispatch gates for complex PFR work
- **Signal**: directive
- **Mistake**: Substantial N-PORT ETL/API work was committed before explicitly running the project’s Planner/Reviewer/Tester/Witness-style gates.
- **Root cause**: Treated passing local tests as enough despite `CLAUDE.md` classifying multi-phase/schema/data work as Full process.
- **Fix pattern**: Before the next major checkpoint, run explicit reviewer/tester/witness passes and record evidence in handoff/state.
- **Verify**: Check latest handoff/state for reviewer/tester/witness reports before saying a complex task is complete.
- **Hits**: 1

## data-handling

### L-002: Verify N-PORT date semantics before user-facing grouping
- **Signal**: evaluative
- **Mistake**: API fallback initially sorted latest holdings by `report_period_end`, which SEC bulk defines as fund fiscal year-end.
- **Root cause**: Reused schema names without re-checking SEC README and real `SUBMISSION.tsv` rows.
- **Fix pattern**: For N-PORT latest holders/timeseries, use `report_period_date` as the holdings snapshot date and preserve `report_period_end` separately.
- **Verify**: Live Anthropic smoke should show latest `period_date` no later than loaded report dates, not fiscal year-end dates like `2026-11-30`.
- **Hits**: 1

### L-003: Keep every Supabase read request at or below 1000 rows
- **Signal**: evaluative
- **Mistake**: The N-PORT API fallback initially used `.limit(5000)` even though project rules cap Supabase reads at 1000 rows.
- **Root cause**: Optimized for convenient complete fallback rows instead of applying the existing PFR pagination rule.
- **Fix pattern**: Use 1000-row pages and keyset pagination when the total fallback can exceed one page.
- **Verify**: `rg "limit\\(([^)]*5000|maxRows)\\)" nport/api/routes/nport.js` must not find uncapped Supabase reads.
- **Hits**: 1

### L-007: Never infer a series adviser from another N-CEN series
- **Signal**: evaluative
- **Mistake**: The first N-CEN adviser API fallback could answer a series-specific route with a registrant-level adviser when the exact `(CIK, series_id)` link was missing.
- **Root cause**: Treated CIK-level adviser identity as safe, but N-CEN can report multiple primary advisers across series under the same registrant.
- **Fix pattern**: For `/funds/:cik/:series_id/adviser`, require an exact series N-CEN link; for CIK-level routes, return an ambiguity note when latest N-CEN links contain multiple adviser identities.
- **Verify**: Node route tests must cover exact-series miss and multi-adviser registrants, and live BlackRock CIK `0000844779` must stay unlinked at registrant level.
- **Hits**: 1

## coding-patterns

### L-004: Protect admin mutation endpoints before local convenience
- **Signal**: evaluative
- **Mistake**: N-PORT admin alias/resolution routes were exposed with only an environment-config guard.
- **Root cause**: Treated isolated/internal routes as safe without adding an explicit admin authorization boundary.
- **Fix pattern**: Require an admin token for every `/api/nport/admin/*` route, validate mutation payloads, and test negative auth cases.
- **Verify**: `npm test` must include a 403 case for missing admin token and payload validation for mutation endpoints.
- **Hits**: 1

## project-conventions

### L-005: Do not hardcode Supabase JWTs in tracked N-PORT code
- **Signal**: evaluative
- **Mistake**: Cross-source N-PORT code copied ADV/Form D Supabase anon JWTs into a tracked file.
- **Root cause**: Followed an older local convention instead of applying the current no-secrets-in-code rule.
- **Fix pattern**: Read all Supabase JWTs/API keys from env vars and degrade gracefully when optional cross-source env is absent.
- **Verify**: `rg "eyJ|service_role" nport/api -g '!**/node_modules/**'` should not find JWT literals.
- **Hits**: 1

### L-006: Remove existing service-role literals and flag rotation
- **Signal**: evaluative
- **Mistake**: An existing upload utility carried an ADV service-role JWT in tracked code.
- **Root cause**: Older one-off scripts were not held to the same secret hygiene as runtime code.
- **Fix pattern**: Replace service-role literals with required env vars and explicitly flag key rotation if the secret was ever committed.
- **Verify**: `rg "eyJ|service_role" enrichment/upload_state_eras.js` should return no JWT literal, and handoff/memory should mention rotation.
- **Hits**: 1
