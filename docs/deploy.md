# Deployment

My Mate Geny is one container: the FastAPI backend serves the built web console,
the API, the WebSockets and the login page on a single origin (so the login
gate covers the UI too), and drives the `claude` / `codex` CLIs installed in
the same image.

```
browser / apps ──HTTPS──> reverse proxy or tunnel ──> geny container :8080
                                                      ├─ /login, /api/auth/*  (public)
                                                      ├─ /health              (public)
                                                      └─ everything else      (session-gated)
```

## 1. Quick start (one machine)

```bash
docker compose up -d           # root docker-compose.yml
```

Console on **http://localhost:8080**, first login **admin / geny-admin** —
change it in Admin right away (see [auth.md](auth.md)). This binds to
127.0.0.1 only and uses plain http (`COOKIE_SECURE=false`).

## 2. Production (`deploy/docker-compose.yml`)

```bash
cd deploy
cp .env.example .env              # GENY_UID/GID, GENY_WORKSPACES, GENY_HOME, tunnel token
cp ../backend/.env.example ../backend/.env   # optional app settings
docker compose up -d              # console on 127.0.0.1:${GENY_PORT:-8080}
```

Same image as the quick start, with `COOKIE_SECURE=true` (HTTPS in front is
required for the login cookie). Put one of these in front:

- **Caddy** (automatic certificates): [deploy/examples/Caddyfile](../deploy/examples/Caddyfile)
- **nginx**: [deploy/examples/nginx.conf](../deploy/examples/nginx.conf)
- **Cloudflare tunnel** (no open ports): in the Cloudflare dashboard create a
  tunnel, add a public hostname `geny.example.com` → `http://geny:8080`, put
  the token in `deploy/.env` as `CLOUDFLARE_TUNNEL_TOKEN`, then
  `docker compose --profile tunnel up -d`. A locally-managed tunnel (config
  file + credentials JSON) is also possible:
  [deploy/cloudflared/config.example.yml](../deploy/cloudflared/config.example.yml).

Whatever sits in front must pass the original `Host` header (same-origin
checks), forward WebSockets with long timeouts (agent turns stream for
minutes) and set `X-Forwarded-For` / `CF-Connecting-IP` (per-IP login bans).

Reboot: `restart: unless-stopped` brings the stack back with the Docker
daemon; `deploy/boot.sh` (`@reboot` in crontab) is a belt-and-braces
`docker compose up -d`.

Day-to-day:

```bash
docker compose up -d --build      # after pulling a new version
docker compose logs -f geny       # logs
docker compose down               # stop (state stays in the volumes)
```

Machine-specific tweaks (extra mounts, a host home directory, ...) go in a
`deploy/docker-compose.override.yml` (gitignored, merged automatically).

## 3. What to mount

| Container path | Default | What |
|---|---|---|
| `/home/geny` | `geny-home` volume (`GENY_HOME` to use a host dir) | All server state: `~/.hr-harnessor/` (SQLite DB, `vault.key`, `session.key`, pooled account logins under `accounts/`, mates, uploads, repos) and the container's own `~/.claude`, `~/.codex`. **Back this up**; losing `vault.key` loses every stored token/key. |
| `/workspaces` | `geny-workspaces` volume (`GENY_WORKSPACES` for a host dir) | Folders the agents work in; also where the mate looks for projects (`MATE_SEARCH_ROOTS`). |
| `/home/geny/.claude`, `/home/geny/.claude.json`, `/home/geny/.codex` | not mounted | Optional: reuse the host user's CLI logins and settings instead of signing in from **Providers**. Run `claude` / `codex login` on the host first (a missing file would be created as a directory). |
| `/home/geny/.ssh` (ro) | not mounted | Optional: SSH key for private git remotes / remote workspaces (remote hosts can also get their own key in **Connections**). |

The container runs as uid/gid `GENY_UID`/`GENY_GID` (default 1000), not root —
the Claude CLI refuses its permissive modes as root. Host directories you
mount must be writable by that uid; rebuild (`--build`) after changing it.

## 4. Without Docker

```bash
(cd backend && python3 -m venv .venv && .venv/bin/pip install -e .)
(cd frontend && npm ci && npm run build)
npm i -g @anthropic-ai/claude-code @openai/codex      # if not installed yet
deploy/start-backend.sh        # 127.0.0.1:8099 by default (GENY_BIND / GENY_PORT)
deploy/start-tunnel.sh         # optional, needs deploy/cloudflared/config.yml
```

This runs as your user, so the CLIs use your own `~/.claude` / `~/.codex`.
Server state goes to `~/.hr-harnessor/` and `DB_PATH` (default
`backend/data/harnessor.db`).

## 5. Configuration

All settings: [backend/.env.example](../backend/.env.example). The ones you
usually touch in production:

| Setting | Why |
|---|---|
| `COOKIE_SECURE` | `true` behind HTTPS (deploy compose default), `false` for plain http |
| `SESSION_TTL_DAYS`, `MAX_LOGIN_FAILS`, `BAN_HOURS` | session lifetime and login lockout |
| `VAULT_KEY` | fixed vault key instead of the generated `vault.key` file |
| `UPLOAD_MAX_MB`, `MATE_IMPORT_MAX_MB` | size limits (keep your proxy's body limit above them) |
| `APPS_REPO`, `APPS_RELEASE_TAG`, `GITHUB_TOKEN` | where the Download page finds app builds |
| `CORS_ORIGINS` | only for front-ends on another origin (the console itself is same-origin) |

## 6. Secrets (never commit)

- `backend/.env`, `.env`, `deploy/.env` — gitignored.
- `~/.hr-harnessor/{vault.key,session.key}` — generated on first start, 0600.
- Cloudflare tunnel token / credentials JSON (`deploy/cloudflared/*.json` and
  `config.yml` are gitignored).
- Android signing keystore and passwords (CI secrets only).

## 7. Sessions and sign-out

Login sets an HMAC-signed, sliding session cookie (native apps get the same
token as a bearer token). Admin → Security → "Sign out all devices" (or deleting
`~/.hr-harnessor/session.key`) invalidates every session. Details:
[auth.md](auth.md).
