// nport/integration/mount.js
//
// One-line integration point for wiring N-PORT into the main PFR Express app.
//
// Borrowed (adapted) from the codex/nport-stabilize parallel build's
// server.js wire-up. That branch modified main server.js directly. This
// module preserves nport-buildout-claude's strict-isolation property by
// keeping the wire-up inside `nport/` — the consumer adds ONE line to
// main server.js to enable it, and removing the line cleanly disables it.
//
// Usage (in main server.js, after other app.use() calls):
//
//   require('./nport/integration/mount')(app, {
//     apiPrefix: '/api/nport',     // optional, default '/api/nport'
//     mountFrontend: true,          // optional, serve /nport/* static bundle
//     mountSpaRoutes: false,        // optional, attach /company/:slug etc.
//                                   //   to main server (only enable when ready)
//   });
//
// All three options default to safe values: API mounted, frontend mounted
// at /nport, SPA routes NOT attached to the main app. The SPA routes
// option exists because attaching them risks colliding with PFR's
// existing `/fund/:slug` SEO route, which is two-segment-different but
// could be confused if the existing route is ever generalized. Opt in
// explicitly when you've audited that.

const path = require('path');

/**
 * Mount the N-PORT subsystem into a host Express app.
 *
 * @param {import('express').Express} app  The host Express application.
 * @param {object} [opts]
 * @param {string} [opts.apiPrefix='/api/nport']
 * @param {boolean} [opts.mountFrontend=true]
 * @param {boolean} [opts.mountSpaRoutes=false]
 * @returns {{ apiPrefix: string, mountedFrontend: boolean, mountedSpa: boolean }}
 */
function mount(app, opts = {}) {
  const apiPrefix = opts.apiPrefix || '/api/nport';
  const mountFrontend = opts.mountFrontend !== false;
  const mountSpaRoutes = opts.mountSpaRoutes === true;

  // ============================================
  // 1. API routes
  // ============================================
  // db/nport_client.js logs a startup warning if SUPABASE_URL_NPORT or
  // SUPABASE_SERVICE_KEY_NPORT are missing; require it here so that
  // warning fires at mount time, not on first request.
  require('../api/db/nport_client');
  const nportRoutes = require('../api/routes/nport');
  app.use(apiPrefix, nportRoutes);

  // ============================================
  // 2. Frontend static bundle (optional)
  // ============================================
  // Serves nport/frontend/{index.html, nport_pages.js, mocks/nport.js}
  // at /nport/*. The standalone frontend is self-contained — no
  // edits to public/app.js required.
  if (mountFrontend) {
    const express = require('express');
    const frontendDir = path.join(__dirname, '..', 'frontend');
    app.use('/nport', express.static(frontendDir));
  }

  // ============================================
  // 3. SPA routes that fall through to the bundle (opt-in)
  // ============================================
  // Lets users land directly on /company/anthropic etc. Attaching these
  // to the host app risks colliding with PFR's existing single-segment
  // /fund/:slug route — that one is single-segment and the N-PORT one
  // is two-segment (/fund/:cik/:series_id) so Express can disambiguate,
  // but you should audit your route order before enabling.
  if (mountSpaRoutes && mountFrontend) {
    const frontendIndex = path.join(__dirname, '..', 'frontend', 'index.html');
    app.get('/company/:slug', (_req, res) => res.sendFile(frontendIndex));
    app.get('/fund/:cik/:series_id', (_req, res) => res.sendFile(frontendIndex));
    app.get('/admin/unresolved', (_req, res) => res.sendFile(frontendIndex));
  }

  return {
    apiPrefix,
    mountedFrontend: mountFrontend,
    mountedSpa: mountSpaRoutes && mountFrontend,
  };
}

module.exports = mount;
module.exports.mount = mount;
