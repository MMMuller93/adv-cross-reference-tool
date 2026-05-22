-- 009_formd_manager_resolution.sql
--
-- Adds a SECOND adviser-resolution path for Form D pooled-vehicle offerings
-- where the manager is NOT a SEC-registered investment adviser (no CRD)
-- but IS a discovered VC/PE manager in the PFR `enriched_managers` table.
--
-- Live failure cases that motivated this:
--   "Kaleida Capital Anthropic SPV I a Series of CGF2021 LLC"
--     → manager is Kaleida Capital (kaleidacapital.com), unregistered, prefix-extracted
--   "ANTHROPIC - A SERIES OF AURUM VP FUND LLC"
--     → manager is AURUM VP FUND LLC, unregistered, "series of" extracted
--
-- Why a parallel resolution table (not polymorphic columns on
-- intel_adviser_resolution): Codex review 2026-05-22 — extending
-- intel_adviser_resolution with manager_kind risks bad joins and silent
-- semantic bugs across downstream readers that assume crd IS NOT NULL.
-- Parallel table + UNION ALL in v_intel_company_holders is cleaner.
--
-- Schema:
--   intel_formd_manager_resolution
--     resolution_id        — surrogate PK
--     source_table         — always 'intel_formd_pooled_vehicle_offering' for now
--     source_id            — FK to that table's offering_id
--     enriched_manager_id  — FK to formd-db enriched_managers.id (UUID)
--     manager_display_name — denormalized for view performance
--     manager_kind         — 'series_master' | 'prefix' | 'related_party' | 'manual'
--     match_method         — 'series_of_extracted' | 'prefix_extracted' |
--                            'related_name_bridge' | 'platform_admin_fallback' |
--                            'manual'
--     confidence           — 'high' | 'medium' | 'low'
--     evidence_snippet     — TEXT (truncated, for audit)
--     materialized_at      — when this resolution was last written

