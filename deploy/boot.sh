#!/usr/bin/env bash
# @reboot entrypoint (crontab: `@reboot /path/to/repo/deploy/boot.sh`) — make
# sure the Docker stack is up. Docker's restart policy already restarts the
# containers when the daemon starts; this is a belt-and-braces net.
# GENY_COMPOSE_FILE picks another compose file (default: docker-compose.yml
# next to this script); extra arguments (e.g. `--profile tunnel`) pass through.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
exec docker compose -f "${GENY_COMPOSE_FILE:-docker-compose.yml}" "$@" up -d
