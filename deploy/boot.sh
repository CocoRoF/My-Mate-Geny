#!/usr/bin/env bash
# @reboot entrypoint (crontab: `@reboot /path/to/repo/deploy/boot.sh`) — make
# sure the Docker stack is up. Docker's restart policy already restarts the
# containers when the daemon starts; this is a belt-and-braces net.
# Extra compose arguments (e.g. `--profile tunnel`) are passed through.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
exec docker compose -f docker-compose.yml "$@" up -d
