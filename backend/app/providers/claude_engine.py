"""Persistent Claude Code engine — one long-lived CLI process per chat.

Why a process per chat instead of one per turn (all verified against the CLI):

* Background tasks (`Bash run_in_background`, long commands the CLI moves to
  the background, subagents) live inside the CLI process. A per-turn process
  would either kill them or block the next turn until they finish.
* When a background task finishes while the chat is idle, Claude starts a
  turn on its own to react. Only a living process can do that; we stream
  those **auto turns** like any other.
* Stop is an ``interrupt`` control request: the current turn ends, the
  process and its background tasks keep running. Model / permission mode are
  switched live with ``set_model`` / ``set_permission_mode``.

The engine only owns the process and its line protocol. Every parsed event
goes into :attr:`events`; the session layer routes them to the active turn,
an auto turn, or the background-task registry.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections import deque
from typing import Any

from app.providers._cli_runtime import _ENV_WHITELIST, _kill_group
from app.portability import child_command
from app.providers._stream_json import StreamJsonAccumulator
from app.providers.base import ProviderEvent

_TASK_SUBTYPES = ("task_started", "task_updated", "task_progress", "task_notification")


class EngineError(RuntimeError):
    pass


def cli_context(info: dict[str, Any]) -> dict[str, Any]:
    """``get_context_usage`` -> ``context.update`` data (what the CLI itself
    will do: its effective window and the point it auto-compacts at)."""
    def num(k: str) -> int | None:
        v = info.get(k)
        return int(v) if isinstance(v, (int, float)) else None

    return {
        "tokens": num("totalTokens"),
        "window": num("maxTokens"),
        "model_window": num("rawMaxTokens"),
        "threshold": num("autoCompactThreshold"),
        "auto_compact": bool(info.get("isAutoCompactEnabled", True)),
        "window_source": info.get("autocompactSource"),
        "model": info.get("model"),
        "source": "cli",
    }


class ClaudeEngine:
    def __init__(
        self,
        *,
        binary: str,
        argv: list[str],
        cwd: str,
        env_extras: dict[str, str],
        fingerprint: str,
        model: str,
        mode: str,
    ) -> None:
        self.binary = binary
        self.argv = argv
        self.cwd = cwd
        self.env_extras = env_extras
        self.fingerprint = fingerprint
        self.model = model          # what the process is currently set to
        self.mode = mode
        self.events: asyncio.Queue[ProviderEvent] = asyncio.Queue()
        self.tasks: dict[str, dict[str, Any]] = {}
        self.cli_session_id: str | None = None
        # API-equivalent cost this process has run up (the CLI's result lines
        # report this running total, not the turn's cost).
        self.cost_total = 0.0
        self.started_at = time.time()
        self.last_activity = time.monotonic()
        self.turn_active = False
        self.interrupt_requested = False
        self._proc: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._stderr: deque[str] = deque(maxlen=60)
        self._pending: dict[str, asyncio.Future] = {}
        self._req_seq = 0
        self._write_lock = asyncio.Lock()

    # ---- lifecycle ----

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    @property
    def running_tasks(self) -> list[dict[str, Any]]:
        return [t for t in self.tasks.values() if t.get("status") in (None, "running", "pending")]

    async def start(self) -> None:
        env = {k: os.environ[k] for k in _ENV_WHITELIST if k in os.environ}
        env.update(self.env_extras)
        self._proc = await asyncio.create_subprocess_exec(
            *child_command(self.binary, self.argv),
            cwd=self.cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,  # own process group: shutdown kills tasks too
            limit=32 * 1024 * 1024,
        )
        self._reader = asyncio.create_task(self._read())
        self._stderr_task = asyncio.create_task(self._drain_stderr())

    async def close(self, *, grace: float = 3.0) -> None:
        """End the process and everything it spawned (background tasks too)."""
        proc = self._proc
        if proc is None:
            return
        if proc.stdin is not None and not proc.stdin.is_closing():
            proc.stdin.close()
        if proc.returncode is None and not self.running_tasks:
            try:
                await asyncio.wait_for(proc.wait(), timeout=grace)
            except asyncio.TimeoutError:
                pass
        if proc.returncode is None:
            _kill_group(proc)
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                pass
        for t in self.running_tasks:
            t["status"] = "killed"
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(EngineError("engine closed"))

    def stderr_tail(self) -> str:
        return "".join(self._stderr)[-2000:]

    # ---- input ----

    async def _write(self, obj: dict[str, Any] | bytes) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.stdin.is_closing() or proc.returncode is not None:
            raise EngineError("engine is not running")
        data = obj if isinstance(obj, bytes) else (json.dumps(obj) + "\n").encode()
        async with self._write_lock:
            proc.stdin.write(data)
            await proc.stdin.drain()
        self.last_activity = time.monotonic()

    async def send_user(self, envelope: bytes) -> None:
        await self._write(envelope)

    async def control(self, request: dict[str, Any], timeout: float = 15.0) -> dict[str, Any]:
        self._req_seq += 1
        rid = f"hrh_{self._req_seq}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self._write({"type": "control_request", "request_id": rid, "request": request})
            resp = await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)
        if resp.get("subtype") != "success":
            raise EngineError(str(resp.get("error") or resp))
        return resp.get("response") or {}

    async def interrupt(self) -> None:
        self.interrupt_requested = True
        await self.control({"subtype": "interrupt"})

    async def stop_task(self, task_id: str) -> None:
        await self.control({"subtype": "stop_task", "task_id": task_id})

    async def set_model(self, model: str) -> None:
        if model and model != self.model:
            await self.control({"subtype": "set_model", "model": model})
            self.model = model

    async def context_usage(self, timeout: float = 4.0) -> dict[str, Any] | None:
        """The CLI's own view of the context window (``get_context_usage``,
        summary detail: answered from the last response's usage, no API
        call): totalTokens, maxTokens (effective window), autoCompactThreshold,
        isAutoCompactEnabled, autocompactSource… None when it can't say."""
        try:
            resp = await self.control({"subtype": "get_context_usage", "detail": "summary"}, timeout=timeout)
        except (EngineError, asyncio.TimeoutError):
            return None
        return resp if isinstance(resp, dict) and resp.get("maxTokens") else None

    async def set_mode(self, permission_mode: str, mode: str) -> None:
        if mode != self.mode:
            await self.control({"subtype": "set_permission_mode", "mode": permission_mode})
            self.mode = mode

    # ---- output ----

    async def _drain_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        async for line in self._proc.stderr:
            self._stderr.append(line.decode(errors="replace"))

    def _task_event(self, sub: str, obj: dict[str, Any]) -> ProviderEvent:
        tid = str(obj.get("task_id") or "")
        task = self.tasks.setdefault(tid, {"task_id": tid, "status": "running", "started_at": time.time()})
        if sub == "task_progress":
            # A running subagent's heartbeat: its description is the current
            # activity ("Running …"), not the task's title.
            if obj.get("description"):
                task["activity"] = obj["description"]
            if obj.get("last_tool_name"):
                task["last_tool_name"] = obj["last_tool_name"]
        else:
            for k in ("tool_use_id", "description", "task_type", "is_backgrounded", "output_file", "summary"):
                if obj.get(k) is not None:
                    task[k] = obj[k]
        for k in ("subagent_type", "parent_task_id"):
            if obj.get(k) is not None:
                task[k] = obj[k]
        usage = obj.get("usage")
        if isinstance(usage, dict):
            for k in ("tool_uses", "total_tokens", "duration_ms"):
                if isinstance(usage.get(k), (int, float)):
                    task[k] = usage[k]
        patch = obj.get("patch") or {}
        if sub == "task_started":
            task["status"] = "running"
        if patch.get("status"):
            task["status"] = patch["status"]
        if sub == "task_notification" and obj.get("status"):
            task["status"] = obj["status"]
        if task["status"] not in ("running", "pending") and not task.get("ended_at"):
            end = patch.get("end_time")
            task["ended_at"] = (end / 1000) if isinstance(end, (int, float)) else time.time()
        return ProviderEvent(type="task.update", data={**task, "event": sub})  # type: ignore[arg-type]

    async def _read(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        acc = StreamJsonAccumulator()
        try:
            async for raw in self._proc.stdout:
                self.last_activity = time.monotonic()
                try:
                    obj = json.loads(raw)
                except ValueError:
                    continue
                typ, sub = obj.get("type"), obj.get("subtype")
                if typ == "control_response":
                    resp = obj.get("response") or {}
                    fut = self._pending.get(str(resp.get("request_id")))
                    if fut is not None and not fut.done():
                        fut.set_result(resp)
                    continue
                if typ == "system" and sub in _TASK_SUBTYPES:
                    await self.events.put(self._task_event(sub, obj))
                    continue
                if typ == "system" and sub == "background_tasks_changed":
                    live = {str(t.get("task_id")) for t in obj.get("tasks") or []}
                    for tid, t in self.tasks.items():
                        if t.get("is_backgrounded") and tid not in live and t.get("status") == "running":
                            t["status"] = "completed"
                            t.setdefault("ended_at", time.time())
                            await self.events.put(ProviderEvent(type="task.update", data={**t, "event": "reconciled"}))  # type: ignore[arg-type]
                    continue
                if typ == "rate_limit_event":
                    await self.events.put(ProviderEvent(type="usage.update", data=obj.get("rate_limit_info") or {}))  # type: ignore[arg-type]
                    continue
                for ev in acc.feed(obj):
                    if ev.type == "session.info" and obj.get("session_id"):
                        self.cli_session_id = obj["session_id"]
                    await self.events.put(ev)
                    if ev.type in ("turn.complete", "error"):
                        # One accumulator per turn; the session id and the
                        # process's running cost total carry over, so each
                        # turn reports only its own share of the cost.
                        sid = acc.session_id
                        self.cost_total = acc.cost_total
                        acc = StreamJsonAccumulator(cost_base=self.cost_total)
                        acc.session_id = sid
        finally:
            rc = None
            if self._proc is not None:
                try:
                    rc = await asyncio.wait_for(self._proc.wait(), timeout=5)
                except asyncio.TimeoutError:
                    rc = None
            await self.events.put(ProviderEvent(type="engine.exit", data={"returncode": rc}))  # type: ignore[arg-type]
