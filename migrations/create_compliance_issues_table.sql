-- Compliance Issues Table
-- Tracks discrepancies between Form D filings and Form ADV filings
-- Created: 2026-01-05

CREATE TABLE IF NOT EXISTS compliance_issues (
    id BIGSERIAL PRIMARY KEY,

    -- Links to related entities
    fund_reference_id TEXT,  -- ReferenceID (PFID) from funds_enriched
    adviser_crd TEXT,         -- CRD from advisers_enriched
    form_d_cik TEXT,          -- CIK from form_d_filings (if applicable)

    -- Issue classification
    discrepancy_type TEXT NOT NULL CHECK (discrepancy_type IN (
        'needs_initial_adv_filing',
        'overdue_annual_amendment',
        'vc_exemption_violation',
        'fund_type_mismatch',
        'missing_fund_in_adv',
        'exemption_mismatch'
    )),

    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'ignored', 'reviewing')),

    -- Issue details
    description TEXT NOT NULL,  -- Factual description, no editorialization
    metadata JSONB,             -- Type-specific details (dates, values, etc.)

    -- Tracking
    detected_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    resolved_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_compliance_issues_fund_ref ON compliance_issues(fund_reference_id);
CREATE INDEX IF NOT EXISTS idx_compliance_issues_adviser_crd ON compliance_issues(adviser_crd);
CREATE INDEX IF NOT EXISTS idx_compliance_issues_type ON compliance_issues(discrepancy_type);
CREATE INDEX IF NOT EXISTS idx_compliance_issues_status ON compliance_issues(status);
CREATE INDEX IF NOT EXISTS idx_compliance_issues_severity ON compliance_issues(severity);
CREATE INDEX IF NOT EXISTS idx_compliance_issues_detected_date ON compliance_issues(detected_date DESC);

-- Composite index for common query pattern
CREATE INDEX IF NOT EXISTS idx_compliance_issues_status_type ON compliance_issues(status, discrepancy_type);

-- Enable Row Level Security
ALTER TABLE compliance_issues ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Allow all authenticated users to read
CREATE POLICY "Allow authenticated read access" ON compliance_issues
    FOR SELECT
    TO authenticated
    USING (true);

-- RLS Policy: Allow anon users to read (for API)
CREATE POLICY "Allow anon read access" ON compliance_issues
    FOR SELECT
    TO anon
    USING (true);

-- RLS Policy: Allow anon users to insert (for detection script)
CREATE POLICY "Allow anon insert access" ON compliance_issues
    FOR INSERT
    TO anon
    WITH CHECK (true);

-- RLS Policy: Allow anon users to delete (for detection script to clear old issues)
CREATE POLICY "Allow anon delete access" ON compliance_issues
    FOR DELETE
    TO anon
    USING (true);

-- RLS Policy: Allow service role full access
CREATE POLICY "Allow service role full access" ON compliance_issues
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Updated trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_compliance_issues_updated_at
    BEFORE UPDATE ON compliance_issues
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add comments for documentation
COMMENT ON TABLE compliance_issues IS 'Tracks regulatory compliance discrepancies between Form D and Form ADV filings';
COMMENT ON COLUMN compliance_issues.discrepancy_type IS 'Type of compliance issue detected';
COMMENT ON COLUMN compliance_issues.metadata IS 'JSON object with type-specific details (filing dates, amounts, etc.)';
COMMENT ON COLUMN compliance_issues.description IS 'Factual description without editorialization or speculation';
