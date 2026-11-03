"""Renewing a login session the way the official CLIs do (docs/providers.md).

Refresh tokens rotate: when two parties renew with the same refresh token,
one of them ends up holding a dead token — that is how a terminal gets
logged out. So renewal here plays by the CLI's own rules:

**Claude** (:func:`renew_claude`)

1. *Due* (the access token is within Claude Code's 5-minute window, or past
   it): run ``claude auth status --json`` with the account's config dir. That
   command makes Claude Code check — and, when due, renew — its own token
   with its own lock and its own write; nothing here touches the file.
2. *Not due yet* (or the CLI didn't renew it): call the same token endpoint
   the CLI calls, but only while holding **both locks Claude Code itself
   takes** before it renews (``<config dir>/.oauth_refresh.lock`` and the
   legacy ``<config dir>.lock`` — mkdir locks, stale after 60 s, refreshed
   every 5 s by their holder). Under the locks the file is read again: if the
   token changed meanwhile, someone else renewed it — nothing is sent. After
   the answer it is read once more, and written (atomically, same 0600 mode,
   every other field kept) only if the refresh token on disk is still the one
   that was sent.

**Codex** (:func:`renew_codex`): only the CLI renews — ``codex app-server``,
``account/read {refreshToken: true}`` ("requests a proactive token refresh"),
with the account's CODEX_HOME. Codex does the rest (its lock, its write).

Tokens never leave this module: results carry codes and short messages only.
"""

from __future__ import annotations

import json
import os
import select
import subprocess
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from typing import Any, Callable, Iterator

from app.providers.login_session import CLI_REFRESH_WINDOW_S, read_json

# The same endpoint / client Claude Code uses (app.providers.oauth).
from app.providers.oauth import _CLAUDE_CLIENT_ID, _CLAUDE_TOKEN

CLAUDE_TOKEN_URL = _CLAUDE_TOKEN
LOCK_STALE_S = 60.0       # proper-lockfile's `stale` in Claude Code
LOCK_UPDATE_S = 5.0       # ... and its `update` (the holder touches the lock)
LOCK_WAIT_S = 20.0        # how long to wait for a CLI that is renewing right now
CLI_TIMEOUT_S = 60.0
_USER_AGENT = "claude-cli/2.1.309 (external, cli)"


def _result(ok: bool, method: str | None = None, code: str = "", error: str = "", *,
            definitive: bool = False, expires_at: float | None = None) -> dict:
    return {"ok": ok, "method": method, "code": code, "error": error[:300], "definitive": definitive,
            "expires_at": expires_at}


class LockBusy(RuntimeError):
    pass


# ---------------------------------------------------------------- locks


class _DirLock:
    """A mkdir lock compatible with proper-lockfile (what Claude Code uses):
    the directory exists while held, its mtime is refreshed every
    ``LOCK_UPDATE_S``, and one older than ``LOCK_STALE_S`` is abandoned."""

    def __init__(self, path: str, *, clock: Callable[[], float] = time.time) -> None:
        self.path = path
        self._clock = clock
        self._stop = threading.Event()
        self._beat: threading.Thread | None = None

    def try_acquire(self) -> bool:
        try:
            os.mkdir(self.path)
        except FileExistsError:
            try:
                age = self._clock() - os.stat(self.path).st_mtime
            except FileNotFoundError:
                return self.try_acquire_once()
            if age <= LOCK_STALE_S:
                return False
            try:  # a holder that died: take it over (what proper-lockfile does)
                os.rmdir(self.path)
            except OSError:
                return False
            return self.try_acquire_once()
        self._start_heartbeat()
        return True

    def try_acquire_once(self) -> bool:
        try:
            os.mkdir(self.path)
        except FileExistsError:
            return False
        self._start_heartbeat()
        return True

    def _start_heartbeat(self) -> None:
        def beat() -> None:
            while not self._stop.wait(LOCK_UPDATE_S):
                try:
                    os.utime(self.path)
                except OSError:
                    return

        self._beat = threading.Thread(target=beat, daemon=True)
        self._beat.start()

    def release(self) -> None:
        self._stop.set()
        try:
            os.rmdir(self.path)
        except OSError:
            pass


