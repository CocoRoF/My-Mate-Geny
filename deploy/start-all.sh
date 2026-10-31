#!/usr/bin/env bash
# Non-Docker host run: start (or restart) the backend and, if a tunnel config
# exists, the Cloudflare tunnel. Idempotent; each sub-script restarts its own
# process. Docker (deploy/docker-compose.yml) is the recommended path.
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
bash "$HERE/start-backend.sh"
if [ -f "${GENY_TUNNEL_CONFIG:-$HERE/cloudflared/config.yml}" ]; then
  sleep 3
  bash "$HERE/start-tunnel.sh"
fi
echo "My Mate Geny: backend on http://${GENY_BIND:-127.0.0.1}:${GENY_PORT:-8099}"
