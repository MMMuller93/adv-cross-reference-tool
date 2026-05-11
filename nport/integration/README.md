# N-PORT Integration Guide

Wire the N-PORT subsystem into the main Private Funds Radar Express server.

## Why this exists

The `nport-buildout-claude` branch is **strictly isolated** — running its tests, schema, and standalone Express server (port 3010) requires zero modifications to existing PFR files. That isolation is enforced by branch-level diff audit.

When you're ready to expose `/api/nport/*` and the N-PORT pages from the main PFR server (port 3009, the one production serves from), you add **one line** to `server.js`. This module makes that one line work.

## The one-line integration

In `server.js`, after the other `app.use(...)` calls (good spot: just after the `enrichmentRoutes` mount around line 1727):

```javascript
require('./nport/api/mount')(app);
```

That's the whole change. After deploying:

- `GET /api/nport/companies/anthropic` returns the rollup
- `GET /nport/` serves the standalone N-PORT frontend (Company / Fund / Admin pages)
- `nport/frontend/index.html` is served at `/nport/`

## Options

```javascript
require('./nport/api/mount')(app, {
  apiPrefix:      '/api/nport',  // change API prefix if needed
  mountFrontend:  true,          // serve nport/frontend/* at /nport
  mountSpaRoutes: false,         // attach /company/:slug etc. to main app
});
```

`mountSpaRoutes: true` adds three SPA routes that fall through to the N-PORT frontend's index.html:

- `GET /company/:slug`
- `GET /fund/:cik/:series_id`  ← two-segment, distinct from PFR's existing `/fund/:slug`
- `GET /admin/unresolved`

**Why it's opt-in:** PFR already has a single-segment `/fund/:slug` SEO route. The N-PORT route is two-segment so Express disambiguates them, but you should audit your route order (this mount call should come AFTER the existing `/fund/:slug` registration) before enabling.

## What it doesn't do

- **Modify your existing React app** (`public/app.js`). The N-PORT pages are a standalone static bundle at `/nport/`, not mounted into your main React tree. If you want them to render *inside* the existing `<App />` instead of at a separate URL prefix, see the alternative wire-up below.
- **Set environment variables.** The N-PORT subsystem reads `SUPABASE_URL_NPORT` and `SUPABASE_SERVICE_KEY_NPORT` from process env. Add them to your `.env` before requesting `/api/nport/*` — the routes return `503 NPORT_NOT_CONFIGURED` until they exist.
- **Run database migrations.** See `nport/migrations/README.md`.

## Alternative: render N-PORT pages inside the existing React app

If you want `/company/anthropic` to render via the existing `<App />` (so the N-PORT pages share the same chrome/header/nav as the rest of PFR), you'll need three small edits to existing files — these are the additions from the parallel `codex/nport-stabilize` branch:

**`public/index.html`** (add before the existing `app.js` script tag):
```html
<script src="/mocks/nport.js?v=1.0.0"></script>
<script type="text/babel" src="/nport_pages.js?v=1.0.0"></script>
```

**`public/app.js`** (replace the final `ReactDOM.render` call):
```javascript
const __nportRoute = (typeof window.matchNportRoute === 'function')
  ? window.matchNportRoute(window.location.pathname) : null;
if (__nportRoute && typeof window.NportRouter === 'function') {
  ReactDOM.render(<window.NportRouter />, document.getElementById('root'));
} else {
  ReactDOM.render(<App />, document.getElementById('root'));
}
```

**`server.js`** (in addition to the one-line mount above): copy `nport/frontend/nport_pages.js` and `nport/frontend/mocks/nport.js` to `public/` so the script tags resolve.

This loses the isolation property — those three files are pre-existing PFR files. Don't do it on `nport-buildout-claude`. Branch off, do it there, deploy with eyes open.

## Verifying the integration works

After adding the one line and rebooting:

```bash
curl -s http://localhost:3009/api/nport/companies | head -c 200
# Expect: {"error":"NPORT_NOT_CONFIGURED",...} until you set env vars
# After setting env vars + provisioning Supabase project: JSON list of companies

curl -s http://localhost:3009/nport/ | head -c 200
# Expect: HTML — the N-PORT frontend index page
```

If both respond, integration is live. If you get 404 on `/api/nport/*`, the require path is wrong; if you get 404 on `/nport/`, `mountFrontend` got passed `false`.

## Rollback

Delete the one line from `server.js`. Done. No data loss, no schema impact, no env vars to clean up.
