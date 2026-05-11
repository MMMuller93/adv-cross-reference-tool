# N-PORT Holdings Subsystem

Self-contained subtree that tracks which mutual funds and ETFs hold shares
in private companies (Anthropic, OpenAI, SpaceX, etc.) by ingesting SEC
Form N-PORT filings.

This subsystem runs as its own process and does **not** touch the main
PrivateFundsRadar `server.js`. Integration with the main PFR product is a
separate decision.

## Quick start (local development)

```bash
# 1) Provision the schema in a local Postgres
createdb nport_dev
psql -d nport_dev -f nport/migrations/001_create_schema.sql
psql -d nport_dev -f nport/migrations/002_seed_sanctioned.sql

# 2) Run the Python CLI (from the repo root, NOT from inside nport/)
python3 -m nport.scraper.backfill_bulk --help
python3 -m nport.scraper.daily_scraper --help

# 3) Run the standalone API + frontend on port 3010
cd nport/api && npm install
NPORT_PG_CONN=postgresql://localhost/nport_dev node server.js
# open http://localhost:3010
```

## Layout

```
nport/
├── PLAN.md                      Full design spec (was PLAN_NPORT_HOLDINGS.md)
├── docs/research/               Stress-test findings from the planning phase
├── migrations/                  Postgres DDL (001_create_schema, 002_seed)
├── lib/                         Shared utils (edgar_index, etc.)
├── resolver/                    Entity resolution: issuer-row -> private-company
├── scraper/                     Bulk + daily + identifiers scrapers
├── delta_detection/             QoQ position-delta + repricing-event detection
├── enrichment/
│   ├── ncen_ingest/             N-CEN parser + daily ingestor
│   ├── n1a_extract/             N-1A portfolio-manager extraction
│   └── ncsr_enrich/             N-CSR acquisition-cost extraction
├── seed_loader/                 Wikipedia + Wikidata + manual private-co seed
├── api/                         Express server on port 3010 (own package.json)
│   ├── routes/nport.js          All /api/nport/* endpoints
│   ├── db/nport_client.js       Supabase production client (when configured)
│   ├── db/cross_source.js       ADV + Form D cross-DB consolidator
│   ├── db/pg_shim.js            Tiny Supabase-shaped wrapper over local pg
│   └── server.js                Express bootstrap
├── frontend/                    Standalone static site (index.html + JS)
├── tests/integration/           End-to-end pipeline test
└── pyproject.toml               Python package (sets up `nport.*` imports)
```

## Running the tests

```bash
# Module-level Python tests (resolver, scraper, delta_detection, enrichment)
python3 -m pytest nport/

# Module-level Node tests (API routes with mocked supabase client)
cd nport/api && npm test

# End-to-end integration test (requires a local Postgres)
# This boots Postgres, applies migrations, runs scraper -> resolver ->
# db_client -> API against the same DB.
NPORT_E2E_PG_CONN=postgresql://localhost/nport_e2e \
  python3 -m pytest nport/tests/integration/
```

## CLI entry points

All of these run via `python3 -m nport.<package>.<module>` from a
directory whose **parent** of `nport/` is on `sys.path`. The easiest
way is to run from the repo root.

- `python3 -m nport.scraper.backfill_bulk --quarter 2026q1`
- `python3 -m nport.scraper.daily_scraper --days 1`
- `python3 -m nport.scraper.load_identifiers --tsv path/to/IDENTIFIERS.tsv`
- `python3 -m nport.delta_detection.compute_deltas --prior 2025-09-30 --current 2025-12-31`
- `python3 -m nport.seed_loader.merge_and_emit --input-dir ./seed_inputs`
- `python3 -m nport.enrichment.ncen_ingest.daily_ncen --days 7`
- `python3 -m nport.enrichment.n1a_extract.dispatcher --html sample.html --cik 24238`
- `python3 -m nport.enrichment.ncsr_enrich.dispatcher --html sample.html --cik 24238`

## Wiring N-PORT to the main PFR app (future)

When ready to integrate, the main `server.js` can mount the routes by
adding **one** require + mount:

```js
const nportRoutes = require('./nport/api/routes/nport');
app.use('/api/nport', nportRoutes);
```

That single line is the entire integration surface. Until then the two
systems are independent processes.
