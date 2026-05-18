-- Migration: Add enrichment v3 columns to enriched_managers
-- Date: 2026-05-14
-- Do NOT run in production without review. Leave for human approval.
--
-- These columns support the per-field evidence model and auto-retry scheduling
-- introduced by enrichment_engine_v3. Existing flat columns (website_url,
-- linkedin_company_url, team_members, etc.) are preserved for backward compatibility.

ALTER TABLE enriched_managers
  ADD COLUMN IF NOT EXISTS field_evidence   JSONB,
  ADD COLUMN IF NOT EXISTS candidates       JSONB,
  ADD COLUMN IF NOT EXISTS last_retry_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_anchor  TEXT[];

-- Index for retry runner to efficiently find managers due for re-enrichment.
-- Partial index: only indexes rows where next_retry_at is set (non-null).
CREATE INDEX IF NOT EXISTS idx_enriched_managers_next_retry
  ON enriched_managers (next_retry_at)
  WHERE next_retry_at IS NOT NULL;

-- Comment on new columns for documentation
COMMENT ON COLUMN enriched_managers.field_evidence IS
  'Per-field evidence + status (verified|candidate|rejected). See ENRICHMENT_REBUILD_DESIGN.md §3.';

COMMENT ON COLUMN enriched_managers.candidates IS
  'Below-bar evidence for next retry. Never returned in public API. Same shape as field_evidence entries.';

COMMENT ON COLUMN enriched_managers.last_retry_at IS
  'Timestamp of last enrichment attempt (v3 pipeline).';

COMMENT ON COLUMN enriched_managers.next_retry_at IS
  'Scheduled next retry. NULL = no retry scheduled (either done or max retries hit).';

COMMENT ON COLUMN enriched_managers.verified_anchor IS
  'Which anchor(s) verified the identity: sec_adv_crd | website_self | linkedin_self';

-- v3_status: rich internal status from enrichment v3 pipeline.
-- Does NOT modify the existing CHECK constraint on enrichment_status,
-- which continues to use legacy values (auto_enriched, needs_manual_review, etc.)
ALTER TABLE enriched_managers
  ADD COLUMN IF NOT EXISTS v3_status TEXT;

COMMENT ON COLUMN enriched_managers.v3_status IS
  'v3-pipeline status: verified | partial | candidates_only | no_data. Internal use only.';

-- retry_count: number of retry attempts completed for this manager.
-- Replaces the approximation that was derived from date arithmetic.
ALTER TABLE enriched_managers
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN enriched_managers.retry_count IS
  'How many auto-retry enrichment attempts have run for this manager.';