def claude_lock_paths(cfg_dir: str) -> tuple[str, str]:
    """(new, legacy) lock paths Claude Code takes before renewing."""
    real = os.path.realpath(cfg_dir)
    return os.path.join(cfg_dir, ".oauth_refresh.lock"), real.rstrip(os.sep) + ".lock"


@contextmanager
def claude_refresh_locks(cfg_dir: str, *, wait_s: float = LOCK_WAIT_S,
                         sleep: Callable[[float], None] = time.sleep) -> Iterator[None]:
    """Hold both of Claude Code's refresh locks (same order as the CLI)."""
    new_path, legacy_path = claude_lock_paths(cfg_dir)
    deadline = time.monotonic() + wait_s
    while True:
        first = _DirLock(new_path)
        if first.try_acquire():
            second = _DirLock(legacy_path)
            if second.try_acquire():
                try:
                    yield
                finally:
                    second.release()
                    first.release()
                return
            first.release()
        if time.monotonic() >= deadline:
            raise LockBusy("Claude Code is renewing this login right now")
        sleep(0.5)


# ---------------------------------------------------------------- files


def _read_oauth(path: str) -> tuple[dict | None, dict]:
    doc = read_json(path)
    oauth = (doc or {}).get("claudeAiOauth")
    return doc, oauth if isinstance(oauth, dict) else {}


def write_json_atomic(path: str, doc: dict) -> None:
    """Replace ``path`` atomically, keeping its mode (0600 for a new file)."""
    try:
        mode = os.stat(path).st_mode & 0o777
    except OSError:
        mode = 0o600
    tmp = f"{path}.hrh-{os.getpid()}-{threading.get_ident()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode or 0o600)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(doc, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode or 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _exp_s(oauth: dict) -> float | None:
    try:
        v = float(oauth.get("expiresAt"))
    except (TypeError, ValueError):
        return None
    return v / 1000.0 if v > 1e11 else v


# ---------------------------------------------------------------- claude


