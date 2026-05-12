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
