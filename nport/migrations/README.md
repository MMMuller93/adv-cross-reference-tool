# N-PORT Migrations

Schema for the dedicated **N-PORT private-company holdings** Supabase project.
This is a **third** Supabase project, separate from the existing ADV
(`ezuqwwffjgfzymqxsctq`) and Form D (`ltdalxkhbbhmkimmogyq`) projects.

Cross-DB joins (ADV ↔ Form D ↔ N-PORT) happen in the Node API server.
No foreign-data wrappers, no cross-project FKs.

Spec: `PLAN_NPORT_HOLDINGS.md` §4.

---

## Files

| File | Purpose |
|---|---|
| `001_create_schema.sql` | All 11 tables, indices, and the `nport_company_positions_mv` materialized view |
| `002_seed_sanctioned.sql` | Seed rows for `sanctioned_securities` (30 OFAC-sanctioned Russian patterns) |

---

## Target Versions

- **Postgres**: 15+ (uses `gen_random_uuid()` via `pgcrypto`, partial indices, `tsvector` GIN, materialized views)
- **Supabase**: any current version — Supabase as of 2026 ships Postgres 15.

**Verified** against a fresh Postgres 17.9 instance (Homebrew) — `001_create_schema.sql`
ran clean, produced **11 tables**, **1 materialized view**, **26 `ix_*` indices**.
`002_seed_sanctioned.sql` inserted **30 rows**. A smoke test exercising every
foreign-key constraint, the `ON DELETE CASCADE` on `private_company_aliases`,
and `REFRESH MATERIALIZED VIEW nport_company_positions_mv` all passed.

Compatible with the Supabase SQL editor (paste the file contents into a new
query and run).

---

## Setup — One-time

### 1. Create the Supabase project

In the Supabase dashboard (https://app.supabase.com):

1. **New project** → name it `nport` (or `pfr-nport`).
2. Pick a region close to your other PFR projects.
3. Wait for provisioning (~2 min).
4. Capture the project URL and the **service-role** key (not the anon key — bulk
   ingestion needs RLS-bypassing service role).

### 2. Set environment variables

Add to your `.env` (locally) and Railway production env:

```bash
SUPABASE_URL_NPORT=https://<your-nport-project-ref>.supabase.co
SUPABASE_SERVICE_KEY_NPORT=eyJhbGciOi...   # service_role key
SUPABASE_ANON_KEY_NPORT=eyJhbGciOi...      # anon key (for public reads from frontend)
```

Naming convention matches the existing ADV / Form D pattern:

| Project | URL var | Service key var |
|---|---|---|
| ADV | `SUPABASE_URL_ADV` | `SUPABASE_SERVICE_KEY_ADV` |
| Form D | `SUPABASE_URL_FORMD` | `SUPABASE_SERVICE_KEY_FORMD` |
| **N-PORT** | **`SUPABASE_URL_NPORT`** | **`SUPABASE_SERVICE_KEY_NPORT`** |

### 3. Run the migrations

**Option A — psql (preferred, faster):**

Get the connection string from Supabase dashboard → Project Settings → Database
→ Connection string (URI mode, use the pooler URL for migrations to avoid
timeouts on large operations).

```bash
export DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres'

psql "$DATABASE_URL" -f migrations/nport/001_create_schema.sql
psql "$DATABASE_URL" -f migrations/nport/002_seed_sanctioned.sql
```

**Option B — Supabase SQL editor:**

1. Dashboard → SQL editor → New query
2. Paste contents of `001_create_schema.sql` → Run
3. New query → paste `002_seed_sanctioned.sql` → Run

---

## Verification

After running both files:

```sql
-- Tables created (expect 11 rows)
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'private_companies', 'private_company_aliases', 'sanctioned_securities',
    'nport_registrants', 'nport_filings', 'nport_holdings',
    'nport_identifiers', 'nport_holdings_ncsr',
    'fund_portfolio_managers', 'fund_ncen_records', 'position_deltas'
  )
ORDER BY tablename;

-- Materialized view created (expect 1 row)
SELECT matviewname FROM pg_matviews
WHERE schemaname = 'public' AND matviewname = 'nport_company_positions_mv';

-- Sanctioned-securities seed loaded (expect 30 rows)
SELECT count(*) FROM sanctioned_securities;

-- Indices created (expect ~20 rows of ix_* indices)
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND indexname LIKE 'ix_%'
ORDER BY indexname;
```

---

## Notes / Gotchas

### Materialized view refresh

`nport_company_positions_mv` is empty after migration (no data yet). After each
bulk ingestion run (per §6 of the plan), refresh it:

```sql
REFRESH MATERIALIZED VIEW nport_company_positions_mv;
```

The materialized view currently uses **non-unique** indices, so
`REFRESH MATERIALIZED VIEW CONCURRENTLY` will not work as-is. If we need
concurrent refresh later (live read traffic during refresh), add a UNIQUE
covering index on the natural key — the obvious candidate is
`(company_id, registrant_id, series_id, share_class_normalized, accession_number)` —
in a follow-up migration. The plan §4.1 specified non-unique indices, so we
ship as specified and revisit when ingestion volume justifies it.

### Forward-reference ordering

The plan's §4.1 listed `nport_holdings` first, but `nport_holdings.resolved_company_id`
references `private_companies(id)`, and `nport_filings.registrant_id` references
`nport_registrants(id)`. The migration reorders to dependency-correct order
(see header comment in `001_create_schema.sql`) — every column, type, default,
constraint, and index is identical to the plan; only the table-declaration
order changed.

### Row-Level Security (RLS)

This migration does **not** enable RLS or create policies. For the ADV / Form D
projects we run with RLS enabled and explicit anon/service policies (see
`migrations/create_compliance_issues_table.sql` for the pattern). RLS for
N-PORT should be added in a follow-up migration once the ingestion-write vs
public-read access shape is decided. Until then, only the service-role key
should be used.

### No data ingestion here

This migration is **schema only**. Bulk N-PORT TSV ingestion, daily NPORT-P
scraping, N-CSR enrichment, N-CEN ingestion, and the resolution pipeline live
in §6 of the plan and ship as separate modules.

---

## Rollback

```sql
DROP MATERIALIZED VIEW IF EXISTS nport_company_positions_mv;
DROP TABLE IF EXISTS position_deltas CASCADE;
DROP TABLE IF EXISTS fund_ncen_records CASCADE;
DROP TABLE IF EXISTS fund_portfolio_managers CASCADE;
DROP TABLE IF EXISTS nport_holdings_ncsr CASCADE;
DROP TABLE IF EXISTS nport_identifiers CASCADE;
DROP TABLE IF EXISTS nport_holdings CASCADE;
DROP TABLE IF EXISTS nport_filings CASCADE;
DROP TABLE IF EXISTS sanctioned_securities CASCADE;
DROP TABLE IF EXISTS private_company_aliases CASCADE;
DROP TABLE IF EXISTS private_companies CASCADE;
DROP TABLE IF EXISTS nport_registrants CASCADE;
-- pgcrypto extension intentionally left in place (it may be in use elsewhere).
```
