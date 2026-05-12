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
./.venv/bin/python -m nport.scraper.preflight_live

echo
echo "Witness check complete. If nport_company_positions_mv is 0, run:"
echo "  REFRESH MATERIALIZED VIEW nport_company_positions_mv;"
