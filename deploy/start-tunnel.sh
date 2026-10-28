#!/usr/bin/env bash
# Start (or restart) the Cloudflare tunnel for agent.hrletsgo.me.
set -euo pipefail

ROOT=/home/hr-harnessor
LOG=$ROOT/logs/tunnel.log
CFG=$ROOT/deploy/cloudflared/config.yml

# Only kill a cloudflared started with THIS config — never the host's others.
pkill -f "cloudflared.*$CFG" 2>/dev/null || true
sleep 1

setsid cloudflared tunnel --no-autoupdate --config "$CFG" run \
  >>"$LOG" 2>&1 < /dev/null &

echo "tunnel started (pid $!), logging to $LOG"
