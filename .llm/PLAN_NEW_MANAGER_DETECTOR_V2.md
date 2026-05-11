# Plan — `needs_initial_adv_filing` accuracy improvements

**Status:** Clean spec, post all corrections
**Format:** every item has CLAIM, EVIDENCE, ACTION, RISK
**Author:** Claude
**Date:** 2026-05-11

---

## What this is

A surgical pass on the existing `needs_initial_adv_filing` detector and the `New Managers` tab. No new tables, no new dependencies, no architectural changes. Each item below cites the specific evidence supporting it. Items without solid evidence are flagged as verification gates rather than direct actions.

**No "Phase B" is planned.** Everything actionable is in this single pass. Future ideas (bidirectional enrichment loops, audit-trail JSONB, active-learning feedback) are noted at the bottom under "Considered for later, not committed" — they're triggers ("if X plateaus, consider Y"), not committed work.

The core question this detector answers, restated correctly: **For each fund-management firm we can extract from recent Form D filings, does that firm have any Form ADV filing (RIA or ERA)?** The unit of analysis is the *firm*, not the fund.

---

## Verification gates (run before implementation)

Run these BEFORE touching code. Each is a known unknown surfaced during stress-testing.

### A0.1 — cross_reference_matches refresh cadence

**CLAIM:** The detector's anti-join base is fresh enough to use.

**EVIDENCE:** Unknown. Data Architect's 1000-row sample showed all rows with `computed_at = 2026-04-12`. Could mean (a) table refreshed once on that date and hasn't been updated since, (b) sample artifact, or (c) refresh is appending rather than rewriting `computed_at`.

**ACTION:** Query `SELECT date(computed_at), count(*) FROM cross_reference_matches GROUP BY date(computed_at) ORDER BY date DESC LIMIT 30`. If the freshest date is >14 days old, the matching base is stale and Phase A items #1–#5 are operating on incomplete data.

**RISK:** If stale, fix the refresh cron BEFORE any other Phase A work. Other items depend on the anti-join being current.

### A0.2 — registration_type distinct values on full table

**CLAIM:** registration_type has values beyond SEC-RIA, SEC-ERA, State-ERA, NULL.

**EVIDENCE:** Conflicting. Earlier POC: 43,610 populated rows split SEC-RIA 17,238 / SEC-ERA 4,995 / State-ERA 5,027 — totals 27,260, implying ~16k populated rows with other values. Data Architect's 1000-row sample showed only those three values + NULL, with State-RIA appearing too (sampled value).

**ACTION:** Query the full table for distinct values with counts: `?select=registration_type&adviser_name=not.is.null` aggregating in code; or direct SQL via service-role. Enumerate the long-tail.

**RISK:** The filter rule "skip State-ERA rows with blank adviser_name" is correct regardless. But weight-by-registration-type rules need to know the actual value set.

### A0.3 — adviser_owners data quality

**CLAIM:** `is_control_person = true` is a meaningful discriminator (not optimistically populated), and `title_or_status` reflects real role.

**EVIDENCE:** Data Architect's sample showed 82% of owner rows marked `is_control_person = true`, which is suspiciously high. POC5d showed one row with `title_or_status = 'CHIEF FINANCIAL OFFICER'` — confirms the column exists.

**ACTION:** Spot-check 10 random `adviser_owners` rows against the corresponding adviser's SEC IAPD Schedule A. For each, verify (a) is the person actually a control person, and (b) does the title match what IAPD shows. If <80% accurate, the cross-check in item A8 cannot be trusted as a deterministic key — must downgrade to "supporting signal only."

**RISK:** If the column is unreliable, item A8 still works as a name-overlap signal but should NOT short-circuit other strategies.

---

## A1 — Hard scope gate: industrygrouptype = 'Pooled Investment Fund'

**CLAIM:** Filtering Form D candidates to `industrygrouptype = 'Pooled Investment Fund'` drops operating-co Reg D raises, RE syndications, debt offerings, etc. without losing any genuine pooled funds.

