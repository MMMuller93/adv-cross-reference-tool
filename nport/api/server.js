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
  const mobileIndex = path.join(frontendDir, 'mobile.html');
  app.use('/', express.static(frontendDir));

  const nportRoutes = require('./routes/nport');
  app.use('/api/nport', nportRoutes);

  const intelRoutes = require('./routes/intel');
  app.use('/api/intel', intelRoutes);

  // Mobile-first /m/* views — single mobile.html, client-side routed.
  app.get('/m', (_req, res) => res.sendFile(mobileIndex));
  app.get('/m/funds', (_req, res) => res.sendFile(mobileIndex));
  app.get('/m/filings', (_req, res) => res.sendFile(mobileIndex));
  app.get('/m/filing/:accession', (_req, res) => res.sendFile(mobileIndex));
  app.get('/m/holdings', (_req, res) => res.sendFile(mobileIndex));
  app.get('/m/private-cos', (_req, res) => res.sendFile(mobileIndex));

  app.get('/company/:slug', (_req, res) => res.sendFile(frontendIndex));
  // /intel/* SPA fallback routes. The React router picks which page to
  // render based on pathname. Cross-cutting routes added 2026-05-26.
  app.get('/intel', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/search', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/companies', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/managers', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/funds', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/spvs', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/people', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/timeline', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/fund/:accession', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/adviser/:crd', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/discovered/:id', (_req, res) => res.sendFile(frontendIndex));
  // CRM routes (must be before the generic /intel/:slug catch-all)
  app.get('/intel/crm', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/crm/deals', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/crm/person/:id', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/:slug', (_req, res) => res.sendFile(frontendIndex));
  app.get('/fund/:cik', (_req, res) => res.sendFile(frontendIndex));
  app.get('/fund/:cik/:series_id', (_req, res) => res.sendFile(frontendIndex));
  app.get('/admin/unresolved', (_req, res) => res.sendFile(frontendIndex));

  // If NPORT_PG_CONN is set, swap the routes' supabase client for the
  // local-postgres shim so the same routes work against a dev DB.
  if (process.env.NPORT_PG_CONN) {
    const { createPgShim } = require('./db/pg_shim');
    const pgClient = createPgShim(process.env.NPORT_PG_CONN);
    nportRoutes.deps.nportClient = pgClient;
    nportRoutes.deps.isConfigured = () => true;
    intelRoutes.deps.nportClient = pgClient;
    intelRoutes.deps.isConfigured = () => true;
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
