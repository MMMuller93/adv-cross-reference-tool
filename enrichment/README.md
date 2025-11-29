# Fund Manager Enrichment System

Automated research and enrichment for the 3,388+ new managers in the database.

## Overview

**Current Status:**
- **3,388 total new managers** in Form D database
- **150 already manually enriched** (in Excel file)
- **~3,238 need automated enrichment**

**Phase 1 (Current):** Basic automated enrichment with manual review queue
**Phase 2 (Future):** + AI classification and team extraction
**Phase 3 (Future):** + Continuous operation with monitoring

---

## Setup

### 1. Install Dependencies

```bash
cd /Users/Miles/Desktop/ADV_Cross_Reference_Gemini
npm install
```

### 2. Get Brave Search API Key (Free Tier: 2,000/month)

1. Go to https://brave.com/search/api/
2. Sign up for free tier
3. Get API key

### 3. Configure Environment

Create `.env` file in project root:

```bash
# Brave Search API (for web research)
BRAVE_SEARCH_API_KEY=your_brave_api_key_here

# Supabase (already configured in server.js, but add here for scripts)
SUPABASE_URL=https://ltdalxkhbbhmkimmogyq.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_here
```

### 4. Create Database Tables

Run the schema script in Supabase SQL editor:

```bash
# Copy contents of database/enrichment_schema.sql
# Paste into Supabase SQL Editor
# Run the script
```

**Or** use Supabase CLI:

```bash
supabase db push --file database/enrichment_schema.sql
```

---

## Usage

### Option 1: Bulk Enrich All Managers (Recommended)

Process all 3,238 unenriched managers:

```bash
node enrichment/bulk_enrich.js
```

**What it does:**
- Fetches all new managers from Form D database
- Skips already enriched ones
- Processes in batches of 20 (to respect API limits)
- Rate limited: ~500ms between requests
- Estimated time: ~27 minutes for 3,238 managers

**Results:**
- ✅ **Auto-enriched** (confidence ≥ 0.7) → Published to public view
- ⏳ **Needs review** (confidence < 0.7) → Internal review queue
- 🔖 **Platform SPVs** → Flagged (Hiive, AngelList, etc.)
- ❌ **No data** → Flagged for manual research

### Option 2: Test Single Manager

```bash
node enrichment/enrichment_engine.js "Ben's Bites Fund, LP"
```

### Option 3: Process Specific Batch

Edit `bulk_enrich.js` and modify the filter logic, or create a custom script.

---

## Cost Analysis

**Free Tier (Brave Search):**
- 2,000 searches/month
- 2 searches per manager = 1,000 managers/month
- Your 3,238 managers = **~3-4 months free** (or pay $50/month to finish in 1 month)

**Paid Option:**
- Brave Search Pro: $5/1,000 queries
- 3,238 managers × 2 searches = 6,476 queries
- Cost: ~**$33 one-time** to process all

---

## Database Structure

### `enriched_managers` Table

Stores enriched fund data:

| Column | Type | Description |
|--------|------|-------------|
| `series_master_llc` | TEXT | Fund name (unique key) |
| `website_url` | TEXT | Fund website |
| `fund_type` | TEXT | VC, PE, Real Estate, etc. |
| `investment_stage` | TEXT | Seed, Series A, etc. |
| `enrichment_status` | TEXT | auto_enriched, needs_manual_review, etc. |
| `confidence_score` | DECIMAL | 0.00-1.00 |
| `is_published` | BOOLEAN | Public visibility (high confidence only) |

### `enriched_team_members` Table

Team members (GPs, Partners, etc.) - Currently **manual only** (Phase 2 will auto-extract)

### `enrichment_queue` Table

Processing queue for tracking batch jobs

---

## Review Queue

After running bulk enrichment, review flagged funds:

**Access:** http://localhost:3009/review (Internal only, not for public)

**Categories:**
1. **Needs Review** - Medium confidence (0.5-0.69), unclear fund type, no website
2. **No Data Found** - No search results, very new/stealth funds
3. **Conflicting Data** - Multiple possible matches

**Actions:**
- ✅ **Publish As-Is** - Verify data is correct, publish
- 🔍 **Manual Research** - Open research modal, enrich manually
- ❌ **Not a Fund** - Mark as operating company/other
- ⏭️ **Skip** - Leave for later

