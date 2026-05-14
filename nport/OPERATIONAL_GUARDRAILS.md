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
- The live materialized view must be refreshed after ingestion batches. The
  base-table API fallback is useful for smoke checks, but it is not a substitute
  for refreshing and verifying `nport_company_positions_mv` before product
  integration.
- Admin mutation routes must stay protected by `NPORT_ADMIN_TOKEN`. Do not
  expose alias creation or resolution refresh endpoints with only service-key
  server config as the guard.
- ADV/Form D Supabase keys belong in environment variables
  (`ADV_SUPABASE_ANON_KEY`, `FORMD_SUPABASE_ANON_KEY`), not in tracked code.
- A pre-existing ADV service-role JWT was removed from
  `enrichment/upload_state_eras.js`; rotate that service-role key because
  removing the literal from HEAD does not erase git history exposure.

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

## Current State

The materialized view was refreshed on 2026-05-14:

```text
nport_company_positions_mv: 52453
Anthropic company positions source: materialized_view
```

After future bulk or daily ingestion, run:

```sql
REFRESH MATERIALIZED VIEW nport_company_positions_mv;
```

Production completion remains gated on intentionally merging the N-PORT mount,
deploying, and verifying `privatefundsradar.com`.

## Overnight Work Rule

Proceed autonomously only on reversible/read-only checks, local code fixes, or
already-approved idempotent ingestion. Stop before irreversible schema changes,
new table mappings, deletes, production deploys, billing/auth changes, or any
step that would expose secrets.
