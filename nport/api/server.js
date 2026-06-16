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

  // CORS: the frontend is served same-origin by this process, so no
  // cross-origin grants are needed. The old wildcard
  // (Access-Control-Allow-Origin: *) was removed 2026-06-10 per the
  // systemic security review — it let any website script the API from a
  // visitor's browser. If a separate dev origin ever needs access, allow
  // it explicitly via INTEL_CORS_ORIGIN.
  const corsOrigin = process.env.INTEL_CORS_ORIGIN || null;
  if (corsOrigin) {
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'nport-api', port: PORT });
  });

  // HTTP Basic auth on everything except /health. Credentials come from
  // INTEL_BASIC_USER / INTEL_BASIC_PASS (set in .env.nport). Basic was
  // chosen over an API key because the browser replays credentials
  // automatically — zero changes needed across the frontend's fetch()
  // call sites. If the env vars are missing the server still runs but
  // logs a loud warning each boot (local-dev affordance; set the vars).
  const BASIC_USER = process.env.INTEL_BASIC_USER || '';
  const BASIC_PASS = process.env.INTEL_BASIC_PASS || '';
  if (BASIC_USER && BASIC_PASS) {
    const expected = 'Basic ' + Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString('base64');
    app.use((req, res, next) => {
      if (req.path === '/health') return next();
      const got = req.headers.authorization || '';
      // timing-safe-ish compare; payloads are small and same-length check first
      const ok = got.length === expected.length &&
        require('crypto').timingSafeEqual(Buffer.from(got), Buffer.from(expected));
      if (ok) return next();
      res.setHeader('WWW-Authenticate', 'Basic realm="intel"');
      return res.status(401).json({ error: 'authentication required' });
    });
  } else {
    console.warn('[nport-api] WARNING: INTEL_BASIC_USER/INTEL_BASIC_PASS not set — API is UNAUTHENTICATED. Set them in .env.nport.');
  }

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
  app.get('/intel/crm/company/:slug', (_req, res) => res.sendFile(frontendIndex));
  app.get('/intel/crm/firms/:id', (_req, res) => res.sendFile(frontendIndex));
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
