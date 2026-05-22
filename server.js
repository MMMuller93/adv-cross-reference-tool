const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');
const { ensureLoaded: ensureExternalDbLoaded, lookupInvestor } = require('./enrichment/external_investor_lookup');

// Stripe setup - only initialize if key is present
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

if (!STRIPE_SECRET_KEY) {
  console.warn('[Stripe] STRIPE_SECRET_KEY not set - billing features disabled');
}

const app = express();
app.use(cors());

// Stripe webhook needs raw body - must be before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Billing not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('[Stripe Webhook] Event:', event.type);

  // Handle subscription events
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_email || session.customer_details?.email;
    console.log('[Stripe] Checkout completed for:', customerEmail);
    // Store subscription in Supabase user metadata or subscriptions table
    // For now, we'll check Stripe directly for subscription status
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    console.log('[Stripe] Subscription cancelled:', subscription.id);
  }

  res.json({ received: true });
});

app.use(express.json());

// Stripe: Create checkout session for $30/month subscription
app.post('/api/stripe/create-checkout', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Billing not configured' });
  }

  try {
    const { email, successUrl, cancelUrl } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // Check if customer already exists
    const customers = await stripe.customers.list({ email, limit: 1 });
    let customerId;

    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
      // Check if they already have an active subscription
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
      if (subs.data.length > 0) {
        return res.status(400).json({ error: 'Already subscribed', subscriptionId: subs.data[0].id });
      }
    }

    const baseUrl = successUrl?.split('?')[0]?.replace('/success', '') || 'https://privatemarket.info';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      customer_email: customerId ? undefined : email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Private Markets Premium',
            description: 'Unlimited searches on Private Markets Intelligence Platform',
          },
          unit_amount: 3000, // $30.00
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: 3,
      },
      success_url: `${baseUrl}?subscription=success`,
      cancel_url: `${baseUrl}?subscription=cancelled`,
    });

    console.log('[Stripe] Checkout session created for:', email);
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[Stripe] Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stripe: Check subscription status by email
app.get('/api/stripe/subscription-status', async (req, res) => {
  if (!stripe) {
    return res.json({ hasSubscription: false });
  }

  try {
    const { email } = req.query;

    if (!email) {
      return res.json({ hasSubscription: false });
    }

    const customers = await stripe.customers.list({ email, limit: 1 });

    if (customers.data.length === 0) {
      return res.json({ hasSubscription: false });
    }

    const subs = await stripe.subscriptions.list({
      customer: customers.data[0].id,
      status: 'active',
      limit: 1
    });

    const hasSubscription = subs.data.length > 0;
    const subscription = hasSubscription ? {
      id: subs.data[0].id,
      status: subs.data[0].status,
      currentPeriodEnd: subs.data[0].current_period_end,
    } : null;

    console.log('[Stripe] Subscription check for', email, ':', hasSubscription);
    res.json({ hasSubscription, subscription });
  } catch (err) {
    console.error('[Stripe] Subscription check error:', err.message);
    res.json({ hasSubscription: false, error: err.message });
  }
});

// Stripe: Create customer portal session (for managing subscription)
app.post('/api/stripe/customer-portal', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Billing not configured' });
  }

  try {
    const { email } = req.body;

    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: req.body.returnUrl || 'https://privatemarket.info',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] Portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Supabase clients (needed for redirects)
const advClient = createClient(
  'https://ezuqwwffjgfzymqxsctq.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE'
);

const formdClient = createClient(
  'https://ltdalxkhbbhmkimmogyq.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc'
);

// Multi-Platform Managers CSV data (loaded at startup)
let multiPlatformManagers = [];

function loadMultiPlatformManagersCSV() {
  const csvPath = path.join(__dirname, 'lead_lists', '08_multi_platform_managers.csv');
  try {
    if (!fs.existsSync(csvPath)) {
      console.warn('[Multi-Platform] CSV not found:', csvPath);
      return;
    }
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());

    multiPlatformManagers = lines.slice(1).map(line => {
      const values = [];
      let current = '';
      let inQuotes = false;
      for (const char of line) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());

      const row = {};
      headers.forEach((h, i) => {
        row[h] = values[i] || '';
      });
      return row;
    }).filter(r => r.display_name); // Filter out empty rows

    console.log(`[Multi-Platform] Loaded ${multiPlatformManagers.length} managers from CSV`);
  } catch (err) {
    console.error('[Multi-Platform] Error loading CSV:', err.message);
  }
}

// Load CSV at startup
loadMultiPlatformManagersCSV();

// Load external investor reference data (OpenVC + Ramp) into memory
ensureExternalDbLoaded(formdClient).catch(err => {
  console.error('[ExternalDB] Failed to load at startup:', err.message);
});

// SEO slug utility (used in redirects)
function generateSlug(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}

// 301 redirects from old query param URLs to new SEO URLs (MUST be before static middleware)
app.get('/', async (req, res, next) => {
  if (req.query.adviser) {
    const crd = req.query.adviser;
    try {
      const { data } = await advClient
        .from('advisers_enriched')
        .select('adviser_name')
        .eq('crd', crd)
        .single();
      const slug = data ? `${crd}-${generateSlug(data.adviser_name)}` : crd;
      return res.redirect(301, `/adviser/${slug}`);
    } catch (e) {
      return res.redirect(301, `/adviser/${crd}`);
    }
  }
  next();
});

app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.js') || path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Helper functions
function normalizeName(name) {
  if (!name) return '';
  let normalized = String(name).toUpperCase();
  const replacements = [
    ', LLC', ' LLC', ', LP', ' LP', ', L.P.', ' L.P.',
    ', L.L.C.', ' L.L.C.', ' INC', ' INC.', ', INC', ', INC.',
    ' FUND', ' A SERIES OF', ', A SERIES OF'
  ];
  replacements.forEach(r => {
    normalized = normalized.replace(new RegExp(r, 'g'), ' ');
  });
  return normalized.replace(/\s+/g, ' ').trim();
}

function similarity(s1, s2) {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  if (longer.length === 0) return 1.0;
  return (longer.length - editDistance(longer, shorter)) / longer.length;
}

function editDistance(s1, s2) {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

// Parse mixed date formats: "DD-MMM-YYYY" (e.g., "31-OCT-2024") or "YYYY-MM-DD" (e.g., "2025-11-06")
function parseFilingDate(dateStr) {
  if (!dateStr) return new Date(0);

  // Check if it's YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }

  // Check if it's DD-MMM-YYYY format
  const monthMap = {
    'JAN': 0, 'FEB': 1, 'MAR': 2, 'APR': 3, 'MAY': 4, 'JUN': 5,
    'JUL': 6, 'AUG': 7, 'SEP': 8, 'OCT': 9, 'NOV': 10, 'DEC': 11
  };

  const match = dateStr.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/i);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = monthMap[match[2].toUpperCase()];
    const year = parseInt(match[3], 10);
    if (month !== undefined) {
      return new Date(year, month, day);
    }
  }

  // Fallback: try native parsing
  return new Date(dateStr);
}

