"""Test a draft without saving it; register only the exact, still-live tested draft."""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
import uuid

from app.mcp_runtime.catalog import definition, recipe
from app.mcp_runtime.client import Connection

TEST_TTL = 300


def previous_values(spec):
    """Recognize the old Docker recipe without exposing any credential values."""
    env = dict(spec.get("env", {}))
    args = spec.get("args", [])
    for i, arg in enumerate(args):
        if i and args[i - 1] in ("-e", "--env") and "=" in arg:
            k, v = arg.split("=", 1)
            if k in {
                "JIRA_URL",
                "JIRA_USERNAME",
                "JIRA_API_TOKEN",
                "JIRA_PERSONAL_TOKEN",
                "CONFLUENCE_URL",
                "CONFLUENCE_USERNAME",
                "CONFLUENCE_API_TOKEN",
                "CONFLUENCE_PERSONAL_TOKEN",
            }:
                env[k] = v
    out = {
        "service": "both"
        if env.get("JIRA_URL") and env.get("CONFLUENCE_URL")
        else "confluence"
        if env.get("CONFLUENCE_URL")
        else "jira",
        "deployment": "server"
        if env.get("JIRA_PERSONAL_TOKEN") or env.get("CONFLUENCE_PERSONAL_TOKEN")
        else "cloud",
        "read_only": env.get("READ_ONLY_MODE", "true").lower() == "true",
    }
    token = next((x for x in args if x.startswith("ATATT") and len(x) > 30 and "\n" not in x), "")
    for service in ("jira", "confluence"):
        out[service + "_url"] = env.get(service.upper() + "_URL", "")
        out[service + "_email"] = env.get(service.upper() + "_USERNAME", "")
        out[service + "_token"] = (
            env.get(service.upper() + "_API_TOKEN")
            or env.get(service.upper() + "_PERSONAL_TOKEN")
            or token
        )
    return out


class SetupTests:
    def __init__(self, service):
        self.service = service
        self.pending, self.expiry = {}, {}
        self.active = 0

    def _revision(self, mid):
        return hashlib.sha256(
            json.dumps(self.service.store.get(mid), sort_keys=True).encode()
        ).hexdigest()

    def defaults(self, rid, mid=None):
        r = recipe(rid)
        values = {f["key"]: f["default"] for f in r["fields"]}
        saved = []
        if mid:
            old = self._previous(rid, mid)
            for f in r["fields"]:
                if f["kind"] == "password" and old.get(f["key"]):
                    saved.append(f["key"])
                elif f["key"] in old:
                    values[f["key"]] = old[f["key"]]
        return {"values": values, "saved_fields": saved}

    def _previous(self, rid, mid):
        spec = self.service.store.get(mid)
        if rid == "atlassian":
            return previous_values(spec)
        return {}

    async def catalog_test(self, rid, values, name="", mid=None):
        # Keeping a saved password never returns it to a renderer.
        if mid:
            previous = self._previous(rid, mid)
            values = dict(values)
            for f in recipe(rid)["fields"]:
                if f["kind"] == "password" and not values.get(f["key"]):
                    values[f["key"]] = previous.get(f["key"], "")
        spec = definition(
            rid, values, name=name, data_dir=self.service.installations.root / "data" / rid
        )
        return await self.test(spec, mid)

    async def test(self, patch, mid=None):
        if self.active + len(self.pending) >= 4:
            raise ValueError("mcp_test_limit")
        self.active += 1
        connection = None
        try:
            # A recipe is a complete replacement, not a merge of old Docker flags/credentials.
            spec = self.service.store.prepare(patch, mid if not patch.get("catalog_id") else None)
            spec["enabled"] = True
            self.service._remember(spec)
            revision = self._revision(mid) if mid else None
            self.service.log(mid, "info", "test_started")
            connection = Connection(
                {"id": "test-" + uuid.uuid4().hex, **spec},
                lambda *a: None,
                prepare=self.service.installations.materialize,
            )
            await asyncio.shield(connection.ready)
            if connection.state != "connected":
                error, code = self.service.redact(connection.error), connection.error_code
                await connection.close()
                self.service.log(mid, "error", "test_failed", code)
                return {"ok": False, "error": error, "error_code": code, "tool_count": 0}
            token = secrets.token_urlsafe(32)
            self.pending[token] = {
                "spec": spec,
                "connection": connection,
                "mid": mid,
                "revision": revision,
                "expires": time.monotonic() + TEST_TTL,
            }
            self.expiry[token] = asyncio.create_task(self._expire(token))
            self.service.log(mid, "info", "test_succeeded", tool_count=len(connection.tools))
            return {
                "ok": True,
                "test_id": token,
                "expires_in": TEST_TTL,
                "tool_count": len(connection.tools),
                "tools": [{"name": t["name"]} for t in connection.tools[:8]],
                "server_info": connection.server_info,
                "protocol": connection.protocol,
            }
        except BaseException:
            if connection:
                await connection.close()
            raise
        finally:
            self.active -= 1

    async def _expire(self, token):
        try:
            await asyncio.sleep(TEST_TTL)
            value = self.pending.pop(token, None)
            if value:
                await value["connection"].close()
        finally:
            self.expiry.pop(token, None)

    async def discard(self, token):
        value = self.pending.pop(token, None)
        timer = self.expiry.pop(token, None)
        if timer:
            timer.cancel()
        if value:
            await value["connection"].close()
        return {"ok": True}

    async def register(self, token):
        value = self.pending.get(token)
        if not value or value["expires"] <= time.monotonic():
            raise ValueError("mcp_test_expired")
        mid, connection = value["mid"], value["connection"]
        if connection.state != "connected" or connection.task.done():
            await self.discard(token)
            raise ValueError("mcp_test_disconnected")
        if mid and self._revision(mid) != value["revision"]:
            await self.discard(token)
            raise ValueError("mcp_config_changed")
        if not mid and len(self.service.store.ids()) >= 100:
            raise ValueError("catalog_full")
        self.pending.pop(token)
        timer = self.expiry.pop(token, None)
        if timer:
            timer.cancel()
        created = not mid
        mid = mid or uuid.uuid4().hex
        async with self.service.locks.setdefault(mid, asyncio.Lock()):
            # Recheck after acquiring the same lock used by reconnect/delete.
            try:
                if not created and self._revision(mid) != value["revision"]:
                    raise ValueError("mcp_config_changed")
                self.service.revoke(mid=mid)
                old = self.service.clients.pop(mid, None)
                if old:
                    await old.close()
                self.service.store.save(mid, value["spec"], create=created)
                connection.spec["id"] = mid
                connection.event = lambda event, text: self.service._event(mid, event, text)
                self.service.clients[mid] = connection
                self.service.log(mid, "info", "registered", tool_count=len(connection.tools))
                self.service.changed()
                return self.service.entry(mid)
            except BaseException:
                await connection.close()
                raise

    async def stop(self):
        for token in list(self.pending):
            await self.discard(token)
