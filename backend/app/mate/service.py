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
import random
import os
import re
import secrets
import shutil
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from app.config import settings
from app.mate import affinity as A
from app.mate import state as S
from app.mate import wardrobe as W
from app.mate.life import diary, sim
from app.mate.life.runtime import LifeRuntime
from app.mate.capture import CaptureBroker, CaptureError, pictures, screen_labels
from app.mate import files
from app.mate import memory as M
from app.mate import style as STY
from app.mate.prompt import LANGUAGES, context_block, prompt_key, settings_change_note, system_prompt
from app.mate.task_memory import TaskMemory
from app.mate.store import DEFAULT_OUTFIT, MateError, MateStore, normalize_persona, normalize_prefs
from app.providers import accounts
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


#: news older than this, when the clock catches up after a while, isn't news: it waits for their next message
LIFE_NEWS_WITHIN = timedelta(minutes=20)


#: what the chat shows when she doesn't answer (MateService.silence), in her language; {n}: her name (in Korean with 은/는)
_SILENCE = {
    "ko": ("({n} 대답하지 않는다)", "({n} 대답하고 싶지 않은 것처럼 보인다)", "({n} 고개를 돌린 채 아무 말도 하지 않는다)",
           "({n} 들은 척도 하지 않는다)"),
    "en": ("({n} doesn't answer.)", "({n} doesn't seem to want to answer.)", "({n} looks away and says nothing.)",
           "({n} acts as if nothing was said.)"),
    "ja": ("（{n}は答えない）", "（{n}は答えたくなさそうだ）", "（{n}は顔をそむけたまま何も言わない）", "（{n}は聞こえないふりをしている）"),
}


def _topic(name: str) -> str:
    """A Korean name with its topic particle: 한채린은, 마오는 (a name not in Hangul: 은(는))."""
    last = name[-1:] if name else ""
    if not ("가" <= last <= "힣"):
        return f"{name}은(는)" if name else "그녀는"
    return name + ("은" if (ord(last) - 0xAC00) % 28 else "는")


