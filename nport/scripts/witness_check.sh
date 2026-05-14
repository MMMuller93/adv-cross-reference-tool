#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== git =="
git status --short
git log --oneline -5

echo
echo "== python tests =="
./.venv/bin/python -m pytest nport -q

echo
echo "== node api tests =="
(cd nport/api && npm test)

echo
echo "== live preflight =="
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
PREFLIGHT_OUTPUT="$(./.venv/bin/python -m nport.scraper.preflight_live)"
echo "$PREFLIGHT_OUTPUT"

echo
if echo "$PREFLIGHT_OUTPUT" | grep -q "nport_company_positions_mv: 0"; then
  echo "Witness check complete. nport_company_positions_mv is empty; run:"
  echo "  REFRESH MATERIALIZED VIEW nport_company_positions_mv;"
else
  echo "Witness check complete. nport_company_positions_mv has rows."
fi
