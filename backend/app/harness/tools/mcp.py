"""MCP servers as tools: the chat's MCP connections, the SSH bridge of a remote workspace, screen sharing, a Mate's own
tools — every server the CLIs get in their ``--mcp-config`` the harness connects to itself.

A server's tools are named ``mcp__<server>__<tool>`` like Claude Code's, so the chat's cards, the remote-workspace guide
(``remote_bash``…) and a Mate's allow-list read the same. Connections stay open between turns and are redone only when
the configuration changes (``McpHub.sync``). Each connection is entered and left by its own task (the SDK's AnyIO
transports insist on it, see ``mcp_runtime/client.py``).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
from contextlib import AsyncExitStack
from datetime import timedelta
from typing import Any

from app.harness.tools.base import Tool, ToolContext, ToolOutput, truncate_middle

CONNECT_S = 40
DEFAULT_CALL_S = 900
MAX_OUTPUT = 60_000


def norm(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)


def load_config(mcp_config: dict | None, mcp_config_file: str | None) -> dict[str, dict]:
    """The servers of a turn's MCP configuration (the file wins: it is the whole merged config)."""
    cfg = mcp_config or {}
    if mcp_config_file and os.path.isfile(mcp_config_file):
        with contextlib.suppress(OSError, ValueError):
            with open(mcp_config_file, encoding="utf-8") as fh:
                cfg = json.load(fh)
    servers = cfg.get("mcpServers") if isinstance(cfg, dict) else None
    return {str(k): v for k, v in (servers or {}).items() if isinstance(v, dict)}


