-- Normalized N-CEN adviser/subadviser links.
--
-- N-CEN filings can contain one adviser block per fund series and multiple
-- subadvisers per series. The legacy fund_ncen_records table is retained as a
-- filing-level summary, but this table is the authoritative source for
-- series-level N-CEN -> ADV CRD joins.

CREATE TABLE IF NOT EXISTS fund_ncen_adviser_links (
  link_key                  text PRIMARY KEY,
  accession_number          text NOT NULL,
  registrant_cik            text NOT NULL,
  series_id                 text,
  series_name               text,
  series_lei                text,
  filing_date               date NOT NULL,
  fiscal_year_end           date,
  adviser_role              text NOT NULL CHECK (adviser_role IN ('investment_adviser', 'subadviser')),
  adviser_name              text,
  adviser_crd_raw           text,
  adviser_crd_normalized    text,
  adviser_lei               text,
  adviser_file_no           text,
  adviser_rssd_id           text,
  adviser_country           text,
  adviser_state             text,
  is_affiliated             boolean,
  fund_type                 text,
  source_url                text,
  ingested_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_ncen_links_cik_series
  ON fund_ncen_adviser_links (registrant_cik, series_id, filing_date DESC);

CREATE INDEX IF NOT EXISTS ix_ncen_links_adv_crd
  ON fund_ncen_adviser_links (adviser_crd_normalized)
  WHERE adviser_crd_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_ncen_links_accession
  ON fund_ncen_adviser_links (accession_number);

GRANT SELECT, INSERT, UPDATE, DELETE
ON fund_ncen_adviser_links
TO service_role;
