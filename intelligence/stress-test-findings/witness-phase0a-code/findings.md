# Phase 0a Witness Audit — backfill_live.py

**Verdict: NEEDS WORK**
**Date:** 2026-05-17
**Auditor:** Claude Sonnet 4.6 (independent witness)
**Tests run:** 15/15 pass

---

## Real Bugs Found

### BUG 1 — Unbounded Retry-After sleep (MEDIUM severity)

**Location:** `_fetch_with_retry()`, line ~162 of the modified file

**Code:**
```python
if retry_after_raw and retry_after_raw.isdigit():
    sleep_for = max(int(retry_after_raw), _RETRY_DELAYS[attempt])
```

**Problem:** No upper bound on `sleep_for`. If SEC EDGAR returns `Retry-After: 3600` (a legitimate response during DDoS mitigation or abuse detection), the script will sleep for one hour — per request, per retry. With 1,549 CIKs and 2 fetches each, this could freeze the job indefinitely.

**Fix:** Cap the sleep: `sleep_for = min(max(int(retry_after_raw), _RETRY_DELAYS[attempt]), 60)` or similar. Alternatively, treat any Retry-After > some threshold (e.g. 120s) as a hard abort rather than a sleep.

**Verification:** No test covers this path at all (noted as known gap in §7 of the brief).

---

### BUG 2 — Docstring/code mismatch on 503 (LOW severity / misleading)

**Location:** `_fetch_with_retry()` docstring, line ~145

**Docstring says:** `"Honors Retry-After header on 429 (uses max(Retry-After, scheduled_delay)). On 5xx (not 503), retries with scheduled delay only."`

**Code does:** `if response.status_code >= 500:` — this catches 503 and retries it like any other 5xx. The "(not 503)" claim is false.

**Behavioral impact:** Benign — retrying 503 is the correct behavior for SEC EDGAR. But the docstring actively misleads any future maintainer about what the function does. If someone adds 503-specific logic later based on the docstring, they'll add dead code or duplicate handling.

**Fix:** Change docstring to read "On 5xx (including 503), retries with scheduled delay only."

---

## Gaps That Are Not Bugs (But Are Risks)

### GAP 1 — 50/50 tie in `most_common()` is non-deterministic

**Location:** `update_registrant_adv_links()`, line ~484

`Counter.most_common(1)[0][0]` with a tie returns whichever CRD was inserted first into the Counter. Insertion order reflects the order of `link_rows` as returned from Supabase. Supabase does not guarantee row order without an explicit `ORDER BY` clause, and `existing_link_accessions` / `shape_link_rows` do not sort.

**Consequence:** For a genuinely tied multi-adviser registrant, re-running the script on the same CIK could pick a different CRD on different runs if Supabase returns rows in a different order. The confidence is correctly lowered to 75 in this case, so the downstream consumer knows it's ambiguous — but the value itself could change across runs.

**The brief acknowledges this** (§8.1: "ties produce a different bucket?"). The recommended fix is either:
- Tiebreak deterministically by lowest CRD number: `min(tied_crds)`
- Or assign confidence=50 with method=`ncen_tied` for manual review

No test exists for this scenario.

### GAP 2 — No tests for `_fetch_with_retry()`, `_flush_batch()`, or `main()` checkpointing

The 4 new tests cover only `update_registrant_adv_links()` in isolation. The following are entirely untested:

- `_fetch_with_retry()`: 429 retry, 5xx retry, ConnectionError, Timeout, large Retry-After
- `_flush_batch()`: upsert then adv_crd update orchestration
- `_maybe_checkpoint()`: the nonlocal rebinding, force=True behavior, checkpoint_every=0 disable

This is consistent with the brief's own §7 item 12 ("Tests for `_fetch_with_retry()` not yet added"). Absence is acknowledged; not a surprise.

### GAP 3 — Tests do not verify the WHERE clause on registrant updates

**Location:** `test_ncen_backfill_live.py`, `_make_mock_client()`

The mock captures the `.update(payload)` argument correctly but the `.in_('cik', cik_variants(...))` call is fully swallowed by MagicMock. A bug in `cik_variants()` that produced wrong CIK variants would not cause any of the 4 new tests to fail. The payload (what gets written) is verified; the target row (what gets matched) is not.

**Mitigation:** `cik_variants()` has its own unit test (`test_normalize_crd_strips_sec_zero_padding` exercises the normalization path). The gap is real but the risk is low given existing coverage.

---

## Things That Are Correct

1. **`_RETRY_DELAYS` index arithmetic**: `range(max_retries + 1)` = `range(5)` = attempts 0..4. At `attempt >= max_retries` (attempt=4), the code returns before accessing `_RETRY_DELAYS[4]`. No `IndexError` possible.

2. **Worst-case total wait**: 2+4+8+16 = 30 seconds per request. 4 retries is appropriate for SEC EDGAR's documented 10 req/s limit.

3. **`nonlocal` semantics**: The closure correctly declares `nonlocal summary_rows, link_rows, registrants_updated_total, flushes` and rebinds (not just mutates) the outer scope lists. Valid Python 3. Single-threaded — no race conditions.

4. **Double-flush prevention**: When `len(ciks)=N` and `checkpoint_every=N`, the checkpoint at `index=N` clears both lists. The subsequent `_maybe_checkpoint(N, force=True)` checks `(summary_rows or link_rows)` — both are empty — and returns early. No double-flush.

5. **`checkpoint_every=0` correctly disables**: `if not args.checkpoint_every: return` — 0 is falsy. Checkpointing is suppressed.

6. **Multi-adviser filtering**: `adviser_role == 'investment_adviser'` filter is applied before the Counter increment. Sub-adviser CRDs cannot inflate the count. Verified by `test_subadviser_links_ignored_for_registrant_resolution`.

7. **CIK deduplication**: `ciks = list(dict.fromkeys(ciks))` deduplicated before the fetch loop. A single CIK cannot appear in two different checkpoint batches.

8. **Checkpoint crash behavior**: A Supabase upsert error during `_flush_batch()` propagates to crash the script. This is identical in severity to the old code (which also had no try/except around upserts), but the new checkpointing makes it strictly better — data from completed checkpoints is committed and safe. Not a regression.

---

## Verdict

**NEEDS WORK** on one real bug: the unbounded Retry-After sleep (BUG 1) is a medium-severity production risk for a long-running script that hits SEC EDGAR 3,000+ times. All other issues are either documentation (BUG 2) or acknowledged gaps (GAPs 1-3).

Fix BUG 1 before running the full 1,549-CIK backfill. BUG 2 is a one-line docstring fix. GAPs can proceed as-is if the operator accepts the tie non-determinism and the missing `_fetch_with_retry` tests.
