"""Login page + auth endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from app.auth import COOKIE_NAME, AuthManager

router = APIRouter()


class LoginBody(BaseModel):
    username: str
    password: str


_LOGIN_HTML = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0c10">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<title>My Mate Geny — 로그인</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:Inter,"Noto Sans KR",ui-sans-serif,system-ui,sans-serif; color:#e6e9f0;
    background:
      radial-gradient(1200px 600px at 80% -10%, #15213a 0%, transparent 55%),
      radial-gradient(900px 500px at -10% 110%, #1a1430 0%, transparent 50%), #0a0c10; }
  .card { width:340px; background:rgba(22,26,34,.72); border:1px solid #232936; border-radius:16px;
    padding:30px; box-shadow:0 20px 60px -20px rgba(0,0,0,.7); backdrop-filter:blur(12px); }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:22px; }
  .logo { width:38px; height:38px; border-radius:11px; display:grid; place-items:center;
    background:linear-gradient(135deg,#6e8bff,#22d3ee); box-shadow:0 0 0 1px #6e8bff40,0 8px 32px -8px #6e8bff80; }
  .logo svg { stroke:#fff; }
  h1 { font-size:16px; font-weight:600; margin:0; letter-spacing:-.01em; }
  .sub { color:#5e6676; font-size:11px; margin-top:1px; }
  .grad { background:linear-gradient(135deg,#8098ff,#22d3ee); -webkit-background-clip:text; background-clip:text; color:transparent; }
  label { font-size:11px; color:#9aa3b4; text-transform:uppercase; letter-spacing:.06em; font-weight:500; }
  input { width:100%; margin:6px 0 14px; padding:11px 12px; background:rgba(15,18,24,.8); border:1px solid #232936;
    border-radius:10px; color:#e6e9f0; font-size:14px; font-family:inherit; transition:.15s; }
  input:focus { outline:none; border-color:rgba(110,139,255,.6); box-shadow:0 0 0 3px rgba(110,139,255,.15); }
  button { width:100%; padding:11px; color:#fff; border:0; border-radius:10px; font-weight:600; cursor:pointer;
    font-size:14px; font-family:inherit; background:linear-gradient(135deg,#6e8bff,#5b7cff);
    box-shadow:0 6px 20px -8px #6e8bffaa; transition:.15s; }
  button:hover:not(:disabled){ background:linear-gradient(135deg,#8098ff,#6e8bff); }
  button:disabled { opacity:.5; cursor:default; }
  .err { color:#f87171; font-size:12px; min-height:16px; margin-top:10px; }
</style></head>
<body>
  <form class="card" id="f">
    <div class="brand">
      <div class="logo"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/></svg></div>
      <div><h1>My Mate <span class="grad">Geny</span></h1><div class="sub">your mate + agent console</div></div>
    </div>
    <label>ID</label>
    <input id="u" autocomplete="username" value="admin" autofocus>
    <label>Password</label>
    <input id="p" type="password" autocomplete="current-password">
    <button id="b" type="submit">로그인</button>
    <div class="err" id="e"></div>
  </form>
<script>
  const f=document.getElementById('f'),e=document.getElementById('e'),b=document.getElementById('b');
  f.onsubmit=async(ev)=>{ev.preventDefault();e.textContent='';b.disabled=true;
    try{
      const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});
      if(r.ok){location.href='/';return;}
      const d=await r.json().catch(()=>({detail:'로그인 실패'}));
      e.textContent=d.detail||'로그인 실패';
    }catch(x){e.textContent='네트워크 오류';}
    b.disabled=false;
  };
</script>
</body></html>"""


@router.get("/login", response_class=HTMLResponse)
async def login_page() -> HTMLResponse:
    return HTMLResponse(_LOGIN_HTML)


@router.post("/api/auth/login")
async def login(body: LoginBody, request: Request):
    auth: AuthManager = request.app.state.auth
    ip = AuthManager.client_ip(request)

    if auth.is_banned(ip):
        return JSONResponse({"detail": "접속 시도가 너무 많습니다. IP가 차단되었습니다."}, status_code=403)

    await auth.tarpit()  # slows distributed guessing; never locks the owner out
    if not auth.check_credentials(body.username, body.password):
        banned = auth.record_failure(ip)
        logs = request.app.state.logs
        ua = request.headers.get("user-agent")
        logs.record(
            "warning", "auth", f"failed login for user '{body.username[:64]}'",
            code="auth.login_failed", ip=ip, path=request.url.path, detail={"user_agent": ua},
        )
        if banned:
            logs.record(
                "error", "auth", f"IP {ip} blocked after repeated failed logins",
                code="auth.ip_banned", ip=ip, path=request.url.path, detail={"user_agent": ua},
            )
        msg = "접속 시도가 너무 많습니다. IP가 차단되었습니다." if banned else "아이디 또는 비밀번호가 올바르지 않습니다."
        return JSONResponse({"detail": msg}, status_code=403 if banned else 401)

    auth.clear_failures(ip)
    token = auth.issue_token(body.username)
    # Token in the body is for native clients (mobile) that can't hold the
    # HttpOnly cookie; the web UI ignores it and uses the cookie.
    resp = JSONResponse({"ok": True, "token": token})
    resp.set_cookie(value=token, **auth.cookie_kwargs())
    return resp


@router.post("/api/auth/revoke-all")
async def revoke_all(request: Request):
    """Sign out every device (all existing session tokens stop working),
    then sign this browser back in with a fresh token."""
    auth: AuthManager = request.app.state.auth
    auth.revoke_all()
    request.app.state.logs.record("info", "auth", "all sessions revoked", code="auth.revoked_all",
                                  ip=AuthManager.client_ip(request))
    from app.config import settings

    resp = JSONResponse({"ok": True})
    resp.set_cookie(value=auth.issue_token(settings.auth_username), **auth.cookie_kwargs())
    return resp


@router.post("/api/auth/logout")
async def logout(request: Request):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp
