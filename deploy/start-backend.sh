#!/usr/bin/env bash
# Non-Docker host run: start (or restart) the backend as the current user, so
# the claude / codex CLIs use this user's own logins (~/.claude, ~/.codex).
# The backend serves the built console (frontend/dist) + API + WS + login.
#
# Prerequisites (once):
#   (cd backend && python3 -m venv .venv && .venv/bin/pip install -e .)
#   (cd frontend && npm ci && npm run build)
#
# Env: GENY_ROOT (repo root; default: the checkout this script is in),
# GENY_BIND (default 127.0.0.1), GENY_PORT (default 8099), GENY_LOG_DIR
# (default $GENY_ROOT/logs). App settings come from backend/.env.
set -euo pipefail

ROOT="${GENY_ROOT:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}"
BIND="${GENY_BIND:-127.0.0.1}"
PORT="${GENY_PORT:-8099}"
LOG_DIR="${GENY_LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/backend.log"

# Only stop a backend started with the same bind/port.
pkill -f "uvicorn app.main:app --host $BIND --port $PORT" 2>/dev/null || true
sleep 1

cd "$ROOT/backend"
# shellcheck disable=SC1091
source .venv/bin/activate
export STATIC_DIR="${STATIC_DIR:-$ROOT/frontend/dist}"

# setsid => own session, fully detached; survives the launching shell exiting.
setsid uvicorn app.main:app --host "$BIND" --port "$PORT" \
  --proxy-headers --forwarded-allow-ips '*' \
  >>"$LOG" 2>&1 < /dev/null &

echo "backend started (pid $!) on $BIND:$PORT, logging to $LOG"
