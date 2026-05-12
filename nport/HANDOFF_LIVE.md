# N-PORT Live Handoff

This file is safe to share with Claude or another local coding agent. It
intentionally omits secret values.

## Supabase Project

- Project name: `pfr-nport`
- Project ref: `figvonwrlcpveyceengf`
- Dashboard: <https://supabase.com/dashboard/project/figvonwrlcpveyceengf>
- SQL editor: <https://supabase.com/dashboard/project/figvonwrlcpveyceengf/sql/new>
- REST base URL: `https://figvonwrlcpveyceengf.supabase.co`

Credentials live only in the ignored file at repo root:

```bash
/private/tmp/nport-buildout-claude/.env
```

Required variables:

```bash
SUPABASE_URL_NPORT=...
SUPABASE_SERVICE_KEY_NPORT=...
```

Do not paste or commit the service-role key. Load it locally with:

```bash
set -a
source /private/tmp/nport-buildout-claude/.env
set +a
```

## Local Tree

- Isolated repo tree: `/private/tmp/nport-buildout-claude`
- Branch: `nport-buildout-claude`
- N-PORT subsystem root: `/private/tmp/nport-buildout-claude/nport`
- Main design spec: `/private/tmp/nport-buildout-claude/nport/PLAN.md`
- Research docs: `/private/tmp/nport-buildout-claude/nport/docs/research`
- Schema: `/private/tmp/nport-buildout-claude/nport/migrations/001_create_schema.sql`
- Sanctions seed: `/private/tmp/nport-buildout-claude/nport/migrations/002_seed_sanctioned.sql`
- Service-role grants: `/private/tmp/nport-buildout-claude/nport/migrations/003_grant_service_role_access.sql`

This branch keeps N-PORT isolated under `nport/`. It does not modify the main
PFR `server.js` or `public/app.js`; production integration is a deliberate later
step via `require('./nport/api/mount')(app)`.

## Data Sources

- SEC N-PORT quarterly bulk ZIPs:
  `https://www.sec.gov/files/dera/data/form-n-port-data-sets/{year}q{q}_nport.zip`
- SEC daily EDGAR index:
  `https://www.sec.gov/Archives/edgar/full-index/{year}/QTR{q}/form.idx`
- Daily filing XML:
  `https://www.sec.gov/Archives/edgar/data/{cik}/{accession_nodashes}/primary_doc.xml`
- User-Agent required for SEC requests. The scraper uses the configured
  user-agent from the N-PORT SEC client.

## Loaded Live Data

Bulk backfill was run from `2019Q4` through `2026Q1`.
Daily Q2-to-date ingestion was run for the 45-day window ending 2026-05-11.

Latest read-only preflight counts after the daily replay and identifier cleanup:

```text
private_companies: 843
private_company_aliases: 924
sanctioned_securities: 30
nport_registrants: 1586
nport_filings: 57375
nport_holdings: 315831
nport_identifiers: 667711
nport_holdings_ncsr: 0
fund_portfolio_managers: 0
fund_ncen_records: 0
position_deltas: 0
nport_company_positions_mv: 0
```

Daily-specific coverage checks:

```text
daily_holdings: 3676
daily_fvl_not_null: 3676
daily_identifiers: 63
daily_identifier_descriptor_rows: 63
daily_identifier_null_desc: 0
```

The daily identifier cleanup backed up the noisy pre-fix rows here before
deleting them:

```bash
/private/tmp/nport_daily_identifiers_backup_before_cleanup.jsonl
```

`nport_company_positions_mv` is empty until this SQL is run in Supabase:

```sql
REFRESH MATERIALIZED VIEW nport_company_positions_mv;
```

Do the refresh after the active daily scraper finishes or after intentionally
stopping it, otherwise the MV will not include the most recent Q2 rows.

At handoff time, browser-based refresh was blocked because Chrome automation
returned a user-denied permission response. The SQL above still needs to be run
manually in Supabase SQL Editor or through an authenticated SQL-capable tool.

## Current Ingestion Process

Q2-to-date daily ingestion was started with:

```bash
cd /private/tmp/nport-buildout-claude
PYTHONUNBUFFERED=1 ./.venv/bin/python -m nport.scraper.daily_scraper --days 45
```

