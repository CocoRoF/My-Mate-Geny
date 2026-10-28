# Deployment — agent.hrletsgo.me

Live at **https://agent.hrletsgo.me** behind a Cloudflare tunnel. The backend
runs on the host (2223) so the `claude` CLI uses this user's existing
subscription auth (`~/.claude`) directly; it serves the SPA + API + WS + auth as
a single origin on `127.0.0.1:8099`.

```
browser ──TLS──> Cloudflare ──tunnel(04f3f1fd)──> localhost:8099 (uvicorn)
                                                   ├─ /login, /api/auth/*  (public)
                                                   ├─ /health              (public)
                                                   └─ everything else      (session-gated)
```

## Auth

- Login: **admin** / password from `backend/.env` (`AUTH_PASSWORD`, not committed).
- Successful login sets an HMAC-signed cookie (`hrh_session`), valid 7 days.
- **Sliding session**: every authenticated request re-issues the cookie, so an
  active browser that returns within 7 days stays logged in indefinitely; only
  7 days of inactivity logs it out.
- **IP ban**: 3 failed logins block that IP for 24h (persisted in SQLite
  `login_attempts`; survives restart). Client IP is read from `CF-Connecting-IP`.
- Tunables in `backend/.env`: `SESSION_TTL_DAYS`, `MAX_LOGIN_FAILS`, `BAN_HOURS`.

## Processes & persistence

Two detached processes (`setsid`, own session), restarted on boot via `@reboot` cron:

| What | Command | Log |
|---|---|---|
| backend | `deploy/start-backend.sh` → uvicorn :8099 | `logs/backend.log` |
| tunnel  | `deploy/start-tunnel.sh` → cloudflared (own config) | `logs/tunnel.log` |

```bash
# redeploy after a code change (rebuild SPA first if frontend changed)
cd /home/hr-harnessor/frontend && npm run build
/home/hr-harnessor/deploy/start-all.sh        # restarts backend + tunnel

# crontab (already installed)
@reboot sleep 15 && /home/hr-harnessor/deploy/start-all.sh >> /home/hr-harnessor/logs/boot.log 2>&1
```

The tunnel is a dedicated named tunnel `hr-harnessor`
(`<tunnel-id>`) with its own config at
`deploy/cloudflared/config.yml`; it does not touch the host's other tunnels.
DNS: `agent.hrletsgo.me` CNAME → that tunnel.

## Secrets (never committed)

- `backend/.env` — `AUTH_PASSWORD`, etc. (gitignored)
- `~/.hr-harnessor/{vault.key,session.key}` — auto-generated, 0600
- `~/.cloudflared/04f3f1fd-*.json` — tunnel credentials

## Notes

- Changing `AUTH_PASSWORD` takes effect on the next backend restart.
- Rotating `SESSION_SECRET`/deleting `session.key` invalidates all live sessions.
- To fully stop: `pkill -f 'uvicorn app.main:app'` and
  `pkill -f 'cloudflared.*hr-harnessor/deploy'`.
