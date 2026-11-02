"""Mate conversations, the mate engine, its tools and delegation results.

* A mate's conversation is a ``sessions`` row (``kind='mate'``) streamed with
  the normal history/ws endpoints. Its engine (Claude Code or Codex, from
  ``mate.llm.provider``) is configured here (:meth:`MateService.configure_engine`):
  our own system prompt, no built-in tools, only the ``mate`` MCP bridge,
  none of the user's CLI settings, model/effort from ``mate.llm``.
* The bridge calls :meth:`call_tool` through the internal API with a
  per-conversation token (``X-Mate-Token``; loopback only, see app.auth).
* ``send_to_session`` / ``create_session`` act exactly like the user typing
  in that chat (idle -> start a turn, running -> steer), tagged ``via``. The
  delegated turn is tracked; when it ends the mate gets a turn with an
  internal ``<delegation_result>`` message (queued while the mate is busy;
  chains of automatic hand-offs are capped, so it never loops).
"""

from __future__ import annotations

import asyncio
import base64
import collections
import json
import os
import re
import secrets
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.config import settings
from app.mate import affinity as A
from app.mate.capture import CaptureBroker, CaptureError
from app.mate import files
from app.mate import memory as M
from app.mate.prompt import MOOD_WORDS, context_block, prompt_key, settings_change_note, system_prompt
from app.mate.store import MateError, MateStore, normalize_persona
from app.providers import get_provider
from app.providers.catalog import default_mate_model
from app.providers.base import TurnRequest
from app.services._ids import now_iso
from app.services.session_service import SessionService, TurnBusyError

BRIDGE = str(Path(__file__).with_name("mcp_bridge.py"))
MAX_CHAIN = 3            # automatic result turns in a row (without the user speaking)
MAX_RESULT_CHARS = 4000  # of a worker's answer, passed to the mate
_SKIP_DIRS = {"node_modules", "__pycache__", "venv", ".venv", "dist", "build", "target", "site-packages", "proc",
              "sys", "snap"}


class ToolImages:
    """A tool result with pictures for the model (the bridge returns them as MCP image content)."""

    def __init__(self, text: str, images: list[dict[str, str]]) -> None:
        self.text = text
        self.images = images


def _clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _trim_answer(text: str) -> str:
    text = (text or "").strip()
    if len(text) <= MAX_RESULT_CHARS:
        return text
    head, tail = int(MAX_RESULT_CHARS * 0.7), int(MAX_RESULT_CHARS * 0.25)
    return f"{text[:head].rstrip()}\n…[{len(text) - head - tail} characters trimmed]…\n{text[-tail:].lstrip()}"


def _attr(v: Any) -> str:
    return str(v or "").replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace("\n", " ")


def _norm(s: str) -> str:
    return re.sub(r"[\s_\-.]+", "", s.lower())