class Conn:
    def __init__(self, name: str, spec: dict, log_dir: str) -> None:
        self.name, self.spec = name, spec
        self.log_path = os.path.join(log_dir, f"mcp-{norm(name)}.log")
        self.ready: asyncio.Future = asyncio.get_running_loop().create_future()
        self.closing = asyncio.Event()
        self.session: Any = None
        self.tools: list[dict] = []
        self.error = ""
        self.slots = asyncio.Semaphore(8)
        self.task = asyncio.create_task(self._run(), name=f"harness-mcp:{name}")

    @property
    def timeout_s(self) -> float:
        t = self.spec.get("timeout")
        try:
            return max(30.0, float(t) / 1000) if t else DEFAULT_CALL_S
        except (TypeError, ValueError):
            return DEFAULT_CALL_S

    async def _run(self) -> None:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        try:
            async with AsyncExitStack() as stack:
                kind = self.spec.get("type") or ("stdio" if self.spec.get("command") else "http")
                if kind == "stdio":
                    from app.portability import child_command

                    errlog = stack.enter_context(open(self.log_path, "a", encoding="utf-8"))  # noqa: SIM115
                    argv = child_command(str(self.spec["command"]), [str(a) for a in self.spec.get("args") or []])
                    env = {str(k): str(v) for k, v in (self.spec.get("env") or {}).items()}
                    streams = await stack.enter_async_context(stdio_client(
                        StdioServerParameters(command=argv[0], args=argv[1:], env=env or None,
                                              cwd=self.spec.get("cwd") or None), errlog=errlog))
                elif kind in ("http", "streamable-http", "streamable_http"):
                    import httpx
                    from mcp.client.streamable_http import streamable_http_client

                    http = await stack.enter_async_context(httpx.AsyncClient(
                        headers=self.spec.get("headers") or {}, timeout=httpx.Timeout(self.timeout_s, read=None)))
                    streams = await stack.enter_async_context(streamable_http_client(self.spec["url"], http_client=http))
                else:
                    from mcp.client.sse import sse_client

                    streams = await stack.enter_async_context(sse_client(
                        self.spec["url"], headers=self.spec.get("headers") or {}, sse_read_timeout=self.timeout_s))
                self.session = await stack.enter_async_context(ClientSession(
                    streams[0], streams[1], read_timeout_seconds=timedelta(seconds=self.timeout_s)))
                init = await asyncio.wait_for(self.session.initialize(), CONNECT_S)
                if init.capabilities.tools:
                    cursor = None
                    for _ in range(50):
                        page = await self.session.list_tools(cursor=cursor)
                        self.tools.extend(t.model_dump(mode="json", by_alias=True, exclude_none=True) for t in page.tools)
                        cursor = page.nextCursor
                        if not cursor:
                            break
                if not self.ready.done():
                    self.ready.set_result(True)
                await self.closing.wait()
        except BaseException as exc:
            self.error = _message(exc) or "the server didn't start"
            if not self.ready.done():
                self.ready.set_result(False)
            if isinstance(exc, asyncio.CancelledError):
                raise

    async def call(self, tool: str, args: dict[str, Any]) -> Any:
        if self.session is None:
            raise RuntimeError(self.error or "not connected")
        async with self.slots:
            return await self.session.call_tool(tool, args, read_timeout_seconds=timedelta(seconds=self.timeout_s))

    async def close(self) -> None:
        self.closing.set()
        try:
            await asyncio.wait_for(asyncio.shield(self.task), 10)
        except (TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
            self.task.cancel()
            with contextlib.suppress(BaseException):
                await self.task


def _message(exc: BaseException) -> str:
    if isinstance(exc, BaseExceptionGroup):
        return " | ".join(_message(e) for e in exc.exceptions[:3])
    return f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__


class McpHub:
    def __init__(self, log_dir: str) -> None:
        self.log_dir = log_dir
        self.conns: dict[str, Conn] = {}
        self._specs: dict[str, str] = {}

    async def sync(self, servers: dict[str, dict]) -> list[dict[str, str]]:
        """Connect to these servers (keeping the ones whose configuration didn't change). → their status"""
        for name in list(self.conns):
            if name not in servers or self._specs.get(name) != json.dumps(servers[name], sort_keys=True):
                await self.conns.pop(name).close()
                self._specs.pop(name, None)
        for name, spec in servers.items():
            if name not in self.conns:
                self.conns[name] = Conn(name, spec, self.log_dir)
                self._specs[name] = json.dumps(spec, sort_keys=True)
        await asyncio.gather(*(asyncio.wait_for(asyncio.shield(c.ready), CONNECT_S + 5) for c in self.conns.values()),
                             return_exceptions=True)
        return [{"name": n, "status": "connected" if c.session is not None and not c.error else "failed",
                 **({"error": c.error[:300]} if c.error else {})} for n, c in self.conns.items()]

    def tools(self) -> list[McpTool]:
        out = []
        for name, c in self.conns.items():
            if c.session is None or c.error:
                continue
            for t in c.tools:
                out.append(McpTool(c, t))
        return out

    async def close(self) -> None:
        for c in list(self.conns.values()):
            await c.close()
        self.conns.clear()
        self._specs.clear()


class McpTool(Tool):
    def __init__(self, conn: Conn, spec: dict[str, Any]) -> None:
        self.conn = conn
        self.tool = spec["name"]
        self.name = f"mcp__{norm(conn.name)}__{norm(spec['name'])}"
        self.description = (spec.get("description") or spec.get("title") or spec["name"])[:4000]
        schema = spec.get("inputSchema") or {}
        if schema.get("type") != "object":
            schema = {"type": "object", "properties": {}}
        self.schema = schema
        hints = spec.get("annotations") or {}
        self.read_only = bool(hints.get("readOnlyHint"))
        self.parallel = self.read_only

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        try:
            result = await self.conn.call(self.tool, args)
        except Exception as exc:  # noqa: BLE001
            return ToolOutput.error(f"MCP {self.conn.name}/{self.tool} failed: {_message(exc)}")
        texts: list[str] = []
        images: list[dict[str, str]] = []
        for c in result.content or []:
            t = getattr(c, "type", "")
            if t == "text":
                texts.append(c.text)
            elif t == "image":
                images.append({"media_type": c.mimeType, "data": c.data})
            elif t == "resource":
                res = c.resource
                texts.append(getattr(res, "text", None) or f"[resource {getattr(res, 'uri', '')}]")
            elif t == "resource_link":
                texts.append(f"[{getattr(c, 'name', '') or 'resource'}]({getattr(c, 'uri', '')})")
        if not texts and getattr(result, "structuredContent", None):
            texts.append(json.dumps(result.structuredContent, ensure_ascii=False))
        text = truncate_middle("\n".join(texts), MAX_OUTPUT)
        return ToolOutput(text, is_error=bool(getattr(result, "isError", False)), images=images)
