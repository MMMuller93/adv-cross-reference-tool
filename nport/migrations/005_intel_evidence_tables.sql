-- Fund Holders Intel — typed evidence tables (V1)
--
-- Four tables that label evidence by source and semantics. They are
-- materialized from the raw N-PORT and Form D tables by the intel pipeline
-- (intelligence/fund_holders_query.py) and serve as the auditable record of
-- "for company X, here's every holder we found."
--
-- Design rules (locked 2026-05-17 after Codex 5.5 review + user directives):
--   - No confidence scores. Method enum says HOW we resolved; that's enough.
--   - No status/review columns. We do NOT flag rows for manual review.
--   - Direct-issuer Form D filings are stored separately from pooled-vehicle
--     filings so we can't accidentally show the tracked company's own
--     fundraises as if they were holder evidence.
--   - Idempotent: each materialization upserts on a stable unique key.

-- ---------------------------------------------------------------------------
-- N-PORT positions: a registered fund holds the tracked company
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intel_nport_position (
    position_id BIGSERIAL PRIMARY KEY,
    company_slug TEXT NOT NULL,
    holding_id_internal BIGINT NOT NULL,
    registrant_cik TEXT NOT NULL,
    series_id TEXT,
    issuer_title TEXT,
    value_usd NUMERIC,
    pct_net_assets NUMERIC,
    as_of_date DATE,
    accession_number TEXT,
    materialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_slug, holding_id_internal)
);
CREATE INDEX IF NOT EXISTS intel_nport_position_company_idx
    ON intel_nport_position (company_slug);
CREATE INDEX IF NOT EXISTS intel_nport_position_cik_idx
    ON intel_nport_position (registrant_cik);

-- ---------------------------------------------------------------------------
-- Form D — pooled-vehicle offerings (HOLDER EVIDENCE)
--   The filer is a pooled investment vehicle (SPV, fund, series LLC, feeder,
--   fund-of-funds) that holds the tracked company.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intel_formd_pooled_vehicle_offering (
    offering_id BIGSERIAL PRIMARY KEY,
    company_slug TEXT NOT NULL,
    accession_number TEXT NOT NULL,
    filer_entityname TEXT NOT NULL,
    filer_cik TEXT,
    series_master_llc TEXT,
    filing_date DATE,
    total_offering_amount NUMERIC,
    match_method TEXT NOT NULL,
        -- 'cross_reference_match' | 'entityname_alias' | 'series_master_parse'
    materialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_slug, accession_number)
);
CREATE INDEX IF NOT EXISTS intel_formd_pooled_company_idx
    ON intel_formd_pooled_vehicle_offering (company_slug);

-- ---------------------------------------------------------------------------
-- Form D — direct-issuer offerings (NOT HOLDER EVIDENCE — audit only)
--   The filer IS the tracked company itself (e.g., Anthropic PBC filing for
--   its Series E raise). Stored so we can audit what we saw, but NEVER
--   surfaced as a "holder" — Anthropic is not a holder of itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intel_formd_direct_issuer_offering (
    offering_id BIGSERIAL PRIMARY KEY,
    company_slug TEXT NOT NULL,
    accession_number TEXT NOT NULL,
    filer_entityname TEXT NOT NULL,
    filer_cik TEXT,
    filing_date DATE,
    total_offering_amount NUMERIC,
    materialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_slug, accession_number)
);
CREATE INDEX IF NOT EXISTS intel_formd_direct_company_idx
    ON intel_formd_direct_issuer_offering (company_slug);

-- ---------------------------------------------------------------------------
-- Adviser resolution: which adviser firm manages a piece of evidence
--   Links to either intel_nport_position or intel_formd_pooled_vehicle_offering
--   via (source_table, source_id). A single evidence row may have multiple
--   resolution links if multiple methods produced the same CRD (rare but
--   harmless). NULL CRD is not allowed here — unresolved evidence has NO
--   row in this table at all (the absence is the signal).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intel_adviser_resolution (
    resolution_id BIGSERIAL PRIMARY KEY,
    source_table TEXT NOT NULL,
        -- 'intel_nport_position' | 'intel_formd_pooled_vehicle_offering'
    source_id BIGINT NOT NULL,
    crd TEXT NOT NULL,
    method TEXT NOT NULL,
        -- 'ncen_xref' | 'cross_reference_match' | 'entityname_alias' |
        -- 'series_master_parse' | 'manual'
    materialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_table, source_id, crd, method)
);
CREATE INDEX IF NOT EXISTS intel_adviser_resolution_crd_idx
    ON intel_adviser_resolution (crd);
CREATE INDEX IF NOT EXISTS intel_adviser_resolution_source_idx
    ON intel_adviser_resolution (source_table, source_id);

-- ---------------------------------------------------------------------------
-- View: holders per company (the main consumer view)
--   Joins both holder-evidence tables to the adviser resolution and labels
--   each row by source. NEVER includes intel_formd_direct_issuer_offering.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_intel_company_holders AS
    SELECT
        p.company_slug,
        'nport' AS source_type,
        p.position_id AS evidence_id,
        p.registrant_cik AS evidence_cik,
        p.series_id AS evidence_series_id,
        p.issuer_title AS evidence_label,
        p.value_usd,
        p.as_of_date AS evidence_date,
        p.accession_number,
        r.crd AS adviser_crd,
        r.method AS adviser_resolution_method
    FROM intel_nport_position p
    LEFT JOIN intel_adviser_resolution r
        ON r.source_table = 'intel_nport_position' AND r.source_id = p.position_id

    UNION ALL

    SELECT
        f.company_slug,
        'formd_pooled_vehicle' AS source_type,
        f.offering_id AS evidence_id,
        f.filer_cik AS evidence_cik,
        NULL AS evidence_series_id,
        f.filer_entityname AS evidence_label,
        f.total_offering_amount AS value_usd,
        f.filing_date AS evidence_date,
        f.accession_number,
        r.crd AS adviser_crd,
        r.method AS adviser_resolution_method
    FROM intel_formd_pooled_vehicle_offering f
    LEFT JOIN intel_adviser_resolution r
        ON r.source_table = 'intel_formd_pooled_vehicle_offering' AND r.source_id = f.offering_id;
