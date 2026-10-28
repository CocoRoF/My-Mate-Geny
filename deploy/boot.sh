#!/usr/bin/env bash
# @reboot entrypoint — ensure the Docker stack is up. docker's restart policy
# already restarts containers on daemon start; this is a belt-and-braces net.
/usr/bin/docker compose -f /home/hr-harnessor/deploy/docker-compose.yml up -d
