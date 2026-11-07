"""Codex's supported stdio protocol: item lifecycles, child agents and steering.

Unlike exec's summary JSONL, app-server emits reasoning starts before any
reasoning text exists. No polling of transcripts, inferred thinking, or second
model invocation is needed. The process still belongs to this turn's process
group, with the same account, workspace, MCP configuration and sandbox policy.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Iterator

from app.config import settings
from app.providers._cli_runtime import CLIProcessRunner
from app.providers._codex_json import CodexJsonAccumulator
from app.providers.base import ProviderEvent, TurnRequest


class RpcError(RuntimeError):
    pass


class CodexConnection:
    """One reader owns stdout; response futures never consume notifications."""

    def __init__(self, runner: CLIProcessRunner, argv: list[str]):
        self.runner, self.argv = runner, argv
        self.events: asyncio.Queue[dict | BaseException | None] = asyncio.Queue()
        self.pending: dict[int, asyncio.Future] = {}
        self.sequence = 0
        self.reader: asyncio.Task | None = None
        self.closed = False

    @staticmethod
    def encode(obj: dict) -> bytes:
        return (json.dumps(obj, ensure_ascii=False) + "\n").encode()

    async def start(self) -> None:
        self.sequence = 1
        future = asyncio.get_running_loop().create_future()
        self.pending[1] = future
        initial = self.encode(
            {
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {"name": "my_mate_geny", "version": "1.0.0"},
                    "capabilities": {"experimentalApi": True},
                },
            }
        )

        async def read() -> None:
            try:
                async for line in self.runner.stream(
                    self.argv, stdin=initial, keep_stdin_open=True
                ):
                    try:
                        obj = json.loads(line)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if not isinstance(obj, dict):
                        continue
                    if "id" in obj and "method" not in obj:
                        f = self.pending.pop(obj["id"], None)
                        if f is not None and not f.done():
                            if "error" in obj:
                                f.set_exception(
                                    RpcError(
                                        str(
                                            (obj["error"] or {}).get(
                                                "message", "Codex request failed"
                                            )
                                        )
                                    )
                                )
                            else:
                                f.set_result(obj.get("result") or {})
                    elif "id" in obj:
                        # There is no interactive permission dialog on this
                        # automation path. Never hang or approve a new request.
                        await self.runner.write(
                            self.encode(
                                {
                                    "id": obj["id"],
                                    "error": {
                                        "code": -32601,
                                        "message": "Interactive requests are not supported by this client",
                                    },
                                }
                            )
                        )
                        await self.events.put(
                            {
                                "method": "geny/unsupportedRequest",
                                "params": {"method": obj.get("method")},
                            }
                        )
                    else:
                        await self.events.put(obj)
            except Exception as exc:
                await self.events.put(exc)
            finally:
                self.closed = True
                for f in self.pending.values():
                    if not f.done():
                        f.set_exception(RpcError(self.closed_message()))
                self.pending.clear()
                await self.events.put(None)

        self.reader = asyncio.create_task(read())
        await asyncio.wait_for(future, 30)
        await self.runner.write(self.encode({"method": "initialized"}))

    def closed_message(self) -> str:
        """Says why, when the CLI left word: the same few words for every cause tell nobody what to do."""
        result = self.runner.last_result
        said = [ln.strip() for ln in (result.stderr if result else "").splitlines() if ln.strip()]
        if not result:
            return "Codex app-server connection closed"
        return f"Codex app-server connection closed (exit {result.returncode})" + (f": {said[-1][:300]}" if said else "")

    async def request(self, method: str, params: dict) -> dict:
        if self.closed:
            raise RpcError(self.closed_message())
        self.sequence += 1
        iid = self.sequence
        f = asyncio.get_running_loop().create_future()
        self.pending[iid] = f
        try:
            if not await self.runner.write(
                self.encode({"id": iid, "method": method, "params": params})
            ):
                raise RpcError("Could not write to Codex app-server")
            return await asyncio.wait_for(f, 60)
        finally:
            self.pending.pop(iid, None)

    async def close(self) -> None:
        self.runner.close_stdin()
        if self.reader:
            try:
                await asyncio.wait_for(asyncio.shield(self.reader), timeout=1)
            except (TimeoutError, asyncio.CancelledError):
                self.reader.cancel()
                with suppress(asyncio.CancelledError):
                    await self.reader


class CodexAppAccumulator(CodexJsonAccumulator):
    def __init__(self) -> None:
        super().__init__()
        self.turn_id: str | None = None
        self.parents: dict[str, str] = {}
        self.agents: dict[str, dict] = {}
        self._parent: str | None = None
        self._time: str | None = None
        self._reasoning: set[str] = set()
        self._summaries: dict[str, dict[int, str]] = {}
        self._usage_total: dict | None = None
        self._turn_usage: dict[str, int] = {}
        self._finalized: set[str] = set()
        self._spawns: dict[str, set[str]] = {}
        self._unbound_children: dict[str, list[dict]] = {}
        self.child_turns: dict[str, str] = {}
        self._agent_descriptions: dict[str, str] = {}
        self._reasoning_started: dict[str, str] = {}
        self._reasoning_parents: dict[str, str | None] = {}
        self._responses: dict[str, str] = {}
        self._main_open: set[str] = set()

    def _response(self, thread: str, start: bool) -> Iterator[ProviderEvent]:
        if start:
            if thread not in self._responses:
                iid = f"{thread}:response:{self._seq}"
                self._responses[thread] = iid
                yield self._ev("thinking.start", {"id": iid, "scope": "response"})
        else:
            iid = self._responses.pop(thread, None)
            if iid:
                yield self._ev("thinking.end", {"id": iid, "scope": "response"})

    def _ev(self, type_: str, data: dict[str, Any]) -> ProviderEvent:
        data = {**data, **({"parent": self._parent} if self._parent else {})}
        ev = super()._ev(type_, data)
        if self._time:
            ev.timestamp = self._time
        return ev

    def _agent_state(self, child: str, state: dict) -> Iterator[ProviderEvent]:
        parent = self.parents.get(child)
        if not parent:
            return
        status = {
            "pendingInit": "running",
            "running": "running",
            "completed": "completed",
            "errored": "failed",
            "interrupted": "stopped",
            "shutdown": "stopped",
            "notFound": "lost",
        }.get(state.get("status"))
        if not status:
            return
        previous = self.agents.get(child) or {}
        if previous.get("tool_use_id") != parent:
            previous = {}
        now = (
            datetime.fromisoformat(self._time).timestamp()
            if self._time
            else datetime.now(timezone.utc).timestamp()
        )
        message = state.get("message") or previous.get("summary") or ""
        current = {
            **previous,
            "task_id": f"codex:{child}:{parent}",
            "tool_use_id": parent,
            "status": status,
            "started_at": previous.get("started_at", now),
            "task_type": "codex_agent",
            "description": self._agent_descriptions.get(child, "Codex"),
            "is_backgrounded": True,
            "subagent_type": "Codex",
            **({"summary": message} if message else {}),
        }
        if status != "running":
            current["ended_at"] = now
        if previous.get("status") == status and previous.get("summary", "") == message:
            return
        self.agents[child] = current
        yield self._ev("task.update", current)
        if message and previous.get("summary") != message:
            yield self._ev("subagent.text", {"parent": parent, "text": message})

    def feed_notification(self, obj: dict) -> Iterator[ProviderEvent]:
        method, p = obj.get("method", ""), obj.get("params") or {}
        if method == "thread/started":
            child = p.get("thread") or {}
            pending = self._spawns.get(child.get("parentThreadId")) or set()
            if len(pending) == 1:
                self.parents.setdefault(child["id"], next(iter(pending)))
            elif pending:
                self._unbound_children.setdefault(child["id"], [])
            return
        thread = p.get("threadId")
        self._parent = self.parents.get(thread)
        self._time = obj.get("_received_at")
        ms = (
            p.get("startedAtMs")
            if method == "item/started"
            else p.get("completedAtMs")
            if method == "item/completed"
            else None
        )
        if isinstance(ms, (int, float)):
            self._time = datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()
        if thread and thread != self.thread_id and not self._parent:
            # Parallel spawn calls can race with child thread notifications.
            # Wait for receiverThreadIds rather than assigning the last spawn.
            pending = self._unbound_children.get(thread)
            if pending is not None and len(pending) < 128:
                pending.append(
                    {**obj, "_received_at": self._time or datetime.now(timezone.utc).isoformat()}
                )
            return  # child prose must never leak into the main answer
        if method == "turn/started":
            if not self._parent:
                self.turn_id = (p.get("turn") or {}).get("id")
            else:
                self.child_turns[thread] = (p.get("turn") or {}).get("id")
            yield from self._response(thread, True)
            return
        if method == "thread/status/changed" and self._parent:
            status = (p.get("status") or {}).get("type")
            if status == "active":
                yield from self._agent_state(thread, {"status": "running"})
            return
        if method == "thread/tokenUsage/updated" and not self._parent:
            usage = p.get("tokenUsage") or {}
            total = usage.get("total") or {}
            if p.get("turnId") == self.turn_id:
                # Total is cumulative for the thread, last is one API call.
                # Taking deltas avoids counting previous turns or repeated updates.
                delta = (
                    {
                        k: max(0, int(v or 0) - int(self._usage_total.get(k, 0) or 0))
                        for k, v in total.items()
                    }
                    if self._usage_total
                    else usage.get("last", {})
                )
                if total != self._usage_total:
                    for k, v in delta.items():
                        self._turn_usage[k] = self._turn_usage.get(k, 0) + int(v or 0)
                self.usage = {
                    "input_tokens": self._turn_usage.get("inputTokens", 0),
                    "cached_input_tokens": self._turn_usage.get("cachedInputTokens", 0),
                    "output_tokens": self._turn_usage.get("outputTokens", 0),
                    "reasoning_output_tokens": self._turn_usage.get("reasoningOutputTokens", 0),
                }
                last = usage.get("last") or {}
                yield self._ev(
                    "context.update",
                    {
                        "tokens": last.get("inputTokens", 0),
                        "window": usage.get("modelContextWindow"),
                        "source": "cli",
                    },
                )
            self._usage_total = total
            return
        if method == "turn/completed":
            yield from self._response(thread, False)
            turn = p.get("turn") or {}
            if self._parent:
                yield from self._agent_state(
                    thread,
                    {
                        "status": {"completed": "completed", "interrupted": "interrupted"}.get(
                            turn.get("status"), "errored"
                        )
                    },
                )
            elif not self.turn_id or turn.get("id") == self.turn_id:
                self.completed = turn.get("status") == "completed"
                if not self.completed:
                    self.failed = (turn.get("error") or {}).get(
                        "message"
                    ) or f"Codex turn {turn.get('status', 'failed')}"
            return
        iid = str(p.get("itemId") or (p.get("item") or {}).get("id") or "")
        key = f"{thread}:{iid}"
        if method in ("item/started", "item/completed"):
            item = p.get("item") or {}
            kind = item.get("type")
            done = method == "item/completed"
            if done and key in self._finalized:
                return
            if done:
                self._finalized.add(key)
            if kind == "reasoning":
                if not done:
                    yield from self._response(thread, False)
                    self._reasoning.add(key)
                    self._reasoning_parents[key] = self._parent
                    ev = self._ev("thinking.start", {"id": key})
                    self._reasoning_started[key] = ev.timestamp
                    yield ev
                else:
                    if key not in self._summaries:
                        text = "\n\n".join(item.get("summary") or item.get("content") or [])
                        if text:
                            yield self._ev("thinking.delta", {"id": key, "text": text})
                    self._reasoning.discard(key)
                    # Some models deliver the entire hidden item at once, with
                    # identical lifecycle timestamps. That is NOT 0 ms thinking.
                    known = (
                        key in self._reasoning_started
                        and self._reasoning_started[key] != self._time
                    )
                    yield self._ev("thinking.end", {"id": key, "timing_known": known})
                return
            if kind in ("collabAgentToolCall", "collabToolCall"):
                yield from self._response(thread, False)
                yield from self._collab(item, key, done)
                if not self._parent:
                    if done:
                        self._main_open.discard(key)
                        if not self._main_open:
                            yield from self._response(thread, True)
                    else:
                        self._main_open.add(key)
                return
            if kind == "subAgentActivity":
                child = item.get("agentThreadId")
                if child and child not in self.parents:
                    self.parents[child] = key
                    self._agent_descriptions[child] = item.get("agentPath") or "Codex"
                    yield from self._tool(
                        "item.started",
                        key,
                        "Agent",
                        {
                            "description": item.get("agentPath") or "Codex",
                            "subagent_type": "Codex",
                            "model": item.get("model"),
                            "run_in_background": True,
                        },
                    )
                    yield self._ev(
                        "tool.result",
                        {
                            "id": key,
                            "output": "Agent started",
                            "is_error": False,
                            "agent": {
                                "agent_id": child,
                                "is_async": True,
                                "model": item.get("model"),
                            },
                        },
                    )
                if child:
                    status = {
                        "started": "running",
                        "interacted": "running",
                        "interrupted": "interrupted",
                        "completed": "completed",
                    }.get(item.get("kind"))
                    if status:
                        yield from self._agent_state(child, {"status": status})
                return
            aliases = {
                "agentMessage": "agent_message",
                "commandExecution": "command_execution",
                "fileChange": "file_change",
                "mcpToolCall": "mcp_tool_call",
                "webSearch": "web_search",
            }
            if kind in aliases:
                yield from self._response(thread, False)
            translated = {**item, "id": key, "type": aliases.get(kind, kind)}
            for old, new in [("aggregatedOutput", "aggregated_output"), ("exitCode", "exit_code")]:
                if old in item:
                    translated[new] = item[old]
            if kind == "agentMessage" and self._parent:
                if done and item.get("text"):
                    yield self._ev("subagent.text", {"text": item["text"]})
                return
            yield from super()._handle_item(
                "item.completed" if done else "item.started", translated
            )
            if not self._parent and kind in (
                "commandExecution",
                "fileChange",
                "mcpToolCall",
                "webSearch",
            ):
                if done:
                    self._main_open.discard(key)
                    if not self._main_open:
                        # This is inference + network wait, explicitly labelled
                        # as response generation, never invented reasoning time.
                        yield from self._response(thread, True)
                else:
                    self._main_open.add(key)
        elif method == "item/agentMessage/delta" and not self._parent:
            yield from self._response(thread, False)
            text = str(p.get("delta") or "")
            self._text_so_far[key] = self._text_so_far.get(key, "") + text
            if text:
                yield self._ev("text.delta", {"text": text})
        elif method in ("item/reasoning/summaryTextDelta", "item/reasoning/textDelta"):
            parts = self._summaries.setdefault(key, {})
            # Prefer the readable summary; raw reasoning is not a second copy.
            if method.endswith("textDelta") and -1 not in parts and parts:
                return
            index = p.get("summaryIndex", -1)
            text = str(p.get("delta") or "")
            prefix = "\n\n" if index not in parts and parts else ""
            parts[index] = parts.get(index, "") + text
            yield self._ev("thinking.delta", {"id": key, "text": prefix + text})
        elif method == "error":
            err = p.get("error") or {}
            self.last_error = err.get("message") or "Codex engine error"
            yield self._ev(
                "notice", {"level": "warning", "code": "codex.error", "message": self.last_error}
            )
        elif method == "turn/plan/updated":
            todos = [
                {
                    "content": x.get("step", ""),
                    "status": {"inProgress": "in_progress", "completed": "completed"}.get(
                        x.get("status"), "pending"
                    ),
                }
                for x in p.get("plan") or []
            ]
            tid = f"{thread}:plan:{self._seq}"
            yield from self._tool("item.started", tid, "TodoWrite", {"todos": todos})
            yield self._ev("tool.result", {"id": tid, "output": "Plan updated", "is_error": False})
        elif method == "geny/unsupportedRequest":
            yield self._ev(
                "notice",
                {
                    "level": "warning",
                    "code": "codex.interaction_required",
                    "message": f"Codex requested an unsupported interactive action: {p.get('method')}",
                },
            )

    def _collab(self, item: dict, key: str, done: bool) -> Iterator[ProviderEvent]:
        action = str(item.get("tool", ""))
        spawn = action in ("spawnAgent", "resumeAgent")
        children = item.get("receiverThreadIds") or [
            x for x in [item.get("newThreadId"), item.get("receiverThreadId")] if x
        ]
        inp = {
            "description": (item.get("prompt") or action)[:160],
            "prompt": item.get("prompt") or "",
            "operation": action,
            "subagent_type": "Codex",
            "model": item.get("model"),
            "reasoning_effort": item.get("reasoningEffort"),
            "run_in_background": spawn,
            "agent_ids": children,
        }
        yield from self._tool(
            "item.completed" if done else "item.started", key, "Agent" if spawn else action, inp
        )
        if spawn:
            sender = item.get("senderThreadId") or self.thread_id
            if done:
                self._spawns.setdefault(sender, set()).discard(key)
            else:
                self._spawns.setdefault(sender, set()).add(key)
        for child in children:
            if spawn:
                self.parents[child] = key
                self._agent_descriptions[child] = inp["description"]
            state = (item.get("agentsStates") or {}).get(child) or {"status": "running"}
            yield from self._agent_state(child, state)
            if spawn and child in self._unbound_children:
                previous_parent, previous_time = self._parent, self._time
                for notification in self._unbound_children.pop(child):
                    yield from self.feed_notification(notification)
                self._parent, self._time = previous_parent, previous_time
        if done:
            failed = item.get("status") in ("failed", "interrupted")
            yield self._ev(
                "tool.result",
                {
                    "id": key,
                    "is_error": failed,
                    "output": json.dumps(
                        {
                            "operation": action,
                            "agents": item.get("agentsStates") or {},
                            "agent_ids": children,
                        },
                        ensure_ascii=False,
                    ),
                    **(
                        {
                            "agent": {
                                "agent_id": children[0] if children else None,
                                "agent_type": "Codex",
                                "model": item.get("model"),
                                "is_async": not failed,
                                "status": item.get("status"),
                            }
                        }
                        if spawn
                        else {}
                    ),
                },
            )

    def close_activity(self) -> Iterator[ProviderEvent]:
        self._parent, self._time = None, None
        for thread in list(self._responses):
            self._parent = self.parents.get(thread)
            yield from self._response(thread, False)
        self._parent = None
        for key in list(self._reasoning):
            self._parent = self._reasoning_parents.get(key)
            yield self._ev("thinking.end", {"id": key})
        self._parent = None
        for child, state in list(self.agents.items()):
            if state.get("status") == "running":
                yield from self._agent_state(
                    child, {"status": "interrupted", "message": "Parent Codex turn ended"}
                )
        yield from self.close_open_tools("(Codex turn ended)")


async def run_app_server(
    provider: Any, req: TurnRequest, env: dict
) -> AsyncIterator[ProviderEvent]:
    runner = CLIProcessRunner(
        binary=provider._binary,
        cwd=req.cwd,
        env_extras=env,
        timeout_s=req.timeout_s or settings.turn_timeout_s,
    )
    client = CodexConnection(runner, ["app-server", *provider._mcp_overrides(req)])
    acc = CodexAppAccumulator()
    watcher: asyncio.Task | None = None
    pending = None
    try:
        await client.start()
        params: dict = {
            "cwd": req.cwd,
            "approvalPolicy": "never",
            "sandbox": "read-only" if req.mode == "plan" else "danger-full-access",
        }
        model = provider._model(req)
        if model:
            params["model"] = model
        if req.cli_session_id:
            params["threadId"] = req.cli_session_id
            # Never ask for the history: the CLI already holds it, and for a long conversation the reply is one
            # JSON line over the reader's limit (17 MB seen), which closed the connection on every message.
            params["excludeTurns"] = True
            if req.fork_session and req.resume_at:
                params["lastTurnId"] = req.resume_at
        method = "thread/start"
        if req.cli_session_id:
            method = "thread/fork" if req.fork_session else "thread/resume"
        try:
            reply = await client.request(method, params)
        except RpcError as exc:
            # (the session layer starts fresh with the conversation handed over, whatever the reason)
            raise RpcError(f"thread/fork failed: {exc}" if method == "thread/fork" else str(exc)) from exc
        acc.thread_id = reply["thread"]["id"]
        turn = {
            "threadId": acc.thread_id,
            "input": [
                {"type": "text", "text": provider._build_prompt(req).decode()},
                *[
                    {"type": "localImage", "path": a.inline_path}
                    for a in req.attachments
                    if a.is_image
                ],
            ],
        }
        if req.effort and req.effort != "default":
            turn["effort"] = req.effort
        reply = await client.request("turn/start", turn)
        acc.turn_id = reply["turn"]["id"]
        yield ProviderEvent(
            type="session.info",
            data={
                "provider": "codex",
                "transport": "app-server",
                "model": model or "default",
                "cli_session_id": acc.thread_id,
            },
        )

        async def stop_child(task_id: str) -> bool:
            child = next(
                (child for child, state in acc.agents.items() if state.get("task_id") == task_id),
                None,
            )
            if not child:
                return False
            child_turn = acc.child_turns.get(child)
            try:
                if not child_turn:
                    response = await client.request(
                        "thread/read", {"threadId": child, "includeTurns": True}
                    )
                    child_turn = next(
                        (
                            t["id"]
                            for t in reversed(response.get("thread", {}).get("turns", []))
                            if t.get("status") == "inProgress"
                        ),
                        None,
                    )
                if not child_turn:
                    return False
                await client.request("turn/interrupt", {"threadId": child, "turnId": child_turn})
                return True
            except (RpcError, TimeoutError):
                return False

        if req.inbox:
            req.inbox.stop_task = stop_child

        async def steer() -> None:
            nonlocal pending
            while True:
                pending = await req.inbox.queue.get()
                try:
                    await client.request(
                        "turn/steer",
                        {
                            "threadId": acc.thread_id,
                            "expectedTurnId": acc.turn_id,
                            "input": [
                                {
                                    "type": "text",
                                    "text": provider._steer_prompt(req, [pending]).decode(),
                                },
                                *[
                                    {"type": "localImage", "path": a.inline_path}
                                    for a in pending.attachments
                                    if a.is_image
                                ],
                            ],
                        },
                    )
                    pending.resolve(True)
                except (RpcError, TimeoutError):
                    pending.resolve(False)  # session queues it as the next turn
                except asyncio.CancelledError:
                    pending.resolve(False)
                    raise
                finally:
                    pending = None

        watcher = asyncio.create_task(steer()) if req.inbox else None
        while True:
            obj = await asyncio.wait_for(
                client.events.get(), req.timeout_s or settings.turn_timeout_s
            )
            if obj is None:
                break
            if isinstance(obj, BaseException):
                raise obj
            for ev in acc.feed_notification(obj):
                yield ev
            if acc.completed or acc.failed:
                break
        for ev in acc.close_activity():
            yield ev
        yield acc.terminal(model=model or "codex (default)", cli_session_id=req.cli_session_id)
    except (RpcError, KeyError, OSError, TimeoutError) as exc:
        code = (
            "exec.cli.binary_not_found"
            if isinstance(exc, FileNotFoundError)
            else "exec.cli.timeout"
            if isinstance(exc, TimeoutError)
            else "exec.cli.codex_error"
        )
        yield ProviderEvent(
            type="error", data={"code": code, "message": str(exc) or "Codex app-server timed out"}
        )
    finally:
        if watcher:
            watcher.cancel()
            with suppress(asyncio.CancelledError):
                await watcher
        if pending:
            pending.resolve(False)
        if req.inbox:
            req.inbox.close()
        await client.close()
