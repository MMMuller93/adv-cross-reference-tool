# Private Funds Radar — Cockpit v4

> Read `.claude/MEMORY.md` for corrections, DB reference, and credentials.
> Archives in `.llm/archive/` — search there for historical context.
> This file is auto-read by both Codex CLI (every invocation) and Claude Code (session start). Keep tight.

---

## 0. Current State Snapshot (updated 2026-05-18)

**Enrichment v3 (the active stack):**
- Modular pipeline at `enrichment/v3/` — 15 modules, replaces the 2,113-LOC `enrichment_engine_v2.js` monolith
- Per-field evidence model: each field carries `{value, status: verified|candidate|rejected, anchors, evidence}` — no row-level confidence-score arithmetic
- Entry: `enrichment/v3/orchestrator.js#enrichManager(name, opts)`
- Identity resolution via `lib/adv_lookup.js#checkAdvDatabase` (canonical SEC-CRD matcher), wrapped by a stricter gate in `enrichment/v3/identity.js#passesStricterCrdGate` (added 2026-05-18 after TMS-Angels false-positive class identified)
- Anchor-gated publish in `server.js:1438` — fields suppressed unless `enrichment_status='auto_enriched'` AND a verifying anchor exists (website OR LinkedIn company URL verified)
- Auto-retry runner at `enrichment/v3/retry_runner.js` — replaces the dead "manual review" queue with scheduled re-enrichment (7/14/30/60/90d backoff)
- Feature flag: `ENRICHMENT_V3_ENABLED=true` enables v3; default OFF leaves v2 in place
- Tests: `tests/enrichment_v3/identity.test.js`, `gate.test.js`, `golden.test.js` — all pass

**Stricter SEC-CRD gate rules (`passesStricterCrdGate`):**
- shared distinctive tokens ≥ 2 → PASS
- shared = 1 AND token length ≥ 5 → PASS ("hash3", "plural", "locus" etc.)
- shared = 1 AND token length ≤ 4 (acronym):
  - has non-platform Form D related persons → DOWNGRADE (candidate, falls through to web search)
  - otherwise → REJECT (resolved=false, v3 falls through to web search)
- shared = 0 → REJECT

**Known FPs reverted manually in production (acronym-class):**
- TMS Angels Opportunity Fund → had wrongly matched CRD 153066 (TMS Capital Mgmt Ltd)
- DAS Holdings SPV Master LP → CRD 158852 (DAS-WFI INC, zero shared tokens)
- Blue Metric Group Fund / Blue Ice Venture Funds → CRD 330738 (BLUE LIMA LLC)
- Atom Heart Mother → CRD 300289 (ATOM CATALYST)

**Golden test fixtures at `.llm/REBUILD_GOLDEN_FIXTURES.json`:**
5 known-good control firms (4th & 1 Ventures, Afore Capital, Deploy Capital, Moonshots, Transform VC) + 5 known-bad cases (Hash3, Astro, Base Case, Moringa, Zecca).

**v3 cleanup pass results (2026-05-18):** ran on 382 production rows that had the unanchored-team-from-linkedin_search junk pattern → 45 verified, 173 partial, 101 candidates_only, 63 no_data, 0 errors. After audit + 5 FP reverts, 40/45 verified rows trustworthy. The Hash3-class junk pattern count went 397 → 13 rows.

**Codex (`gpt-5.5` with `xhigh` reasoning) is the standing co-programmer + reviewer.** Invoked proactively for:
- Adversarial plan/spec review before substantial implementation
- Root-cause analysis when my own hypothesis isn't verified
- Pre-merge code inspection
Don't ask permission each time — it's already authorized. Invocation: `codex exec --model gpt-5.5 --config model_reasoning_effort=xhigh -C "<project>" --output-last-message <tmp> "<prompt>"`. **Codex CLI has stalled on xhigh + large prompts (≥10KB)** — keep prompts focused and ≤8KB. Don't dump JSON arrays; reference file paths instead.

---

## 1. Complexity Assessment (Every Request)

Count triggers, then act:

| Triggers | Level | Action |
|----------|-------|--------|
| 0-1 | Light | Implement directly |
| 2 | Medium | Present plan, wait for approval |
| 3+ | Full | Dispatch pipeline with agents |

**Triggers:** (1) >30 min work, (2) 3+ phases, (3) >30K context, (4) strict quality gates, (5) 2+ independent sub-tasks, (6) schema/data mapping, (7) production deployment.

