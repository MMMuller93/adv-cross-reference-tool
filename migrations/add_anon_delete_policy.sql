-- Add DELETE policy for anon role on compliance_issues table
-- This allows the detection script to clear old issues before inserting new ones
-- Run this on the Form D database (ltdalxkhbbhmkimmogyq.supabase.co)
-- Created: 2026-01-07

-- Add the policy (will fail silently if it already exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'compliance_issues'
        AND policyname = 'Allow anon delete access'
    ) THEN
        CREATE POLICY "Allow anon delete access" ON compliance_issues
            FOR DELETE
            TO anon
            USING (true);
        RAISE NOTICE 'Created "Allow anon delete access" policy on compliance_issues';
    ELSE
        RAISE NOTICE 'Policy "Allow anon delete access" already exists on compliance_issues';
    END IF;
END
$$;
