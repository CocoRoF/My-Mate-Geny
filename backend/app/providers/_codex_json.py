"""Parse Codex CLI ``exec --json`` output into normalized events.

Codex JSONL schema (verified against codex-cli 0.166 with a live run):

* ``{"type":"thread.started","thread_id":"..."}``          -> resumable id
* ``{"type":"turn.started"}``
* ``{"type":"item.started"|"item.updated"|"item.completed","item":{...}}``
    - ``agent_message``      {text}                         -> assistant text
    - ``reasoning``          {text}                         -> thinking
    - ``command_execution``  {command, aggregated_output, exit_code, status}
    - ``file_change``        {changes:[{path, kind}], status}
    - ``mcp_tool_call``      {server, tool, arguments, result|error, status}
    - ``web_search``         {query}
    - ``todo_list``          {items:[{text, completed}]}
    - ``error``              {message}  — a NON-fatal warning (e.g. "Model
                                          metadata … not found"); the turn goes on
* ``{"type":"turn.completed","usage":{...}}``               -> success
* ``{"type":"turn.failed","error":{"message":...}}``        -> failure
* ``{"type":"error","message":...}``                        -> transient (retries,
                                                               reconnects); fatal only
                                                               if the turn never completes

Only a missing ``turn.completed`` makes the turn an error, so one warning no
longer ends the turn (or splits it into several error bubbles).
"""

from __future__ import annotations

import json
from typing import Any, Iterator

from app.providers.base import ProviderEvent


def _text_of(item: dict[str, Any]) -> str:
    for k in ("text", "message", "content", "delta"):
        v = item.get(k)
        if isinstance(v, str) and v:
            return v
    return ""


def _short(value: Any, limit: int = 20000) -> str:
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return s if len(s) <= limit else s[:limit] + "\n… (truncated)"


