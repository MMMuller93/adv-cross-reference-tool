-- ============================================================================
-- FUND MANAGER ENRICHMENT DATABASE SCHEMA
-- For storing enriched data from automated and manual research
-- ============================================================================

-- Main enriched managers table
CREATE TABLE IF NOT EXISTS enriched_managers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_master_llc TEXT UNIQUE NOT NULL,

  -- Core enrichment data
  website_url TEXT,
  fund_type TEXT, -- 'VC', 'PE', 'Real Estate', 'Hedge Fund', 'Credit', 'SPV Platform', 'Operating Company', 'Charitable Trust', 'Unknown'
  investment_stage TEXT, -- 'Pre-seed', 'Seed', 'Series A', 'Series B', 'Growth', 'Late-stage', 'Multi-stage'
  investment_sectors TEXT[], -- ['B2B SaaS', 'Fintech', 'Healthcare', 'AI/ML', etc.]
  geography_focus TEXT, -- 'US', 'North America', 'Global', 'Africa', 'Israel', etc.

  -- Location
  headquarters_city TEXT,
  headquarters_state TEXT,
  headquarters_country TEXT,

  -- Contact info
  primary_contact_email TEXT,
  phone_number TEXT,
  linkedin_company_url TEXT,
  twitter_handle TEXT,

  -- Fund details
  fund_size_usd BIGINT,
  check_size_min_usd INT,
  check_size_max_usd INT,
  portfolio_count INT,
  notable_portfolio_companies TEXT[],
  co_investors TEXT[],
  founded_year INT,

  -- Enrichment metadata
  enrichment_status TEXT NOT NULL DEFAULT 'pending',
  -- 'pending', 'auto_enriched', 'needs_manual_review', 'manually_verified', 'no_data_found', 'not_a_fund', 'platform_spv'

  confidence_score DECIMAL(3,2), -- 0.00 to 1.00
  enrichment_source TEXT, -- 'automated', 'manual', 'hybrid'
  enrichment_date TIMESTAMPTZ DEFAULT NOW(),
  last_updated TIMESTAMPTZ DEFAULT NOW(),

  -- Search/research metadata
  search_queries_used TEXT[],
  data_sources TEXT[], -- ['website', 'linkedin', 'crunchbase', 'pitchbook', 'news']
  raw_search_results JSONB, -- Store full results for debugging

  -- Internal review
  internal_notes TEXT,
  flagged_issues TEXT[], -- ['conflicting_sources', 'unclear_fund_type', 'no_team_found', 'website_broken', etc.]
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,

  -- Visibility control (for public vs internal)
  is_published BOOLEAN DEFAULT false, -- Only true for high-confidence auto-enriched or manually verified
  published_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT valid_confidence_score CHECK (confidence_score >= 0 AND confidence_score <= 1),
  CONSTRAINT valid_enrichment_status CHECK (enrichment_status IN (
    'pending', 'auto_enriched', 'needs_manual_review', 'manually_verified',
    'no_data_found', 'not_a_fund', 'platform_spv'
  ))
);

-- Team members table
CREATE TABLE IF NOT EXISTS enriched_team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID NOT NULL REFERENCES enriched_managers(id) ON DELETE CASCADE,

  full_name TEXT NOT NULL,
  title TEXT, -- 'Managing Partner', 'General Partner', 'Partner', 'Principal', 'VP', etc.
  email TEXT,
  linkedin_profile_url TEXT,
  twitter_handle TEXT,
  background_summary TEXT,

  is_key_person BOOLEAN DEFAULT false, -- Managing Partner/GP = true
  display_order INT DEFAULT 0, -- For sorting (MPs first, then GPs, then Partners)

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for team members
CREATE INDEX IF NOT EXISTS idx_team_manager ON enriched_team_members(manager_id);
CREATE INDEX IF NOT EXISTS idx_team_key_person ON enriched_team_members(manager_id, is_key_person);

-- Enrichment queue/history
CREATE TABLE IF NOT EXISTS enrichment_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_master_llc TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed', 'skipped'
  priority INT DEFAULT 5, -- 1-10, higher = more urgent

  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 3,
  last_attempt_at TIMESTAMPTZ,
  error_message TEXT,

  -- Trigger info
  triggered_by TEXT, -- 'cron_job', 'manual', 'webhook', 'bulk_import'
  trigger_date TIMESTAMPTZ DEFAULT NOW(),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped'))
);

-- Indexes for enrichment queue
CREATE INDEX IF NOT EXISTS idx_queue_status ON enrichment_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_priority ON enrichment_queue(priority DESC, created_at ASC);

-- Public view (for published data only)
CREATE OR REPLACE VIEW public_enriched_managers AS
SELECT
  series_master_llc,
  website_url,
  fund_type,
  investment_stage,
  investment_sectors,
  geography_focus,
  headquarters_city,
  headquarters_state,
  headquarters_country,
  primary_contact_email,
  linkedin_company_url,
  fund_size_usd,
  check_size_min_usd,
  check_size_max_usd,
  portfolio_count,
  notable_portfolio_companies,
  founded_year,
  published_at
