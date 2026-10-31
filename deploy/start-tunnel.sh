#!/usr/bin/env bash
# Non-Docker host run: start (or restart) a locally-managed Cloudflare tunnel.
# Copy deploy/cloudflared/config.example.yml to deploy/cloudflared/config.yml
# (gitignored) and fill in your tunnel id, credentials file and hostname, or
# point GENY_TUNNEL_CONFIG at a config elsewhere.
set -euo pipefail

HERE="$(dirname "$(readlink -f "$0")")"
ROOT="${GENY_ROOT:-$(cd "$HERE/.." && pwd)}"
CFG="${GENY_TUNNEL_CONFIG:-$HERE/cloudflared/config.yml}"
LOG_DIR="${GENY_LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/tunnel.log"

if [ ! -f "$CFG" ]; then
  echo "no tunnel config at $CFG (see deploy/cloudflared/config.example.yml)" >&2
  exit 1
fi

# Only kill a cloudflared started with THIS config — never the host's others.
pkill -f "cloudflared.*$CFG" 2>/dev/null || true
sleep 1

setsid cloudflared tunnel --no-autoupdate --config "$CFG" run \
  >>"$LOG" 2>&1 < /dev/null &

echo "tunnel started (pid $!), logging to $LOG"
