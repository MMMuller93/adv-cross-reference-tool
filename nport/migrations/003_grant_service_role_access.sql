-- Grant backend ingestion/API access for Supabase Data API calls.
--
-- The N-PORT ingestion jobs use the Supabase service-role or secret API key
-- from server-side environments only. These grants do not expose tables to
-- anon/authenticated clients and do not create public read policies.

-- Supabase projects already define this role. Local Postgres integration tests
-- do not, so create a no-login placeholder when needed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
ON ALL TABLES IN SCHEMA public
TO service_role;

GRANT USAGE, SELECT, UPDATE
ON ALL SEQUENCES IN SCHEMA public
TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT USAGE, SELECT, UPDATE
ON SEQUENCES TO service_role;
