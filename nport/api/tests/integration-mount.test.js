// Smoke test for nport/integration/mount.js — verifies the wire-up function
// can be required and called against a stub Express app, registers the
// expected routes, and respects the options.
//
// Lives in nport/api/tests/ (not nport/integration/) so express resolves
// via nport/api/node_modules — express is a peer dep of any host that
// calls mount(), but we need it in node_modules to run the test.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const mount = require(path.join(__dirname, '..', 'mount.js'));

function stubApp() {
  const handlers = {};
  const mounts = [];
  return {
    use(prefix, handler) {
      mounts.push({ prefix, handler });
    },
    get(routePath, handler) {
      handlers[routePath] = handler;
    },
    _state: { handlers, mounts },
  };
}

test('mount() returns a default config and registers default routes', () => {
  const app = stubApp();
  const result = mount(app);
  assert.equal(result.apiPrefix, '/api/nport');
  assert.equal(result.mountedFrontend, true);
  assert.equal(result.mountedSpa, false);
  // API + frontend static => 2 app.use calls
  assert.equal(app._state.mounts.length, 2);
  assert.equal(app._state.mounts[0].prefix, '/api/nport');
  assert.equal(app._state.mounts[1].prefix, '/nport');
  // Default does NOT register SPA routes
  assert.equal(Object.keys(app._state.handlers).length, 0);
});

test('mount() with mountSpaRoutes=true adds /company, /fund/:cik/:series_id, /admin/unresolved', () => {
  const app = stubApp();
  const result = mount(app, { mountSpaRoutes: true });
  assert.equal(result.mountedSpa, true);
  assert.ok(app._state.handlers['/company/:slug']);
  assert.ok(app._state.handlers['/fund/:cik/:series_id']);
  assert.ok(app._state.handlers['/admin/unresolved']);
});

test('mount() with mountFrontend=false omits static bundle and SPA routes', () => {
  const app = stubApp();
  const result = mount(app, { mountFrontend: false, mountSpaRoutes: true });
  assert.equal(result.mountedFrontend, false);
  assert.equal(result.mountedSpa, false);   // SPA requires frontend; force-disabled
  // Only the API mount, no static
  assert.equal(app._state.mounts.length, 1);
  assert.equal(app._state.mounts[0].prefix, '/api/nport');
  assert.equal(Object.keys(app._state.handlers).length, 0);
});

test('mount() respects custom apiPrefix', () => {
  const app = stubApp();
  const result = mount(app, { apiPrefix: '/v2/nport' });
  assert.equal(result.apiPrefix, '/v2/nport');
  assert.equal(app._state.mounts[0].prefix, '/v2/nport');
});
