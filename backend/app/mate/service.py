"""Mate conversations, the mate engine, its tools and delegation results.

* A mate's conversation is a ``sessions`` row (``kind='mate'``) streamed with
  the normal history/ws endpoints. Its Claude engine is configured here
  (:meth:`MateService.configure_engine`): our own system prompt, no built-in
  tools, only the ``mate`` MCP bridge, model/effort from ``mate.llm``.
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
import collections
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path
from typing import Any

from app.config import settings
from app.mate import files
from app.mate.prompt import prompt_key, settings_change_note, system_prompt
from app.mate.store import MateError, MateStore
from app.providers import get_provider
from app.providers.catalog import DEFAULT_MATE_MODEL
from app.providers.base import TurnRequest
from app.services._ids import now_iso
from app.services.session_service import SessionService, TurnBusyError

BRIDGE = str(Path(__file__).with_name("mcp_bridge.py"))
MAX_CHAIN = 3            # automatic result turns in a row (without the user speaking)
MAX_RESULT_CHARS = 4000  # of a worker's answer, passed to the mate
_SKIP_DIRS = {"node_modules", "__pycache__", "venv", ".venv", "dist", "build", "target", "site-packages", "proc",
              "sys", "snap"}


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
        sessions.mate_engine = self.configure_engine
        sessions.add_turn_end_listener(self._on_turn_end)
        self.sync_builtins()

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
        it). A new bundle version updates persona + body of the mates the
        user hasn't edited; their voice/model choices are never overwritten."""
        removed = self.store.builtin_removed()
        for key in files.builtin_keys():
            try:
                version = files.builtin_hash(key)
                cur = self.store.by_builtin(key)
                if cur is not None and (cur["customized"] or cur["builtin_hash"] == version):
                    continue
                if cur is None and key in removed:
                    continue
                doc = files.builtin_doc(key)
                name, persona = files.builtin_persona(doc)
                avatar = files.builtin_avatar(key, doc) or {"kind": "none"}
                if cur is None:
                    mate = self.store.create(name=name, persona=persona, avatar=avatar)
                    self.store.mark_builtin(mate["id"], key, version)
                    voice = files.ailism_voice(doc, files.builtin_voice_dir(key), mate["id"])
                    if voice:
                        self.store.update(mate["id"], {"voice": voice, "_sync": True})
                else:
                    self.store.update(cur["id"], {"persona": persona, "avatar": avatar, "_sync": True})
                    self.store.mark_builtin(cur["id"], key, version)
            except Exception as exc:  # noqa: BLE001 - one broken bundle must not stop the app
                self._log("warning", f"built-in mate {key}: {exc}")

    def restore_builtins(self) -> list[dict[str, Any]]:
        self.store.restore_builtins()
        self.sync_builtins()
        return self.store.list()

    def get(self, mate_id: str) -> dict[str, Any]:
        return self.store.get(mate_id)

    def create(self, body: dict[str, Any]) -> dict[str, Any]:
        return self.store.create(name=body.get("name") or "", persona=body.get("persona"),
                                 avatar=body.get("avatar"), llm=body.get("llm"), voice=body.get("voice"),
                                 is_default=bool(body.get("is_default")))

    def update(self, mate_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        before = self.store.get(mate_id)
        mate, changed = self.store.update(mate_id, patch)
        sid = self._live_session(mate)
        if sid and changed & {"llm", "name"}:
            # (the engine itself picks persona/llm changes up at the next turn:
            # see configure_engine; the row keeps the UI's view in sync)
            self._svc.update(sid, model=mate["llm"]["model"] or DEFAULT_MATE_MODEL,
                             effort=mate["llm"]["effort"], title=mate["name"])
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

    def conversation(self, mate_id: str) -> dict[str, Any]:
        mate = self.store.get(mate_id)
        sid = self._live_session(mate)
        if sid is None:
            home = files.home_dir(mate_id)
            s = self._svc.create(
                provider="claude", model=mate["llm"]["model"], effort=mate["llm"]["effort"],
                workspace_path=str(home), title=mate["name"], kind="mate", mate_id=mate_id,
            )
            sid = s["id"]
            greeting = mate["persona"].get("greeting")
            if greeting:
                self._svc.seed_message(sid, "assistant", greeting, provider="claude",
                                       meta={"internal": True, "kind": "greeting"})
            self.store.set_session(mate_id, sid)
            mate = self.store.get(mate_id)
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
        the engine a mate. Persona/memory edits change the prompt key and
        effort is a launch setting, so either restarts the engine at the next
        turn (``--resume``: same conversation); the model switches live."""
        mate_id = session.get("mate_id") or ""
        try:
            mate = self.store.get(mate_id)
        except KeyError:
            mate = {"id": mate_id, "name": session.get("title") or "Mate", "persona": {}, "memory_rev": 0,
                    "llm": {"model": session.get("model") or "", "effort": session.get("effort") or "low"}}
        memories = self.store.memories(mate_id) if mate_id else []
        prompt = system_prompt(mate["name"], mate["persona"], memories)
        note = self._settings_note(mate_id, mate)
        if note:  # persona edited since the conversation last ran: say so in this message
            req.preamble = f"{note}\n\n{req.preamble}" if req.preamble else note
        # (a file: persona + 200 memories can outgrow one argv string)
        req.system_prompt_file = files.engine_file(mate_id, "prompt", "md", prompt)
        req.prompt_key = prompt_key(mate["name"], mate["persona"], int(mate.get("memory_rev") or 0))
        req.tools = []                     # no Bash/Read/Edit/WebFetch… — it can't do the work itself
        req.allowed_tools = ["mcp__mate"]  # all mate bridge tools
        req.sealed = True
        req.mode = "agent"
        req.extra_dirs = []
        req.model = mate["llm"].get("model") or DEFAULT_MATE_MODEL
        req.effort = mate["llm"].get("effort") or "default"
        req.mcp_config = {"mcpServers": {"mate": {
            "type": "stdio",
            "command": sys.executable,
            "args": ["-I", BRIDGE],
            "env": {
                "HRH_MATE_API": f"http://127.0.0.1:{settings.port}",
                "HRH_MATE_TOKEN": self._token(mate_id, session["id"]),
                "HRH_MATE_ID": mate_id,
                "HRH_MATE_SESSION": session["id"],
            },
        }}}
        # (a 0600 file, so the token isn't in the process list)
        req.mcp_config_file = files.engine_file(mate_id, "mcp", "json", json.dumps(req.mcp_config, indent=1))
        if session.get("model") != req.model or (session.get("effort") or "default") != req.effort:
            self._svc.update(session["id"], model=req.model, effort=req.effort)

    def _settings_note(self, mate_id: str, mate: dict[str, Any]) -> str:
        """Compare the persona with the one the conversation last ran with
        (kept next to the mate's engine files) and remember the new one."""
        if not mate_id:
            return ""
        path = files.home_dir(mate_id) / ".applied-persona.json"
        now = {"name": mate.get("name") or "", "persona": mate.get("persona") or {}}
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
        return settings_change_note(str(before.get("name") or ""), before.get("persona") or {},
                                    now["name"], now["persona"])

    # ---- tools (called by the bridge through the internal API) ----

    async def call_tool(self, ctx: dict[str, str], name: str, args: dict[str, Any]) -> tuple[str, bool]:
        """-> (text for the model, is_error)."""
        fn = getattr(self, f"_tool_{name}", None)
        if fn is None:
            return f"unknown tool: {name}", True
        try:
            mate = self.store.get(ctx["mate_id"])
        except KeyError:
            return "this mate no longer exists", True
        try:
            out = await fn(mate, ctx["session_id"], args if isinstance(args, dict) else {})
        except MateError as exc:
            return str(exc), True
        except Exception as exc:  # noqa: BLE001 - surfaced to the model, logged for the admin
            self._log("error", f"mate tool {name} failed: {exc}", code="mate.tool_failed",
                      detail={"args": args}, session_id=ctx.get("session_id"))
            return f"{name} failed: {exc}", True
        return (out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, indent=1)), False

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
        mem = self.store.add_memory(mate["id"], str(args.get("text") or ""))
        return f"Remembered [{mem['id']}]: {mem['text']}"

    async def _tool_forget(self, mate: dict[str, Any], _sid: str, args: dict[str, Any]) -> str:
        mid = str(args.get("id") or "").strip().strip("[]")
        if not self.store.delete_memory(mate["id"], mid):
            raise MateError(f"no memory with id {mid!r}")
        return f"Forgot [{mid}]."

    # ---- delegation results ----

    def _on_turn_end(self, sid: str, outcome: dict[str, Any]) -> None:
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