FROM enriched_managers
WHERE is_published = true
ORDER BY published_at DESC;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_enriched_managers_status ON enriched_managers(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_enriched_managers_fund_type ON enriched_managers(fund_type);
CREATE INDEX IF NOT EXISTS idx_enriched_managers_published ON enriched_managers(is_published);
CREATE INDEX IF NOT EXISTS idx_enriched_managers_confidence ON enriched_managers(confidence_score DESC);
CREATE INDEX IF NOT EXISTS idx_enriched_managers_created ON enriched_managers(created_at DESC);

-- Function to auto-update last_updated timestamp
CREATE OR REPLACE FUNCTION update_last_updated_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_enriched_managers_last_updated
  BEFORE UPDATE ON enriched_managers
  FOR EACH ROW
  EXECUTE FUNCTION update_last_updated_column();

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to add manager to enrichment queue
CREATE OR REPLACE FUNCTION queue_manager_for_enrichment(
  p_series_master_llc TEXT,
  p_priority INT DEFAULT 5,
  p_triggered_by TEXT DEFAULT 'manual'
)
RETURNS UUID AS $$
DECLARE
  v_queue_id UUID;
BEGIN
  INSERT INTO enrichment_queue (series_master_llc, priority, triggered_by)
  VALUES (p_series_master_llc, p_priority, p_triggered_by)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_queue_id;

  RETURN v_queue_id;
END;
$$ LANGUAGE plpgsql;

-- Function to mark enrichment as complete
CREATE OR REPLACE FUNCTION complete_enrichment(
  p_series_master_llc TEXT,
  p_enrichment_status TEXT,
  p_confidence_score DECIMAL DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE enriched_managers
  SET
    enrichment_status = p_enrichment_status,
    confidence_score = COALESCE(p_confidence_score, confidence_score),
    is_published = CASE
      WHEN p_enrichment_status = 'auto_enriched' AND p_confidence_score >= 0.7 THEN true
      WHEN p_enrichment_status = 'manually_verified' THEN true
      ELSE false
    END,
    published_at = CASE
      WHEN p_enrichment_status IN ('auto_enriched', 'manually_verified') THEN NOW()
      ELSE NULL
    END
  WHERE series_master_llc = p_series_master_llc;

  UPDATE enrichment_queue
  SET status = 'completed', completed_at = NOW()
  WHERE series_master_llc = p_series_master_llc AND status = 'processing';

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE enriched_managers IS 'Enriched fund manager data from automated and manual research';
COMMENT ON TABLE enriched_team_members IS 'Team members (GPs, Partners, etc.) for enriched managers';
COMMENT ON TABLE enrichment_queue IS 'Queue for automated enrichment processing';
COMMENT ON COLUMN enriched_managers.confidence_score IS 'Automated confidence score (0-1) based on data quality and source reliability';
COMMENT ON COLUMN enriched_managers.is_published IS 'Whether data is visible in public view (high confidence or manually verified only)';
COMMENT ON COLUMN enriched_managers.enrichment_status IS 'Status: pending, auto_enriched, needs_manual_review, manually_verified, no_data_found, not_a_fund, platform_spv';

-- ============================================================================
-- SAMPLE DATA (for testing)
-- ============================================================================

-- Example: Ben's Bites Fund (from our research)
INSERT INTO enriched_managers (
  series_master_llc,
  website_url,
  fund_type,
  investment_stage,
  investment_sectors,
  geography_focus,
  headquarters_city,
  headquarters_country,
  primary_contact_email,
  linkedin_company_url,
  check_size_min_usd,
  check_size_max_usd,
  portfolio_count,
  notable_portfolio_companies,
  founded_year,
  enrichment_status,
  confidence_score,
  enrichment_source,
  data_sources,
  is_published
) VALUES (
  'Ben''s Bites Fund, LP',
  'https://www.bensbites.com/',
  'VC',
  'Pre-seed to Late-stage',
  ARRAY['AI/ML', 'Infrastructure', 'Developer Tools'],
  'Global',
  'Ampthill',
  'United Kingdom',
  'Via website',
  'https://www.linkedin.com/company/ben-s-bites',
  200000,
  500000,
  17,
  ARRAY['Supabase', 'Flutterflow', 'Etched', 'Pika Labs', 'Gamma', 'Julius'],
  2022,
  'manually_verified',
  0.95,
  'manual',
  ARRAY['website', 'linkedin', 'pitchbook', 'crunchbase'],
  true
) ON CONFLICT (series_master_llc) DO NOTHING;

-- Add team members
INSERT INTO enriched_team_members (manager_id, full_name, title, is_key_person, display_order)
SELECT id, 'Ben Tossell', 'Founder/GP', true, 1
FROM enriched_managers WHERE series_master_llc = 'Ben''s Bites Fund, LP'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- PORTFOLIO COMPANIES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS portfolio_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID REFERENCES enriched_managers(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  company_website TEXT,
  company_logo_url TEXT,
  company_description TEXT,
  investment_stage TEXT, -- Seed, Series A, Series B, Growth, etc.
  investment_date DATE,
  exit_date DATE,
  is_exited BOOLEAN DEFAULT false,
  exit_type TEXT, -- IPO, Acquisition, etc.
  investment_amount_usd NUMERIC(15,2),
  current_valuation_usd NUMERIC(15,2),
  source_url TEXT, -- Where we found this data
  extraction_method TEXT DEFAULT 'web_scraping', -- web_scraping, manual, api
  confidence_score DECIMAL(3,2) DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for portfolio companies
CREATE INDEX IF NOT EXISTS idx_portfolio_companies_manager ON portfolio_companies(manager_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_companies_name ON portfolio_companies(company_name);
CREATE INDEX IF NOT EXISTS idx_portfolio_companies_exited ON portfolio_companies(is_exited);

-- Example portfolio companies (for Ben's Bites Fund)
INSERT INTO portfolio_companies (manager_id, company_name, company_website, company_description, investment_stage, source_url, extraction_method, confidence_score)
SELECT
  id,
  'Example Portfolio Company',
  'https://example.com',
  'AI-powered example company',
  'Seed',
  'https://www.bensbites.com/',
  'manual',
  1.0
FROM enriched_managers
WHERE series_master_llc = 'Ben''s Bites Fund, LP'
LIMIT 1
ON CONFLICT DO NOTHING;