"""An SDK transport is entered and exited by the same task (AnyIO invariant).

Calls are multiplexed by ClientSession, with bounded concurrency and explicit
shutdown. The SDK closes stdin, then terminates the stdio process tree.
"""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import AsyncExitStack
from datetime import timedelta

import anyio
import httpx
from mcp import ClientSession, McpError, StdioServerParameters, types
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

from app.mcp_runtime.diagnostics import ConnectionIssue, launch_environment, preflight
from app.portability import child_command

HEALTH_INTERVAL = 10


class CancellableSession(ClientSession):
    """SDK v1 drops a canceled response waiter without notifying the peer.

    Match the SDK's synchronously allocated request ID before its first await,
    then explicitly forward protocol cancellation, including deadline expiry.
    Keep this adapter covered by real-server tests when upgrading the SDK.
    """

    async def send_request(self, request, result_type, **kwargs):
        request_id = self._request_id
        try:
            return await super().send_request(request, result_type, **kwargs)
        except BaseException as exc:
            if isinstance(exc, (asyncio.CancelledError, TimeoutError)) or (
                isinstance(exc, McpError) and exc.error.code == 408
            ):
                with anyio.move_on_after(2, shield=True):
                    try:
                        await self.send_notification(
                            types.ClientNotification(
                                types.CancelledNotification(
                                    params=types.CancelledNotificationParams(requestId=request_id)
                                )
                            )
                        )
                    except Exception:
                        pass
            raise


def exception_message(exc):
    if isinstance(exc, BaseExceptionGroup):
        return " | ".join(exception_message(e) for e in exc.exceptions[:5])
    return type(exc).__name__ + ": " + str(exc)