**EVIDENCE:**
- POC1 (`poc1_out.txt`): `industrygrouptype IS NULL` = 0 rows in post-2025 non-amendment filings → column is essentially 100% populated.
- POC1: 45,511 filings have industrygrouptype = 'Pooled Investment Fund' OR ispooledinvestmentfundtype = true; only the categorical column is reliable.
- POC1: Top non-PIF industrygrouptype values in recent data: Other, Other Technology, Commercial, Other Real Estate, Residential, Biotechnology, Other Health Care, Oil and Gas, Other Banking, Manufacturing, Insurance, Business Services — all non-fund Reg D filings that should never be in the new-manager detector.
- Form D reference guide Section 5.4.1: "Item 4 — Industry Group: Classification (Agriculture, Banking, Technology, etc.)" with "Pooled Investment Fund" being the explicit value for investment-fund issuers.

**ACTION:**
In `server.js` `/api/new-managers` endpoint (line ~1163 area), add:
```js
.eq('industrygrouptype', 'Pooled Investment Fund')
```
Same filter in `detect_compliance_issues.js:detectNeedsInitialADVFiling()` candidate query.

**RISK:** Low. The column is well-populated and the value is canonical. No coverage loss risk.

---

## A2 — Preserve existing series-master regex extraction (NO CHANGE)

**CLAIM:** The `parseFundName()` regex `/,\s+a\s+series\s+of\s+(.+?)$/i` is the correct mechanism for extracting series-master names from platform-hosted funds. It should not be modified.

**EVIDENCE:**
- `.llm/archive/learnings.md` lists `parseFundName()` under "What Works" for enrichment.
- POC1: 11,473 / 45,511 (25%) of 2025+ pooled funds match this pattern; for those, the series-master is the only reliable identity signal extractable from `entityname` alone.
- For the remaining 75%, other extraction strategies are needed (see A3, A6); the regex isn't a candidate filter, it's a name extractor for the population that has this naming structure.

**ACTION:** Leave the regex as-is in `detect_compliance_issues.js:53-71` and `server.js:1184-1215`.

**RISK:** None — this item is "do not regress."

---

## A3 — Multi-strategy manager extraction beyond series-master regex

**CLAIM:** For pooled-fund Form D filings that don't have the "a series of" pattern (75% of recent filings per POC1), we extract firm identity from `related_names` + `related_roles` and from the entityname directly.

**EVIDENCE:**
- POC1: 34,035 pooled-fund filings in 2025+ have no "a series of" pattern. Names like "March Capital Partners Fund V, L.P.", "Acme Ventures III, LP" — firm name is the prefix before the fund-numbering convention.
- `docs/SEC_FORM_ADV_FORM_D_REFERENCE_GUIDE.md` Section 5.4.1 Item 3: Related Persons = "Executive officers, directors, promoters (20%+ owners)."
- `docs/ADV_VALIDATION_MAPPING.md` Future Enhancements section already calls for extracting from `related_names` with `related_roles` "Executive Officer" / "Promoter".
- `.claude/agents/sec-expert.md` FLAG 1 spec lists Manager Extraction Strategies 1-4 including series-of pattern, related_persons, and entity name parsing.

**ACTION:** Add to `detect_compliance_issues.js` (new helper functions in same file or extracted to `enrichment/utils.js`):
1. For "non-series" filings, parse the entityname prefix by stripping fund-number suffix patterns (`Fund I+`, `Fund \d+`, ` III, LP`, `, L.P.`) — yields a candidate firm name.
2. Iterate `related_names` + `related_roles` (both pipe-separated, same index): filter to entries whose role is one of: `Executive Officer`, `Director`, `Promoter`, `General Partner`, `Managing Member`, `Manager`. Each filtered name becomes a candidate firm-link target.
3. Use ALL candidates as input to A6 (ADV lookup) — first hit wins.

**RISK:** False positives if the entityname-prefix extraction is too greedy. Mitigation: require ≥2 distinct alphabetic tokens (not just the first word) before treating as a firm name.

