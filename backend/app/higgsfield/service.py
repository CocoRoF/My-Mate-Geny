"""Higgsfield accounts: sign-in, tokens (sealed in the vault), the only refresher, and the account API.

One row per Higgsfield account in ``higgsfield_accounts``; its tokens are a vault secret ``higgsfield:<id>``
(``{access, refresh, issued_at, expires_at}``), its details (email, plan, credits, workspaces) a JSON column. One
account is the default — the one chats use.

Only this service refreshes tokens: Higgsfield's refresh token may change on every use, so two refreshers would sign
each other out. Refreshes are serialised per account (an asyncio lock; the server runs as one process) and the
tokens are read again inside the lock, so of two concurrent callers only one refreshes and the other gets its result.
Agents get the access token alone (agent.py), never the refresh token.

Outbound calls are plain urllib in a worker thread (no extra dependency); ``transport`` is swapped in tests. Every
error text is redacted (oauth.redact) before it reaches a log, an exception or the UI. Never calls purchase endpoints.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from app.config import settings
from app.db import Database
from app.higgsfield.oauth import (
    CLIENT_ID,
    PENDING_TTL_S,
    REDIRECT_URI,
    HiggsfieldError,
    authorize_url,
    needs_refresh,
    normalize_tokens,
    parse_callback,
    parse_time,
    pkce,
    redact,
)
from app.vault import SecretVault

#: (method, url, headers, body, timeout) -> (status, body)
Transport = Callable[[str, str, dict[str, str], bytes | None, float], tuple[int, bytes]]

TIMEOUT_S = 30.0
#: Job types are the account's catalogue: read once a day.
JOB_TYPES_TTL_S = 24 * 3600
#: The account's balance / plan shown in the UI is read again after this long.
PROFILE_TTL_S = 60

_TABLE = """
CREATE TABLE IF NOT EXISTS higgsfield_accounts (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL DEFAULT '',
    email       TEXT,
    source      TEXT NOT NULL DEFAULT 'oauth',
    info        TEXT NOT NULL DEFAULT '{}',
    check_state TEXT NOT NULL DEFAULT '{}',
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
)
"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso() -> str:
    return _now().isoformat()


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None,
                     timeout: float) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed https endpoints
            return resp.status, resp.read(8 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        try:
            data = exc.read(1024 * 1024)
        except Exception:  # noqa: BLE001
            data = b""
        return exc.code, data


def _json(body: bytes) -> Any:
    try:
        return json.loads(body.decode("utf-8", "replace") or "null")
    except ValueError:
        return None


def _said(body: bytes) -> str:
    data = _json(body)
    if isinstance(data, dict):
        for key in ("detail", "message", "error_description", "error"):
            v = data.get(key)
            if isinstance(v, str) and v:
                return v
            if v is not None:
                return json.dumps(v)[:300]
    return body.decode("utf-8", "replace")[:300]


class HiggsfieldService:
    def __init__(self, db: Database, vault: SecretVault, transport: Transport | None = None) -> None:
        self._db = db
        self._vault = vault
        self.transport: Transport = transport or urllib_transport
        self._db.execute(_TABLE)
        #: state -> (verifier, started (monotonic), account id to sign in again or None)
        self._pending: dict[str, tuple[str, float, str | None]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._job_types: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        #: called with an account id after its tokens changed (agent.py rewrites the chats' credentials)
        self.on_tokens: list[Callable[[str], None]] = []

    # ---- http ----

    async def _request(self, method: str, url: str, *, headers: dict[str, str] | None = None,
                       form: dict[str, str] | None = None, body: Any = None,
                       params: dict[str, Any] | None = None) -> tuple[int, bytes]:
        h = {"Accept": "application/json", "User-Agent": "my-mate-geny"}
        h.update(headers or {})
        data = None
        if form is not None:
            data = urllib.parse.urlencode(form).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        elif body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                url = f"{url}?{urllib.parse.urlencode(clean)}"
        try:
            return await asyncio.to_thread(self.transport, method, url, h, data, TIMEOUT_S)
        except (OSError, ValueError) as exc:  # URLError, timeouts, refused connections
            raise HiggsfieldError("network", type(exc).__name__) from None

    # ---- rows ----

    def _row(self, aid: str) -> dict[str, Any]:
        row = self._db.query_one("SELECT * FROM higgsfield_accounts WHERE id = ?", (aid,))
        if row is None:
            raise HiggsfieldError("not_connected")
        d = dict(row)
        for key in ("info", "check_state"):
            try:
                d[key] = json.loads(d.get(key) or "{}")
            except ValueError:
                d[key] = {}
        return d

    def rows(self) -> list[dict[str, Any]]:
        ids = [r["id"] for r in self._db.query("SELECT id FROM higgsfield_accounts ORDER BY created_at")]
        return [self._row(i) for i in ids]

    def default_id(self) -> str | None:
        row = self._db.query_one(
            "SELECT id FROM higgsfield_accounts ORDER BY is_default DESC, created_at LIMIT 1")
        return row["id"] if row else None

    def connected(self) -> bool:
        return self.default_id() is not None

    @staticmethod
    def _secret_ref(aid: str) -> str:
        return SecretVault.make_id("higgsfield", aid)

    def tokens_of(self, aid: str) -> dict[str, Any] | None:
        ref = self._secret_ref(aid)
        if not self._vault.exists(ref):
            return None
        try:
            return normalize_tokens(self._vault.read(ref))
        except Exception:  # noqa: BLE001 - VaultError (key changed) or a damaged secret: signed out
            return None

    def _put_tokens(self, aid: str, tokens: dict[str, Any]) -> None:
        self._vault.put("higgsfield", aid, json.dumps(tokens, separators=(",", ":")))
        for cb in list(self.on_tokens):
            try:
                cb(aid)
            except Exception:  # noqa: BLE001 - a listener never breaks a refresh
                pass

    def _save(self, aid: str, *, info: dict[str, Any] | None = None, check: dict[str, Any] | None = None,
              email: str | None = None) -> None:
        sets, params = ["updated_at = ?"], [_iso()]
        if info is not None:
            sets.append("info = ?")
            params.append(json.dumps(info))
        if check is not None:
            sets.append("check_state = ?")
            params.append(json.dumps(check))
        if email is not None:
            sets.append("email = ?")
            params.append(email)
        params.append(aid)
        self._db.execute(f"UPDATE higgsfield_accounts SET {', '.join(sets)} WHERE id = ?", params)

    def public(self, row: dict[str, Any]) -> dict[str, Any]:
        """An account as the UI sees it: no token, only whether there is one and when it expires."""
        info = row.get("info") or {}
        tokens = self.tokens_of(row["id"])
        check = row.get("check_state") or {}
        status = "ok"
        if tokens is None or check.get("error") == "reauth_required":
            status = "reauth"
        elif check.get("ok") is False:
            status = "error"
        return {
            "id": row["id"],
            "label": row.get("label") or row.get("email") or "",
            "email": row.get("email"),
            "source": row.get("source") or "oauth",
            "is_default": bool(row.get("is_default")),
            "plan": info.get("plan"),
            "credits": info.get("credits"),
            "workspace_id": info.get("workspace_id"),
            "workspaces": info.get("workspaces") or [],
            "refreshed_at": info.get("refreshed_at"),
            "status": status,
            "error": check.get("error") if status != "ok" else None,
            "checked_at": check.get("at"),
            "has_refresh_token": bool(tokens and tokens.get("refresh")),
            "token_expires_at": tokens.get("expires_at") if tokens else None,
            "created_at": row.get("created_at"),
        }

    def accounts(self) -> list[dict[str, Any]]:
        return [self.public(r) for r in self.rows()]

    def account(self, aid: str) -> dict[str, Any]:
        return self.public(self._row(aid))

    def _create(self, tokens: dict[str, Any], *, source: str, email: str | None, label: str = "") -> str:
        aid = "hf_" + secrets.token_hex(6)
        now = _iso()
        first = not self.connected()
        self._db.execute(
            "INSERT INTO higgsfield_accounts (id, label, email, source, info, check_state, is_default, created_at, "
            "updated_at) VALUES (?, ?, ?, ?, '{}', '{}', ?, ?, ?)",
            (aid, label or email or "", email, source, 1 if first else 0, now, now),
        )
        self._put_tokens(aid, tokens)
        return aid

    def set_default(self, aid: str) -> dict[str, Any]:
        self._row(aid)
        self._db.execute("UPDATE higgsfield_accounts SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END", (aid,))
        return self.account(aid)

    def rename(self, aid: str, label: str) -> dict[str, Any]:
        self._row(aid)
        self._db.execute("UPDATE higgsfield_accounts SET label = ?, updated_at = ? WHERE id = ?",
                         (label.strip()[:80], _iso(), aid))
        return self.account(aid)

    def disconnect(self, aid: str) -> None:
        """Forget the account here (its tokens leave the vault; Higgsfield itself isn't told)."""
        row = self._row(aid)
        self._vault.delete(self._secret_ref(aid))
        self._db.execute("DELETE FROM higgsfield_accounts WHERE id = ?", (aid,))
        self._job_types.pop(aid, None)
        if row.get("is_default"):
            nxt = self.default_id()
            if nxt:
                self.set_default(nxt)
        for cb in list(self.on_tokens):
            try:
                cb(aid)
            except Exception:  # noqa: BLE001
                pass

    # ---- sign-in ----

    def start_login(self, account_id: str | None = None) -> dict[str, Any]:
        """A PKCE authorize link (the CLI's client). ``account_id``: sign that account in again."""
        if account_id is not None:
            self._row(account_id)
        moment = time.monotonic()
        self._pending = {s: p for s, p in self._pending.items() if moment - p[1] < PENDING_TTL_S}
        verifier, challenge = pkce()
        state = secrets.token_urlsafe(24)
        self._pending[state] = (verifier, moment, account_id)
        return {"authorize_url": authorize_url(settings.higgsfield_authorize_url, state, challenge),
                "redirect_uri": REDIRECT_URI, "state": state, "expires_in": PENDING_TTL_S}

    async def complete_login(self, callback: str) -> dict[str, Any]:
        """The pasted (or caught) callback address → the signed-in account."""
        code, state = parse_callback(callback)
        moment = time.monotonic()
        if state is None:  # a bare code: only when exactly one login is waiting
            live = [s for s, p in self._pending.items() if moment - p[1] < PENDING_TTL_S]
            if len(live) != 1:
                raise HiggsfieldError("invalid_callback")
            state = live[0]
        pending = self._pending.get(state)
        if pending is None or moment - pending[1] > PENDING_TTL_S:
            raise HiggsfieldError("login_expired")
        del self._pending[state]
        verifier, _, account_id = pending
        body = await self._token_request({
            "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI,
            "client_id": CLIENT_ID, "code_verifier": verifier,
        })
        tokens = normalize_tokens({**body, "issued_at": None})
        if tokens is None:
            raise HiggsfieldError("token_exchange_failed")
        return await self._adopt(tokens, source="oauth", account_id=account_id)

    async def import_credentials(self, raw: Any) -> dict[str, Any]:
        """The contents of the CLI's credentials.json (text or the parsed object)."""
        tokens = normalize_tokens(raw)
        if tokens is None:
            raise HiggsfieldError("import_failed")
        return await self._adopt(tokens, source="import")

    async def _adopt(self, tokens: dict[str, Any], *, source: str, account_id: str | None = None) -> dict[str, Any]:
        """New tokens → read the account with them first (bad tokens never become an account), then store them on
        the account they belong to (same email = the same account, signed in again) or a new one."""
        profile = await self._profile_with(tokens["access"], None)
        email = profile.get("email")
        target = account_id
        if target is None and email:
            row = self._db.query_one("SELECT id FROM higgsfield_accounts WHERE email = ?", (email,))
            target = row["id"] if row else None
        if target is not None:
            row = self._row(target)
            async with self._lock(target):
                self._put_tokens(target, tokens)
            self._db.execute("UPDATE higgsfield_accounts SET source = ? WHERE id = ?", (source, target))
            info = {**(row.get("info") or {}), **profile}
            self._save(target, info=info, check={"ok": True, "at": _iso(), "error": None}, email=email)
        else:
            target = self._create(tokens, source=source, email=email)
            self._save(target, info=profile, check={"ok": True, "at": _iso(), "error": None})
        return self.account(target)

    # ---- tokens ----

    def _lock(self, aid: str) -> asyncio.Lock:
        return self._locks.setdefault(aid, asyncio.Lock())

    async def _token_request(self, form: dict[str, str]) -> dict[str, Any]:
        status, raw = await self._request("POST", settings.higgsfield_token_url, form=form)
        body = _json(raw)
        if status >= 400 or not isinstance(body, dict) or not body.get("access_token"):
            err = body.get("error") if isinstance(body, dict) else None
            code = ("reauth_required" if err in ("invalid_grant", "invalid_token") and form["grant_type"] == "refresh_token"
                    else "token_exchange_failed")
            said = (body.get("error_description") or err) if isinstance(body, dict) else None
            raise HiggsfieldError(code, redact(said or f"HTTP {status}", *form.values()))
        return body

    async def access_token(self, aid: str, *, force: bool = False, failed: str | None = None,
                           keep: timedelta = timedelta(0)) -> dict[str, Any]:
        """The account's tokens, refreshed first when near expiry (``keep``: when less than that is left), or when
        ``force``d / the access token ``failed`` (a 401) — unless another caller has replaced that token meanwhile.
        Raises reauth_required when there is no way to refresh."""
        force = force or failed is not None
        tokens = self.tokens_of(aid)
        if tokens is None:
            self._row(aid)  # not_connected when the account is gone
            raise HiggsfieldError("reauth_required")
        if not force and not needs_refresh(tokens, keep=keep):
            return tokens
        async with self._lock(aid):
            tokens = self.tokens_of(aid)  # read again inside the lock: another caller may have refreshed
            if tokens is None:
                raise HiggsfieldError("reauth_required")
            if failed is not None and tokens["access"] != failed:
                return tokens  # refreshed by someone else since that call
            if not force and not needs_refresh(tokens, keep=keep):
                return tokens
            if not tokens.get("refresh"):
                if force or needs_refresh(tokens):  # (merely inside `keep`: the token still works for now)
                    self._save(aid, check={"ok": False, "at": _iso(), "error": "reauth_required"})
                    raise HiggsfieldError("reauth_required")
                return tokens
            try:
                body = await self._token_request({"grant_type": "refresh_token", "refresh_token": tokens["refresh"],
                                                  "client_id": CLIENT_ID})
            except HiggsfieldError as exc:
                if exc.code == "reauth_required":
                    self._save(aid, check={"ok": False, "at": _iso(), "error": "reauth_required"})
                raise
            fresh = normalize_tokens({**body, "issued_at": None})
            if fresh is None:
                raise HiggsfieldError("token_exchange_failed")
            fresh["refresh"] = fresh["refresh"] or tokens["refresh"]
            self._put_tokens(aid, fresh)
            return fresh

    # ---- account API ----

    async def _api_with(self, access: str, method: str, path: str, *, workspace: str | None = None,
                        params: dict[str, Any] | None = None, body: Any = None) -> tuple[int, bytes]:
        headers = {"Authorization": f"Bearer {access}"}
        if workspace:
            headers["hf-workspace-id"] = str(workspace)
        return await self._request(method, f"{settings.higgsfield_api_base}{path}", headers=headers,
                                   params=params, body=body)

    @staticmethod
    def _check(status: int, raw: bytes, path: str, *secrets_: str) -> Any:
        if status == 404 and path.startswith(("/jobs/", "/job_types/")):
            raise HiggsfieldError("unknown_job_type", redact(_said(raw), *secrets_))
        if status in (400, 422):
            raise HiggsfieldError("invalid_params", redact(_said(raw), *secrets_))
        if status >= 400:
            raise HiggsfieldError("api_error", f"{path} → {status}: {redact(_said(raw), *secrets_)}")
        data = _json(raw)
        if data is None:
            raise HiggsfieldError("bad_json", path)
        return data

    async def api(self, aid: str, method: str, path: str, *, params: dict[str, Any] | None = None,
                  body: Any = None) -> Any:
        """One account API call with the account's token and workspace; a 401 forces one refresh and a retry."""
        workspace = (self._row(aid).get("info") or {}).get("workspace_id")
        status, raw, access = 0, b"", ""
        for attempt in range(2):
            tokens = await self.access_token(aid, failed=access if attempt == 1 else None)
            access = tokens["access"]
            status, raw = await self._api_with(access, method, path, workspace=workspace, params=params, body=body)
            if status != 401:
                break
        if status == 401:
            self._save(aid, check={"ok": False, "at": _iso(), "error": "reauth_required"})
            raise HiggsfieldError("reauth_required", "the account API refused the token")
        return self._check(status, raw, path, access)

    async def _profile_with(self, access: str, workspace: str | None) -> dict[str, Any]:
        """Workspaces + balance read with a token (not stored yet). → the account details."""
        status, raw = await self._api_with(access, "GET", "/account/workspaces", workspace=workspace)
        if status == 401:
            raise HiggsfieldError("import_failed", "Higgsfield refused these credentials (signed out or expired)")
        ws = self._check(status, raw, "/account/workspaces", access)
        return await self._profile_from(access, workspace, ws)

    async def _profile_from(self, access: str, workspace: str | None, ws: Any) -> dict[str, Any]:
        items = [w for w in (ws.get("items") if isinstance(ws, dict) else ws) or [] if isinstance(w, dict) and w.get("id")]
        workspaces = [{"id": str(w["id"]), "name": str(w.get("name") or w.get("title") or ""),
                       "type": w.get("type")} for w in items]
        current = workspace
        if current not in [w["id"] for w in workspaces]:
            chosen = (next((w for w in items if w.get("is_selected")), None)
                      or next((w for w in items if w.get("type") == "private"), None)
                      or (items[0] if items else None))
            current = str(chosen["id"]) if chosen else None
        status, raw = await self._api_with(access, "GET", "/account/balance", workspace=current)
        bal = self._check(status, raw, "/account/balance", access)
        bal = bal if isinstance(bal, dict) else {}
        credits = bal.get("credits")
        return {
            "email": bal.get("email") if isinstance(bal.get("email"), str) else None,
            "plan": bal.get("subscription_plan_type"),
            "credits": credits if isinstance(credits, (int, float)) and not isinstance(credits, bool) else None,
            "workspace_id": current, "workspaces": workspaces, "refreshed_at": _iso(),
        }

    async def refresh_profile(self, aid: str) -> dict[str, Any]:
        """Balance, plan and workspaces again (the token is refreshed first when needed). → the account."""
        row = self._row(aid)
        info = dict(row.get("info") or {})
        try:
            ws = await self.api(aid, "GET", "/account/workspaces")
            tokens = await self.access_token(aid)
            profile = await self._profile_from(tokens["access"], info.get("workspace_id"), ws)
        except HiggsfieldError as exc:
            if exc.code != "reauth_required":
                self._save(aid, check={"ok": False, "at": _iso(), "error": exc.text()})
            raise
        info.update(profile)
        self._save(aid, info=info, check={"ok": True, "at": _iso(), "error": None},
                   email=profile.get("email") or row.get("email"))
        return self.account(aid)

    async def fresh_account(self, aid: str, max_age_s: float = PROFILE_TTL_S) -> dict[str, Any]:
        """The account, its balance read again when older than ``max_age_s`` (errors keep the stored one)."""
        acc = self.account(aid)
        at = parse_time(acc.get("refreshed_at"))
        if at is None or (_now() - at).total_seconds() > max_age_s:
            try:
                return await self.refresh_profile(aid)
            except HiggsfieldError:
                return self.account(aid)
        return acc

    def set_workspace(self, aid: str, workspace_id: str) -> dict[str, Any]:
        row = self._row(aid)
        info = dict(row.get("info") or {})
        known = [w.get("id") for w in info.get("workspaces") or [] if isinstance(w, dict)]
        if known and workspace_id not in known:
            raise HiggsfieldError("unknown_workspace")
        info["workspace_id"] = workspace_id
        self._save(aid, info=info)
        for cb in list(self.on_tokens):  # the chats' CLI config names the workspace
            try:
                cb(aid)
            except Exception:  # noqa: BLE001
                pass
        return self.account(aid)

    async def transactions(self, aid: str, *, size: int = 20, cursor: str | None = None) -> dict[str, Any]:
        """Recent credit transactions (newest first): {items: [{action, created_at, credits, display_name}], cursor}."""
        data = await self.api(aid, "GET", "/account/transactions",
                              params={"size": max(1, min(int(size), 100)), "cursor": cursor})
        items = data.get("items") if isinstance(data, dict) else data
        out = []
        for t in items or []:
            if not isinstance(t, dict):
                continue
            credits = t.get("credits")
            out.append({
                "action": str(t.get("action") or ""),
                "created_at": t.get("created_at"),
                "credits": credits if isinstance(credits, (int, float)) and not isinstance(credits, bool) else None,
                "display_name": str(t.get("display_name") or ""),
            })
        nxt = data.get("cursor") if isinstance(data, dict) else None
        return {"items": out, "cursor": str(nxt) if nxt not in (None, "") else None}

    async def job_types(self, aid: str, *, force: bool = False) -> list[dict[str, Any]]:
        """The account's job types [{job_type, display_name, type}] (cached a day)."""
        hit = self._job_types.get(aid)
        if hit and not force and time.monotonic() - hit[0] < JOB_TYPES_TTL_S:
            return hit[1]
        data = await self.api(aid, "GET", "/job_types")
        items = data if isinstance(data, list) else (
            (data.get("items") or data.get("job_types") or data.get("data") or []) if isinstance(data, dict) else [])
        rows = []
        for r in items:
            if not isinstance(r, dict):
                continue
            jt = r.get("job_type") or r.get("id") or r.get("name")
            if isinstance(jt, str) and jt:
                rows.append({"job_type": jt, "display_name": str(r.get("display_name") or jt),
                             "type": (str(r.get("type") or "").lower() or None)})
        rows.sort(key=lambda r: (r["type"] or "~", r["display_name"].lower()))
        self._job_types[aid] = (time.monotonic(), rows)
        return rows

    async def quote(self, aid: str, job_type: str, params: dict[str, Any]) -> dict[str, Any]:
        """What a job would cost (POST /jobs/{jt}/cost): spends nothing."""
        if not job_type or not all(c.isalnum() or c in "_-." for c in job_type):
            raise HiggsfieldError("invalid_params", "job type")
        data = await self.api(aid, "POST", f"/jobs/{job_type}/cost", body={"params": params or {}})
        credits = None
        if isinstance(data, dict):
            for key in ("credits", "cost", "total_credits"):
                v = data.get(key)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    credits = v
                    break
        if credits is None:
            raise HiggsfieldError("bad_json", "cost without credits")
        return {"job_type": job_type, "credits": credits}
