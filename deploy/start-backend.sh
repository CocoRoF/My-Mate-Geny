#!/usr/bin/env bash
# Start (or restart) the hr-harnessor backend on the host.
# The backend serves the SPA + API + WS + auth on 127.0.0.1:8099; the tunnel
# exposes it as https://agent.hrletsgo.me. Runs on the host (not Docker) so the
# claude CLI uses this user's existing subscription auth (~/.claude) directly.
set -euo pipefail

ROOT=/home/hr-harnessor
LOG=$ROOT/logs/backend.log

pkill -f "uvicorn app.main:app" 2>/dev/null || true
sleep 1

cd "$ROOT/backend"
# shellcheck disable=SC1091
source .venv/bin/activate

# setsid => own session, fully detached; survives the launching shell exiting.
setsid uvicorn app.main:app --host 127.0.0.1 --port 8099 \
  --proxy-headers --forwarded-allow-ips '*' \
  >>"$LOG" 2>&1 < /dev/null &

echo "backend started (pid $!), logging to $LOG"