---

## A4 — Platform detection routing

**CLAIM:** Platform-admin'd filings (Sydecar, AngelList admin-only, Assure, Allocations, Decile, etc.) need their `related_names` re-interpreted: platform-staff entries are NOT principals; non-platform entries are.

**EVIDENCE:**
- `lead_lists/PLATFORM_DETECTION_REFERENCE.md` enumerates 10+ platforms with their `entityname` and `related_names` patterns + known signer-name lists.
- Top signer names for platforms: Sydecar = Brett Sagan, Taylor Hughes, Theodore Stiefel, Tuan Tiet; AngelList = Abraham Wilson, Cathy Bui, Isaiah Deporto-Plick; Allocations = Hoang Phan, Kurt Nunez; Assure = Richard Thoms, Jeremy Neilson; Decile = Long Pham, Adeo Ressi; etc.
- POC4: confirmed Sydecar's 119 S Main 98104 address has 154 distinct entities filed against it; AngelList variants have similar concentration.

**ACTION:** In `detect_compliance_issues.js`, add a `detectPlatformFiling(filing)` function that returns the platform name (or null) by checking:
1. `entityname` matches platform patterns from PLATFORM_DETECTION_REFERENCE.md ("cgf2021", "roll up vehicles", "-al-", "equitybee", "cfund master", "republic master", etc.)
2. `related_names` contains platform staff names or platform entity patterns ("sydecar", "belltower", "assure fund", "decile", etc.)

When `detectPlatformFiling()` returns non-null, the manager-extraction logic should:
- Strip platform-staff names from `related_names` before person-level matching
- For platform-admin'd filings (NOT IA'd by platform — those are the ones in `cross_reference_matches`), look harder at non-platform-staff `related_names` entries for the real GP
- Don't treat the series-master (which IS the platform admin entity) as the firm name

**RISK:** Adding platforms incorrectly to the detector blocks real matches. Source of truth is PLATFORM_DETECTION_REFERENCE.md — don't add new platform signals without confirming there first.

---

## A5 — Use existing cross_reference_matches anti-join (NO CHANGE)

**CLAIM:** Form D filings whose `accessionnumber` is in `cross_reference_matches` are already linked to an ADV adviser via the existing matching pipeline, and should be skipped by the new-manager detector.

**EVIDENCE:**
- H11 verification (TRUE): `detect_compliance_issues.js:243-275` already builds `matchedAccessionSet` and continues past any filing in it.
- POC5a: cross_reference_matches has 63,160 rows, all with `adviser_entity_crd` populated.
- This includes funds where AngelList Advisors LLC (CRD 167700) is the actual IA — those are correct matches per Form ADV Section 7.B regulatory meaning ("for each private fund advised"), not false positives.

**ACTION:** Leave as-is. Do NOT add a "filter out AngelList matches" rule — those funds are genuinely IA'd by AngelList.

**RISK:** Depends entirely on A0.1 (refresh cadence). If cross_reference_matches is stale, this anti-join produces FPs on recently-matched filings.

---

## A6 — Multi-strategy ADV lookup with title-filtered owner cross-check

**CLAIM:** After extracting candidate firm name(s) and candidate principal name(s) from a Form D filing, resolve to ADV via four ordered strategies; first hit wins.

**EVIDENCE:**
- `docs/ADV_VALIDATION_MAPPING.md`: existing 2-strategy approach (base-name ilike + first-word ilike) achieves 73.5% recall on 200-row manual validation.
- `docs/SEC_FORM_ADV_FORM_D_REFERENCE_GUIDE.md` Section 7.1: ADV-Form D linking via "Related person matching: ADV Schedules A/B to Form D related persons."
- `signatory_titles_ranked.csv`: top signatory titles are CCO (8.95%), GC (1.13%), Authorized Signatory (0.57%), CFO (3.40%/3.05%) — these are predominantly outsourced service providers and CANNOT be used as principal-identity links.
- `signatory_names_ranked.csv`: Barry Breen signs for 19 firms as CCO, Michelle Riley for 14, David Jaques as Consulting CFO for 11. Person-level identity by signatory_name alone is high-FP.
- POC5d: `adviser_owners` has `is_control_person` boolean and `title_or_status` text. Title can be filtered to management-level only.

