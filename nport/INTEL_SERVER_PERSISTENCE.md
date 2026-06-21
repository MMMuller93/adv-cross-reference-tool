# Keeping the intel / CRM server always-on

The CRM lives at **http://localhost:3011/intel/crm**, served by
`nport/api/server.js`. To stop it disappearing when the dev process exits or
the laptop reboots, it runs under a macOS **launchd LaunchAgent**.

## What's installed

- **Launcher** (versioned): `nport/run-intel-server.sh` — sources secrets from
  `.env.nport`, sets `PORT=3011`, execs `node nport/api/server.js`.
- **LaunchAgent** (user config, NOT in repo):
  `~/Library/LaunchAgents/com.privatefundsradar.intel.plist` — runs the
  launcher with `RunAtLoad` (start at login) + `KeepAlive` (restart on
  crash/exit). Logs to `~/Library/Logs/pfr-intel.{out,err}.log`.

Auth is whatever `.env.nport` sets (`INTEL_BASIC_USER` / `INTEL_BASIC_PASS`) —
the persistent server is Basic-auth protected (returns 401 until you log in).

## Manage it

```bash
# status (PID + last exit code)
launchctl list | grep privatefundsradar

# stop / start
launchctl unload ~/Library/LaunchAgents/com.privatefundsradar.intel.plist
launchctl load -w ~/Library/LaunchAgents/com.privatefundsradar.intel.plist

# logs
tail -f ~/Library/Logs/pfr-intel.err.log
```

The plist (recreate if needed):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.privatefundsradar.intel</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>/Users/Miles/projects/PrivateFundsRadar/.claude/worktrees/nport-buildout-claude/nport/run-intel-server.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/Miles_1/Library/Logs/pfr-intel.out.log</string>
  <key>StandardErrorPath</key><string>/Users/Miles_1/Library/Logs/pfr-intel.err.log</string>
</dict></plist>
```

## Caveats / next level

- **The launcher path points at this git worktree** (`.claude/worktrees/
  nport-buildout-claude`). If that worktree is removed, the agent breaks.
  For real robustness, merge this branch to a stable checkout and update the
  launcher path, or deploy to the cloud.
- **Cloud / public / multi-device:** the repo has a Railway config
  (`railway.json` + `Procfile`), but its `startCommand` targets the *root*
  ADV app (`node server.js`), not this intel server. To host the CRM you'd
  add a Railway service with `startCommand: node nport/api/server.js`, set the
  `SUPABASE_*` + `INTEL_BASIC_*` env vars there, and point it at this branch.
  Needs a Railway account — see `DEPLOYMENT.md`.
