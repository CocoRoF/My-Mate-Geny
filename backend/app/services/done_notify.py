"""“끝나면 알려 줘”: a chat tells their mate when its work is done, and she phones them with it (docs/mate-calls.md
"Alarms"). The everyday notifications (a chat finished, on screen or not) are already on; someone who says it outright
wants a call.

- Every ordinary chat gets a small tool while a mate can call them (``geny_notify`` → ``notify_when_done``, a stdio
  bridge like the screen's: ``done_bridge.py``, a per-chat token). The chat's agent calls it when they ask to be told;
  the chat shows it (``session.notify`` on its stream, a chip with ✕), and the composer's bell does the same by hand.
- When that chat's turn ends (``add_turn_end_listener``), its mate gets what it did — the chat's title and the answer's
  gist — as a "done" alarm due at once (app/mate/alarms.py): she phones them on the device they are on, says it's done
  and what came of it; unanswered, she tries again, then leaves a message.
- Their mate: the one their phone lets call (``call_phones``), else the default mate, else the one they talked to last.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sys
import tempfile
from pathlib import Path
from typing import Any

from app.config import settings
from app.services._ids import now_iso

BRIDGE = str(Path(__file__).with_name("done_bridge.py"))
SUMMARY_CHARS = 600

PROMPT = """You have a tool for when the user wants to be told this work is done: mcp__geny_notify__notify_when_done.
Call it — once, right away — whenever they ask to be told, notified, called or alarmed when you finish ("끝나면 알려 줘",
"다 되면 알람 줘", "끝나면 전화해", "let me know when it's done"); then just do the work. When your turn ends, their
mate phones them with what you did, so end with a short, plain summary of the outcome. Don't call it unless they ask."""


class DoneNotify:
    def __init__(self, sessions: Any, mates: Any) -> None:
        self.sessions = sessions
        self.mates = mates
        self.tokens: dict[str, str] = {}
        self.armed: dict[str, dict[str, Any]] = {}
        self.config_dir = tempfile.TemporaryDirectory(prefix="hrh-notify-")
        sessions.add_turn_end_listener(self.ended)

    # ---- the mate who tells them ----

    def mate_for(self) -> dict[str, Any] | None:
        """Their mate for this: the one a phone lets call them, else the default one, else the one they talked to last."""
        calls = getattr(self.mates, "calls", None)
        store = self.mates.store
        mates = [m for m in store.list() if not m.get("draft")]  # (her conversation is made when she calls, if need be)
        if not mates or calls is None:
            return None
        by_id = {m["id"]: m for m in mates}
        for _dev, pol in sorted((calls.phones or {}).items(), key=lambda kv: str(kv[1].get("at") or ""), reverse=True):
            if pol.get("enabled") is True:
                chosen = by_id.get(str(pol.get("mate_id") or ""))
                if chosen is not None:
                    return chosen
                break
        default = next((m for m in mates if m.get("is_default")), None)
        if default is not None:
            return default
        return max(mates, key=lambda m: str(m.get("updated_at") or ""))

    # ---- the chat's tool ----

    def token_info(self, token: str | None) -> str | None:
        if not token:
            return None
        return next((sid for sid, known in self.tokens.items() if secrets.compare_digest(token, known)), None)

    def configure(self, sid: str, req: Any) -> None:
        """The chat's turn gets the tool — while a mate can call them."""
        if self.mate_for() is None:
            return
        token = self.tokens.setdefault(sid, secrets.token_urlsafe(32))
        base = Path(self.config_dir.name) / hashlib.sha256(sid.encode()).hexdigest()
        token_path = base.with_suffix(".token")
        token_path.write_text(token)
        os.chmod(token_path, 0o600)
        config = req.mcp_config or {"mcpServers": {}}
        config.setdefault("mcpServers", {})["geny_notify"] = {
            "type": "stdio", "command": sys.executable, "args": ["-I", BRIDGE],
            "env": {"HRH_NOTIFY_API": f"http://127.0.0.1:{settings.port}", "HRH_NOTIFY_TOKEN_FILE": str(token_path)},
        }
        req.mcp_config = config
        path = base.with_suffix(".json")
        path.write_text(json.dumps(config))
        os.chmod(path, 0o600)
        req.mcp_config_file = str(path)
        req.system_append = "\n\n".join(x for x in (req.system_append, PROMPT) if x)

    async def tool(self, sid: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            state = self.arm(sid, str(args.get("note") or ""), by="agent")
        except ValueError as exc:
            return {"text": str(exc), "is_error": True}
        return {"text": f"Done. When this turn ends, {state['mate_name']} phones them with what you did — finish with a short "
                        "summary of the outcome.", "is_error": False}

    # ---- armed or not ----

    def arm(self, sid: str, note: str = "", *, by: str = "user") -> dict[str, Any]:
        session = self.sessions.get(sid)
        if session.get("kind") in ("mate", "avatar"):
            raise ValueError("this is not a work chat")
        mate = self.mate_for()
        if mate is None:
            raise ValueError("no mate can call them yet: set one up (the Mate tab), then this works")
        self.armed[sid] = {"mate_id": mate["id"], "mate_name": mate["name"], "note": " ".join(note.split())[:200],
                           "by": by, "at": now_iso()}
        self._publish(sid)
        return self.state(sid)

    def disarm(self, sid: str) -> dict[str, Any]:
        self.armed.pop(sid, None)
        self._publish(sid)
        return self.state(sid)

    def state(self, sid: str) -> dict[str, Any]:
        a = self.armed.get(sid)
        mate = None if a else self.mate_for()
        return {"armed": a is not None, "mate_id": (a or {}).get("mate_id") or (mate or {}).get("id") or "",
                "mate_name": (a or {}).get("mate_name") or (mate or {}).get("name") or "", "available": a is not None or mate is not None}

    def _publish(self, sid: str) -> None:
        try:
            self.sessions._publish(sid, {"type": "session.notify", "data": self.state(sid)})
        except Exception:  # noqa: BLE001 - the chip shows the next time it is asked
            pass

    # ---- the turn ended: their mate tells them ----

    def ended(self, sid: str, outcome: dict[str, Any]) -> None:
        a = self.armed.pop(sid, None)
        if a is None:
            return
        self._publish(sid)
        calls = getattr(self.mates, "calls", None)
        if calls is None:
            return
        try:
            session = self.sessions.get(sid)
        except KeyError:
            return
        title = " ".join(str(session.get("title") or "a chat").split())[:80]
        status = outcome.get("status") or "ok"
        gist = " ".join(str(outcome.get("text") or "").split())
        if status == "error":
            gist = "it stopped with an error: " + " ".join(str(outcome.get("error") or "").split())[:300]
        elif status == "stopped":
            gist = "it was stopped before it finished. " + gist
        if len(gist) > SUMMARY_CHARS:
            gist = gist[: SUMMARY_CHARS - 1] + "…"
        about = f"“{title}” — {gist}" if gist else f"“{title}” finished"
        if a.get("note"):
            about += f" (they asked: {a['note']})"
        book = calls.alarms.book
        book.add(a["mate_id"], book.now(), about, kind="done", session_id=sid)
        calls.alarms.poke()
