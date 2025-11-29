# Phase 2 & 3: AI Enhancement + Continuous Operation

## Phase 2: AI-Powered Enrichment

### Goal
Reduce manual review queue from ~40% to ~15% by using AI for classification and data extraction.

### Timeline
After Phase 1 runs for 2-4 weeks and workflow is validated.

### Cost
**~$1-10/month** (GPT-4-mini: $0.15/1M input tokens)

---

### Features to Add

#### 1. AI-Powered Fund Classification

**Current (Phase 1):** Pattern matching (~70% accuracy)
```javascript
if (/venture capital|vc fund|seed/i.test(text)) return 'VC';
```

**Phase 2:** GPT-4-mini classification (~95% accuracy)
```javascript
async function classifyFundTypeAI(name, searchResults) {
  const prompt = `
Given these search results for "${name}":
${JSON.stringify(searchResults.web.results.slice(0, 5))}

Classify this entity as one of:
- VC (venture capital investing in startups)
- PE (private equity, buyouts, growth equity)
- Real Estate (property investment)
- Hedge Fund (trading, market strategies)
- Credit (lending, debt)
- Operating Company (builds products, not an investor)
- SPV Platform (Hiive, AngelList, Sydecar vehicle)
- Charitable Trust (steward ownership, non-profit)
- Unknown