class Connection:
    def __init__(self, spec: dict, event, prepare=None):
        self.spec, self.event = spec, event
        self.prepare = prepare
        self.ready = asyncio.get_running_loop().create_future()
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=128)
        self.calls: set[asyncio.Task] = set()
        self.slots = asyncio.Semaphore(8)
        self.tools: list[dict] = []
        self.capabilities: dict = {}
        self.server_info: dict = {}
        self.protocol = ""
        self.state, self.error, self.connected_at = "connecting", "", None
        self.error_code = ""
        self.docker_unavailable = False
        self.task = asyncio.create_task(self._run(), name="mcp:" + spec["id"])

    async def _run(self):
        try:
            async with AsyncExitStack() as stack:
                spec = self.spec
                if self.prepare:
                    spec = self.prepare(spec)
                    self.spec = spec
                spec = {
                    **spec,
                    "command": os.path.expanduser(spec["command"]),
                    "cwd": os.path.expanduser(spec["cwd"]),
                }
                self.spec = spec
                preflight(spec)
                if spec["transport"] == "stdio":
                    # Capture stderr through a pipe: never forward raw provider output to Python logging.
                    read_fd, write_fd = os.pipe()
                    output = os.fdopen(write_fd, "w", encoding="utf-8", buffering=1)

                    async def stderr():
                        while True:
                            # Windows anonymous pipes do not support connect_read_pipe.
                            chunk = await asyncio.to_thread(os.read, read_fd, 4096)
                            if not chunk:
                                return
                            lower = chunk.lower()
                            if any(
                                s in lower
                                for s in (
                                    b"cannot connect to the docker daemon",
                                    b"is the docker daemon running",
                                    b"docker.sock: connect: permission denied",
                                )
                            ):
                                self.docker_unavailable = True
                            self.event("stderr", chunk.decode("utf-8", "replace"))

                    tail = asyncio.create_task(stderr())
                    stack.callback(os.close, read_fd)

                    async def stop_tail():
                        try:
                            await asyncio.wait_for(tail, 2)
                        except TimeoutError:
                            tail.cancel()
                            await asyncio.gather(tail, return_exceptions=True)

                    stack.push_async_callback(stop_tail)
                    stack.callback(output.close)
                    env = launch_environment(spec)
                    import shutil

                    command = shutil.which(spec["command"], path=env.get("PATH")) or spec["command"]
                    argv = child_command(command, spec["args"])
                    streams = await stack.enter_async_context(
                        stdio_client(
                            StdioServerParameters(
                                command=argv[0], args=argv[1:], cwd=spec["cwd"] or None, env=env
                            ),
                            errlog=output,
                        )
                    )
                    output.close()  # child has its own descriptor; EOF now follows child shutdown
                elif spec["transport"] == "http":
                    http = await stack.enter_async_context(
                        httpx.AsyncClient(
                            headers=spec["headers"],
                            timeout=httpx.Timeout(spec["timeout_s"], read=None),
                            follow_redirects=False,
                        )
                    )
                    streams = await stack.enter_async_context(
                        streamable_http_client(spec["url"], http_client=http)
                    )
                else:
                    streams = await stack.enter_async_context(
                        sse_client(
                            spec["url"],
                            headers=spec["headers"],
                            timeout=30,
                            sse_read_timeout=spec["timeout_s"],
                        )
                    )
                self.session = await stack.enter_async_context(
                    CancellableSession(
                        streams[0],
                        streams[1],
                        read_timeout_seconds=timedelta(seconds=spec["timeout_s"]),
                    )
                )
                with anyio.fail_after(30):
                    init = await self.session.initialize()
                    self.server_info = init.serverInfo.model_dump(
                        mode="json", by_alias=True, exclude_none=True
                    )
                    self.protocol = init.protocolVersion
                    self.capabilities = init.capabilities.model_dump(
                        mode="json", by_alias=True, exclude_none=True
                    )
                    if init.capabilities.tools:
                        cursor = None
                        for _ in range(100):
                            page = await self.session.list_tools(cursor=cursor)
                            self.tools.extend(
                                t.model_dump(mode="json", by_alias=True, exclude_none=True)
                                for t in page.tools
                            )
                            if len(self.tools) > 2000:
                                raise RuntimeError("too_many_tools")
                            cursor = page.nextCursor
                            if not cursor:
                                break
                        else:
                            raise RuntimeError("too_many_tool_pages")
                self.state, self.connected_at = "connected", time.time()
                self.ready.set_result(True)
                self.event("connected", "")
                try:
                    while True:
                        try:
                            method, params, result = await asyncio.wait_for(
                                self.queue.get(), HEALTH_INTERVAL
                            )
                        except TimeoutError:
                            # Idle transports must notice a dead child or lost HTTP connection.
                            # Avoid pinging a serial server while it runs a long tool call.
                            if not self.calls:
                                with anyio.fail_after(5):
                                    await self.session.send_ping()
                            continue
                        if method == "_stop":
                            break
                        task = asyncio.create_task(self._perform(method, params, result))
                        self.calls.add(task)
                        task.add_done_callback(self.calls.discard)
                        result.add_done_callback(
                            lambda f, task=task: task.cancel() if f.cancelled() else None
                        )
                finally:
                    for task in list(self.calls):
                        task.cancel()
                    await asyncio.gather(*self.calls, return_exceptions=True)
        except asyncio.CancelledError:
            pass
        except BaseException as exc:
            # SDK exception groups may contain a server's raw message: callers/logs redact it.
            self.error = exception_message(exc)[:4000]
            if isinstance(exc, ConnectionIssue):
                self.error_code = exc.code
            else:
                detail = self.error.lower()
                self.error_code = (
                    "authentication_failed"
                    if any(x in detail for x in ("401", "403", "unauthorized", "forbidden"))
                    else "connection_timeout"
                    if "timeout" in detail or "timed out" in detail
                    else "connection_failed"
                )
                if self.docker_unavailable:
                    self.error_code = "docker_unavailable"
            self.state = "error"
            self.event("error", self.error)
        finally:
            if not self.ready.done():
                self.ready.set_result(False)
            if self.state != "error":
                self.state = "disconnected"
                self.event("disconnected", "")
            while not self.queue.empty():
                _, _, future = self.queue.get_nowait()
                if future is not None and not future.done():
                    future.set_exception(RuntimeError("mcp_disconnected"))

    async def _perform(self, method, params, future):
        try:
            async with self.slots:
                if future.done():
                    return
                functions = {
                    "tools/list": lambda: self.session.list_tools(cursor=params.get("cursor")),
                    "tools/call": lambda: self.session.call_tool(
                        params["name"], params.get("arguments") or {}
                    ),
                    "resources/list": lambda: self.session.list_resources(
                        cursor=params.get("cursor")
                    ),
                    "resources/templates/list": lambda: self.session.list_resource_templates(
                        cursor=params.get("cursor")
                    ),
                    "resources/read": lambda: self.session.read_resource(params["uri"]),
                    "prompts/list": lambda: self.session.list_prompts(cursor=params.get("cursor")),
                    "prompts/get": lambda: self.session.get_prompt(
                        params["name"], params.get("arguments")
                    ),
                }
                if method not in functions:
                    raise ValueError("unsupported_method")
                result = await functions[method]()
                if not future.done():
                    future.set_result(
                        result.model_dump(mode="json", by_alias=True, exclude_none=True)
                    )
        except asyncio.CancelledError:
            if not future.done():
                future.set_exception(RuntimeError("mcp_disconnected"))
        except Exception as exc:
            if not future.done():
                future.set_exception(exc)

    async def request(self, method: str, params: dict):
        if not await asyncio.shield(self.ready) or self.task.done():
            raise RuntimeError(self.error or "mcp_disconnected")
        result = asyncio.get_running_loop().create_future()
        try:
            async with asyncio.timeout(self.spec["timeout_s"]):
                await self.queue.put((method, params, result))
                return await result
        finally:
            if not result.done():
                result.cancel()

    async def close(self):
        if not self.task.done():
            if self.state == "connected":
                await self.queue.put(("_stop", {}, None))
            else:
                self.task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(self.task), 15)
            except TimeoutError:
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
