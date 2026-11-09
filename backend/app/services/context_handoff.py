"""Carry conversation context across engines (Claude Code <-> Codex).

Each provider keeps its OWN CLI session per chat plus a watermark of how much
of the chat it has seen. Before a turn, whatever that engine hasn't seen is
rendered here as a compact transcript and prepended to the user's message:

* first turn on an engine in this chat -> full handoff of the conversation;
* returning to an engine that has a session -> it resumes that session and
  gets a "meanwhile" catch-up of only the turns another engine ran.

A transcript block is: the user's message(s), the agent's final answer and a
one-line-per-action summary of what it did (commands, files read/edited…),
newest kept first within a character budget.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

ENGINE_LABEL = {"claude": "Claude Code", "codex": "Codex", "anthropic": "Anthropic (API)", "openai": "OpenAI (API)",
                "google": "Google (API)"}

_BUDGET = 60_000          # total characters of transcript
_PER_MESSAGE = 6_000      # cap for any single message
_MAX_ACTIONS = 15         # action lines per agent turn


@dataclass
class Block:
    user: list[str] = field(default_factory=list)       # user + mid-turn messages
    engine: str | None = None
    model: str | None = None
    answer: str | None = None
    actions: list[str] = field(default_factory=list)
    outcome: str | None = None                           # failed / stopped note


def _clip(text: str, n: int = _PER_MESSAGE) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[:n] + f" … [{len(text) - n} more characters]"


def _short(value: Any, n: int = 140) -> str:
    s = " ".join(str(value or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def describe_action(name: str, inp: Any) -> str | None:
    i = inp if isinstance(inp, dict) else {}
    n = name[13:] if name.startswith("mcp__remote__") else name
    low = n.lower()
    path = i.get("file_path") or i.get("path") or i.get("notebook_path") or ""
    if low in ("bash", "shell", "remote_bash"):
        cmd = i.get("command") if isinstance(i, dict) else inp
        if isinstance(cmd, list):
            cmd = " ".join(map(str, cmd))
        return f"ran `{_short(cmd)}`"
    if low in ("read", "remote_read"):
        return f"read {path}"
    if low == "remote_list":
        return f"listed {path}"
    if low in ("edit", "multiedit", "notebookedit"):
        return f"edited {path}"
    if low in ("write", "remote_write"):
        return f"wrote {path}"
    if low == "apply_patch":
        changes = i.get("changes") or []
        return "changed " + ", ".join(f"{c.get('path')} ({c.get('kind', 'update')})" for c in changes if isinstance(c, dict))
    if low in ("grep", "glob", "websearch", "web_search", "toolsearch"):
        return f"searched {_short(i.get('pattern') or i.get('query'), 80)}"
    if low == "webfetch":
        return f"fetched {i.get('url', '')}"
    if low in ("task", "agent"):
        return f"ran a subagent: {_short(i.get('description') or i.get('subagent_type'), 80)}"
    if low == "todowrite":
        return None
    if name.startswith("mcp__"):
        return f"called {name.split('__')[-1]}"
    return f"used {n}"


def build_blocks(messages: list[dict], events: list[dict]) -> list[Block]:
    """Merge messages + events (oldest first) into per-turn blocks."""
    items: list[tuple[str, int, int, dict]] = []
    for k, m in enumerate(messages):
        items.append((m["created_at"], 0, k, {"msg": m}))
    for e in events:
        items.append((e["timestamp"], 1, e.get("eid") or 0, {"ev": e}))
    items.sort(key=lambda x: (x[0], x[1], x[2]))

    blocks: list[Block] = []
    cur: Block | None = None
    for _, _, _, it in items:
        m = it.get("msg")
        if m is not None:
            role = m["role"]
            if role == "user":
                cur = Block(user=[m["content"]])
                blocks.append(cur)
            elif role == "steer":
                if cur is None:
                    cur = Block()
                    blocks.append(cur)
                cur.user.append(f"(added while the agent was working) {m['content']}")
            elif role == "assistant":
                if cur is None:
                    cur = Block()
                    blocks.append(cur)
                # (a mate too angry to answer said nothing: the chat's line of narration is no reply of hers)
                cur.answer = "(you didn't answer them: too angry to reply)" if (m.get("meta") or {}).get("refused") else m["content"]
                cur.engine = m.get("provider") or cur.engine
                cur.model = m.get("model") or cur.model
            continue
        ev = it["ev"]
        if cur is None:
            continue
        data = ev.get("data") or {}
        if ev["type"] == "session.start":
            cur.engine = cur.engine or data.get("provider")
            cur.model = cur.model or data.get("model")
        elif ev["type"] == "tool.use":
            line = describe_action(str(data.get("name") or ""), data.get("input"))
            if line and (not cur.actions or cur.actions[-1] != line):
                cur.actions.append(line)
        elif ev["type"] == "error":
            code = data.get("code")
            if code == "turn.interrupted":
                cur.outcome = "stopped by the user"
            elif code not in ("turn.busy", "attachment.invalid"):
                cur.outcome = f"failed: {_short(data.get('message'), 200)}"
    return blocks


def render_block(b: Block) -> str:
    lines: list[str] = []
    for u in b.user:
        lines.append(f"[User]\n{_clip(u)}")
    who = ENGINE_LABEL.get(b.engine or "", "Agent")
    if b.model and b.model not in ("default", "codex (default)"):
        who += f" · {b.model}"
    body: list[str] = []
    if b.actions:
        acts = b.actions[:_MAX_ACTIONS]
        more = len(b.actions) - len(acts)
        body.append("Actions: " + "; ".join(acts) + (f"; … and {more} more" if more > 0 else ""))
    if b.answer:
        body.append(_clip(b.answer))
    if b.outcome and not b.answer and b.actions:
        # Only worth mentioning if it got partway (it may have changed things).
        body.append(f"(The turn {b.outcome}.)")
    if body:
        lines.append(f"[{who}]\n" + "\n".join(body))
    return "\n\n".join(lines)


def transcript(blocks: list[Block], budget: int = _BUDGET) -> tuple[str, int]:
    """Newest blocks first within the budget. Returns (text, blocks_included)."""
    rendered: list[str] = []
    used = 0
    for b in reversed(blocks):
        r = render_block(b)
        if not r:
            continue
        if used + len(r) > budget and rendered:
            break
        rendered.append(r)
        used += len(r)
    rendered.reverse()
    omitted = len([b for b in blocks if render_block(b)]) - len(rendered)
    text = "\n\n".join(rendered)
    if omitted > 0:
        text = f"({omitted} earlier exchange(s) omitted for length.)\n\n" + text
    return text, len(rendered)


def handoff_preamble(engine: str, blocks: list[Block]) -> str:
    text, _ = transcript(blocks)
    others = sorted({ENGINE_LABEL.get(b.engine or "", "another agent") for b in blocks if b.engine and b.engine != engine})
    by = f" with {', '.join(others)}" if others else ""
    return (
        "<conversation_so_far>\n"
        f"You are joining a conversation that started{by} in this same workspace. "
        "Everything so far, oldest first (the agent's tool output is summarised as 'Actions'):\n\n"
        f"{text}\n"
        "</conversation_so_far>\n\n"
        "Continue the work with full awareness of the above. The user's new message:"
    )


def catchup_preamble(engine: str, blocks: list[Block]) -> str:
    text, _ = transcript(blocks)
    others = sorted({ENGINE_LABEL.get(b.engine or "", "another agent") for b in blocks if b.engine and b.engine != engine})
    by = ", ".join(others) or "another agent"
    return (
        "<meanwhile>\n"
        f"Since your last turn the conversation continued with {by}. "
        "What happened, oldest first:\n\n"
        f"{text}\n"
        "</meanwhile>\n\n"
        "Take this into account. The user's new message:"
    )