**ACTION:** Resolve order in `checkAdvDatabase()` (extracted to `enrichment/utils.js` for reuse):

1. **Exact normalized name match** (existing). `extractBaseName(formD_firm_name)` → ilike `%baseName%` on `adviser_name`. Apply A7 fix (strip "Master").

2. **First-word match (≥3 chars)** (existing). Keep at 3 — Data Architect surfaced 214 real advisers with 3-4 char first words (KIG, FSF, VTC, GRIT, FIAT).

3. **adviser_owners control-person cross-check WITH title filter** (NEW). For each Form D related person whose role is Executive Officer / Director / Promoter / General Partner / Managing Member / Manager:
   - Search `adviser_owners` where `owner_full_name` matches (≥2-token agreement: first AND last) AND `is_control_person = true` AND `title_or_status` matches management-titles (MANAGING MEMBER, MANAGING PARTNER, MANAGING DIRECTOR, PARTNER, CEO, PRESIDENT, FOUNDER, GENERAL PARTNER, PRINCIPAL).
   - **Exclude** owners whose title indicates outsourced/service role: CHIEF COMPLIANCE OFFICER, CCO, CHIEF FINANCIAL OFFICER, CFO, GENERAL COUNSEL, AUTHORIZED SIGNATORY, ATTORNEY IN FACT, CONSULTING anything, CONTROLLER, COMPLIANCE OFFICER.
   - If a match found, look up the corresponding `firm_crd` in advisers_enriched.

4. **regulatory_contact_name cross-check** (NEW, lower priority). Same matching rules as above against `advisers_enriched.regulatory_contact_name` — 40% coverage, pre-verified single point of contact. Lower FP risk than signatory_name because it's an explicit "this is the regulatory contact" field rather than "this person signed."

**Drop signatory_name as a positive matching signal.** It's noise — see evidence above.

**RISK:**
- Title-filter on adviser_owners depends on A0.3 verification. If `title_or_status` is sparsely populated or inconsistent, this strategy degrades from deterministic to supporting-signal.
- ≥2-token agreement requirement reduces recall on initial-only names ("J. Smith") and Asian-name romanization variants. Acceptable trade-off.

---

## A7 — extractBaseName: strip "Master"

**CLAIM:** Adding "Master" to the regex strip list in `extractBaseName()` fixes the Patricof Co. Master, LLC false-positive case.

**EVIDENCE:**
- `docs/ANALYSIS_COMPLIANCE_ENRICHMENT_FIXES.md` Issue #6 documents this exact gap: input "Patricof Co. Master, LLC" → output "Patricof Co. Master" (keeps Master) → ilike `%Patricof Co. Master%` doesn't match registered "PATRICOF CO. LLC".
- Fix already proposed in same doc, not yet shipped.

**ACTION:** In `detect_compliance_issues.js:93`:
```js
// Before:
base.replace(/\s+(GP|General Partner|Manager|Management|Advisors?|Advisers?)\s*,?\s*(LLC|LP|L\.?P\.?)?$/i, '');
// After:
base.replace(/\s+(GP|General Partner|Manager|Management|Advisors?|Advisers?|Master)\s*,?\s*(LLC|LP|L\.?P\.?)?$/i, '');
```

**RISK:** Some firms have "Master" as a legitimate part of their name (e.g., "Master Capital Partners"). The first-word fallback (strategy 2 in A6) would still catch those. Net risk minimal.

---

## A8 — Form D timing-lag suppression window

**CLAIM:** If the firm associated with a Form D filing has any Form ADV filing in the last 12 months, suppress the "needs initial ADV" flag on their new Form D filings for 60-90 days post-Form-D-filing.

