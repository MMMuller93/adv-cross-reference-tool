/**
 * N-PORT Supabase Client
 *
 * Mirrors the existing client setup pattern in server.js (top-of-file pattern).
 * Reads SUPABASE_URL_NPORT and SUPABASE_SERVICE_KEY_NPORT from env.
 *
 * NOTE: The N-PORT Supabase project does not exist yet. Routes that depend on
 * this client will fail at runtime until those env vars are populated and the
 * project + tables are provisioned per PLAN_NPORT_HOLDINGS.md §4.
 *
 * Per CLAUDE.md pagination rules:
 *   - Read batch size cap: 1000 rows
 *   - Write batch size cap:  500 rows
 *   - Always prefer keyset pagination over OFFSET for tables > 50k rows
 */

const { createClient } = require('@supabase/supabase-js');

const NPORT_SUPABASE_URL = process.env.SUPABASE_URL_NPORT || '';
const NPORT_SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY_NPORT || '';

if (!NPORT_SUPABASE_URL || !NPORT_SUPABASE_KEY) {
  console.warn(
    '[N-PORT] SUPABASE_URL_NPORT / SUPABASE_SERVICE_KEY_NPORT not set — ' +
    'N-PORT routes will return 503 until configured.'
  );
}

// Build client even when env is missing so server.js can still import the
// module at startup. Calls will fail at request time with a clear error.
const nportClient = createClient(
  NPORT_SUPABASE_URL || 'https://placeholder.supabase.co',
  NPORT_SUPABASE_KEY || 'placeholder-key'
);

const READ_PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 500;

function isConfigured() {
  return Boolean(NPORT_SUPABASE_URL && NPORT_SUPABASE_KEY);
}

module.exports = {
  nportClient,
  isConfigured,
  READ_PAGE_SIZE,
  WRITE_BATCH_SIZE,
};
