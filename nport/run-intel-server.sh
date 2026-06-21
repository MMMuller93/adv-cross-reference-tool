#!/bin/bash
# Launcher for the N-PORT intel / CRM server. Used by the launchd LaunchAgent
# (com.privatefundsradar.intel) so the CRM stays up at http://localhost:3011
# across logins, crashes, and laptop wake. Sources secrets from .env.nport.
set -euo pipefail
cd "$(dirname "$0")/.."          # -> worktree root (nport-buildout-claude)
set -a
# shellcheck disable=SC1091
source /Users/Miles_1/projects/PrivateFundsRadar/.env.nport
set +a
export PORT="${PORT:-3011}"
# Basic auth left as set in .env.nport (or unauth if unset — local only).
exec /usr/local/bin/node nport/api/server.js
