"""Parse Claude Code CLI ``stream-json`` output into normalized events.

The CLI (``--output-format stream-json --include-partial-messages``) emits one
JSON object per line. The relevant shapes:

* ``{"type":"system","subtype":"init", "session_id": ...}``
* ``{"type":"stream_event","event":{...anthropic streaming event...}}``
    - ``content_block_delta`` with ``text_delta`` / ``thinking_delta`` / ``input_json_delta``
* ``{"type":"assistant","message":{"content":[...blocks...]}}`` — complete turn
* ``{"type":"user","message":{"content":[{"type":"tool_result",...}]}}``
* ``{"type":"result","subtype":"success","result":..., "total_cost_usd":...,
     "usage":{...}, "session_id":...}`` — terminal

This accumulator is intentionally tolerant: unknown lines are ignored. It is a
focused re-implementation of geny-executor's ``StreamJsonAccumulator``.
"""

from __future__ import annotations

import json
from typing import Any, Iterator

from app.providers.base import ProviderEvent


class StreamJsonAccumulator:
    """One turn's worth of stream-json.

    ``total_cost_usd`` on a result line is the cost the CLI *process* has run up
    since it started (a ``--resume``d process starts from 0 again). A one-shot
    turn is its own process, so that is the turn's cost; the persistent engine
    serves many turns from one process and passes ``cost_base`` (the process
    total after the previous turn) so ``cost_usd`` is still this turn's share.
    """

    def __init__(self, *, cost_base: float = 0.0) -> None:
        self._seq = 0
        self.session_id: str | None = None
        self.final_text: str = ""
        self.usage: dict[str, Any] = {}
        self.cost_base = cost_base
        self.cost_total: float = cost_base  # process total as of the last result
        self.cost_usd: float = 0.0          # this turn's API-equivalent cost
        self.stop_reason: str = ""
        self.model: str = ""
        self._seen_tool_ids: set[str] = set()
        # Context size of the main conversation as of its latest API call, and
        # the CLI's typed API error (usage limit, auth…) if a call failed.
        self.context_tokens: int | None = None
        self._ctx_call: str | None = None
        self.api_error: dict[str, Any] | None = None
        self._thinking: dict[int, str] = {}
        self._message_number = 0

    def _ev(self, type_: str, data: dict[str, Any]) -> ProviderEvent:
        self._seq += 1
        return ProviderEvent(type=type_, data=data, seq=self._seq)  # type: ignore[arg-type]

    def feed_line(self, raw: bytes) -> Iterator[ProviderEvent]:
        text = raw.decode(errors="replace").strip()
        if not text:
            return
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            return
        yield from self.feed(obj)

    def feed(self, obj: dict[str, Any]) -> Iterator[ProviderEvent]:
        kind = obj.get("type")

        if kind == "system":
            sub = obj.get("subtype")
            if sub == "init":
                if obj.get("session_id"):
                    self.session_id = obj["session_id"]
                if obj.get("model"):
                    self.model = obj["model"]
                yield self._ev("session.info", {
                    k: obj.get(k)
                    for k in ("model", "cwd", "tools", "slash_commands", "skills", "agents",
                              "mcp_servers", "plugins", "permissionMode", "additional_directories",
                              "claude_code_version", "output_style", "memory_paths",
                              "terminal_slash_commands")
                })
            elif sub == "compact_boundary":
                yield self._ev("notice", compaction_notice(obj.get("compact_metadata") or {}))
            return

        # Messages from inside a subagent (Agent/Task tool) carry the parent
        # tool id: their tool calls nest under that row, and their prose and
        # reasoning become ``subagent.*`` events — never part of the answer.
        parent = obj.get("parent_tool_use_id") or None

        if kind == "stream_event":
            # Subagent output arrives as complete messages (handled below);
            # partial frames for it, should a CLI send them, would duplicate it.
            if not parent:
                yield from self._handle_stream_event(obj.get("event", {}))
            return

        if kind == "assistant":
            if not parent:
                yield from self._main_call(obj)
            yield from self._handle_assistant(obj.get("message", {}), parent)
            return

        if kind == "user":
            yield from self._handle_user(obj.get("message", {}), parent, obj.get("tool_use_result"))
            return

        if kind == "result":
            yield from self._handle_result(obj)
            return

    # ---- partial streaming (text / thinking) ----

    def _handle_stream_event(self, event: dict[str, Any]) -> Iterator[ProviderEvent]:
        etype = event.get("type")
        index = event.get("index", 0)
        if etype == "message_start":
            self._message_number += 1
        elif etype == "content_block_start":
            block = event.get("content_block") or {}
            if block.get("type") in ("thinking", "redacted_thinking"):
                iid = f"claude:{self._message_number}:{index}"
                self._thinking[index] = iid
                yield self._ev("thinking.start", {"id": iid})
                if block.get("thinking"):
                    yield self._ev("thinking.delta", {"id": iid, "text": block["thinking"]})
        elif etype == "content_block_stop" and index in self._thinking:
            yield self._ev("thinking.end", {"id": self._thinking.pop(index)})
        elif etype == "message_stop":
            for iid in self._thinking.values():
                yield self._ev("thinking.end", {"id": iid})
            self._thinking.clear()
        elif etype == "content_block_delta":
            delta = event.get("delta", {})
            dtype = delta.get("type")
            if dtype == "text_delta" and delta.get("text"):
                yield self._ev("text.delta", {"text": delta["text"]})
            elif dtype == "thinking_delta" and delta.get("thinking"):
                yield self._ev("thinking.delta", {"id": self._thinking.get(index), "text": delta["thinking"]})
        elif etype == "message_delta":
            stop = event.get("delta", {}).get("stop_reason")
            if stop:
                self.stop_reason = stop

    # ---- complete assistant turn (tool_use blocks) ----

    def _handle_assistant(self, message: dict[str, Any], parent: str | None = None) -> Iterator[ProviderEvent]:
        if message.get("model") and not parent:
            self.model = message["model"]
        for block in message.get("content", []):
            btype = block.get("type")
            if btype == "tool_use":
                tid = block.get("id", "")
                if tid in self._seen_tool_ids:
                    continue
                self._seen_tool_ids.add(tid)
                data = {"id": tid, "name": block.get("name", ""), "input": block.get("input", {})}
                if parent:
                    data["parent"] = parent
                yield self._ev("tool.use", data)
            elif btype == "text" and block.get("text"):
                if parent:
                    yield self._ev("subagent.text", {"parent": parent, "text": block["text"]})
                else:
                    # Keep the last complete text as the canonical final answer.
                    self.final_text = block["text"]
            elif btype == "thinking" and parent and str(block.get("thinking") or "").strip():
                # (empty when the CLI omits the reasoning display)
                yield self._ev("subagent.thinking", {"parent": parent, "text": block["thinking"]})

    # ---- per API call of the main conversation (not a subagent's) ----

    def _main_call(self, obj: dict[str, Any]) -> Iterator[ProviderEvent]:
        """Context size after each main-conversation API call, and the typed
        API error of a failed one.

        Every call re-sends the whole context, so the context size is that
        call's input + cache read + cache write tokens (the result's usage is
        summed over all calls of the turn — not a context size). One call can
        arrive as several assistant messages (one per content block) with the
        same id: reported once."""
        if obj.get("error") or obj.get("is_api_error_message") or obj.get("api_error"):
            params = obj.get("api_error_params") or {}
            self.api_error = {
                "error": obj.get("error"),
                "kind": obj.get("api_error"),
                "status": obj.get("api_error_status"),
                "rate_limit_info": params.get("rate_limit_info") if isinstance(params, dict) else None,
            }
        message = obj.get("message") or {}
        usage = message.get("usage")
        if not isinstance(usage, dict):
            return
        tokens = 0
        for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            try:
                tokens += int(usage.get(k) or 0)
            except (TypeError, ValueError):
                pass
        call = message.get("id") or obj.get("request_id") or obj.get("uuid")
        if tokens <= 0 or (call and call == self._ctx_call):
            return
        self._ctx_call = call
        self.context_tokens = tokens
        yield self._ev("context.update", {"tokens": tokens, "source": "call", "model": message.get("model")})

    def _api_error_fields(self) -> dict[str, Any]:
        return {"api_error": self.api_error} if self.api_error else {}

    # ---- tool results (arrive as user messages) ----

    def _handle_user(
        self, message: dict[str, Any], parent: str | None = None, structured: Any = None
    ) -> Iterator[ProviderEvent]:
        content = message.get("content", [])
        if not isinstance(content, list):
            return
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                out = block.get("content", "")
                images: list[dict[str, str]] = []
                if isinstance(out, list):
                    texts = []
                    for part in out:
                        if not isinstance(part, dict):
                            continue
                        if part.get("type") == "image" and isinstance(part.get("source"), dict):
                            src = part["source"]
                            if src.get("type") == "base64" and src.get("data"):
                                # Raw image the tool returned (e.g. a screenshot the agent
                                # Read). The session layer stores it as a file.
                                images.append({"media_type": src.get("media_type", "image/png"), "data": src["data"]})
                        else:
                            texts.append(part.get("text", ""))
                    out = "".join(texts)
                data = {
                    "id": block.get("tool_use_id", ""),
                    "output": out,
                    "is_error": bool(block.get("is_error", False)),
                }
                if images:
                    data["images"] = images
                if parent:
                    data["parent"] = parent
                agent = _agent_result(structured)
                if agent:
                    data["agent"] = agent
                yield self._ev("tool.result", data)

    # ---- terminal result ----

    def _handle_result(self, obj: dict[str, Any]) -> Iterator[ProviderEvent]:
        if obj.get("session_id"):
            self.session_id = obj["session_id"]
        if isinstance(obj.get("result"), str) and obj["result"]:
            self.final_text = obj["result"]
        self.usage = obj.get("usage", {}) or {}
        try:
            total = float(obj.get("total_cost_usd", 0.0) or 0.0)
        except (TypeError, ValueError):
            total = self.cost_base
        # A total below the base means the counter restarted: all of it is new.
        self.cost_usd = round(total - self.cost_base if total >= self.cost_base else total, 6)
        self.cost_total = total
        # Failed / stopped turns still used tokens: their cost travels on the error.
        spent = {"usage": self.usage, **self.cost_fields(), **self._api_error_fields()}

        if obj.get("subtype") not in (None, "success"):
            reasons = {
                "error_max_turns": "the agent hit its maximum number of turns",
                "error_during_execution": "the agent stopped because of an execution error",
            }
            sub = obj.get("subtype", "unknown")
            errs = [str(e) for e in (obj.get("errors") or []) if e]
            yield self._ev(
                "error",
                {"code": f"exec.cli.{sub}", "message": "; ".join(errs) or reasons.get(sub, sub), **spent},
            )
            return
        if obj.get("is_error"):
            # API-level failures (auth expired, usage limit, overloaded…) arrive
            # as a "success" result flagged is_error, with the reason as text.
            yield self._ev(
                "error",
                {"code": "exec.cli.api_error", "message": str(obj.get("result") or "API error"), **spent},
            )
            return

        yield self._ev(
            "turn.complete",
            {
                "text": self.final_text,
                "model": self.model,
                "usage": self.usage,
                **self.cost_fields(),
                "stop_reason": self.stop_reason,
                "cli_session_id": self.session_id,
                "duration_ms": obj.get("duration_ms"),
                "num_turns": obj.get("num_turns"),
            },
        )

    def cost_fields(self) -> dict[str, Any]:
        """Cost keys of a terminal event. ``cost_kind: "turn"`` marks a value
        that is already per turn (events from before it may be cumulative —
        see ``app.services.turn_cost``)."""
        return {"cost_usd": self.cost_usd, "cost_kind": "turn", "process_cost_usd": round(self.cost_total, 6)}