CREATE TABLE IF NOT EXISTS intel_formd_manager_resolution (
    resolution_id        BIGSERIAL PRIMARY KEY,
    source_table         TEXT        NOT NULL,
    source_id            BIGINT      NOT NULL,
    enriched_manager_id  UUID        NOT NULL,
    manager_display_name TEXT        NOT NULL,
    manager_kind         TEXT        NOT NULL CHECK (manager_kind IN (
                              'series_master', 'prefix', 'related_party', 'manual'
                          )),
    match_method         TEXT        NOT NULL,
    confidence           TEXT        NOT NULL DEFAULT 'medium'
                              CHECK (confidence IN ('high', 'medium', 'low')),
    evidence_snippet     TEXT,
    materialized_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One resolution per (source_table, source_id). Update via upsert.
    CONSTRAINT intel_formd_manager_resolution_uq
        UNIQUE (source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_intel_formd_manager_resolution_source
    ON intel_formd_manager_resolution (source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_intel_formd_manager_resolution_manager
    ON intel_formd_manager_resolution (enriched_manager_id);

COMMENT ON TABLE intel_formd_manager_resolution IS
    'Resolution of Form D pooled-vehicle offerings to DISCOVERED managers '
    '(VC/PE firms in enriched_managers, not in SEC adviser registry). '
    'Companion to intel_adviser_resolution which handles CRD-registered advisers.';

-- Extend v_intel_company_holders to surface discovered managers via UNION.
-- Existing CRD-resolved rows keep their current shape (adviser_crd populated,
-- adviser_resolution_method='crd-direct' etc.). New rows surface with
-- adviser_crd=NULL and discovered_manager_id populated.

DROP VIEW IF EXISTS v_intel_company_holders;

CREATE VIEW v_intel_company_holders AS
    -- N-PORT positions (unchanged — they always resolve via CRD)
    SELECT
        p.company_slug,
        'nport'                                                     AS source_type,
        p.position_id                                               AS evidence_id,
        p.registrant_cik                                            AS evidence_cik,
        p.series_id                                                 AS evidence_series_id,
        p.issuer_title                                              AS evidence_label,
        p.value_usd,
        p.as_of_date                                                AS evidence_date,
        p.accession_number,
        r.crd                                                       AS adviser_crd,
        r.method                                                    AS adviser_resolution_method,
        NULL::UUID                                                  AS discovered_manager_id,
        NULL::TEXT                                                  AS discovered_manager_name,
        NULL::TEXT                                                  AS discovered_manager_kind,
        company_status_at_date(p.company_slug, p.as_of_date)        AS status_at_evidence_date,
        (company_status_at_date(p.company_slug, p.as_of_date) = 'private')
                                                                    AS was_private_at_evidence_date
    FROM intel_nport_position p
    LEFT JOIN intel_adviser_resolution r
        ON r.source_table = 'intel_nport_position' AND r.source_id = p.position_id

    UNION ALL

    -- Form D pooled-vehicle offerings — CRD-resolved (existing path)
    SELECT
        f.company_slug,
        'formd_pooled_vehicle'                                      AS source_type,
        f.offering_id                                               AS evidence_id,
        f.filer_cik                                                 AS evidence_cik,
        NULL                                                        AS evidence_series_id,
        f.filer_entityname                                          AS evidence_label,
        f.total_offering_amount                                     AS value_usd,
        f.filing_date                                               AS evidence_date,
        f.accession_number,
        r.crd                                                       AS adviser_crd,
        r.method                                                    AS adviser_resolution_method,
        NULL::UUID                                                  AS discovered_manager_id,
        NULL::TEXT                                                  AS discovered_manager_name,
        NULL::TEXT                                                  AS discovered_manager_kind,
        company_status_at_date(f.company_slug, f.filing_date)       AS status_at_evidence_date,
        (company_status_at_date(f.company_slug, f.filing_date) = 'private')
                                                                    AS was_private_at_evidence_date
    FROM intel_formd_pooled_vehicle_offering f
    INNER JOIN intel_adviser_resolution r
        ON r.source_table = 'intel_formd_pooled_vehicle_offering' AND r.source_id = f.offering_id

    UNION ALL

    -- Form D pooled-vehicle offerings — DISCOVERED-manager-resolved (new path)
    -- This branch fires when the offering has NO CRD-bridge row but DOES
    -- have a discovered-manager bridge in intel_formd_manager_resolution.
    SELECT
        f.company_slug,
        'formd_pooled_vehicle'                                      AS source_type,
        f.offering_id                                               AS evidence_id,
        f.filer_cik                                                 AS evidence_cik,
        NULL                                                        AS evidence_series_id,
        f.filer_entityname                                          AS evidence_label,
        f.total_offering_amount                                     AS value_usd,
        f.filing_date                                               AS evidence_date,
        f.accession_number,
        NULL::TEXT                                                  AS adviser_crd,
        m.match_method                                              AS adviser_resolution_method,
        m.enriched_manager_id                                       AS discovered_manager_id,
        m.manager_display_name                                      AS discovered_manager_name,
        m.manager_kind                                              AS discovered_manager_kind,
        company_status_at_date(f.company_slug, f.filing_date)       AS status_at_evidence_date,
        (company_status_at_date(f.company_slug, f.filing_date) = 'private')
                                                                    AS was_private_at_evidence_date
    FROM intel_formd_pooled_vehicle_offering f
    INNER JOIN intel_formd_manager_resolution m
        ON m.source_table = 'intel_formd_pooled_vehicle_offering' AND m.source_id = f.offering_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM intel_adviser_resolution r
        WHERE r.source_table = 'intel_formd_pooled_vehicle_offering'
          AND r.source_id = f.offering_id
    )

    UNION ALL

    -- Form D pooled-vehicle offerings — UNRESOLVED (existing "—" path)
    -- This branch fires only when there's NEITHER a CRD bridge NOR a
    -- discovered-manager bridge. Keeps the offering visible in the holders
    -- table with adviser_crd=NULL and discovered_manager_id=NULL so the
    -- UI can show the filing with a "manager unknown" indicator.
    SELECT
        f.company_slug,
        'formd_pooled_vehicle'                                      AS source_type,
        f.offering_id                                               AS evidence_id,
        f.filer_cik                                                 AS evidence_cik,
        NULL                                                        AS evidence_series_id,
        f.filer_entityname                                          AS evidence_label,
        f.total_offering_amount                                     AS value_usd,
        f.filing_date                                               AS evidence_date,
        f.accession_number,
        NULL::TEXT                                                  AS adviser_crd,
        NULL::TEXT                                                  AS adviser_resolution_method,
        NULL::UUID                                                  AS discovered_manager_id,
        NULL::TEXT                                                  AS discovered_manager_name,
        NULL::TEXT                                                  AS discovered_manager_kind,
        company_status_at_date(f.company_slug, f.filing_date)       AS status_at_evidence_date,
        (company_status_at_date(f.company_slug, f.filing_date) = 'private')
                                                                    AS was_private_at_evidence_date
    FROM intel_formd_pooled_vehicle_offering f
    WHERE NOT EXISTS (
        SELECT 1
        FROM intel_adviser_resolution r
        WHERE r.source_table = 'intel_formd_pooled_vehicle_offering'
          AND r.source_id = f.offering_id
    )
    AND NOT EXISTS (
        SELECT 1
        FROM intel_formd_manager_resolution m
        WHERE m.source_table = 'intel_formd_pooled_vehicle_offering'
          AND m.source_id = f.offering_id
    );

COMMENT ON VIEW v_intel_company_holders IS
    'Unified holders view: N-PORT positions + Form D pooled vehicles. '
    'Form D offerings appear in one of three branches: CRD-resolved '
    '(via intel_adviser_resolution), discovered-manager-resolved '
    '(via intel_formd_manager_resolution → enriched_managers), or '
    'unresolved (manager-unknown). The UI surfaces (adviser_crd OR '
    'discovered_manager_id OR neither) per row.';