// Helper: Fetch all results with pagination (Supabase has 1000 row hard limit)
async function fetchAllResultsPaginated(buildQuery, pageSize = 1000) {
  let allResults = [];
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const query = buildQuery(from, from + pageSize - 1);
    const { data, error } = await query;

    if (error) {
      console.error(`Error fetching page at offset ${from}:`, error);
      throw error;
    }

    if (data && data.length > 0) {
      allResults = allResults.concat(data);
      console.log(`  Fetched ${data.length} rows (offset ${from}), total so far: ${allResults.length}`);
      from += pageSize;
      hasMore = data.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return allResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cached adviser-index for the /api/funds/new-managers matcher.
//
// Production bug 2026-05-19: the endpoint was rebuilding a 57K-row in-memory
// index FROM SCRATCH on every request via OFFSET-paginated reads. Each request
// took 30+ seconds just to load (offset-pagination on a 57K-row table is O(n)
// per page). Combined with the variant-ladder matcher, requests hung past
// curl/browser timeouts and the New Managers tab appeared to never load.
//
// Fix: build the index ONCE at module scope, refresh on TTL. Returns the
// existing pending promise during a build so concurrent requests share it.
// TTL = 1 hour. Adviser data updates roughly daily, so 1 hour is fresh enough.
//
// Refresh fires lazily on first request after expiry; doesn't block startup.
// If the build errors, the previous index (if any) is kept and the error logs.
// ─────────────────────────────────────────────────────────────────────────────
const ADVISER_INDEX_TTL_MS = 60 * 60 * 1000;  // 1 hour
let _adviserIndex = null;       // { advisersByNameExact, advisersByNamePrefix, builtAt, count }
let _adviserIndexBuilding = null;  // Promise in flight, to dedupe concurrent rebuilds

async function getAdviserIndex() {
  const now = Date.now();
  if (_adviserIndex && (now - _adviserIndex.builtAt) < ADVISER_INDEX_TTL_MS) {
    return _adviserIndex;
  }
  if (_adviserIndexBuilding) {
    return _adviserIndexBuilding;
  }
  _adviserIndexBuilding = (async () => {
    const t0 = Date.now();
    console.log('[adviser-index] Building (cache miss or expired)...');
    const advisersData = await fetchAllResultsPaginated((from, to) => {
      return advClient
        .from('advisers_enriched')
        .select('crd, adviser_name, adviser_entity_legal_name, primary_website, total_aum, aum_2023, aum_2024, aum_2025, aum_2026, registration_type')
        .range(from, to);
    });
    const advisersByNameExact = {};
    const advisersByNamePrefix = [];
    // Inverted token index: distinctive-token → Set of indexes into advisersByNamePrefix.
    // Lets variant-laddered matcher narrow from 57K candidates to ~5-20 per variant
    // (added 2026-05-22 after the variant-ladder hit 400M comparisons / request).
    const { distinctiveTokens } = require('./lib/name_matcher');
    const tokenToAdvIdx = new Map();  // token (string) → Set<number>

    let activeCount = 0;
    let inactiveCount = 0;
    const isAdviserActive = (adv) => adv.aum_2023 || adv.aum_2024 || adv.aum_2025 || adv.aum_2026 || adv.total_aum;
    for (const adv of advisersData) {
      const name1 = (adv.adviser_name || '').toLowerCase().trim();
      const name2 = (adv.adviser_entity_legal_name || '').toLowerCase().trim();
      if (!name1 && !name2) continue;
      if (isAdviserActive(adv)) activeCount++; else inactiveCount++;
      if (name1) advisersByNameExact[name1] = adv;
      if (name2) advisersByNameExact[name2] = adv;
      const idx = advisersByNamePrefix.length;
      advisersByNamePrefix.push({ names: [name1, name2].filter(n => n), adv });
      // Build inverted index from BOTH names' distinctive tokens
      const tokens = new Set([...distinctiveTokens(name1), ...distinctiveTokens(name2)]);
      for (const t of tokens) {
        if (!tokenToAdvIdx.has(t)) tokenToAdvIdx.set(t, new Set());
        tokenToAdvIdx.get(t).add(idx);
      }
    }
    const built = {
      advisersByNameExact,
      advisersByNamePrefix,
      tokenToAdvIdx,
      builtAt: now,
      count: advisersData.length,
      activeCount,
      inactiveCount,
    };
    console.log(`[adviser-index] Built in ${Date.now() - t0}ms — ${built.count} advisers (${activeCount} with AUM, ${inactiveCount} without)`);
    _adviserIndex = built;
    return built;
  })().catch(err => {
    console.error('[adviser-index] Build failed:', err.message);
    // Keep stale index if present, so endpoint still works
    return _adviserIndex || { advisersByNameExact: {}, advisersByNamePrefix: [], builtAt: now, count: 0 };
  }).finally(() => {
    _adviserIndexBuilding = null;
  });
  return _adviserIndexBuilding;
}

// API: Search Advisers
app.get('/api/advisers/search', async (req, res) => {
  try {
    const { query, minAum, maxAum, state, type, exemption, limit = 500 } = req.query;
    console.log(`[Gemini] Searching Advisers: query="${query || '(none)'}"`);

    let adviserQuery = advClient.from('advisers_enriched').select('*');

    // Require at least 3 chars like old tool to prevent slow full-table scans
    if (query && query.trim().length >= 3) {
      adviserQuery = adviserQuery.or(`adviser_name.ilike.%${query}%,adviser_entity_legal_name.ilike.%${query}%,other_business_names.ilike.%${query}%`);
    }

    if (state && state.trim()) {
      adviserQuery = adviserQuery.eq('state_country', state);
    }

    if (type && type.trim()) {
      adviserQuery = adviserQuery.eq('type', type);
    }

    if (exemption === 'vc') {
      adviserQuery = adviserQuery.eq('exemption_2b1', 'Y');
    } else if (exemption === 'private_fund') {
      adviserQuery = adviserQuery.eq('exemption_2b2', 'Y');
    }

    if (minAum) {
      adviserQuery = adviserQuery.gte('total_aum', parseFloat(minAum) * 1000000);
    }
    if (maxAum) {
      adviserQuery = adviserQuery.lte('total_aum', parseFloat(maxAum) * 1000000);
    }

    // Sort by aum_2025 (most complete), push NULLs to end
    adviserQuery = adviserQuery.order('aum_2025', { ascending: false, nullsFirst: false }).limit(parseInt(limit));
    const { data, error } = await adviserQuery;

    if (error) throw error;

    // Enrich advisers with fund counts using database-level aggregation
    const advisers = data || [];
    if (advisers.length > 0) {
      const crdList = advisers.map(a => a.crd).filter(Boolean);
      const crdStrings = crdList.map(c => String(c));

      if (crdStrings.length > 0) {
        // OPTIMIZED: Use parallel count queries with head: true (no row data transferred)
        // This is much faster than fetching all rows just to count them
        const countPromises = crdStrings.map(crd =>
          advClient
            .from('funds_enriched')
            .select('*', { count: 'exact', head: true })
            .eq('adviser_entity_crd', crd)
            .then(({ count, error }) => ({ crd, count: error ? 0 : (count || 0) }))
        );

        const countResults = await Promise.all(countPromises);

        // Build count map from results
        const countMap = {};
        countResults.forEach(({ crd, count }) => {
          countMap[crd] = count;
        });

        console.log(`[FundCount] Got counts for ${crdStrings.length} advisers via parallel database queries`);

        // Merge counts into advisers
        advisers.forEach(a => {
          a.fund_count = countMap[String(a.crd)] || 0;
        });
      }
    }

    res.json(advisers);
  } catch (error) {
    console.error('Adviser search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get single adviser by CRD
app.get('/api/advisers/:crd', async (req, res) => {
  try {
    const { crd } = req.params;
    const { data, error } = await advClient
      .from('advisers_enriched')
      .select('*')
      .eq('crd', crd)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Adviser fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get funds by adviser CRD
app.get('/api/advisers/:crd/funds', async (req, res) => {
  try {
    const { crd } = req.params;
    const { data, error } = await advClient
      .from('funds_enriched')
      .select('*')
      .eq('adviser_entity_crd', crd);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Adviser funds error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Search ADV Funds with pagination
app.get('/api/funds/adv', async (req, res) => {
  try {
    const { query, page = 1, pageSize = 100, exemption3c1, exemption3c7, sortBy = 'updated_at', sortOrder = 'desc', scope = 'all' } = req.query;

    const pageNum = parseInt(page);
    const pageSizeNum = Math.min(parseInt(pageSize), 500);
    const offset = (pageNum - 1) * pageSizeNum;

    console.log(`[Gemini] Searching ADV funds: ${query || '(all)'} (scope=${scope})`);

    // scope=related is Form-D-only (related_names lives on form_d_filings); short-circuit
    if (query && scope === 'related') {
      return res.json({ results: [], total: 0, count: 0, note: 'scope=related is Form-D-only' });
    }

    let dbQuery = advClient.from('funds_enriched').select('*', { count: 'exact' });

    if (query) {
      if (scope === 'name') {
        dbQuery = dbQuery.ilike('fund_name', `%${query}%`);
      } else if (scope === 'adviser') {
        dbQuery = dbQuery.ilike('adviser_entity_legal_name', `%${query}%`);
      } else {
        dbQuery = dbQuery.or(`fund_name.ilike.%${query}%,adviser_entity_legal_name.ilike.%${query}%`);
      }
    }

    if (exemption3c1 === 'yes') {
      dbQuery = dbQuery.eq('exclusion_3c1', 'Y');
    } else if (exemption3c1 === 'no') {
      dbQuery = dbQuery.or('exclusion_3c1.neq.Y,exclusion_3c1.is.null');
    }

    if (exemption3c7 === 'yes') {
      dbQuery = dbQuery.eq('exclusion_3c7', 'Y');
    } else if (exemption3c7 === 'no') {
      dbQuery = dbQuery.or('exclusion_3c7.neq.Y,exclusion_3c7.is.null');
    }

    const validSortColumns = ['updated_at', 'created_at', 'fund_name', 'latest_gross_asset_value', 'adviser_entity_legal_name'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'updated_at';
    dbQuery = dbQuery.order(sortColumn, { ascending: sortOrder === 'asc', nullsFirst: false });
    dbQuery = dbQuery.range(offset, offset + pageSizeNum - 1);

    const { data, error, count } = await dbQuery;
    if (error) throw error;

    // Enrich ADV funds with Form D cross-reference data using DIRECT lookup
    // The cross_reference_matches table has adv_fund_name that matches funds_enriched.fund_name exactly
    let crossRefMap = {};
    if (data && data.length > 0) {
      const fundNames = data.map(f => f.fund_name).filter(Boolean);

      if (fundNames.length > 0) {
        try {
          // DIRECT LOOKUP: Query cross_reference_matches by exact fund names
          // Only return exact matches (match_score = 1.0) to filter out old fuzzy matches
          // BATCH queries to avoid Supabase URL length limit (fails with >50-100 items in .in())
          const BATCH_SIZE = 50;
          const allMatches = [];

          for (let i = 0; i < fundNames.length; i += BATCH_SIZE) {
            const batch = fundNames.slice(i, i + BATCH_SIZE);
            const { data: matches, error: crossRefError } = await formdClient
              .from('cross_reference_matches')
              .select('adv_fund_name,formd_entity_name,formd_filing_date,formd_offering_amount,formd_accession,match_score')
              .eq('match_score', 1)
              .in('adv_fund_name', batch);

            if (crossRefError) {
              console.error('[ADV Search] Cross-reference batch error:', crossRefError.message);
            } else if (matches) {
              allMatches.push(...matches);
            }
          }

          if (allMatches.length > 0) {
            // Build map from adv_fund_name to match data (keep best match per fund)
            allMatches.forEach(match => {
              const key = match.adv_fund_name;
              if (!crossRefMap[key] || (match.match_score > (crossRefMap[key].match_score || 0))) {
                crossRefMap[key] = match;
              }
            });

            // Fetch related_names from form_d_filings using accession numbers
            const accessions = [...new Set(allMatches.map(m => m.formd_accession).filter(Boolean))];
            if (accessions.length > 0) {
              const relatedMap = {};
              for (let i = 0; i < accessions.length; i += BATCH_SIZE) {
                const batch = accessions.slice(i, i + BATCH_SIZE);
                const { data: filings } = await formdClient
                  .from('form_d_filings')
                  .select('accessionnumber,related_names,related_roles')
                  .in('accessionnumber', batch);
                if (filings) {
                  filings.forEach(f => {
                    relatedMap[f.accessionnumber] = { related_names: f.related_names, related_roles: f.related_roles };
                  });
                }
              }
              // Add related_names to crossRefMap
              Object.values(crossRefMap).forEach(match => {
                if (match.formd_accession && relatedMap[match.formd_accession]) {
                  match.related_names = relatedMap[match.formd_accession].related_names;
                  match.related_roles = relatedMap[match.formd_accession].related_roles;
                }
              });
            }

            console.log(`[ADV Search] Direct lookup found ${allMatches.length} Form D matches for ${fundNames.length} funds, linked ${Object.keys(crossRefMap).length} unique`);
          } else {
            console.log(`[ADV Search] No Form D matches found for ${fundNames.length} funds`);
          }
        } catch (crossRefErr) {
          console.error('[ADV Search] Cross-reference lookup failed:', crossRefErr.message);
          // Continue without cross-reference data rather than failing
        }
      }
    }

    // Add source field and Form D enrichment to each result
    const results = (data || []).map(fund => {
      const crossRef = crossRefMap[fund.fund_name];
      return {
        ...fund,
        source: 'adv',
        // Add Form D data from pre-computed cross-reference matches
        form_d_entity_name: crossRef?.formd_entity_name || null,
        form_d_filing_date: crossRef?.formd_filing_date || null,
        form_d_offering_amount: crossRef?.formd_offering_amount || null,
        form_d_accession: crossRef?.formd_accession || null,
        form_d_match_score: crossRef?.match_score || null,
        form_d_related_names: crossRef?.related_names || null,
        form_d_related_roles: crossRef?.related_roles || null,
        // Also include without prefix for frontend compatibility
        related_names: crossRef?.related_names || null,
        related_roles: crossRef?.related_roles || null,
        has_form_d_match: !!crossRef
      };
    });

    res.json({
      success: true,
      results,
      pagination: {
        page: pageNum,
        pageSize: pageSizeNum,
        totalResults: count || 0,
        totalPages: Math.ceil((count || 0) / pageSizeNum),
        hasMore: pageNum < Math.ceil((count || 0) / pageSizeNum)
      }
    });
  } catch (error) {
    console.error('ADV search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get single fund by name
app.get('/api/funds/by-name', async (req, res) => {
  try {
    const { name, crd } = req.query;
    let dbQuery = advClient.from('funds_enriched').select('*');

    if (name) {
      dbQuery = dbQuery.eq('fund_name', name);
    }
    if (crd) {
      dbQuery = dbQuery.eq('adviser_entity_crd', crd);
    }

    const { data, error } = await dbQuery.limit(1).single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Fund fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Find Form D match for a fund by name (fuzzy matching)
app.get('/api/funds/formd-match', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.json({ match: null });
    }

    console.log(`[Gemini] Finding Form D match for: ${name}`);
    const normalizedName = normalizeName(name);

    // Search Form D database for potential matches
    const { data, error } = await formdClient
      .from('form_d_filings')
      .select('cik,entityname,filing_date,sale_date,totalofferingamount,totalamountsold,indefiniteofferingamount,federalexemptions_items_list,stateorcountry,related_names,related_roles,accessionnumber')
      .or(`entityname.ilike.%${name.substring(0, 20)}%,entityname.ilike.%${name.split(' ').slice(0, 3).join('%')}%`)
      .limit(50);

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.json({ match: null });
    }

    // Find best match using similarity scoring
    let bestMatch = null;
    let bestScore = 0;

    for (const filing of data) {
      const normalizedFormd = normalizeName(filing.entityname);
      const score = similarity(normalizedName, normalizedFormd);

      if (score > bestScore && score > 0.6) { // 60% similarity threshold
        bestScore = score;
        bestMatch = {
          ...filing,
          match_score: score
        };
      }
    }

    res.json({ match: bestMatch });
  } catch (error) {
    console.error('Form D match error:', error);
    res.status(500).json({ error: error.message, match: null });
  }
});

// API: Search Form D filings
app.get('/api/funds/formd', async (req, res) => {
  try {
    const { query, limit = 1000, startDate, endDate, state, scope } = req.query;
    console.log(`[Gemini] Searching Form D: ${query || '(all)'} (scope=${scope || 'all'})`);

    let dbQuery = formdClient
      .from('form_d_filings')
      .select('accessionnumber,entityname,cik,filing_date,stateorcountry,federalexemptions_items_list,investmentfundtype,related_names,related_roles,totalofferingamount,totalamountsold,issuerphonenumber,minimuminvestmentaccepted,totalnumberalreadyinvested,nameofsigner,signaturetitle,street1,city,zipcode,sale_date,totalremaining,salescomm_dollaramount,findersfee_dollaramount,hasnonaccreditedinvestors,numbernonaccreditedinvestors,isamendment,industrygrouptype,entitytype,jurisdictionofinc,file_num');

    if (query) {
      // Scope-limit which fields the query matches against:
      //   - 'name'    → entityname only (the fund/entity name)
      //   - 'related' → related_names only (key person / GP / promoter)
      //   - 'adviser' → not applicable on Form D side; return empty
      //   - 'all' (default) → entityname OR related_names (legacy behavior)
      if (scope === 'name') {
        dbQuery = dbQuery.ilike('entityname', `%${query}%`);
      } else if (scope === 'related') {
        dbQuery = dbQuery.ilike('related_names', `%${query}%`);
      } else if (scope === 'adviser') {
        // Form D doesn't track an adviser_name directly; return empty.
        return res.json({ results: [], total: 0, note: 'scope=adviser is ADV-only' });
      } else {
        dbQuery = dbQuery.or(`entityname.ilike.%${query}%,related_names.ilike.%${query}%`);
      }
    }

    // State filter (server-side - works fine)
    if (state) dbQuery = dbQuery.eq('stateorcountry', state);

    // Server-side date filtering for YYYY-MM-DD formatted dates (newer records)
    // This ensures we actually get records in the requested date range
    if (startDate) dbQuery = dbQuery.gte('filing_date', startDate);
    if (endDate) dbQuery = dbQuery.lte('filing_date', endDate + 'Z'); // Add Z to include end date

    // Order by id descending (indexed, fast) to get most recent filings first
    dbQuery = dbQuery.order('id', { ascending: false }).limit(Math.min(parseInt(limit), 2000));

    const { data, error } = await dbQuery;
    if (error) throw error;

    // Sort by parsed date (handles mixed DD-MMM-YYYY and YYYY-MM-DD formats)
    let sortedData = (data || []).sort((a, b) => {
      const dateA = parseFilingDate(a.filing_date);
      const dateB = parseFilingDate(b.filing_date);
      return dateB - dateA; // Descending (newest first)
    });

    // Client-side date filtering (handles mixed date formats correctly)
    if (startDate || endDate) {
      const startDateObj = startDate ? new Date(startDate + 'T00:00:00') : null;
      const endDateObj = endDate ? new Date(endDate + 'T23:59:59') : null;

      sortedData = sortedData.filter(filing => {
        const filingDate = parseFilingDate(filing.filing_date);
        if (startDateObj && filingDate < startDateObj) return false;
        if (endDateObj && filingDate > endDateObj) return false;
        return true;
      });
      console.log(`[Form D] Date filter applied: ${startDate || 'any'} to ${endDate || 'any'}, ${sortedData.length} results after filter`);
    }

    // Deduplicate by CIK (keep most recent filing for each CIK)
    const fundMap = new Map();
    for (const filing of sortedData) {
      const key = filing.cik || filing.entityname;
      if (!fundMap.has(key)) {
        fundMap.set(key, filing);
      }
    }

    // Apply limit after deduplication and normalize field names for frontend
    let results = Array.from(fundMap.values()).slice(0, parseInt(limit)).map(fund => ({
      ...fund,
      fund_name: fund.entityname,
      form_d_cik: fund.cik,
      form_d_filing_date: fund.filing_date,
      federal_exemptions: fund.federalexemptions_items_list,
      investment_fund_type: fund.investmentfundtype,
      form_d_offering_amount: fund.totalofferingamount,
      form_d_amount_sold: fund.totalamountsold,
      form_d_file_number: fund.file_num,
      form_d_phone: fund.issuerphonenumber,
      form_d_min_investment: fund.minimuminvestmentaccepted,
      form_d_num_investors: fund.totalnumberalreadyinvested,
      form_d_signer: fund.nameofsigner,
      form_d_signer_title: fund.signaturetitle,
      form_d_address: [fund.street1, fund.city, fund.stateorcountry, fund.zipcode].filter(Boolean).join(', '),
      form_d_first_sale_date: fund.sale_date,
      form_d_remaining: fund.totalremaining,
      form_d_sales_commission: fund.salescomm_dollaramount,
      form_d_finders_fee: fund.findersfee_dollaramount,
      form_d_has_non_accredited: fund.hasnonaccreditedinvestors,
      form_d_num_non_accredited: fund.numbernonaccreditedinvestors,
      form_d_is_amendment: fund.isamendment,
      form_d_industry: fund.industrygrouptype,
      form_d_entity_type: fund.entitytype,
      form_d_jurisdiction: fund.jurisdictionofinc,
      source: 'formd'
    }));

    // Enrich with adviser data by matching related_names to advisers_enriched
    // Extract adviser names from related_names (format: "ADVISER NAME | PERSON NAME")
    const adviserNamesToLookup = new Set();
    results.forEach(fund => {
      if (fund.related_names) {
        const names = fund.related_names.split('|').map(n => n.trim());
        const roles = (fund.related_roles || '').split('|').map(r => r.trim());

        // Find names with "Promoter" or first name if no promoter
        const promoterIdx = roles.findIndex(r => r.toLowerCase().includes('promoter'));
        const adviserName = promoterIdx >= 0 ? names[promoterIdx] : names[0];

        if (adviserName && adviserName !== 'N/A' && !adviserName.match(/^\d+$/)) {
          adviserNamesToLookup.add(adviserName);
        }
      }
    });

    // Batch lookup advisers from ADV database
    if (adviserNamesToLookup.size > 0) {
      try {
        const adviserNameArray = Array.from(adviserNamesToLookup);
        const adviserMatches = new Map();

        // Query in batches of 50
        for (let i = 0; i < adviserNameArray.length; i += 50) {
          const batch = adviserNameArray.slice(i, i + 50);
          const orConditions = batch.map(name =>
            `adviser_name.ilike.%${name.substring(0, 30)}%,adviser_entity_legal_name.ilike.%${name.substring(0, 30)}%`
          ).join(',');

          const { data } = await advClient
            .from('advisers_enriched')
            .select('crd,adviser_name,adviser_entity_legal_name')
            .or(orConditions)
            .limit(batch.length * 2);

          if (data) {
            data.forEach(adviser => {
              const key = adviser.adviser_name || adviser.adviser_entity_legal_name;
              if (!adviserMatches.has(key)) {
                adviserMatches.set(key, adviser);
              }
            });
          }
        }

        // Attach adviser data to funds
        results = results.map(fund => {
          if (fund.related_names) {
            const names = fund.related_names.split('|').map(n => n.trim());
            const roles = (fund.related_roles || '').split('|').map(r => r.trim());
            const promoterIdx = roles.findIndex(r => r.toLowerCase().includes('promoter'));
            const adviserName = promoterIdx >= 0 ? names[promoterIdx] : names[0];

            // Try to find matching adviser
            for (const [key, adviser] of adviserMatches) {
              const nameMatch = adviserName.toLowerCase().includes(key.toLowerCase()) ||
                               key.toLowerCase().includes(adviserName.toLowerCase());
              if (nameMatch) {
                return {
                  ...fund,
                  adviser_entity_crd: adviser.crd,
                  adviser_entity_legal_name: adviser.adviser_entity_legal_name || adviser.adviser_name
                };
              }
            }
          }
          return fund;
        });
      } catch (err) {
        console.error('[Form D] Adviser enrichment error:', err.message);
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Form D search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Browse cross-reference matches
app.get('/api/browse-computed', async (req, res) => {
  try {
    const { limit = 10000, offset = 0, discrepanciesOnly, overdueAdvOnly, searchTerm } = req.query;
    console.log(`[Gemini] Browsing computed matches`);

    let query = formdClient.from('cross_reference_matches').select('*', { count: 'estimated' });

    if (searchTerm && searchTerm.trim().length > 0) {
      query = query.or(`adv_fund_name.ilike.%${searchTerm}%,formd_entity_name.ilike.%${searchTerm}%,adviser_entity_legal_name.ilike.%${searchTerm}%`);
    }

    if (discrepanciesOnly === 'true') {
      query = query.not('issues', 'is', null).neq('issues', '');
    }

    if (overdueAdvOnly === 'true') {
      query = query.eq('overdue_adv_flag', true);
    }

    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1).order('computed_at', { ascending: false });

    const { data: matches, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      matches: matches || [],
      total_matches: count || matches?.length || 0,
      inconsistency_count: (matches || []).filter(m => m.issues && m.issues.trim() !== '').length
    });
  } catch (error) {
    console.error('Browse computed error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Compliance Discrepancies - Intelligence Radar
app.get('/api/discrepancies', async (req, res) => {
  try {
    const { limit = 1000, offset = 0, severity, type, searchTerm, status = 'active' } = req.query;
    console.log(`[Intelligence Radar] Fetching compliance issues - severity: ${severity || 'all'}, type: ${type || 'all'}, search: ${searchTerm || 'none'}`);

    let query = formdClient
      .from('compliance_issues')
      .select('*', { count: 'estimated' });

    // Filter by status (default: active only)
    if (status) {
      query = query.eq('status', status);
    }

    // Filter by severity (comma-separated: e.g., "high,critical")
    if (severity) {
      const severities = severity.split(',').map(s => s.trim());
      query = query.in('severity', severities);
    }

    // Filter by discrepancy type (comma-separated)
    if (type) {
      const types = type.split(',').map(t => t.trim());
      query = query.in('discrepancy_type', types);
    }

    // Search across fund names, entity names, and descriptions
    if (searchTerm && searchTerm.trim().length > 0) {
      query = query.or(`description.ilike.%${searchTerm}%,metadata->>fund_name.ilike.%${searchTerm}%,metadata->>entity_name.ilike.%${searchTerm}%`);
    }

    query = query
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)
      .order('severity', { ascending: false })
      .order('detected_date', { ascending: false });

    const { data: issues, error, count } = await query;
    if (error) {
      console.error('[Intelligence Radar] Query error:', error);
      throw error;
    }

    // Fetch adviser details from ADV database (cross-database lookup)
    const crdList = [...new Set((issues || []).map(i => i.adviser_crd).filter(Boolean))];
    let adviserMap = new Map();

    if (crdList.length > 0) {
      try {
        const { data: advisers, error: advError } = await advClient
          .from('advisers_enriched')
          .select('crd, adviser_name, adviser_entity_legal_name, primary_website, phone_number, regulatory_contact_email')
          .in('crd', crdList);

        if (!advError && advisers) {
          advisers.forEach(adv => adviserMap.set(adv.crd, adv));
        }
      } catch (err) {
        console.warn('[Intelligence Radar] Adviser lookup failed:', err.message);
      }
    }

    // Transform to frontend format
    const discrepancies = (issues || []).map(issue => {
      const adviser = adviserMap.get(issue.adviser_crd);
      const meta = issue.metadata || {};

      // Determine entity name with explicit fallback chain
      let entityName = 'Unknown';
      if (adviser?.adviser_name) {
        entityName = adviser.adviser_name;
      } else if (adviser?.adviser_entity_legal_name) {
        entityName = adviser.adviser_entity_legal_name;
      } else if (meta.entity_name) {
        entityName = meta.entity_name;
      } else if (meta.adviser_name) {
        entityName = meta.adviser_name;
      } else if (meta.fund_name) {
        entityName = meta.fund_name;
      }

      return {
        id: issue.id,
        fund_reference_id: issue.fund_reference_id,
        crd: issue.adviser_crd,
        form_d_cik: issue.form_d_cik,
        type: issue.discrepancy_type,
        severity: issue.severity,
        status: issue.status,
        description: issue.description,
        metadata: meta,
        detected_date: issue.detected_date,
        resolved_date: issue.resolved_date,
        // Adviser/entity details - use computed entityName
        entity_name: entityName,
        fund_name: meta.sample_non_vc_funds?.[0]?.name || meta.primary_fund_name || meta.adv_fund_name || meta.fund_name,
        contact_info: {
          email: adviser?.regulatory_contact_email || meta.contact_email,
          phone: adviser?.phone_number || meta.contact_phone,
          website: adviser?.primary_website
        }
      };
    });

    res.json({
      success: true,
      discrepancies,
      total: count || discrepancies.length,
      filters: { severity, type, status }
    });
  } catch (error) {
    console.error('[Intelligence Radar] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Multi-Platform Managers (managers using multiple fund admin platforms)
app.get('/api/multi-platform-managers', (req, res) => {
  try {
    const { searchTerm, platformFilter, minPlatforms = 2, limit = 100, offset = 0 } = req.query;
    console.log(`[Multi-Platform] Fetching managers - search: ${searchTerm || 'none'}, platform: ${platformFilter || 'all'}, minPlatforms: ${minPlatforms}`);

    let filtered = [...multiPlatformManagers];

    // Filter by minimum platforms
    if (minPlatforms > 1) {
      filtered = filtered.filter(m => parseInt(m.num_platforms) >= parseInt(minPlatforms));
    }

    // Filter by platform
    if (platformFilter) {
      const platforms = platformFilter.split(',').map(p => p.trim().toLowerCase());
      filtered = filtered.filter(m => {
        const managerPlatforms = (m.platforms_used || '').toLowerCase();
        return platforms.some(p => managerPlatforms.includes(p));
      });
    }

    // Search by manager name, IA firm name, or sample entities
    if (searchTerm && searchTerm.trim()) {
      const search = searchTerm.toLowerCase();
      filtered = filtered.filter(m =>
        (m.display_name || '').toLowerCase().includes(search) ||
        (m.ia_firm_name || '').toLowerCase().includes(search) ||
        (m.sample_entities || '').toLowerCase().includes(search)
      );
    }

    // Sort by number of filings (most active first)
    filtered.sort((a, b) => parseInt(b.num_filings || 0) - parseInt(a.num_filings || 0));

    // Pagination
    const start = parseInt(offset);
    const end = start + parseInt(limit);
    const paginated = filtered.slice(start, end);

    // Transform to API response format
    const managers = paginated.map(m => {
      // Parse team_members if it's a JSON string
      let teamMembers = [];
      if (m.team_members) {
        try {
          teamMembers = JSON.parse(m.team_members.replace(/'/g, '"'));
        } catch {
          teamMembers = [];
        }
      }

      return {
        id: m.manager_key,
        display_name: m.display_name,
        manager_key: m.manager_key,
        num_platforms: parseInt(m.num_platforms) || 0,
        platforms: (m.platforms_used || '').split(', ').filter(Boolean),
        num_filings: parseInt(m.num_filings) || 0,
        num_ciks: parseInt(m.num_ciks) || 0,
        linked_crd: m.linked_crd || null,
        ia_firm_name: m.ia_firm_name || null,
        form_adv_url: m.form_adv_url || null,
        website: m.website || null,
        linkedin_url: m.linkedin_url || null,
        phone: m.phone || null,
        cco_name: m.cco_name || null,
        cco_email: m.cco_email || null,
        team_members: teamMembers,
        sample_entities: (m.sample_entities || '').split(' | ').slice(0, 3),
        platform_signers: m.platform_signers || null,
        match_type: m.match_type || null
      };
    });

    // Get unique platforms for filter options
    const allPlatforms = new Set();
    multiPlatformManagers.forEach(m => {
      (m.platforms_used || '').split(', ').forEach(p => {
        if (p.trim()) allPlatforms.add(p.trim());
      });
    });

    res.json({
      success: true,
      managers,
      total: filtered.length,
      platforms: Array.from(allPlatforms).sort(),
      filters: { searchTerm, platformFilter, minPlatforms }
    });
  } catch (error) {
    console.error('[Multi-Platform] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: New Managers
app.get('/api/funds/new-managers', async (req, res) => {
  try {
    const { startDate, endDate, fundType, state, query } = req.query;

    // Default to last 12 months if no date filter provided for performance
    const defaultStartDate = startDate || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    console.log(`[Gemini] Fetching new managers from ${defaultStartDate} to ${endDate || 'now'}, fundType: ${fundType || 'all'}, state: ${state || 'all'}, query: ${query || 'none'}`);

    // EMERGENCY FIX 2026-05-22: form_d_filings has grown to ~330K rows and
    // OFFSET pagination on this table now hits Postgres statement_timeout
    // (Supabase error 57014: "canceling statement due to statement timeout").
    // Per MEMORY.md: "NEVER use OFFSET pagination for large tables (>50k rows)."
    // Converted to keyset pagination on the indexed `id` column.
    const data = [];
    const BATCH_SIZE = 1000;
    let lastId = 0;
    while (true) {
      let q = formdClient
        .from('form_d_filings')
        .select('*')
        .gt('id', lastId)
        .order('id', { ascending: true })
        .limit(BATCH_SIZE);

      if (query) {
        q = q.ilike('entityname', `%${query}%`);
      } else {
        q = q.ilike('entityname', '%a series of%');
      }

      q = q.neq('isamendment', 'true');
      // Hard scope gate: only pooled-investment-fund issuers.
      q = q.eq('industrygrouptype', 'Pooled Investment Fund');
      q = q.gte('filing_date', defaultStartDate);
      if (endDate) q = q.lte('filing_date', endDate);
      if (fundType) q = q.ilike('investmentfundtype', `%${fundType}%`);
      if (state) q = q.eq('stateorcountry', state);

      const { data: batch, error } = await q;
      if (error) {
        console.error(`[new-managers] keyset fetch error at lastId=${lastId}:`, error.message);
        break;
      }
      if (!batch || batch.length === 0) break;
      data.push(...batch);
      lastId = batch[batch.length - 1].id;
      console.log(`  Keyset fetched ${batch.length} rows (lastId now ${lastId}, total ${data.length})`);
      if (batch.length < BATCH_SIZE) break;
    }

    console.log(`  Total filings fetched: ${data.length}`);

    // Sort by parsed date first (handles mixed DD-MMM-YYYY and YYYY-MM-DD formats)
    const sortedData = (data || []).sort((a, b) => {
      const dateA = parseFilingDate(a.filing_date);
      const dateB = parseFilingDate(b.filing_date);
      return dateB - dateA; // Descending (newest first)
    });

    // Group by series master
    const seriesPattern = /,?\s+a\s+series\s+of\s+(.+?)(?:\s*,?\s*$|$)/i;
    const adminUmbrellas = ['roll up vehicles', 'angellist funds', 'multimodal ventures', 'mv funds', 'cgf2021 llc', 'sydecar'];
    const managers = {};

    sortedData.forEach(filing => {
      const match = (filing.entityname || '').match(seriesPattern);
      if (match) {
        const masterLlc = match[1].trim();
        const isAdmin = adminUmbrellas.some(p => masterLlc.toLowerCase().includes(p));
        if (!isAdmin) {
          if (!managers[masterLlc]) {
            managers[masterLlc] = {
              series_master_llc: masterLlc,
              first_filing_date: filing.filing_date,
              first_filing_date_parsed: parseFilingDate(filing.filing_date),
              funds: [],
              total_offering_amount: 0,
              fund_count: 0
            };
          }
          managers[masterLlc].funds.push(filing);
          managers[masterLlc].fund_count++;
          managers[masterLlc].total_offering_amount += parseFloat(filing.totalofferingamount) || 0;
          // Compare using parsed dates
          const currentParsed = parseFilingDate(filing.filing_date);
          if (currentParsed < managers[masterLlc].first_filing_date_parsed) {
            managers[masterLlc].first_filing_date = filing.filing_date;
            managers[masterLlc].first_filing_date_parsed = currentParsed;
          }
        }
      }
    });

    // Sort managers by first filing date (newest first) using parsed dates
    let result = Object.values(managers).sort((a, b) => {
      return b.first_filing_date_parsed - a.first_filing_date_parsed;
    });

    // OPTIMIZED: Batch fetch enriched_managers and advisers upfront instead of individual queries
    console.log(`[Gemini] Batch fetching enrichment data for ${result.length} managers...`);

    // Batch fetch all enriched_managers data
    const enrichedManagersData = await fetchAllResultsPaginated((from, to) => {
      return formdClient
        .from('enriched_managers')
        .select('*')
        .range(from, to);
    });

    // Create lookup map for enriched managers
    // Index by BOTH full name AND parsed umbrella name for better matching
    const enrichedSeriesPattern = /,?\s+a\s+series\s+of\s+(.+?)(?:\s*,?\s*$|$)/i;
    const enrichedManagersMap = {};
    enrichedManagersData.forEach(em => {
      if (em.series_master_llc) {
        const fullName = em.series_master_llc.toLowerCase();
        enrichedManagersMap[fullName] = em;

        // Also index by parsed umbrella name (if it's a series pattern)
        const emMatch = em.series_master_llc.match(enrichedSeriesPattern);
        if (emMatch) {
          const umbrellaName = emMatch[1].trim().toLowerCase();
          // Only add if not already present (prefer exact match)
          if (!enrichedManagersMap[umbrellaName]) {
            enrichedManagersMap[umbrellaName] = em;
          }
        }
      }
    });
    console.log(`  Loaded ${enrichedManagersData.length} enriched managers for matching (indexed by full name + umbrella)`);

    // Batch fetch all advisers for matching. Include registration_type so the
    // frontend can distinguish RIA vs SEC-ERA vs State-ERA; include AUM years
    // as a CONFIDENCE signal (active = has AUM data) but DO NOT filter by it.
    //
    // Production bug 2026-05-11: previously this filtered out State-ERAs with
    // no AUM data, which made the bidirectional matcher miss real registered
    // advisers like Capital Factory (CRD 192514) and Great Circle Ventures GP
    // (CRD 326490) — both legitimately registered State-ERAs with NULL AUM.
    // User caught it by Googling "Capital Factory form ADV"; the matcher was
    // structurally blind to them.
    // Use the module-scope cached adviser index instead of rebuilding per request.
    // See getAdviserIndex() comment block — fixes 30-second per-request hang.
    const advIdx = await getAdviserIndex();
    const advisersByNameExact = advIdx.advisersByNameExact;
    const advisersByNamePrefix = advIdx.advisersByNamePrefix;
    const tokenToAdvIdx = advIdx.tokenToAdvIdx;  // inverted token index for narrowed candidate lookup
    const { distinctiveTokens: distinctiveTokensShared } = require('./lib/name_matcher');
    const isAdviserActive = (adv) => adv.aum_2023 || adv.aum_2024 || adv.aum_2025 || adv.aum_2026 || adv.total_aum;
    console.log(`  Using cached adviser index: ${advIdx.count} advisers (built ${Math.round((Date.now() - advIdx.builtAt)/1000)}s ago)`);

    // Use shared base-name extractor from the detector lib. Production bug
    // 2026-05-11: the inline parseFundName regex was incorrectly stripping
    // " VC LLC" as a state-2-letter pattern (turning "Moreno VC LLC" into
    // "Moreno"). Using lib/adv_lookup.js's extractBaseName ensures the two
    // matching paths (this endpoint + the detector) use the same name shape.
    const { extractBaseName: parseFundName } = require('./lib/adv_lookup');
    const nameVariants = require('./lib/name_variants');
    const { passesStricterCrdGate } = require('./lib/name_matcher');
    const { buildPublicView } = require('./enrichment/v3/publish/public_view');

    // Token-subset matcher. Production bug 2026-05-11 (multiple): the previous
    // bidirectional `startsWith` matched on very short adviser_entity_legal_name
    // values ("MATERIAL", "FRONT", "MVP") AND naive substring ilike matched
    // embedded substrings (KIG → IKIGAI). Token-subset on RAW tokens (no
    // stopword filter, min-length 2) + min-size guard solves both.
    //
    // Key tuning insight: keep short tokens (≥2 chars) so distinguishing
    // tokens like "in" (FIRST IN VENTURES) / "nc" (BACKBONE NC) / "u s"
    // (U.S. VENTURE PARTNERS) stay in the set and BLOCK loose subset matches.
    //   - "First Bight Ventures" {first,bight,venture} vs "FIRST IN VENTURES"
    //     {first,in,venture}: "in" ∈ adv but not mgr → no subset → no match ✓
    //   - "Front Porch Venture Partners SPV" vs "U.S. VENTURE PARTNERS"
    //     {us,venture,partner} (or similar): "us" not in mgr → no match ✓
    //   - "Capital Factory SPVs" {capital,factory,spv} vs "CAPITAL FACTORY"
    //     {capital,factory}: adv ⊆ mgr → match ✓
    // Tokens stemmed (trailing 's' stripped if word ends in 's' and len≥4) so
    // "ventures" and "venture" compare equal.
    // Both sides require ≥2 tokens: rejects ambiguous single-token firms
    // (KIG → KIG INVESTMENT MGMT; Capital Factory bare → CAPITAL FACTORY).
    // Acceptable tradeoff — detector lib catches single-token cases.
    // Stopwords used for the distinctive-overlap gate. They aren't removed from
    // the raw token sets (which keep "venture", "partner", etc. to enforce
    // containment); they just don't count toward "distinctive" gates.
    // Added 2026-05-11: "investment(s)", "partnership(s)" — both common generic
    // firm-name modifiers that lead to wrong matches when they're the only
    // overlap.
    const MATCH_STOPWORDS_BASE = [
      'the','of','and','co','llc','lp','llp','ltd','inc','corp','company',
      'fund','funds','capital','ventures','venture','partners','partner','partnership','partnerships',
      'holdings','holding','group','management','mgmt','advisors','advisers',
      'gp','master','feeder','series','spv','spvs','investment','investments',
      'first','new','global','international',
    ];
    const stem = (t) => (t.length >= 4 && t.endsWith('s') ? t.slice(0, -1) : t);
    // Pre-stem the stopword list so distinctiveOf catches stemmed token forms.
    // Without this, words like "series" stem to "serie" (length 6, ends in 's')
    // but the base set only contains 'series' — so 'serie' leaks as "distinctive"
    // and pollutes the manager-side extra-token check. Same fix in
    // lib/name_matcher.js#distinctiveTokens.
    const MATCH_STOPWORDS = new Set(MATCH_STOPWORDS_BASE);
    for (const w of MATCH_STOPWORDS_BASE) MATCH_STOPWORDS.add(stem(w));
    const rawTokens = (s) => {
      const toks = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
      return new Set(toks.filter(t => t.length >= 2).map(stem));
    };
    const distinctiveOf = (tokens) => {
      const out = new Set();
      for (const t of tokens) if (!MATCH_STOPWORDS.has(t)) out.add(t);
      return out;
    };
    const sharedDistinctive = (a, b) => {
      let n = 0;
      for (const t of a) if (b.has(t) && !MATCH_STOPWORDS.has(t)) n++;
      return n;
    };
    // Per-pair predicate: bidirectional token-subset match against ONE candidate adviser.
    // Used inside the inverted-index narrowed loop in tryAdviserMatch below.
    const advPairMatches = (mgrTokens, mgrDist, name, nameIdx) => {
      if (!name) return false;
      const advTokens = rawTokens(name);
      if (advTokens.size < 2) return false;
      // Production bug 2026-05-11: short adviser_entity_legal_name values
      // ("ANCHOR CAPITAL" — 2 tokens) are common prefixes across unrelated firms.
      if (nameIdx === 1 && advTokens.size <= 2) return false;
      if (sharedDistinctive(mgrTokens, advTokens) < 1) return false;
      const advDist = distinctiveOf(advTokens);
      // Direction A: adv ⊆ mgr
      if (advTokens.size <= mgrTokens.size && [...advTokens].every(t => mgrTokens.has(t))) {
        const mgrExtraDist = [...mgrDist].filter(t => !advDist.has(t));
        if (mgrExtraDist.length === 0) return true;
      }
      // Direction B: mgr ⊆ adv
      if (mgrTokens.size <= advTokens.size && [...mgrTokens].every(t => advTokens.has(t))) {
        const advExtraDist = [...advDist].filter(t => !mgrDist.has(t));
        if (advExtraDist.length === 0) return true;
      }
      return false;
    };

    // Inverted-index-narrowed candidate lookup. Reduces per-variant scan from
    // O(57K advisers) to O(~5-20 token-overlapping candidates) — ~2000x speedup.
    // Was the 2026-05-22 production-outage fix.
    const tryAdviserMatch = (variantName) => {
      const lowerName = variantName.toLowerCase();
      if (advisersByNameExact[lowerName]) {
        return advisersByNameExact[lowerName];
      }
      const mgrTokens = rawTokens(lowerName);
      const mgrDist = distinctiveOf(mgrTokens);
      if (mgrTokens.size < 1) return null;

      // Use the SAME tokenization the index was built with (lib/name_matcher).
      // Union the adviser indexes that share at least one distinctive token.
      const variantDistinct = distinctiveTokensShared(variantName);
      if (variantDistinct.size === 0) return null;
      const candidateIdxs = new Set();
      for (const tok of variantDistinct) {
        const advSet = tokenToAdvIdx.get(tok);
        if (advSet) for (const i of advSet) candidateIdxs.add(i);
      }
      if (candidateIdxs.size === 0) return null;

      for (const i of candidateIdxs) {
        const { names, adv } = advisersByNamePrefix[i];
        for (let nameIdx = 0; nameIdx < names.length; nameIdx++) {
          if (advPairMatches(mgrTokens, mgrDist, names[nameIdx], nameIdx)) {
            return adv;
          }
        }
      }
      return null;
    };

    // Variant-laddered match — RESTORED 2026-05-22 with inverted-token-index.
    // Tries progressively shorter name variants so manager-side tail tokens
    // ("Series", "Master", "Opportunity", "Growth", "Holdings") that aren't in
    // the SEC adviser_name don't block a match. Hash3-class fix.
    //
    // Original variant-ladder (commit 3472334) became prohibitively slow as
    // form_d_filings + advisers_enriched grew: 4 variants × 57K full-scan ×
    // 1949 managers = ~400M comparisons. The inverted-token-index built in
    // the adviser cache narrows each variant's candidate set to O(~5-20),
    // making the variant ladder cheap.
    //
    // Stricter CRD gate (passesStricterCrdGate) rejects acronym-only false
    // positives — e.g., "TMS" alone matching "TMS Capital Management" when
    // the actual firm is "TMS Angels" (unrelated).
    const findAdviserMatch = (parsedName, opts = {}) => {
      const variants = nameVariants.generateVariants(parsedName, { extraStripper: parseFundName });
      const tries = [parsedName, ...variants];
      const seen = new Set();
      for (const v of tries) {
        if (!v || seen.has(v.toLowerCase())) continue;
        seen.add(v.toLowerCase());
        const adv = tryAdviserMatch(v);
        if (!adv) continue;
        const gate = passesStricterCrdGate(
          { found: true, adviser_name: adv.adviser_name },
          parsedName,
          { matchedVariant: v, relatedNames: opts.relatedNames || null }
        );
        if (gate.pass) return adv;
      }
      return null;
    };

    // Process all managers in memory (no API calls)
    const enrichedResult = result.map(manager => {
      const enrichedManager = { ...manager };
      const parsedName = parseFundName(manager.series_master_llc);

      // Check enriched_managers lookup
      const enrichedData = enrichedManagersMap[manager.series_master_llc.toLowerCase()];
      if (enrichedData) {
        // Per-field publish gate: buildPublicView handles both v3 rows (field_evidence JSONB)
        // and v2 legacy rows (flat columns). Each field is emitted only when verified.
        const baseView = buildPublicView(enrichedData);
        enrichedManager.enrichment_data = {
          ...baseView,
          // Supplemental fields not gated by field_evidence
          fund_type: enrichedData.fund_type,
          investment_stage: enrichedData.investment_stage,
          portfolio_companies: enrichedData.portfolio_companies || [],
        };
      }

      // Check advisers lookup. Pass relatedNames so the stricter gate can
      // do acronym corroboration via Form D principals when needed.
      const advData = findAdviserMatch(parsedName, { relatedNames: manager.related_names });
      if (advData) {
        enrichedManager.has_form_adv = true;
        enrichedManager.linked_crd = advData.crd;
        enrichedManager.adv_data = {
          crd: advData.crd,
          name: advData.adviser_name || advData.adviser_entity_legal_name,
          website: advData.primary_website,
          aum: advData.total_aum,
          registration_type: advData.registration_type,  // SEC-RIA / SEC-ERA / State-RIA / State-ERA / null
          adviser_active: isAdviserActive(advData),       // has AUM data; helps frontend distinguish dormant vs active
        };
      } else {
        enrichedManager.has_form_adv = false;
      }

      // Check external investor databases (OpenVC + Ramp) for supplemental data
      const extMatch = lookupInvestor(parsedName) || lookupInvestor(manager.series_master_llc);
      if (extMatch) {
        const ed = enrichedManager.enrichment_data || {};
        const isSuppressed = ed.suppressed === true;
        enrichedManager.enrichment_data = {
          ...ed,
          // Identity fields (website/linkedin/twitter/email) are only merged from external DB
          // when the enriched_managers row passed the anchor gate. If suppressed, we skip these
          // to avoid surfacing unverified identity data from an alternative source.
          ...(isSuppressed ? {} : {
            website: ed.website || extMatch.website_url,
            linkedin: ed.linkedin || extMatch.linkedin_url,
            twitter: ed.twitter || extMatch.twitter_url,
            email: ed.email || extMatch.primary_contact_email,
          }),
          // Neutral supplemental fields are always safe to surface regardless of gate status.
          fund_type: ed.fund_type || extMatch.investor_type,
          investment_stage: ed.investment_stage || extMatch.investment_stage,
          investment_sectors: ed.investment_sectors || extMatch.investment_sectors,
          check_size_min: extMatch.check_size_min_usd,
          check_size_max: extMatch.check_size_max_usd,
          contact_name: isSuppressed ? undefined : extMatch.contact_name,
          description: extMatch.description,
          founded_year: extMatch.founded_year,
          hq_location: extMatch.hq_location,
          external_db_source: extMatch.source,
        };
        enrichedManager.has_external_db = true;
      }

      return enrichedManager;
    });

    const hasAdvCount = enrichedResult.filter(m => m.has_form_adv).length;
    console.log(`[Gemini] Found ${hasAdvCount} managers with existing Form ADV data`);

    res.json({ success: true, managers: enrichedResult, total: enrichedResult.length });
  } catch (error) {
    console.error('New managers error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENRICHMENT REVIEW QUEUE ROUTES
// ============================================

// Get all funds needing manual review
app.get('/api/review/queue', async (req, res) => {
  try {
    const { data, error } = await formdClient
      .from('enriched_managers')
      .select('*')
      .in('enrichment_status', ['needs_manual_review', 'platform_spv', 'no_data_found', 'conflicting_data'])
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      managers: data
    });
  } catch (error) {
    console.error('Error fetching review queue:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get auto-enriched funds (for verification)
app.get('/api/review/auto-enriched', async (req, res) => {
  try {
    const { data, error } = await formdClient
      .from('enriched_managers')
      .select('*')
      .eq('enrichment_status', 'auto_enriched')
      .eq('is_published', false)
      .order('confidence_score', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      managers: data
    });
  } catch (error) {
    console.error('Error fetching auto-enriched:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Publish a fund (mark as verified and public)
app.post('/api/review/publish', async (req, res) => {
  try {
    const { id } = req.body;

    const { data, error } = await formdClient
      .from('enriched_managers')
      .update({
        is_published: true,
        enrichment_status: 'manually_verified',
        verified_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      manager: data
    });
  } catch (error) {
    console.error('Error publishing fund:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update enrichment data
app.post('/api/review/update', async (req, res) => {
  try {
    const { id, updates } = req.body;

    const { data, error } = await formdClient
      .from('enriched_managers')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      manager: data
    });
  } catch (error) {
    console.error('Error updating fund:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Mark as not a fund / skip
app.post('/api/review/skip', async (req, res) => {
  try {
    const { id, reason } = req.body;

    const { data, error } = await formdClient
      .from('enriched_managers')
      .update({
        enrichment_status: 'not_a_fund',
        flagged_issues: reason ? [reason] : [],
        is_published: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      manager: data
    });
  } catch (error) {
    console.error('Error skipping fund:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get enrichment stats
app.get('/api/review/stats', async (req, res) => {
  try {
    const { data, error } = await formdClient
      .from('enriched_managers')
      .select('enrichment_status, is_published');

    if (error) throw error;

    const stats = {
      total: data.length,
      auto_enriched: data.filter(m => m.enrichment_status === 'auto_enriched').length,
      needs_review: data.filter(m => m.enrichment_status === 'needs_manual_review').length,
      platform_spv: data.filter(m => m.enrichment_status === 'platform_spv').length,
      no_data: data.filter(m => m.enrichment_status === 'no_data_found').length,
      manually_verified: data.filter(m => m.enrichment_status === 'manually_verified').length,
      published: data.filter(m => m.is_published).length,
      unpublished: data.filter(m => !m.is_published).length
    };

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// UNIFIED ADVISER / ENRICHED MANAGER ROUTES
// ============================================

// Get unified adviser data (Form ADV + Enriched Manager)
app.get('/api/advisers/unified/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const isCRD = /^\d+$/.test(identifier);

    let adviserData = null;
    let enrichedData = null;
    let portfolioCompanies = [];

    if (isCRD) {
      // Fetch from Form ADV by CRD
      const { data: advData } = await advClient
        .from('advisers_enriched')
        .select('*')
        .eq('crd', identifier)
        .single();

      adviserData = advData;

      // Check if also in enriched managers (linked by CRD)
      const { data: enriched } = await formdClient
        .from('enriched_managers')
        .select('*')
        .eq('linked_crd', identifier)
        .single();

      enrichedData = enriched;
    } else {
      // Fetch from enriched managers by name
      const { data: enriched } = await formdClient
        .from('enriched_managers')
        .select('*')
        .eq('series_master_llc', identifier)
        .single();

      enrichedData = enriched;

      // If has CRD, also fetch ADV data
      if (enriched && enriched.linked_crd) {
        const { data: advData } = await advClient
          .from('advisers_enriched')
          .select('*')
          .eq('crd', enriched.linked_crd)
          .single();

        adviserData = advData;
      }
    }

    // Fetch portfolio companies if enriched data exists
    if (enrichedData) {
      const { data: portfolio } = await formdClient
        .from('portfolio_companies')
        .select('*')
        .eq('manager_id', enrichedData.id)
        .order('company_name');

      portfolioCompanies = portfolio || [];
    }

    // Check if adviser is active (has recent AUM data - not defunct)
    const isAdviserActive = adviserData && (
      adviserData.aum_2023 || adviserData.aum_2024 || adviserData.aum_2025 || adviserData.total_aum
    );

    // Merge the data
    const unifiedData = {
      // Basic info (prefer ADV data if available)
      name: adviserData?.adviser_name || adviserData?.adviser_entity_legal_name || enrichedData?.series_master_llc,
      crd: adviserData?.crd || enrichedData?.linked_crd,
      website: enrichedData?.website_url || adviserData?.primary_website,

      // Form ADV specific (only show as having Form ADV if adviser is currently active)
      hasFormADV: !!isAdviserActive,
      isAdviserDefunct: adviserData && !isAdviserActive,
      advData: adviserData ? {
        aum: adviserData.total_aum,
        crd: adviserData.crd,
        isDefunct: !isAdviserActive
      } : null,

      // Enriched data specific
      hasEnrichedData: !!enrichedData,
      enrichedData: enrichedData ? {
        fund_type: enrichedData.fund_type,
        investment_stage: enrichedData.investment_stage,
        linkedin_url: enrichedData.linkedin_company_url,
        confidence_score: enrichedData.confidence_score,
        enrichment_status: enrichedData.enrichment_status
      } : null,

      // Portfolio companies
      portfolioCompanies
    };

    res.json({
      success: true,
      adviser: unifiedData
    });

  } catch (error) {
    console.error('Error fetching unified adviser:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get portfolio companies for a manager
app.get('/api/managers/:managerId/portfolio', async (req, res) => {
  try {
    const { managerId } = req.params;

    const { data, error } = await formdClient
      .from('portfolio_companies')
      .select('*')
      .eq('manager_id', managerId)
      .order('company_name');

    if (error) throw error;

    res.json({
      success: true,
      companies: data || [],
      count: data?.length || 0
    });

  } catch (error) {
    console.error('Error fetching portfolio companies:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// ENRICHMENT & DISCREPANCY DETECTION ROUTES
// ============================================
const enrichmentRoutes = require('./routes/enrichment_routes');
app.use('/api', enrichmentRoutes);

// ============================================
// SEO-FRIENDLY URL ROUTES
// ============================================
// SEO routes - serve index.html for client-side routing
// Format: /adviser/{crd}-{slug} or /fund/{id}-{slug}
app.get('/adviser/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/fund/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3009;
app.listen(PORT, () => {
  console.log(`\n🚀 Gemini Cross-Reference Visualizer running on port ${PORT}\n`);
});