def _post_refresh(refresh_token: str, *, scopes: list[str], client_id: str | None, timeout: float = 30.0) -> dict:
    body: dict[str, Any] = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id or _CLAUDE_CLIENT_ID,
    }
    if scopes:
        body["scope"] = " ".join(scopes)
    req = urllib.request.Request(
        CLAUDE_TOKEN_URL, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": _USER_AGENT, "anthropic-beta": "oauth-2025-04-20"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _run_claude_cli(binary: str, env: dict[str, str], timeout: float) -> tuple[int | None, str]:
    """``claude auth status --json`` — Claude Code renews a due token itself."""
    try:
        proc = subprocess.run(
            [binary, "auth", "status", "--json"], env=env, capture_output=True, text=True,
            timeout=timeout, stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return None, "claude CLI not found"
    except subprocess.TimeoutExpired:
        return None, "claude auth status timed out"
    tail = (proc.stderr or "").strip().splitlines()[-2:]
    return proc.returncode, " ".join(tail)


def renew_claude(
    cfg_dir: str, *, env: dict[str, str], binary: str, now: Callable[[], float] = time.time,
    cli_timeout: float = CLI_TIMEOUT_S, lock_wait_s: float = LOCK_WAIT_S,
) -> dict:
    """Renew a Claude login in ``cfg_dir`` (see the module doc)."""
    path = os.path.join(cfg_dir, ".credentials.json")
    _doc, before = _read_oauth(path)
    if not before.get("accessToken"):
        return _result(False, None, "no_credentials", "not signed in", definitive=True)
    if not before.get("refreshToken"):
        return _result(False, None, "no_refresh_token", "this login has no refresh token — sign in again",
                       definitive=True)
    exp = _exp_s(before)
    cli_note = ""
    if exp is None or exp - now() <= CLI_REFRESH_WINDOW_S - 10:
        _rc, cli_note = _run_claude_cli(binary, env, cli_timeout)
        _d, after = _read_oauth(path)
        new_exp = _exp_s(after)
        if after.get("accessToken") and after.get("accessToken") != before.get("accessToken") and (
            new_exp is None or new_exp > now()
        ):
            return _result(True, "cli", expires_at=new_exp)
        # the CLI didn't renew it (lock busy, refused, offline): ask directly
        # under its locks — the answer says whether the refresh token is dead.
    try:
        with claude_refresh_locks(cfg_dir, wait_s=lock_wait_s):
            doc, cur = _read_oauth(path)
            if cur.get("accessToken") != before.get("accessToken"):
                # renewed by someone else (a CLI) while we waited: done, nothing sent
                return _result(True, "already", expires_at=_exp_s(cur))
            posted = cur.get("refreshToken") or ""
            if not posted:
                return _result(False, None, "no_refresh_token", "this login has no refresh token — sign in again",
                               definitive=True)
            scopes = [s for s in (cur.get("scopes") or []) if isinstance(s, str)]
            try:
                tok = _post_refresh(posted, scopes=scopes, client_id=cur.get("clientId"))
            except urllib.error.HTTPError as exc:
                detail = ""
                try:
                    detail = exc.read().decode(errors="replace")[:300]
                except Exception:  # noqa: BLE001
                    pass
                dead = exc.code in (400, 401) and ("invalid_grant" in detail or exc.code == 401)
                if dead:
                    return _result(False, "direct", "invalid_grant",
                                   "the provider refused the refresh token (revoked or expired) — sign in again",
                                   definitive=True)
                if exc.code == 429:
                    return _result(False, "direct", "rate_limited", "the sign-in server is rate limiting — try later")
                return _result(False, "direct", f"http_{exc.code}", f"renewal failed ({exc.code})")
            except (OSError, ValueError) as exc:
                note = f" (CLI: {cli_note})" if cli_note else ""
                return _result(False, "direct", "network", f"renewal failed: {type(exc).__name__}{note}")
            access = tok.get("access_token")
            if not access:
                return _result(False, "direct", "bad_response", "the sign-in server's answer had no token")
            doc2, again = _read_oauth(path)
            if (again.get("refreshToken") or "") != posted:
                # written by someone who didn't take the lock: keep theirs
                return _result(True, "already", expires_at=_exp_s(again))
            t = now()
            new = dict(again)
            new["accessToken"] = access
            new["refreshToken"] = tok.get("refresh_token") or posted
            try:
                new["expiresAt"] = int((t + float(tok.get("expires_in"))) * 1000)
            except (TypeError, ValueError):
                new.pop("expiresAt", None)
            if tok.get("refresh_token_expires_in") is not None:
                try:
                    new["refreshTokenExpiresAt"] = int((t + float(tok["refresh_token_expires_in"])) * 1000)
                except (TypeError, ValueError):
                    pass
            elif tok.get("refresh_token") and tok.get("refresh_token") != posted:
                new.pop("refreshTokenExpiresAt", None)  # a new refresh token: the old end date isn't its own
            if isinstance(tok.get("scope"), str) and tok["scope"].strip():
                new["scopes"] = tok["scope"].split()
            out_doc = dict(doc2 or doc or {})
            out_doc["claudeAiOauth"] = new
            write_json_atomic(path, out_doc)
            return _result(True, "direct", expires_at=_exp_s(new))
    except LockBusy as exc:
        return _result(False, None, "lock_busy", str(exc))


# ---------------------------------------------------------------- codex


def _codex_rpc(binary: str, env: dict[str, str], timeout: float) -> tuple[dict | None, str]:
    """``codex app-server``: initialize, then account/read {refreshToken: true}."""
    try:
        proc = subprocess.Popen([binary, "app-server"], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
    except FileNotFoundError:
        return None, "codex CLI not found"
    err_tail: list[str] = []

    def drain() -> None:
        for raw in iter(proc.stderr.readline, b""):  # type: ignore[union-attr]
            err_tail.append(raw.decode(errors="replace").strip())
            del err_tail[:-8]

    threading.Thread(target=drain, daemon=True).start()

    def send(msg: dict) -> None:
        proc.stdin.write((json.dumps(msg) + "\n").encode())  # type: ignore[union-attr]
        proc.stdin.flush()  # type: ignore[union-attr]

    def wait(rid: int, until: float) -> dict | None:
        while time.monotonic() < until:
            r, _, _ = select.select([proc.stdout], [], [], 0.5)
            if not r:
                if proc.poll() is not None:
                    return None
                continue
            line = proc.stdout.readline()  # type: ignore[union-attr]
            if not line:
                return None
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("id") == rid:
                return msg
        return None

    until = time.monotonic() + timeout
    answer = None
    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "my-mate-geny", "version": "1"}}})
        if wait(1, until) is not None:
            send({"method": "initialized"})
            send({"id": 2, "method": "account/read", "params": {"refreshToken": True}})
            answer = wait(2, until)
    except (OSError, ValueError):
        pass
    finally:
        try:
            proc.terminate()
            proc.wait(5)
        except Exception:  # noqa: BLE001
            proc.kill()
    return answer, " ".join(x for x in err_tail if x)[-400:]


