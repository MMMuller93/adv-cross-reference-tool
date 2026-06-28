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
#   bash enrichment/v3/run_retry_overnight.sh [BATCHES] [PER_BATCH]
#     BATCHES    number of retry batches to run   (default 8)
#     PER_BATCH  managers per batch               (default 200)
#   Defaults => 1600 managers/night (~9h at ~20s each). Re-run nightly until the
#   "due for retry now" count in the coverage report hits ~0.
#
# Requires .env with FORMD_SERVICE_KEY, ADV_SERVICE_KEY, BRAVE_SEARCH_API_KEY,
# OPENAI_API_KEY (the engine loads it automatically).

set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

BATCHES="${1:-8}"
PER_BATCH="${2:-200}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p .llm/backups logs
LOG="logs/retry-${TS}.log"
BACKUP=".llm/backups/enriched_managers-${TS}.json"

echo "=== coverage BEFORE ===" | tee "$LOG"
node enrichment/v3/coverage.js 2>&1 | tee -a "$LOG"

echo "=== pre-run backup ===" | tee -a "$LOG"
node enrichment/v3/backup_below_bar.js "$BACKUP" 2>&1 | tee -a "$LOG"

echo "=== retry pass: ${BATCHES} batches x ${PER_BATCH} (keeping Mac awake) ===" | tee -a "$LOG"
for i in $(seq 1 "$BATCHES"); do
  echo "--- batch ${i}/${BATCHES} ---" | tee -a "$LOG"
  # caffeinate -i prevents idle sleep for the duration of each batch.
  caffeinate -i node enrichment/v3/retry_runner.js --limit "$PER_BATCH" 2>&1 | tee -a "$LOG"
done

echo "=== coverage AFTER ===" | tee -a "$LOG"
node enrichment/v3/coverage.js 2>&1 | tee -a "$LOG"

echo "=== done. backup: ${BACKUP} | log: ${LOG} ===" | tee -a "$LOG"
