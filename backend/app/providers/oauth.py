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

import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import termios
import threading
import time
from dataclasses import dataclass, field

_ANSI = re.compile(
    rb"\x1b\[[0-9;?]*[a-zA-Z]"  # CSI
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC ... BEL/ST
    rb"|\x1b[>=@-Z\\-_]"  # misc 2-byte
)
_CODE_RE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b")
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
    output: str = ""
    done: bool = False
    ok: bool = False
    error: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)


class OAuthManager:
    def __init__(self) -> None:
        self._sessions: dict[str, LoginSession] = {}
        self._home = os.environ.get("HOME", os.path.expanduser("~"))

    def _env(self) -> dict[str, str]:
        env = dict(os.environ)
        env["HOME"] = self._home
        env.setdefault("TERM", "xterm-256color")
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
        return os.path.exists(os.path.join(self._home, ".codex", "auth.json"))

    # ---- codex: device-code flow (stdout pipes) ----

    def start_codex(self, timeout: float = 25.0) -> dict:
        self._kill("codex")
        s = LoginSession("codex")
        self._sessions["codex"] = s
        # Run under a pty: a pipe would block-buffer codex's output so the
        # URL/code never arrive line-by-line. A pty makes it flush interactively.
        master, slave = pty.openpty()
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 400, 0, 0))
        except Exception:
            pass
        try:
            proc = subprocess.Popen(
                ["codex", "login", "--device-auth"],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env=self._env(),
                close_fds=True,
                preexec_fn=os.setsid,
            )
        except FileNotFoundError:
            os.close(master)
            os.close(slave)
            return {"flow": "device", "error": "codex CLI not found"}
        os.close(slave)
        s.proc = proc
        s.master_fd = master

        def reader() -> None:
            buf = b""
            while True:
                try:
                    r, _, _ = select.select([master], [], [], 0.5)
                except OSError:
                    break
                if master in r:
                    try:
                        data = os.read(master, 4096)
                    except OSError:
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
            with s.lock:
                s.done = True
                s.ok = self.codex_logged_in()

        threading.Thread(target=reader, daemon=True).start()
        return self._wait_for(s, lambda: bool(s.url and s.user_code), timeout, "device")

    def codex_status(self) -> dict:
        if self.codex_logged_in():
            return {"status": "connected"}
        s = self._sessions.get("codex")
        if s:
            with s.lock:
                if s.done and not s.ok:
                    return {"status": "failed", "error": s.error or "login did not complete"}
        return {"status": "pending"}

    # ---- claude: auth-url + paste-code flow (pty) ----

    def start_claude(self, timeout: float = 25.0) -> dict:
        self._kill("claude")
        s = LoginSession("claude")
        self._sessions["claude"] = s
        master, slave = pty.openpty()
        # Wide window so the URL never wraps.
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 400, 0, 0))
        except Exception:
            pass
        try:
            proc = subprocess.Popen(
                ["claude", "setup-token"],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env=self._env(),
                close_fds=True,
                preexec_fn=os.setsid,
            )
        except FileNotFoundError:
            os.close(master)
            os.close(slave)
            return {"flow": "paste", "error": "claude CLI not found"}
        os.close(slave)
        s.proc = proc
        s.master_fd = master

        def reader() -> None:
            buf = b""
            while True:
                try:
                    r, _, _ = select.select([master], [], [], 0.5)
                except OSError:
                    break
                if master in r:
                    try:
                        data = os.read(master, 4096)
                    except OSError:
                        break
                    if not data:
                        break
                    buf += data
                    with s.lock:
                        s.output = _strip(buf)
                        if not s.url:
                            m = _CLAUDE_OSC.search(buf) or _CLAUDE_PLAIN.search(buf)
                            if m:
                                s.url = (m.group(1) if m.re is _CLAUDE_OSC else m.group(0)).decode(
                                    errors="replace"
                                )
                if proc.poll() is not None:
                    break
            proc.wait()
            with s.lock:
                s.done = True
                s.ok = self.claude_logged_in()

        threading.Thread(target=reader, daemon=True).start()
        return self._wait_for(s, lambda: bool(s.url), timeout, "paste")

    def complete_claude(self, code: str, timeout: float = 40.0) -> dict:
        s = self._sessions.get("claude")
        if not s or s.master_fd is None:
            return {"ok": False, "error": "no active claude login — start again"}
        try:
            os.write(s.master_fd, (code.strip() + "\r").encode())
        except OSError as exc:
            return {"ok": False, "error": f"failed to send code: {exc}"}
        deadline = time.time() + timeout
        while time.time() < deadline:
            with s.lock:
                if s.done or self.claude_logged_in():
                    return {"ok": s.ok or self.claude_logged_in(), "error": s.error}
            time.sleep(0.3)
        # Even if the CLI hasn't exited, a fresh credential file means success.
        return {"ok": self.claude_logged_in(), "error": "" if self.claude_logged_in() else "timed out"}

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
