# Authentication

My Mate Geny is a **single-user** server: one username + password protects the
web console, the desktop app and the mobile app. Code: `backend/app/auth.py`
(manager, gate, CORS) and `backend/app/routers/auth.py` (login page, endpoints).

## Credentials

Highest precedence first:

| Source | How it is set | Notes |
| --- | --- | --- |
| **Database** | Admin → Security → *Sign-in credentials* | Password stored only as a salted scrypt hash (`app_kv['auth_credentials']`). |
| **Environment** | `AUTH_USERNAME` (default `admin`) / `AUTH_PASSWORD` | Used while nothing is stored in the DB. |
| **Built-in default** | — | `admin` / `geny-admin`. |

While the **default password** is in use (no DB credentials and no
`AUTH_PASSWORD`, or `AUTH_PASSWORD=geny-admin`), the server logs a startup
warning, the login page shows a warning, and every view of the web app shows a
banner: *"Default password — change it in Admin → Security"*. Change it right
after the first sign-in.

Changing credentials in Admin requires the current password; the new password
needs at least 8 characters and may not be the default. Leaving *New password*
empty changes only the username (not allowed while the default password is in
use). On save every other browser and app is signed out, the current browser
gets a fresh cookie, and an `auth.credentials_changed` entry is written to the
admin log. Five wrong current passwords within 15 minutes lock the form for
15 minutes (this does not ban the IP).

**Forgot the password?** On the server run

```sh
cd backend && python -m app.auth reset-credentials   # same env/DB_PATH as the server
```

then restart the backend. That deletes the stored credentials, so the env
values (or the defaults) apply again.

## Sessions

* A successful login sets the `hrh_session` cookie (HttpOnly, SameSite=Lax,
  7 days, sliding: every authenticated request renews it). With
  `COOKIE_SECURE=auto` (the default) it is `Secure` exactly when the request
  arrived over https (directly, `X-Forwarded-Proto: https`, or Cloudflare's
  `CF-Visitor`), so the same setting works behind an HTTPS proxy and on a
  plain-http LAN server. `COOKIE_SECURE=true` forces the flag on every
  response.
* The same token is returned in the login response body. Native clients that
  cannot hold the cookie send it as `Authorization: Bearer <token>` (HTTP) or
  `?token=<token>` (WebSocket).
* Tokens are HMAC-signed with a key derived from `SESSION_SECRET` (or the key
  file `~/.hr-harnessor/session.key`), a generation counter, and the active
  credentials. So **Sign out everywhere** (Admin → Security) and any credential
  change invalidate every token. Upgrading from env-only credentials keeps
  existing sessions valid.

## Brute-force protection

* 3 failed logins from one IP (IPv6: one /64) ban it for 24 h
  (`MAX_LOGIN_FAILS`, `BAN_HOURS`). The ban is stored in SQLite and blocks every
  path, not only the login. Admin → Security lists and clears bans.
* More than 30 failures in 10 minutes from anywhere slow every login attempt by
  3 s (the owner is never locked out).
* Forwarding headers (`CF-Connecting-IP`, `X-Forwarded-For`) are believed only
  from a private/loopback peer (your own proxy or tunnel).

## Native-app login contract

This contract is binding for the desktop (Electron) and mobile (Capacitor)
*connect* screens: they ask for **server URL + username + password**.

### 1. Probe the server

```
GET /health
→ 200 {"status": "ok", "service": "my-mate-geny", "version": "0.1.0", "product": "My Mate Geny"}
```

Public, with `Access-Control-Allow-Origin: *` (no credentials), so a local
connect page can call it with `fetch`. Fields are only ever added. Old clients
only rely on `status`.

### 2. Log in

```
POST /api/auth/login
Content-Type: application/json
{"username": "admin", "password": "…", "exchange": true}

→ 200 {"ok": true, "token": "<session token>", "username": "admin",
       "default_password": false,
       "exchange_code": "<one-time code>", "expires_in": 60}
→ 401 {"detail": "Wrong username or password."}
→ 403 {"detail": "Too many failed attempts — this IP is temporarily blocked."}
```

* Without `exchange: true` the response has no `exchange_code` / `expires_in`.
* CORS: any origin, **without credentials**: `Access-Control-Allow-Origin: *`,
  preflight allows `POST, OPTIONS` and the `Content-Type` header (also
  `Access-Control-Allow-Private-Network: true` when Chromium asks for it). This
  covers Electron `file://` pages (Origin `null`), Capacitor
  (`https://localhost`, `capacitor://localhost`), and local probe pages. A
  cross-origin page cannot receive the cookie. It reads `token` /
  `exchange_code` from the body.
* Failed logins through this path count toward the IP ban like any other.
  401/403 responses also carry the CORS header, so the page can show the reason.
* `default_password: true` means the app should tell the user to change the
  password in Admin → Security.

### 3. Turn the code into a first-party session

Navigate the app's web view (top level, not `fetch`) to:

```
GET /auth/exchange?code=<exchange_code>&next=/
→ 302 Location: <next>      + Set-Cookie: hrh_session=… (HttpOnly; SameSite=Lax; Secure on https)
→ 302 Location: /login?error=expired   (unknown, used, or expired code)
```

* Codes are single-use and valid for **60 s**. They are kept in memory, so a
  backend restart drops them. They stop working early if the credentials change
  or someone uses "sign out everywhere".
* `next` must be a same-origin path (`/…`). Anything else (`//host`,
  `https://…`, backslashes, control characters) falls back to `/`.
* The cookie is set for the server's own origin, so the web UI loaded in the
  app's web view is signed in exactly like a browser.

Alternatively a native client may keep using the `token` directly
(`Authorization: Bearer` / `?token=`) without the exchange step.

### Other endpoints (same-origin web UI, behind the session)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/status` | `{username, source: "db"\|"env"\|"default", default_password, updated_at, min_password_length}` |
| `POST /api/auth/credentials` | `{current_password, username, new_password?}` → `{ok, token, …status}` + fresh cookie. Errors: 400 (wrong current password / weak password), 429 (throttled) |
| `POST /api/auth/revoke-all` | Sign out everywhere (this browser gets a fresh cookie). |
| `POST /api/auth/logout` | Clear this browser's cookie. |

Every other endpoint keeps the strict CORS policy (`CORS_ORIGINS`, with
credentials). Cookie-authenticated state-changing requests must also come from
the server's own origin (CSRF check).