---

## 2. Dispatch Pipeline

Non-trivial work goes through specialist agents, not direct coding.

```
Light: Implement → Test → Commit
Medium/Full:
  [Triage] → [Spec] → [Planner] → [Coder] → [Reviewer] → [Tester] → [Witness]
```

**How:** Announce agent → adopt role from `.Codex/agents/[name].md` → execute → report → handoff.

### Agents

| Agent | When | Model |
|-------|------|-------|
| Spec | New features, significant fixes | sonnet |
| Planner | After spec approved | haiku |
| Coder | After plan approved | opus/sonnet |
| Reviewer | Before any commit | sonnet |
| Tester | After code written | sonnet |
| Witness | After all steps (**mandatory**) | sonnet |
| Researcher | Exploration needed | haiku |
| SEC Expert | Regulatory/compliance questions | sonnet |
| Data Architect | **Mandatory** before schema/query changes | sonnet |
| Scraper | IAPD HTML scraping | sonnet |

Full agent definitions loaded on dispatch from `.Codex/agents/*.md`.

### Mandatory Agent Invocations

| Situation | Required |
|-----------|----------|
| Schema/data changes | Data Architect |
| Multi-step implementation | Planner + Reviewer |
| Deployment | Witness |
| Compliance detection | SEC Expert + Data Architect |
| Marking work "done" | Witness |

---

## 3. Architecture

### Databases

| DB | Project ID | Tables |
|----|-----------|--------|
| **ADV** | `ezuqwwffjgfzymqxsctq` | `advisers_enriched` (40k), `funds_enriched` (185k) |
| **Form D** | `ltdalxkhbbhmkimmogyq` | `form_d_filings` (330k), `cross_reference_matches`, `compliance_issues` |

Pagination keys: `advisers_enriched` → `crd`, `funds_enriched` → `reference_id`, `form_d_filings` → `id`.
Limits: 1000 reads, 500 inserts. **Keyset pagination only** for large tables.

### Key Files

| File | Purpose |
|------|---------|
| `server.js` | API server |
| `public/app.js` | React frontend |
| `detect_compliance_issues.js` | 6 compliance detectors |
| `enrichment/enrichment_engine_v2.js` | Manager enrichment |

---

## 4. Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| `user-prompt-submit.py` | UserPromptSubmit | Sets complexity mode |
| `verify-dispatch.py` | PreToolUse (Write/Edit) | Blocks if dispatch needed |
| `update-state.py` | PostToolUse | Tracks progress |
| `verify-witness.py` | Stop | Auto-loop or witness check |

State: `.Codex/cockpit-state.json` | Override: `/bypass`

---

## 5. Auto-Loop

```
/auto "task" --max-iterations 20 --promise "DONE"
```

Wraps dispatch pipeline. Witness outputs `<promise>TEXT</promise>` when criteria genuinely met. `/cancel-auto` to stop. Full spec: `.Codex/commands/auto.md`.

---

## 6. Memory

| File | Purpose |
|------|---------|
| `.Codex/MEMORY.md` | Corrections, DB reference (read at start) |
| `.llm/shared_memory.md` | Project-wide rules (read at start) |
| `.llm/project_state.md` | Current state (read when resuming) |
| `features.json` | Feature tracking |
| `.llm/archive/*.md` | Historical sessions/learnings (search on demand) |
| `.llm/memories/[agent].md` | Per-agent memory |

Update corrections **immediately** — don't wait for session end.

---

## 7. DO NOT DO

### Data
1. No batchSize > 1000 reads, no inserts > 500
2. No OFFSET pagination for >50k rows
3. No assuming columns exist — verify first
4. No editing schema/mapping without investigation + approval
5. No explaining data patterns without a diagnostic query first

### Process
6. No skipping dispatch for non-trivial work
7. No marking done without Witness
8. No claiming "deployed" without checking live site
9. No speculating about unread code
10. No adding unrequested features
11. No false completion promises

### Pre-Answer Check
Before any data/diagnostic response: Am I presenting unverified info as fact? → investigate first. Haven't queried data? → say "I don't know yet, let me check."

---

## 8. Production

```bash
git push → wait for deploy → curl https://privatefundsradar.com/api/health → test feature live
```

GitHub Actions: `https://github.com/MMMuller93/adv-cross-reference-tool/actions`

---

## 9. Session End

- No half-implemented features
- Changes committed
- Memory files updated if corrections received
- project_state.md updated if work done
