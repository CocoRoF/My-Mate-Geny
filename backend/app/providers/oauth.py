"""Web-driven OAuth for the provider CLIs.

Both provider CLIs support a headless, web-surfaceable login that this manager
drives and exposes over HTTP so the whole flow happens in the browser:

* **Codex** — ``codex login --device-auth`` prints a verification URL
  (``auth.openai.com/codex/device``) + a one-time ``XXXX-XXXX`` code, then polls
  OpenAI until the user authorizes and writes ``~/.codex/auth.json``. The web UI
  shows the URL+code and polls :meth:`codex_status`.
* **Claude** — ``claude setup-token`` prints an auth URL whose redirect lands on
  ``platform.claude.com`` (not localhost), then waits on a TTY for the user to
  paste the resulting code. The web UI shows the URL, the user authorizes and
  pastes the code back, which :meth:`complete_claude` writes to the CLI's pty.

State lives in-memory (single uvicorn process, single user).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import select
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

# Claude Code's public OAuth client (same across installs). We implement the
# PKCE exchange directly rather than driving the CLI pty — robust + web-native.
_CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
_CLAUDE_AUTHORIZE = "https://claude.com/cai/oauth/authorize"
_CLAUDE_TOKEN = "https://platform.claude.com/v1/oauth/token"
_CLAUDE_REDIRECT = "https://platform.claude.com/oauth/code/callback"
_CLAUDE_SCOPES = "org:create_api_key user:profile user:inference"

_ANSI = re.compile(
    rb"\x1b\[[0-9;?]*[a-zA-Z]"  # CSI
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC ... BEL/ST
    rb"|\x1b[>=@-Z\\-_]"  # misc 2-byte
)
_CODE_RE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b")
# Long-lived token printed by `claude setup-token` (sk-ant-oat01-...).
_TOKEN_RE = re.compile(rb"sk-ant-oat[0-9A-Za-z._-]{20,}")
_CODEX_URL = "https://auth.openai.com/codex/device"
# Claude prints its URL inside an OSC-8 hyperlink: ESC]8;id=..;<URL>ESC\
_CLAUDE_OSC = re.compile(rb"\x1b\]8;[^;]*;(https://claude\.com/[^\x1b\x07]+)")
_CLAUDE_PLAIN = re.compile(rb"https://claude\.com/cai/oauth/authorize\?[^\s\"'\x1b\x07]+")


def _strip(b: bytes) -> str:
    return _ANSI.sub(b"", b).decode(errors="replace")


@dataclass
class LoginSession:
    provider: str
    proc: subprocess.Popen | None = None
    master_fd: int | None = None
    url: str = ""
    user_code: str = ""
    token: str = ""
    verifier: str = ""
    state: str = ""
    output: str = ""
    done: bool = False
    ok: bool = False
    error: str = ""
    started_at: float = field(default_factory=time.time)
    auth_file: str = ""  # where a successful login writes credentials
    lock: threading.Lock = field(default_factory=threading.Lock)


def _fresh(path: str, since: float) -> bool:
    try:
        return os.path.getmtime(path) >= since - 1
    except OSError:
        return False


class OAuthManager:
    def __init__(self) -> None:
        self._sessions: dict[str, LoginSession] = {}
        self._home = os.environ.get("HOME", os.path.expanduser("~"))

    def _env(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        env = dict(os.environ)
        env["HOME"] = self._home
        env.setdefault("TERM", "xterm-256color")
        if extra:
            env.update(extra)
        return env

    def _kill(self, provider: str) -> None:
        old = self._sessions.pop(provider, None)
        if old and old.proc and old.proc.poll() is None:
            try:
                old.proc.kill()
            except Exception:
                pass
        if old and old.master_fd is not None:
            try:
                os.close(old.master_fd)
            except Exception:
                pass

    # ---- status helpers ----

    def claude_logged_in(self) -> bool:
        home = self._home
        return any(
            os.path.exists(os.path.join(home, ".claude", f))
            for f in (".credentials.json", "credentials.json", "auth.json")
        )

    def codex_logged_in(self) -> bool:
        if os.path.exists(os.path.join(self._home, ".codex", "auth.json")):
            return True
        from .native_login import logged_in
        from app.services.cli_tools.tools import effective_binary
        return logged_in('codex', effective_binary('codex'))

    # ---- codex: device-code flow (stdout pipes) ----

    def start_codex(self, timeout: float = 25.0, *, key: str = "codex", env_extra: dict | None = None) -> dict:
        self._kill(key)
        s = LoginSession(key)
        codex_home = (env_extra or {}).get("CODEX_HOME") or os.path.join(self._home, ".codex")
        s.auth_file = os.path.join(codex_home, "auth.json")
        self._sessions[key] = s
        # Run under a pty: a pipe would block-buffer codex's output so the
        # URL/code never arrive line-by-line. A pty makes it flush interactively.
        from app.services.cli_tools.tools import effective_binary
        from app.portability import child_command
        cmd = child_command(effective_binary("codex"), ["login", "--device-auth"])
        conpty = None
        master = None
        if os.name == "nt":
            from winpty import PtyProcess
            try:
                conpty = PtyProcess.spawn(cmd, env=self._env(env_extra), dimensions=(60, 400))
            except (OSError, RuntimeError) as exc:
                return {"flow": "device", "error": str(exc)[:300]}
            class ProcessAdapter:
                pid = conpty.pid
                @property
                def returncode(self):
                    return None if conpty.isalive() else conpty.exitstatus
                def poll(self): return self.returncode
                def wait(self): return conpty.wait()
                def kill(self):
                    from app.portability import kill_tree
                    kill_tree(self.pid)
            proc = ProcessAdapter()
        else:
            import fcntl, pty, termios
            master, slave = pty.openpty()
            try:
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 400, 0, 0))
                proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave,
                                        env=self._env(env_extra), close_fds=True, start_new_session=True)
            except OSError as exc:
                os.close(master)
                return {"flow": "device", "error": str(exc)[:300]}
            finally:
                os.close(slave)
        s.proc = proc
        s.master_fd = master

        def reader() -> None:
            buf = b""
            while True:
                try:
                    r, _, _ = ([], [], []) if conpty else select.select([master], [], [], 0.5)
                except OSError:
                    break
                if conpty or master in r:
                    try:
                        data = conpty.read(4096).encode() if conpty else os.read(master, 4096)
                    except (OSError, EOFError):
                        break
                    if not data:
                        break
                    buf += data
                    clean = _strip(buf)
                    with s.lock:
                        s.output = clean
                        if _CODEX_URL in clean:
                            s.url = _CODEX_URL
                        m = _CODE_RE.search(clean)
                        if m:
                            s.user_code = m.group(1)
                if proc.poll() is not None:
                    break
            proc.wait()
            if conpty:
                conpty.close()
            with s.lock:
                s.done = True
                # Judge THIS login by its own auth file (an account's CODEX_HOME,
                # not the host's ~/.codex) and only if written after it started.
                native_ok = False
                if proc.returncode == 0 and key == 'codex' and not env_extra:
                    from .native_login import logged_in, invalidate
                    invalidate('codex')
                    native_ok = logged_in('codex', effective_binary('codex'))
                s.ok = proc.returncode == 0 and (_fresh(s.auth_file, s.started_at) or native_ok)
                if not s.ok and not s.error:
                    tail = s.output.strip().splitlines()[-3:]
                    s.error = " ".join(tail)[:300] or "login did not complete"

        threading.Thread(target=reader, daemon=True).start()
        return self._wait_for(s, lambda: bool(s.url and s.user_code), timeout, "device")

    def session_state(self, key: str) -> dict | None:
        """done/ok/error/started_at of the login started under ``key``."""
        s = self._sessions.get(key)
        if s is None:
            return None
        with s.lock:
            return {"done": s.done, "ok": s.ok, "error": s.error, "started_at": s.started_at,
                    "auth_file": s.auth_file}

    def codex_status(self) -> dict:
        if self.codex_logged_in():
            return {"status": "connected"}
        s = self._sessions.get("codex")
        if s:
            with s.lock:
                if s.done and not s.ok:
                    return {"status": "failed", "error": s.error or "login did not complete"}
        return {"status": "pending"}

    # ---- claude: direct OAuth PKCE flow (authorize URL -> paste code -> token) ----

    def start_claude(self, timeout: float = 25.0, *, key: str = "claude", env_extra: dict | None = None) -> dict:
        self._kill(key)
        s = LoginSession(key)
        verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode()).digest()
        ).rstrip(b"=").decode()
        state = secrets.token_urlsafe(24)
        s.verifier = verifier
        s.state = state
        params = {
            "code": "true",
            "client_id": _CLAUDE_CLIENT_ID,
            "response_type": "code",
            "redirect_uri": _CLAUDE_REDIRECT,
            "scope": _CLAUDE_SCOPES,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
        s.url = _CLAUDE_AUTHORIZE + "?" + urllib.parse.urlencode(params)
        self._sessions[key] = s
        return {"flow": "paste", "url": s.url}

    def complete_claude(self, code: str, timeout: float = 40.0, *, key: str = "claude",
                        check_dir: str | None = None) -> dict:
        s = self._sessions.get(key)
        if not s or not s.verifier:
            return {"ok": False, "error": "no active claude login — start again"}
        raw = code.strip()
        # The callback shows "<code>#<state>" (CLI splits on '#').
        the_code = raw.split("#")[0].split("&")[0].strip()
        the_state = raw.split("#")[1] if "#" in raw else s.state
        body = json.dumps({
            "grant_type": "authorization_code",
            "code": the_code,
            "state": the_state,
            "client_id": _CLAUDE_CLIENT_ID,
            "redirect_uri": _CLAUDE_REDIRECT,
            "code_verifier": s.verifier,
        }).encode()
        req = urllib.request.Request(
            _CLAUDE_TOKEN, data=body, method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                # Required to pass Cloudflare on platform.claude.com.
                "User-Agent": "claude-cli/2.1.204 (external, cli)",
                "anthropic-beta": "oauth-2025-04-20",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                tok = json.loads(r.read().decode())
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode()[:200]
            except Exception:
                pass
            return {"ok": False, "error": f"token exchange failed ({exc.code}) {detail}"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"token exchange error: {exc}"}

        access = tok.get("access_token")
        if not access:
            return {"ok": False, "error": "no access_token in response"}
        expires_at = int(time.time() * 1000) + int(tok.get("expires_in", 0)) * 1000
        account = tok.get("account") or {}
        creds = {
            "claudeAiOauth": {
                "accessToken": access,
                "refreshToken": tok.get("refresh_token", ""),
                "expiresAt": expires_at,
                "scopes": (tok.get("scope") or _CLAUDE_SCOPES).split(),
                "subscriptionType": account.get("subscription_type")
                or tok.get("subscription_type")
                or "",
            }
        }
        return {"ok": True, "error": "", "credentials": creds}

    # ---- shared ----

    @staticmethod
    def _wait_for(s: LoginSession, ready, timeout: float, flow: str) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            with s.lock:
                if ready() or s.done:
                    break
            time.sleep(0.3)
        with s.lock:
            if not s.url and s.done:
                return {"flow": flow, "error": s.error or (s.output[-300:] or "login failed to start")}
            return {"flow": flow, "url": s.url, "user_code": s.user_code, "error": s.error}