For faster live ingestion, run process shards. Each process owns a
deterministic accession slice and uses its own Supabase/SEC clients:

```bash
cd /private/tmp/nport-buildout-claude
for i in 0 1 2 3; do
  SEC_RATE_LIMIT_SEC=0.50 PYTHONUNBUFFERED=1 \
    ./.venv/bin/python -m nport.scraper.daily_scraper \
    --days 45 --shard-count 4 --shard-index "$i" \
    > "/tmp/nport_daily_shard_${i}.log" 2>&1 &
done
wait
```

The upsert keys make this idempotent, so rerunning shards repairs partial rows
from an interrupted serial run. Use `SEC_RATE_LIMIT_SEC=0.50` with four shards
to keep aggregate SEC traffic below the 10 req/s ceiling. The scraper now
rejects unsafe shard/rate combinations before the first SEC request.

Daily ingestion also checks Supabase before processing and skips accessions
already loaded from non-daily bulk data. This avoids duplicate facts caused by
daily XML synthetic holding IDs versus SEC bulk `HOLDING_ID` values.

Check status:

```bash
pgrep -af 'nport.scraper.daily_scraper|python -m nport'
```

At handoff time there are no daily scraper processes running.

## Commands

Read-only live preflight:

```bash
cd /private/tmp/nport-buildout-claude
./.venv/bin/python -m nport.scraper.preflight_live
```

Reversible write smoke test:

```bash
cd /private/tmp/nport-buildout-claude
./.venv/bin/python -m nport.scraper.preflight_live --write-smoke
```

Single-quarter bulk backfill:

```bash
cd /private/tmp/nport-buildout-claude
PYTHONUNBUFFERED=1 ./.venv/bin/python -m nport.scraper.backfill_bulk --quarter 2026q1
```

Full historical backfill:

```bash
cd /private/tmp/nport-buildout-claude
PYTHONUNBUFFERED=1 ./.venv/bin/python -m nport.scraper.backfill_bulk --start 2019q4 --end 2026q1
```

Targeted tests:

```bash
cd /private/tmp/nport-buildout-claude
./.venv/bin/python -m pytest nport/scraper/tests nport/tests/integration/test_e2e_pipeline.py -q
```

## Implementation Corrections Already Applied

- Live row mapping now uses exact schema-aware table columns.
- Bulk and daily scrapers upsert `nport_registrants`, `nport_filings`,
  `nport_holdings`, and useful `nport_identifiers`.
- Resolver loads live Supabase UUIDs and aliases instead of bundled placeholder
  ids when live credentials are present.
- Broad level-3 loan capture was narrowed to resolved tracked-company credit
  rows only; the broad predicate matched over a million rows in one quarter.
- IDENTIFIERS ingestion was narrowed to useful descriptor rows only. Keeping all
  ISIN/ticker rows produced millions of mostly irrelevant rows per quarter.
- Impossible `pct_of_nav` values are nulled before upsert to avoid dropping the
  full holding row on `numeric(12,8)` overflow.
- Daily registrants are inserted with `ON CONFLICT DO NOTHING` semantics so
  sparse daily XML cannot null richer bulk-loaded address/phone metadata.
- Daily identifiers are written only for kept holdings and only for useful
  descriptors, not for every public holding in the filing.
- Bulk ingestion refuses to run if a bulk ZIP overlaps existing daily holdings,
  preventing duplicate facts caused by daily synthetic XML holding IDs versus
  SEC bulk `HOLDING_ID` values.
- Bulk ingestion filters holdings to accessions whose filing metadata was
  valid and upserted, preventing orphan facts that would disappear from the MV.
- Live Supabase initialization now fails loud if env vars are present but the
  client cannot be created, instead of silently falling back to JSONL stubs.

## Still Pending

- Refresh `nport_company_positions_mv`.
- Run post-refresh company-page smoke checks against `anthropic`.
- Start N-CEN, N-1A, and N-CSR enrichment jobs if those enrichments are needed
  before product integration.
- Decide whether to keep this as the isolated N-PORT branch or merge a one-line
  mount into the main PFR app.
