# SEO-Friendly URL Structure

## Goal
Change URLs from query params to path-based for better Google indexing:

| Page | Current | Target |
|------|---------|--------|
| Adviser | `/?adviser=105958` | `/adviser/the-vanguard-group-inc` |
| Fund | `/?tab=funds&q=...` (detail?) | `/fund/equitybee-22-30885-cfund-master` |

## Implementation Steps

### 1. Slug Generation Utility
```javascript
// utils/slug.js
function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with dashes
    .replace(/^-+|-+$/g, '')       // Trim leading/trailing dashes
    .substring(0, 100);            // Limit length
}

// "THE VANGUARD GROUP, INC." → "the-vanguard-group-inc"
// "EQUITYBEE 22-30885, A SERIES OF EQUITYBEE CFUND MASTER LLC" → "equitybee-22-30885-a-series-of-equitybee-cfund-master-llc"
```

### 2. Server Routes (server.js)

**New routes:**
```javascript
// Adviser page by slug
app.get('/adviser/:slug', async (req, res) => {
  const { slug } = req.params;
  // Option A: Lookup by slug column (requires DB change)
  // Option B: Fetch all advisers, find matching slug (slow but no DB change)
  // Option C: Include CRD in slug: /adviser/105958-the-vanguard-group-inc
});

// Fund page by slug
app.get('/fund/:slug', async (req, res) => {
  const { slug } = req.params;
  // Same options as above
});

// 301 redirects from old URLs
app.get('/', (req, res, next) => {
  if (req.query.adviser) {
    // Lookup adviser name, generate slug, redirect
    return res.redirect(301, `/adviser/${slug}`);
  }
  next();
});
```

### 3. Database Options

**Option A: Add slug columns (recommended)**
```sql
-- ADV database
ALTER TABLE advisers_enriched ADD COLUMN slug VARCHAR(150);
UPDATE advisers_enriched SET slug = /* generate from adviser_name */;
CREATE INDEX idx_advisers_slug ON advisers_enriched(slug);

ALTER TABLE funds_enriched ADD COLUMN slug VARCHAR(150);
UPDATE funds_enriched SET slug = /* generate from fund_name */;
CREATE INDEX idx_funds_slug ON funds_enriched(slug);
```

**Option B: Include ID in slug (simpler, no DB change)**
- `/adviser/105958/the-vanguard-group-inc` - ID for lookup, slug for SEO
- `/fund/805-1842765912/equitybee-22-30885`

**Option C: Hybrid - CRD/ID prefix**
- `/adviser/105958-the-vanguard-group-inc` - Parse CRD from start of slug

### 4. Frontend Changes

**React Router setup:**
```jsx
<Route path="/adviser/:slug" element={<AdviserDetail />} />
<Route path="/fund/:slug" element={<FundDetail />} />
```

**Link generation:**
```jsx
// Instead of: <a href={`/?adviser=${crd}`}>
<a href={`/adviser/${generateSlug(adviserName)}`}>
```

### 5. Sitemap Generation

Create `/sitemap.xml` endpoint:
```javascript
app.get('/sitemap.xml', async (req, res) => {
  const advisers = await fetchAllAdvisers();
  const funds = await fetchAllFunds();

  const urls = [
    ...advisers.map(a => `https://privatefundradar.com/adviser/${a.slug}`),
    ...funds.map(f => `https://privatefundradar.com/fund/${f.slug}`)
  ];

  res.type('application/xml');
  res.send(generateSitemapXML(urls));
});
```

### 6. Meta Tags

Add dynamic meta tags per page:
```html
<title>The Vanguard Group Inc - $7.9T AUM | Private Fund Radar</title>
<meta name="description" content="View The Vanguard Group Inc's 22 funds, AUM history, and regulatory filings.">
<link rel="canonical" href="https://privatefundradar.com/adviser/the-vanguard-group-inc">
```

## Recommended Approach

**Phase 1: Hybrid IDs (quick win, no DB changes)**
- `/adviser/105958-the-vanguard-group-inc`
- Parse CRD from URL, use for lookup
- Slug is purely cosmetic for SEO

**Phase 2: Pure slugs (if needed)**
- Add slug columns to DB
- Migration script to populate
- Remove IDs from URLs

## Effort Estimate

| Task | Complexity |
|------|------------|
| Slug utility | Small |
| Server routes | Medium |
| 301 redirects | Small |
| Frontend routing | Medium |
| Sitemap | Small |
| Meta tags | Medium |
| **Total** | ~1-2 days |

## Files to Modify

- `server.js` - New routes, redirects
- `public/app.js` - React routing, link generation
- `public/index.html` - Meta tag templates
- New: `utils/slug.js`