**EVIDENCE:**
- `docs/SEC_FORM_ADV_FORM_D_REFERENCE_GUIDE.md` Section 4.5: "Annual Updating Amendment: Within 90 days of fiscal year end" + "Items NOT required to be updated between annual amendments: Items 2, 5, 6, 7, 9.A.(2), 9.B.(2), 9.E., 9.F., 12 — Section 1.F of Schedule D" → Item 7.B (Section 7.B fund list) IS in the annual-only list.
- `docs/SEC_FORM_ADV_FORM_D_REFERENCE_GUIDE.md` Section 4.5: Initial ERA Report: "Within 60 days of relying on exemption."
- `.claude/agents/sec-expert.md` lists "Recent Form D may not yet be in latest ADV (timing lag)" as a known FP risk in the FLAG 1 (Needs Initial ADV Filing) spec.

**ACTION:** In `detectNeedsInitialADVFiling()`, after firm extraction and ADV lookup, before flagging:
- If the firm WAS resolved to an ADV adviser (via any A6 strategy) → don't flag (already handled).
- If the firm was NOT resolved AND the firm's series-master / related_persons / address has had any other Form D filing in the last 12 months that DID match an adviser → suppress.
- The "60-day grace" already exists in the detector — keep that, but make explicit: it's a queue-priority signal, not a violation trigger. Re-label the metric in code comments and UI tooltip.

**RISK:** This requires looking up "other Form D filings by this firm" — which is a recursive identity problem. For MVP, simplify: only suppress if there's a definitive A6 match. The harder "implicit firm membership" case stays in the flag set.

---

## A9 — registration_type weighting on ADV pool

**CLAIM:** State-ERA rows with blank `adviser_name` cannot be matched by name and should be excluded from the name-matching ADV pool. SEC-RIA matches get full weight; SEC-ERA matches get full weight; State-ERA matches with non-blank adviser_name get full weight; State-ERA with blank get excluded.

**EVIDENCE:**
- `.llm/archive/sessions.md` Session 2026-01-17 (State ERA Data Refresh): "78.5% with websites; signatory/CIK columns added" — implies State ERA scrape coverage is incomplete.
- POC5c: registration_type populated 43,610/57,543 (75.8%); SEC-RIA 17,238, SEC-ERA 4,995, State-ERA 5,027 — the long tail (~16k) is the A0.2 verification gate.
- `.claude/agents/sec-expert.md`: explicitly notes State-registered adviser data sparsity, including the blank-name State-ERA cases.

**ACTION:** In each ilike query inside `checkAdvDatabase()`, add: `.not('adviser_name', 'is', null).not('adviser_name', 'eq', '')`. This is a safety filter regardless of registration_type values.

Optional: when match confidence is being computed, downweight matches where the matched adviser's `registration_type = 'State-ERA'` (sparse data → less confidence).

**RISK:** Adviser-name nullness is a property to filter on, regardless of A0.2 outcome. The filter is safe.

---

## A10 — Foreign and family-office candidate tagging

**CLAIM:** Form D filings from non-US issuers OR with family-office indicators are regulatorily exempt from Form ADV filing entirely (per §202(a)(30) and Rule 202(a)(11)(G)-1) and should be tagged for review rather than flagged as violations.

**EVIDENCE:**
- `docs/SEC_FORM_ADV_FORM_D_REFERENCE_GUIDE.md` Section 2.2: Foreign private adviser exemption.
- Reference: Rule 202(a)(11)(G)-1 family office exclusion.
- These are TWO of the few exemptions where the firm genuinely does NOT file Form ADV at all (unlike §203(l)/§203(m) which file as ERAs — see ERROR section below for why those are different).

**ACTION:** Add a soft-tag step after A6 fails to find a match:
- If `form_d_filings.stateorcountry` is non-US (or `stateorcountrydescription` indicates foreign jurisdiction) → tag the issue with `metadata.exemption_likely = 'foreign_private_adviser'`.
- If `related_names` is short (1-3 entries) AND all entries share a surname / appear to be family members → tag with `metadata.exemption_likely = 'family_office'` for human review.

