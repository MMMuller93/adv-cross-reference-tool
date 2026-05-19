-- Fund Holders Intel — company lifecycle events (V1.1)
--
-- N-PORT data is historical (2019Q4 onward). A company that's currently
-- public may have been private when an old N-PORT position was recorded.
-- We need to label each position with "was the company private at the
-- time of this holding?", not just "is the company private NOW".
--
-- Codex 5.5 xhigh design (2026-05-18): use a date-interval event model.
-- One row per transition (IPO, take-private, acquisition, etc.). Walking
-- the events in date order produces the status at any given date.

CREATE TABLE IF NOT EXISTS company_lifecycle_events (
    id BIGSERIAL PRIMARY KEY,
    company_slug TEXT NOT NULL
        REFERENCES private_companies(slug) ON UPDATE CASCADE,
    event_date DATE NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'founded',         -- company exists from this date; status_after='private'
        'ipo',             -- registered IPO on a stock exchange
        'direct_listing',  -- direct listing on an exchange
        'spac',            -- went public via SPAC merger
        'take_private',    -- public company taken private (PE buyout, etc.)
        'acquisition',     -- acquired by another company
        'delisting',       -- delisted from exchange (e.g., bankruptcy)
        'spinout',         -- spun out of a parent into independent entity
        'unknown'          -- event exists but type unclear
    )),
    status_after TEXT NOT NULL CHECK (status_after IN (
        'private',
        'public',
        'acquired_public_parent',  -- acquired by a public company (still effectively a public-equity position)
        'acquired_private',        -- acquired by a private company (became private-within-private)
        'unknown'
    )),
    source_url TEXT,           -- e.g., SEC filing or company press release
    source_name TEXT,          -- e.g., 'SEC EDGAR', 'Wikipedia', 'company press release'
    confidence INT CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
    notes TEXT,
    verified_at TIMESTAMPTZ,   -- when a human last verified this event
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_slug, event_date, event_type)
);

CREATE INDEX IF NOT EXISTS company_lifecycle_events_lookup_idx
    ON company_lifecycle_events (company_slug, event_date DESC, id DESC);


-- View: compute the current company status (the most recent event's status_after).
-- Useful for quick lookups + a sanity check against private_companies.lifecycle_status.
CREATE OR REPLACE VIEW v_company_current_lifecycle AS
    SELECT DISTINCT ON (company_slug)
        company_slug,
        event_date AS last_event_date,
        event_type AS last_event_type,
        status_after AS current_status
    FROM company_lifecycle_events
    ORDER BY company_slug, event_date DESC, id DESC;


-- Function: status_at_date(slug, target_date) -> text
-- Returns the company's status as of `target_date` by finding the most
-- recent event on or before that date. If no event exists on or before
-- target_date, returns 'unknown' (we haven't seeded the founding date).
CREATE OR REPLACE FUNCTION company_status_at_date(
    slug TEXT,
    target_date DATE
) RETURNS TEXT AS $$
    SELECT COALESCE(
        (
            SELECT status_after
            FROM company_lifecycle_events
            WHERE company_slug = slug
              AND event_date <= target_date
            ORDER BY event_date DESC, id DESC
            LIMIT 1
        ),
        'unknown'
    );
$$ LANGUAGE sql STABLE;


-- Extend the consumer view to include the per-evidence-date status.
-- Existing consumers using SELECT * pick up the new columns automatically.
-- 'status_at_evidence_date' is the policy-clean value ('private' / 'public' /
-- 'acquired_private' / 'acquired_public_parent' / 'unknown').
-- 'was_private_at_evidence_date' is a convenience boolean for the publish
-- gate: true when the evidence row reflects a private-company holding.
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
        r.method AS adviser_resolution_method,
        company_status_at_date(p.company_slug, p.as_of_date) AS status_at_evidence_date,
        (company_status_at_date(p.company_slug, p.as_of_date) = 'private') AS was_private_at_evidence_date
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
        r.method AS adviser_resolution_method,
        company_status_at_date(f.company_slug, f.filing_date) AS status_at_evidence_date,
        (company_status_at_date(f.company_slug, f.filing_date) = 'private') AS was_private_at_evidence_date
    FROM intel_formd_pooled_vehicle_offering f
    LEFT JOIN intel_adviser_resolution r
        ON r.source_table = 'intel_formd_pooled_vehicle_offering' AND r.source_id = f.offering_id;