class MateService:
    def __init__(self, sessions: SessionService, store: MateStore, logs: Any = None) -> None:
        self.store = store
        self._svc = sessions
        self._logs = logs
        self._tokens: dict[str, dict[str, str]] = {}      # token -> {mate_id, session_id}
        self._token_by_sid: dict[str, str] = {}
        self._delegations: dict[str, dict[str, Any]] = {}  # worker sid -> who delegated (mate) + chain depth
        self._pending: dict[str, list[dict[str, Any]]] = {}  # mate sid -> results waiting for the mate
        self._depth: dict[str, int] = {}                  # mate sid -> chain depth of its running turn
        # see_screen: requests to the user's desktop app windows (app/mate/capture.py; /ws/sessions registers them)
        self.capture = CaptureBroker()
        sessions.mate_engine = self.configure_engine
        sessions.add_turn_end_listener(self._on_turn_end)
        # every mate write is announced on /ws/sessions (mates.changed): open
        # windows and other devices refetch instead of keeping a stale copy
        store.on_change = sessions.mates_changed
        self._housekept: dict[str, str] = {}               # mate id -> the local day its memory was tidied
        store.on_memory_added = self._memory_added
        try:
            store.migrate_memories()  # (memories saved before kinds existed; idempotent)
        except Exception as exc:  # noqa: BLE001 - never stops the app
            self._log("warning", f"memory migration: {exc}")
        self.sync_builtins()
        for m in store.list():
            try:
                self.relation_doc(m["id"])  # (a mate from before relationships: seeded from its real history)
            except Exception as exc:  # noqa: BLE001
                self._log("warning", f"relationship seed for {m['id']}: {exc}")

    def _log(self, level: str, message: str, **kw: Any) -> None:
        if self._logs is not None:
            self._logs.record(level, "mate", message, **kw)

    # ---- mates ----

    def list(self) -> list[dict[str, Any]]:
        self.store.ensure_default()  # (only when there is no mate at all, built-ins included)
        return self.store.list()

    # ---- built-in mates: the bundled ailism characters (app/mate/builtin) ----

    def sync_builtins(self) -> None:
        """Every bundled character exists as a mate (unless the user deleted
        it). A new bundle version is merged field by field (files.merge_builtin):
        persona fields, name, greeting and body still as previously bundled get
        the new version, whatever the user changed stays theirs. The reply
        language, voice, model, memories and default flag are never touched."""
        removed = self.store.builtin_removed()
        for key in files.builtin_keys():
            try:
                version = files.builtin_hash(key)
                cur = self.store.by_builtin(key)
                if cur is not None and cur["builtin_hash"] == version and cur["builtin_snapshot"]:
                    continue
                if cur is None and key in removed:
                    continue
                doc = files.builtin_doc(key)
                snapshot = files.builtin_snapshot(key, doc)
                if cur is None:
                    name, persona = files.localized(snapshot)
                    mate = self.store.create(name=name, persona=persona, avatar=snapshot["avatar"])
                    self.store.mark_builtin(mate["id"], key, version, snapshot)
                    voice = files.ailism_voice(doc, files.builtin_voice_dir(key), mate["id"])
                    if voice:
                        self.store.update(mate["id"], {"voice": voice, "_sync": True})
                    continue
                prev = cur["builtin_snapshot"] or files.legacy_snapshot(cur, doc, snapshot["avatar"])
                patch = files.merge_builtin(cur, prev, snapshot)
                if patch:
                    self.store.update(cur["id"], {**patch, "_sync": True})
                    self._log("info", f"built-in mate {key} updated: {', '.join(sorted(patch))}"
                              + (f" ({', '.join(sorted(patch['persona']))})" if "persona" in patch else ""))
                self.store.mark_builtin(cur["id"], key, version, snapshot)
            except Exception as exc:  # noqa: BLE001 - one broken bundle must not stop the app
                self._log("warning", f"built-in mate {key}: {exc}")

    def restore_builtins(self) -> list[dict[str, Any]]:
        self.store.restore_builtins()
        self.sync_builtins()
        return self.store.list()

    def reset_builtin_avatar(self, mate_id: str) -> dict[str, Any]:
        """Put the bundled body back on a built-in mate (undoes clip/trigger edits).
        It counts as unedited again (app updates refresh it) only when its
        persona is still the bundled one; voice/model choices are untouched."""
        mate = self.store.get(mate_id)
        key = mate.get("builtin")
        if not key or key not in files.builtin_keys():
            raise MateError("only a built-in mate has a bundled avatar to go back to")
        doc = files.builtin_doc(key)
        snapshot = files.builtin_snapshot(key, doc)
        mate, _changed = self.store.update(mate_id, {"avatar": snapshot["avatar"], "_sync": True})
        _name, persona = files.localized(snapshot, mate["persona"]["language"])
        if mate["customized"] and normalize_persona(persona, mate["persona"]) == mate["persona"]:
            self.store.set_customized(mate_id, False)
            self.store.mark_builtin(mate_id, key, files.builtin_hash(key), snapshot)
        return self.store.get(mate_id)

    def get(self, mate_id: str) -> dict[str, Any]:
        return self.store.get(mate_id)

    def create(self, body: dict[str, Any]) -> dict[str, Any]:
        return self.store.create(name=body.get("name") or "", persona=body.get("persona"),
                                 avatar=body.get("avatar"), llm=body.get("llm"), voice=body.get("voice"),
                                 prefs=body.get("prefs"), is_default=bool(body.get("is_default")))

    def update(self, mate_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        before = self.store.get(mate_id)
        patch = files.localize_patch(before, patch)  # a new reply language: bundled name/greeting follow it
        mate, changed = self.store.update(mate_id, patch)
        sid = self._live_session(mate)
        if sid and changed & {"llm", "name"}:
            # (the engine itself picks persona/llm changes up at the next turn:
            # see configure_engine; the row keeps the UI's view in sync). A new
            # engine (Claude <-> Codex) switches the session's provider exactly
            # like a chat's engine switch: each engine keeps its own CLI
            # session, the other one is handed the conversation so far.
            self._svc.update(sid, **self._engine_fields(mate), title=mate["name"])
        if "avatar" in changed and files.import_dirs_of(before["avatar"], mate_id):
            # an imported pack/model the avatar no longer uses
            files.drop_import_dirs(mate_id, keep=files.import_dirs_of(mate["avatar"], mate_id))
        return mate

    def delete(self, mate_id: str) -> None:
        mate = self.store.get(mate_id)
        sid = self._live_session(mate)
        if sid:
            self._svc.delete(sid)
            self._forget_session(sid)
        self.store.delete(mate_id)
        files.remove_mate(mate_id)

    def _live_session(self, mate: dict[str, Any]) -> str | None:
        sid = mate.get("session_id")
        if not sid:
            return None
        try:
            s = self._svc.get(sid)
        except KeyError:
            return None
        return sid if s.get("kind") == "mate" and s.get("mate_id") == mate["id"] else None

    def _forget_session(self, sid: str) -> None:
        tok = self._token_by_sid.pop(sid, None)
        if tok:
            self._tokens.pop(tok, None)
        self._pending.pop(sid, None)
        self._depth.pop(sid, None)
        for wsid, d in list(self._delegations.items()):
            if d["mate_sid"] == sid:
                self._delegations.pop(wsid, None)

    # ---- conversation (a kind="mate" session) ----

    @staticmethod
    def _engine_fields(mate: dict[str, Any]) -> dict[str, str]:
        """The session columns that follow ``mate.llm``."""
        llm = mate["llm"]
        provider = llm.get("provider") or "claude"
        return {"provider": provider, "model": llm.get("model") or default_mate_model(provider),
                "effort": llm.get("effort") or "default"}

    def conversation(self, mate_id: str) -> dict[str, Any]:
        mate = self.store.get(mate_id)
        sid = self._live_session(mate)
        if sid is None:
            home = files.home_dir(mate_id)
            fields = self._engine_fields(mate)
            s = self._svc.create(**fields, workspace_path=str(home), title=mate["name"], kind="mate",
                                 mate_id=mate_id)
            sid = s["id"]
            greeting = mate["persona"].get("greeting")
            if greeting:
                self._svc.seed_message(sid, "assistant", greeting, provider=fields["provider"],
                                       meta={"internal": True, "kind": "greeting"})
            self.store.set_session(mate_id, sid)
            mate = self.store.get(mate_id)
        elif (self._svc.get(sid).get("provider") or "claude") != (mate["llm"].get("provider") or "claude") \
                and not self._svc.is_running(sid):
            self._svc.update(sid, **self._engine_fields(mate))  # (a switch that didn't reach the row)
        return {"mate": mate, "session_id": sid, "session": self._svc.get(sid), "running": self._svc.is_running(sid)}

    def reset(self, mate_id: str) -> dict[str, Any]:
        conv = self.conversation(mate_id)
        notice = self._svc.reset_context(conv["session_id"])  # TurnBusyError while it's talking
        self._pending.pop(conv["session_id"], None)
        return {**self.conversation(mate_id), "notice": notice}

    # ---- the mate engine ----

    def _token(self, mate_id: str, sid: str) -> str:
        tok = self._token_by_sid.get(sid)
        if tok is None:
            tok = secrets.token_urlsafe(32)
            self._token_by_sid[sid] = tok
            self._tokens[tok] = {"mate_id": mate_id, "session_id": sid}
        return tok

    def token_info(self, token: str | None) -> dict[str, str] | None:
        if not token:
            return None
        for known, info in self._tokens.items():
            if secrets.compare_digest(known, token):
                return info
        return None

    def configure_engine(self, session: dict[str, Any], req: TurnRequest) -> None:
        """SessionService hook for a kind="mate" turn: everything that makes
        the engine a mate, on either engine (``session.provider``, kept equal
        to ``mate.llm.provider``).

        * Claude: persona/memory edits change the prompt key and effort is a
          launch setting, so either restarts the engine at the next turn
          (``--resume``: same conversation); the model switches live.
        * Codex: one process per turn in its own sealed CODEX_HOME
          (``req.engine_home``, see app.providers._codex_sealed), resuming the
          thread; the instructions file is read again every turn."""
        mate_id = session.get("mate_id") or ""
        engine = session.get("provider") or "claude"
        try:
            mate = self.store.get(mate_id)
        except KeyError:
            mate = {"id": mate_id, "name": session.get("title") or "Mate", "persona": {}, "memory_rev": 0,
                    "llm": {"provider": engine, "model": session.get("model") or "",
                            "effort": session.get("effort") or "low"}}
        now_utc = datetime.now(timezone.utc)
        tz = self.store.tz()
        now_local = now_utc.astimezone(tz).replace(tzinfo=None)
        if mate_id:
            self._housekeep(mate_id, now_utc, now_local)
        memories = self.store.memories(mate_id) if mate_id else []
        core = M.core(memories)
        prefs = mate.get("prefs") or {}
        rel = self._advanced(mate_id, now_utc, tz) if mate_id else None
        relation = bool(rel and rel["enabled"])
        screen = bool((mate.get("screen") or {}).get("enabled"))
        prompt = system_prompt(mate["name"], mate["persona"], core, prefs, more=len(memories) - len(core),
                               relation=relation, screen=screen)
        # the per-turn context (docs/mate-memory-affinity.md §2): settings note (persona edited since the
        # conversation last ran), then the clock, recalled memories, the user's memory edits — prepended to
        # this message, never stored, never a restart
        note = self._settings_note(mate_id, mate, relation, screen)
        ctx = self._context(mate, req, engine, memories, core, prefs, now_utc, now_local, tz, rel) if mate_id else ""
        req.preamble = "\n\n".join(x for x in (note, ctx, req.preamble) if x)
        # (see_screen on/off changes the prompt and the bridge's tool list: the engine restarts with it)
        req.prompt_key = prompt_key(mate["name"], mate["persona"], int(mate.get("memory_rev") or 0), prefs,
                                    relation=relation, screen=screen)
        if engine == "codex" and mate_id:
            prompt = self._codex_prompt(mate_id, prompt, req.prompt_key, resuming=bool(req.cli_session_id))
            req.engine_home = str(files.mate_dir(mate_id) / "codex")
        # (a file: persona + 200 memories can outgrow one argv string)
        req.system_prompt_file = files.engine_file(mate_id, "prompt", "md", prompt)
        req.tools = []                     # no Bash/Read/Edit/WebFetch… — it can't do the work itself
        req.allowed_tools = ["mcp__mate"]  # all mate bridge tools
        req.sealed = True
        req.mode = "agent"
        req.extra_dirs = []
        llm = mate["llm"]
        # (a mate whose engine was just switched: that engine's default until the row catches up)
        same = (llm.get("provider") or "claude") == engine
        req.model = (llm.get("model") if same else "") or default_mate_model(engine)
        req.effort = llm.get("effort") or "default"
        req.mcp_config = {"mcpServers": {"mate": {
            "type": "stdio",
            "command": sys.executable,
            "args": ["-I", BRIDGE],
            "env": {
                "HRH_MATE_API": f"http://127.0.0.1:{settings.port}",
                "HRH_MATE_TOKEN": self._token(mate_id, session["id"]),
                "HRH_MATE_ID": mate_id,
                "HRH_MATE_SESSION": session["id"],
                **({"HRH_MATE_SCREEN": "1"} if screen else {}),  # the bridge offers see_screen only then
            },
        }}}
        # (a 0600 file, so the token isn't in the process list; Codex: in its
        # sealed home's 0600 config.toml instead)
        if engine != "codex":
            req.mcp_config_file = files.engine_file(mate_id, "mcp", "json", json.dumps(req.mcp_config, indent=1))
        if session.get("model") != req.model or (session.get("effort") or "default") != req.effort:
            self._svc.update(session["id"], model=req.model, effort=req.effort)

    @staticmethod
    def _codex_prompt(mate_id: str, prompt: str, key: str, *, resuming: bool) -> str:
        """The instructions a Codex turn gets. A resumed thread whose
        instructions file changed gets the whole new prompt appended as a
        "replaces the base instructions" message — so keep the previous text
        while only memories the mate saved itself changed (they are in the
        conversation already), exactly when the Claude engine keeps running
        (same prompt key). A fresh thread always gets the current prompt."""
        path = files.home_dir(mate_id) / ".codex-prompt.json"
        try:
            prev = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            prev = None
        if resuming and isinstance(prev, dict) and prev.get("key") == key and isinstance(prev.get("prompt"), str):
            return prev["prompt"]
        try:
            path.write_text(json.dumps({"key": key, "prompt": prompt}, ensure_ascii=False), "utf-8")
        except OSError:
            pass
        return prompt

    def _housekeep(self, mate_id: str, now_utc: datetime, now_local: datetime) -> None:
        day = now_local.date().isoformat()
        if self._housekept.get(mate_id) == day:
            return
        self._housekept[mate_id] = day
        try:
            self.store.housekeep(mate_id, now_utc, now_local)
        except Exception as exc:  # noqa: BLE001
            self._log("warning", f"memory housekeeping: {exc}")

    @staticmethod
    def _tz_name(tz: Any, now_utc: datetime) -> str:
        return str(getattr(tz, "key", "") or now_utc.astimezone(tz).tzname() or "")

    def _context_state(self, mate_id: str, engine: str, cli: str | None) -> dict[str, Any]:
        """What this engine session was already told (recalled memory ids by turn, the last relationship and
        mood lines). A fresh context (no session to resume, another engine, a different session) starts
        over, so a new context is told everything again."""
        path = files.home_dir(mate_id) / ".context-state.json"
        try:
            st = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            st = None
        fresh = {"engine": engine, "cli": cli, "turn": 0, "injected": {}, "rel": None, "mood": None, "mood_at": 0}
        if not isinstance(st, dict) or not cli:
            return fresh
        if st.get("engine") != engine or (st.get("cli") and st.get("cli") != cli):
            return fresh
        return {**fresh, **st, "cli": cli}

    def _save_context_state(self, mate_id: str, st: dict[str, Any]) -> None:
        path = files.home_dir(mate_id) / ".context-state.json"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(st, ensure_ascii=False), "utf-8")
        except OSError:
            pass

    def _context(self, mate: dict[str, Any], req: TurnRequest, engine: str, memories: list[dict[str, Any]],
                 core: list[dict[str, Any]], prefs: dict[str, Any], now_utc: datetime, now_local: datetime,
                 tz: Any, rel: dict[str, Any] | None = None) -> str:
        mate_id = mate["id"]
        st = self._context_state(mate_id, engine, req.cli_session_id)
        turn = int(st.get("turn") or 0) + 1
        injected = {k: int(v) for k, v in (st.get("injected") or {}).items() if turn - int(v) < M.INJECT_TTL_TURNS}
        query = next((str(m.get("content") or "") for m in reversed(req.messages) if m.get("role") == "user"), "")
        if query.lstrip().startswith("<delegation_result"):
            query = query[:600]
        core_ids = {m["id"] for m in core}
        level = (prefs.get("memory") or {}).get("recall") or "normal"
        recalled = M.recall([m for m in memories if m["id"] not in core_ids], query, now_utc=now_utc,
                            now_local=now_local, level=level, skip=set(injected))
        for m in recalled:
            injected[m["id"]] = turn
        changes = self.store.take_memory_changes(mate_id)
        relation = self._relation_lines(rel, st, now_utc, tz, turn)
        self._save_context_state(mate_id, {**st, "turn": turn, "injected": injected})
        if recalled:
            self.store.mark_used(mate_id, [m["id"] for m in recalled])
        return context_block(now_local, self._tz_name(tz, now_utc), recalled=recalled, changes=changes,
                             relation=relation)

    @staticmethod
    def _relation_lines(rel: dict[str, Any] | None, st: dict[str, Any], now_utc: datetime, tz: Any,
                        turn: int) -> list[str]:
        """Where things stand and how the mate feels — only when it changed since this engine session was last
        told (or every 30 turns), so most messages carry no such line (docs/mate-memory-affinity.md §5.5)."""
        if not rel or not rel["enabled"] or rel["paused"]:
            return []
        lines: list[str] = []
        today = now_utc.astimezone(tz).date()
        streak = int(rel["streak_days"] or 0)
        distant = A.STAGES.index(A.STAGES[int(rel.get("warm") or 0)]) < A.STAGES.index(A.earned_stage(rel))
        sig = [rel["stage"], 0 if streak < 2 else 1 if streak < 7 else 2, distant]
        if rel["started_at"] and (st.get("rel") != sig or turn - int(st.get("rel_turn") or 0) >= 30):
            line = f"Relationship: {rel['stage']} — day {A.days_together(rel, today, tz)} together"
            if streak >= 2:
                line += f", talking {streak} days in a row"
            lines.append(line + ".")
            if distant:
                lines.append("It has been a while since you two talked: you still know them — be a little more "
                             "reserved for now and let it close naturally as you talk. Never mention the gap.")
            st["rel"], st["rel_turn"] = sig, turn
        mood = A.mood(rel, now_utc, tz)["label"]
        last = float(st.get("mood_at") or 0)
        if mood != st.get("mood") and (st.get("mood") is None or now_utc.timestamp() - last >= 20 * 60):
            lines.append(f"Your state: {MOOD_WORDS.get(mood, mood)}.")
            st["mood"], st["mood_at"] = mood, now_utc.timestamp()
        return lines

    # ---- the relationship (app/mate/affinity.py) ----

    def _history_events(self, mate: dict[str, Any]) -> list[tuple[datetime, str, Any]]:
        """The real history the relationship is rebuilt from: the user's messages in the mate's conversation
        (not the internal ones — delegation results, greetings) with the reply that followed, and memories."""
        events: list[tuple[datetime, str, Any]] = []
        sid = mate.get("session_id")
        if sid:
            rows = self._svc._db.query(
                "SELECT role, content, meta, created_at FROM messages WHERE session_id = ? AND role IN "
                "('user', 'assistant') ORDER BY created_at, rowid", (sid,))
            pending: tuple[datetime, str] | None = None
            for r in rows:
                try:
                    meta = json.loads(r["meta"] or "null") or {}
                except ValueError:
                    meta = {}
                at = A._t(r["created_at"])
                if at is None:
                    continue
                if r["role"] == "user":
                    if pending:
                        events.append((pending[0], "turn", (pending[1], "")))
                    pending = None if meta.get("internal") else (at, r["content"] or "")
                elif pending:
                    events.append((pending[0], "turn", (pending[1], r["content"] or "")))
                    pending = None
            if pending:
                events.append((pending[0], "turn", (pending[1], "")))
        for r in self.store._db.query("SELECT created_at FROM mate_memories WHERE mate_id = ?", (mate["id"],)):
            at = A._t(r["created_at"])
            if at is not None:
                events.append((at, "memory", None))
        return events

    def _recompute(self, mate_id: str, settings: dict[str, Any] | None = None,
                   marks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        mate = self.store.get(mate_id)
        tz, key = self.store.tz_and_key()
        doc = A.replay(self._history_events(mate), datetime.now(timezone.utc), tz, settings, marks)
        doc["tz"] = key
        return doc

    def relation_doc(self, mate_id: str) -> dict[str, Any]:
        """The mate's relationship; a mate without one (from before, or new) starts from its real history. One
        whose days were counted in another zone than the user's now — the server's own while no browser had
        said the user's (a container runs in UTC), or the user changed it — is counted again from the history
        (the same rules as in real time; the user's own changes and switches kept): a day's talk, streaks and
        the quiet days between them depend on where midnight is."""
        doc = self.store.relation_doc(mate_id)
        if doc is None:
            doc = self._recompute(mate_id)
            self.store.save_relation(mate_id, doc)
        elif doc.get("tz") != self.store.tz_and_key()[1]:
            doc = self._retimed(mate_id, doc)
        return doc

    def _retimed(self, mate_id: str, cur: dict[str, Any]) -> dict[str, Any]:
        doc = self._recompute(mate_id, {k: cur[k] for k in ("enabled", "sensitivity", "show_indicator", "avatar_mood")},
                              A.marks_of(cur))
        doc["paused"] = cur["paused"]
        if cur.get("paused") or not cur.get("enabled", True):
            doc["quiet_from"] = cur.get("quiet_from")
        A._log(doc, 0.0, f"timezone {cur.get('tz') or '?'} → {doc['tz']}", datetime.now(timezone.utc))
        self._log("info", f"relationship of {mate_id} counted again in {doc['tz']} (was {cur.get('tz') or 'unknown'}): "
                          f"{cur.get('stage')} {round(float(cur.get('affinity') or 0))} → {doc['stage']} "
                          f"{round(float(doc['affinity']))}", code="mate.relation_retimed")
        self._save_relation(mate_id, doc, cur)
        return doc

    def timezone_changed(self) -> None:
        """The user's timezone was set or changed (Global settings → Defaults, or the console filling it from the
        browser): every relationship is counted in it now — announced, so indicators move without a reload."""
        for m in self.store.list():
            try:
                self.relation_doc(m["id"])
            except Exception as exc:  # noqa: BLE001 - one mate's history never stops the others
                self._log("warning", f"relationship recount for {m['id']}: {exc}")

    def _save_relation(self, mate_id: str, doc: dict[str, Any], before: dict[str, Any] | None,
                       force: bool = False) -> None:
        self.store.save_relation(mate_id, doc)
        tz = self.store.tz()
        now = datetime.now(timezone.utc)
        if force or before is None or A.summary(before, now, tz) != A.summary(doc, now, tz):
            self.store._changed("relation", mate_id)  # (the indicator / Relationship tab refetch)

    def _advanced(self, mate_id: str, now: datetime, tz: Any) -> dict[str, Any]:
        doc = self.relation_doc(mate_id)
        before = A.clone(doc)
        A.advance(doc, now, tz)
        if doc != before:
            self._save_relation(mate_id, doc, before)
        return doc

    def relation_view(self, mate_id: str) -> dict[str, Any]:
        self.store.get(mate_id)
        now, tz = datetime.now(timezone.utc), self.store.tz()
        return A.view(self._advanced(mate_id, now, tz), now, tz)

    def _talk_times(self, mate: dict[str, Any]) -> list[datetime]:
        """When the user wrote to the mate (not the internal messages — delegation results), oldest first."""
        sid = mate.get("session_id")
        if not sid:
            return []
        out = []
        for r in self._svc._db.query("SELECT meta, created_at FROM messages WHERE session_id = ? AND role = 'user' "
                                     "ORDER BY created_at, rowid", (sid,)):
            try:
                meta = json.loads(r["meta"] or "null") or {}
            except ValueError:
                meta = {}
            at = A._t(r["created_at"])
            if at is not None and not (isinstance(meta, dict) and meta.get("internal")):
                out.append(at)
        return out

    def relation_journal(self, mate_id: str, days: int = 30) -> dict[str, Any]:
        """The Relationship panel (docs/mate-memory-affinity.md §6.1) — reads only: the value at the end of each of
        the last ``days`` days, what the next stage still needs (earned and warmth), stats, milestones and
        anniversaries, the change log with kinds, the latest memories. The daily values come from the change log;
        days older than what it still keeps (the last 200 changes) from a replay of the real history through the
        same engine (``A.replay`` — real time and recompute agree)."""
        mate = self.store.get(mate_id)
        days = max(7, min(90, int(days)))
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc = self._advanced(mate_id, now, tz)
        today = now.astimezone(tz).date()
        series = A.daily(doc["log"], today, tz, days)
        source = "log"
        first = next((d for d in (A.log_day(e, tz) for e in doc["log"]) if d), None)
        if len(doc["log"]) >= A.LOG_MAX and first and first >= today - timedelta(days=days - 1):
            # the log lost older changes: those days (and its first, partial one) from the whole history
            trace: list[dict[str, Any]] = []
            A.replay(self._history_events(mate), now, tz,
                     {k: doc[k] for k in ("enabled", "sensitivity", "show_indicator", "avatar_mood")},
                     A.marks_of(doc), trace=trace)
            old = {x["day"]: x for x in A.daily(trace, today, tz, days)}
            series = [old[x["day"]] if x["day"] <= first.isoformat() else x for x in series]
            source = "log+replay"
        talks = self._talk_times(mate)
        per_day: dict[str, int] = {}
        for at in talks:
            k = at.astimezone(tz).date().isoformat()
            per_day[k] = per_day.get(k, 0) + 1
        for x in series:
            x["talks"] = per_day.get(x["day"], 0)
        talk_days = {date.fromisoformat(k) for k in per_day}
        view = A.view(doc, now, tz)
        stats = {**view["stats"],
                 "longest_streak": max(A.longest_run(talk_days), int(doc["streak_days"] or 0)),
                 "memories_active": self.store.memory_counts(mate_id).get("active", 0),
                 "first_talk_at": A._iso(talks[0]) if talks else doc.get("started_at"),
                 "last_talk_at": A._iso(talks[-1]) if talks else None}
        recent = sorted(self.store.memories(mate_id), key=lambda m: m.get("created_at") or "", reverse=True)[:5]
        return {
            "days": days, "today": today.isoformat(), "series": series, "series_source": source,
            "relation": view, "requirements": A.requirements(doc), "stats": stats,
            "milestones": view["milestones"], "anniversaries": A.anniversaries(doc, today, tz),
            "changes": A.changes(doc),
            "memories": [{k: m.get(k) for k in ("id", "text", "kind", "created_at", "source")} for m in recent],
        }

    def relation_update(self, mate_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        """The Relationship tab: on/off, pause, sensitivity, the indicator, the avatar following the mood, a value
        set by hand. Time up to now is settled first, under the old settings (a pause covers what it covered)."""
        self.store.get(mate_id)
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc = self._advanced(mate_id, now, tz)
        before = A.clone(doc)
        for k in ("enabled", "paused"):
            if k in patch and patch[k] is not None:
                A.set_switch(doc, k, bool(patch[k]), now, tz)
        for k in ("show_indicator", "avatar_mood"):
            if k in patch and patch[k] is not None:
                doc[k] = bool(patch[k])
        if patch.get("sensitivity") is not None:
            try:
                doc["sensitivity"] = max(A.SENSITIVITY[0], min(A.SENSITIVITY[1], float(patch["sensitivity"])))
            except (TypeError, ValueError) as exc:
                raise MateError("sensitivity must be a number (0.5 – 1.5)") from exc
        if patch.get("affinity") is not None:
            if isinstance(patch["affinity"], bool):
                raise MateError("affinity must be a number (0 – 100)")
            try:
                A.set_value(doc, float(patch["affinity"]), now, tz)
            except (TypeError, ValueError) as exc:
                raise MateError("affinity must be a number (0 – 100)") from exc
        self._save_relation(mate_id, doc, before, force=True)
        return A.view(doc, now, tz)

    def relation_reset(self, mate_id: str, mode: str) -> dict[str, Any]:
        """``zero``: a fresh start (settings kept); ``recompute``: rebuilt from the real history."""
        self.store.get(mate_id)
        now, tz = datetime.now(timezone.utc), self.store.tz()
        cur = self.relation_doc(mate_id)
        if mode == "zero":
            doc = A.reset(cur, now, tz)
            doc["tz"] = self.store.tz_and_key()[1]
        elif mode == "recompute":
            doc = self._recompute(mate_id, {k: cur[k] for k in ("enabled", "sensitivity", "show_indicator",
                                                                "avatar_mood")})
            doc["paused"] = cur["paused"]
        else:
            raise MateError("mode: zero | recompute")
        self._save_relation(mate_id, doc, cur, force=True)
        return A.view(doc, now, tz)

    def _memory_added(self, mate_id: str) -> None:
        now, tz = datetime.now(timezone.utc), self.store.tz()
        if self.store.relation_doc(mate_id) is None:
            self.relation_doc(mate_id)  # (seeded from history now — this memory is already in it)
            return
        doc = self.relation_doc(mate_id)
        before = A.clone(doc)
        A.advance(doc, now, tz)
        A.credit_memory(doc, now, tz)
        self._save_relation(mate_id, doc, before)

    def _relation_turn(self, mate_id: str, outcome: dict[str, Any]) -> None:
        """A mate turn ended: the user's own message counts (an internal one — a delegation result — only
        moves the mood a little)."""
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc = self.relation_doc(mate_id)
        before = A.clone(doc)
        A.advance(doc, now, tz)
        meta = outcome.get("meta") or {}
        if meta.get("internal"):
            if meta.get("kind") == "delegation_result":
                ok = all((d.get("status") == "ok") for d in (meta.get("delegations") or []))
                A.mood_result(doc, now, ok)
        else:
            A.credit_turn(doc, now, tz, str(outcome.get("input") or ""), str(outcome.get("text") or ""))
        self._save_relation(mate_id, doc, before)

    def _settings_note(self, mate_id: str, mate: dict[str, Any], relation: bool | None = None,
                       screen: bool | None = None) -> str:
        """Compare the persona with the one the conversation last ran with
        (kept next to the mate's engine files) and remember the new one."""
        if not mate_id:
            return ""
        path = files.home_dir(mate_id) / ".applied-persona.json"
        now = {"name": mate.get("name") or "", "persona": mate.get("persona") or {}, "prefs": mate.get("prefs") or {},
               "relation": relation, "screen": screen}
        try:
            before = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            before = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(now, ensure_ascii=False), "utf-8")
        except OSError:
            pass
        if not isinstance(before, dict):
            return ""  # first turn ever: the system prompt says it all
        note = settings_change_note(str(before.get("name") or ""), before.get("persona") or {},
                                    now["name"], now["persona"],
                                    before.get("prefs") if isinstance(before.get("prefs"), dict) else None,
                                    now["prefs"],
                                    old_relation=before.get("relation") if isinstance(before.get("relation"), bool)
                                    else None, new_relation=relation)
        was = before.get("screen")
        if isinstance(was, bool) and screen is not None and was != screen:
            line = ("- You can now look at the user's screen with see_screen (when it helps; the user may be "
                    "asked to allow it each time)." if screen else
                    "- You can no longer look at the user's screen (see_screen is gone).")
            note = (note.replace("</settings_update>", line + "\n</settings_update>") if note else
                    f"<settings_update>\nThe user changed your settings:\n{line}\n</settings_update>")
        return note

    # ---- tools (called by the bridge through the internal API) ----

    async def call_tool(self, ctx: dict[str, str], name: str, args: dict[str, Any]) -> tuple[str, bool]:
        """-> (text for the model, is_error)."""
        text, is_error, _images = await self.call_tool_full(ctx, name, args)
        return text, is_error

    async def call_tool_full(self, ctx: dict[str, str], name: str,
                             args: dict[str, Any]) -> tuple[str, bool, list[dict[str, str]]]:
        """-> (text for the model, is_error, images ``[{data: base64, mime}]`` — see_screen's picture)."""
        fn = getattr(self, f"_tool_{name}", None)
        if fn is None:
            return f"unknown tool: {name}", True, []
        try:
            mate = self.store.get(ctx["mate_id"])
        except KeyError:
            return "this mate no longer exists", True, []
        try:
            out = await fn(mate, ctx["session_id"], args if isinstance(args, dict) else {})
        except MateError as exc:
            return str(exc), True, []
        except CaptureError as exc:  # (an expected outcome: no app, denied, timed out… — not an admin error)
            return str(exc), True, []
        except Exception as exc:  # noqa: BLE001 - surfaced to the model, logged for the admin
            self._log("error", f"mate tool {name} failed: {exc}", code="mate.tool_failed",
                      detail={"args": args}, session_id=ctx.get("session_id"))
            return f"{name} failed: {exc}", True, []
        if isinstance(out, ToolImages):
            return out.text, False, out.images
        return (out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, indent=1)), False, []

    def _chat(self, sid: Any) -> dict[str, Any]:
        sid = str(sid or "").strip()
        try:
            s = self._svc.get(sid)
        except KeyError as exc:
            raise MateError(f"no chat with session_id {sid!r} (see list_sessions)") from exc
        if s.get("kind") == "mate":
            raise MateError("that is a mate conversation, not a chat")
        return s

    def _snippets(self, sid: str) -> dict[str, str]:
        rows = self._svc._db.query(
            "SELECT role, content FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') "
            "ORDER BY created_at DESC LIMIT 8", (sid,))
        out: dict[str, str] = {}
        for r in rows:
            key = "last_user" if r["role"] == "user" else "last_answer"
            out.setdefault(key, _clip(r["content"], 200))
        return out

    async def _tool_list_sessions(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> Any:
        q = str(args.get("query") or "").strip().lower()
        rows = []
        for s in self._svc.list_all():
            if q and q not in (s["title"] or "").lower() and q not in (s["workspace_path"] or "").lower():
                continue
            rows.append({
                "session_id": s["id"],
                "title": s["title"],
                "workspace": s["workspace_path"] + (" (remote)" if s.get("connection_id") else ""),
                "provider": s["provider"],
                "model": s["model"],
                "running": self._svc.is_running(s["id"]),
                "updated_at": s["updated_at"],
                **self._snippets(s["id"]),
            })
            if len(rows) >= 30:
                break
        if not rows:
            return "No chats match." if q else "There are no chats yet."
        return rows

    async def _tool_read_session(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> Any:
        s = self._chat(args.get("session_id"))
        try:
            limit = max(1, min(40, int(args.get("limit") or 10)))
        except (TypeError, ValueError):
            limit = 10
        msgs = [m for m in self._svc.messages(s["id"]) if m["role"] in ("user", "assistant", "steer")][-limit:]
        out: dict[str, Any] = {
            "session_id": s["id"], "title": s["title"], "workspace": s["workspace_path"],
            "provider": s["provider"], "model": s["model"], "running": self._svc.is_running(s["id"]),
            "messages": [
                {"role": "user (added mid-turn)" if m["role"] == "steer" else m["role"],
                 **({"via": m["meta"]["via"].get("name")} if (m.get("meta") or {}).get("via") else {}),
                 "at": m["created_at"], "text": _clip(m["content"], 1500),
                 **({"files": [a["name"] for a in m["attachments"]]} if m.get("attachments") else {})}
                for m in msgs
            ],
        }
        if out["running"]:
            run = self._svc.active_runs.get(s["id"]) or {}
            row = self._svc._db.query_one(
                "SELECT data FROM events WHERE session_id = ? AND type = 'tool.use' ORDER BY id DESC LIMIT 1",
                (s["id"],))
            activity: dict[str, Any] = {"since": run.get("started_at"), "tool_calls": run.get("tools", 0)}
            if row is not None:
                d = json.loads(row["data"])
                inp = d.get("input") or {}
                hint = inp.get("description") or inp.get("command") or inp.get("file_path") or inp.get("pattern")
                activity["current_tool"] = d.get("name") + (f": {_clip(str(hint), 160)}" if hint else "")
            out["activity"] = activity
        bg = self._svc.running_task_count(s["id"])
        if bg:
            out["background_tasks_running"] = bg
        return out

    def _via(self, mate: dict[str, Any]) -> dict[str, Any]:
        return {"via": {"kind": "mate", "mate_id": mate["id"], "name": mate["name"]}}

    def _forwarded(self, mate_sid: str, raw: Any) -> list[dict[str, Any]]:
        """The mate's ``attachments`` argument -> rows of files from its own
        conversation (the ``[att_…]`` ids it sees with the user's messages)."""
        if raw in (None, "", []):
            return []
        items = raw if isinstance(raw, list) else re.split(r"[\s,]+", str(raw))
        ids = list(dict.fromkeys(i for i in (str(x).strip().strip("[]").strip() for x in items) if i))
        svc = self._svc._attachments
        if svc is None or not ids:
            return []
        if len(ids) > settings.upload_max_files:
            raise MateError(f"at most {settings.upload_max_files} attachments per message")
        rows = []
        for aid in ids:
            row = svc.get(aid)
            if row is None or row["session_id"] != mate_sid:
                raise MateError(f"no attachment {aid!r} in this conversation — use the [att_…] ids listed "
                                "with the user's messages")
            if not os.path.exists(row["path"]):
                raise MateError(f"the file of {aid} ({row['name']}) is gone")
            rows.append(row)
        return rows

    async def _copies(self, rows: list[dict[str, Any]], target_sid: str) -> list[str]:
        """The mate's files, copied into the worker chat as pending uploads
        (what the user uploading them there would make)."""
        out: list[str] = []
        try:
            for row in rows:
                out.append((await asyncio.to_thread(self._svc._attachments.copy_to, row, target_sid))["id"])
        except Exception:
            self._drop_copies(out)
            raise
        return out

    def _drop_copies(self, ids: list[str]) -> None:
        for aid in ids:
            self._svc._attachments.delete_pending(aid)  # (a no-op once sent)

    @staticmethod
    def _files_phrase(rows: list[dict[str, Any]]) -> str:
        if not rows:
            return ""
        names = ", ".join(r["name"] for r in rows[:5]) + (f" +{len(rows) - 5}" if len(rows) > 5 else "")
        return f" with {len(rows)} file{'s' if len(rows) != 1 else ''} ({names})"

    async def _deliver(self, sid: str, text: str, meta: dict[str, Any],
                       attachment_ids: list[str] | None = None) -> str:
        """Exactly like the user: idle -> new turn, running -> steer. A turn
        that is just wrapping up can't take input: wait for it, then start.
        ``attachment_ids``: pending uploads of that chat, sent with it."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 45
        while True:
            if not self._svc.is_running(sid):
                try:
                    self._svc.start_turn(sid, text, attachment_ids or None, meta=meta)
                    return "started"
                except TurnBusyError:
                    pass
            elif await self._svc.steer(sid, text, attachment_ids or None, meta=meta):
                return "steered"
            if loop.time() > deadline:
                raise MateError("that chat is busy finishing its turn; try again in a moment")
            await asyncio.sleep(0.4)

    def _track(self, worker_sid: str, mate: dict[str, Any], mate_sid: str, title: str) -> None:
        self._delegations[worker_sid] = {
            "mate_id": mate["id"], "mate_sid": mate_sid, "name": mate["name"], "title": title,
            "depth": self._depth.get(mate_sid, 0), "at": time.time(), "auto_only": False,
        }

    async def _tool_send_to_session(self, mate: dict[str, Any], mate_sid: str, args: dict[str, Any]) -> str:
        s = self._chat(args.get("session_id"))
        text = str(args.get("message") or "").strip()
        if not text:
            raise MateError("message is empty")
        rows = self._forwarded(mate_sid, args.get("attachments"))
        copies = await self._copies(rows, s["id"])
        self._track(s["id"], mate, mate_sid, s["title"])
        try:
            how = await self._deliver(s["id"], text, self._via(mate), copies)
        except Exception:
            self._delegations.pop(s["id"], None)
            self._drop_copies(copies)
            raise
        what = "it started a new turn" if how == "started" else "it was added to the turn it is running"
        return (f"Sent to \"{s['title']}\" ({s['id']}){self._files_phrase(rows)}: {what}. Its result will "
                "reach you as a <delegation_result> when it finishes — tell the user what you sent and end "
                "your turn.")

    async def _tool_create_session(self, mate: dict[str, Any], mate_sid: str, args: dict[str, Any]) -> str:
        raw = str(args.get("workspace_path") or "").strip()
        if not raw:
            raise MateError("workspace_path is required (find it with find_folders)")
        path = os.path.abspath(os.path.expanduser(raw))
        if not os.path.isdir(path):
            raise MateError(f"folder not found: {path} (use find_folders to get the exact path)")
        if Path(files.root()) in Path(path).parents or Path(path) == files.root():
            raise MateError("that folder belongs to a mate, not to a project")
        provider = str(args.get("provider") or "claude").strip()
        try:
            get_provider(provider)
        except KeyError as exc:
            raise MateError(f"unknown provider: {provider} (claude or codex)") from exc
        title = _clip(str(args.get("title") or "").strip(), 120) or os.path.basename(path.rstrip("/")) or path
        msg = str(args.get("message") or "").strip()
        rows = self._forwarded(mate_sid, args.get("attachments"))
        if rows and not msg:
            raise MateError("attachments go with a message: say what the chat should do with them")
        s = self._svc.create(provider=provider, model=str(args.get("model") or "").strip(),
                             workspace_path=path, title=title)
        if not msg:
            return f"Created chat \"{s['title']}\" ({s['id']}) on {path}. No instruction sent yet."
        copies = await self._copies(rows, s["id"])
        self._track(s["id"], mate, mate_sid, s["title"])
        try:
            await self._deliver(s["id"], msg, self._via(mate), copies)
        except Exception:
            self._delegations.pop(s["id"], None)
            self._drop_copies(copies)
            raise
        return (f"Created chat \"{s['title']}\" ({s['id']}) on {path} and sent the instruction"
                f"{self._files_phrase(rows)}; it is working on it. Its result will reach you as a "
                "<delegation_result>.")

    async def _tool_find_folders(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> Any:
        q = str(args.get("query") or "").strip()
        if len(_norm(q)) < 2:
            raise MateError("query must have at least 2 letters")
        chats = [(s["workspace_path"], s["title"]) for s in self._svc.list_all() if not s.get("connection_id")]
        roots = [r.strip() for r in settings.mate_search_roots.split(",") if r.strip()]
        found = await asyncio.to_thread(find_folders, q, chats, roots)
        return found or f"No folder matching {q!r} found. Ask the user for the path."

    async def _tool_remember(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> str:
        mem = self.store.add_memory(mate["id"], str(args.get("text") or ""), kind=args.get("kind"),
                                    importance=args.get("importance"), due_at=args.get("due"))
        if mem["merged"]:
            return f"Already known as {M.line(mem)} — updated it."
        out = f"Remembered {M.line(mem)}"
        if mem["similar"]:
            out += ("\nSimilar memories: " + "; ".join(M.line(m) for m in mem["similar"])
                    + " — if the new one replaces one of them, update_memory that one and forget the duplicate.")
        return out

    async def _tool_update_memory(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> str:
        mid = str(args.get("id") or "").strip().strip("[]")
        patch = {k: args[k] for k in ("text", "kind", "importance", "status") if args.get(k) not in (None, "")}
        if "due" in args:
            patch["due_at"] = args.get("due")
        if not patch:
            raise MateError("nothing to change: give text, kind, importance, due or status")
        try:
            mem = self.store.update_memory(mate["id"], mid, patch)
        except KeyError as exc:
            raise MateError(f"no memory with id {mid!r}") from exc
        return f"Updated {M.line(mem)}" + (f" (status {mem['status']})" if mem["status"] != "active" else "")

    async def _tool_forget(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> str:
        mid = str(args.get("id") or "").strip().strip("[]")
        if not self.store.delete_memory(mate["id"], mid):
            raise MateError(f"no memory with id {mid!r}")
        return f"Forgot [{mid}]."

    async def _tool_recall(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> str:
        q = str(args.get("query") or "").strip()
        if not q:
            raise MateError("query is required")
        try:
            limit = max(1, min(10, int(args.get("limit") or 6)))
        except (TypeError, ValueError):
            limit = 6
        kind = str(args.get("kind") or "").strip() or None
        rows = self.store.memories(mate["id"], status="all" if args.get("include_done") else "active", kind=kind)
        now_utc = datetime.now(timezone.utc)
        now_local = now_utc.astimezone(self.store.tz()).replace(tzinfo=None)
        found = M.recall(rows, q, now_utc=now_utc, now_local=now_local, limit=limit, chars=6000, due_soon=False)
        if not found:
            return f"Nothing in your memory matches {q!r}."
        return "\n".join(M.line(m) + (f" (status {m['status']})" if m.get("status") != "active" else "")
                         for m in found)

    def preview_context(self, mate_id: str, text: str) -> dict[str, Any]:
        """The Memory tab's "Test recall": what the mate would get for this message (nothing is recorded)."""
        mate = self.store.get(mate_id)
        now_utc = datetime.now(timezone.utc)
        tz = self.store.tz()
        now_local = now_utc.astimezone(tz).replace(tzinfo=None)
        memories = self.store.memories(mate_id)
        core = M.core(memories)
        ids = {m["id"] for m in core}
        level = ((mate.get("prefs") or {}).get("memory") or {}).get("recall") or "normal"
        recalled = M.recall([m for m in memories if m["id"] not in ids], text or "", now_utc=now_utc,
                            now_local=now_local, level=level)
        return {"core": core, "recalled": recalled, "level": level,
                "block": context_block(now_local, self._tz_name(tz, now_utc), recalled=recalled)}

    # ---- seeing the screen (app/mate/capture.py; docs/mate.md §4 "Seeing the screen") ----

    async def _tool_see_screen(self, mate: dict[str, Any], sid: str, args: dict[str, Any]) -> "ToolImages":
        if not (mate.get("screen") or {}).get("enabled"):
            raise MateError("Looking at the screen is switched off for you (Mate settings → Screen).")
        if not self._svc.is_mate_session(sid):
            raise MateError("see_screen works only in your own conversation")
        reason = str(args.get("reason") or "").strip()
        device = self._svc.last_client_device(sid)
        res = await self.capture.request(mate=mate, session_id=sid, device=device, reason=reason)
        row = self._capture_row(sid, res.get("attachment_id"))
        # (the conversation's own copy: never a pending composer upload, gone with the conversation)
        self._svc._attachments.link([row["id"]], f"artifact:capture:{res['id']}")
        use_model = bool(row.get("model_path")) and os.path.exists(row["model_path"])
        path = row["model_path"] if use_model else row["path"]
        mime = (row.get("model_mime") if use_model else None) or row["mime"]
        data = await asyncio.to_thread(Path(path).read_bytes)
        src = res.get("source") if isinstance(res.get("source"), dict) else {}
        what = "window" if src.get("kind") == "window" else "screen"
        name = " ".join(str(src.get("name") or "").split())[:120]
        elsewhere = bool(device) and res["client"].device != device
        where = (" (on the computer where the desktop app was used last — the user's last message came from "
                 "another device)") if elsewhere else ""
        size = f", {row['width']}×{row['height']}" if row.get("width") else ""
        label = f" “{name}”" if name else ""
        text = (f"Screen captured: the {what}{label}{size}{where} — [{row['id']}] {row['name']}. The picture is "
                "attached below; the user sees it in your conversation too. Talk only about what matters for "
                "what they asked; don't remember what you saw unless they ask you to.")
        return ToolImages(text, [{"data": base64.b64encode(data).decode(), "mime": mime}])

    def _capture_row(self, sid: str, aid: Any) -> dict[str, Any]:
        att = self._svc._attachments
        row = att.get(str(aid or "")) if att is not None else None
        if row is None or row["session_id"] != sid or row["kind"] != "image" or not os.path.exists(row["path"]):
            raise CaptureError("error", "The desktop app's capture did not arrive as an image.")
        return row

    def capture_result(self, mate_id: str, rid: str, body: dict[str, Any]) -> bool:
        """The desktop app's answer to a capture request (``POST /api/mates/{id}/capture/{rid}``):
        ``{ok: true, attachment_id, source?: {name, kind}}`` or ``{ok: false, code, message?}``.
        False: no such request waiting (answered, timed out, another mate's)."""
        sid = self.capture.pending_session(rid)
        if sid is None:
            return False
        if body.get("ok") is True:
            row = self._capture_row(sid, body.get("attachment_id"))  # (an upload of that conversation)
            if row["message_id"] is not None:
                raise CaptureError("error", "That attachment was sent already.")
            src = body.get("source") if isinstance(body.get("source"), dict) else {}
            payload = {"ok": True, "attachment_id": row["id"],
                       "source": {"name": str(src.get("name") or "")[:200], "kind": str(src.get("kind") or "")[:20]}}
        else:
            payload = {"ok": False, "code": str(body.get("code") or "error")[:40],
                       "message": str(body.get("message") or "")[:400]}
        return self.capture.resolve(rid, mate_id, payload)

    # ---- delegation results ----

    def _on_turn_end(self, sid: str, outcome: dict[str, Any]) -> None:
        if self._svc.is_mate_session(sid):
            self.capture.cancel_session(sid)  # (a capture still waiting: the turn that wanted it is over)
        d = self._delegations.get(sid)
        if d is not None:
            self._delegations.pop(sid, None)
            if not d["auto_only"] or outcome.get("trigger") == "auto":
                try:
                    title = self._svc.get(sid)["title"]
                except KeyError:
                    title = d["title"]
                entry = {"session_id": sid, "title": title, "status": outcome.get("status") or "error",
                         "text": outcome.get("text") or "", "error": outcome.get("error"), "depth": d["depth"]}
                bg = self._svc.running_task_count(sid)
                if bg and entry["status"] == "ok":
                    # Work continues in the background: report again when the
                    # chat's own follow-up turn (the task finished) ends.
                    entry["background"] = bg
                    self._delegations[sid] = {**d, "auto_only": True, "at": time.time()}
                self._pending.setdefault(d["mate_sid"], []).append(entry)
                asyncio.get_running_loop().call_soon(self._flush, d["mate_sid"])
        if self._svc.is_mate_session(sid):
            if outcome.get("trigger") == "turn" and "meta" in outcome:
                try:
                    mate_id = (self._svc.get(sid).get("mate_id") or "")
                    if mate_id:
                        self._relation_turn(mate_id, outcome)
                except Exception as exc:  # noqa: BLE001 - never breaks the turn loop
                    self._log("warning", f"relationship: {exc}")
            self._depth.pop(sid, None)  # the next turn is the user's unless a result starts it
            if self._pending.get(sid):
                asyncio.get_running_loop().call_soon(self._flush, sid)

    @staticmethod
    def _result_block(e: dict[str, Any]) -> str:
        attrs = f'session_id="{_attr(e["session_id"])}" title="{_attr(e["title"])}" status="{e["status"]}"'
        if e.get("background"):
            attrs += f' background_tasks="{e["background"]}"'
        body = _trim_answer(e["text"]) if e["status"] == "ok" else (
            (e.get("error") or "the turn failed") + (("\n\nPartial answer:\n" + _trim_answer(e["text"]))
                                                      if e.get("text") else ""))
        if e.get("background"):
            body += (f"\n\n(The chat still has {e['background']} background task(s) running; you will get "
                     "another result when it reacts to them.)")
        return f"<delegation_result {attrs}>\n{body or '(no text answer)'}\n</delegation_result>"

    def _flush(self, mate_sid: str) -> None:
        items = self._pending.get(mate_sid)
        if not items or self._svc.is_running(mate_sid):
            return  # (delivered when the mate's current turn ends)
        self._pending.pop(mate_sid, None)
        depth = max(int(e["depth"]) for e in items) + 1
        delegs = [{"session_id": e["session_id"], "title": e["title"], "status": e["status"]} for e in items]
        try:
            if depth > MAX_CHAIN:
                for e in items:
                    self._svc.add_notice(
                        mate_sid, "mate.delegation_held",
                        f"\"{e['title']}\" finished ({e['status']}) — not handed to the mate automatically "
                        "after several automatic hand-offs in a row.", delegation=delegs)
                return
            self._svc.start_turn(mate_sid, "\n\n".join(self._result_block(e) for e in items),
                                 meta={"internal": True, "kind": "delegation_result", "delegations": delegs})
            self._depth[mate_sid] = depth
        except TurnBusyError:
            self._pending.setdefault(mate_sid, [])[:0] = items  # retried when that turn ends
        except KeyError:
            pass  # the mate's conversation is gone

    # ---- introspection (tests / admin) ----

    def describe(self) -> dict[str, Any]:
        return {"delegations": {k: {**v} for k, v in self._delegations.items()},
                "pending": {k: len(v) for k, v in self._pending.items()}, "at": now_iso()}


def find_folders(query: str, chats: list[tuple[str, str]], roots: list[str], *, limit: int = 20,
                 max_depth: int = 3, budget_s: float = 2.5, max_dirs: int = 40000) -> list[dict[str, Any]]:
    """Folders matching ``query``: existing chats' workspaces first, then a
    bounded walk of ``roots`` (depth <= 3; hidden, node_modules, build dirs
    skipped). Names are compared ignoring case, spaces, - _ and ."""
    q = _norm(query)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path, title in chats:
        if path in seen:
            continue
        if q in _norm(os.path.basename(path.rstrip("/"))) or q in _norm(title or ""):
            seen.add(path)
            out.append({"path": path, "source": f"chat \"{title}\"", "exists": os.path.isdir(path)})
    hits: list[tuple[tuple, dict[str, Any]]] = []
    deadline = time.monotonic() + budget_s
    visited = 0
    queue = collections.deque((r, 0) for r in roots if os.path.isdir(r))  # breadth first: shallow dirs first
    while queue and visited < max_dirs and time.monotonic() < deadline:
        d, depth = queue.popleft()
        try:
            with os.scandir(d) as it:
                entries = [e for e in it if e.is_dir(follow_symlinks=False)]
        except OSError:
            continue
        for e in entries:
            name = e.name
            if name.startswith(".") or name in _SKIP_DIRS:
                continue
            visited += 1
            if q in _norm(name) and e.path not in seen:
                seen.add(e.path)
                git = os.path.isdir(os.path.join(e.path, ".git"))
                rank = (0 if _norm(name) == q else 1, 0 if git else 1, e.path.count("/"), len(e.path))
                hits.append((rank, {"path": e.path, "git": git}))
            if depth + 1 < max_depth:
                queue.append((e.path, depth + 1))
    hits.sort(key=lambda h: h[0])
    out += [h for _, h in hits]
    return out[:limit]