Return JSON:
{
  "fundType": "VC",
  "confidence": 0.95,
  "reasoning": "Clear indicators of seed/Series A venture capital..."
}
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' }
  });

  return JSON.parse(response.choices[0].message.content);
}
```

#### 2. Team Member Extraction

**Current (Phase 1):** Manual only

**Phase 2:** AI extracts team from website/LinkedIn
```javascript
async function extractTeamMembers(websiteUrl) {
  // Fetch website content
  const websiteContent = await fetchWebsite(websiteUrl);

  const prompt = `
Extract team members from this venture capital firm's website:
${websiteContent.substring(0, 8000)} // Truncated

Find:
- Names
- Titles (Managing Partner, GP, Partner, Principal, etc.)
- Emails (if available)

Return JSON array:
[
  {
    "name": "Jane Smith",
    "title": "Managing Partner",
    "email": "jane@example.com",
    "isKeyPerson": true
  }
]

Only include investment team, not lawyers/accountants.
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' }
  });

  return JSON.parse(response.choices[0].message.content).teamMembers;
}
```

#### 3. Investment Focus Extraction

**Current (Phase 1):** Basic stage detection

**Phase 2:** Detailed thesis extraction
```javascript
async function extractInvestmentFocus(searchResults, websiteContent) {
  const prompt = `
Analyze this VC firm's investment focus:
${JSON.stringify(searchResults)}
${websiteContent.substring(0, 5000)}

Extract:
{
  "stage": "Seed to Series A",
  "sectors": ["B2B SaaS", "Fintech", "Healthcare"],
  "geography": "North America",
  "checkSize": "$500K-$2M",
  "sweetSpot": "$1M"
}
`;

  // GPT call similar to above
}
```

#### 4. Email Validation

```javascript
function validateEmail(email, websiteDomain) {
  // Check if email domain matches fund website
  const emailDomain = email.split('@')[1];
  const websiteDomainClean = websiteDomain.replace('www.', '');

  if (emailDomain === websiteDomainClean) {
    return { valid: true, confidence: 1.0 };
  }

  // Check for common patterns (law firms, etc.)
  const invalidPatterns = ['gmail.com', 'yahoo.com', '@law', '@legal'];
  if (invalidPatterns.some(p => email.includes(p))) {
    return { valid: false, reason: 'Personal/law firm email' };
  }

  return { valid: true, confidence: 0.7 };
}
```

#### 5. Improved Confidence Scoring

```javascript
function calculateConfidenceAI(data, aiClassification) {
  let score = 0;

  // Website found (30%)
  if (data.website && !data.website.includes('crunchbase')) score += 0.3;

  // AI classification confidence (30%)
  score += (aiClassification.confidence * 0.3);

  // Team found (20%)
  if (data.teamMembers && data.teamMembers.length > 0) {
    const hasGP = data.teamMembers.some(m => m.isKeyPerson);
    score += hasGP ? 0.2 : 0.1;
  }

  // Investment focus extracted (10%)
  if (data.investmentStage && data.sectors && data.sectors.length > 0) {
    score += 0.1;
  }

  // Multiple sources + cross-validation (10%)
  if (data.dataSources.length >= 3) score += 0.1;

  return Math.min(score, 1.0);
}
```

---

### Implementation Steps

1. **Add OpenAI Dependency**
```bash
npm install openai
```

2. **Configure API Key**
```bash
# .env
OPENAI_API_KEY=sk-...
```

3. **Create AI Module**
```javascript
// enrichment/ai_classifier.js
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

module.exports = {
  classifyFundTypeAI,
  extractTeamMembers,
  extractInvestmentFocus
};
```

4. **Update enrichment_engine.js**
```javascript
// Add AI functions as fallback/enhancement
if (process.env.OPENAI_API_KEY) {
  const aiClassification = await classifyFundTypeAI(name, searchResults);
  data.fundType = aiClassification.fundType;
  data.aiConfidence = aiClassification.confidence;
  data.aiReasoning = aiClassification.reasoning;
}
```

5. **Test on Small Batch**
```bash
# Test on 50 managers first
node enrichment/bulk_enrich.js --limit 50 --ai-enabled
```

6. **Compare Results**
```sql
-- Compare Phase 1 vs Phase 2 accuracy
SELECT
  enrichment_source,
  AVG(confidence_score) as avg_confidence,
  COUNT(CASE WHEN is_published THEN 1 END) as published_count,
  COUNT(CASE WHEN enrichment_status = 'needs_manual_review' THEN 1 END) as review_count
FROM enriched_managers
GROUP BY enrichment_source;
```

---

### Expected Improvements

| Metric | Phase 1 | Phase 2 | Improvement |
|--------|---------|---------|-------------|
| Auto-publish rate | ~30% | ~70% | +133% |
| Manual review needed | ~40% | ~15% | -62.5% |
| Team data captured | 0% | ~60% | +60% |
| Classification accuracy | ~70% | ~95% | +25% |
| Cost per manager | $0.00 | $0.0003 | Minimal |

---

## Phase 3: Continuous Operation

### Goal
Fully automate enrichment with monitoring and alerts.

### Timeline
After Phase 2 is stable (2-3 months)

### Cost
**~$10-20/month** (Brave Search + GPT + Notifications)

---

### Features to Add

#### 1. Automated Daily Cron Job

**Option A: Supabase pg_cron**
```sql
-- Run daily at 3 AM (after Form D ingestion at 2 AM)
SELECT cron.schedule(
  'daily-enrichment',
  '0 3 * * *',
  $$
  SELECT enrich_new_managers_daily();
  $$
);

CREATE OR REPLACE FUNCTION enrich_new_managers_daily()
RETURNS void AS $$
BEGIN
  -- Call Node.js enrichment script via HTTP
  PERFORM net.http_post(
    url := 'http://your-server/api/enrich-new-managers',
    headers := '{"Authorization": "Bearer YOUR_TOKEN"}'::jsonb
  );
END;
$$ LANGUAGE plpgsql;
```

**Option B: GitHub Actions**
```yaml
# .github/workflows/daily-enrichment.yml
name: Daily Fund Enrichment

on:
  schedule:
    - cron: '0 3 * * *'  # 3 AM daily
  workflow_dispatch:

jobs:
  enrich:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: node enrichment/bulk_enrich.js --new-only
        env:
          BRAVE_SEARCH_API_KEY: ${{ secrets.BRAVE_SEARCH_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
```

#### 2. Email Notifications

**When to notify:**
- New funds added to review queue
- Weekly digest of enrichment stats
- Errors/failures

**Implementation:**
```javascript
// enrichment/notifications.js
const Resend = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendReviewQueueNotification(reviewItems) {
  await resend.emails.send({
    from: 'enrichment@yourdomain.com',
    to: 'miles@yourdomain.com',
    subject: `${reviewItems.length} funds need manual review`,
    html: `
      <h2>Manual Review Queue</h2>
      <p>${reviewItems.length} funds flagged for review:</p>
      <ul>
        ${reviewItems.slice(0, 10).map(item => `
          <li><strong>${item.name}</strong> - ${item.reason}</li>
        `).join('')}
      </ul>
      <p><a href="https://yourdomain.com/review">Review Now</a></p>
    `
  });
}

async function sendWeeklyDigest(stats) {
  await resend.emails.send({
    from: 'enrichment@yourdomain.com',
    to: 'miles@yourdomain.com',
    subject: 'Weekly Enrichment Digest',
    html: `
      <h2>Enrichment Stats (Last 7 Days)</h2>
      <ul>
        <li>New managers added: ${stats.newManagers}</li>
        <li>Auto-enriched: ${stats.autoEnriched}</li>
        <li>Needs review: ${stats.needsReview}</li>
        <li>Manually verified: ${stats.manuallyVerified}</li>
      </ul>
    `
  });
}
```

#### 3. Monitoring Dashboard

Add to main app.js:

```javascript
// Analytics tab showing:
{
  totalManagers: 3500,
  enriched: 2800,
  published: 2100,
  needsReview: 450,
  inProgress: 250,

  trends: {
    last7Days: { enriched: 140, published: 98 },
    last30Days: { enriched: 520, published: 364 }
  },

  qualityMetrics: {
    avgConfidence: 0.82,
    autoPublishRate: 0.71,
    manualReviewRate: 0.16
  }
}
```

#### 4. Smart Prioritization

```javascript
// Prioritize enrichment based on:
function calculatePriority(manager) {
  let priority = 5; // Default

  // Larger offerings = higher priority
  if (manager.total_offering_amount > 50000000) priority += 2;
  if (manager.total_offering_amount > 100000000) priority += 3;

  // More funds = higher priority (established manager)
  if (manager.fund_count > 3) priority += 1;

  // Recent filings = higher priority
  const daysSinceFirst = daysBetween(manager.first_filing_date, new Date());
  if (daysSinceFirst < 30) priority += 2;
  if (daysSinceFirst < 7) priority += 3;

  return Math.min(priority, 10);
}
```

#### 5. Error Recovery

```javascript
// Retry logic for failed enrichments
async function enrichWithRetry(manager, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await enrichManager(manager.series_master_llc);
      return result;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);

      if (attempt < maxAttempts) {
        // Exponential backoff
        await sleep(1000 * Math.pow(2, attempt));
      } else {
        // Final failure - log and queue for manual review
        await logFailure(manager, error);
        return {
          enrichmentStatus: 'needs_manual_review',
          flaggedIssues: [`enrichment_error: ${error.message}`]
        };
      }
    }
  }
}
```

---

### Implementation Checklist

- [ ] Set up cron job (Supabase or GitHub Actions)
- [ ] Configure notification service (Resend/SendGrid)
- [ ] Add monitoring dashboard to UI
- [ ] Implement smart prioritization
- [ ] Add error recovery and retry logic
- [ ] Set up weekly digest emails
- [ ] Create admin dashboard for metrics
- [ ] Add alerting for failures/anomalies

---

### Maintenance

**Daily:**
- Check cron job ran successfully
- Review notification emails

**Weekly:**
- Review manual queue (5-10 funds)
- Check enrichment quality metrics
- Verify auto-published data is accurate

**Monthly:**
- Review API costs
- Analyze enrichment trends
- Adjust confidence thresholds if needed
- Update classification patterns

---

## Cost Summary

| Phase | Monthly Cost | One-Time Cost | Notes |
|-------|--------------|---------------|-------|
| **Phase 1** | $0 | $0-33 | Free (slow) or $33 to process all 3,238 |
| **Phase 2** | $1-10 | $0 | GPT-4-mini very cheap |
| **Phase 3** | $10-20 | $0 | + Notifications, monitoring |

**Total ongoing cost:** $10-20/month for fully automated system

---

## Success Metrics

**Phase 1 Baseline:**
- 30% auto-published
- 40% manual review needed
- 70% classification accuracy

**Phase 2 Target:**
- 70% auto-published
- 15% manual review needed
- 95% classification accuracy

**Phase 3 Target:**
- 100% new managers enriched within 24 hours
- <5% error rate
- <30 min/week manual oversight
