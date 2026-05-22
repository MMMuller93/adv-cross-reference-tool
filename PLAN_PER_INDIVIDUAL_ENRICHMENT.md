# PLAN v3: Per-Individual Enrichment (V1 — LinkedIn only)

Status: v3 after second Codex pushback. Codex said "Fix those and I'd
approve the narrowed V1." Awaiting user approval.
Last revised: 2026-05-22

## v3 changes from v2 (Codex's 5 blockers)

1. **Drop the Node-wrapper idea.** `searchTeamLinkedIn(fundName)` is not
   a (person, firm) lookup — it's a team-list pull. Keep the existing
   Python `find_linkedin_for_person()` in `enrich_people.py` (it works:
   17/20 hits on Franklin's 20-person test).
2. **Schema**: keep `UNIQUE (adviser_crd, normalized_name)`. Add
   `source_table`, `source_role`, `evidence_url`, `evidence_snippet` as
   metadata columns only (not part of the unique key). One row per
   person-firm; multiple roles tracked via array or pipe-string.
3. **No new file.** Extend existing `intelligence/enrich_people.py`
   with `--crd` flag. Don't create `enrich_people_v2.py`.
4. **Add team_members to the orchestrator.** Current
   `fetch_named_people_for_company()` pulls ADV fields only; it doesn't
   touch `enriched_managers.team_members`. Add that so V1 actually
   enriches the team-member rows the UI renders.
5. **V1 surfaces `confidence='high'` only.** Tighten
   `v_intel_person_enrichment` filter from `(high, medium)` to `(high)`.
   Re-classify cached rows: if evidence snippet doesn't contain a
   firm-name token, demote to `low` (won't surface).

## Why v2

Codex flagged the v1 plan as over-scoped and reaching past V1 safety
gates. Key revisions:

- **Per-person LinkedIn only in V1.** Email + Twitter defer to V2 — PFR
  itself documents these as weak/noisy ([CLAUDE.md L447](/Users/Miles/projects/PrivateFundsRadar/CLAUDE.md)),
  and shipping low-quality contacts is worse than no contact.
- **Reuse PFR's JS enrichment**, not a Python re-implementation. Wrap
  `enrichment_engine_v2.searchTeamLinkedIn` + `extractLinkedInFromWebsite`
  via a thin Node CLI.
- **Vertical slice first.** One adviser page (T. Rowe Price, which
  already has 5 owners + 5 team_members) end-to-end, then expand.
- **Defer broader UI** (unified Funds pane, expandable rows) until the
  vertical slice is visibly working.
- **Identity key**: (adviser_crd, normalized_name, source_role) with
  source_table + evidence_url + evidence_snippet stored alongside.
- **Validation is precision-first**: known-FP fixtures + per-source
  sampling + evidence snippets + concrete CLI/curl/Playwright commands.

---

## V1 Scope (DOABLE THIS SESSION)

> Per-person LinkedIn URL rendered as contact buttons on every owner /
> CCO / signatory / team member, on ONE adviser page first, then
> expanded once verified.

### Hard exclusions for V1 (defer to V2+):
- ❌ Per-person email (only firm-level + known regulatory_contact_email)
- ❌ Per-person Twitter
- ❌ Form D related-parties team enrichment (PFR docs say service-providers,
  not team)
- ❌ Unified N-PORT + Form D pane
- ❌ Expandable fund rows
- ❌ "Unbridged" → em-dash (separate one-liner; not in this plan)

---

## Identity model (V1)

`intel_person_enrichment` schema (existing migration 007 — verify columns):
```
id                BIGSERIAL PK
adviser_crd       TEXT NOT NULL         -- firm anchor
normalized_name   TEXT NOT NULL         -- 'David Oestreicher'
role_hint         TEXT                  -- 'owner'|'cco'|'signatory'|'team'
source_table      TEXT                  -- 'advisers_enriched'|'enriched_managers.team_members'|'form_d_filings.related_names'
source_role       TEXT                  -- raw source role label (e.g. 'CHIEF LEGAL OFFICER/DIRECTOR')
linkedin_url      TEXT
evidence_url      TEXT                  -- the search hit URL that matched
evidence_snippet  TEXT                  -- the search snippet that justified
confidence        TEXT                  -- 'high' | 'medium' | 'low'
source            TEXT                  -- 'brave' | 'google' | 'manual'
enriched_at       TIMESTAMPTZ
UNIQUE (adviser_crd, normalized_name)
```
Add `source_table`, `source_role`, `evidence_url`, `evidence_snippet` if not
present. **Schema diff check** is the first task — run a SELECT to verify
columns before any code change.

---

## Architecture (V1)

```
┌────────────────────────────────────────────────────────────────────┐
│  Python: intelligence/enrich_people_v2.py                          │
│  - Walks owners/CCO/signatory/team for one or more firms.          │
│  - For each (crd, name, role): spawn Node subprocess that calls   │
│    PFR's enrichment_engine_v2.searchTeamLinkedIn(name, firm)       │
│    OR a new helper search_linkedin_for_person(name, firm).         │
│  - Validates via existing enrichment_validator.py.                 │
│  - Writes to intel_person_enrichment with evidence_url/snippet.    │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (via subprocess + JSON)
┌────────────────────────────────────────────────────────────────────┐
│  Node: intelligence/enrich_engine_cli.js (NEW)                     │
│  Thin wrapper: takes (name, firm), returns JSON with the best       │
│  LinkedIn URL + evidence. Wraps PFR's exported searchTeamLinkedIn   │
│  + extractLinkedInFromWebsite. No reimplementation.                 │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  API: /api/intel/advisers/:crd                                     │
│  Each owner / CCO / signatory / team_member object gets:           │
│    linkedin_url    (from intel_person_enrichment)                  │
│    confidence                                                      │
│  Already returns structured team_members. Add per-person lookup    │
│  for owners_detail and cco_name/signatory_name fields.             │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  UI: PersonContactButtons component (NEW)                          │
│  Per-person row: [LinkedIn] button only in V1.                     │
│    - Green/active if linkedin_url present                          │
│    - Greyed out + X overlay otherwise                              │
│  Applied to: AdviserPage owners_detail list, AdviserDetailPanel    │
│  team list. NOT yet to FundPage (defer).                           │
└────────────────────────────────────────────────────────────────────┘
```

---

## V1 Sequencing (each step has a verify command)

### Step 0: Confirm artifacts
```bash
# Schema diff
psql ... -c "\d intel_person_enrichment"
# Expect: columns including evidence_url + source_table
```
- [ ] Schema columns exist or add migration
- [ ] enrichment_engine_v2.js exports `searchTeamLinkedIn` (line 2062)
- [ ] `validate_linkedin_company_url` + `_url_slug_matches_name` exist

### Step 1: Node CLI wrapper
Create `intelligence/enrich_engine_cli.js`:
```bash
NODE_PATH=... node intelligence/enrich_engine_cli.js --person "David Oestreicher" --firm "T. ROWE PRICE ASSOCIATES, INC."
# Output JSON: {linkedin_url, evidence_url, evidence_snippet, confidence}
```
- [ ] CLI handles missing firm → empty result, not crash
- [ ] CLI rate-limits (reuse PFR delays)

### Step 2: Python orchestrator
Modify `enrich_people_v2.py`:
- [ ] Pull (crd, name, role) tuples for ONE adviser CRD (T. Rowe Price = 105496)
- [ ] For each, call the CLI via subprocess
- [ ] Validate via enrichment_validator
- [ ] Write to intel_person_enrichment with evidence fields
- [ ] Verify: `SELECT count(*) FROM intel_person_enrichment WHERE adviser_crd='105496'`
      expected >= 5 (5 owners + maybe more)

### Step 3: API
- [ ] In `/api/intel/advisers/:crd`, after looking up owners_detail, join
      intel_person_enrichment by (crd, normalized_name) and add
      `linkedin_url` to each owner.
- [ ] Verify: `curl /api/intel/advisers/105496 | jq '.adviser.owners_detail[] | select(.linkedin_url != null) | .name'`
      expected: at least 2 names.

### Step 4: PersonContactButtons component
- [ ] One file: `nport/frontend/intel_page.js` (inline) or shared component
- [ ] Props: `{ linkedin_url, label }`
- [ ] Active state: real anchor with LinkedinIcon
- [ ] Disabled state: greyed span with X overlay (PFR pattern)

### Step 5: Apply to AdviserPage owners list
- [ ] Replace inline `in↗` with PersonContactButtons
- [ ] Verify in browser: T. Rowe Price page shows LinkedIn buttons next
      to David Oestreicher / Robert W. Sharps / others

### Step 6: Apply to AdviserDetailPanel team list
- [ ] Same component
- [ ] Verify: Anthropic intel page → click an adviser with team_members
      (Coatue, T. Rowe Price) → see LinkedIn buttons

### Step 7: Precision spot-check (validation gate)
Manually verify on the live UI:
- [ ] 5 random LinkedIn URLs across firms → click → verify the profile is
      actually that person at that firm
- [ ] 5 random "missing LinkedIn" → manually search LinkedIn for the
      person to confirm we didn't have a false negative

If <80% precision → STOP. Revisit validator before scaling.

### Step 8: Scale to all Anthropic advisers
- [ ] Re-run enrich_people_v2 for all 25 Anthropic adviser CRDs
- [ ] Coverage report by source bucket (owners / CCO / signatory / team):
      `SELECT role_hint, count(*) FROM intel_person_enrichment GROUP BY role_hint`
- [ ] Target: at least 50% of owners + 60% of team_members have
      linkedin_url. CCO/signatory likely lower (less LinkedIn presence).

### Step 9: Surface results to user
- [ ] Open `/intel/anthropic` + `/intel/adviser/105496`
- [ ] Screenshot. Walk through what's visible.
- [ ] User signs off OR points at gaps → fix.

---

## V2 Roadmap (NOT V1)

Tracked but explicitly out of scope this session:
- Per-person email discovery (website team-page scrape + name proximity)
- Per-person Twitter handle discovery
- Form D `related_names` enrichment (separate role gate first)
- Unified N-PORT + Form D pane with filter checkboxes
- Expandable fund rows
- "Unbridged" → em-dash (do this as a one-liner anyway)
- Service-provider role separation in Form D `related_names`

---

## Concrete validation commands (replaces "run validator after edits")

```bash
# Schema check (Step 0)
curl -s -H "apikey: ${SUPABASE_ANON_KEY_NPORT}" \
  "${SUPABASE_URL_NPORT}/rest/v1/intel_person_enrichment?limit=1&select=evidence_url,source_table" \
  | python3 -m json.tool

# Person enrichment dry-run (Step 2)
python intelligence/enrich_people_v2.py --crd 105496 --max-calls 30

# API JSON assertion (Step 3)
curl -s "http://localhost:3010/api/intel/advisers/105496" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); \
    owners_with_li = [o for o in d['adviser']['owners_detail'] if o.get('linkedin_url')]; \
    print(f'{len(owners_with_li)}/{len(d[\"adviser\"][\"owners_detail\"])} owners have LinkedIn'); \
    assert len(owners_with_li) >= 2, 'FAIL: need at least 2'"

# Browser verify (Step 5/6)
open http://localhost:3010/intel/adviser/105496

# Precision spot-check (Step 7) — manual, 5 LinkedIn clicks
```

---

## Known-FP fixtures (V1 — prevent regression)

Tests in `intelligence/test_person_enrichment_fixtures.py`:
- `Lindsey Oshita` at Franklin Advisers should NOT match
  `linkedin.com/in/amelialee` (caught earlier; regression test now)
- Any person at `Manhattan West Asset Management` should NOT match
  `linkedin.com/company/wix-com` (engine false positive)
- Generic words ('CAPITAL', 'MANAGEMENT') in firm_short shouldn't allow
  arbitrary LinkedIn URLs to pass

Run before merge:
```bash
python intelligence/test_person_enrichment_fixtures.py
# Expect: all green
```

---

## Overwatch (mechanical, not "be careful")

1. After Step 2: run the API JSON assertion. If <2 owners have LinkedIn, STOP.
2. After Step 3: open the API JSON in browser. Visually inspect one
   owner block. If linkedin_url is null on all owners, STOP.
3. After Step 5: take a screenshot. Compare to PFR's contact-button
   pattern. If buttons look different (color/size/icon), STOP.
4. After Step 8: precision spot-check (Step 7). If <80%, STOP and
   diagnose before any further commit.
5. Each `STOP` = surface to user immediately, get direction, then continue.

---

## Commit cadence

One commit per Step. Each commit message includes:
- What changed
- The verify command that passed
- Known limitations (e.g., "BlackRock still empty because Brave rate-limited the test run")

No batching. No skipping verify steps.

---

## Codex re-review gate

Before any code: send this v2 plan back to Codex (with correct cwd this
time: `/Users/Miles/projects/PrivateFundsRadar-fund-holders-intel`) and
wait for approval or further pushback.

After Step 3 (API change): send the API contract to Codex for review.

After Step 8 (full enrichment run): send the precision spot-check
results + a few raw rows to Codex for sanity-check.
