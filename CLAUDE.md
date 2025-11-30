# ADV Cross-Reference Tool - Project Context

## Architecture

**Two Supabase databases:**
- **ADV** (`ezuqwwffjgfzymqxsctq.supabase.co`): SEC Form ADV data
  - `funds_enriched`: ~180k funds (NO `id` column - use `reference_id` for keyset pagination)
  - `advisers_enriched`: ~38k advisers (NO `id` column - use `crd` for keyset pagination)
- **Form D** (`ltdalxkhbbhmkimmogyq.supabase.co`): SEC Form D filings
  - `form_d_filings`: ~330k filings (HAS `id` column)
  - `cross_reference_matches`: Pre-computed ADV↔Form D matches

**Weekly job:** `scripts/compute_cross_reference.py` runs via GitHub Actions to refresh `cross_reference_matches`.

## Critical Learnings

### DO NOT use OFFSET pagination for large tables
```python
# BAD - times out at high offsets (Supabase statement_timeout)
.range(offset, offset + batch_size - 1)

# GOOD - O(1) regardless of position
.gt(id_column, last_id).order(id_column).limit(batch_size)
```

OFFSET pagination scans ALL previous rows before returning results. At offset 90,000+, this exceeds Supabase's statement_timeout and fails silently or with timeout errors.

### ADV tables don't have `id` columns
- `funds_enriched`: Use `reference_id` (integer)
- `advisers_enriched`: Use `crd` (integer)
- `form_d_filings`: Has `id` (default)

### Name matching uses exact normalized comparison
The `normalize_name_for_match()` function:
1. Uppercase
2. Remove punctuation (commas, periods, quotes, parens, hyphens, slashes)
3. Collapse whitespace
4. Strip entity suffixes (LLC, LP, L P, L L C, INC, LTD, CO, CORP, etc.)

Example: `"Tiger Fund, L.P."` → `"TIGER FUND"`

### Match count target
- ~50k ADV funds have `form_d_file_number` populated (claim to have filed Form D)
- Current exact name matching yields ~60k matches
- If match count drops significantly, check:
  1. Pagination failures (incomplete data fetch)
  2. Normalization bugs

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Form D columns show dashes | `cross_reference_matches` has bad/missing data | Re-run `compute_cross_reference.py` |
| Script times out at offset 90k+ | OFFSET pagination | Use keyset pagination |
| Match count much lower than expected | Incomplete fetch due to timeouts | Check for retry failures in logs |
| "column X.id does not exist" | Wrong id_column for keyset pagination | Use `reference_id` for funds, `crd` for advisers |

## Key Files

| File | Purpose |
|------|---------|
| `scripts/compute_cross_reference.py` | Weekly job to compute ADV↔Form D matches |
| `server.js` | Express API server (Railway deployment) |
| `.github/workflows/` | GitHub Actions for scheduled jobs |

## API Keys (anon, safe to commit)
```
ADV_URL=https://ezuqwwffjgfzymqxsctq.supabase.co
FORMD_URL=https://ltdalxkhbbhmkimmogyq.supabase.co
```
Keys are in environment variables or hardcoded as fallbacks in scripts.
