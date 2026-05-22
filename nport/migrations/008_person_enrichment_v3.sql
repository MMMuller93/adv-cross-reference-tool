-- Person enrichment v3 (Codex pushback round 2):
--
-- 1. Add provenance + multi-source tracking columns (additive only).
-- 2. Tighten v_intel_person_enrichment to surface confidence='high' rows only.
-- 3. Add twitter_handle column.
-- 4. last_attempt_at lets us avoid re-querying within N days.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DROP VIEW + CREATE VIEW.
-- (CREATE OR REPLACE VIEW can't reorder columns; we drop + recreate.)

ALTER TABLE intel_person_enrichment
    ADD COLUMN IF NOT EXISTS source_table TEXT,
    ADD COLUMN IF NOT EXISTS source_role TEXT,
    ADD COLUMN IF NOT EXISTS evidence_url TEXT,
    ADD COLUMN IF NOT EXISTS evidence_snippet TEXT,
    ADD COLUMN IF NOT EXISTS twitter_handle TEXT,
    ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- Drop + recreate the view. CREATE OR REPLACE VIEW errors when column
-- order/identity changes vs the existing view; DROP avoids that.
DROP VIEW IF EXISTS v_intel_person_enrichment;

CREATE VIEW v_intel_person_enrichment AS
SELECT
    adviser_crd,
    normalized_name,
    role_hint,
    linkedin_url,
    inferred_title,
    inferred_email,
    confidence,
    enriched_at,
    -- new in v3:
    twitter_handle,
    source_table,
    source_role,
    evidence_url,
    evidence_snippet,
    last_attempt_at
FROM intel_person_enrichment
WHERE confidence = 'high';

GRANT SELECT ON v_intel_person_enrichment TO authenticated, anon;
