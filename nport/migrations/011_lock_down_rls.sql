-- 011_lock_down_rls.sql
--
-- Lock the entire N-PORT project down to service-role-only access.
--
-- Why (systemic review 2026-06-10, security finding): every table in this
-- project was created via the SQL editor, which leaves ROW LEVEL SECURITY
-- disabled. Supabase's default grants give the `anon` and `authenticated`
-- roles full CRUD on RLS-disabled tables in `public` — so anyone holding
-- the project's anon key (publishable by design) could read and write
-- crm_*, intel_*, nport_*, everything. The anon key is not currently
-- distributed anywhere (verified across both worktrees + git history),
-- which is the only reason this wasn't exploitable — a loaded gun with
-- the safety on. This migration removes the gun.
--
-- Effect: only the service_role key (held in .env.nport, never committed)
-- can touch the data. The nport API server and all Python pipeline scripts
-- already use the service key, so NOTHING breaks.
--
-- Apply: paste into the Supabase SQL editor for project figvonwrlcpveyceengf
-- and run. Idempotent — safe to re-run.

BEGIN;

-- 1. Enable RLS on every base table in public. With RLS on and zero
--    policies defined, anon/authenticated get nothing even where legacy
--    grants exist. service_role bypasses RLS entirely.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- 2. Belt and braces: revoke the grants themselves from anon/authenticated
--    on everything that exists today (tables, views, matviews, sequences,
--    functions — "ALL TABLES" covers views and materialized views).
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- 3. And on everything created in the future.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification (run after):
--   SELECT count(*) FILTER (WHERE rowsecurity) AS rls_on,
--          count(*)                            AS total
--   FROM pg_tables WHERE schemaname = 'public';
--   -- expect rls_on = total
--
-- And from a shell WITHOUT the service key (using the project's anon key):
--   curl "$SUPABASE_URL_NPORT/rest/v1/crm_person?select=person_id&limit=1" \
--        -H "apikey: <anon key>"
--   -- expect: [] or a 401/permission error, never data.
