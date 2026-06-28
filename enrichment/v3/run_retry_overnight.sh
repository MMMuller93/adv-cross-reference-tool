#!/usr/bin/env bash
#
# run_retry_overnight.sh — Accelerated overnight v3 enrichment retry pass.
#
# Works through the "due for retry" backlog faster than the nightly 200/run cron
# by running several batches back-to-back, keeping the Mac awake (caffeinate),
# and logging everything. Safe by design:
#   - v3 writes are PROMOTE-ONLY (never null out verified data)
#   - v3 is ANCHOR-GATED (never publishes an unverified field)
#   => a retry pass can only ADD or improve data. A full pre-run backup of the
#      below-bar rows is taken anyway (per ETL hygiene).
#
# Usage:
#   bash enrichment/v3/run_retry_overnight.sh [BATCHES] [PER_BATCH] [CONCURRENCY]
#     BATCHES      number of retry batches          (default 4)
#     PER_BATCH    managers per batch (Supabase cap) (default 1000)
#     CONCURRENCY  parallel workers per batch        (default 10)
#   Defaults => up to 4000 managers at ~14/min (~5h for the full ~3.2k backlog).
#   Work is I/O-bound, so concurrency 10 is ~5x faster than sequential with no
#   measured API rate-limiting. Re-run until "due for retry now" hits ~0.
#
# Requires .env with FORMD_SERVICE_KEY, ADV_SERVICE_KEY, BRAVE_SEARCH_API_KEY,
# OPENAI_API_KEY (the engine loads it automatically).

set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

BATCHES="${1:-4}"
PER_BATCH="${2:-1000}"
CONCURRENCY="${3:-10}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p .llm/backups logs
LOG="logs/retry-${TS}.log"
BACKUP=".llm/backups/enriched_managers-${TS}.json"

echo "=== coverage BEFORE ===" | tee "$LOG"
node enrichment/v3/coverage.js 2>&1 | tee -a "$LOG"

echo "=== pre-run backup ===" | tee -a "$LOG"
node enrichment/v3/backup_below_bar.js "$BACKUP" 2>&1 | tee -a "$LOG"

echo "=== retry pass: ${BATCHES} batches x ${PER_BATCH} @ concurrency ${CONCURRENCY} (keeping Mac awake) ===" | tee -a "$LOG"
for i in $(seq 1 "$BATCHES"); do
  echo "--- batch ${i}/${BATCHES} ---" | tee -a "$LOG"
  # caffeinate -i prevents idle sleep for the duration of each batch.
  caffeinate -i node enrichment/v3/retry_runner.js --limit "$PER_BATCH" --concurrency "$CONCURRENCY" --delay 0 2>&1 | tee -a "$LOG"
done

echo "=== coverage AFTER ===" | tee -a "$LOG"
node enrichment/v3/coverage.js 2>&1 | tee -a "$LOG"

echo "=== done. backup: ${BACKUP} | log: ${LOG} ===" | tee -a "$LOG"