**Do NOT hard-suppress.** Show in UI with the tag so user can review. The tag is a hint, not a decision.

**RISK:** Family-office detection from surname-overlap is heuristic and will miss many real cases. Foreign detection is more reliable (issuer state/country is a structured field). For MVP, only tag — don't filter.

---

## A11 — Enrichment fixes (in-place, no decoupling)

**CLAIM:** Four bugs in the existing enrichment pipeline are documented but unshipped; fix them in-place without changing the pipeline architecture.

**EVIDENCE:**
- `docs/ANALYSIS_COMPLIANCE_ENRICHMENT_FIXES.md` Enrichment Issue #1: "Not Checking advisers_enriched Before Enriching" — explicit P0, not shipped.
- `docs/ANALYSIS_COMPLIANCE_ENRICHMENT_FIXES.md` Enrichment Issue #2: "Not Finding Obvious Data" — Patricof Co. case, the manager has primary_website in ADV but enrichment doesn't reuse it.
- `enrichment/enrichment_engine_v2.js:56-58`: BLOCKED_DOMAINS includes pitchbook.com, crunchbase.com, bloomberg.com, tracxn.com but the article-URL bug indicates pass-3 fallback bypasses it.
- `features.json` enrich-001: "Some enriched managers have article URLs" still listed as not_started.

**ACTION:**

A11.1 — In `enrichment/enrich_recent.js` / `enrich_controlled.js`, add an ADV-database check before enriching. Reuse the same `checkAdvDatabase()` function from A6 (post-extraction to shared module). If the manager is found in advisers_enriched, skip enrichment AND populate the enriched_managers row from advisers_enriched (CRD, name, primary_website, phone_number, regulatory_contact_email).

A11.2 — In `enrichment/enrichment_engine_v2.js` website extraction (pass-3 fallback), enforce BLOCKED_DOMAINS as a hard filter on the return value. Currently the function may select a result whose domain matched a BLOCKED_DOMAINS entry if no other candidate was found. Required behavior: if no non-blocked candidate, return null (no website) rather than returning a blocked-domain URL.

A11.3 — In pass-3 fallback specifically: require the candidate domain to contain at least one distinctive token from the manager name (≥4 chars, not in {capital, ventures, partners, fund, management, advisors, group}). If no domain in search results matches that criterion, return null.

A11.4 — Add `og:type=article` check to `isNewsOrArticlePage()`. Fetch the candidate URL's HTML head; if it contains `<meta property="og:type" content="article">`, mark as news/article and skip.

A11.5 — Build `enrichment/enrich_compliance_violators.js` per the P1 spec in ANALYSIS doc. Triggers enrichment for managers in compliance_issues table with `discrepancy_type = 'needs_initial_adv_filing'` and no entry in enriched_managers yet.

**RISK:**
- A11.1 requires extracting `checkAdvDatabase()` to a shared module. Small refactor; low risk.
- A11.3's "distinctive token" rule could over-filter for firms with generic names. Spot-check 10 known-good managers (Patricof Co., Sequoia Capital, etc.) before deploying.
- A11.5 should respect API rate limits — Brave 2000/month, currently shared with new-managers enrichment. Add throttling.

---

## Items explicitly NOT in scope (considered and rejected)

Each of these was considered and rejected with reason. Recording so they don't resurface.