def compaction_notice(meta: dict[str, Any]) -> dict[str, Any]:
    """``compact_boundary`` -> a ``context.compacted`` notice (rendered as a
    divider): auto/manual, and the context size before -> after."""
    trigger = meta.get("trigger") if meta.get("trigger") in ("auto", "manual") else None
    pre, post = meta.get("pre_tokens"), meta.get("post_tokens")
    pre = pre if isinstance(pre, int) else None
    post = post if isinstance(post, int) else None

    def k(n: int) -> str:
        return f"{n / 1000:.0f}k" if n >= 10_000 else f"{n:,}"

    sizes = f"{k(pre)} → {k(post)} tokens" if pre is not None and post is not None else (
        f"was {k(pre)} tokens" if pre is not None else "")
    what = {"auto": "Context auto-compacted", "manual": "Context compacted"}.get(trigger or "", "Context compacted")
    return {
        "level": "info", "code": "context.compacted",
        "message": what + (f" ({sizes})" if sizes else ""),
        "trigger": trigger, "pre_tokens": pre, "post_tokens": post,
        "duration_ms": meta.get("duration_ms") if isinstance(meta.get("duration_ms"), (int, float)) else None,
    }


_AGENT_FIELDS = (
    ("status", "status"), ("agentType", "agent_type"), ("resolvedModel", "model"),
    ("totalDurationMs", "duration_ms"), ("totalTokens", "total_tokens"),
    ("totalToolUseCount", "tool_uses"), ("isAsync", "is_async"),
)


def _agent_result(structured: Any) -> dict[str, Any] | None:
    """Summary of an Agent/Task tool result from the CLI's structured
    ``tool_use_result``: the subagent's clean final report and run stats,
    without the hand-back framing the model sees in the text result."""
    if not isinstance(structured, dict) or not structured.get("agentId"):
        return None
    out: dict[str, Any] = {"agent_id": str(structured["agentId"])}
    for src, dst in _AGENT_FIELDS:
        if structured.get(src) is not None:
            out[dst] = structured[src]
    content = structured.get("content")
    if isinstance(content, list):
        text = "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
        if text:
            out["result"] = text
    return out