---

## Monitoring

### Check Progress

```bash
# In Supabase SQL Editor
SELECT
  enrichment_status,
  COUNT(*) as count,
  ROUND(AVG(confidence_score)::numeric, 2) as avg_confidence
FROM enriched_managers
GROUP BY enrichment_status
ORDER BY count DESC;
```

### Published vs Internal

```bash
SELECT
  CASE WHEN is_published THEN 'Published' ELSE 'Internal Only' END as visibility,
  COUNT(*) as count
FROM enriched_managers
GROUP BY is_published;
```

---

## Phase 2: AI Enhancement (Future)

**When:** After Phase 1 proves the workflow

**What it adds:**
- GPT-4-mini for classification (95% accuracy vs 70% pattern matching)
- Team member extraction from websites
- Email validation
- Confidence score improvements

**Cost:** ~$1-10/month (GPT-4-mini is very cheap)

**Implementation:**
- Add OpenAI API key to config
- Update `classifyFundType()` to use AI
- Add `extractTeamMembers()` function
- Better handling of edge cases

---

## Phase 3: Continuous Operation (Future)

**When:** After Phase 2 is stable

**What it adds:**
- Daily cron job (runs automatically)
- Enriches new managers as Form D filings come in
- Email/Slack notifications for manual review queue
- Dashboard with metrics and trends

**Implementation:**
- Supabase cron job or GitHub Actions
- Notification service (Resend, SendGrid, Slack webhook)
- Analytics dashboard

---

## Troubleshooting

### "No Brave Search API key"
Add `BRAVE_SEARCH_API_KEY` to `.env` file

### "Supabase error: relation does not exist"
Run `database/enrichment_schema.sql` in Supabase SQL Editor

### "Rate limit exceeded"
Free tier limit reached (2,000/month). Options:
- Wait until next month
- Upgrade to paid tier ($5/1,000 queries)
- Reduce batch size and process over multiple days

### "Too many managers in review queue"
This is normal! Expected ~30-40% need manual review in Phase 1.
- Review highest priority first (largest funds, recent filings)
- Phase 2 (AI) will reduce review queue by ~50%

---

## Import Existing Enriched Funds

If you have already manually enriched funds in an Excel file, import them first:

```bash
node enrichment/import_excel.js
```

**Expected output:**
- Reads `venture_fund_contacts_comprehensive.xlsx` from Downloads folder
- Skips duplicates automatically
- Imports all columns: name, website, fund type, team members, etc.
- Marks as `manually_verified` and published

---

## Review Queue UI

Access the internal review queue at:

**http://localhost:3009/review.html**

**Features:**
- View all funds needing manual review
- Verify auto-enriched funds before publishing
- Edit enrichment data (website, fund type, stage, etc.)
- Publish verified funds to public view
- Skip non-funds (operating companies, etc.)
- Quick research links (Google, LinkedIn, Crunchbase)

**Tabs:**
1. **Needs Review** - Medium confidence, unclear classification
2. **Auto-Enriched** - High confidence, verify before auto-publish
3. **Platform SPVs** - Hiive, AngelList, Sydecar vehicles
4. **No Data Found** - No search results, stealth/new funds

---

## Files

```
enrichment/
├── enrichment_engine.js    # Core enrichment logic
├── bulk_enrich.js          # Batch processing script
├── import_excel.js         # Import existing Excel data
├── README.md               # This file
database/
├── enrichment_schema.sql   # Database tables
public/
├── review.html             # Internal review queue UI
```

---

## Next Steps

1. ✅ Run database schema in Supabase
2. ✅ Configure Brave Search API key in `.env`
3. ✅ Import existing 150 enriched funds from Excel
   ```bash
   node enrichment/import_excel.js
   ```
4. ✅ Test single manager enrichment
   ```bash
   node enrichment/enrichment_engine.js "Ben's Bites Fund, LP"
   ```
5. ⏳ Run bulk enrichment (3,238 managers)
   ```bash
   node enrichment/bulk_enrich.js
   ```
6. ⏳ Review flagged funds via UI
   - Open http://localhost:3009/review.html
   - Verify auto-enriched funds
   - Manually research flagged funds
   - Publish verified data
7. 🔮 Phase 2: Add AI enhancement (GPT-4-mini)
8. 🔮 Phase 3: Automate with cron jobs
