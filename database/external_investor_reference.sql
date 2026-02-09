-- External Investor Reference Table
-- Combined OpenVC + Ramp investor database for pre-enrichment lookups
-- Created: 2026-02-09

CREATE TABLE IF NOT EXISTS external_investor_reference (
  id SERIAL PRIMARY KEY,
  investor_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,

  -- Contact & Web
  website_url TEXT,
  primary_contact_email TEXT,
  contact_name TEXT,
  linkedin_url TEXT,
  twitter_url TEXT,

  -- Investment Profile
  investor_type TEXT,
  investment_stage TEXT,
  investment_sectors TEXT[],
  investment_thesis TEXT,
  geography_focus TEXT,
  countries_of_investment TEXT[],

  -- Fund Details
  check_size_min_usd INT,
  check_size_max_usd INT,
  portfolio_companies TEXT[],
  portfolio_count INT,
  founded_year INT,
  hq_location TEXT,
  description TEXT,

  -- Provenance
  source TEXT NOT NULL,
  openvc_record BOOLEAN DEFAULT false,
  ramp_record BOOLEAN DEFAULT false,
  imported_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_normalized_name UNIQUE(normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_ext_inv_norm ON external_investor_reference(normalized_name);
CREATE INDEX IF NOT EXISTS idx_ext_inv_type ON external_investor_reference(investor_type);
