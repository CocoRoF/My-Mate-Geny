"""Parse Codex CLI ``exec --json`` output into normalized events.

Codex 0.165's JSONL event schema (observed):

* ``{"type":"thread.started","thread_id":"..."}``        -> resumable id
* ``{"type":"turn.started"}``
* ``{"type":"item.started"|"item.updated"|"item.completed","item":{...}}``
    item.type ∈ {agent_message, reasoning, command_execution, error, ...}
* ``{"type":"turn.completed","usage":{...}}``
* ``{"type":"error","message":"..."}``

The accumulator is defensive about exact field names (they drift between Codex
versions): it reads text from several likely keys and treats unknown item types
as no-ops. Field names should be confirmed against a live authenticated run.
"""

from __future__ import annotations

from typing import Any, Iterator

from app.providers.base import ProviderEvent


def _text_of(item: dict[str, Any]) -> str:
    for k in ("text", "message", "content", "delta"):
        v = item.get(k)
        if isinstance(v, str) and v:
            return v
    return ""


class CodexJsonAccumulator:
    def __init__(self) -> None:
        self._seq = 0
        self.thread_id: str | None = None
        self.final_text: str = ""
        self.usage: dict[str, Any] = {}
        self._emitted_tool: set[str] = set()

    def _ev(self, type_: str, data: dict[str, Any]) -> ProviderEvent:
        self._seq += 1
        return ProviderEvent(type=type_, data=data, seq=self._seq)  # type: ignore[arg-type]

    def feed_line(self, raw: bytes) -> Iterator[ProviderEvent]:
        import json

        text = raw.decode(errors="replace").strip()
        if not text or not text.startswith("{"):
            return  # skip non-JSON log lines
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            return
        yield from self.feed(obj)

    def feed(self, obj: dict[str, Any]) -> Iterator[ProviderEvent]:
        etype = obj.get("type", "")

        if etype == "thread.started":
            self.thread_id = obj.get("thread_id")
            return

        if etype in ("item.started", "item.updated", "item.completed"):
            yield from self._handle_item(etype, obj.get("item", {}))
            return

        if etype == "turn.completed":
            self.usage = obj.get("usage", {}) or {}
            return

        if etype in ("error", "turn.failed"):
            msg = obj.get("message") or obj.get("error", {}).get("message", "codex error")
            yield self._ev("error", {"code": "exec.cli.codex_error", "message": str(msg)})
            return

    def _handle_item(self, etype: str, item: dict[str, Any]) -> Iterator[ProviderEvent]:
        itype = item.get("type", "")
        iid = str(item.get("id", ""))

        if itype in ("agent_message", "assistant_message", "message"):
            txt = _text_of(item)
            if etype == "item.completed" and txt:
                self.final_text = txt
                yield self._ev("text.delta", {"text": txt})
            elif etype == "item.updated" and txt:
                yield self._ev("text.delta", {"text": txt})

        elif itype in ("reasoning", "thinking"):
            txt = _text_of(item)
            if txt:
                yield self._ev("thinking.delta", {"text": txt})

        elif itype in ("command_execution", "exec_command", "shell"):
            cmd = item.get("command") or item.get("cmd") or item.get("input")
            if etype == "item.started" and iid not in self._emitted_tool:
                self._emitted_tool.add(iid)
                yield self._ev("tool.use", {"id": iid, "name": "shell", "input": cmd})
            elif etype == "item.completed":
                out = item.get("aggregated_output") or item.get("stdout") or item.get("output") or ""
                exit_code = item.get("exit_code", 0)
                yield self._ev(
                    "tool.result",
                    {"id": iid, "output": str(out)[:8000], "is_error": bool(exit_code)},
                )

        elif itype == "error":
            yield self._ev(
                "error", {"code": "exec.cli.codex_error", "message": _text_of(item) or "codex error"}
            )

    def terminal(self, cli_session_id: str | None) -> ProviderEvent:
        self._seq += 1
        return ProviderEvent(
            type="turn.complete",
            data={
                "text": self.final_text,
                "model": "codex",
                "usage": self.usage,
                "cost_usd": 0.0,  # codex reports tokens, not cost
                "stop_reason": "end_turn",
                "cli_session_id": cli_session_id or self.thread_id,
            },
            seq=self._seq,
        )
