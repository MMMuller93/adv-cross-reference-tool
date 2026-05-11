-- =============================================================================
-- N-PORT Private-Company Holdings Database — Schema Migration
-- =============================================================================
-- Implements §4.1 of PLAN_NPORT_HOLDINGS.md
--
-- Target: Postgres 15+ / Supabase (dedicated `nport` project, NOT the existing
-- ADV or Form D projects). Cross-DB joins happen in the Node API server.
--
-- Run with:
--   psql "$DATABASE_URL" -f migrations/nport/001_create_schema.sql
--   psql "$DATABASE_URL" -f migrations/nport/002_seed_sanctioned.sql
--
-- Tables (created in dependency order):
--   1. nport_registrants              (no FK deps)
--   2. private_companies              (no FK deps)
--   3. private_company_aliases        → private_companies
--   4. sanctioned_securities          (no FK deps)
--   5. nport_filings                  → nport_registrants
--   6. nport_holdings                 → private_companies (+ accession by value)
--   7. nport_identifiers              (no FK deps; joins by holding_id text)
--   8. nport_holdings_ncsr            → nport_holdings
--   9. fund_portfolio_managers        (no FK deps)
--  10. fund_ncen_records              (no FK deps)
--  11. position_deltas                → private_companies, nport_registrants
--  12. nport_company_positions_mv     (materialized view; depends on all above)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =========================================================
-- Fund family / registrant metadata
-- =========================================================
CREATE TABLE nport_registrants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cik                 text UNIQUE NOT NULL,
  name                text NOT NULL,
  lei                 text,
  address_street1     text,
  address_street2     text,
  address_city        text,
  address_state       text,
  address_zip         text,
  address_country     text,
  phone               text,

  -- Cross-link to ADV adviser DB
  adv_crd             text,                       -- nullable; FK-by-value to advisers_enriched.crd
  adv_crd_match_confidence smallint,              -- 0-100; how confidently matched
  adv_crd_match_method text,                      -- 'cik_in_adv'|'ncen_xref'|'name_fuzzy'|'manual'

  first_seen_at       timestamptz DEFAULT now(),
  last_filed_at       date
);

CREATE INDEX ix_nport_registrants_adv      ON nport_registrants (adv_crd) WHERE adv_crd IS NOT NULL;


-- =========================================================
-- Curated private-company entity table
-- =========================================================
CREATE TABLE private_companies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text UNIQUE NOT NULL,      -- 'anthropic', 'openai', 'spacex'
  display_name         text NOT NULL,             -- 'Anthropic', 'OpenAI', 'SpaceX'
  primary_domain       text,                      -- 'anthropic.com'
  sector               text,                      -- 'ai_ml' | 'space_defense' | 'fintech' | 'biotech' | 'consumer' | 'mobility' | 'other'
  description          text,
  founded_year         smallint,
  hq_country           text,
  hq_state             text,

  -- Legal entity registry — one company can have multiple legal entities (parent, sub, PBC, LLC)
  legal_entities       jsonb,                     -- [{name, jurisdiction, role: 'parent'|'sub'|'pbc'|'llc', start_date, end_date}]

  -- Round history (manually curated or scraped from Wikipedia/CB Insights/Forge)
  most_recent_round    text,                      -- 'Series F'
  most_recent_round_date date,
  latest_known_valuation_usd numeric(20,4),
  latest_known_valuation_date date,
  total_funding_usd    numeric(20,4),

  -- Seed source attribution
  seed_source          text,                      -- 'wikipedia'|'nport_discovery'|'manual'|'cbinsights'

  is_sanctioned        boolean DEFAULT false,     -- exclude Russian etc. from rankings
  is_public            boolean DEFAULT false,     -- flag if it IPO'd (e.g. Rivian)
  ipo_date             date,                      -- if public
  is_acquired          boolean DEFAULT false,     -- e.g. Wiz acquired by Google
  acquired_by          text,                      -- acquirer name
  acquired_date        date,                      -- when N-PORT rows disappear
  lifecycle_status     text,                      -- 'private'|'public'|'acquired'|'defunct'

  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE INDEX ix_private_companies_sector  ON private_companies (sector);
