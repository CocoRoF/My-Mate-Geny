from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from app.config import settings
from app.mcp_runtime.client import Connection
from app.mcp_runtime.installations import Installations
from app.mcp_runtime.secret_args import values as secret_arguments
from app.mcp_runtime.setup import SetupTests
from app.mcp_runtime.store import McpStore

METHODS = {
    "tools/list",
    "tools/call",
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "prompts/list",
    "prompts/get",
}
BRIDGE = str(Path(__file__).with_name("bridge.py"))


class _SafeSdkLog(logging.Handler):
    """SDK parse errors can contain raw server output. Never forward their traceback."""

    def __init__(self, service):
        super().__init__(logging.WARNING)
        self.service = service

    def emit(self, record):
        try:
            # A malformed protocol message may include arguments or results.
            # Diagnostic stderr is separately opt-in; the default log stays metadata-only.
            self.service.log(None, "warning", "sdk", f"{record.name}: {record.levelname}")
        except Exception:
            pass


class McpService:
    def __init__(self, db, vault, sessions, logs):
        self.store = McpStore(db, vault)
        self.sessions, self.logs = sessions, logs
        self.clients: dict[str, Connection] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.stats: dict[str, dict] = {}
        self.secret_values: set[str] = set()
        for mid in self.store.ids():
            try:
                self._remember(self.store.get(mid))
            except Exception:
                pass
        self.tokens: dict[tuple[str, str], str] = {}
        self.inflight: dict[tuple[str, str], set[asyncio.Task]] = {}
        self.requests: dict[tuple[str, str, str], asyncio.Task] = {}
        self.directory = tempfile.TemporaryDirectory(prefix="geny-mcp-")
        self.startup = None
        self.closed = False
        self.installations = Installations(self.changed, self.log)
        self.setup = SetupTests(self)
        self.logger = logging.getLogger("mcp")
        self.previous_propagate = self.logger.propagate
        self.log_handler = _SafeSdkLog(self)
        self.logger.addHandler(self.log_handler)
        self.logger.propagate = False

    def changed(self):
        if not self.closed:
            self.sessions.broadcast_list({"type": "mcp.changed", "data": {}})

    def _remember(self, spec):
        self.secret_values.update(v for v in secret_arguments(spec["args"]) if v)
        self.secret_values.update(
            v for v in [*spec["env"].values(), *spec["headers"].values()] if v
        )
        self.secret_values.update(
            v
            for k, v in parse_qsl(urlsplit(spec["url"]).query)
            if v and any(word in k.lower() for word in ("key", "token", "auth", "secret"))
        )

    def redact(self, text: str) -> str:
        text = str(text)
        for value in sorted(self.secret_values, key=len, reverse=True):
            text = text.replace(value, "[redacted]")
        # Common credential formats in server errors, even when not configured as an env/header.
        import re

        return re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[redacted]", text)[:4000]

    def log(self, mid, level, event, message="", *, sid=None, **detail):
        if mid:
            row = self.store.db.query_one("SELECT name FROM mcp_catalog WHERE id = ?", (mid,))
            if row:
                detail["mcp_name"] = row["name"]
        self.logs.record(
            level,
            "mcp",
            self.redact(message or event),
            code="mcp." + event,
            session_id=sid,
            detail={
                "mcp_id": mid,
                **{k: self.redact(v) if isinstance(v, str) else v for k, v in detail.items()},
            },
        )

    def _event(self, mid, event, text):
        stats = self.stats.setdefault(mid, {})
        if event == "error":
            stats["errors"] = stats.get("errors", 0) + 1
        if event == "stderr":
            client = self.clients.get(mid)
            if client is None or not client.spec.get("log_stderr"):
                return
            now = time.monotonic()
            # A verbose server cannot flood the DB or the browser.
            if now - stats.get("stderr_since", 0) > 60:
                stats.update(stderr_since=now, stderr_rows=0)
            stats["stderr_rows"] = stats.get("stderr_rows", 0) + 1
            if stats["stderr_rows"] <= 30:
                self.log(mid, "info", "stderr", text)
            else:
                stats["stderr_dropped"] = stats.get("stderr_dropped", 0) + 1
        else:
            client = self.clients.get(mid)
            info = (
                {
                    "transport": client.spec["transport"],
                    "protocol": client.protocol,
                    "server_info": client.server_info,
                    "tool_count": len(client.tools),
                }
                if client
                else {}
            )
            self.log(mid, "error" if event == "error" else "info", event, text, **info)
            self.changed()

    async def start(self):
        async def restore():
            for mid in self.store.ids():
                try:
                    spec = self.store.get(mid)
                    # Adopt the stable runner used to repair the previous Docker-only entry.
                    # Only an exact app-owned launch signature is migrated.
                    if not spec["catalog_id"] and spec["command"] == sys.executable:
                        candidate = {
                            **spec,
                            "catalog_id": "atlassian",
                            "command": "geny-managed",
                            "args": [],
                        }
                        if self.installations.manifest("atlassian"):
                            launch = self.installations.materialize(candidate)
                            if spec["args"] == launch["args"]:
                                spec = self.store.save(
                                    mid,
                                    {
                                        "catalog_id": "atlassian",
                                        "command": "geny-managed",
                                        "args": [],
                                    },
                                )
                                self.log(mid, "info", "managed_migrated")
                    if spec["enabled"]:
                        await self.connect(mid)
                except Exception as exc:
                    self.log(mid, "error", "restore_failed", type(exc).__name__)

        self.startup = asyncio.create_task(restore())

    async def connect(self, mid, *, force=False):
        async with self.locks.setdefault(mid, asyncio.Lock()):
            spec = self.store.get(mid)
            old = self.clients.get(mid)
            if old is not None and not force and old.state == "connected" and not old.task.done():
                return self.entry(mid)
            if old is not None:
                await old.close()
            if not spec["enabled"] or self.closed:
                self.clients.pop(mid, None)
                self.changed()
                return self.entry(mid)
            client = Connection(
                spec,
                lambda event, text: self._event(mid, event, text),
                prepare=self.installations.materialize,
            )
            self.clients[mid] = client
            self.changed()
            await asyncio.shield(client.ready)
            return self.entry(mid)

    def entry(self, mid):
        spec = self.store.public(self.store.get(mid))
        client = self.clients.get(mid)
        state = client.state if client else "disconnected"
        if not spec["enabled"]:
            state = "disabled"
        stats = self.stats.get(mid, {})
        return {
            **spec,
            "state": state,
            "error": self.redact(client.error) if client else "",
            "error_code": client.error_code if client else "",
            "repair_recipe": "atlassian"
            if spec["command"] in ("docker", "docker.exe")
            and any(
                isinstance(a, str) and a.startswith("ghcr.io/sooperset/mcp-atlassian")
                for a in spec["args"]
            )
            else None,
            "connected_at": client.connected_at if client else None,
            "tool_count": len(client.tools) if client else 0,
            "tools": [
                {"name": t["name"], "description": (t.get("description") or "")[:240]}
                for t in (client.tools[:8] if client else [])
            ],
            "capabilities": client.capabilities if client else {},
            "server_info": client.server_info if client else {},
            "protocol": client.protocol if client else "",
            "metrics": {
                k: stats.get(k, 0)
                for k in ("calls", "errors", "cancelled", "last_ms", "stderr_dropped")
            },
            "execution_mode": settings.execution_mode,
        }

    def catalog(self):
        items = []
        for mid in self.store.ids():
            try:
                items.append(self.entry(mid))
            except Exception:
                # Preserve a damaged definition; never run it or silently overwrite its credentials.
                items.append(
                    {
                        "id": mid,
                        "name": mid,
                        "state": "error",
                        "error": "stored_config_unreadable",
                        "enabled": False,
                        "tools": [],
                        "metrics": {},
                        "execution_mode": settings.execution_mode,
                    }
                )
        return {"items": items, "execution_mode": settings.execution_mode}

    def tool_page(self, mid, offset, limit):
        self.store.get(mid)
        client = self.clients.get(mid)
        tools = client.tools if client else []
        return {
            "items": [
                {"name": tool["name"], "description": (tool.get("description") or "")[:2000]}
                for tool in tools[offset : offset + limit]
            ],
            "total": len(tools),
            "has_more": offset + limit < len(tools),
            "offset": offset,
        }

    async def save(self, patch: dict, mid=None):
        create = mid is None
        if create and len(self.store.ids()) >= 100:
            raise ValueError("catalog_full")
        mid = mid or uuid.uuid4().hex
        self._remember(self.store.save(mid, patch, create=create))
        self.revoke(mid=mid)
        self.log(mid, "info", "created" if create else "updated")
        return await self.connect(mid, force=True)

    async def delete(self, mid):
        async with self.locks.setdefault(mid, asyncio.Lock()):
            self.revoke(mid=mid)
            client = self.clients.pop(mid, None)
            if client:
                await client.close()
            self.store.delete(mid)
            self.log(mid, "info", "deleted")
            self.changed()

    def selection(self, patch):
        if not isinstance(patch, dict) or len(patch) > 100:
            raise ValueError("invalid_mcp_selection")
        for mid, enabled in patch.items():
            if not isinstance(enabled, bool):
                raise ValueError("mcp_selection_must_be_boolean")
            try:
                self.store.get(mid)
            except KeyError:
                raise ValueError("mcp_not_found") from None

    def selected(self, sid, mid):
        try:
            return (
                self.store.get(mid)["enabled"]
                and self.sessions.get(sid).get("mcp", {}).get(mid) is True
            )
        except (KeyError, ValueError):
            return False

    def revoke(self, *, sid=None, mid=None):
        for key in list(self.tokens):
            if (sid is None or key[0] == sid) and (mid is None or key[1] == mid):
                del self.tokens[key]
                self._token_path(*key).unlink(missing_ok=True)
        for key, tasks in list(self.inflight.items()):
            if (sid is None or key[0] == sid) and (mid is None or key[1] == mid):
                for task in list(tasks):
                    task.cancel()

    def token_info(self, token):
        if not token:
            return None
        return next(
            (key for key, value in self.tokens.items() if secrets.compare_digest(token, value)),
            None,
        )

    def _token_path(self, sid, mid):
        return Path(self.directory.name) / (
            hashlib.sha256((sid + ":" + mid).encode()).hexdigest() + ".token"
        )

    def configure(self, sid, req):
        selection = self.sessions.get(sid).get("mcp", {})
        if not self.store.ids() and not selection:
            return
        config = req.mcp_config or {"mcpServers": {}}
        for mid, enabled in selection.items():
            if not enabled or not self.selected(sid, mid):
                continue
            token = self.tokens.setdefault((sid, mid), secrets.token_urlsafe(32))
            token_path = self._token_path(sid, mid)
            fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as out:
                out.write(token)
            config.setdefault("mcpServers", {})["geny_" + mid] = {
                "command": sys.executable,
                "args": ["-I", BRIDGE],
                "timeout": (self.store.get(mid)["timeout_s"] + 10) * 1000,
                "env": {
                    "GENY_MCP_REVISION": self.store.get(mid)["updated_at"],
                    "GENY_MCP_API": f"http://127.0.0.1:{settings.port}",
                    "GENY_MCP_TOKEN_FILE": str(token_path),
                },
            }
            env = getattr(req, "extra_env", None) or {}
            try:
                previous = int(env.get("MCP_TIMEOUT", os.environ.get("MCP_TIMEOUT", "0")))
            except ValueError:
                previous = 0
            req.extra_env = {**env, "MCP_TIMEOUT": str(max(35000, previous))}
        req.mcp_config = config
        path = Path(self.directory.name) / (hashlib.sha256(sid.encode()).hexdigest() + ".json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(config, out, ensure_ascii=False)
        req.mcp_config_file = str(path)

    def cancel_request(self, sid, mid, request_id):
        task = self.requests.get((sid, mid, request_id))
        if task is None or task.done():
            return False
        task.cancel()
        return True

    async def request(self, sid, mid, method, params, request_id=None):
        if not self.selected(sid, mid):
            raise PermissionError("mcp_disabled_for_session")
        client = self.clients.get(mid)
        if client is None or client.state != "connected" or client.task.done():
            await self.connect(mid)
            client = self.clients.get(mid)
        if client is None or client.state != "connected":
            raise RuntimeError("mcp_not_connected")
        if method == "bridge/info":
            return {"name": self.store.get(mid)["name"], "capabilities": client.capabilities}
        if method not in METHODS:
            raise ValueError("unsupported_method")
        if method == "tools/call" and params.get("name") not in {t["name"] for t in client.tools}:
            raise ValueError("unknown_tool")
        key = (sid, mid)
        request_id = request_id or uuid.uuid4().hex
        request_key = (sid, mid, request_id)
        if request_key in self.requests:
            raise ValueError("duplicate_request_id")
        task = asyncio.create_task(client.request(method, params))
        self.inflight.setdefault(key, set()).add(task)
        self.requests[request_key] = task
        start = time.monotonic()
        stats = self.stats.setdefault(mid, {})
        stats["calls"] = stats.get("calls", 0) + 1
        name = str(params.get("name") or method)[:200]
        self.log(
            mid, "info", "call_started", sid=sid, method=method, tool=name, request_id=request_id
        )
        try:
            result = await task
            if not self.selected(sid, mid):
                raise PermissionError("mcp_disabled_for_session")
            failed = result.get("isError") is True
            stats["last_ms"] = round((time.monotonic() - start) * 1000, 1)
            stats["errors"] = stats.get("errors", 0) + int(failed)
            self.log(
                mid,
                "warning" if failed else "info",
                "call_failed" if failed else "call_completed",
                sid=sid,
                method=method,
                tool=name,
                request_id=request_id,
                duration_ms=stats["last_ms"],
            )
            return result
        except BaseException as exc:
            cancelled = isinstance(exc, (asyncio.CancelledError, PermissionError))
            counter = "cancelled" if cancelled else "errors"
            stats[counter] = stats.get(counter, 0) + 1
            stats["last_ms"] = round((time.monotonic() - start) * 1000, 1)
            self.log(
                mid,
                "info" if cancelled else "warning",
                "call_cancelled" if cancelled else "call_failed",
                type(exc).__name__,
                sid=sid,
                method=method,
                tool=name,
                request_id=request_id,
                duration_ms=stats["last_ms"],
            )
            raise
        finally:
            self.inflight[key].discard(task)
            self.requests.pop(request_key, None)

    async def stop(self):
        self.closed = True
        await self.setup.stop()
        await self.installations.stop()
        self.revoke()
        if self.startup:
            self.startup.cancel()
            await asyncio.gather(self.startup, return_exceptions=True)
        await asyncio.gather(*(c.close() for c in self.clients.values()), return_exceptions=True)
        self.logger.removeHandler(self.log_handler)
        self.logger.propagate = self.previous_propagate
        self.directory.cleanup()
