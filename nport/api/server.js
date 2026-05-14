#!/usr/bin/env node
/**
 * N-PORT standalone HTTP server.
 *
 * Runs on port 3010 by default (separate from the main PFR server on
 * 3009). The main PFR server.js does NOT mount these routes — that's a
 * deliberate isolation choice so this subsystem can be developed,
 * tested, and deployed independently. Integration into the main app is a
 * separate decision later.
 *
 * Two backends are supported:
 *   1. Supabase (production) — set SUPABASE_URL_NPORT and
 *      SUPABASE_SERVICE_KEY_NPORT. The N-PORT Supabase project is not
 *      provisioned yet, so this mode currently returns 503.
 *   2. Local Postgres (development / integration tests) — set
 *      NPORT_PG_CONN to a `postgresql://...` connection string. The
 *      Supabase client is replaced with a tiny supabase-shim built on
 *      `pg` that supports the chained-builder calls used by routes/nport.js.
 *
 * Usage:
 *   PORT=3010 node nport/api/server.js
 *   NPORT_PG_CONN=postgresql://localhost/nport_test node nport/api/server.js
 */

const express = require('express');

const PORT = parseInt(process.env.NPORT_PORT || process.env.PORT || '3010', 10);

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Lightweight CORS for the standalone frontend during development.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'nport-api', port: PORT });
  });

  // Static frontend (../frontend) — convenient single-process dev.
  const path = require('path');
  const frontendDir = path.join(__dirname, '..', 'frontend');
  const frontendIndex = path.join(frontendDir, 'index.html');
  app.use('/', express.static(frontendDir));

  const nportRoutes = require('./routes/nport');
  app.use('/api/nport', nportRoutes);

  app.get('/company/:slug', (_req, res) => res.sendFile(frontendIndex));
  app.get('/fund/:cik/:series_id', (_req, res) => res.sendFile(frontendIndex));
  app.get('/admin/unresolved', (_req, res) => res.sendFile(frontendIndex));

  // If NPORT_PG_CONN is set, swap the routes' supabase client for the
  // local-postgres shim so the same routes work against a dev DB.
  if (process.env.NPORT_PG_CONN) {
    const { createPgShim } = require('./db/pg_shim');
    const pgClient = createPgShim(process.env.NPORT_PG_CONN);
    nportRoutes.deps.nportClient = pgClient;
    nportRoutes.deps.isConfigured = () => true;
  }

  return app;
}

if (require.main === module) {
  const app = buildApp();
  app.listen(PORT, () => {
    console.log(`[nport-api] listening on http://localhost:${PORT}`);
  });
}

module.exports = { buildApp };