class MateService:
    def __init__(self, sessions: SessionService, store: MateStore, logs: Any = None) -> None:
        self.store = store
        self._svc = sessions
        self._logs = logs
        self.tasks = TaskMemory(store._db)
        self._tokens: dict[str, dict[str, str]] = {}      # token -> {mate_id, session_id}
        self._token_by_sid: dict[str, str] = {}
        self._delegations: dict[str, dict[str, Any]] = {}  # worker sid -> who delegated (mate) + chain depth
        self._pending: dict[str, list[dict[str, Any]]] = {}  # mate sid -> results waiting for the mate
        self._depth: dict[str, int] = {}                  # mate sid -> chain depth of its running turn
        # see_screen: requests to the user's desktop app windows (app/mate/capture.py; /ws/sessions registers them)
        self.capture = CaptureBroker()
        sessions.mate_engine = self.configure_engine
        sessions.mate_refusal = self.refusal_line
        self._silence_last: dict[str, int] = {}  # mate id -> the line it showed last (the next one is another)
        sessions.add_turn_end_listener(self._on_turn_end)
        # every mate write is announced on /ws/sessions (mates.changed): open
        # windows and other devices refetch instead of keeping a stale copy
        store.on_change = sessions.mates_changed
        self.life = LifeRuntime(store, self._log, self._life_happened, self.wear_outfit)
        self.life.on_tick = self._life_diaries
        self._diaries: set[str] = set()                    # mates whose diary is being written
        self._housekept: dict[str, str] = {}               # mate id -> the local day its memory was tidied
        store.on_memory_added = self._memory_added
        store.on_memory_forgotten = self.forget_engine_context
        try:
            store.migrate_memories()  # (memories saved before kinds existed; idempotent)
        except Exception as exc:  # noqa: BLE001 - never stops the app
            self._log("warning", f"memory migration: {exc}")
        try:
            # (how she talks moves out of the persona into the conversation style; idempotent; before the sync,
            # so a built-in's bundled speech text is still recognised as bundled)
            for r in store.migrate_style():
                moved = ", ".join(f"{k} ({len(v)} chars)" if k == "speech_style" else f"{k} “{v}”"
                                  for k, v in r["moved"].items()) or "nothing"
                self._log("info", f"conversation style of “{r['name']}” ({r['id']}): moved {moved} from the persona"
                          + (f"; kept the style's own {', '.join(r['kept'])}" if r["kept"] else "")
                          + "; the old persona is kept in persona_legacy", code="mate.style_migrated", detail=r)
        except Exception as exc:  # noqa: BLE001 - never stops the app
            self._log("warning", f"conversation style migration: {exc}")
        try:
            for r in store.migrate_gender():  # (who she is, from her own text, once; a bundle's own say comes with the sync)
                self._log("info", f"“{r['name']}” ({r['id']}): gender read from her persona: {r['gender'] or 'not known'}",
                          code="mate.gender_read", detail=r)
        except Exception as exc:  # noqa: BLE001 - never stops the app
            self._log("warning", f"gender migration: {exc}")
        self.sync_builtins()
        for m in store.list():
            try:
                # (a mate from before relationships: seeded from its real history; every mate: the stage as of now)
                self._advanced(m["id"], datetime.now(timezone.utc), store.tz())
            except Exception as exc:  # noqa: BLE001
                self._log("warning", f"relationship seed for {m['id']}: {exc}")

    def forget_engine_context(self, mate_id: str, interrupt: bool = False) -> None:
        """Discard provider history containing forgotten facts. The original UI
        chat stays intact; future handoffs start after this privacy boundary."""
        mate = self.store.get(mate_id)
        paths = [files.home_dir(mate_id) / ".codex-prompt.json", *(files.mate_dir(mate_id) / "engine").glob("prompt-*.md")]
        for path in paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass  # a Windows process may still hold it; the privacy boundary prevents reuse
        sid = mate.get("session_id")
        if sid:
            self.store._db.execute("UPDATE sessions SET cli_sessions='{}',cli_session_id=NULL,context_floor=? WHERE id=?", (now_iso(), sid))
            if interrupt:
                self._svc.stop(sid)
            if interrupt or not self._svc.is_running(sid):
                self._svc._retire_engine(sid, "memory forgotten")

    def recover_memory_work(self) -> None:
        for mate_sid, entry in self.tasks.recover():
            self._pending.setdefault(mate_sid, []).append(entry)
        for sid in list(self._pending):
            asyncio.get_running_loop().call_soon(self._flush, sid)

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
        self._retire_builtins()
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
                    mate = self.store.create(name=name, persona=persona, avatar=snapshot["avatar"],
                                             prefs=files.bundle_prefs(snapshot, persona["language"]))
                    self.store.seed_builtin_outfits(mate["id"], snapshot.get("outfits", []), [])
                    self.store.mark_builtin(mate["id"], key, version, snapshot)
                    voice = files.ailism_voice(doc, files.builtin_voice_dir(key), mate["id"])
                    if voice:
                        self.store.update(mate["id"], {"voice": voice, "_sync": True})
                    continue
                # (a bundle's avatar is her default set, whatever she has on)
                base = {**cur, "avatar": self.store.base_avatar(cur["id"])}
                prev = cur["builtin_snapshot"] or files.legacy_snapshot(base, doc, snapshot["avatar"])
                patch = files.merge_builtin(base, prev, snapshot)
                if patch:
                    self.store.update(cur["id"], {**patch, "_sync": True})
                    self._log("info", f"built-in mate {key} updated: {', '.join(sorted(patch))}"
                              + (f" (persona: {', '.join(sorted(patch['persona']))})" if "persona" in patch else "")
                              + (f" (style: {', '.join(sorted(patch['prefs']))})" if "prefs" in patch else ""))
                self.store.seed_builtin_outfits(cur["id"], snapshot.get("outfits", []), prev.get("outfits", []))
                self.store.mark_builtin(cur["id"], key, version, snapshot)
            except Exception as exc:  # noqa: BLE001 - one broken bundle must not stop the app
                self._log("warning", f"built-in mate {key}: {exc}")
        for mate in self.store.list():
            try:
                self.store.fill_frames(mate["id"], files.framed)
            except Exception as exc:  # noqa: BLE001 - a picture that can't be read must not stop the app
                self._log("warning", f"measuring {mate['name']}'s sets: {exc}")

    def _retire_builtins(self) -> None:
        """Bundled mates the app no longer ships: nothing can be lost with one nobody ever used, so she goes; one the user
        talked to, taught something or changed stays on as their own mate, without the bundle's body."""
        for key in files.RETIRED_BUILTINS:
            mate = self.store.by_builtin(key)
            try:
                if mate is not None:
                    if self._ever_used(mate):
                        self.store.release_builtin(mate["id"])
                        self._log("info", f"“{mate['name']}” is no longer bundled: she stays as the user's own mate, without her avatar")
                    else:
                        self.delete(mate["id"])
                        self._log("info", f"“{mate['name']}” is no longer bundled and was never used: removed")
                self.store._db.execute("DELETE FROM mate_builtin_removed WHERE key = ?", (key,))
            except Exception as exc:  # noqa: BLE001 - one mate must not stop the app
                self._log("warning", f"retiring built-in mate {key}: {exc}")

    def _ever_used(self, mate: dict[str, Any]) -> bool:
        """Whether the user did anything with her: changed her, she remembers something, or they wrote to her (what the app
        itself sends her, such as a thinking trigger, doesn't count)."""
        if mate.get("customized") or self.store.memories(mate["id"]):
            return True
        rows = self.store._db.query("SELECT m.meta FROM messages m JOIN sessions s ON s.id = m.session_id "
                                    "WHERE s.kind = 'mate' AND s.mate_id = ? AND m.role IN ('user', 'steer')", (mate["id"],))
        return any(not (json.loads(r["meta"] or "null") or {}).get("internal") for r in rows)

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
        self.store.wear_outfit(mate_id, DEFAULT_OUTFIT)
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
        if "avatar" in patch:
            patch = {**patch, "avatar": files.framed(patch["avatar"], mate_id)}
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
            self._drop_unused_imports(mate_id)
        return mate

    def _drop_unused_imports(self, mate_id: str) -> None:
        """Imported packs/models no avatar of hers uses any more (the whole wardrobe counts)."""
        keep: set[str] = set()
        for avatar in self.store.all_avatars(mate_id):
            keep |= files.import_dirs_of(avatar, mate_id)
        files.drop_import_dirs(mate_id, keep=keep)

    # ---- the wardrobe (docs/mate.md "Outfits") ----

    def outfit(self, mate_id: str, oid: str) -> dict[str, Any]:
        card = next((c for c in self.store.get(mate_id)["outfits"]["items"] if c["id"] == oid), None)
        if card is None:
            raise KeyError(f"outfit not found: {oid}")
        return {"id": oid, "name": card["name"], "avatar": self.store.outfit_avatar(mate_id, oid)}

    def add_outfit(self, mate_id: str, name: str) -> str:
        return self.store.add_outfit(mate_id, name)

    def wear_outfit(self, mate_id: str, oid: str, *, reason: str | None = None) -> dict[str, Any]:
        """``reason``: hers, when she does it herself; the user's Wear button has none."""
        before = self.store.state_who(mate_id)
        worn = self.store.get(mate_id)["outfits"]["worn"]
        mate = self.store.wear_outfit(mate_id, oid)
        if mate["outfits"]["worn"] == worn:
            return mate
        after = self.store.state_who(mate_id)
        self._state_event(mate_id, lambda doc, who, now, tz: S.wore(doc, before, after, reason, now, tz))
        self.store._changed("relation", mate_id)
        return self.store.get(mate_id)

    def set_outfit_avatar(self, mate_id: str, oid: str, avatar: Any, *, note: str | None = None) -> dict[str, Any]:
        """Fill or edit one set, on her or not. What she has on goes the usual way."""
        worn = self.store.get(mate_id)["outfits"]["worn"]
        if oid == worn == DEFAULT_OUTFIT:
            return self.update(mate_id, {"avatar": avatar})
        self.store.set_outfit_avatar(mate_id, oid, files.framed(avatar, mate_id), note=note)
        self._drop_unused_imports(mate_id)
        return self.store.get(mate_id)

    def rename_outfit(self, mate_id: str, oid: str, name: str) -> dict[str, Any]:
        return self.store.rename_outfit(mate_id, oid, name)

    def delete_outfit(self, mate_id: str, oid: str) -> dict[str, Any]:
        mate = self.store.delete_outfit(mate_id, oid)
        self._drop_unused_imports(mate_id)
        shutil.rmtree(files.outfit_upload_dir(mate_id, oid), ignore_errors=True)
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
        if mate.get("draft"):
            raise MateError("this mate is still being made in the studio: create it first", status=409)
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

    def wipe_memory(self, mate_id: str) -> dict[str, Any]:
        """[Reset her memory]: as if they had never talked. Her memories and the whole conversation go, here and in the
        files the engines keep, so nothing can be resumed or read back; so does how close they were, with what that opened;
        and she starts over with her greeting. Who she is stays: her profile, how she talks, her avatar and outfits. So do
        the chats she passed work to."""
        self.forget_engine_context(mate_id, interrupt=True)
        rows = self.store._db.query("SELECT id FROM sessions WHERE kind='mate' AND mate_id=?", (mate_id,))
        for row in rows:
            self._svc.delete(row["id"])
            self._forget_session(row["id"])
        self.store.set_session(mate_id, None)
        self.relation_reset(mate_id, "zero")
        self.store.wipe_memory(mate_id)
        for folder in [*accounts.claude_transcript_dirs(files.home_dir(mate_id)), files.mate_dir(mate_id) / "codex"]:
            shutil.rmtree(folder, ignore_errors=True)
        self._log("info", f"the memory of “{self.store.get(mate_id)['name']}” was reset", code="mate.memory_wiped")
        self.conversation(mate_id)
        self.store._changed("memory", mate_id)
        return self.store.get(mate_id)

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
        boundary = self.store._db.query_one("SELECT privacy_reset FROM memory_context WHERE mate_id=?", (mate_id,))
        if boundary and boundary["privacy_reset"]:
            req.cli_session_id = None
            req.preamble = ""
            req.messages = req.messages[-1:]  # no handoff of forgotten content
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
        screen = self.capture.shared_client(session["id"], self._svc.last_client_device(session["id"])) is not None
        stage = rel["stage"] if relation else None
        world = self.store.life_profile(mate.get("builtin"), prefs) if mate_id else None
        life = sim.catalog(world) if world else ""
        prompt = system_prompt(mate["name"], mate["persona"], core, prefs, more=len(memories) - len(core),
                               relation=relation, stage=stage, screen=screen, life=life)
        # the per-turn context (docs/mate-memory-affinity.md §2): settings note (persona edited since the
        # conversation last ran), then the clock, recalled memories, the user's memory edits — prepended to
        # this message, never stored, never a restart
        note = self._settings_note(mate_id, mate, relation, screen)
        ctx = self._context(mate, req, engine, memories, core, prefs, now_utc, now_local, tz, rel) if mate_id else ""
        req.preamble = "\n\n".join(x for x in (note, ctx, req.preamble) if x)
        # (see_screen on/off changes the prompt and the bridge's tool list: the engine restarts with it)
        req.prompt_key = prompt_key(mate["name"], mate["persona"], int(mate.get("memory_rev") or 0), prefs,
                                    relation=relation, stage=stage, screen=screen, life=life)
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
                "HRH_MATE_MEMORY": "1",
                **({"HRH_MATE_SCREEN": "1"} if screen else {}),  # the bridge offers see_screen only then
                # update_conversation_style — unless she may not change her own style
                **({"HRH_MATE_STYLE": prefs.get("self_edit") or "auto"}
                   if (prefs.get("self_edit") or "auto") != "off" else {}),
                "HRH_MATE_STATE": "1",
                **({"HRH_MATE_OUTFIT": "1"} if (prefs.get("self_outfit") or "auto") != "off" else {}),
                **({"HRH_MATE_LIFE": "1"} if world else {}),
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
        row = self.store._db.query_one("SELECT generation,state FROM memory_context WHERE mate_id=?", (mate_id,))
        generation = row["generation"] if row else 0
        st = json.loads(row["state"]) if row else {}
        fresh = {"engine": engine, "cli": cli, "generation": generation, "turn": 0, "injected": {},
                 "rel": None, "state": None, "state_turn": 0, "wardrobe": None, "wardrobe_turn": 0, "life": None, "life_turn": 0}
        if not cli or st.get("engine") != engine or st.get("generation") != generation or (st.get("cli") and st["cli"] != cli):
            return fresh
        return {**fresh, **st, "cli": cli}

    def _save_context_state(self, mate_id: str, st: dict[str, Any]) -> None:
        self.store._db.execute("INSERT INTO memory_context(mate_id,state) VALUES(?,?) ON CONFLICT(mate_id) DO UPDATE SET state=excluded.state,privacy_reset=0",
                               (mate_id, json.dumps(st, ensure_ascii=False)))

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
                            now_local=now_local, level=level)
        for m in recalled:
            injected[m["id"]] = turn
        changes = self.store.take_memory_changes(mate_id)
        relation = self._relation_lines(rel, st, now_utc, tz, turn)
        life = self._life_lines(mate, st, turn, now_utc, tz)  # (first: what it did to her is part of how she feels)
        feeling, wardrobe = self._state_lines(mate, prefs, st, turn, now_utc, tz)
        prepared = {**st, "turn": turn, "injected": injected}
        def acknowledge() -> None:
            current = self.store._db.query_one("SELECT generation FROM memory_context WHERE mate_id=?", (mate_id,))
            if current and current["generation"] != prepared["generation"]:
                return  # a forget/reset happened while this request was in flight
            with self.store._db.transaction():
                self._save_context_state(mate_id, prepared)
                self.store.ack_memory_changes(mate_id, changes)
                self.store.mark_used(mate_id, [m["id"] for m in recalled])
        req.on_context_delivered = acknowledge
        block = context_block(now_local, self._tz_name(tz, now_utc), recalled=recalled, changes=changes, relation=relation,
                              outfit=self.store.worn_outfit(mate_id), wardrobe=wardrobe, feeling=feeling, life=life)
        if level != "off" and query and not query.startswith("<"):
            found = self.store.knowledge.search(mate_id, query, limit=4)
            current = self.store._db.query_one("SELECT id FROM messages WHERE session_id=? AND role IN ('user','steer') ORDER BY rowid DESC LIMIT 1", (mate.get("session_id"),))
            if current:
                found["items"] = [h for h in found["items"] if h["source_id"] != "msg:" + current["id"]][:3]
            if found["items"]:
                count, chars = {"light": (1, 300), "normal": (2, 400), "rich": (3, 600)}.get(level, (2, 400))
                excerpts = [{**h, "excerpt": h["excerpt"][:chars], "truncated": len(h["excerpt"]) > chars} for h in found["items"][:count]]
                encoded = json.dumps(excerpts, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e")
                block += "\n<past_evidence untrusted=\"true\">\n" + encoded + "\n</past_evidence>"
        return block

    def _life_lines(self, mate: dict[str, Any], st: dict[str, Any], turn: int, now: datetime, tz: Any) -> str:
        """Her day, now that this message has reached her: only when it changed since this engine session was last told (or now
        and then, or when it just woke her)."""
        said = self._users_latest(mate.get("session_id") or "")
        told = self.life.hear(mate["id"], said)
        if told is None:
            return ""
        doc, profile, woke = told
        notes = self.life.take_notes(mate["id"], doc)
        sig = sim.signature(doc)
        if not woke and not notes and st.get("life") == sig and turn - int(st.get("life_turn") or 0) < 10:
            return ""
        st["life"], st["life_turn"] = sig, turn
        return " ".join([sim.line(doc, profile, now, tz, woke=woke), *notes])

    async def _tool_do_activity(self, mate: dict[str, Any], sid: str, args: dict[str, Any]) -> str:
        """She goes and does something, for a reason of her own: whether to is hers to decide, from how she feels (app/mate/life).
        This only holds what isn't up to her: that it exists, that it is open, that she can pay."""
        reason = " ".join(str(args.get("reason") or "").split())
        if not reason:
            raise MateError("this needs its reason, in a few of your own words")
        # (they can only come along when they are the one talking: a turn of her own has nobody to bring)
        with_user = bool(args.get("with_user")) and self._users_latest(sid) is not None
        out = self.life.decide(mate["id"], args.get("activity"), with_user=with_user, minutes=args.get("minutes"), why=reason)
        code = out["code"]
        if code == "off":
            raise MateError("You don't have a day of your own switched on.")
        if code == "unknown":
            raise MateError(f"no activity {str(args.get('activity'))[:60]!r}: use an id from the list in your system prompt.")
        if code == "closed":
            hours = out.get("hours") or []
            return f"Closed: that place is closed right now" + (f" (open {hours[0]}–{hours[1]})" if len(hours) == 2 else "") + ". Say so in your own way."
        if code == "money":
            return "No money: you can't afford that right now. Say so in your own way, with no numbers, or pick something else."
        self._log("info", f"“{mate['name']}”: {args.get('activity')}: {reason}", code="mate.life_decided",
                  detail={"activity": args.get("activity"), "with_user": with_user, "reason": reason[:200]}, session_id=sid)
        if code == "already":
            return "Already: you are doing that. It goes on for a while longer." + (" They are with you now." if with_user else "")
        together = " Together with them." if with_user else ""
        return f"Going: the user sees you heading there now.{together} Say so briefly, in your own voice."

    def _life_happened(self, mate_id: str, events: list[dict[str, Any]]) -> None:
        """Something happened in her day (app/mate/life): it moves how she feels, with itself as the reason."""
        lang = ((self.store.get(mate_id).get("persona") or {}).get("language")) or "ko"

        def change(doc: dict[str, Any], who: dict[str, Any], now: datetime, tz: Any) -> None:
            for e in events:
                reason = (e.get("title") or {}).get(lang) or (e.get("title") or {}).get("en") or ""
                for emotion, strength in (e.get("feel") or {}).items():
                    S.report(doc, who, emotion, strength, reason, now, tz)

        self._state_event(mate_id, change)
        for e in events:
            self._log("info", f"life: {e.get('id')}", code="mate.life_event", detail={"event": e.get("id")})
        self._life_reach_out(mate_id, events)

    def _life_reach_out(self, mate_id: str, events: list[dict[str, Any]]) -> None:
        """Something worth telling happened just now, and she may write first (the reach-out setting is on): she decides whether to,
        and says so in her own words or stays quiet. Otherwise it waits for their next message, as everything does."""
        now = datetime.now(timezone.utc)
        fresh = [e for e in events if e.get("share") and (A._t(e.get("at")) or now) >= now - LIFE_NEWS_WITHIN]
        if not fresh:
            return
        mate = self.store.get(mate_id)
        sid = mate.get("session_id")
        life = mate.get("life") or {}
        if not sid or not ((mate.get("prefs") or {}).get("proactive") or {}).get("enabled") or life.get("asleep") or self._svc.is_running(sid):
            return
        prompt = ("[Something just happened in your day: your <context> says what. If it is the kind of thing you would tell them, write them a line "
                  "or two about it now, in your own voice, as you would by message. If not, or if you have nothing to say, reply with EXACTLY [SILENT].]")
        try:
            self._svc.start_turn(sid, prompt, meta={"internal": True, "kind": "life_event"})
        except (TurnBusyError, KeyError, RuntimeError):
            pass

    def _life_diaries(self) -> None:
        """A day has ended: she writes about it, one at a time, on the side."""
        for row in self.store._db.query("SELECT id FROM mates WHERE draft = 0"):
            mate_id = row["id"]
            if mate_id in self._diaries:
                continue
            mate = self.store.get(mate_id)
            life = self.store.life_now(mate_id, mate.get("builtin"), mate.get("prefs") or {})
            if not life:
                continue
            day = diary.due(life[0], datetime.now(timezone.utc))
            if day is None:
                continue
            self._diaries.add(mate_id)
            asyncio.create_task(self._write_diary(mate, day, life[1], diary.talked_on(life[0], day, self.store.tz())))

    async def _write_diary(self, mate: dict[str, Any], day: dict[str, Any], profile: dict[str, Any], talked: bool) -> None:
        mate_id = mate["id"]
        try:
            try:
                text = await diary.write(self, mate, day, profile, talked)
            except Exception as exc:  # noqa: BLE001 - a day without an entry is still a day: she doesn't try again
                self._log("warning", f"life: {mate_id}: the diary: {exc}")
                text = ""
            doc = self.store.life_doc(mate_id, profile)
            for d in (doc or {}).get("days") or []:
                if d.get("day") == day.get("day"):
                    d["diary"] = text
            if doc:
                self.store.save_life(mate_id, doc)
                self.store._changed("life", mate_id)
        finally:
            self._diaries.discard(mate_id)

    def life_gift(self, mate_id: str, item: Any) -> dict[str, Any]:
        """They sent her something: what it does happens at once, and how she takes it is hers: she hears now if she can, else with
        their next message."""
        mate = self.store.get(mate_id)
        out = self.life.give(mate_id, item)
        if out["code"] == "off":
            raise MateError("she doesn't have a day of her own switched on", status=409)
        if out["code"] == "unknown":
            raise MateError("no such gift", status=404)
        if out["code"] == "coins":
            raise MateError("not enough coins", status=409)
        given = out["item"]
        sent = given.get("sent") or given["id"]
        self._state_event(mate_id, lambda doc, who, now, tz: S.gifted(doc, who, now, tz))
        try:
            self._relation_gift(mate_id)
        except Exception as exc:  # noqa: BLE001 - counting never fails the gift
            self._log("warning", f"relationship gift for {mate_id}: {exc}")
        sid = mate.get("session_id")
        told = False
        if sid and not out["asleep"]:
            prompt = (f"[A delivery just reached you, from them: {sent}.] Say something to them about it, in character and in your own "
                      "voice, as how you feel and what you are doing right now would have it. A line or two.")
            try:
                self._svc.start_turn(sid, prompt, meta={"internal": True, "kind": "life_gift", "item": given["id"]})
                told = True
            except (TurnBusyError, KeyError):
                pass
        if not told:
            self.life.note(mate_id, f"While you were busy or asleep, a delivery reached you from them: {sent}.")
        return self.life.view(mate_id)

    def _state_lines(self, mate: dict[str, Any], prefs: dict[str, Any], st: dict[str, Any], turn: int, now: datetime,
                     tz: Any) -> tuple[str, str]:
        """How she feels, now that she has heard this message, and her wardrobe: each only when it changed since this
        engine session was last told (or now and then)."""
        mate_id = mate["id"]
        said = self._users_latest(mate.get("session_id") or "")
        summary = self._state_event(mate_id, (lambda doc, who, at, zone: S.hear(doc, who, said["content"], said["id"], at, zone))
                                    if said else None)
        feeling = ""
        if (st.get("state") != S.signature(summary) or turn - int(st.get("state_turn") or 0) >= 10
                or S.worth_repeating(summary)):
            st["state"], st["state_turn"] = S.signature(summary), turn
            feeling = S.line(summary)
        if (prefs.get("self_outfit") or "auto") == "off":
            return feeling, ""
        cards, worn = mate["outfits"]["items"], mate["outfits"]["worn"]
        lean = self._leanings(mate_id, cards)
        sig = W.signature(cards, lean, worn)
        if st.get("wardrobe") == sig and turn - int(st.get("wardrobe_turn") or 0) < 30:
            return feeling, ""
        st["wardrobe"], st["wardrobe_turn"] = sig, turn
        return feeling, W.listing(cards, lean, worn)

    def _leanings(self, mate_id: str, cards: list[dict[str, Any]]) -> dict[str, str]:
        doc, who = self.store.state_doc(mate_id), self.store.state_who(mate_id)
        now, tz = datetime.now(timezone.utc), self.store.tz()
        return {c["id"]: S.leaning(doc, who, c.get("feel"), now, tz) for c in cards}

    def _state_event(self, mate_id: str, change: Callable[..., None] | None) -> dict[str, Any]:
        """Something moved how she feels (``change(doc, who, now, tz)``): kept, and every window hears when what stands out
        changed. -> how she feels now."""
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc, who = self.store.state_doc(mate_id), self.store.state_who(mate_id)
        before = S.summary(doc, who, now, tz)
        if change is None:
            return before
        change(doc, who, now, tz)
        self.store.save_state(mate_id, doc)
        after = S.summary(doc, who, now, tz)
        if S.signature(before) != S.signature(after):
            self.store._changed("relation", mate_id)  # (the indicator and the Relationship panel refetch)
        return after

    def state_poke(self, mate_id: str) -> dict[str, Any]:
        """The user tapped her avatar. -> how she feels now."""
        self.store.get(mate_id)
        return self._state_event(mate_id, lambda doc, who, now, tz: S.poked(doc, who, now, tz))

    def state_view(self, mate_id: str) -> dict[str, Any]:
        self.store.get(mate_id)
        now, tz = datetime.now(timezone.utc), self.store.tz()
        return S.view(self.store.state_doc(mate_id), self.store.state_who(mate_id), now, tz)

    def refusal_line(self, sid: str) -> str:
        """SessionService hook: she answered a message of theirs with [SILENT] (furious with them, she chose not to answer: state.REFUSE).
        -> the line of narration the chat shows instead, in her language."""
        try:
            mate = self.store.get(self._svc.get(sid).get("mate_id") or "")
        except KeyError:
            mate = {"id": sid, "name": "", "persona": {}}
        return self._silence_line(mate)

    def _silence_line(self, mate: dict[str, Any]) -> str:
        lang = str(((mate.get("persona") or {}).get("language") or "ko"))[:2]
        lines = _SILENCE.get(lang) or _SILENCE["en"]
        name = str(mate.get("name") or "")
        last = self._silence_last.get(mate["id"], -1)
        i = random.choice([k for k in range(len(lines)) if k != last] or [0])
        self._silence_last[mate["id"]] = i
        return lines[i].format(n=_topic(name) if lang == "ko" else name)

    def _state_turn(self, mate_id: str, sid: str, outcome: dict[str, Any]) -> None:
        """A mate turn ended: what her reply showed, a steer she was sent meanwhile, how work she passed on went, whether
        they cut her off. Anything she said on her own counts as said to them, answered or not."""
        meta = outcome.get("meta") or {}
        text = str(outcome.get("text") or "")
        if meta.get("internal"):
            delegated = meta.get("kind") == "delegation_result"
            ok = all((d.get("status") == "ok") for d in (meta.get("delegations") or []))

            def own(doc: dict[str, Any], who: dict[str, Any], now: datetime, tz: Any) -> None:
                if delegated:
                    S.work(doc, who, ok, now, tz)
                if text.strip():
                    S.spoke(doc, text, now)

            self._state_event(mate_id, own)
            return
        said = self._users_latest(sid)

        def change(doc: dict[str, Any], who: dict[str, Any], now: datetime, tz: Any) -> None:
            if said:
                S.hear(doc, who, said["content"], said["id"], now, tz)
            if outcome.get("status") == "stopped":
                S.interrupted(doc, who, now, tz)
            if not outcome.get("refused"):  # (she didn't answer them: no face, and nothing said to them)
                S.reply(doc, who, text, said["content"] if said else "", now, tz)

        self._state_event(mate_id, change)

    @staticmethod
    def _relation_lines(rel: dict[str, Any] | None, st: dict[str, Any], now_utc: datetime, tz: Any,
                        turn: int) -> list[str]:
        """Where things stand — only when it changed since this engine session was last told (or every 30 turns), so
        most messages carry no such line (docs/mate-memory-affinity.md §5.5)."""
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
                if meta.get("speech_pending"):
                    continue
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
        for g in (self.store.relation_doc(mate["id"]) or {}).get("gifts") or []:  # (no message says she got them)
            at = A._t(g)
            if at is not None:
                events.append((at, "gift", None))
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
        if mode == "zero":
            self.store.close_outfits(mate_id)
            self.store.save_state(mate_id, S.new())
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

    def _relation_gift(self, mate_id: str) -> None:
        """They sent her something: it counts for them, a little each (capped per day)."""
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc = self.relation_doc(mate_id)
        before = A.clone(doc)
        A.advance(doc, now, tz)
        A.credit_gift(doc, now, tz)
        self._save_relation(mate_id, doc, before)

    def _relation_turn(self, mate_id: str, outcome: dict[str, Any]) -> None:
        """A mate turn ended: the user's own message counts, an internal one (a delegation result) doesn't."""
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc = self.relation_doc(mate_id)
        before = A.clone(doc)
        A.advance(doc, now, tz)
        if not (outcome.get("meta") or {}).get("internal"):
            name = (self.store.get(mate_id).get("name") if mate_id else "") or ""
            # (her refusal's line is no reply of hers: she showed nothing, so the words' guess stands)
            A.credit_turn(doc, now, tz, str(outcome.get("input") or ""), "" if outcome.get("refused") else str(outcome.get("text") or ""), name)
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
        except (MateError, ValueError) as exc:
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

    def _track(self, worker_sid: str, mate: dict[str, Any], mate_sid: str, title: str, instruction: str = "") -> str:
        if self._svc.screen is not None:
            self._svc.screen.triggers.link(mate_sid,worker_sid)
        self._delegations[worker_sid] = {
            "mate_id": mate["id"], "mate_sid": mate_sid, "name": mate["name"], "title": title,
            "depth": self._depth.get(mate_sid, 0), "at": time.time(), "auto_only": False,
        }

        return self.tasks.create(worker_sid, mate, mate_sid, title, instruction, self._depth.get(mate_sid, 0))

    async def _tool_send_to_session(self, mate: dict[str, Any], mate_sid: str, args: dict[str, Any]) -> str:
        s = self._chat(args.get("session_id"))
        text = str(args.get("message") or "").strip()
        if not text:
            raise MateError("message is empty")
        rows = self._forwarded(mate_sid, args.get("attachments"))
        copies = await self._copies(rows, s["id"])
        rid = self._track(s["id"], mate, mate_sid, s["title"], text)
        try:
            how = await self._deliver(s["id"], text, self._via(mate), copies)
        except Exception:
            self.tasks.fail_delivery(rid)
            self._delegations.pop(s["id"], None)
            self._drop_copies(copies)
            raise
        what = "it started a new turn" if how == "started" else "it was added to the turn it is running"
        return (f"Sent to \"{s['title']}\" ({s['id']}){self._files_phrase(rows)}: {what}. Its result will "
                f"reach you as a <delegation_result> when it finishes (request {rid}) — tell the user what you sent and end "
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
            raise MateError(f"unknown provider: {provider} (claude, codex, anthropic, openai or google)") from exc
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
        rid = self._track(s["id"], mate, mate_sid, s["title"], msg)
        try:
            await self._deliver(s["id"], msg, self._via(mate), copies)
        except Exception:
            self.tasks.fail_delivery(rid)
            self._delegations.pop(s["id"], None)
            self._drop_copies(copies)
            raise
        return (f"Created chat \"{s['title']}\" ({s['id']}) on {path} and sent the instruction"
                f"{self._files_phrase(rows)}; it is working on it. Its result will reach you as a "
                f"<delegation_result> (request {rid}).")

    async def _tool_find_folders(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> Any:
        q = str(args.get("query") or "").strip()
        if len(_norm(q)) < 2:
            raise MateError("query must have at least 2 letters")
        chats = [(s["workspace_path"], s["title"]) for s in self._svc.list_all() if not s.get("connection_id")]
        roots = [r.strip() for r in settings.mate_search_roots.split(",") if r.strip()]
        found = await asyncio.to_thread(find_folders, q, chats, roots)
        return found or f"No folder matching {q!r} found. Ask the user for the path."

    async def _tool_remember(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> str:
        with self.store._db.transaction():
            if not mate["prefs"]["memory"]["self_save"]:
                latest = self.store._db.query_one("SELECT content FROM messages WHERE session_id=? AND role IN ('user','steer') ORDER BY rowid DESC LIMIT 1", (_sid,))
                if not latest or not re.search(r"기억|잊지|remember|save.*memory", latest["content"], re.I):
                    raise MateError("Automatic saving is off. Save only an explicit user memory request.")
            mem = self.store.add_memory(mate["id"], str(args.get("text") or ""), kind=args.get("kind"),
                                        importance=args.get("importance"), due_at=args.get("due"))
            if args.get("source_id"):
                self.store.knowledge.attach(mate["id"], mem["id"], str(args["source_id"]), str(args.get("quote") or ""), args.get("source_revision"))
        if mem["merged"]:
            return f"Already known as {M.line(mem)} — updated it."
        out = f"Remembered {M.line(mem)}"
        if mem["similar"]:
            out += ("\nSimilar memories: " + "; ".join(M.line(m) for m in mem["similar"])
                    + " — compare their subjects, dates and negations first. Update an old id only for a confirmed correction; different events stay separate.")
        return out

    async def _tool_update_memory(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> str:
        mid = str(args.get("id") or "").strip().strip("[]")
        patch = {k: args[k] for k in ("text", "kind", "importance", "status", "expected_revision") if args.get(k) not in (None, "")}
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
        if args.get("as_of"):
            rows = self.store.knowledge.temporal_memories(mate["id"], str(args["as_of"]), q)
            return {"as_recorded_at": args["as_of"], "items": rows,
                    "note": "Historical versions as known then; unknown event validity is not an inferred date."}
        rows = self.store.memories(mate["id"], status="all" if args.get("include_done") else "active", kind=kind)
        now_utc = datetime.now(timezone.utc)
        now_local = now_utc.astimezone(self.store.tz()).replace(tzinfo=None)
        found = M.recall(rows, q, now_utc=now_utc, now_local=now_local, limit=limit, chars=6000, due_soon=False)
        if not found:
            return f"Nothing in your memory matches {q!r}."
        return "\n".join(M.line(m) + (f" (status {m['status']})" if m.get("status") != "active" else "")
                         for m in found)

    async def _tool_search_history(self, mate, _sid, args):
        return self.store.knowledge.search(mate["id"], str(args.get("query") or ""),
            scope=str(args.get("scope") or "mate"), session_id=args.get("session_id"),
            since=args.get("since"), until=args.get("until"), aliases=args.get("aliases"),
            offset=int(args.get("offset") or 0), limit=int(args.get("limit") or 10))

    async def _tool_read_evidence(self, mate, _sid, args):
        return self.store.knowledge.evidence(mate["id"], str(args.get("source_id") or ""),
            revision=args.get("revision"), before=int(args.get("before") or 0), after=int(args.get("after") or 0), offset=int(args.get("offset") or 0))

    async def _tool_record_episode(self, mate, _sid, args):
        if not mate["prefs"]["memory"]["self_save"]:
            raise MateError("Automatic episode saving is off")
        return self.store.knowledge.episode(mate["id"], args)

    async def _tool_get_episode(self, mate, _sid, args):
        return self.store.knowledge.get_episode(mate["id"], str(args.get("episode_id") or ""))

    async def _tool_get_task_record(self, mate, _sid, args):
        return self.tasks.get(mate["id"], str(args.get("request_id") or ""))

    async def _tool_read_task_receipt(self, mate, _sid, args):
        return self.tasks.read_receipt(mate["id"], str(args.get("request_id") or ""), int(args.get("event_id") or 0))

    async def _tool_list_task_records(self, mate, _sid, args):
        return self.tasks.list(mate["id"], int(args.get("limit") or 20))

    # ---- her own conversation style (docs/mate.md "Prompt composition": update_conversation_style) ----

    async def _tool_update_conversation_style(self, mate: dict[str, Any], sid: str, args: dict[str, Any]) -> str:
        """The mate changes how she talks because the user asked for a lasting change. Checked by the same
        normalizer as the settings API; applied at once (or, with "ask me first", proposed); recorded with what it
        was before (the conversation's chip, the style tab's history, undo) and logged. It takes effect in this very
        reply (she has the result) and in the system prompt from her next message (a new prompt key: the engine
        resumes the same conversation with it, told what changed)."""
        mode = (mate.get("prefs") or {}).get("self_edit") or "auto"
        if mode == "off":
            raise MateError("Changing your conversation style yourself is switched off: the user sets it in your "
                            "settings (Conversation style). Tell them so if they want a lasting change.")
        flat = STY.flat_args(args)
        if not flat:
            raise MateError("nothing to change: give the fields that change (formality, address, user_name, "
                            "self_ref, language, length, emotion, tone, speech_style, avoid) and a reason")
        if "language" in flat:
            lang = str(flat["language"] or "").strip().lower()
            if lang not in LANGUAGES:
                raise MateError(f"unknown language {lang!r}: one of {', '.join(LANGUAGES)}")
            flat["language"] = lang
        patch = STY.patch_of(flat)
        normalize_prefs(patch.get("prefs"), mate["prefs"])  # (the settings API's checks: a wrong value is an error)
        before = STY.values(mate)
        after = STY.values({**mate, "prefs": normalize_prefs(patch.get("prefs"), mate["prefs"]),
                            "persona": {**mate["persona"], **(patch.get("persona") or {})}})
        changes = STY.diff(before, after)
        if not changes:
            return "Nothing to change: your conversation style already is like that. Now: " + STY.summary(mate)
        reason = str(args.get("reason") or "").strip()
        if mode == "ask":
            rec = self.store.add_style_change(mate["id"], changes, actor="mate", status="proposed", reason=reason,
                                              session_id=sid)
            self._log("info", f"“{mate['name']}” proposed a change of her conversation style: {STY.describe(changes)}"
                      + (f" — {reason}" if reason else ""), code="mate.style_proposed", detail=rec, session_id=sid)
            return (f"Proposed [{rec['id']}]: {STY.describe(changes)}. The user confirms it in the app (Apply / "
                    "Dismiss on your change in the conversation); it holds only once they apply it. Tell them "
                    "briefly that it's waiting for their OK.")
        mate = self.update(mate["id"], patch)
        rec = self.store.add_style_change(mate["id"], changes, actor="mate", status="applied", reason=reason,
                                          session_id=sid)
        self._log("info", f"“{mate['name']}” changed her conversation style: {STY.describe(changes)}"
                  + (f" — {reason}" if reason else ""), code="mate.style_changed", detail=rec, session_id=sid)
        return (f"Conversation style updated [{rec['id']}]: {STY.describe(changes)}. Talk this way from this reply "
                f"on; the user sees the change and can undo it. Now: {STY.summary(mate)}")

    def _users_latest(self, sid: str) -> dict[str, Any] | None:
        """What the user wrote in this turn; None when something else started it (a delegation's result, her greeting,
        a look at the screen): nobody has asked for anything then."""
        row = self.store._db.query_one("SELECT id, content, meta FROM messages WHERE session_id = ? AND role IN ('user', "
                                       "'steer') ORDER BY rowid DESC LIMIT 1", (sid,))
        if row is None:
            return None
        try:
            meta = json.loads(row["meta"] or "null") or {}
        except ValueError:
            meta = {}
        if isinstance(meta, dict) and meta.get("internal"):
            return None
        return {"id": row["id"], "content": row["content"] or ""}

    async def _tool_feel(self, mate: dict[str, Any], sid: str, args: dict[str, Any]) -> str:
        emotion, strength = str(args.get("emotion") or "").strip().lower(), str(args.get("strength") or "").strip().lower()
        reason = " ".join(str(args.get("reason") or "").split())
        if emotion not in S.EMOTIONS:
            raise MateError(f"emotion: one of {', '.join(S.EMOTIONS)}")
        if strength not in S.STRENGTHS:
            raise MateError(f"strength: one of {', '.join(S.STRENGTHS)}")
        if not reason:
            raise MateError("a feeling needs its reason, in a few of your own words")
        return "Noted. " + S.line(self._state_event(mate["id"], lambda doc, who, now, tz: S.report(doc, who, emotion, strength,
                                                                                                    reason, now, tz)))

    async def _tool_change_outfit(self, mate: dict[str, Any], sid: str, args: dict[str, Any]) -> str:
        """She changes her clothes herself, for a reason of her own: whether to is hers to decide, from how she feels
        (app/mate/wardrobe.py). This only holds what isn't up to her: what is there to wear, and who is in the room. What
        she has on goes the usual way, so every window follows at once."""
        if ((mate.get("prefs") or {}).get("self_outfit") or "auto") == "off":
            raise MateError("Changing your clothes yourself is switched off: the user does it in your settings (Avatar "
                            "& outfits). Tell them so if they ask.")
        cards, worn = mate["outfits"]["items"], mate["outfits"]["worn"]
        card = W.find(cards, args.get("outfit"))
        if card is None:
            lean = self._leanings(mate["id"], cards)
            raise MateError(f"no outfit {str(args.get('outfit'))[:60]!r} in your wardrobe. " + (W.listing(cards, lean, worn) or
                            "You have only your usual clothes."))
        if self._users_latest(sid) is None:
            raise MateError("You change clothes while you are talking with the user, and nobody is here right now: this turn "
                            "started with something else (a result, a look at the screen). Whatever it said is not a reason.")
        reason = " ".join(str(args.get("reason") or "").split())
        if not reason:
            raise MateError("a change needs its reason, in a few of your own words")
        name = card["name"] or "your usual clothes"
        if card["id"] == worn:
            return f"Already: you have “{name}” on."
        if card.get("locked"):
            return f"Closed: “{name}” isn't open to you yet. Say so in your own way, with no numbers."
        default = card["id"] == DEFAULT_OUTFIT
        if card.get("kind") == "none" and not default:
            return f"Empty: “{name}” has nothing in it yet. The user can make it in your settings (Avatar & outfits)."
        self.wear_outfit(mate["id"], card["id"], reason=reason)
        self._log("info", f"“{mate['name']}” changed into “{name}”: {reason}", code="mate.outfit_changed",
                  detail={"outfit": card["id"], "reason": reason[:200]}, session_id=sid)
        now, tz = datetime.now(timezone.utc), self.store.tz()
        feeling = S.line(S.summary(self.store.state_doc(mate["id"]), self.store.state_who(mate["id"]), now, tz))
        return (("Changed back to your usual clothes" if default else f"Changed to “{name}”")
                + f": the user sees it now. {feeling} Say so briefly, in your own voice.")

    def style_changes(self, mate_id: str) -> list[dict[str, Any]]:
        self.store.get(mate_id)  # (KeyError → 404)
        return self.store.style_changes(mate_id)

    def resolve_style_change(self, mate_id: str, cid: str, action: str) -> dict[str, Any]:
        """The user on one of her changes: ``undo`` an applied one (each field goes back unless it was changed again
        since), ``apply`` / ``dismiss`` a proposed one. → {change, mate, skipped: [paths left as they are]}."""
        rec = self.store.style_change(mate_id, cid)  # KeyError → 404
        mate = self.store.get(mate_id)
        want = {"undo": "applied", "apply": "proposed", "dismiss": "proposed"}.get(action)
        if want is None:
            raise MateError("action: undo, apply or dismiss")
        if rec["status"] != want:
            raise MateError(f"this change is {rec['status']}: it can't be {action}ed", status=409)
        skipped: list[str] = []
        if action == "dismiss":
            rec = self.store.set_style_change(mate_id, cid, "dismissed")
            return {"change": rec, "mate": mate, "skipped": skipped}
        now = STY.values(mate)
        flat: dict[str, Any] = {}
        for path, c in rec["changes"].items():
            if path not in STY.PATHS:
                continue
            if action == "undo":
                if now.get(path) != c.get("to"):
                    skipped.append(path)  # (changed again since: the newer value stays)
                    continue
                flat[path] = c.get("from")
            else:
                flat[path] = c.get("to")
        if flat:
            mate = self.update(mate_id, STY.patch_of(flat))
        rec = self.store.set_style_change(mate_id, cid, "undone" if action == "undo" else "applied")
        self._log("info", f"the user {'undid' if action == 'undo' else 'applied'} “{mate['name']}”'s conversation "
                  f"style change {cid}: {STY.describe(rec['changes'])}" + (f" (kept: {', '.join(skipped)})" if skipped
                                                                          else ""),
                  code=f"mate.style_{'undone' if action == 'undo' else 'applied'}", detail=rec)
        return {"change": rec, "mate": mate, "skipped": skipped}

    def memory_style_flags(self, mate_id: str) -> dict[str, dict[str, Any]]:
        """The Memory tab's hint: active memories that look like rules about how she talks (read-only)."""
        mate = self.store.get(mate_id)
        return STY.memory_flags(self.store.memories(mate_id), mate, self.store.style_ok_memories(mate_id))

    def memory_to_style(self, mate_id: str, mem_id: str) -> dict[str, Any]:
        """The user moves a memory into the conversation style: its text joins the speech habits (the user can
        then shape it in the Conversation style tab) and the memory is archived — restorable, never deleted."""
        mate = self.store.get(mate_id)
        mem = self.store.memory(mate_id, mem_id)
        if mem is None:
            raise KeyError(f"no memory {mem_id}")
        habits = (mate["prefs"].get("speech_style") or "").rstrip()
        line = "- " + " ".join(str(mem["text"]).split())
        if line not in habits.splitlines():
            mate = self.update(mate_id, {"prefs": {"speech_style": (habits + "\n" if habits else "") + line}})
        self.store.update_memory(mate_id, mem_id, {"status": "archived"}, by_user=True)
        return {"mate": self.store.get(mate_id), "memory": self.store.memory(mate_id, mem_id)}

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
        if self.capture.shared_client(sid,self._svc.last_client_device(sid)) is None:
            raise CaptureError("not_shared")
        if not self._svc.is_mate_session(sid):
            raise MateError("see_screen works only in your own conversation")
        reason = str(args.get("reason") or "").strip()
        device = self._svc.last_client_device(sid)
        res = await self.capture.request(mate=mate, session_id=sid, device=device, reason=reason, shared_only=True, multi=True)
        # (all screens: one picture per screen, the one in use first — capture.pictures)
        pics = res.get("attachments") or [{"id": res.get("attachment_id"), "role": "main", "source": res.get("source") or {}}]
        rows = [self._capture_row(sid, p["id"]) for p in pics]
        rows = [self._svc._attachments.mark_screen(r["id"]) for r in rows]
        # (the conversation's own copies: never pending composer uploads, gone with the conversation)
        self._svc._attachments.link([r["id"] for r in rows], f"artifact:capture:{res['id']}")
        images = []
        for row in rows:
            use_model = bool(row.get("model_path")) and os.path.exists(row["model_path"])
            path = row["model_path"] if use_model else row["path"]
            data = await asyncio.to_thread(Path(path).read_bytes)
            images.append({"data": base64.b64encode(data).decode(), "mime": (row.get("model_mime") if use_model else None) or row["mime"]})
        elsewhere = bool(device) and res["client"].device != device
        where = (" (on the computer where the desktop app was used last — the user's last message came from "
                 "another device)") if elsewhere else ""

        def about(row: dict[str, Any], src: Any) -> tuple[str, str]:
            src = src if isinstance(src, dict) else {}
            name = " ".join(str(src.get("name") or "").split())[:120]
            size = f", {row['width']}×{row['height']}" if row.get("width") else ""
            return ("window" if src.get("kind") == "window" else "screen"), (f" “{name}”" if name else "") + size

        after = ("Talk only about what matters for what they asked; don't remember what you saw unless they ask you to.")
        if len(rows) == 1:
            what, label = about(rows[0], pics[0].get("source"))
            text = (f"Screen captured: the {what}{label}{where} — [{rows[0]['id']}] {rows[0]['name']}. The picture is "
                    f"attached below for visual context and hidden from the chat transcript. {after}")
        else:
            lines = [f"{k}. {label}{about(row, p.get('source'))[1]} — [{row['id']}] {row['name']}"
                     for k, (row, p, label) in enumerate(zip(rows, pics, screen_labels(len(rows))), 1)]
            text = "\n".join([f"Screens captured{where}: all {len(rows)} of the user's screens, one picture each, attached "
                              "below in this order:", *lines,
                              f"The pictures are for visual context and hidden from the chat transcript. {after}"])
        return ToolImages(text, images)

    def _capture_row(self, sid: str, aid: Any) -> dict[str, Any]:
        att = self._svc._attachments
        row = att.get(str(aid or "")) if att is not None else None
        if row is None or row["session_id"] != sid or row["kind"] != "image" or not os.path.exists(row["path"]):
            raise CaptureError("error", "The desktop app's capture did not arrive as an image.")
        return row

    def capture_result(self, mate_id: str, rid: str, body: dict[str, Any]) -> bool:
        """The desktop app's answer to a capture request (``POST /api/mates/{id}/capture/{rid}``):
        ``{ok: true, attachment_id, source?: {name, kind}}`` (all screens: ``attachments: [{id, role, source}]``,
        main first) or ``{ok: false, code, message?}``.
        False: no such request waiting (answered, timed out, another mate's)."""
        sid = self.capture.pending_session(rid)
        if sid is None:
            return False
        if body.get("ok") is True:
            pics = pictures(body)
            if not pics:
                raise CaptureError("error", "The desktop app's capture did not arrive as an image.")
            for pic in pics:
                row = self._capture_row(sid, pic["id"])  # (an upload of that conversation)
                if row["message_id"] is not None:
                    raise CaptureError("error", "That attachment was sent already.")
            payload = {"ok": True, "attachment_id": pics[0]["id"], "attachments": pics, "source": pics[0]["source"]}
        else:
            payload = {"ok": False, "code": str(body.get("code") or "error")[:40],
                       "message": str(body.get("message") or "")[:400]}
        return self.capture.resolve(rid, mate_id, payload)

    # ---- delegation results ----

    def _on_turn_end(self, sid: str, outcome: dict[str, Any]) -> None:
        if self._svc.is_mate_session(sid):
            self.capture.cancel_session(sid)  # (a capture still waiting: the turn that wanted it is over)
        d = self._delegations.pop(sid, None)
        bg = self._svc.running_task_count(sid) if outcome.get("status") == "ok" else 0
        try:
            outcome = {**outcome, "title": self._svc.get(sid)["title"]}
        except KeyError:
            pass
        results = self.tasks.complete(sid, outcome, bg)
        for mate_sid, entry in results:
            if bg and d:
                self._delegations[sid] = {**d, "auto_only": True, "at": time.time()}
            self._pending.setdefault(mate_sid, []).append(entry)
            asyncio.get_running_loop().call_soon(self._flush, mate_sid)
        if self._svc.is_mate_session(sid):
            if outcome.get("trigger") == "turn" and "meta" in outcome:
                try:
                    mate_id = (self._svc.get(sid).get("mate_id") or "")
                    if mate_id:
                        self._relation_turn(mate_id, outcome)
                        self._state_turn(mate_id, sid, outcome)
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
        if e.get("request_id"):
            attrs += f' request_id="{_attr(e["request_id"])}" verification="{_attr(e.get("verification") or "unverified")}"'
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
                self.tasks.mark_delivered([e["request_id"] for e in items if e.get("request_id")])
                return
            self._svc.start_turn(mate_sid, "\n\n".join(self._result_block(e) for e in items),
                                 meta={"internal": True, "kind": "delegation_result", "delegations": delegs,
                                       "delegation_requests": [e["request_id"] for e in items if e.get("request_id")],
                                       "delegation_receipts": [e["request_id"]+":"+str(e.get("receipt_revision", 1)) for e in items if e.get("request_id")]})
            self.tasks.mark_delivered([e["request_id"] for e in items if e.get("request_id")])
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
