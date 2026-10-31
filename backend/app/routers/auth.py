"""Login page + auth endpoints.

Native-app login contract (binding for the desktop/mobile "connect" screens;
full text in docs/auth.md):

* ``GET /health`` -> ``{"status": "ok", "service": "my-mate-geny", "version",
  "product": "My Mate Geny"}`` — public, ``Access-Control-Allow-Origin: *``.
* ``POST /api/auth/login`` ``{username, password, exchange?: true}`` ->
  ``{ok, token, username, default_password}`` + the session cookie; with
  ``exchange: true`` also ``{exchange_code, expires_in: 60}``. Any origin may
  call it (``*``, no credentials); failures count toward the IP ban.
* ``GET /auth/exchange?code=<code>&next=/`` -> sets the session cookie for this
  origin and 302s to ``next`` (same-origin path only, default ``/``). A bad,
  used or expired code -> 302 ``/login?error=expired``.
"""

from __future__ import annotations

import asyncio
import html

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from app.auth import (
    COOKIE_NAME,
    EXCHANGE_TTL_S,
    MAX_FIELD_LEN,
    AuthManager,
    password_problem,
    safe_next,
    username_problem,
)

router = APIRouter()

_BANNED_MSG = "Too many failed attempts — this IP is temporarily blocked."
_BAD_CREDS_MSG = "Wrong username or password."
_CHANGE_FAIL_DELAY_S = 1.0  # per wrong "current password" (plus the 5-per-15-min cap)


class LoginBody(BaseModel):
    username: str = Field(max_length=MAX_FIELD_LEN)
    password: str = Field(max_length=MAX_FIELD_LEN)
    # Native connect pages: also return a one-time code for GET /auth/exchange.
    exchange: bool = False


class CredentialsBody(BaseModel):
    current_password: str = Field(max_length=MAX_FIELD_LEN)
    username: str = Field(max_length=MAX_FIELD_LEN)
    # Empty -> keep the current password (username-only change).
    new_password: str = Field(default="", max_length=MAX_FIELD_LEN)