CREATE INDEX ix_private_companies_active  ON private_companies (is_sanctioned, is_public, is_acquired)
  WHERE NOT is_sanctioned AND NOT is_public AND NOT is_acquired;


-- =========================================================
-- Alias patterns for entity resolution
-- =========================================================
CREATE TABLE private_company_aliases (
  id                bigserial PRIMARY KEY,
  company_id        uuid NOT NULL REFERENCES private_companies(id) ON DELETE CASCADE,
  pattern_type      text NOT NULL,                -- 'exact_normalized'|'prefix'|'contains'|'regex'|'vendor_code'
  pattern           text NOT NULL,
  exposure_type     text NOT NULL DEFAULT 'direct', -- if this alias represents an SPV, set 'spv'
  underlier_only    boolean DEFAULT false,        -- when pattern matches an SPV that wraps the company
  vendor_code_type  text,                         -- 'BlackRock'|'BBGID'|'FIGI'|'LoanX'|'LEI' if pattern_type='vendor_code'
  notes             text,
  source            text,                         -- 'manual'|'auto_cluster'|'ncen_match'
  confidence        smallint DEFAULT 100,
  created_at        timestamptz DEFAULT now(),

  UNIQUE (company_id, pattern_type, pattern)
);

CREATE INDEX ix_aliases_pattern      ON private_company_aliases (pattern_type, pattern);
CREATE INDEX ix_aliases_company      ON private_company_aliases (company_id);


-- =========================================================
-- Sanctioned-securities exclusion list
-- =========================================================
CREATE TABLE sanctioned_securities (
  id                 bigserial PRIMARY KEY,
  pattern            text NOT NULL,
  reason             text,                        -- 'OFAC Russia 2022', etc.
  added_at           timestamptz DEFAULT now()
);
-- Seed: SBERBANK, LUKOIL, POLYUS, NORILSK, GAZPROM, NOVATEK, EVRAZ, NOVOLIPETSK, TATNEFT, SURGUTNEFTEGAS, ROSNEFT, MAGNIT, etc.
-- See 002_seed_sanctioned.sql


