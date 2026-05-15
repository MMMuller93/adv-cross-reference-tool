/**
 * Tests for routes/nport.js using node:test + a mock Supabase client.
 *
 * After Bug 5 fixes, every table name referenced by the routes matches
 * the actual schema in migrations/001_create_schema.sql. The mock
 * fixtures below mirror those tables exactly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const nportRoutes = require('../routes/nport');

// ---------------------------------------------------------------------------
// HTTP test client (~supertest-lite)
// ---------------------------------------------------------------------------

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/nport', nportRoutes);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function request(baseUrl, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'content-type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Supabase chainable-builder mock
// ---------------------------------------------------------------------------

function makeBuilder(result) {
  const ops = [];
  const builder = {};
  const passthrough = [
    'select',
    'eq',
    'in',
    'or',
    'order',
    'range',
    'limit',
    'insert',
    'update',
    'delete',
    'gt',
    'lt',
    'gte',
    'lte',
    'not',
    'is',
    'neq',
  ];
  for (const m of passthrough) {
    builder[m] = (...args) => {
      ops.push([m, args]);
      return builder;
    };
  }
  let singleMode = false;
  const resolve = () => {
    const r = typeof result === 'function' ? result(ops) : result;
    if (r && typeof r === 'object' && 'data' in r) {
      if (singleMode && Array.isArray(r.data)) {
        return Promise.resolve({ ...r, data: r.data[0] || null });
      }
      if (
        !singleMode &&
        r.data !== null &&
        r.data !== undefined &&
        !Array.isArray(r.data)
      ) {
        return Promise.resolve({ ...r, data: [r.data] });
      }
    }
    return Promise.resolve(r);
  };

  builder.then = (onF, onR) => resolve().then(onF, onR);
  builder.maybeSingle = () => {
    singleMode = true;
    return resolve();
  };
  builder.single = () => {
    singleMode = true;
    return resolve();
  };
  builder.ops = ops;
  return builder;
}

function makeClient(tableRouter) {
  return {
    from: (table) => makeBuilder(tableRouter(table)),
  };
}

// ---------------------------------------------------------------------------
// Default fixtures — mirror the actual schema
// ---------------------------------------------------------------------------

const COMPANY_ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  slug: 'anthropic',
  display_name: 'Anthropic',
  sector: 'ai_ml',
  lifecycle_status: 'private',
};

function defaultNportRouter(table) {
  switch (table) {
    case 'private_companies':
      return { data: COMPANY_ROW, error: null, count: 1 };

    case 'nport_company_positions_mv':
      return {
        data: [
          {
            company_slug: 'anthropic',
            company_name: 'Anthropic',
            registrant_cik: '24238',
            registrant_name: 'Fidelity Investments',
            series_id: 'S000004007',
            series_name: 'Contrafund',
            fund_type: 'open_end',
            report_period_end: '2026-08-31',
            report_period_date: '2025-12-31',
            balance: 1000,
            currency_value_usd: 187000000,
            raw_issuer_name: 'ANTHROPIC PBC',
            raw_issuer_title: 'ANTHROPIC PBC SER F PC PP',
            accession_number: '0001234567-25-000001',
          },
        ],
        error: null,
        count: 1,
      };

    case 'nport_registrants':
      return {
        data: {
          cik: '24238',
          name: 'Fidelity Investments',
          lei: null,
          last_filed_at: '2026-01-15',
        },
        error: null,
      };

    case 'nport_filings':
      return {
        data: [
          {
            cik: '24238',
            series_id: 'S000004007',
            series_name: 'Contrafund',
            fund_type: 'open_end',
            report_period_end: '2026-08-31',
            report_period_date: '2025-12-31',
            accession_number: '0001234567-25-000001',
            filing_date: '2026-01-15',
            net_assets_usd: 150000000000,
            total_assets_usd: 152000000000,
          },
        ],
        error: null,
      };

    case 'fund_portfolio_managers':
      return {
        data: [
          {
            pm_name: 'Will Danoff',
            pm_role: 'Portfolio Manager',
            pm_managing_since: '1990-01-01',
            is_currently_active: true,
          },
        ],
        error: null,
      };

    case 'fund_ncen_records':
      return {
        data: [
          {
            investment_adviser_name: 'Fidelity Management & Research Co',
            investment_adviser_crd: '108281',
            filing_date: '2026-01-15',
          },
        ],
        error: null,
      };

    case 'fund_ncen_adviser_links':
      return {
        data: [
          {
            accession_number: '0000035402-26-001453',
            registrant_cik: '0000024238',
            series_id: 'S000004007',
            adviser_role: 'investment_adviser',
            adviser_name: 'Fidelity Management & Research Company LLC',
            adviser_crd_raw: '000108281',
            adviser_crd_normalized: '108281',
            filing_date: '2026-03-12',
          },
        ],
        error: null,
      };

    case 'position_deltas':
      return {
        data: [
          {
            company_id: COMPANY_ROW.id,
            registrant_id: '22222222-2222-2222-2222-222222222222',
            series_id: 'S000004007',
            current_period_end: '2025-12-31',
            prior_period_end: '2025-09-30',
            current_value_usd: 187000000,
            prior_value_usd: 150000000,
            markup_pct: 24.67,
            is_pure_markup: true,
          },
        ],
        error: null,
      };

    case 'nport_holdings':
      return {
        data: [
          {
            id: 1,
            issuer_name: 'Anthropic PBC',
            issuer_title: 'ANTHROPIC PBC SER F PC PP',
            issuer_lei: null,
            asset_cat: 'EC',
            resolution_source: 'unresolved',
            source_bulk_quarter: '2026Q1',
            ingested_at: '2026-01-01',
          },
        ],
        error: null,
        count: 1,
      };

    case 'private_company_aliases':
      return {
        data: {
          id: 99,
          company_id: COMPANY_ROW.id,
          pattern_type: 'exact_normalized',
          pattern: 'ANTHROPIC PBC',
        },
        error: null,
      };

    default:
      return { data: null, error: null };
  }
}

function defaultAdvRouter(table) {
  if (table === 'advisers_enriched') {
    return {
      data: {
        crd: 108281,
        adviser_entity_legal_name: 'Fidelity Management & Research Co',
      },
      error: null,
    };
  }
  return { data: null, error: null };
}

function defaultFormdRouter(table) {
  if (table === 'form_d_filings') {
    return {
      data: [{ entityname: 'Anthropic Fund', accession: '0001234567-25-000001' }],
      error: null,
    };
  }
  return { data: null, error: null };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let server;
let baseUrl;
let originalDeps;

test.before(async () => {
  const s = await startApp();
  server = s.server;
  baseUrl = s.baseUrl;
  originalDeps = { ...nportRoutes.deps };
});

test.after(() => {
  Object.assign(nportRoutes.deps, originalDeps);
  server.close();
});

function installMocks({ nportRouter, advRouter, formdRouter } = {}) {
  nportRoutes.deps.isConfigured = () => true;
  nportRoutes.deps.getAdminToken = () => 'test-admin-token';
  nportRoutes.deps.nportClient = makeClient(nportRouter || defaultNportRouter);
  nportRoutes.deps.advClient = makeClient(advRouter || defaultAdvRouter);
  nportRoutes.deps.formdClient = makeClient(formdRouter || defaultFormdRouter);

  nportRoutes.deps.getCrossSourceCompanyView = (slug, _injected) =>
    originalDeps.getCrossSourceCompanyView(slug, {
      nportClient: nportRoutes.deps.nportClient,
      advClient: nportRoutes.deps.advClient,
      formdClient: nportRoutes.deps.formdClient,
    });
}

const ADMIN_HEADERS = { 'x-admin-token': 'test-admin-token' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('503 when N-PORT not configured', async () => {
  nportRoutes.deps.isConfigured = () => false;
  const res = await request(baseUrl, 'GET', '/api/nport/companies');
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'NPORT_NOT_CONFIGURED');
});

test('GET /companies — 200 happy path', async () => {
  installMocks();
  const res = await request(baseUrl, 'GET', '/api/nport/companies?page=1&pageSize=10');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.companies));
  assert.equal(res.body.companies[0].slug, 'anthropic');
  assert.equal(res.body.page, 1);
  assert.equal(res.body.pageSize, 10);
});

test('GET /companies — 400 on invalid hasRecentMarkup', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/companies?hasRecentMarkup=maybe'
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PARAM');
});

test('GET /companies/:slug — 200 happy path', async () => {
  installMocks();
  const res = await request(baseUrl, 'GET', '/api/nport/companies/anthropic');
  assert.equal(res.status, 200);
  assert.equal(res.body.company.slug, 'anthropic');
});

test('GET /companies/:slug — 404 on unknown slug', async () => {
  installMocks({
    nportRouter: (t) =>
      t === 'private_companies' ? { data: null, error: null } : defaultNportRouter(t),
  });
  const res = await request(baseUrl, 'GET', '/api/nport/companies/unknown');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'COMPANY_NOT_FOUND');
});

test('GET /companies/:slug/positions — 200 happy path', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/companies/anthropic/positions'
  );
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.positions));
  assert.equal(res.body.positions[0].registrant_cik, '24238');
});

test('GET /companies/:slug/positions — falls back to base tables when MV empty', async () => {
  installMocks({
    nportRouter: (table) => {
      if (table === 'nport_company_positions_mv') {
        return { data: [], error: null, count: 0 };
      }
      if (table === 'nport_holdings') {
        return {
          data: [
            {
              id: 7,
              accession_number: '0001234567-25-000001',
              issuer_name: 'ANTHROPIC PBC',
              issuer_title: 'ANTHROPIC PBC SER F PC PP',
              balance: 1000,
              currency_value_usd: 187000000,
              pct_of_nav: 1.2,
              asset_cat: 'EC',
              exposure_type: 'direct',
              share_class_normalized: 'Series F',
              resolved_company_id: COMPANY_ROW.id,
            },
          ],
          error: null,
          count: 1,
        };
      }
      return defaultNportRouter(table);
    },
  });

  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/companies/anthropic/positions'
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'base_tables');
  assert.equal(res.body.total, 1);
  assert.equal(res.body.positions[0].holding_id_internal, 7);
  assert.equal(res.body.positions[0].report_period_date, '2025-12-31');
  assert.equal(res.body.positions[0].report_period_end, '2026-08-31');
  assert.equal(res.body.positions[0].registrant_name, 'Fidelity Investments');
});

test('GET /companies/:slug/positions — 404 when company missing', async () => {
  installMocks({
    nportRouter: (t) =>
      t === 'private_companies' ? { data: null, error: null } : defaultNportRouter(t),
  });
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/companies/unknown/positions'
  );
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'COMPANY_NOT_FOUND');
});

test('GET /companies/:slug/holders — 200 happy path', async () => {
  installMocks();
  const res = await request(baseUrl, 'GET', '/api/nport/companies/anthropic/holders');
  assert.equal(res.status, 200);
  assert.equal(res.body.company_slug, 'anthropic');
  assert.equal(res.body.period_date, '2025-12-31');
  assert.equal(res.body.holders[0].registrant_name, 'Fidelity Investments');
  assert.equal(res.body.holders[0].first_seen_report_date, '2025-12-31');
  assert.equal(res.body.holders[0].first_seen_accession_number, '0001234567-25-000001');
});

test('GET /companies/:slug/holders — first seen tracks same fund and security across periods', async () => {
  installMocks({
    nportRouter: (table) => {
      if (table === 'nport_company_positions_mv') {
        return {
          data: [
            {
              company_slug: 'anthropic',
              company_name: 'Anthropic',
              registrant_cik: '24238',
              registrant_name: 'Fidelity Investments',
              series_id: 'S000004007',
              series_name: 'Contrafund',
              fund_type: 'open_end',
              report_period_end: '2026-08-31',
              report_period_date: '2025-12-31',
              balance: 1000,
              currency_value_usd: 187000000,
              asset_cat: 'EC',
              exposure_type: 'direct',
              share_class_normalized: 'Series F',
              raw_issuer_name: 'ANTHROPIC PBC',
              raw_issuer_title: 'ANTHROPIC PBC SER F PC PP',
              accession_number: '0001234567-25-000001',
            },
            {
              company_slug: 'anthropic',
              company_name: 'Anthropic',
              registrant_cik: '24238',
              registrant_name: 'Fidelity Investments',
              series_id: 'S000004007',
              series_name: 'Contrafund',
              fund_type: 'open_end',
              report_period_end: '2026-05-31',
              report_period_date: '2025-09-30',
              balance: 1000,
              currency_value_usd: 140000000,
              asset_cat: 'EC',
              exposure_type: 'direct',
              share_class_normalized: 'Series F',
              raw_issuer_name: 'ANTHROPIC PBC',
              raw_issuer_title: 'ANTHROPIC PBC SER F PC PP',
              accession_number: '0001234567-24-000009',
            },
          ],
          error: null,
          count: 2,
        };
      }
      return defaultNportRouter(table);
    },
  });
  const res = await request(baseUrl, 'GET', '/api/nport/companies/anthropic/holders');
  assert.equal(res.status, 200);
  assert.equal(res.body.holders.length, 1);
  assert.equal(res.body.holders[0].report_period_date, '2025-12-31');
  assert.equal(res.body.holders[0].first_seen_report_date, '2025-09-30');
  assert.equal(res.body.holders[0].first_seen_accession_number, '0001234567-24-000009');
});

test('GET /companies/:slug/holders — includes latest available row per fund-security key', async () => {
  installMocks({
    nportRouter: (table) => {
      if (table === 'nport_company_positions_mv') {
        return {
          data: [
            {
              company_slug: 'anthropic',
              registrant_cik: '24238',
              registrant_name: 'Fidelity Investments',
              series_id: 'S000004007',
              series_name: 'Contrafund',
              report_period_end: '2026-08-31',
              report_period_date: '2025-12-31',
              balance: 1000,
              currency_value_usd: 187000000,
              asset_cat: 'EC',
              exposure_type: 'direct',
              share_class_normalized: 'Series F',
              raw_issuer_title: 'ANTHROPIC PBC SER F PC PP',
              accession_number: '0001234567-25-000001',
            },
            {
              company_slug: 'anthropic',
              registrant_cik: '719608',
              registrant_name: 'New Economy Fund',
              series_id: null,
              series_name: 'New Economy Fund',
              report_period_end: '2026-05-31',
              report_period_date: '2025-11-30',
              balance: 500,
              currency_value_usd: 75000000,
              asset_cat: 'EC',
              exposure_type: 'direct',
              share_class_normalized: 'Class A',
              raw_issuer_title: 'ANTHROPIC PBC CL A PP',
              accession_number: '0007654321-25-000001',
            },
          ],
          error: null,
          count: 2,
        };
      }
      return defaultNportRouter(table);
    },
  });
  const res = await request(baseUrl, 'GET', '/api/nport/companies/anthropic/holders');
  assert.equal(res.status, 200);
  assert.equal(res.body.period_date, '2025-12-31');
  assert.equal(res.body.holders.length, 2);
  assert.deepEqual(
    res.body.holders.map((h) => h.registrant_name).sort(),
    ['Fidelity Investments', 'New Economy Fund']
  );
});

test('GET /companies/:slug/timeseries — 200 happy path', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/companies/anthropic/timeseries'
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.company_slug, 'anthropic');
  assert.ok(Array.isArray(res.body.series));
  assert.equal(res.body.series[0].report_period_date, '2025-12-31');
});

test('GET /companies/:slug/markups — 200 happy path', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/companies/anthropic/markups?limit=5'
  );
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.markups));
  assert.equal(res.body.markups[0].is_pure_markup, true);
});

test('GET /companies/:slug/cross — 200 consolidated view', async () => {
  installMocks();
  const res = await request(baseUrl, 'GET', '/api/nport/companies/anthropic/cross');
  assert.equal(res.status, 200);
  assert.equal(res.body.company.slug, 'anthropic');
  assert.ok(Array.isArray(res.body.nportPositions));
  assert.ok(Array.isArray(res.body.formDFilings));
  assert.ok(Array.isArray(res.body.relatedAdvisers));
});

test('GET /companies/:slug/cross — resolves N-CEN links across padded CIK variants', async () => {
  installMocks({
    nportRouter: (table) => {
      if (table === 'fund_ncen_adviser_links') {
        return (ops) => {
          const inOp = ops.find(([name, args]) => name === 'in' && args[0] === 'registrant_cik');
          const queried = new Set((inOp && inOp[1][1]) || []);
          return {
            data: queried.has('0000024238')
              ? [
                  {
                    registrant_cik: '0000024238',
                    series_id: 'S000004007',
                    adviser_role: 'investment_adviser',
                    adviser_crd_normalized: '000108281',
                    filing_date: '2026-03-12',
                  },
                ]
              : [],
            error: null,
          };
        };
      }
      return defaultNportRouter(table);
    },
  });

  const res = await request(baseUrl, 'GET', '/api/nport/companies/anthropic/cross');

  assert.equal(res.status, 200);
  assert.equal(res.body.relatedAdvisers.length, 1);
  assert.equal(res.body.relatedAdvisers[0].crd, 108281);
});

test('GET /companies/:slug/cross — 404 on unknown company', async () => {
  installMocks({
    nportRouter: (t) =>
      t === 'private_companies' ? { data: null, error: null } : defaultNportRouter(t),
  });
  const res = await request(baseUrl, 'GET', '/api/nport/companies/unknown/cross');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'COMPANY_NOT_FOUND');
});

test('GET /funds/:cik — 200 fund family', async () => {
  installMocks();
  const res = await request(baseUrl, 'GET', '/api/nport/funds/24238');
  assert.equal(res.status, 200);
  assert.equal(res.body.filer.cik, '24238');
  assert.ok(Array.isArray(res.body.series));
});

test('GET /funds/:cik — 400 on non-numeric cik', async () => {
  installMocks();
  const res = await request(baseUrl, 'GET', '/api/nport/funds/abc');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_CIK');
});

test('GET /funds/:cik — 404 when filer missing', async () => {
  installMocks({
    nportRouter: (t) =>
      t === 'nport_registrants' ? { data: null, error: null } : defaultNportRouter(t),
  });
  const res = await request(baseUrl, 'GET', '/api/nport/funds/99999');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'FILER_NOT_FOUND');
});

test('GET /funds/:cik/:series_id — 200 series detail', async () => {
  installMocks();
  const res = await request(baseUrl, 'GET', '/api/nport/funds/24238/S000004007');
  assert.equal(res.status, 200);
  assert.equal(res.body.series.series_id, 'S000004007');
});

test('GET /funds/:cik/:series_id/positions — 200 happy path', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/funds/24238/S000004007/positions'
  );
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.positions));
});

test('GET /funds/:cik/:series_id/managers — 200 happy path', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/funds/24238/S000004007/managers'
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.managers[0].pm_name, 'Will Danoff');
});

test('GET /funds/:cik/adviser — 200 with registrant-level adviser', async () => {
  installMocks();
  const res = await request(baseUrl, 'GET', '/api/nport/funds/24238/adviser');
  assert.equal(res.status, 200);
  assert.equal(res.body.series_id, null);
  assert.equal(res.body.adviser_crd, '108281');
  assert.equal(res.body.adviser.crd, 108281);
});

test('GET /funds/:cik/:series_id/adviser — 200 with adviser', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/funds/24238/S000004007/adviser'
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.adviser_crd, '108281');
  assert.equal(res.body.adviser.crd, 108281);
});

test('GET /funds/:cik/:series_id/adviser — normalizes zero-padded N-CEN CRD', async () => {
  installMocks({
    nportRouter: (t) => {
      if (t === 'fund_ncen_adviser_links') {
        return {
          data: [
            {
              accession_number: '0000035402-26-001453',
              registrant_cik: '0000024238',
              series_id: 'S000004007',
              adviser_role: 'investment_adviser',
              adviser_name: 'Fidelity Management & Research Company LLC',
              adviser_crd_raw: '000108281',
              adviser_crd_normalized: '000108281',
              filing_date: '2026-03-12',
            },
          ],
          error: null,
        };
      }
      return defaultNportRouter(t);
    },
  });
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/funds/24238/S000004007/adviser'
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.adviser_crd, '108281');
  assert.equal(res.body.ncen_source, 'fund_ncen_adviser_links');
  assert.equal(res.body.adviser.crd, 108281);
});

test('GET /funds/:cik/adviser — does not pick an arbitrary adviser for multi-adviser registrants', async () => {
  installMocks({
    nportRouter: (t) => {
      if (t === 'fund_ncen_adviser_links') {
        return {
          data: [
            {
              accession_number: '0000844779-26-000001',
              registrant_cik: '0000844779',
              series_id: 'S000038448',
              adviser_role: 'investment_adviser',
              adviser_name: 'BlackRock Advisors, LLC',
              adviser_crd_raw: '000106614',
              adviser_crd_normalized: '106614',
              filing_date: '2026-03-12',
            },
            {
              accession_number: '0000844779-26-000001',
              registrant_cik: '0000844779',
              series_id: 'S000087852',
              adviser_role: 'investment_adviser',
              adviser_name: 'BlackRock Fund Advisors',
              adviser_crd_raw: '000105247',
              adviser_crd_normalized: '105247',
              filing_date: '2026-03-12',
            },
          ],
          error: null,
        };
      }
      if (t === 'fund_ncen_records') return { data: [], error: null };
      return defaultNportRouter(t);
    },
  });

  const res = await request(baseUrl, 'GET', '/api/nport/funds/844779/adviser');

  assert.equal(res.status, 200);
  assert.equal(res.body.adviser_crd, null);
  assert.equal(res.body.adviser, null);
  assert.match(res.body.note, /Multiple N-CEN investment advisers/);
});

test('GET /funds/:cik/:series_id/adviser — does not fall back to another series adviser on exact miss', async () => {
  installMocks({
    nportRouter: (t) => {
      if (t === 'fund_ncen_adviser_links') {
        return (ops) => {
          const eqSeries = ops.find(([name, args]) => name === 'eq' && args[0] === 'series_id');
          if (eqSeries) return { data: [], error: null };
          return {
            data: [
              {
                accession_number: '0000035402-26-001453',
                registrant_cik: '0000024238',
                series_id: 'S000099999',
                adviser_role: 'investment_adviser',
                adviser_name: 'Fidelity Management & Research Company LLC',
                adviser_crd_raw: '000108281',
                adviser_crd_normalized: '108281',
                filing_date: '2026-03-12',
              },
            ],
            error: null,
          };
        };
      }
      if (t === 'fund_ncen_records') return { data: [], error: null };
      return defaultNportRouter(t);
    },
  });

  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/funds/24238/S000004007/adviser'
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.adviser_crd, null);
  assert.equal(res.body.exact_series_match, false);
  assert.match(res.body.note, /No exact N-CEN adviser link/);
});

test('GET /funds/:cik/:series_id/adviser — 200 null when no link', async () => {
  installMocks({
    nportRouter: (t) => {
      if (t === 'fund_ncen_adviser_links') return { data: [], error: null };
      if (t === 'fund_ncen_records') return { data: [], error: null };
      return defaultNportRouter(t);
    },
  });
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/funds/24238/S000004007/adviser'
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.adviser_crd, null);
  assert.equal(res.body.adviser, null);
});

test('GET /admin/unresolved — 200 list', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'GET',
    '/api/nport/admin/unresolved?page=1&pageSize=10',
    undefined,
    ADMIN_HEADERS
  );
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.unresolved));
  assert.equal(res.body.unresolved[0].issuer_name, 'Anthropic PBC');
});

test('POST /admin/aliases — 201 on valid body', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'POST',
    '/api/nport/admin/aliases',
    {
      rawName: 'Anthropic PBC',
      canonicalSlug: 'anthropic',
      source: 'curator',
    },
    ADMIN_HEADERS
  );
  assert.equal(res.status, 201);
  assert.equal(res.body.alias.canonical_slug, 'anthropic');
});

test('POST /admin/aliases — 403 without admin token', async () => {
  installMocks();
  const res = await request(baseUrl, 'POST', '/api/nport/admin/aliases', {
    rawName: 'Anthropic PBC',
    canonicalSlug: 'anthropic',
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NPORT_ADMIN_FORBIDDEN');
});

test('POST /admin/aliases — 400 missing rawName', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'POST',
    '/api/nport/admin/aliases',
    {
      canonicalSlug: 'anthropic',
    },
    ADMIN_HEADERS
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MISSING_RAW_NAME');
});

test('POST /admin/aliases — 400 missing canonicalSlug', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'POST',
    '/api/nport/admin/aliases',
    {
      rawName: 'Anthropic PBC',
    },
    ADMIN_HEADERS
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MISSING_CANONICAL_SLUG');
});

test('POST /admin/refresh_resolution — 200 with ids', async () => {
  installMocks({
    nportRouter: (t) =>
      t === 'nport_holdings'
        ? { data: [{ id: 1 }, { id: 2 }], error: null }
        : defaultNportRouter(t),
  });
  const res = await request(
    baseUrl,
    'POST',
    '/api/nport/admin/refresh_resolution',
    {
      ids: [1, 2],
    },
    ADMIN_HEADERS
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.queued, 2);
});

test('POST /admin/refresh_resolution — 400 missing target', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'POST',
    '/api/nport/admin/refresh_resolution',
    {},
    ADMIN_HEADERS
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MISSING_TARGET');
});

test('POST /admin/refresh_resolution — 400 ids not array', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'POST',
    '/api/nport/admin/refresh_resolution',
    {
      ids: 'not-an-array',
    },
    ADMIN_HEADERS
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_IDS');
});

test('POST /admin/refresh_resolution — 400 ids must be positive integers and capped', async () => {
  installMocks();
  const res = await request(
    baseUrl,
    'POST',
    '/api/nport/admin/refresh_resolution',
    {
      ids: [1, -2, 3],
    },
    ADMIN_HEADERS
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_IDS');
});