_CODEX_DEAD = ("refresh token has expired", "refresh_token_expired", "refresh token was already used",
               "refresh_token_reused", "refresh token was revoked", "refresh_token_invalidated", "invalid_grant",
               "sign in again", "log out and sign in")


def renew_codex(codex_home: str, *, env: dict[str, str], binary: str, now: Callable[[], float] = time.time,
                timeout: float = CLI_TIMEOUT_S) -> dict:
    path = os.path.join(codex_home, "auth.json")
    before = read_json(path) or {}
    tokens = before.get("tokens") if isinstance(before.get("tokens"), dict) else {}
    if str(before.get("auth_mode") or "").lower() in ("apikey", "api_key") or (
        before.get("OPENAI_API_KEY") and not tokens.get("access_token")
    ):
        return _result(False, None, "api_key", "an API key has no session to renew")
    if not tokens.get("access_token"):
        return _result(False, None, "no_credentials", "not signed in", definitive=True)
    if not tokens.get("refresh_token"):
        return _result(False, None, "no_refresh_token", "this login has no refresh token — sign in again",
                       definitive=True)
    answer, err = _codex_rpc(binary, env, timeout)
    after = read_json(path) or {}
    t_after = after.get("tokens") if isinstance(after.get("tokens"), dict) else {}
    changed = (t_after.get("access_token") != tokens.get("access_token")
               or after.get("last_refresh") != before.get("last_refresh"))
    if changed and t_after.get("access_token"):
        from app.providers.login_session import jwt_claims

        exp = jwt_claims(t_after.get("access_token")).get("exp")
        return _result(True, "cli", expires_at=float(exp) if isinstance(exp, (int, float)) else None)
    text = f"{(answer or {}).get('error', {}).get('message', '') if isinstance(answer, dict) else ''} {err}".lower()
    if any(k in text for k in _CODEX_DEAD):
        return _result(False, "cli", "invalid_grant", "Codex couldn't renew the login (refresh token expired or "
                       "revoked) — sign in again", definitive=True)
    if isinstance(answer, dict) and isinstance(answer.get("result"), dict) and answer["result"].get("account"):
        # Codex answered with the account and kept its token: nothing was due
        from app.providers.login_session import jwt_claims

        exp = jwt_claims(tokens.get("access_token")).get("exp")
        return _result(True, "cli", "not_needed", expires_at=float(exp) if isinstance(exp, (int, float)) else None)
    msg = ((answer or {}).get("error") or {}).get("message") if isinstance(answer, dict) else None
    return _result(False, "cli", "cli_refresh_failed", f"Codex didn't renew the login{': ' + msg if msg else ''}")
