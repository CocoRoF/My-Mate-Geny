"""Lite history pages: the same chat state in far fewer bytes.

A history page ships every event of its turns, and the client folds them into
turns (frontend ``chatStore.reconstruct``: messages and events on one timeline,
sorted by ``(timestamp, message-before-event, eid)``). Most of the bytes are
things the folded state holds once or that no collapsed row shows. A client
that asks (``?lite=1``, only the new frontend does) gets:

1. **Tool payloads as previews.** Big tool inputs / outputs travel as a preview
   plus ``event.lazy`` (``{"input": {...}}`` / ``{"output": {...}}``: the
   original size and what was cut). Everything a collapsed tool row, the
   group header, the "Changed files" / todo panels, subagent cards and mate
   chips read stays exact; the client fetches the original event
   (``POST /api/history/{sid}/events``) when it opens the row / diff / modal.
   Per tool (``_lite_input`` / ``_lite_result``):

   * inputs up to about ``INPUT_KEEP`` chars of JSON, TodoWrite (the todo panel) and
     the mate's tools travel whole;
   * what a call acts on (``file_path``, ``path``, ``url``, ``pattern``,
     ``description``, … : ``_ADDRESS_KEYS``) is never cut;
   * Edit / MultiEdit / Write / NotebookEdit: the file content (old/new
     strings, edits, content, new source) is left out as a unit — never cut
     into — the path and flags stay;
   * apply_patch: each change keeps its path / kind / move path and small
     fields; big ones (the diff text) are left out;
   * anything else (Bash command, an Agent's prompt, MCP arguments): strings
     longer than ``STR_PREVIEW`` are cut to their start (a row shows one
     truncated line), other values over it are left out; key order stays (a
     row shows the first string argument);
   * results: failed ones (the "stopped" test reads them), Agent / Task
     reports without ``agent.result`` (the subagent card reads the report from
     the output then), the mate's tools, non-text outputs and anything up to
     ``OUTPUT_KEEP`` chars travel whole; others as their first
     ``OUTPUT_PREVIEW`` chars. ``images`` / ``agent`` / ``is_error`` stay.

   The previews are short on purpose: no collapsed row shows them (only the
   expanded row while the original loads), and a busy turn holds hundreds of
   calls.

2. **Deltas merged.** A run of ``text.delta`` (or ``thinking.delta``) events
   next to each other on that timeline folds into one event with the joined
   text: the first one's timestamp (it closes a thinking block / starts one),
   the last one's eid (``last_eid`` and ordering stay right).

3. **Task snapshots folded.** The client merges each ``task.update`` into its
   call's task state (``{...task, ...data}``). Updates of one call between two
   turn boundaries (where finished turns read that state) fold into one event
   at the last one's place, its data the merge of theirs; ``event.covers``
   lists the eids it stands for (an older page drops pinned copies by eid).
   ``context.update`` events are left out: a paged client takes the context
   meter from ``summary.context`` and its replay ignores them.

4. **Echoed answers left out.** A ``turn.complete`` repeats the answer as
   ``text``; the client only uses it for a turn that streamed none. Where the
   turn certainly streamed some, it is left out (``_drop_echoed_text``).

The running turn (``live_from`` on): its tool payloads stay whole, as they
stream. Merging and folding are exact there too.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Mapping

LITE_VERSION = 1

INPUT_KEEP = 320  # a tool input up to about this many chars of JSON travels whole
STR_PREVIEW = 200  # a cut string argument keeps this many chars (more than a row shows)
SMALL_VALUE = 256  # an apply_patch change keeps fields up to this size
OUTPUT_KEEP = 512  # a tool output up to this many chars travels whole
OUTPUT_PREVIEW = 256  # ... else its first chars (shown while the rest loads)

# Edit-family inputs: the content keys, left out as a unit.
_CONTENT_KEYS = {
    "edit": ("old_string", "new_string"),
    "multiedit": ("edits",),
    "write": ("content",),
    "remote_write": ("content",),
    "notebookedit": ("new_source",),
}
_WHOLE_INPUT = ("todowrite",)
# Input fields that name what a call acts on: never cut (a row links the path,
# the changed-files panel lists it, an image read shows from it, …).
_ADDRESS_KEYS = {"file_path", "path", "notebook_path", "move_path", "kind", "url", "description",
                 "subagent_type", "skill", "pattern", "query", "session_id", "workspace_path"}
_WHOLE_RESULT = ("task", "agent")
# Events whose reduction can read a call's task state (finishing a turn) or
# opens a new turn: a task.update never folds across one.
_FOLD_SAFE = {"text.delta", "thinking.delta", "tool.use", "tool.result", "subagent.text", "subagent.thinking",
              "task.update", "turn.changes"}
_DELTAS = ("text.delta", "thinking.delta")


def _norm(name: Any) -> str:
    n = str(name or "")
    if n.startswith("mcp__remote__"):
        n = n[len("mcp__remote__"):]
    return n.lower()


def _vsize(v: Any) -> int:
    """About the JSON length of a value (chars; strings without escapes)."""
    if isinstance(v, str):
        return len(v) + 2
    if v is None or isinstance(v, (bool, int, float)):
        return 8
    return len(json.dumps(v, ensure_ascii=False))


def _is_mate(name: Any) -> bool:
    return str(name or "").startswith("mcp__mate__")


# ---- 1. tool payloads ----

def _lite_input(name: Any, inp: Any) -> tuple[Any, dict[str, Any]] | None:
    """(preview input, lazy info), or None when the input travels whole."""
    if not isinstance(inp, dict):
        return None
    n = _norm(name)
    if n in _WHOLE_INPUT or _is_mate(name):
        return None
    sizes = {k: _vsize(v) for k, v in inp.items()}
    size = sum(sizes.values()) + sum(len(k) + 4 for k in inp) + 2
    if size <= INPUT_KEEP:
        return None
    content = _CONTENT_KEYS.get(n, ())
    out: dict[str, Any] = {}
    cut: list[str] = []
    for k, v in inp.items():
        if k in content:
            cut.append(k)
            continue
        if k in _ADDRESS_KEYS and isinstance(v, str):
            out[k] = v  # (whole, however long: rows link it, panels list it)
            continue
        if n == "apply_patch" and k == "changes" and isinstance(v, list):
            changes = []
            for c in v:
                if isinstance(c, dict):
                    small = {ck: cv for ck, cv in c.items() if ck in _ADDRESS_KEYS or _vsize(cv) <= SMALL_VALUE}
                    if len(small) != len(c):
                        cut.append(k)
                    changes.append(small)
                else:
                    changes.append(c)
            out[k] = changes
            continue
        if isinstance(v, str):
            if len(v) > STR_PREVIEW:
                out[k] = v[:STR_PREVIEW]
                cut.append(k)
            else:
                out[k] = v
        elif sizes[k] > STR_PREVIEW:
            cut.append(k)
        else:
            out[k] = v
    if not cut:
        return None
    return out, {"size": size, "cut": sorted(set(cut))}


def _lite_result(name: str | None, data: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    out = data.get("output")
    if not isinstance(out, str) or len(out) <= OUTPUT_KEEP:
        return None
    if data.get("is_error") or name is None or _is_mate(name):
        return None
    agent = data.get("agent")
    if _norm(name) in _WHOLE_RESULT and not (isinstance(agent, dict) and isinstance(agent.get("result"), str)
                                             and agent["result"]):
        return None  # (the subagent card reads its report from the output)
    return {**data, "output": out[:OUTPUT_PREVIEW]}, {"size": len(out), "lines": out.count("\n") + 1}


def _lite_tool_event(e: dict[str, Any], names: Mapping[str, str]) -> dict[str, Any]:
    d = e.get("data")
    if not isinstance(d, dict):
        return e
    if e["type"] == "tool.use":
        r = _lite_input(d.get("name"), d.get("input"))
        if r is not None:
            return {**e, "data": {**d, "input": r[0]}, "lazy": {"input": r[1]}}
    elif e["type"] == "tool.result":
        name = names.get(str(d.get("id"))) if d.get("id") is not None else None
        r2 = _lite_result(name, d)
        if r2 is not None:
            return {**e, "data": r2[0], "lazy": {"output": r2[1]}}
    return e


def lite_payloads(events: Iterable[dict[str, Any]], names: Mapping[str, str],
                  live_from: str | None = None) -> list[dict[str, Any]]:
    """Tool payloads as previews (events at / after ``live_from`` stay whole)."""
    return [e if live_from is not None and e["timestamp"] >= live_from else _lite_tool_event(e, names)
            for e in events]


# ---- the timeline (chatStore.reconstruct's order) ----

def _timeline(messages: list[dict[str, Any]], events: list[dict[str, Any]]) -> list[dict[str, Any] | None]:
    """Events in the client's replay order; None marks a message (any role)."""
    items = [((m.get("created_at") or ""), 0, 0, None) for m in messages]
    items += [((e.get("timestamp") or ""), 1, e.get("eid") or 0, e) for e in events]
    items.sort(key=lambda x: x[:3])
    return [x[3] for x in items]


