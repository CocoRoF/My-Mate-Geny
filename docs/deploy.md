# Deployment — agent.hrletsgo.me

Live at **https://agent.hrletsgo.me** behind a Cloudflare tunnel, run as a
**Docker Compose** stack (daemon-managed = survives logout and reboots — the
only reliably-persistent mechanism on this host, matching the sibling apps).

```
browser ──TLS──> Cloudflare ──tunnel container(04f3f1fd)──> backend container :8080
                                                            ├─ /login, /api/auth/*  (public)
                                                            ├─ /health              (public)
                                                            └─ everything else      (session-gated)
```

Two containers (`deploy/docker-compose.yml`), both `restart: unless-stopped`:

- **backend** — FastAPI serving SPA + API + WS + auth. Runs as `hrjang`
  (uid 1000, NOT root — the Claude CLI refuses permissive modes as root), with
  `HOME=/home/hrjang` and `/home` bind-mounted, so `~/.claude`, `~/.claude.json`,
  `~/.codex`, `~/.ssh`, the vault/session keys, and the SQLite DB are the real
  host files — identical to a host run. App code is bind-mounted
  (`/app/app`) so edits apply on `docker compose restart backend` (no rebuild).
- **tunnel** — `cloudflare/cloudflared` running the dedicated `hr-harnessor`
  tunnel (`user: "1000:1000"` to read the 0400 creds), ingress → `http://backend:8080`.

```bash
cd /home/hr-harnessor/deploy
docker compose up -d                 # start / apply changes
docker compose restart backend       # after a backend code edit (code is mounted)
docker compose logs -f backend       # tail logs
# frontend change: (cd ../frontend && npm run build) then restart backend
```

Reboot: the Docker daemon restarts the containers; `@reboot deploy/boot.sh` is a
belt-and-braces `docker compose up -d`.

## Auth

- Login: **admin** / password from `backend/.env` (`AUTH_PASSWORD`, not committed).
- Successful login sets an HMAC-signed cookie (`hrh_session`), valid 7 days.
- **Sliding session**: every authenticated request re-issues the cookie, so an
  active browser that returns within 7 days stays logged in indefinitely; only
  7 days of inactivity logs it out.
- **IP ban**: 3 failed logins block that IP for 24h (persisted in SQLite
  `login_attempts`; survives restart). Client IP is read from `CF-Connecting-IP`.
- Tunables in `backend/.env`: `SESSION_TTL_DAYS`, `MAX_LOGIN_FAILS`, `BAN_HOURS`.

## Auth tokens (web + mobile)

Login returns the signed session token both as the `hrh_session` HttpOnly cookie
(web) and in the JSON body (`token`). Native clients (mobile) send it as
`Authorization: Bearer <token>` on REST and `?token=` on the chat WebSocket.
`CF-Connecting-IP` is used for the IP-ban logic.

## Secrets (never committed)

- `backend/.env` — `AUTH_PASSWORD`, etc. (gitignored)
- `~/.hr-harnessor/{vault.key,session.key}` — auto-generated, 0600
- `~/.cloudflared/04f3f1fd-*.json` and `deploy/cloudflared/04f3f1fd-*.json` — tunnel creds (gitignored)

## Notes

- The tunnel is the dedicated `hr-harnessor` tunnel
  (`<tunnel-id>`); DNS `agent.hrletsgo.me` CNAME → it.
  It does not touch the host's other tunnels.
- Changing `AUTH_PASSWORD` in `backend/.env` → `docker compose restart backend`.
- Deleting `~/.hr-harnessor/session.key` invalidates all live sessions.
- Stop everything: `cd deploy && docker compose down`.
- The older host-run scripts (`start-*.sh`) remain for a non-Docker host run,
  but Docker is the deployed path.