-- =========================================================
-- Filing metadata — one row per accession
-- =========================================================
CREATE TABLE nport_filings (
  accession_number          text PRIMARY KEY,
  cik                       text NOT NULL,
  registrant_id             uuid REFERENCES nport_registrants(id),

  -- From genInfo
  registrant_name           text NOT NULL,
  registrant_lei            text,
  series_id                 text,                 -- SEC series ID like S000012345
  series_name               text,
  series_lei                text,
  report_period_end         date NOT NULL,        -- repPdEnd
  report_period_date        date NOT NULL,        -- repPdDate (month within quarter)
  is_amendment              boolean NOT NULL DEFAULT false,
  is_final_filing           boolean NOT NULL DEFAULT false,
  filing_date               date NOT NULL,

  -- From fundInfo
  net_assets_usd            numeric(20,4),
  total_assets_usd          numeric(20,4),

  -- Classification (computed)
  fund_type                 text,                 -- 'open_end'|'etf'|'closed_end'|'interval'|'tender_offer'|'unknown'
  is_interval_fund          boolean DEFAULT false,
  is_variable_insurance     boolean DEFAULT false,
  parent_registrant_id      uuid,                 -- for VA sub-accounts that mirror underlying

  -- Trace
  source_bulk_quarter       text,
  source_url                text,                 -- EDGAR primary_doc.xml URL
  ingested_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_nport_filings_cik          ON nport_filings (cik);
CREATE INDEX ix_nport_filings_period       ON nport_filings (report_period_end);
CREATE INDEX ix_nport_filings_fund_type    ON nport_filings (fund_type) WHERE is_interval_fund OR fund_type IN ('closed_end','interval');


-- =========================================================
-- Core fact table — one row per (filer × period × position)
-- =========================================================
CREATE TABLE nport_holdings (
  id                        bigserial PRIMARY KEY,
  accession_number          text NOT NULL,
  holding_id                text NOT NULL,

  -- Raw fields, verbatim from FUND_REPORTED_HOLDING.tsv
  issuer_name               text NOT NULL,
  issuer_title              text,
  issuer_lei                text,
  issuer_cusip              text,
  balance                   numeric(28,8),
  unit                      text,                 -- NS=number of shares, PA=principal amount
  other_unit_desc           text,
  currency_code             text,
  currency_value_usd        numeric(20,4),        -- already converted to USD by SEC
  exchange_rate             numeric(20,8),
  pct_of_nav                numeric(12,8),
  payoff_profile            text,                 -- Long, Short, N/A
  asset_cat                 text,                 -- EC, EP, LON, DBT, DE, OTHER
  other_asset               text,
  issuer_type               text,                 -- CORP, RF, ABS, OTHER
  other_issuer              text,
  investment_country        text,
  is_restricted_security    boolean,
  fair_value_level          smallint,             -- 1, 2, 3
  derivative_cat            text,

  -- Resolution (materialized at ingestion)
  resolved_company_id       uuid REFERENCES private_companies(id),
  resolution_source         text,                 -- 'alias'|'loanx'|'bbgid'|'lei'|'manual'|'unresolved'
  resolution_confidence     smallint,             -- 0-100
  exposure_type             text,                 -- 'direct'|'spv'|'feeder'|'derivative'|'credit'
  underlier_issuer_name     text,                 -- when SPV/feeder, the parsed underlier
  share_class_normalized    text,                 -- 'Series F-1', 'Common', 'Class A', 'unspecified'

  -- Trace
  source_bulk_quarter       text,                 -- '2026Q1' | 'daily-scrape' for traceability
  ingested_at               timestamptz NOT NULL DEFAULT now(),

  UNIQUE (accession_number, holding_id)
);

CREATE INDEX ix_nport_holdings_accession      ON nport_holdings (accession_number);
CREATE INDEX ix_nport_holdings_resolved       ON nport_holdings (resolved_company_id, fair_value_level)
  WHERE resolved_company_id IS NOT NULL;
CREATE INDEX ix_nport_holdings_unresolved     ON nport_holdings (issuer_name)
  WHERE resolution_source = 'unresolved' OR resolution_source IS NULL;
CREATE INDEX ix_nport_holdings_text_search    ON nport_holdings
  USING gin (to_tsvector('simple', coalesce(issuer_name,'') || ' ' || coalesce(issuer_title,'')));
CREATE INDEX ix_nport_holdings_loanx_lookup   ON nport_holdings (issuer_lei) WHERE issuer_lei IS NOT NULL AND issuer_lei != 'N/A';


-- =========================================================
-- IDENTIFIERS.tsv — vendor cross-reference table
-- =========================================================
CREATE TABLE nport_identifiers (
  id                bigserial PRIMARY KEY,
  holding_id        text NOT NULL,
  identifiers_id    text,                         -- from IDENTIFIERS.IDENTIFIERS_ID
  isin              text,
  ticker            text,
  other_identifier  text,
  other_id_desc     text,                         -- 'BlackRock Identifier'|'LoanX ID'|'BBGID'|...

  source_bulk_quarter text,
  UNIQUE (holding_id, identifiers_id)
);

CREATE INDEX ix_nport_id_holding     ON nport_identifiers (holding_id);
CREATE INDEX ix_nport_id_loanx       ON nport_identifiers (other_identifier) WHERE other_id_desc = 'LoanX ID';
CREATE INDEX ix_nport_id_bbgid       ON nport_identifiers (other_identifier)
  WHERE other_id_desc IN ('BBGID','ID_BB_GLOBAL','Bloomberg Identifier','Bloomberg');


-- =========================================================
-- N-CSR enrichment — acquisition cost / date / methodology
-- =========================================================
CREATE TABLE nport_holdings_ncsr (
  id                       bigserial PRIMARY KEY,
  holding_id_ref           bigint REFERENCES nport_holdings(id) ON DELETE CASCADE,
  acquisition_date         date,
  acquisition_cost_usd     numeric(20,4),
  is_multiple_tranches     boolean DEFAULT false,  -- Fidelity uses date ranges
  acquisition_date_range_start date,
  acquisition_date_range_end   date,
  valuation_methodology    text,                  -- 'Market Approach / Precedent Transactions'
  valuation_inputs         text,                  -- free text
  level3_movements         jsonb,                  -- {opening_balance, purchases, conversions, unrealized_appr, ending_balance}
  ncsr_accession           text NOT NULL,
  ncsr_period_end          date NOT NULL,
  ncsr_form_type           text,                  -- 'N-CSR'|'N-CSRS'
  source_field             text,                  -- 'restricted_table'|'inline_name'|'soi_column'|'roll_forward'
  extraction_method        text,                  -- 'ark_regex'|'destiny_ixbrl'|'fidelity_llm'|'trp_regex_inline'|'generic_llm'
  extraction_confidence    smallint,              -- 0-100
  raw_extracted_text       text,                  -- preserve the source snippet
  extracted_at             timestamptz DEFAULT now()
);

CREATE INDEX ix_ncsr_holding ON nport_holdings_ncsr (holding_id_ref);


-- =========================================================
-- N-1A portfolio manager enrichment
-- =========================================================
CREATE TABLE fund_portfolio_managers (
  id                       bigserial PRIMARY KEY,
  filing_accession         text NOT NULL,         -- N-1A / 485BPOS / N-2 accession
  registrant_cik           text NOT NULL,
  series_id                text,
  series_name              text,
  pm_name                  text NOT NULL,
  pm_role                  text,                  -- 'Portfolio Manager'|'Co-PM'|'Lead PM'|'CIO'
  pm_managing_since        date,
  pm_managing_since_year   smallint,              -- when only year disclosed
  pm_biography             text,
  is_currently_active      boolean DEFAULT true,
  retirement_date          date,                  -- if disclosed
  filing_form_type         text,                  -- 'N-1A'|'485BPOS'|'N-2'|'N-2/A'
  filing_date              date,
  extraction_method        text,                  -- 'fidelity_regex'|'trp_table_parser'|'baron_regex'|'generic_llm'
  extraction_confidence    smallint,
  raw_extracted_text       text,
  extracted_at             timestamptz DEFAULT now()
);

CREATE INDEX ix_fpm_registrant ON fund_portfolio_managers (registrant_cik, series_id, is_currently_active);


-- =========================================================
-- N-CEN — structured fund census (XML)
-- =========================================================
CREATE TABLE fund_ncen_records (
  id                       bigserial PRIMARY KEY,
  accession_number         text UNIQUE NOT NULL,
  registrant_cik           text NOT NULL,
  series_id                text,
  fiscal_year_end          date,
  filing_date              date NOT NULL,
  investment_adviser_name  text,
  investment_adviser_crd   text,
  investment_adviser_lei   text,
  subadviser_name          text,
  subadviser_crd           text,
  subadviser_lei           text,
  fund_type                text,                  -- from N-CEN classification
  is_etf                   boolean,
  is_money_market          boolean,
  ingested_at              timestamptz DEFAULT now()
);

CREATE INDEX ix_ncen_cik ON fund_ncen_records (registrant_cik, series_id);
CREATE INDEX ix_ncen_adviser ON fund_ncen_records (investment_adviser_crd);
CREATE INDEX ix_ncen_subadv  ON fund_ncen_records (subadviser_crd);


-- =========================================================
-- Quarter-over-quarter delta detection (computed)
-- =========================================================
CREATE TABLE position_deltas (
  id                       bigserial PRIMARY KEY,
  company_id               uuid NOT NULL REFERENCES private_companies(id),
  registrant_id            uuid NOT NULL REFERENCES nport_registrants(id),
  series_id                text NOT NULL,
  share_class_normalized   text,
  exposure_type            text,
  prior_period_end         date NOT NULL,
  current_period_end       date NOT NULL,
  prior_balance            numeric(28,8),
  current_balance          numeric(28,8),
  prior_value_usd          numeric(20,4),
  current_value_usd        numeric(20,4),
  balance_delta            numeric(28,8),
  value_delta_usd          numeric(20,4),
  implied_price_prior      numeric(20,6),         -- value/balance
  implied_price_current    numeric(20,6),
  markup_pct               numeric(10,4),         -- (current_price - prior_price) / prior_price * 100
  is_pure_markup           boolean,               -- balance unchanged, only value moved
  is_new_position          boolean,
  is_exit                  boolean,
  detected_at              timestamptz DEFAULT now(),

  UNIQUE (company_id, registrant_id, series_id, share_class_normalized, exposure_type, current_period_end)
);

CREATE INDEX ix_deltas_company ON position_deltas (company_id, current_period_end);
CREATE INDEX ix_deltas_markup  ON position_deltas (company_id, markup_pct) WHERE is_pure_markup = true;


-- =========================================================
-- Materialized rollup view — fast company-page queries
-- =========================================================
CREATE MATERIALIZED VIEW nport_company_positions_mv AS
SELECT
  pc.id                          AS company_id,
  pc.slug                        AS company_slug,
  pc.display_name                AS company_name,
  pc.sector,
  nh.exposure_type,
  nh.share_class_normalized,
  nh.asset_cat,
  nf.report_period_end,
  nf.report_period_date,
  nr.id                          AS registrant_id,
  nr.cik                         AS registrant_cik,
  nr.name                        AS registrant_name,
  nf.series_id,
  nf.series_name,
  nf.fund_type,
  nf.is_interval_fund,
  nf.is_variable_insurance,
  nf.parent_registrant_id,
  nh.balance,
  nh.currency_value_usd,
  nh.pct_of_nav,
  nh.issuer_name                 AS raw_issuer_name,
  nh.issuer_title                AS raw_issuer_title,
  nh.accession_number,
  nh.id                          AS holding_id_internal
FROM nport_holdings nh
JOIN nport_filings    nf ON nh.accession_number = nf.accession_number
JOIN nport_registrants nr ON nf.cik = nr.cik
JOIN private_companies pc ON nh.resolved_company_id = pc.id
WHERE nh.resolved_company_id IS NOT NULL
  AND pc.is_sanctioned = false
  AND pc.is_acquired   = false;

CREATE INDEX ix_mv_company_period ON nport_company_positions_mv (company_id, report_period_end);
CREATE INDEX ix_mv_registrant     ON nport_company_positions_mv (registrant_id);
CREATE INDEX ix_mv_company_slug   ON nport_company_positions_mv (company_slug, report_period_end);


-- =============================================================================
-- Documentation comments
-- =============================================================================
COMMENT ON TABLE nport_registrants         IS 'Fund family / registrant metadata (one row per CIK). Cross-links to ADV adviser DB via adv_crd (by value).';
COMMENT ON TABLE private_companies         IS 'Curated private-company entity table (Anthropic, OpenAI, SpaceX, ...). Seeded from N-PORT discovery + manual curation.';
COMMENT ON TABLE private_company_aliases   IS 'Alias patterns for entity resolution — many-to-one from raw N-PORT issuer names to canonical private_companies rows.';
COMMENT ON TABLE sanctioned_securities     IS 'Exclusion list — OFAC-sanctioned Russian securities and similar noise. Seeded in 002_seed_sanctioned.sql.';
COMMENT ON TABLE nport_filings             IS 'One row per N-PORT accession (filer × period). Joined to nport_holdings by accession_number.';
COMMENT ON TABLE nport_holdings            IS 'Core fact table — one row per (filer × period × position). Verbatim FUND_REPORTED_HOLDING.tsv plus resolution columns.';
COMMENT ON TABLE nport_identifiers         IS 'IDENTIFIERS.tsv — vendor cross-reference table (LoanX, BBGID, ISIN, ticker). Joined by holding_id.';
COMMENT ON TABLE nport_holdings_ncsr       IS 'N-CSR / N-CSRS enrichment — acquisition cost, date, valuation methodology, level-3 roll-forwards.';
COMMENT ON TABLE fund_portfolio_managers   IS 'N-1A / 485BPOS / N-2 portfolio manager identity extraction.';
COMMENT ON TABLE fund_ncen_records         IS 'N-CEN annual fund census (XBRL/XML structured). Source of adviser/subadviser CRD linkage.';
COMMENT ON TABLE position_deltas           IS 'Computed quarter-over-quarter position deltas — markup signal, new-position flag, exit flag.';
COMMENT ON MATERIALIZED VIEW nport_company_positions_mv IS 'Rollup view for fast company-page queries. Refresh after each ingestion run: REFRESH MATERIALIZED VIEW CONCURRENTLY nport_company_positions_mv.';