def _fold_tasks(line: list[dict[str, Any] | None]) -> list[dict[str, Any] | None]:
    seg = 0
    epoch: dict[str, int] = {}  # tool.use events per call id so far (a call's turn is fixed between them)
    groups: dict[tuple[int, str, int], list[int]] = {}
    for i, e in enumerate(line):
        if e is None or e["type"] not in _FOLD_SAFE:
            seg += 1
            continue
        d = e["data"]
        if e["type"] == "tool.use" and isinstance(d, dict) and isinstance(d.get("id"), str):
            epoch[d["id"]] = epoch.get(d["id"], 0) + 1
        elif e["type"] == "task.update" and isinstance(d, dict) and isinstance(d.get("tool_use_id"), str) \
                and d["tool_use_id"]:
            tid = d["tool_use_id"]
            groups.setdefault((seg, tid, epoch.get(tid, 0)), []).append(i)
    out = list(line)
    for idx in groups.values():
        if len(idx) < 2:
            continue
        merged: dict[str, Any] = {}
        for i in idx:
            merged.update(line[i]["data"])  # type: ignore[index]
        last = line[idx[-1]]
        assert last is not None
        out[idx[-1]] = {**last, "data": merged, "covers": [line[i]["eid"] for i in idx]}  # type: ignore[index]
        for i in idx[:-1]:
            out[i] = _GONE
    return [e for e in out if e is not _GONE]


