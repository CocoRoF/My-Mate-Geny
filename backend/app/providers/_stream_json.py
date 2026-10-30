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
    def __init__(self) -> None:
        self._seq = 0
        self.session_id: str | None = None
        self.final_text: str = ""
        self.usage: dict[str, Any] = {}
        self.cost_usd: float = 0.0
        self.stop_reason: str = ""
        self.model: str = ""
        self._seen_tool_ids: set[str] = set()

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
                meta = obj.get("compact_metadata") or {}
                pre = meta.get("pre_tokens")
                yield self._ev("notice", {
                    "level": "info", "code": "context.compacted",
                    "message": "Conversation context was compacted"
                               + (f" (was {pre:,} tokens)" if isinstance(pre, int) else ""),
                })
            return

        if kind == "stream_event":
            yield from self._handle_stream_event(obj.get("event", {}))
            return

        if kind == "assistant":
            yield from self._handle_assistant(obj.get("message", {}))
            return

        if kind == "user":
            yield from self._handle_user(obj.get("message", {}))
            return

        if kind == "result":
            yield from self._handle_result(obj)
            return

    # ---- partial streaming (text / thinking) ----

    def _handle_stream_event(self, event: dict[str, Any]) -> Iterator[ProviderEvent]:
        etype = event.get("type")
        if etype == "content_block_delta":
            delta = event.get("delta", {})
            dtype = delta.get("type")
            if dtype == "text_delta" and delta.get("text"):
                yield self._ev("text.delta", {"text": delta["text"]})
            elif dtype == "thinking_delta" and delta.get("thinking"):
                yield self._ev("thinking.delta", {"text": delta["thinking"]})
        elif etype == "message_delta":
            stop = event.get("delta", {}).get("stop_reason")
            if stop:
                self.stop_reason = stop

    # ---- complete assistant turn (tool_use blocks) ----

    def _handle_assistant(self, message: dict[str, Any]) -> Iterator[ProviderEvent]:
        if message.get("model"):
            self.model = message["model"]
        for block in message.get("content", []):
            btype = block.get("type")
            if btype == "tool_use":
                tid = block.get("id", "")
                if tid in self._seen_tool_ids:
                    continue
                self._seen_tool_ids.add(tid)
                yield self._ev(
                    "tool.use",
                    {"id": tid, "name": block.get("name", ""), "input": block.get("input", {})},
                )
            elif btype == "text" and block.get("text"):
                # Keep the last complete text as the canonical final answer.
                self.final_text = block["text"]

    # ---- tool results (arrive as user messages) ----

    def _handle_user(self, message: dict[str, Any]) -> Iterator[ProviderEvent]:
        content = message.get("content", [])
        if not isinstance(content, list):
            return
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                out = block.get("content", "")
                if isinstance(out, list):
                    out = "".join(
                        part.get("text", "") for part in out if isinstance(part, dict)
                    )
                yield self._ev(
                    "tool.result",
                    {
                        "id": block.get("tool_use_id", ""),
                        "output": out,
                        "is_error": bool(block.get("is_error", False)),
                    },
                )

    # ---- terminal result ----

    def _handle_result(self, obj: dict[str, Any]) -> Iterator[ProviderEvent]:
        if obj.get("session_id"):
            self.session_id = obj["session_id"]
        if isinstance(obj.get("result"), str) and obj["result"]:
            self.final_text = obj["result"]
        self.usage = obj.get("usage", {}) or {}
        self.cost_usd = float(obj.get("total_cost_usd", 0.0) or 0.0)

        if obj.get("subtype") not in (None, "success"):
            reasons = {
                "error_max_turns": "the agent hit its maximum number of turns",
                "error_during_execution": "the agent stopped because of an execution error",
            }
            sub = obj.get("subtype", "unknown")
            yield self._ev(
                "error",
                {"code": f"exec.cli.{sub}", "message": reasons.get(sub, sub)},
            )
            return
        if obj.get("is_error"):
            # API-level failures (auth expired, usage limit, overloaded…) arrive
            # as a "success" result flagged is_error, with the reason as text.
            yield self._ev(
                "error",
                {"code": "exec.cli.api_error", "message": str(obj.get("result") or "API error")},
            )
            return

        yield self._ev(
            "turn.complete",
            {
                "text": self.final_text,
                "model": self.model,
                "usage": self.usage,
                "cost_usd": self.cost_usd,
                "stop_reason": self.stop_reason,
                "cli_session_id": self.session_id,
                "duration_ms": obj.get("duration_ms"),
                "num_turns": obj.get("num_turns"),
            },
        )
