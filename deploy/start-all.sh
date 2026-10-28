#!/usr/bin/env bash
# Start the whole hr-harnessor deployment (backend + tunnel). Idempotent:
# each sub-script restarts its own process. Used by @reboot and for manual
# redeploys after a code change.
set -euo pipefail
ROOT=/home/hr-harnessor
bash "$ROOT/deploy/start-backend.sh"
sleep 3
bash "$ROOT/deploy/start-tunnel.sh"
echo "hr-harnessor: backend + tunnel up -> https://agent.hrletsgo.me"