class CodexJsonAccumulator:
    def __init__(self) -> None:
        self._seq = 0
        self.thread_id: str | None = None
        self.final_text: str = ""
        self.usage: dict[str, Any] = {}
        self.completed = False
        self.failed: str | None = None      # message from turn.failed
        self.last_error: str | None = None  # last transient/item error (diagnostics)
        self._started: set[str] = set()
        self._text_so_far: dict[str, str] = {}
        self._todos_seen: dict[str, str] = {}
        self._open: set[str] = set()

    def _ev(self, type_: str, data: dict[str, Any]) -> ProviderEvent:
        if type_ == "tool.result":
            self._open.discard(str(data.get("id")))
        self._seq += 1
        return ProviderEvent(type=type_, data=data, seq=self._seq)  # type: ignore[arg-type]

    def feed_line(self, raw: bytes) -> Iterator[ProviderEvent]:
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
        elif etype in ("item.started", "item.updated", "item.completed"):
            yield from self._handle_item(etype, obj.get("item", {}) or {})
        elif etype == "turn.completed":
            self.completed = True
            self.usage = obj.get("usage", {}) or {}
        elif etype == "turn.failed":
            err = obj.get("error") or {}
            self.failed = (err.get("message") if isinstance(err, dict) else str(err)) or "codex turn failed"
        elif etype == "error":
            msg = str(obj.get("message") or "codex error")
            self.last_error = msg
            yield self._ev("notice", {"level": "warning", "code": "codex.error", "message": msg})

    # ---- items ----

    def _tool(self, etype: str, iid: str, name: str, inp: Any) -> Iterator[ProviderEvent]:
        if iid not in self._started:
            self._started.add(iid)
            self._open.add(iid)
            yield self._ev("tool.use", {"id": iid, "name": name, "input": inp})

    def close_open_tools(self, note: str) -> Iterator[ProviderEvent]:
        """Finish tool calls cut off by an interrupt (so none spin forever)."""
        for iid in sorted(self._open):
            yield self._ev("tool.result", {"id": iid, "output": note, "is_error": False})
        self._open.clear()

    def begin_run(self) -> None:
        """Reset per-process state before a resumed run in the same turn."""
        self.completed = False
        self.failed = None

    def _handle_item(self, etype: str, item: dict[str, Any]) -> Iterator[ProviderEvent]:
        itype = item.get("type", "")
        iid = str(item.get("id", ""))
        done = etype == "item.completed"

        if itype in ("agent_message", "assistant_message", "message"):
            txt = _text_of(item)
            # Emit only what's new so updates + completion don't duplicate text.
            prev = self._text_so_far.get(iid, "")
            if txt and txt.startswith(prev) and len(txt) > len(prev):
                yield self._ev("text.delta", {"text": txt[len(prev):]})
            elif txt and not txt.startswith(prev):
                yield self._ev("text.delta", {"text": txt})
            if txt:
                self._text_so_far[iid] = txt
            if done and txt:
                self.final_text = txt

        elif itype in ("reasoning", "thinking"):
            txt = _text_of(item)
            prev = self._text_so_far.get(iid, "")
            if txt and txt != prev:
                yield self._ev("thinking.delta", {"text": txt[len(prev):] if txt.startswith(prev) else txt})
                self._text_so_far[iid] = txt

        elif itype in ("command_execution", "exec_command", "shell"):
            cmd = item.get("command") or item.get("cmd") or item.get("input")
            yield from self._tool(etype, iid, "shell", {"command": cmd})
            if done:
                out = item.get("aggregated_output") or item.get("stdout") or item.get("output") or ""
                code = item.get("exit_code")
                text = _short(out)
                if code not in (0, None):
                    text = f"{text}\n[exit code {code}]".strip()
                yield self._ev("tool.result", {"id": iid, "output": text, "is_error": code not in (0, None)})

        elif itype == "file_change":
            changes = item.get("changes") or []
            yield from self._tool(etype, iid, "apply_patch", {"changes": changes})
            if done:
                lines = [f"{c.get('kind', 'update')}: {c.get('path', '')}" for c in changes if isinstance(c, dict)]
                failed = item.get("status") == "failed"
                yield self._ev("tool.result", {"id": iid, "output": "\n".join(lines) or "applied", "is_error": failed})

        elif itype == "mcp_tool_call":
            name = f"mcp__{item.get('server', 'mcp')}__{item.get('tool', 'tool')}"
            yield from self._tool(etype, iid, name, item.get("arguments") or {})
            if done:
                err = item.get("error")
                result = item.get("result")
                out = err.get("message") if isinstance(err, dict) else err
                yield self._ev("tool.result", {
                    "id": iid, "output": _short(out if err else (result if result is not None else "")),
                    "is_error": bool(err) or item.get("status") == "failed",
                })

        elif itype == "web_search":
            yield from self._tool(etype, iid, "web_search", {"query": item.get("query", "")})
            if done:
                yield self._ev("tool.result", {"id": iid, "output": "searched", "is_error": False})

        elif itype == "todo_list":
            todos = [
                {"content": t.get("text", ""), "status": "completed" if t.get("completed") else "pending"}
                for t in (item.get("items") or [])
                if isinstance(t, dict)
            ]
            key = json.dumps(todos, sort_keys=True)
            if self._todos_seen.get(iid) == key:
                return  # started/updated/completed often repeat the same list
            self._todos_seen[iid] = key
            # Same shape as Claude's TodoWrite so the UI renders one checklist.
            tid = f"{iid}:{len(self._started)}"
            yield from self._tool(etype, tid, "TodoWrite", {"todos": todos})
            yield self._ev("tool.result", {"id": tid, "output": "todos updated", "is_error": False})

        elif itype == "error":
            msg = _text_of(item) or "codex warning"
            self.last_error = msg
            yield self._ev("notice", {"level": "warning", "code": "codex.warning", "message": msg})

    # ---- terminal ----

    def terminal(self, *, model: str, cli_session_id: str | None) -> ProviderEvent:
        self._seq += 1
        if self.failed or not self.completed:
            return ProviderEvent(
                type="error",
                data={
                    "code": "exec.cli.codex_error",
                    "message": self.failed or self.last_error or "codex ended without completing the turn",
                },
                seq=self._seq,
            )
        return ProviderEvent(
            type="turn.complete",
            data={
                "text": self.final_text,
                "model": model,
                "usage": self.usage,
                "cost_usd": 0.0,  # codex reports tokens, not cost
                "cost_kind": "none",
                "stop_reason": "end_turn",
                "cli_session_id": self.thread_id or cli_session_id,
            },
            seq=self._seq,
        )