| Item | Why rejected |
|---|---|
| Multi-class risk taxonomy (`Behind_on_ERA`, `Likely_Exempt_VC`, etc.) | Over-engineered. Binary flag at firm level is regulatorily correct; exemption analysis is per-row metadata, not a separate output class. |
| §203(l) and §203(m) hard suppression | ERAs file Form ADV (Part 1A reduced items per reference guide §4.2). A firm qualifying for §203(l)/(m) but with no ADV is still a real signal — they should be filing as an ERA. |
| `signatory_name` as positive match signal | Signatories are dominated by outsourced CCO/CFO/GC/Authorized Signatory roles; signatory_names_ranked.csv shows top signatory Barry Breen signs for 19 unrelated firms. Single-name matches are FP-heavy. |
| Platform-CRD self-referential filter (AngelList 167700) | Listing on Section 7.B IS the regulatory definition of "I am the adviser for this fund" (reference guide §4.4). AngelList genuinely is the IA for its on-platform funds; those matches are correct, not false. |
| CIK backfill / fund-level CIK matching | CIK is per-series, not per-firm (`.llm/archive/learnings.md`: "CIK != Manager"); and POC2 showed `funds_enriched.cik` has 312 / 202k populated with zero overlap with sampled Form D ciks. Wrong granularity. |
| `linked_adviser_crd` filter | POC verified: 0 / 352,358 rows populated. Column exists but nothing writes it. |
| `file_num` "primary deterministic key" promotion | Already used as primary key in `cross_reference_matches` per `.llm/archive/learnings.md`. Not new. |
| Probabilistic ER / Splink for unresolved residuals | Over-engineered for a problem that's mostly deterministic with proper extraction strategies + person-graph cross-check. Defer indefinitely unless A6 strategies plateau. |
| Drop "a series of" regex from candidate selection | The regex is the firm-name extractor for the 25% of pooled funds with this naming pattern, listed in `.llm/archive/learnings.md` as "What Works." |
| Sponsor cluster table | Not necessary for MVP. Existing tables + in-query grouping (already in server.js:1184-1215) suffice. |
| Phase E enrichment decoupling | Original Codex-inspired idea was to enrich every pooled-fund issuer; would waste API spend on already-registered firms and doesn't address the actual product goal. Fix enrichment bugs in-place (A11) instead. |
| First-word match length 3 → 5 | Data Architect surfaced 214 real advisers with 3-4 char first words (KIG, FSF, VTC, GRIT, FIAT). Would silently lose Patricof-style fix. Keep at ≥3. |

---

## Acceptance criteria

After Phase A ships:

| Metric | Today | Target |
|---|---|---|
| Pooled-fund Form D recall (`industrygrouptype` gate working) | ~25% (via "a series of" gate) | ≥99% |
| FP rate on `needs_initial_adv_filing` flags (50-row hand-validated sample) | ~32% | ≤10% |
| Patricof Co. + KIG GP + HighVista + 4 other known historical FPs all stay un-flagged | Currently regression-untested | All 7 pass as regression tests |
| Article-URL appearances in `enriched_managers.website_url` (audit 100 recent rows) | ~30% (from feature description) | <5% |
| API cost on enrichment (Brave/Google search calls per 100 managers) | Baseline TBD | ≥25% reduction (from A11.1 ADV check skipping registered) |

---

## Process commitment

Every item above has a CLAIM, EVIDENCE, ACTION, RISK. If I add anything during implementation that doesn't fit this format, I stop and verify before writing code. The session has surfaced four cases where I introduced sophisticated-sounding logic on unverified premises (signatory matching, ERA suppression, AngelList filter, fund-level CIK); each was caught only by the user pushing back. Going forward, the format is the gate.

---

## What to do next

1. Run A0.1, A0.2, A0.3 verification queries
2. Confirm results with user before touching code
3. SEC Expert + Data Architect dispatch is already done; revisit if A0 surfaces new questions
4. Implement A1, A2, A5, A7, A9 first (lowest-risk, smallest-blast-radius)
5. Then A6 (the main matching improvement)
6. Then A3, A4 (the extraction-strategy additions)
7. Then A8, A10 (the suppression/tagging refinements)
8. Then A11 (enrichment fixes — separate from detector improvements)
9. Regression-test against Patricof Co., KIG GP, HighVista, Canyon Capital, Millstreet, Hohimer Wealth, Lighthouse Asset (all in ADV_VALIDATION_MAPPING.md as historical FPs)