# The login page is rendered by the backend (works before the SPA loads and
# without it). It posts to /api/auth/login on the same origin; native apps use
# their own connect screen + the exchange flow described at the top.
_LOGIN_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0c10">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<title>My Mate Geny — Sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; --mint:#8ee6c0; --mint-2:#5fd4a4; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px;
    font-family:Inter,"Noto Sans KR",ui-sans-serif,system-ui,sans-serif; color:#e6e9f0;
    background:
      radial-gradient(1000px 520px at 50% -12%, rgba(95,212,164,.10) 0%, transparent 60%),
      radial-gradient(900px 500px at -10% 110%, #141a2e 0%, transparent 50%), #0a0c10; }
  .card { width:352px; max-width:100%; background:rgba(20,24,31,.78); border:1px solid #222a33; border-radius:18px;
    padding:30px 30px 26px; box-shadow:0 0 0 1px rgba(142,230,192,.05), 0 24px 70px -24px rgba(0,0,0,.8);
    backdrop-filter:blur(12px); }
  .brand { display:flex; flex-direction:column; align-items:center; text-align:center; margin-bottom:22px; }
  .logo { width:104px; height:104px; margin:-4px 0 10px; user-select:none;
    filter:drop-shadow(0 10px 26px rgba(95,212,164,.22)); }
  h1 { font-size:18px; font-weight:600; margin:0; letter-spacing:-.01em; }
  .sub { color:#5e6676; font-size:11.5px; margin-top:3px; }
  .grad { background:linear-gradient(135deg,var(--mint),#22d3ee); -webkit-background-clip:text; background-clip:text; color:transparent; }
  label { display:block; font-size:11px; color:#9aa3b4; text-transform:uppercase; letter-spacing:.06em; font-weight:500; }
  input { width:100%; margin:6px 0 14px; padding:11px 12px; background:rgba(13,16,21,.85); border:1px solid #232b35;
    border-radius:10px; color:#e6e9f0; font-size:14px; font-family:inherit; transition:.15s; }
  input:focus { outline:none; border-color:rgba(142,230,192,.55); box-shadow:0 0 0 3px rgba(142,230,192,.13); }
  button { width:100%; padding:11px; color:#06140f; border:0; border-radius:10px; font-weight:600; cursor:pointer;
    font-size:14px; font-family:inherit; background:linear-gradient(135deg,var(--mint),var(--mint-2));
    box-shadow:0 8px 22px -10px rgba(95,212,164,.7); transition:.15s; }
  button:hover:not(:disabled){ filter:brightness(1.06); }
  button:disabled { opacity:.5; cursor:default; }
  .err { color:#f87171; font-size:12px; min-height:16px; margin-top:10px; text-align:center; }
  .warn { display:flex; gap:8px; align-items:flex-start; margin:0 0 18px; padding:10px 12px; border-radius:10px;
    background:rgba(245,158,11,.12); border:1px solid rgba(245,158,11,.35); color:#fbbf24; font-size:12px; line-height:1.45; }
  .warn b { color:#fcd34d; }
</style></head>
<body>
  <form class="card" id="f">
    <div class="brand">
      <img class="logo" src="/logo.png" alt="Geny" width="104" height="104" draggable="false">
      <h1>My Mate <span class="grad">Geny</span></h1><div class="sub">your mate + agent console</div>
    </div>
    __WARNING__
    <label for="u">Username</label>
    <input id="u" autocomplete="username" autocapitalize="none" spellcheck="false" value="__USERNAME__" autofocus>
    <label for="p">Password</label>
    <input id="p" type="password" autocomplete="current-password">
    <button id="b" type="submit">Sign in</button>
    <div class="err" id="e">__ERROR__</div>
  </form>
<script>
  // Same-origin login: the cookie set by /api/auth/login is all the web UI needs.
  // Native apps use their own connect screen + POST /api/auth/login {exchange:true}
  // -> GET /auth/exchange (docs/auth.md).
  const f=document.getElementById('f'),e=document.getElementById('e'),b=document.getElementById('b');
  f.onsubmit=async(ev)=>{ev.preventDefault();e.textContent='';b.disabled=true;
    try{
      const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:document.getElementById('u').value.trim(),password:document.getElementById('p').value})});
      if(r.ok){location.href='/';return;}
      const d=await r.json().catch(()=>({detail:'Sign-in failed'}));
      e.textContent=d.detail||'Sign-in failed';
    }catch(x){e.textContent='Network error';}
    b.disabled=false;
  };
</script>
</body></html>"""

_DEFAULT_WARNING = (
    '<div class="warn" role="alert"><span>&#9888;</span><span><b>Default password</b> — change it in '
    "<b>Admin &rarr; Security</b> after signing in. Anyone who can reach this server can sign in until you do."
    "</span></div>"
)
_PAGE_ERRORS = {
    "expired": "That sign-in link expired or was already used. Please sign in again.",
}


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, error: str | None = None) -> HTMLResponse:
    auth: AuthManager = request.app.state.auth
    default = auth.using_default_password
    page = (
        _LOGIN_HTML.replace("__WARNING__", _DEFAULT_WARNING if default else "")
        # Prefill only the (public) default username, never a custom one.
        .replace("__USERNAME__", html.escape(auth.username) if default else "")
        .replace("__ERROR__", html.escape(_PAGE_ERRORS.get(error or "", "")))
    )
    return HTMLResponse(page, headers={"Cache-Control": "no-store"})


@router.post("/api/auth/login")
async def login(body: LoginBody, request: Request):
    auth: AuthManager = request.app.state.auth
    ip = AuthManager.client_ip(request)

    if auth.is_banned(ip):
        return JSONResponse({"detail": _BANNED_MSG}, status_code=403)

    await auth.tarpit()  # slows distributed guessing; never locks the owner out
    if not await auth.check_credentials_async(body.username, body.password):
        banned = auth.record_failure(ip)
        logs = request.app.state.logs
        ua = request.headers.get("user-agent")
        detail = {"user_agent": ua, "origin": request.headers.get("origin")}
        logs.record(
            "warning", "auth", f"failed login for user '{body.username[:64]}'",
            code="auth.login_failed", ip=ip, path=request.url.path, detail=detail,
        )
        if banned:
            logs.record(
                "error", "auth", f"IP {ip} blocked after repeated failed logins",
                code="auth.ip_banned", ip=ip, path=request.url.path, detail=detail,
            )
        return JSONResponse({"detail": _BANNED_MSG if banned else _BAD_CREDS_MSG},
                            status_code=403 if banned else 401)

    auth.clear_failures(ip)
    token = auth.issue_token(auth.username)
    # Token in the body is for native clients that can't hold the HttpOnly
    # cookie (Bearer header / ?token=); the web UI ignores it and uses the cookie.
    out: dict = {"ok": True, "token": token, "username": auth.username,
                 "default_password": auth.using_default_password}
    if body.exchange:
        out["exchange_code"] = auth.create_exchange_code(token)
        out["expires_in"] = EXCHANGE_TTL_S
    resp = JSONResponse(out, headers={"Cache-Control": "no-store"})
    resp.set_cookie(value=token, **auth.cookie_kwargs(request))
    return resp


@router.get("/auth/exchange")
async def exchange(request: Request, code: str | None = None, next: str | None = None):  # noqa: A002
    """One-time code (from a cross-origin login) -> first-party session cookie."""
    auth: AuthManager = request.app.state.auth
    token = auth.consume_exchange_code(code)
    if token is None:
        return RedirectResponse("/login?error=expired", status_code=302, headers={"Cache-Control": "no-store"})
    resp = RedirectResponse(safe_next(next), status_code=302, headers={"Cache-Control": "no-store"})
    resp.set_cookie(value=token, **auth.cookie_kwargs(request))
    return resp


@router.get("/api/auth/status")
async def status(request: Request) -> dict:
    """Who is signed in and where the credentials come from (behind the gate)."""
    auth: AuthManager = request.app.state.auth
    return auth.credentials_info()


@router.post("/api/auth/credentials")
async def change_credentials(body: CredentialsBody, request: Request):
    """Change username and/or password (current password required). Every
    other session and app is signed out; this browser gets a fresh cookie."""
    auth: AuthManager = request.app.state.auth
    ip = AuthManager.client_ip(request)
    logs = request.app.state.logs
    if auth.change_blocked():
        return JSONResponse({"detail": "Too many wrong passwords — try again in 15 minutes."}, status_code=429)
    if not await auth.check_credentials_async(auth.username, body.current_password):
        auth.note_change_failure()
        await asyncio.sleep(_CHANGE_FAIL_DELAY_S)
        logs.record("warning", "auth", "credential change refused: wrong current password",
                    code="auth.change_failed", ip=ip, path=request.url.path)
        # 400, not 401: a wrong form field must not bounce the UI to /login.
        return JSONResponse({"detail": "Current password is incorrect."}, status_code=400)

    username = body.username.strip()
    if problem := username_problem(username):
        return JSONResponse({"detail": problem}, status_code=400)
    password = body.new_password or body.current_password
    if body.new_password:
        problem = password_problem(body.new_password, username)
    elif auth.using_default_password:
        problem = "set a new password — the default one is public"
    else:
        problem = None
    if problem:
        return JSONResponse({"detail": problem}, status_code=400)

    old_username, old_source = auth.username, auth.source
    await asyncio.to_thread(auth.set_credentials, username, password)
    logs.record(
        "info", "auth", f"credentials changed (user '{old_username}' -> '{username}'); all other sessions signed out",
        code="auth.credentials_changed", ip=ip, path=request.url.path,
        detail={"old_username": old_username, "new_username": username, "previous_source": old_source,
                "password_changed": bool(body.new_password), "user_agent": request.headers.get("user-agent")},
    )
    token = auth.issue_token(auth.username)
    resp = JSONResponse({"ok": True, "token": token, **auth.credentials_info()})
    resp.set_cookie(value=token, **auth.cookie_kwargs(request))
    return resp


@router.post("/api/auth/revoke-all")
async def revoke_all(request: Request):
    """Sign out every device (all existing session tokens stop working),
    then sign this browser back in with a fresh token."""
    auth: AuthManager = request.app.state.auth
    auth.revoke_all()
    request.app.state.logs.record("info", "auth", "all sessions revoked", code="auth.revoked_all",
                                  ip=AuthManager.client_ip(request))
    resp = JSONResponse({"ok": True})
    resp.set_cookie(value=auth.issue_token(auth.username), **auth.cookie_kwargs(request))
    return resp


@router.post("/api/auth/logout")
async def logout(request: Request):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp
