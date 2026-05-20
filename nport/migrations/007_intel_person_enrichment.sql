-- Fund Holders Intel — per-person enrichment (V1)
--
-- Stores web-search results for individual people named in Form ADV
-- (owners, CCOs, signatories, control persons, regulatory contacts). The
-- per-person lookup is run out-of-band by intelligence/enrich_people.py,
-- which reuses PFR's existing Brave/Google search infrastructure to
-- find a LinkedIn URL plus optional title/email signals.
--
-- The intel API JOINs this table on (adviser_crd, normalized_name) and
-- surfaces the LinkedIn URL on the intel page next to the person's name.
--
-- Identity key: (adviser_crd, normalized_name).
--   - adviser_crd anchors the person to a specific firm. The same first/
--     last name can map to different people at different firms.
--   - normalized_name is the person's name after the name_normalizer
--     pass ('David Oestreicher' not 'OESTREICHER, DAVID, NMN'), so the
--     API can JOIN without re-parsing on every request.
--
-- Idempotent: enrich_people.py upserts on (adviser_crd, normalized_name).
-- Confidence: 'high' = matched LinkedIn profile with firm-name match in
-- profile text; 'medium' = matched but firm-name confidence is weaker;
-- 'low' = best-effort, not surfaced in default UI.

CREATE TABLE IF NOT EXISTS intel_person_enrichment (
    id BIGSERIAL PRIMARY KEY,
    adviser_crd TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    role_hint TEXT,            -- 'owner' | 'cco' | 'signatory' | 'control' | 'regulatory' | NULL
    linkedin_url TEXT,
    inferred_title TEXT,
    inferred_email TEXT,
    confidence TEXT,           -- 'high' | 'medium' | 'low'
    source TEXT,               -- 'brave' | 'google' | 'manual' | etc.
    raw_search_hit JSONB,      -- store full payload for audit
    enriched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (adviser_crd, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_intel_person_enrichment_crd
    ON intel_person_enrichment (adviser_crd);

CREATE INDEX IF NOT EXISTS idx_intel_person_enrichment_confidence
    ON intel_person_enrichment (confidence);

-- Convenience: a queryable view that the API can SELECT from with one
-- round trip per adviser-CRD batch.
CREATE OR REPLACE VIEW v_intel_person_enrichment AS
SELECT adviser_crd, normalized_name, role_hint, linkedin_url, inferred_title,
       inferred_email, confidence, enriched_at
FROM intel_person_enrichment
WHERE confidence IN ('high', 'medium');

GRANT SELECT ON intel_person_enrichment TO authenticated, anon;
GRANT SELECT ON v_intel_person_enrichment TO authenticated, anon;