_GONE: dict[str, Any] = {"type": "_gone"}


def _mergeable(e: dict[str, Any] | None) -> bool:
    return e is not None and e["type"] in _DELTAS and isinstance(e["data"], dict) \
        and "text" in e["data"] and set(e["data"]) <= {"text", "id", "parent"} and isinstance(e["data"]["text"], str)


def _merge_deltas(line: list[dict[str, Any] | None]) -> list[dict[str, Any] | None]:
    out: list[dict[str, Any] | None] = []
    run: list[dict[str, Any]] = []

    def flush() -> None:
        if len(run) == 1:
            out.append(run[0])
        elif run:
            first, last = run[0], run[-1]
            out.append({**first, "eid": last["eid"], "seq": last["seq"],
                        "data": {**first["data"], "text": "".join(e["data"]["text"] for e in run)}})
        run.clear()

    for e in line:
        if _mergeable(e) and (not run or (run[-1]["type"] == e["type"] and  # type: ignore[index]
                all(run[-1]["data"].get(k) == e["data"].get(k) for k in ("id", "parent")))):  # type: ignore[index]
            run.append(e)  # type: ignore[arg-type]
            continue
        flush()
        if _mergeable(e):
            run.append(e)  # type: ignore[arg-type]
        else:
            out.append(e)
    flush()
    return out


_JS_BLANK_EXTRA = "﻿"  # (JS trim() strips it; Python's isspace() doesn't)


def _shows(text: str) -> bool:
    """``text.trim()`` is non-empty in JS (a conservative test)."""
    return any(not c.isspace() and c not in _JS_BLANK_EXTRA for c in text)


def _drop_echoed_text(line: list[dict[str, Any] | None]) -> list[dict[str, Any] | None]:
    """A turn.complete's ``text`` is the answer the deltas already streamed; the
    client only uses it for a turn that has no text. Left out where the turn
    certainly has some: a non-blank text.delta since the session.start that
    opened it, and nothing between that could start another turn (anything but
    steps inside the turn: a notice may add a system turn, …)."""
    out: list[dict[str, Any] | None] = []
    opened = has_text = False
    for e in line:
        if e is None:
            opened = has_text = False
        elif e["type"] == "text.delta":
            d = e["data"]
            if opened and isinstance(d, dict) and isinstance(d.get("text"), str) and _shows(d["text"]):
                has_text = True
        elif e["type"] not in _FOLD_SAFE:
            d = e["data"]
            if e["type"] == "turn.complete" and opened and has_text and isinstance(d, dict) and d.get("text"):
                e = {**e, "data": {k: v for k, v in d.items() if k != "text"}}
            opened = e["type"] == "session.start"
            has_text = False
        out.append(e)
    return out


def lite_events(messages: list[dict[str, Any]], events: list[dict[str, Any]], names: Mapping[str, str],
                *, live_from: str | None = None) -> list[dict[str, Any]]:
    """A page's events, lite (see the module doc), in id order."""
    line = [e for e in _timeline(messages, events) if e is None or e["type"] != "context.update"]
    line = _drop_echoed_text(_merge_deltas(_fold_tasks(line)))
    evs = [e for e in line if e is not None]
    evs.sort(key=lambda e: e.get("eid") or 0)
    return lite_payloads(evs, names, live_from)
