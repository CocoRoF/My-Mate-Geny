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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hr·harnessor — 로그인</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0f1115; color:#e5e7eb; font-family:ui-sans-serif,system-ui,-apple-system,sans-serif; }
  .card { width:320px; background:#171a21; border:1px solid #272b35; border-radius:12px; padding:28px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p { color:#9ca3af; font-size:12px; margin:0 0 20px; }
  label { font-size:12px; color:#9ca3af; }
  input { width:100%; margin:4px 0 14px; padding:10px; background:#0f1115; border:1px solid #272b35;
    border-radius:8px; color:#e5e7eb; font-size:14px; }
  input:focus { outline:none; border-color:#6aa8ff; }
  button { width:100%; padding:10px; background:#6aa8ff; color:#000; border:0; border-radius:8px;
    font-weight:600; cursor:pointer; font-size:14px; }
  button:disabled { opacity:.5; }
  .err { color:#f87171; font-size:12px; min-height:16px; margin-top:8px; }
</style></head>
<body>
  <form class="card" id="f">
    <h1>hr<span style="color:#6aa8ff">·</span>harnessor</h1>
    <p>관리자 로그인</p>
    <label>ID</label>
    <input id="u" autocomplete="username" autofocus>
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

    if not auth.check_credentials(body.username, body.password):
        banned = auth.record_failure(ip)
        msg = "접속 시도가 너무 많습니다. IP가 차단되었습니다." if banned else "아이디 또는 비밀번호가 올바르지 않습니다."
        return JSONResponse({"detail": msg}, status_code=403 if banned else 401)

    auth.clear_failures(ip)
    token = auth.issue_token(body.username)
    # Token in the body is for native clients (mobile) that can't hold the
    # HttpOnly cookie; the web UI ignores it and uses the cookie.
    resp = JSONResponse({"ok": True, "token": token})
    resp.set_cookie(value=token, **auth.cookie_kwargs())
    return resp


@router.post("/api/auth/logout")
async def logout(request: Request):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp
