#!/usr/bin/env -S python3 -P
"""A stand-in for Higgsfield (its Clerk OAuth endpoints, the account gateway, the skills archive) for
desktop/test/e2e/higgsfield-browser.js. Run the throwaway backend with

    HIGGSFIELD_AUTHORIZE_URL=http://127.0.0.1:<port>/oauth/authorize
    HIGGSFIELD_TOKEN_URL=http://127.0.0.1:<port>/oauth/token
    HIGGSFIELD_API_BASE=http://127.0.0.1:<port>/fnf/developer/v2alpha
    HIGGSFIELD_SKILLS_URL=http://127.0.0.1:<port>/skills.tar.gz

/oauth/authorize answers like the real sign-in does once the user is through: a redirect to
http://localhost:8765/callback?code=…&state=… (the address a user pastes back). The code is accepted once, with the
PKCE verifier matching that authorize request's challenge. Refresh tokens rotate. Never a real network call.

Avatar Create (desktop/test/e2e/avatar-create-browser.js): `/jobs/<job type>/cost` prices per job type (the
credits fake-higgsfield.py uses), `/account/billing/plans` (ULTRA: $99 / 3000 credits), and with a files folder
`/fake-files/<name>` serves the results fake-higgsfield.py writes there. `/e2e/quotes` lists the quotes asked for.

usage: higgsfield-stub.py <port> [files folder]
"""
import base64
import hashlib
import io
import json
import secrets
import sys
import tarfile
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

API = "/fnf/developer/v2alpha"
LOCK = threading.Lock()
CODES: dict[str, str] = {}  # code -> challenge
ACCESS: set[str] = set()
REFRESH: set[str] = set()
STATE = {"credits": 250.5, "n": 0}
FILES = sys.argv[2] if len(sys.argv) > 2 else None
COSTS = {"nano_banana_pro": 2.0, "image_background_remover": 0.5, "kling_o3_flf": 9.0, "video_background_remover": 1.0}
QUOTES: list = []


def issue() -> dict:
    with LOCK:
        STATE["n"] += 1
        n = STATE["n"]
    a, r = f"oat_e2e{n:03d}{secrets.token_hex(12)}", f"rt_e2e{n:03d}{secrets.token_hex(16)}"
    ACCESS.add(a)
    REFRESH.add(r)
    return {"access_token": a, "refresh_token": r, "expires_in": 86400, "token_type": "bearer",
            "scope": "email profile offline_access user:org:read"}


def skills_tar() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, text in {
            "skills-main/README.md": "Higgsfield skills (e2e stand-in)",
            "skills-main/higgsfield-generate/SKILL.md": "---\nname: higgsfield-generate\ndescription: e2e\n---\n# Generate\n",
        }.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class H(BaseHTTPRequestHandler):
    def _send(self, status: int, body, ctype="application/json", headers=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _authed(self) -> bool:
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and auth[7:] in ACCESS

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/oauth/authorize":
            code = "e2e-" + secrets.token_hex(8)
            CODES[code] = q.get("code_challenge", [""])[0]
            state = q.get("state", [""])[0]
            loc = f"http://localhost:8765/callback?code={code}&state={state}"
            return self._send(302, b"", "text/plain", {"Location": loc})
        if u.path == "/e2e/access":  # (the test compares the chat's token with the ones handed out)
            return self._send(200, sorted(ACCESS))
        if u.path == "/e2e/quotes":
            return self._send(200, QUOTES)
        if u.path.startswith("/fake-files/") and FILES:
            import os
            name = os.path.basename(u.path)
            p = os.path.join(FILES, name)
            if not os.path.isfile(p):
                return self._send(404, {"detail": "not found"})
            with open(p, "rb") as fh:
                data = fh.read()
            return self._send(200, data, "video/mp4" if name.endswith(".mp4") else "image/png")
        if u.path == "/skills.tar.gz":
            return self._send(200, skills_tar(), "application/gzip")
        if not u.path.startswith(API):
            return self._send(404, {"detail": "not found"})
        if not self._authed():
            return self._send(401, {"detail": "Not authenticated"})
        path = u.path[len(API):]
        if path == "/account/workspaces":
            return self._send(200, {"items": [{"id": "ws-e2e", "name": "E2E Studio", "type": "private", "is_selected": True},
                                              {"id": "ws-team", "name": "Team", "type": "team"}]})
        if path == "/account/balance":
            return self._send(200, {"credits": STATE["credits"], "email": "e2e@example.com",
                                    "subscription_plan_type": "ultra"})
        if path == "/account/transactions":
            now = datetime.now(timezone.utc).isoformat()
            return self._send(200, {"cursor": None, "items": [
                {"action": "spend", "created_at": now, "credits": -2.5, "display_name": "GPT Image 2.5"},
                {"action": "spend", "created_at": "2026-10-30T09:00:00Z", "credits": -1.5, "display_name": "Nano Banana 2"},
                {"action": "refund", "created_at": "2026-10-29T09:00:00Z", "credits": 1.5, "display_name": "Seedance 2.5"},
            ]})
        if path == "/account/billing/plans":
            return self._send(200, {"items": [{"type": "ultra", "final_price_cents": 9900, "credits": 3000},
                                              {"type": "credits_500", "price_cents": 2941, "credits": 500,
                                               "dollar_to_credits_ratio": 17}]})
        if path == "/job_types":
            return self._send(200, [{"job_type": "gpt_image_2_5", "display_name": "GPT Image 2.5", "type": "image"}])
        return self._send(404, {"detail": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode() if n else ""
        if u.path == "/oauth/token":
            form = {k: v[0] for k, v in parse_qs(raw).items()}
            if form.get("grant_type") == "authorization_code":
                challenge = CODES.pop(form.get("code", ""), None)
                verifier = form.get("code_verifier", "")
                ok = challenge and base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode() == challenge
                if not ok:
                    return self._send(400, {"error": "invalid_grant", "error_description": "bad code or verifier"})
                return self._send(200, issue())
            if form.get("grant_type") == "refresh_token":
                with LOCK:
                    ok = form.get("refresh_token") in REFRESH
                    REFRESH.discard(form.get("refresh_token"))
                return self._send(200, issue()) if ok else self._send(400, {"error": "invalid_grant"})
            return self._send(400, {"error": "unsupported_grant_type"})
        if u.path.startswith(API) and u.path.endswith("/cost"):
            if not self._authed():
                return self._send(401, {"detail": "no"})
            jt = u.path[len(API) + len("/jobs/"):-len("/cost")]
            QUOTES.append({"job_type": jt, "params": (json.loads(raw or "{}") or {}).get("params")})
            return self._send(200, {"credits": COSTS.get(jt, 2.5)})
        return self._send(404, {"detail": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
