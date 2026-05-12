# N-PORT Operational Guardrails

This file captures the process corrections from the 2026-05-12 audit. It is
safe to share with Claude, Codex, or another local agent. It intentionally
contains no secrets.

## What Was Violated

- The work qualified as Full process under `CLAUDE.md` / `AGENTS.md`: multi-hour,
  multi-phase, data-mapping, database-write work with strict quality gates.
  Codex used tests and commits, but did not consistently run explicit
  Planner/Reviewer/Tester/Witness-style gates before each major checkpoint.
- A user-facing API fallback initially treated `REPORT_ENDING_PERIOD` as the
  latest holdings period. SEC docs and real `SUBMISSION.tsv` rows show that is
  the fund fiscal year-end; `REPORT_DATE` is the holdings snapshot date.
- The live materialized view remains unrefreshed. The base-table API fallback is
  useful for smoke checks, but it is not a substitute for refreshing and
  verifying `nport_company_positions_mv` before product integration.
- Admin mutation routes must stay protected by `NPORT_ADMIN_TOKEN`. Do not
  expose alias creation or resolution refresh endpoints with only service-key
  server config as the guard.
- ADV/Form D Supabase keys belong in environment variables
  (`ADV_SUPABASE_ANON_KEY`, `FORMD_SUPABASE_ANON_KEY`), not in tracked code.

## Required Gates From Here

1. Before data-mapping or DB-write code changes, write down the evidence:
   source schema/doc inspected, real rows queried, current code behavior, and
   the exact intended mutation.
2. Run a reviewer pass before committing any substantial N-PORT change.
3. Run a tester pass after edits. At minimum:

   ```bash
   ./.venv/bin/python -m pytest nport -q
   cd nport/api && npm test
   ```

4. Run a witness pass before saying anything is complete:

   ```bash
   nport/scripts/witness_check.sh
   ```

5. Do not claim production completion until the one-line main-app mount is
   intentionally merged, deployed, and verified on `privatefundsradar.com`.
6. Before production integration, set these env vars on the runtime:
   `SUPABASE_URL_NPORT`, `SUPABASE_SERVICE_KEY_NPORT`, `NPORT_ADMIN_TOKEN`,
   `ADV_SUPABASE_ANON_KEY`, and `FORMD_SUPABASE_ANON_KEY`.

## Current Blocker

Supabase SQL access is still needed for:

```sql
REFRESH MATERIALIZED VIEW nport_company_positions_mv;
```

The project ref is `figvonwrlcpveyceengf`; the dashboard URL is documented in
`nport/HANDOFF_LIVE.md`.

## Overnight Work Rule

Proceed autonomously only on reversible/read-only checks, local code fixes, or
already-approved idempotent ingestion. Stop before irreversible schema changes,
new table mappings, deletes, production deploys, billing/auth changes, or any
step that would expose secrets.
