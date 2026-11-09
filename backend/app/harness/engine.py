"""One turn of an API-key agent: the loop Claude Code and Codex run inside their CLIs, run here.

The model answers; the tools it called run (calls marked parallel together, the rest in order); their results go back;
until it answers without calling anything. Along the way:

- every step is streamed as the normalized events a CLI turn produces (text, thinking, tool.use/tool.result, a
  subagent's steps under its call, background tasks, context size), and the turn ends with ``turn.complete`` carrying
  the usage, the cost and where the conversation now stands (``cli_session_id`` + ``cli_at``);
- a message the user adds while it works (steering) joins the conversation at the next step;
- background work that finishes is told to the model at the next step (or the next turn);
- when the conversation nears the model's context window it is compacted into a summary (also on ``/compact``);
- a key that is rate limited, out of credit or refused is swapped for another of the provider's keys within the turn;
  a vendor that is overloaded or unreachable is retried with backoff;
- Stop cancels the model call and the running tools, and leaves the conversation consistent (unanswered calls get an
  "interrupted" result) with what was spent reported.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

from app.harness import prompts
from app.harness import runtime as runtimes
from app.harness.llm import adapter as make_adapter
from app.harness.llm.base import (
    Done,
    LLMCall,
    LLMError,
    TextDelta,
    ThinkingDelta,
    ThinkingEnd,
    ThinkingStart,
    ToolInputDelta,
    ToolSpec,
)
from app.harness.models import ModelCatalog
from app.harness.pricing import call_cost
from app.harness.store import TranscriptStore, model_view
from app.harness.tools import ToolContext, ToolOutput, builtin, select
from app.harness.tools.mcp import McpHub, load_config
from app.harness.tools.tasks import find_skills
from app.harness.vendors import VENDORS
from app.providers._attachments import compose_text
from app.providers.base import ProviderEvent, TurnRequest

MAX_STEPS = 400
SUBAGENT_STEPS = 200
RETRIES = 6
RATE_WAITS = 3
INTERRUPTED = "Interrupted by user"
_pause = asyncio.sleep  # (waits before a retry; the tests make them instant)


class KeySource:
    """The API key a turn uses, and another one when it fails (the session layer's account pool)."""

    key: str = ""
    label: str = ""
    account_id: str | None = None

    async def failover(self, err: LLMError) -> bool:  # pragma: no cover - interface
        return False

    def ok(self) -> None:
        pass


class StaticKey(KeySource):
    def __init__(self, key: str, label: str = "API key") -> None:
        self.key, self.label = key, label


@dataclass
class Spend:
    usage: dict[str, int] = field(default_factory=lambda: {
        "input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0,
        "reasoning_output_tokens": 0})
    cost: float = 0.0
    priced: bool = True
    calls: int = 0

    def add(self, usage: dict[str, int], cost: float | None) -> None:
        for k in self.usage:
            self.usage[k] += int(usage.get(k) or 0)
        self.calls += 1
        if cost is None:
            self.priced = False
        else:
            self.cost += cost

    def fields(self) -> dict[str, Any]:
        return {"usage": dict(self.usage), "cost_usd": round(self.cost, 6) if self.priced else 0.0,
                "cost_kind": "turn" if self.priced else "none"}


@dataclass
class Answer:
    text: str
    citations: list[dict[str, str]]


class _Stop(Exception):
    def __init__(self, code: str, message: str, err: LLMError | None = None) -> None:
        super().__init__(message)
        self.code, self.err = code, err


@dataclass
class Conv:
    """One running conversation: the turn's main one, or a subagent's."""

    view: list[dict[str, Any]]
    system: str
    tools: list[Any]
    parent: str | None = None
    persist: Callable[[dict[str, Any]], None] | None = None
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    final_text: str = ""
    stop_reason: str = "end_turn"
    steps: int = 0
    tool_uses: int = 0
    open_calls: list[str] = field(default_factory=list)  # tool calls asked for and not answered yet
    results: dict[str, ToolOutput] = field(default_factory=dict)  # ... and the answers that came back so far

    def add(self, entry: dict[str, Any]) -> None:
        self.view.append(entry)
        if self.persist is not None:
            self.persist(entry)


def _text_of(message: dict[str, Any]) -> str:
    return "".join(b.get("text", "") for b in message.get("content") or [] if b.get("type") == "text").strip()


def _tool_result_block(use: dict[str, Any], out: ToolOutput) -> dict[str, Any]:
    content: list[dict[str, Any]] = [{"type": "text", "text": out.text or ("(no output)" if not out.is_error else "Error")}]
    content += [{"type": "image", "media_type": i["media_type"], "data": i["data"]} for i in out.images]
    return {"type": "tool_result", "tool_use_id": use["id"], "name": use["name"], "content": content,
            "is_error": out.is_error}


class HarnessTurn:
    def __init__(self, provider: str, req: TurnRequest, db: Any) -> None:
        self.provider = provider
        self.req = req
        self.db = db
        self.store = TranscriptStore(db)
        self.catalog = ModelCatalog(db)
        self.llm = make_adapter(provider)
        self.vendor = VENDORS[provider].label
        self.spend = Spend()
        self.started = time.monotonic()
        self.keys: KeySource = req.key_source or StaticKey(req.api_key or "")
        self.sid = req.session_id or "turn"
        # (a background extraction — a mate's memory, her diary — keeps nothing: no conversation, no shell left over)
        self.rt = runtimes.SessionRuntime(self.sid) if req.ephemeral or not req.session_id else runtimes.get(self.sid)
        self.model = ""
        self.info: dict[str, Any] = {}
        self.partial = ""            # text of the call streaming right now (kept if it is stopped)
        self.compacted_at = -1
        self.last_prompt = 0
        self.alive = True
        self.conv: Conv | None = None
        self.hs = ""

    # ---- the turn ----

    async def run(self) -> AsyncIterator[ProviderEvent]:
        req = self.req
        self.model = req.model if req.model and req.model != "default" else self.catalog.default_model(self.provider)
        if not self.model:
            yield self._error("exec.api.no_model", f"No {self.vendor} model is switched on. Turn one on in Settings → "
                                                  f"Providers → {self.vendor} → Models.")
            return
        if not self.keys.key:
            yield self._error("exec.api.no_key", f"No {self.vendor} API key. Add one in Settings → Providers → "
                                                f"{self.vendor}.")
            return
        self.info = self.catalog.info(self.provider, self.model)
        hs = self._conversation()
        if hs is None:
            yield self._error("exec.api.stale", "no conversation found with that id")
            return
        self.hs = hs
        self.rt.turn_running = True
        self.rt.on_event = req.background_event
        if getattr(self.rt, "base_cwd", None) != req.cwd:  # (another folder: the shell starts over there)
            self.rt.base_cwd = req.cwd
            self.rt.cwd = None
        if req.inbox is not None:
            req.inbox.stop_task = self._stop_task
        yield ProviderEvent(type="session.start", data={"provider": self.provider, "model": self.model,
                                                        "workspace": req.cwd})
        try:
            mcp_status = await self._connect_mcp()
            skills = {} if req.sealed else find_skills(req.plugin_dirs, req.cwd)
            builtins = [] if req.tools == [] else builtin(skills)
            mcp_tools = self.rt.mcp.tools() if self.rt.mcp is not None else []
            tools = select(builtins, mcp_tools, req)
            own = prompts.own_prompt(req)
            system = own if own is not None else prompts.system_prompt(
                provider=self.provider, model=self.model, cwd=req.cwd, extra_dirs=[*req.extra_dirs], mode=req.mode,
                folders_note=req.folders_note, system_append=req.system_append, skills=skills)
            if own is not None and req.system_append:
                system = f"{system}\n\n{req.system_append}"
            yield ProviderEvent(type="session.info", data={
                "provider": self.provider, "transport": "api", "model": self.model, "cwd": req.cwd,
                "cli_session_id": None if req.ephemeral else hs, "tools": [t.name for t in tools],
                "mcp_servers": mcp_status,
                "permissionMode": req.mode, "account": self.keys.label})
            entries = [] if req.ephemeral else self.store.load(hs)
            conv = self.conv = Conv(view=model_view(entries), system=system, tools=tools,
                                    persist=None if req.ephemeral else (lambda e: self.store.append(hs, [e])))
            # (how big the conversation already is, until the first call says: ~4 characters a token)
            self.last_prompt = len(json.dumps(conv.view, ensure_ascii=False)) // 4 + len(system) // 4
            text = self._user_text()
            if text.strip().startswith("/compact") and not req.attachments:
                if not conv.view:
                    yield ProviderEvent(type="turn.complete", data=self._complete("Nothing to compact yet.", conv))
                    return
                async for ev in self._compact(conv, "manual", text.strip()[len("/compact"):].strip()):
                    yield ev
                yield ProviderEvent(type="turn.complete", data=self._complete("", conv))
                return
            conv.add(self._user_entry(text))
            async for ev in self._steps(conv, MAX_STEPS):
                yield ev
            if req.inbox is not None:
                req.inbox.close()
            self.keys.ok()
            async for ev in self._drain(conv):
                yield ev
            yield ProviderEvent(type="turn.complete", data=self._complete(conv.final_text, conv))
        except _Stop as stop:
            if req.inbox is not None:
                req.inbox.close()
            yield self._error(stop.code, str(stop), stop.err)
        except asyncio.CancelledError:
            self._interrupted()
            raise
        finally:
            self.alive = False
            self.rt.turn_running = False
            self.rt.touch()
            if req.ephemeral or not req.session_id:
                await self.rt.shutdown()

    def _conversation(self) -> str | None:
        req = self.req
        if req.ephemeral:
            return "ephemeral"
        if req.cli_session_id:
            if not self.store.exists(req.cli_session_id):
                return None
            if req.fork_session:
                at = None
                with contextlib.suppress(TypeError, ValueError):
                    at = int(req.resume_at) if req.resume_at is not None else None
                return self.store.fork(req.cli_session_id, at, self.sid, self.provider)
            return req.cli_session_id
        return self.store.create(self.sid, self.provider)

    async def _connect_mcp(self) -> list[dict[str, str]]:
        servers = load_config(self.req.mcp_config, self.req.mcp_config_file)
        if not servers:
            if self.rt.mcp is not None:
                await self.rt.mcp.close()
                self.rt.mcp = None
            return []
        if self.rt.mcp is None:
            self.rt.mcp = McpHub(self.rt.dir)
        return await self.rt.mcp.sync(servers)

    def _user_text(self) -> str:
        last = next((m.get("content", "") for m in reversed(self.req.messages) if m.get("role") == "user"), "")
        return str(last or "")

    def _user_entry(self, text: str) -> dict[str, Any]:
        req = self.req
        vision = bool(self.info.get("vision", True))
        body = compose_text(text, req.attachments, inline_images=vision, inline_files=req.inline_files)
        notices = self.rt.take_notices()
        parts = [p for p in (req.preamble, *notices, body) if p]
        content: list[dict[str, Any]] = [{"type": "text", "text": "\n\n".join(parts) or "(empty message)"}]
        if vision:
            content += [{"type": "image", "media_type": a.inline_mime, "path": a.inline_path}
                        for a in req.attachments if a.is_image]
        return {"role": "user", "content": content}

    # ---- the loop ----

    async def _steps(self, conv: Conv, limit: int) -> AsyncIterator[ProviderEvent]:
        nested = conv.parent is not None
        for _ in range(limit):
            if not nested:
                extra = self._steering()
                if extra:
                    conv.add({"role": "user", "content": extra})
                if self._needs_compaction(conv):
                    async for ev in self._compact(conv, "auto"):
                        yield ev
            done: Done | None = None
            async for ev in self._call(conv):
                if isinstance(ev, Done):
                    done = ev
                else:
                    yield ev
            assert done is not None
            conv.steps += 1
            msg = done.message
            if nested:
                for b in msg["content"]:
                    if b["type"] == "thinking" and b.get("text"):
                        yield ProviderEvent(type="subagent.thinking", data={"parent": conv.parent, "text": b["text"]})
                text = _text_of(msg)
                if text:
                    yield ProviderEvent(type="subagent.text", data={"parent": conv.parent, "text": text})
            uses = [b for b in msg["content"] if b["type"] == "tool_use"]
            conv.add(msg)
            if not uses:
                if not nested and ((self.req.inbox is not None and not self.req.inbox.queue.empty())
                                   or self.rt.notices):
                    continue  # (the user added something, or background work ended, while it answered: go on)
                conv.final_text = _text_of(msg)
                conv.stop_reason = done.stop_reason
                return
            conv.open_calls = [u["id"] for u in uses]
            async for ev in self._run_tools(conv, uses, cut=done.stop_reason == "max_tokens"):
                yield ev
        raise _Stop("exec.api.max_steps", f"Stopped after {limit} steps without finishing.")

    def _steering(self) -> list[dict[str, Any]]:
        """What the user added while the turn worked, and background work that finished, as one user message."""
        blocks: list[dict[str, Any]] = []
        texts: list[str] = [*self.rt.take_notices()]
        inbox = self.req.inbox
        delivered = []
        while inbox is not None and not inbox.queue.empty():
            msg = inbox.queue.get_nowait()
            vision = bool(self.info.get("vision", True))
            texts.append(compose_text(msg.text, msg.attachments, inline_images=vision, inline_files=msg.inline_files))
            if vision:
                blocks += [{"type": "image", "media_type": a.inline_mime, "path": a.inline_path}
                           for a in msg.attachments if a.is_image]
            delivered.append(msg)
        for msg in delivered:
            msg.resolve(True)  # (recorded now, in its true place: before what the model does with it)
        if not texts and not blocks:
            return []
        return [{"type": "text", "text": "\n\n".join(t for t in texts if t)}, *blocks]

    async def _call(self, conv: Conv, *, tools: bool = True, quiet: bool = False,
                    web_search: bool = False, view: list[dict[str, Any]] | None = None,
                    system: str | None = None, max_tokens: int | None = None) -> AsyncIterator[Any]:
        """One model call (retried, or moved to another key, when that helps) → its events, then its Done."""
        nested = conv.parent is not None
        call = LLMCall(
            model=self.model, system=conv.system if system is None else system,
            messages=conv.view if view is None else view,
            tools=[ToolSpec(t.name, t.description, t.schema) for t in conv.tools] if tools and not web_search else [],
            effort=self.req.effort or "default", max_tokens=max_tokens or self._max_tokens(),
            caps=self.info.get("caps") or {}, cache_key=self.hs, web_search=web_search,
        )
        retries = rate_waits = 0
        while True:
            emitted = False
            open_thinking: set[str] = set()
            if not quiet and not nested:
                self.partial = ""
            try:
                gen = self.llm.stream(call, self.keys.key)
                gap = self.req.timeout_s or 900
                while True:
                    try:
                        ev = await asyncio.wait_for(gen.__anext__(), gap)
                    except StopAsyncIteration:
                        break
                    except TimeoutError:
                        with contextlib.suppress(Exception):
                            await gen.aclose()
                        raise LLMError("network", f"no response from {self.vendor} for {gap:.0f}s") from None
                    if isinstance(ev, Done):
                        cost = call_cost(self.info.get("price"), ev.usage)
                        self.spend.add(ev.usage, cost)
                        if self.req.on_usage is not None:
                            with contextlib.suppress(Exception):
                                self.req.on_usage(self.spend.fields())
                        if not quiet and not nested:
                            self.last_prompt = (ev.usage.get("input_tokens", 0) + ev.usage.get("cache_read_input_tokens", 0)
                                                + ev.usage.get("cache_creation_input_tokens", 0))
                            yield self._context_event()
                        if ev.stop_reason == "refusal" and not quiet:
                            yield ProviderEvent(type="notice", data={
                                "level": "warning", "code": "api.refusal",
                                "message": f"{self.vendor} declined to continue this answer."})
                        yield ev
                        return
                    if quiet or nested:
                        continue
                    emitted = True
                    if isinstance(ev, TextDelta):
                        self.partial += ev.text
                        yield ProviderEvent(type="text.delta", data={"text": ev.text})
                    elif isinstance(ev, ThinkingStart):
                        open_thinking.add(ev.id)
                        yield ProviderEvent(type="thinking.start", data={"id": ev.id})
                    elif isinstance(ev, ThinkingDelta):
                        yield ProviderEvent(type="thinking.delta", data={"id": ev.id, "text": ev.text})
                    elif isinstance(ev, ThinkingEnd):
                        open_thinking.discard(ev.id)
                        yield ProviderEvent(type="thinking.end", data={"id": ev.id})
                    elif isinstance(ev, ToolInputDelta):
                        pass
                raise LLMError("bad_response", "the answer ended without finishing")
            except LLMError as err:
                for tid in open_thinking:
                    yield ProviderEvent(type="thinking.end", data={"id": tid})
                if err.kind == "context" and self.compacted_at != len(conv.view) and not quiet and conv.parent is None:
                    async for ev in self._compact(conv, "auto"):
                        yield ev
                    call.messages = conv.view
                    continue
                if err.account_outcome:
                    old = self.keys.label
                    if await self.keys.failover(err):
                        yield ProviderEvent(type="notice", data={
                            "level": "info", "code": "account.failover",
                            "message": f"{old}: {err} — continuing with {self.keys.label}"})
                        continue
                    if err.kind == "rate_limit" and rate_waits < RATE_WAITS and not emitted:
                        rate_waits += 1
                        wait = min(err.retry_after or 10 * rate_waits, 60)
                        yield ProviderEvent(type="notice", data={
                            "level": "warning", "code": "api.rate_limited",
                            "message": f"{self.vendor} rate limit — retrying in {wait:.0f}s"})
                        await _pause(wait)
                        continue
                if err.retryable and retries < RETRIES and not emitted:
                    retries += 1
                    wait = min(2 ** retries, 30)
                    if retries == 1 or retries == RETRIES - 1:
                        yield ProviderEvent(type="notice", data={
                            "level": "warning", "code": "api.retrying",
                            "message": f"{self.vendor}: {err} — retrying ({retries}/{RETRIES - 1})"})
                    await _pause(wait)
                    continue
                raise _Stop(f"exec.api.{err.kind}", f"{self.vendor} API error: {err}", err) from err

    async def _run_tools(self, conv: Conv, uses: list[dict[str, Any]], *, cut: bool) -> AsyncIterator[ProviderEvent]:
        for u in uses:
            data = {"id": u["id"], "name": u["name"], "input": u.get("input") or {}}
            if conv.parent:
                data["parent"] = conv.parent
            yield ProviderEvent(type="tool.use", data=data)
        conv.tool_uses += len(uses)
        results = conv.results = {}
        by_name = {t.name: t for t in conv.tools}
        batches: list[list[dict[str, Any]]] = []
        for u in uses:
            tool = by_name.get(u["name"])
            if batches and tool is not None and tool.parallel and all(
                    (by_name.get(x["name"]) is not None and by_name[x["name"]].parallel) for x in batches[-1]):
                batches[-1].append(u)
            else:
                batches.append([u])
        tasks: dict[asyncio.Task, dict[str, Any]] = {}
        getter: asyncio.Task | None = None
        try:
            for batch in batches:
                for u in batch:
                    tasks[asyncio.create_task(self._exec(conv, u, by_name.get(u["name"]), cut))] = u
                pending = {t for t, u in tasks.items() if u in batch}
                while pending:
                    getter = getter or asyncio.create_task(conv.queue.get())
                    done, _ = await asyncio.wait(pending | {getter}, return_when=asyncio.FIRST_COMPLETED)
                    if getter in done:
                        yield getter.result()
                        getter = None
                    for t in done & pending:
                        pending.discard(t)
                        u = tasks[t]
                        out = t.result()
                        results[u["id"]] = out
                        yield self._result_event(conv, u, out)
            if getter is not None:
                getter.cancel()
                getter = None
            async for ev in self._drain(conv):
                yield ev
        finally:
            if getter is not None:
                getter.cancel()
            for t in tasks:
                if not t.done():
                    t.cancel()
            if any(not t.done() for t in tasks):
                await asyncio.gather(*tasks, return_exceptions=True)
        conv.open_calls = []
        conv.add({"role": "user", "content": [_tool_result_block(u, results[u["id"]]) for u in uses]})

    async def _drain(self, conv: Conv) -> AsyncIterator[ProviderEvent]:
        while not conv.queue.empty():
            yield conv.queue.get_nowait()

    def _result_event(self, conv: Conv, use: dict[str, Any], out: ToolOutput) -> ProviderEvent:
        data: dict[str, Any] = {"id": use["id"], "output": out.text, "is_error": out.is_error}
        if out.images:
            data["images"] = [{"media_type": i["media_type"], "data": i["data"]} for i in out.images]
        if out.agent:
            data["agent"] = out.agent
        if conv.parent:
            data["parent"] = conv.parent
        return ProviderEvent(type="tool.result", data=data)

    async def _exec(self, conv: Conv, use: dict[str, Any], tool: Any, cut: bool) -> ToolOutput:
        if cut:
            return ToolOutput.error("The answer hit its output limit before this call's input was complete, so it was "
                                    "not run. Try again with a smaller input (for a big file, write it in parts).")
        if tool is None:
            known = ", ".join(t.name for t in conv.tools)
            why = " (not available in plan mode)" if self.req.mode == "plan" else ""
            return ToolOutput.error(f"No tool named {use['name']}{why}. Available: {known}")
        args = use.get("input") or {}
        if "__invalid__" in args:
            return ToolOutput.error("The tool input was not valid JSON. Send the call again with valid arguments.")
        ctx = ToolContext(
            sid=self.sid, runtime=self.rt, cwd=self.req.cwd, roots=[self.req.cwd, *self.req.extra_dirs],
            mode=self.req.mode, env=self._tool_env(), tool_use_id=use["id"], parent=conv.parent,
            emit=conv.queue.put_nowait, ask=self.ask,
            run_agent=self.run_agent if conv.parent is None else None, timeout_s=self.req.timeout_s)
        try:
            out = await tool.run(args, ctx)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a broken tool is an error result, not a broken turn
            out = ToolOutput.error(f"{use['name']} failed: {type(exc).__name__}: {exc}")
        if not isinstance(out, ToolOutput):
            out = ToolOutput(str(out))
        return out

    def _tool_env(self) -> dict[str, str]:
        import os

        from app.providers._cli_runtime import _ENV_WHITELIST
        from app.services.managed_node import environment

        env = environment({k: os.environ[k] for k in _ENV_WHITELIST if k in os.environ})
        env.update({k: v for k, v in self.req.extra_env.items() if "KEY" not in k.upper() and "TOKEN" not in k.upper()})
        env.update(self.req.tool_env)
        env.setdefault("GIT_TERMINAL_PROMPT", "0")
        env.setdefault("PAGER", "cat")
        return env

    # ---- what tools ask of the engine ----

    async def ask(self, system: str, prompt: str, *, web_search: bool = False) -> Answer:
        """A side question to the chat's model with none of the conversation (WebFetch, WebSearch)."""
        side = Conv(view=[], system=system, tools=[], parent="(side)")
        done: Done | None = None
        async for ev in self._call(side, tools=False, quiet=True, web_search=web_search,
                                   view=[{"role": "user", "content": [{"type": "text", "text": prompt}]}],
                                   max_tokens=8000):
            if isinstance(ev, Done):
                done = ev
        if done is None:
            return Answer("", [])
        return Answer(_text_of(done.message), done.citations)

    async def run_agent(self, *, description: str, prompt: str, subagent_type: str, background: bool,
                        tool_use_id: str) -> ToolOutput:
        main = self.conv
        tools = select(builtin({}), self.rt.mcp.tools() if self.rt.mcp is not None else [], self.req, subagent=True)
        system = prompts.system_prompt(
            provider=self.provider, model=self.model, cwd=self.req.cwd, extra_dirs=[*self.req.extra_dirs],
            mode=self.req.mode, folders_note=self.req.folders_note, system_append=self.req.system_append, skills={},
            subagent=True)
        if subagent_type and subagent_type != "general-purpose":
            system += f"\n\nYou were started as a \"{subagent_type}\" agent; work in that role."
        sub = Conv(view=[{"role": "user", "content": [{"type": "text", "text": prompt}]}], system=system, tools=tools,
                   parent=tool_use_id)
        agent_id = f"agent_{tool_use_id[-8:]}"
        started = time.monotonic()
        spent_before = sum(self.spend.usage.values())
        forward = main.queue.put_nowait if main is not None else (lambda ev: None)

        def report(status: str, text: str) -> dict[str, Any]:
            return {"agent_id": agent_id, "status": status, "agent_type": subagent_type, "model": self.model,
                    "duration_ms": int((time.monotonic() - started) * 1000),
                    "total_tokens": sum(self.spend.usage.values()) - spent_before,
                    "tool_uses": sub.tool_uses, "is_async": background, "result": text}

        async def work() -> str:
            async for ev in self._steps(sub, SUBAGENT_STEPS):
                if self.alive:
                    forward(ev)
            return sub.final_text or "(the subagent finished without a report)"

        if not background:
            try:
                text = await work()
            except _Stop as stop:
                return ToolOutput(f"The subagent stopped: {stop}", is_error=True, agent=report("failed", str(stop)))
            return ToolOutput(text, agent=report("completed", text))

        rt = self.rt
        task_data = {"task_id": agent_id, "tool_use_id": tool_use_id, "description": description,
                     "task_type": "local_agent", "is_backgrounded": True, "subagent_type": subagent_type,
                     "started_at": time.time()}

        def state(status: str, **extra: Any) -> ProviderEvent:
            return ProviderEvent(type="task.update", data={**task_data, "status": status, **extra})

        async def background_run() -> None:
            try:
                text = await work()
                status, summary = "completed", text
            except asyncio.CancelledError:
                rt.emit(state("stopped", ended_at=time.time()))
                raise
            except Exception as exc:  # noqa: BLE001
                status, summary = "failed", f"{type(exc).__name__}: {exc}"
            agent = rt.agents.get(agent_id)
            if agent is not None:
                agent.status, agent.result = status, summary
            (forward if self.alive else rt.emit)(state(status, ended_at=time.time(), summary=summary[:500]))
            rt.notify(f"<task-notification>Background agent {agent_id} ({description}) {status}. Its report:\n"
                      f"{summary}</task-notification>")

        from app.harness.runtime import BackgroundAgent

        task = asyncio.create_task(background_run())
        rt.agents[agent_id] = BackgroundAgent(agent_id, description, tool_use_id, task, time.time())
        forward(state("running"))
        return ToolOutput(f"Agent launched in the background (id: {agent_id}). You'll be told when it finishes; "
                          "don't wait for it — carry on or end your turn.",
                          agent={"agent_id": agent_id, "status": "running", "agent_type": subagent_type,
                                 "model": self.model, "is_async": True})

    async def _stop_task(self, task_id: str) -> bool:
        from app.harness.runtime import kill_shell
        from app.harness.tools.shell import task_event

        shell = self.rt.shells.get(task_id)
        if shell is not None and shell.running:
            await kill_shell(shell)
            self.rt.emit(task_event(shell))
            return True
        agent = self.rt.agents.get(task_id)
        if agent is not None and not agent.task.done():
            agent.task.cancel()
            return True
        return False

    # ---- context ----

    def _window(self) -> tuple[int, int]:
        full = int(self.info.get("context_window") or 200_000)
        acw = int(self.req.auto_compact_window or 0)
        window = min(full, acw) if acw else full
        buffer = min(33_000, window // 5)
        return window, max(0, window - buffer)

    def _needs_compaction(self, conv: Conv) -> bool:
        _, threshold = self._window()
        return self.last_prompt > threshold and self.compacted_at != len(conv.view) and len(conv.view) > 2

    def _context_event(self) -> ProviderEvent:
        window, threshold = self._window()
        return ProviderEvent(type="context.update", data={
            "tokens": self.last_prompt, "window": window, "model_window": int(self.info.get("context_window") or window),
            "threshold": threshold, "auto_compact": True, "window_source": "model", "model": self.model,
            "source": "cli"})

    async def _compact(self, conv: Conv, trigger: str, focus: str = "") -> AsyncIterator[ProviderEvent]:
        started = time.monotonic()
        pre = self.last_prompt
        ask = prompts.COMPACT + (f"\nPay special attention to: {focus}" if focus else "")
        view = [*conv.view]
        if view and view[-1]["role"] == "user":
            view = [*view[:-1], {**view[-1], "content": [*view[-1]["content"], {"type": "text", "text": ask}]}]
        else:
            view.append({"role": "user", "content": [{"type": "text", "text": ask}]})
        done: Done | None = None
        async for ev in self._call(conv, tools=False, quiet=True, view=view, max_tokens=20_000):
            if isinstance(ev, Done):
                done = ev
        summary = _text_of(done.message) if done else ""
        if not summary:
            raise _Stop("exec.api.compact_failed", "Could not compact the conversation (the summary came back empty).")
        entry = {"role": "user", "compaction": True, "content": [{"type": "text", "text":
                 "This conversation continues from an earlier part that ran out of room and was summarized:\n\n"
                 f"<summary>\n{summary}\n</summary>\n\nContinue the work from where it stood, without asking the user "
                 "to repeat anything."}]}
        conv.view.clear()
        conv.add({k: v for k, v in entry.items()})
        conv.view[:] = model_view([entry])
        self.compacted_at = len(conv.view)
        post = len(summary) // 4
        self.last_prompt = post
        yield ProviderEvent(type="notice", data={
            "level": "info", "code": "context.compacted", "message": "Conversation compacted",
            "trigger": trigger, "pre_tokens": pre, "post_tokens": post,
            "duration_ms": int((time.monotonic() - started) * 1000)})
        yield self._context_event()

    def _max_tokens(self) -> int | None:
        if self.provider == "anthropic":
            return min(int(self.info.get("max_output") or 32_000), 64_000)
        return None

    # ---- the end ----

    def _complete(self, text: str, conv: Conv) -> dict[str, Any]:
        ephemeral = self.req.ephemeral
        return {"text": text, "model": self.model, **self.spend.fields(), "stop_reason": conv.stop_reason,
                "cli_session_id": None if ephemeral else self.hs,
                "cli_at": None if ephemeral else str(self.store.count(self.hs)),
                "duration_ms": int((time.monotonic() - self.started) * 1000), "num_turns": conv.steps,
                "account": self.keys.label}

    def _error(self, code: str, message: str, err: LLMError | None = None) -> ProviderEvent:
        data: dict[str, Any] = {"code": code, "message": message, "model": self.model or self.req.model, **self.spend.fields()}
        if err is not None:
            data["api_error"] = {"kind": err.kind, "status": err.status, "outcome": err.account_outcome}
        if self.hs and not self.req.ephemeral:
            data["cli_session_id"] = self.hs
        return ProviderEvent(type="error", data=data)

    def _interrupted(self) -> None:
        """Stopped midway: leave the conversation as something the model can go on from."""
        conv = self.conv
        if conv is None:
            return
        with contextlib.suppress(Exception):
            if conv.open_calls:
                uses = {b["id"]: b for m in conv.view[-1:] for b in m.get("content") or [] if b.get("type") == "tool_use"}
                conv.add({"role": "user", "content": [
                    _tool_result_block(uses.get(cid, {"id": cid, "name": "tool"}),
                                       conv.results.get(cid) or ToolOutput.error(INTERRUPTED))
                    for cid in conv.open_calls]})
                conv.open_calls = []
            elif self.partial.strip():
                conv.add({"role": "assistant", "provider": self.provider, "model": self.model,
                          "content": [{"type": "text", "text": self.partial}]})
            conv.add({"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user]"}]})
        if self.req.on_usage is not None:
            with contextlib.suppress(Exception):
                self.req.on_usage(self.spend.fields())


async def run_turn(provider: str, req: TurnRequest, db: Any) -> AsyncIterator[ProviderEvent]:
    turn = HarnessTurn(provider, req, db)
    async for ev in turn.run():
        yield ev


def dumps(ev: ProviderEvent) -> str:  # (debugging)
    return json.dumps(ev.to_dict(), ensure_ascii=False)[:500]
