"""Avatar Create: the agent's conversation, its tools, the spending gate and the server-side runner
(docs/avatar-create.md).

* A project's conversation is a ``sessions`` row of kind ``avatar`` — streamed with the normal history / ws
  endpoints, hidden from the chat list. Its engine (Claude Code by default, or Codex) is sealed exactly like a
  mate's: our own system prompt, no built-in tools, only the ``avatar`` MCP bridge (app/avatar/mcp_bridge.py →
  ``POST /api/internal/avatar/call`` with a per-conversation token).
* The agent interviews the user (question cards), records the brief, and asks for an estimate: every job of the plan
  priced by Higgsfield itself (free quotes). Nothing that spends credits runs before the USER confirms that plan
  (``confirm``, a cookie-authenticated route the agent can't reach); the runner checks the gate again before every
  single job, and never goes past the cap (confirmed total + reserve + extras the user confirmed).
* The runner (one asyncio task per running project) goes phase by phase — candidates → pick → base picture →
  approve → stills → approve → clips → mattes → encode → check → export — with every job's id written to the project
  document before it is waited for, so a restart waits for the same job instead of submitting it again. Pause / cancel
  stop new jobs; running ones finish.
* The agent hears about the run through internal ``<avatar_event>`` messages (a turn started for it when idle,
  queued while it talks).
"""

from __future__ import annotations

import asyncio
import base64
import json
import secrets
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from app.avatar import plan as PL
from app.avatar import presets as P
from app.avatar.deps import Deps
from app.avatar.generator import Generator, JobError, job_id, result_url
from app.avatar.prompt import system_prompt
from app.avatar.store import AvatarError, AvatarStore, project_dir, safe_rel
from app.config import settings
from app.higgsfield.oauth import HiggsfieldError
from app.mate import files as mate_files
from app.providers.base import TurnRequest
from app.providers.catalog import default_mate_model
from app.services._ids import now_iso
from app.services.session_service import SessionService, TurnBusyError

BRIDGE = str(Path(__file__).with_name("mcp_bridge.py"))
PHASES = ("design", "pick", "home", "approve_home", "stills", "approve_stills", "clips", "matte", "encode", "check",
          "export")
CHECKPOINTS = {"pick": "pick", "approve_home": "home", "approve_stills": "stills"}
PARALLEL = {"design": 4, "home": 1, "stills": 3, "clips": 2, "matte": 1}
MAX_TRIES = 3
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")
SERVE_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
             ".mp4": "video/mp4", ".json": "application/json"}
SERVE_DIRS = ("ref", "design", "thumbs", "stills", "clips", "web", "export", "masters", "sheets")
EVENT_DELAY_S = 1.5


class Paused(Exception):
    pass


def _clip(text: str, n: int = 300) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


class AvatarService:
    def __init__(self, sessions: SessionService, mates: Any, higgsfield: Any, logs: Any = None,
                 deps: Deps | None = None, generator: Generator | None = None) -> None:
        self._svc = sessions
        self.mates = mates
        self.store = AvatarStore(sessions._db)
        self.gen = generator or Generator(higgsfield)
        self.deps = deps or Deps()
        self._logs = logs
        self._tokens: dict[str, dict[str, str]] = {}
        self._token_by_sid: dict[str, str] = {}
        self._runners: dict[str, asyncio.Task] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._events: dict[str, list[str]] = {}
        self._event_timers: dict[str, asyncio.TimerHandle] = {}
        self.on_change: list[Any] = []
        sessions.engine_hooks["avatar"] = self.configure_engine
        sessions.add_turn_end_listener(self._on_turn_end)

    def _log(self, level: str, message: str, **kw: Any) -> None:
        if self._logs is not None:
            self._logs.record(level, "avatar", message, **kw)

    # ---------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        """After a restart: projects that were running go on (jobs already submitted are waited for)."""
        for pid in self.store.ids():
            try:
                doc = self.store.get(pid)
            except AvatarError:
                continue
            if doc.get("status") == "running":
                self._kick(pid)

    async def stop(self) -> None:
        for t in list(self._runners.values()):
            t.cancel()
        await asyncio.gather(*self._runners.values(), return_exceptions=True)

    # ---------------------------------------------------------------- documents

    def _lock(self, pid: str) -> asyncio.Lock:
        return self._locks.setdefault(pid, asyncio.Lock())

    def doc(self, pid: str) -> dict[str, Any]:
        return self.store.get(pid)

    def save(self, doc: dict[str, Any]) -> dict[str, Any]:
        self.store.save(doc)
        self._svc.broadcast_list({"type": "avatar.changed", "data": {"project_id": doc["id"],
                                                                     "version": doc["version"]}})
        for cb in list(self.on_change):
            try:
                cb(doc)
            except Exception:  # noqa: BLE001
                pass
        return doc

    def dir(self, pid: str) -> Path:
        return project_dir(pid)

    def _history(self, doc: dict[str, Any], what: str, **kw: Any) -> None:
        log = doc.setdefault("log", [])
        log.append({"at": now_iso(), "what": what, **kw})
        del log[:-200]
        try:
            with (self.dir(doc["id"]) / "log.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"at": now_iso(), "what": what, **kw}, ensure_ascii=False) + "\n")
        except OSError:
            pass

    # ---------------------------------------------------------------- projects

    def list(self) -> list[dict[str, Any]]:
        out = []
        for pid in self.store.ids():
            try:
                d = self.store.get(pid)
            except AvatarError:
                continue
            out.append({"id": pid, "title": d.get("title"), "status": d.get("status"), "phase": d.get("phase"),
                        "mate_id": (d.get("brief") or {}).get("target", {}).get("mate_id"),
                        "updated_at": d.get("updated_at"), "created_at": d.get("created_at"),
                        "thumb": self._url(d, "thumbs/home.jpg") if (self.dir(pid) / "thumbs/home.jpg").is_file()
                        else None})
        return out

    def create(self, *, mate_id: str | None = None, language: str = "en", provider: str = "claude") -> dict[str, Any]:
        brief = P.default_brief()
        title = "New avatar"
        if mate_id:
            mate = self.mates.get(mate_id)  # KeyError → 404
            brief["target"] = {"mode": "existing", "mate_id": mate_id, "name": mate["name"]}
            title = mate["name"]
        provider = provider if provider in ("claude", "codex") else "claude"
        doc = self.store.create({
            "title": title, "status": "interview", "phase": None, "language": language if language in ("ko", "en")
            else "en", "engine": {"provider": provider, "model": default_mate_model(provider), "effort": "medium"},
            "brief": brief, "question": None, "plan": None, "confirmation": None, "extras": [], "items": {},
            "done": {}, "ledger": {"committed": 0.0, "jobs": 0}, "paused": False, "picked": None, "check": None,
            "result": None, "applied": None, "error": None, "log": [],
        })
        pid = doc["id"]
        s = self._svc.create(provider=provider, model=doc["engine"]["model"], effort=doc["engine"]["effort"],
                             workspace_path=str(self.dir(pid)), title=f"Avatar · {title}", kind="avatar")
        doc["session_id"] = s["id"]
        self.save(doc)
        self._event(pid, "start", "The user opened Avatar Create"
                    + (f" for the mate “{title}”" if mate_id else " (the avatar may go to a new mate or an existing one)")
                    + ". Greet them in one sentence and start the interview with the first question card.")
        return self.view(pid)

    def delete(self, pid: str) -> None:
        doc = self.doc(pid)
        if doc.get("status") == "running":
            raise AvatarError("pause or cancel the run first", 409, "busy")
        sid = doc.get("session_id")
        if sid:
            try:
                self._svc.delete(sid)
            except KeyError:
                pass
            tok = self._token_by_sid.pop(sid, None)
            if tok:
                self._tokens.pop(tok, None)
        self.store.delete(pid)

    def _url(self, doc: dict[str, Any], rel: str) -> str:
        try:
            v = int((self.dir(doc["id"]) / rel).stat().st_mtime)
        except OSError:
            v = 0
        return f"/api/avatar/projects/{doc['id']}/files/{rel}?v={v}"

    def file_path(self, pid: str, rel: str) -> Path:
        rel = safe_rel(rel)
        if rel.split("/")[0] not in SERVE_DIRS:
            raise AvatarError("not found", 404, "not_found")
        p = (self.dir(pid) / rel).resolve()
        if self.dir(pid).resolve() not in p.parents or not p.is_file() or p.suffix.lower() not in SERVE_EXT:
            raise AvatarError("not found", 404, "not_found")
        return p

    def view(self, pid: str) -> dict[str, Any]:
        """The project as the panel shows it: the document + file URLs + the preview avatar."""
        doc = self.doc(pid)
        d = self.dir(pid)
        out = {k: v for k, v in doc.items() if k not in ("log",)}
        out["log"] = (doc.get("log") or [])[-30:]
        refs = [{"name": f, "url": self._url(doc, f"ref/{f}")} for f in (doc["brief"]["reference"].get("files") or [])
                if (d / "ref" / f).is_file()]
        cands = []
        for key, it in sorted(doc["items"].items(), key=lambda kv: (len(kv[0]), kv[0])):
            if it["stage"] == "design" and it.get("status") == "done":
                cid = key.split(":", 1)[1]
                cands.append({"id": cid, "url": self._url(doc, f"thumbs/{cid}.jpg") if (d / f"thumbs/{cid}.jpg").is_file()
                              else self._url(doc, it["out"]), "full": self._url(doc, it["out"])})
        stills = []
        for s in doc["brief"]["stills"]:
            it = doc["items"].get(f"still:{s['name']}")
            t = d / "thumbs" / f"still-{s['name']}.jpg"
            stills.append({"name": s["name"], "status": (it or {}).get("status") or "pending",
                           "url": self._url(doc, f"thumbs/still-{s['name']}.jpg") if t.is_file() else None,
                           "error": (it or {}).get("error")})
        clips = []
        for c in doc["brief"]["clips"]:
            it = doc["items"].get(f"clip:{c['id']}") or {}
            mt = doc["items"].get(f"matte:{c['id']}") or {}
            web = d / "web" / f"{c['id']}.sm.mp4"
            clips.append({"id": c["id"], "kind": c["kind"], "emotion": c.get("emotion"),
                          "action": P.fill(c["action"], doc["brief"].get("pronoun")),
                          "status": it.get("status") or "pending", "matte": mt.get("status"),
                          "processed": bool(mt.get("processed")), "error": it.get("error") or mt.get("error"),
                          "raw": self._url(doc, f"clips/{c['id']}.mp4") if (d / "clips" / f"{c['id']}.mp4").is_file()
                          else None, "web": self._url(doc, f"web/{c['id']}.sm.mp4") if web.is_file() else None,
                          "check": ((doc.get("check") or {}).get("clips") or {}).get(c["id"])})
        files = {"refs": refs, "candidates": cands, "stills": stills, "clips": clips,
                 "home": self._url(doc, "thumbs/home.jpg") if (d / "thumbs/home.jpg").is_file() else None,
                 "face": self._url(doc, "thumbs/face.jpg") if (d / "thumbs/face.jpg").is_file() else None}
        out["files"] = files
        out["preview"] = self.preview(doc)
        out["credits"] = {"committed": PL.committed(doc), "cap": PL.cap(doc),
                          "confirmed": (doc.get("confirmation") or {}).get("total"),
                          "reserve": (doc.get("plan") or {}).get("reserve")}
        out["agent_running"] = bool(doc.get("session_id") and self._svc.is_running(doc["session_id"]))
        return out

    def preview(self, doc: dict[str, Any]) -> dict[str, Any] | None:
        exp = self.dir(doc["id"]) / "export"
        if not (exp / "rig.json").is_file():
            return None
        try:
            raw = json.loads((exp / "rig.json").read_text())
            return mate_files.rig_avatar(raw, exp, lambda rel: self._url(doc, f"export/{rel}"))
        except Exception:  # noqa: BLE001
            return None

    async def env(self) -> dict[str, Any]:
        """What the run needs on this server: a Higgsfield account, its CLI, the processing tools."""
        aid = self.gen.account_id()
        acc = None
        if aid:
            try:
                acc = await self.gen.balance()
            except HiggsfieldError:
                acc = None
        return {"higgsfield": {"connected": bool(aid), "cli": bool(self.gen.cli()), "account": acc},
                "deps": self.deps.status(), "root": str(settings.avatar_root_path)}

    # ---------------------------------------------------------------- the engine

    def _token(self, pid: str, sid: str) -> str:
        tok = self._token_by_sid.get(sid)
        if tok is None:
            tok = secrets.token_urlsafe(32)
            self._token_by_sid[sid] = tok
            self._tokens[tok] = {"project_id": pid, "session_id": sid}
        return tok

    def token_info(self, token: str | None) -> dict[str, str] | None:
        if not token:
            return None
        for known, info in self._tokens.items():
            if secrets.compare_digest(known, token):
                return info
        return None

    def _engine_file(self, pid: str, kind: str, ext: str, content: str) -> str:
        import hashlib

        d = self.dir(pid) / ".engine"
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{kind}-{hashlib.sha256(content.encode()).hexdigest()[:16]}.{ext}"
        if not p.is_file():
            import os

            tmp = p.with_name(p.name + ".part")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.replace(tmp, p)
        return str(p)

    def configure_engine(self, session: dict[str, Any], req: TurnRequest) -> None:
        """SessionService hook for a kind="avatar" turn: a sealed engine with only the avatar tools."""
        pid = self.store.by_session(session["id"]) or ""
        try:
            doc = self.doc(pid)
        except AvatarError:
            doc = {"id": pid, "language": "en", "brief": P.default_brief(), "engine": {}}
        t = doc["brief"]["target"]
        state = f"Project {pid}. " + (f"Target: the existing mate “{t.get('name')}”." if t["mode"] == "existing"
                                     else "Target: a new mate" + (f" named “{t['name']}”." if t.get("name") else "."))
        prompt = system_prompt(language=doc.get("language") or "en", state=state, emotions=list(P.EMOTIONS))
        engine = session.get("provider") or "claude"
        req.system_prompt_file = self._engine_file(pid, "prompt", "md", prompt)
        req.prompt_key = ""
        req.system_prompt = None
        req.tools = []
        req.allowed_tools = ["mcp__avatar"]
        req.sealed = True
        req.mode = "agent"
        req.extra_dirs = []
        if engine == "codex":
            req.engine_home = str(self.dir(pid) / ".engine" / "codex")
        req.model = session.get("model") or default_mate_model(engine)
        req.mcp_config = {"mcpServers": {"avatar": {
            "type": "stdio", "command": sys.executable, "args": ["-I", BRIDGE],
            "env": {"HRH_AVATAR_API": f"http://127.0.0.1:{settings.port}",
                    "HRH_AVATAR_TOKEN": self._token(pid, session["id"]), "HRH_AVATAR_PROJECT": pid},
        }}}
        if engine != "codex":
            req.mcp_config_file = self._engine_file(pid, "mcp", "json", json.dumps(req.mcp_config, indent=1))

    # ---------------------------------------------------------------- telling the agent

    def _event(self, pid: str, kind: str, text: str) -> None:
        """An <avatar_event> for the agent: collected for a moment, then one internal turn (queued while it talks)."""
        self._events.setdefault(pid, []).append(f'<avatar_event kind="{kind}">\n{text}\n</avatar_event>')
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if pid not in self._event_timers:
            self._event_timers[pid] = loop.call_later(EVENT_DELAY_S, self._flush, pid)

    def _flush(self, pid: str) -> None:
        self._event_timers.pop(pid, None)
        items = self._events.get(pid)
        if not items:
            return
        try:
            sid = self.doc(pid).get("session_id")
        except AvatarError:
            self._events.pop(pid, None)
            return
        if not sid or self._svc.is_running(sid):
            return  # (delivered when its turn ends)
        self._events.pop(pid, None)
        try:
            self._svc.start_turn(sid, "\n\n".join(items), meta={"internal": True, "kind": "avatar_event"})
        except TurnBusyError:
            self._events.setdefault(pid, [])[:0] = items
        except KeyError:
            pass

    def _on_turn_end(self, sid: str, outcome: dict[str, Any]) -> None:
        pid = self.store.by_session(sid) if sid in getattr(self._svc, "_avatar_sids", set()) else None
        if pid and self._events.get(pid):
            asyncio.get_running_loop().call_later(0.3, self._flush, pid)

    # ---------------------------------------------------------------- tools (the bridge)

    async def call_tool(self, ctx: dict[str, str], name: str, args: dict[str, Any]) -> tuple[str, bool, list]:
        fn = getattr(self, f"_tool_{name}", None)
        if fn is None:
            return f"unknown tool: {name}", True, []
        pid = ctx["project_id"]
        try:
            self.doc(pid)
        except AvatarError:
            return "this avatar project no longer exists", True, []
        try:
            async with self._lock(pid):
                out = await fn(pid, args if isinstance(args, dict) else {})
        except (AvatarError, P.BriefError, PL.GateError, HiggsfieldError) as exc:
            code = getattr(exc, "code", None)
            return (f"[{code}] " if code and isinstance(exc, PL.GateError) else "") + str(exc), True, []
        except Exception as exc:  # noqa: BLE001 - surfaced to the model, logged for the admin
            self._log("error", f"avatar tool {name} failed: {exc}", code="avatar.tool_failed", detail={"args": args})
            return f"{name} failed: {exc}", True, []
        if isinstance(out, tuple):
            return out[0], False, out[1]
        return (out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, indent=1)), False, []

    def _summary(self, doc: dict[str, Any]) -> dict[str, Any]:
        b = doc["brief"]
        items = doc["items"]
        counts: dict[str, dict[str, int]] = {}
        for it in items.values():
            c = counts.setdefault(it["stage"], {})
            c[it.get("status") or "pending"] = c.get(it.get("status") or "pending", 0) + 1
        plan = doc.get("plan")
        return {
            "status": doc["status"], "phase": doc.get("phase"), "paused": doc.get("paused"),
            "checkpoint": doc.get("checkpoint"), "error": doc.get("error"),
            "brief": {**b, "clips": [{k: c[k] for k in ("id", "kind", "emotion", "action") if k in c} for c in b["clips"]]},
            "missing": P.problems(b),
            "plan": None if not plan else {k: plan[k] for k in ("id", "total", "reserve", "cap", "minutes", "complete",
                                                                  "errors", "balance", "usd", "counts")}
            | {"lines": [{k: ln.get(k) for k in ("stage", "job_type", "count", "unit", "credits", "error")}
                         for ln in plan["lines"]]},
            "confirmed": doc.get("confirmation"),
            "credits": {"committed": PL.committed(doc), "cap": PL.cap(doc)},
            "extras": [{k: x[k] for k in ("id", "reason", "total", "status")} for x in doc.get("extras") or []],
            "items": counts,
            "failed": [{"item": k, "error": it.get("error")} for k, it in items.items() if it.get("status") == "failed"],
            "picked": doc.get("picked"), "check": doc.get("check"),
            "ready": bool(doc.get("result")), "applied": doc.get("applied"),
        }

    async def _tool_get_project(self, pid: str, args: dict[str, Any]) -> Any:
        return self._summary(self.doc(pid))

    async def _tool_ask_user(self, pid: str, args: dict[str, Any]) -> str:
        kind = args.get("kind") or "choice"
        if kind not in ("choice", "multi", "slider", "upload", "text", "mate"):
            raise AvatarError("kind must be choice, multi, slider, upload, text or mate")
        q = str(args.get("question") or "").strip()
        if not q:
            raise AvatarError("question is required")
        opts = []
        for o in (args.get("options") or [])[:12]:
            if isinstance(o, str):
                o = {"value": o, "label": o}
            if isinstance(o, dict) and (o.get("value") or o.get("label")):
                opts.append({"value": str(o.get("value") or o.get("label"))[:80],
                             "label": str(o.get("label") or o.get("value"))[:120],
                             "description": str(o.get("description") or "")[:240] or None})
        if kind in ("choice", "multi") and not opts:
            raise AvatarError("choice / multi cards need options")
        card = {"id": "q_" + secrets.token_hex(4), "kind": kind, "question": q[:400], "options": opts,
                "allow_other": bool(args.get("allow_other", kind in ("choice", "multi"))), "at": now_iso()}
        if kind == "slider":
            card.update({k: args.get(k) for k in ("min", "max", "step", "default", "unit")
                         if isinstance(args.get(k), (int, float, str))})
        doc = self.doc(pid)
        doc["question"] = card
        self.save(doc)
        return ("The card is shown to the user. End your turn now; their answer comes as the next message.")

    async def _tool_update_brief(self, pid: str, args: dict[str, Any]) -> Any:
        doc = self.doc(pid)
        if doc.get("confirmation"):
            raise AvatarError("the plan is confirmed and running: the brief is locked (use extend to add clips or "
                              "stills, regenerate to redo one)")
        patch = args.get("patch") if isinstance(args.get("patch"), dict) else {k: v for k, v in args.items()}
        t = patch.get("target")
        if isinstance(t, dict) and t.get("mode") == "existing" and t.get("mate_id"):
            try:
                t["name"] = self.mates.get(str(t["mate_id"]))["name"]
            except KeyError:
                raise AvatarError(f"no mate with id {t['mate_id']!r}") from None
        doc["brief"] = P.merge_brief(doc["brief"], patch)
        tg = doc["brief"]["target"]
        doc["title"] = tg.get("name") or doc.get("title")
        if doc.get("plan") and doc["status"] == "estimate":
            doc["plan"] = None  # (the old estimate no longer matches)
            doc["status"] = "interview"
        doc["question"] = None
        self.save(doc)
        return {"brief": self._summary(doc)["brief"], "missing": P.problems(doc["brief"])}

    async def _tool_use_reference(self, pid: str, args: dict[str, Any]) -> str:
        aid = str(args.get("attachment_id") or "").strip().strip("[]")
        doc = self.doc(pid)
        atts = getattr(self._svc, "_attachments", None)
        row = atts.get(aid) if atts is not None and aid else None
        if row is None or row["session_id"] != doc.get("session_id") or row["kind"] != "image":
            raise AvatarError("no picture with that id in this conversation (the [att_…] ids of the user's images)")
        src = Path(row["path"])
        name = self._next_ref_name(pid, src.suffix.lower() if src.suffix.lower() in IMAGE_EXT else ".png")
        (self.dir(pid) / "ref").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, self.dir(pid) / "ref" / name)
        self._add_ref(doc, name)
        return f"{name} is now the reference (mode {doc['brief']['reference']['mode']})."

    def _next_ref_name(self, pid: str, ext: str) -> str:
        d = self.dir(pid) / "ref"
        n = 1
        while (d / f"ref-{n}{ext}").exists() or any(d.glob(f"ref-{n}.*")):
            n += 1
        return f"ref-{n}{ext}"

    def _add_ref(self, doc: dict[str, Any], name: str) -> None:
        ref = doc["brief"]["reference"]
        ref["files"] = [*(ref.get("files") or []), name][-4:]
        if ref.get("mode") == "none":
            ref["mode"] = "redraw"
        doc["question"] = None
        self.save(doc)

    async def _tool_estimate(self, pid: str, args: dict[str, Any]) -> Any:
        doc = self.doc(pid)
        if doc.get("confirmation"):
            raise AvatarError("the plan is already confirmed")
        missing = P.problems(doc["brief"])
        if missing:
            raise AvatarError("ask the user first: " + "; ".join(missing))
        plan = await self._estimate(doc)
        return {"plan": self._summary(self.doc(pid))["plan"],
                "note": "The estimate card is shown with Confirm / Change plan / Cancel. Summarize the total in one "
                        "or two sentences and end your turn; nothing runs until the user confirms."
                if plan["complete"] else "Some prices could not be quoted (see errors); tell the user."}

    async def _estimate(self, doc: dict[str, Any]) -> dict[str, Any]:
        if not self.gen.account_id():
            raise AvatarError("Higgsfield is not connected: the user connects an account in Settings → Providers → "
                              "Higgsfield first")
        brief = doc["brief"]
        jobs = PL.jobs_for(brief)
        quotes: dict[str, Any] = {}
        ph = await asyncio.to_thread(self._placeholders)
        for key, jt, params in PL.quote_requests(jobs):
            media = {}
            if jt == PL.CLIP_JOB:
                media = {"start-image": ph["image"], "end-image": ph["image"]}
            elif jt == PL.MATTE_JOB and ph.get("video"):
                media = {"video-references": ph["video"]}
            elif jt == PL.CUTOUT_JOB:
                media = {"image-references": ph["image"]}
            try:
                quotes[key] = await self.gen.quote(jt, params, workdir=self.dir(doc["id"]), placeholders=media)
            except (HiggsfieldError, JobError) as exc:
                quotes[key] = {"error": exc.text() if isinstance(exc, HiggsfieldError) else str(exc)}
        bal = None
        try:
            acc = await self.gen.balance()
            bal = acc.get("credits") if acc else None
        except HiggsfieldError:
            pass
        usd = await self.gen.credit_usd()
        plan = PL.price(brief, quotes, balance=bal, credit_usd=usd)
        doc["plan"] = plan
        doc["status"] = "estimate"
        doc["question"] = None
        self._history(doc, "estimate", plan=plan["id"], total=plan["total"], complete=plan["complete"])
        self.save(doc)
        return plan

    def _placeholders(self) -> dict[str, Path]:
        """Tiny inputs for the CLI's cost command when Higgsfield wants media in a quote (uploads are free)."""
        d = settings.avatar_root_path / ".placeholders"
        d.mkdir(parents=True, exist_ok=True)
        img = d / "gray.png"
        if not img.is_file():
            img.write_bytes(_gray_png(64, 64))
        out = {"image": img}
        vid = d / "gray.mp4"
        if vid.is_file():
            out["video"] = vid
        return out

    async def _tool_look(self, pid: str, args: dict[str, Any]) -> tuple[str, list]:
        target = str(args.get("target") or "").strip()
        d = self.dir(pid)
        doc = self.doc(pid)
        paths: list[tuple[str, Path]] = []
        if target in ("reference", "ref"):
            paths = [(f, d / "ref" / f) for f in doc["brief"]["reference"].get("files") or []]
        elif target == "candidates":
            paths = [(k.split(":")[1], d / it["out"]) for k, it in sorted(doc["items"].items())
                     if it["stage"] == "design" and it.get("status") == "done"]
        elif target in ("home", "base"):
            paths = [("base picture", d / "thumbs" / "home.jpg"), ("face region", d / "thumbs" / "face.jpg")]
        elif target == "stills":
            paths = [(s["name"], d / "thumbs" / f"still-{s['name']}.jpg") for s in doc["brief"]["stills"]]
        elif target.startswith("clip:"):
            cid = target.split(":", 1)[1]
            sheet = d / "sheets" / f"{cid}.jpg"
            if not (d / "clips" / f"{cid}.mp4").is_file():
                raise AvatarError(f"clip {cid} has not been made yet")
            if not sheet.is_file():
                await self.deps.run("sheet", [str(d), cid, str(sheet)], timeout=300)
            paths = [(f"clip {cid} (4 frames)", sheet)]
        else:
            raise AvatarError("target: reference, candidates, home, stills or clip:<id>")
        paths = [(n, p) for n, p in paths if p.is_file()]
        if not paths:
            raise AvatarError("nothing to look at yet")
        images = []
        names = []
        for name, p in paths[:12]:
            data = await asyncio.to_thread(_small_jpeg, p, self.deps)
            if data is None:
                continue
            images.append({"data": base64.b64encode(data).decode(), "mime": "image/jpeg"})
            names.append(name)
        return f"{len(images)} picture(s), in order: {', '.join(names)}", images

    async def _tool_regenerate(self, pid: str, args: dict[str, Any]) -> Any:
        key = str(args.get("item") or "").strip()
        note = _clip(args.get("note") or "", 300)
        return await self.redo(pid, key, note=note, by="agent")

    async def _tool_extend(self, pid: str, args: dict[str, Any]) -> Any:
        return await self.extend(pid, clips=args.get("clips") or [], stills=args.get("stills") or [], by="agent")

    async def _tool_pause(self, pid: str, args: dict[str, Any]) -> str:
        self.pause(pid)
        return "Paused: no new jobs start; jobs already running finish."

    async def _tool_resume(self, pid: str, args: dict[str, Any]) -> str:
        self.resume(pid)
        return "Resumed."

    async def _tool_cancel(self, pid: str, args: dict[str, Any]) -> str:
        self.cancel(pid)
        return "Canceled: no new jobs start; running ones finish."

    # ---------------------------------------------------------------- user actions (cookie routes only)

    async def upload_reference(self, pid: str, name: str, data: bytes) -> dict[str, Any]:
        ext = Path(name or "").suffix.lower()
        if ext not in IMAGE_EXT:
            raise AvatarError("a reference must be a PNG, JPEG or WebP picture")
        if len(data) > 30 * 1024 * 1024:
            raise AvatarError("the picture is larger than 30 MB", 413)
        async with self._lock(pid):
            doc = self.doc(pid)
            if doc.get("confirmation"):
                raise AvatarError("the plan is already confirmed", 409)
            fname = self._next_ref_name(pid, ext)
            (self.dir(pid) / "ref").mkdir(parents=True, exist_ok=True)
            (self.dir(pid) / "ref" / fname).write_bytes(data)
            self._add_ref(doc, fname)
        return self.view(pid)

    async def answer(self, pid: str) -> None:
        """The user answered the open question card (the answer itself goes to the agent as a chat message)."""
        async with self._lock(pid):
            doc = self.doc(pid)
            if doc.get("question"):
                doc["question"] = None
                self.save(doc)

    async def estimate(self, pid: str) -> dict[str, Any]:
        """The user's Re-estimate (fresh quotes for the same brief)."""
        async with self._lock(pid):
            doc = self.doc(pid)
            if doc.get("confirmation"):
                raise AvatarError("the plan is already confirmed", 409)
            missing = P.problems(doc["brief"])
            if missing:
                raise AvatarError("the brief is not complete yet: " + "; ".join(missing))
            await self._estimate(doc)
        return self.view(pid)

    async def confirm(self, pid: str, plan_id: Any, total: Any) -> dict[str, Any]:
        """The user pressed Confirm on the estimate card: the only way a run starts."""
        async with self._lock(pid):
            doc = self.doc(pid)
            if not self.deps.ready():
                raise PL.GateError("deps_missing", "install the processing tools first (the button on the card)")
            if not self.gen.account_id() or not self.gen.cli():
                raise PL.GateError("no_higgsfield", "Higgsfield (an account and its CLI) is not available")
            doc["confirmation"] = PL.confirm(doc, plan_id, total)
            doc["status"] = "running"
            doc["paused"] = False
            doc["error"] = None
            doc["started_at"] = now_iso()
            if doc["brief"]["reference"]["mode"] == "as_base":
                doc["done"]["design"] = True
                doc["done"]["pick"] = True
                doc["picked"] = "ref"
            if not doc["brief"]["stills"]:
                doc["done"]["stills"] = doc["done"]["approve_stills"] = True
            try:
                acc = await self.gen.balance()
                doc["balance_at_start"] = acc.get("credits") if acc else None
            except HiggsfieldError:
                doc["balance_at_start"] = None
            self._history(doc, "confirmed", plan=doc["plan"]["id"], total=doc["plan"]["total"],
                          cap=doc["confirmation"]["cap"])
            self.save(doc)
        self._event(pid, "confirmed", f"The user confirmed plan {doc['plan']['id']} ({doc['plan']['total']:g} "
                    f"credits, cap {doc['confirmation']['cap']:g}). Generation has started. Tell them in one sentence "
                    "what happens first and that they will be asked at each checkpoint.")
        self._kick(pid)
        return self.view(pid)

    async def decline(self, pid: str, *, cancel: bool = False) -> dict[str, Any]:
        """Change plan (back to the interview) or Cancel, from the estimate card."""
        async with self._lock(pid):
            doc = self.doc(pid)
            if doc.get("confirmation"):
                raise AvatarError("the plan is running: use pause or cancel", 409)
            doc["plan"] = None
            doc["status"] = "canceled" if cancel else "interview"
            self.save(doc)
        self._event(pid, "declined", "The user canceled the project." if cancel else
                    "The user wants to change the plan. Ask what to change (one card), update_brief, estimate again.")
        return self.view(pid)

    def pause(self, pid: str) -> None:
        doc = self.doc(pid)
        if doc["status"] not in ("running", "waiting"):
            raise AvatarError("nothing is running")
        doc["paused"] = True
        self._history(doc, "paused")
        self.save(doc)

    def resume(self, pid: str) -> None:
        doc = self.doc(pid)
        if not doc.get("confirmation"):
            raise PL.GateError("not_confirmed", "nothing to resume: the plan is not confirmed")
        if doc["status"] in ("canceled", "applied"):
            raise AvatarError("this project is closed")
        doc["paused"] = False
        doc["error"] = None
        if doc["status"] in ("paused", "failed"):
            doc["status"] = "running"
        self._history(doc, "resumed")
        self.save(doc)
        if doc["status"] == "running":
            self._kick(pid)

    def cancel(self, pid: str) -> None:
        doc = self.doc(pid)
        doc["canceled"] = True
        doc["paused"] = True
        if doc["status"] in ("interview", "estimate", "paused", "failed", "waiting", "ready"):
            doc["status"] = "canceled"
        self._history(doc, "canceled")
        self.save(doc)

    async def checkpoint(self, pid: str, action: str, *, candidate: str | None = None,
                         items: list[str] | None = None) -> dict[str, Any]:
        """The user's decision at a checkpoint: pick a candidate, approve, or go back."""
        async with self._lock(pid):
            doc = self.doc(pid)
            cp = doc.get("checkpoint") or {}
            if doc["status"] != "waiting" or not cp:
                raise AvatarError("nothing is waiting for a decision", 409)
            stage = cp.get("stage")
            if action == "pick":
                if stage != "pick":
                    raise AvatarError("not picking a candidate now", 409)
                it = doc["items"].get(f"design:{candidate}")
                if not it or it.get("status") != "done":
                    raise AvatarError("no such candidate")
                doc["picked"] = candidate
                doc["done"]["pick"] = True
                msg = f"The user picked candidate {candidate}. The base picture (cut-out) is being made."
            elif action == "approve":
                if stage not in ("home", "stills"):
                    raise AvatarError("nothing to approve now", 409)
                doc["done"]["approve_home" if stage == "home" else "approve_stills"] = True
                msg = ("The user approved the base picture; the stills are being made." if stage == "home" else
                       "The user approved the stills; the motion clips are being made (the longest part).")
            elif action == "back" and stage == "home" and doc["brief"]["reference"]["mode"] != "as_base":
                doc["done"]["pick"] = False
                doc["done"]["home"] = False
                doc["items"].pop("home", None)
                msg = "The user went back to the candidates to pick another one."
            else:
                raise AvatarError("unknown action")
            doc["checkpoint"] = None
            doc["status"] = "running"
            self._history(doc, f"checkpoint.{action}", stage=stage, candidate=candidate)
            self.save(doc)
        self._event(pid, f"decision_{action}", msg)
        self._kick(pid)
        return self.view(pid)

    async def user_redo(self, pid: str, key: str, note: str = "") -> dict[str, Any]:
        async with self._lock(pid):
            res = await self.redo(pid, key, note=note, by="user")
        return {"result": res, "project": self.view(pid)}

    async def confirm_extra(self, pid: str, xid: str, total: Any) -> dict[str, Any]:
        async with self._lock(pid):
            doc = self.doc(pid)
            x = PL.confirm_extra(doc, xid, total)
            for it in x["items"]:
                self._apply_redo(doc, it)
            if doc["status"] in ("ready", "waiting", "failed", "paused"):
                doc["status"] = "running"
                doc["paused"] = False
                doc["checkpoint"] = None if (doc.get("checkpoint") or {}).get("stage") == "cap" else doc.get("checkpoint")
            self._history(doc, "extra.confirmed", extra=xid, total=x["total"])
            self.save(doc)
        self._event(pid, "extra_confirmed", f"The user confirmed {x['reason']} ({x['total']:g} credits); it runs now.")
        self._kick(pid)
        return self.view(pid)

    async def decline_extra(self, pid: str, xid: str) -> dict[str, Any]:
        async with self._lock(pid):
            doc = self.doc(pid)
            for x in doc.get("extras") or []:
                if x["id"] == xid and x["status"] == "pending":
                    x["status"] = "declined"
            self.save(doc)
        return self.view(pid)

    # ---------------------------------------------------------------- redo / extend

    def _stage_unit(self, doc: dict[str, Any], stage: str) -> float:
        unit = PL.unit_of(doc.get("plan"), "design" if stage == "design" else stage)
        if unit is None and stage == "design":
            unit = PL.unit_of(doc.get("plan"), "stills")
        if unit is None:
            raise AvatarError(f"no price known for {stage} jobs (estimate again)")
        return float(unit)

    async def redo(self, pid: str, key: str, *, note: str = "", by: str = "agent") -> dict[str, Any]:
        """Redo one item, or a new batch of candidates (``design``). Within AUTO_REDO_MAX and the cap it runs at once;
        otherwise a request card waits for the user's OK (``by == "user"`` is that OK: their click)."""
        doc = self.doc(pid)
        if not doc.get("confirmation"):
            raise PL.GateError("not_confirmed", "nothing can be redone before the user confirms the plan")
        if key in ("design", "candidates"):
            n = doc["brief"]["candidates"]
            unit = self._stage_unit(doc, "design")
            redo = {"kind": "reroll", "key": "design", "count": n, "credits": round(unit * n, 4), "note": note}
            label = f"{n} new candidates"
        else:
            it = doc["items"].get(key)
            if it is None:
                raise AvatarError("no such item (see get_project: design, home, still:<name>, clip:<id>)")
            if it.get("status") in ("pending", "running"):
                raise AvatarError("that item is still being made")
            unit = float(it.get("credits") or self._stage_unit(doc, it["stage"]))
            extra = 0.0
            if it["stage"] == "clips":  # a new clip needs a new matte too
                extra = float(self._stage_unit(doc, "matte"))
            redo = {"kind": "item", "key": key, "credits": round(unit + extra, 4), "note": note}
            label = f"a redo of {key}"
        decision = "auto" if by == "user" and self._fits(doc, redo["credits"]) else PL.redo_decision(doc, redo["credits"])
        if decision == "auto":
            self._apply_redo(doc, redo)
            if doc["status"] in ("ready", "failed", "paused"):
                doc["status"] = "running"
                doc["paused"] = False
            self._history(doc, "redo", item=key, credits=redo["credits"], by=by)
            self.save(doc)
            self._kick(pid)
            return {"started": True, "credits": redo["credits"],
                    "text": f"Redoing {key} ({redo['credits']:g} credits, inside the confirmed cap)."}
        x = PL.new_extra(label, [redo])
        doc.setdefault("extras", []).append(x)
        self.save(doc)
        return {"started": False, "needs_confirmation": x["id"], "credits": x["total"],
                "text": f"{label} costs {x['total']:g} credits: the user sees a card to confirm it. End your turn."}

    @staticmethod
    def _fits(doc: dict[str, Any], credits: float) -> bool:
        try:
            PL.check_spend(doc, credits, allow_paused=True)
            return True
        except PL.GateError:
            return False

    def _apply_redo(self, doc: dict[str, Any], redo: dict[str, Any]) -> None:
        if redo["kind"] == "reroll":
            n0 = sum(1 for k in doc["items"] if k.startswith("design:"))
            doc["design_batch"] = int(doc.get("design_batch") or 1) + 1
            doc["design_extra"] = int(doc.get("design_extra") or 0) + redo["count"]
            doc["design_note"] = redo.get("note") or ""
            doc["done"]["design"] = False
            doc["done"]["pick"] = False
            doc["_design_target"] = n0 + redo["count"]
            return
        if redo["kind"] == "cap":  # (more room under the cap: nothing else changes)
            return
        if redo["kind"] == "add":  # extend: new clips / stills join the brief
            for c in redo.get("clips") or []:
                doc["brief"]["clips"].append(c)
            for s in redo.get("stills") or []:
                doc["brief"]["stills"].append(s)
            if redo.get("clips"):
                for ph in ("clips", "matte", "encode", "check", "export"):
                    doc["done"][ph] = False
            if redo.get("stills"):
                for ph in ("stills", "export"):
                    doc["done"][ph] = False
            return
        key = redo["key"]
        it = doc["items"][key]
        it.update({"status": "pending", "tries": 0, "job_id": None, "error": None,
                   "version": int(it.get("version") or 1) + 1, "note": redo.get("note") or ""})
        stage = it["stage"]
        if stage == "home":
            for ph in ("home", "approve_home"):
                doc["done"][ph] = False
        elif stage == "stills":
            for ph in ("stills", "export"):
                doc["done"][ph] = False
        elif stage == "clips":
            cid = key.split(":", 1)[1]
            m = doc["items"].get(f"matte:{cid}")
            if m:
                m.update({"status": "pending", "tries": 0, "job_id": None, "error": None, "processed": False})
            for ph in ("clips", "matte", "encode", "check", "export"):
                doc["done"][ph] = False
            doc.setdefault("reencode", [])
            if cid not in doc["reencode"]:
                doc["reencode"].append(cid)
        elif stage == "matte":
            it["processed"] = False
            for ph in ("matte", "encode", "check", "export"):
                doc["done"][ph] = False

    async def extend(self, pid: str, *, clips: list[Any], stills: list[Any], by: str) -> dict[str, Any]:
        doc = self.doc(pid)
        if not doc.get("confirmation"):
            raise AvatarError("before the plan is confirmed, change the brief with update_brief")
        seen_c = {c["id"] for c in doc["brief"]["clips"]}
        seen_s = {s["name"] for s in doc["brief"]["stills"]}
        new_c = [P._clean_clip(c, seen_c) for c in clips]
        new_s = [P._clean_still(s, seen_s) for s in stills]
        if not new_c and not new_s:
            raise AvatarError("nothing to add")
        if len(doc["brief"]["clips"]) + len(new_c) > P.MAX_CLIPS or len(doc["brief"]["stills"]) + len(new_s) > P.MAX_STILLS:
            raise AvatarError("that is more than a project may have")
        credits = len(new_c) * (self._stage_unit(doc, "clips") + self._stage_unit(doc, "matte"))
        if new_s:
            credits += len(new_s) * self._stage_unit(doc, "stills")
        x = PL.new_extra(f"{len(new_c)} more clip(s) and {len(new_s)} more still(s)",
                         [{"kind": "add", "key": "extend", "credits": round(credits, 4), "clips": new_c,
                           "stills": new_s}])
        doc.setdefault("extras", []).append(x)
        self.save(doc)
        return {"needs_confirmation": x["id"], "credits": x["total"],
                "text": f"Adding them costs {x['total']:g} credits: the user sees a card to confirm. End your turn."}

    # ---------------------------------------------------------------- the runner

    def _kick(self, pid: str) -> None:
        t = self._runners.get(pid)
        if t is not None and not t.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._runners[pid] = loop.create_task(self._run(pid))

    async def _run(self, pid: str) -> None:
        try:
            while True:
                doc = self.doc(pid)
                if doc.get("canceled"):
                    doc["status"] = "canceled"
                    self.save(doc)
                    return
                if doc.get("paused"):
                    if doc["status"] == "running":
                        doc["status"] = "paused"
                        self.save(doc)
                    return
                if doc["status"] != "running":
                    return
                phase = next((ph for ph in PHASES if not doc["done"].get(ph)), None)
                if phase is None:
                    await self._finish(pid)
                    return
                if phase in CHECKPOINTS:
                    await self._wait_checkpoint(pid, CHECKPOINTS[phase])
                    return
                doc["phase"] = phase
                self.save(doc)
                try:
                    await getattr(self, f"_phase_{phase}")(pid)
                except Paused:
                    continue
                except PL.GateError as exc:
                    await self._gate_stop(pid, exc)
                    return
                except Exception as exc:  # noqa: BLE001 - the run stops with the reason; resume tries again
                    doc = self.doc(pid)
                    doc["status"] = "failed"
                    doc["error"] = _clip(str(exc), 600)
                    self._history(doc, "failed", phase=phase, error=doc["error"])
                    self.save(doc)
                    self._log("warning", f"avatar {pid} {phase}: {exc}", code="avatar.phase_failed")
                    self._event(pid, "failed", f"The {phase} step failed: {doc['error']}\nExplain it simply; the "
                                "user can press Resume to try the step again, or you may suggest a redo.")
                    return
                doc = self.doc(pid)
                doc["done"][phase] = True
                self.save(doc)
        except asyncio.CancelledError:
            raise
        finally:
            self._runners.pop(pid, None)

    async def _gate_stop(self, pid: str, exc: PL.GateError) -> None:
        doc = self.doc(pid)
        if exc.code == "paused":
            doc["status"] = "paused"
        elif exc.code == "canceled":
            doc["status"] = "canceled"
        else:
            doc["status"] = "waiting"
            doc["checkpoint"] = {"stage": "cap", "at": now_iso(), "reason": str(exc)}
            pend = [k for k, it in doc["items"].items() if it.get("status") in ("pending", "blocked")]
            credits = sum(float(doc["items"][k].get("credits") or 0) for k in pend)
            if credits > 0 and not any(x["status"] == "pending" for x in doc.get("extras") or []):
                doc.setdefault("extras", []).append(PL.new_extra(
                    f"{len(pend)} more job(s) beyond the confirmed cap", [{"kind": "cap", "key": "cap",
                                                                           "credits": round(credits, 4)}]))
            self._event(pid, "cap", f"The run stopped: {exc}. A card asks the user to allow more credits.")
        self.save(doc)

    async def _wait_checkpoint(self, pid: str, stage: str) -> None:
        doc = self.doc(pid)
        doc["status"] = "waiting"
        doc["checkpoint"] = {"stage": stage, "at": now_iso()}
        doc["phase"] = stage
        self._history(doc, "checkpoint", stage=stage)
        self.save(doc)
        texts = {
            "pick": "The candidates are ready ({n}). Look at them (look candidates) and tell the user briefly what "
                    "you notice in each (hands, framing, face, background); recommend one. They pick in the panel, "
                    "or ask for new candidates.",
            "home": "The base picture is cut out and placed (look home: the picture and the face region the stills "
                    "may change). Check edges, hair and the face region, then ask the user to approve it in the "
                    "panel (or go back to the candidates).",
            "stills": "The stills are ready (look stills). Compare each face with the base picture; point out any "
                      "that look wrong and offer to redo them. The user approves in the panel; the clips come next.",
        }
        n = sum(1 for it in doc["items"].values() if it["stage"] == "design" and it.get("status") == "done")
        self._event(pid, f"checkpoint_{stage}", texts[stage].format(n=n))

    async def _finish(self, pid: str) -> None:
        doc = self.doc(pid)
        doc["status"] = "ready"
        doc["phase"] = None
        doc["finished_at"] = now_iso()
        self._history(doc, "ready")
        self.save(doc)
        chk = doc.get("check") or {}
        bad = chk.get("redo") or []
        failed = [k for k, it in doc["items"].items() if it.get("status") == "failed"]
        self._event(pid, "ready", "The avatar is ready and plays in the panel's preview. "
                    + (f"These clips failed the automatic check: {', '.join(bad)} — explain and offer redos. "
                       if bad else "Every clip passed the automatic check. ")
                    + (f"These items failed and were left out: {', '.join(failed)}. " if failed else "")
                    + "Tell the user they can press Apply (to the target mate) or create a new mate with it.")

    # ---- jobs ----

    def _item(self, doc: dict[str, Any], key: str, stage: str, job_type: str, out: str, credits: float) -> dict:
        it = doc["items"].get(key)
        if it is None:
            it = {"key": key, "stage": stage, "job_type": job_type, "out": out, "credits": credits,
                  "status": "pending", "tries": 0, "job_id": None, "error": None, "version": 1}
            doc["items"][key] = it
        return it

    async def _jobs(self, pid: str, keys: list[str], flags_for: Any, parallel: int) -> None:
        """Run these items' jobs (``flags_for(doc, item)`` → the CLI flags), ``parallel`` at a time. Pause/cancel:
        no new job starts (Paused is raised once the running ones finished); the gate refusing one stops them all."""
        queue = [k for k in keys if self.doc(pid)["items"][k].get("status") != "done"]
        stop: dict[str, Any] = {"paused": False, "gate": None}

        async def worker() -> None:
            while queue and stop["gate"] is None:
                doc = self.doc(pid)
                if doc.get("paused") or doc.get("canceled"):
                    stop["paused"] = True
                    return
                key = queue.pop(0)
                try:
                    await self._one_job(pid, key, flags_for)
                except PL.GateError as exc:
                    stop["gate"] = exc
                    return

        await asyncio.gather(*(worker() for _ in range(max(1, parallel))))
        if stop["gate"] is not None:
            raise stop["gate"]
        if stop["paused"]:
            raise Paused()

    async def _one_job(self, pid: str, key: str, flags_for: Any) -> None:
        """One item to done (or failed): a new try passes the gate, is counted, submitted, its id saved; a try that
        was already submitted (a restart) is only waited for."""
        d = self.dir(pid)
        while True:
            doc = self.doc(pid)
            it = doc["items"][key]
            if it.get("status") in ("done", "failed"):
                return
            jid = it.get("job_id") if it.get("status") == "running" else None
            finished: dict[str, Any] | None = None
            if not jid:
                if it.get("status") == "running":  # (a restart while submitting: that try counts, as spent)
                    it["error"] = "interrupted while submitting"
                if it["tries"] >= MAX_TRIES:
                    it["status"] = "failed"
                    self.save(doc)
                    self._event(pid, "job_failed", f"{key} failed after {MAX_TRIES} tries: {it.get('error')}")
                    return
                PL.check_spend(doc, float(it["credits"]))  # THE GATE: raises before anything is spent
                PL.commit(doc, float(it["credits"]))
                it["tries"] += 1
                it["status"] = "running"
                it["job_id"] = None
                it["started_at"] = now_iso()
                self._history(doc, "job.submit", item=key, credits=it["credits"], attempt=it["tries"])
                self.save(doc)
                try:
                    job = await self.gen.create(it["job_type"], flags_for(doc, it), workdir=d)
                except JobError as exc:
                    await self._job_failed(pid, key, exc)
                    continue
                doc = self.doc(pid)
                it = doc["items"][key]
                jid = job_id(job)
                it["job_id"] = jid or "direct"
                self.save(doc)
                if not jid:  # (an answer that already holds the result)
                    finished = job
            try:
                if finished is None:
                    finished = await self.gen.wait(jid, workdir=d)
                url = result_url(finished)
                if not url:
                    raise JobError("the finished job has no result", code="no_result")
                await self.gen.download(url, d / it["out"])
            except JobError as exc:
                await self._job_failed(pid, key, exc)
                continue
            doc = self.doc(pid)
            it = doc["items"][key]
            it.update({"status": "done", "error": None, "finished_at": now_iso()})
            self._history(doc, "job.done", item=key)
            self.save(doc)
            return

    async def _job_failed(self, pid: str, key: str, exc: JobError) -> None:
        doc = self.doc(pid)
        it = doc["items"][key]
        it["error"] = _clip(str(exc), 300)
        it["job_id"] = None
        refused = not exc.retry
        it["status"] = "failed" if refused or it["tries"] >= MAX_TRIES else "pending"
        self._history(doc, "job.failed", item=key, error=it["error"], code=exc.code)
        self.save(doc)
        if it["status"] == "failed":
            self._event(pid, "job_failed", f"{key} failed{' (refused by Higgsfield)' if refused else ''}: {it['error']}")
        else:
            await asyncio.sleep(min(60, 10 * it["tries"]))

    # ---- phases ----

    def _pipeline_cfg(self, doc: dict[str, Any]) -> None:
        b = doc["brief"]
        cfg = {"aspect": b["aspect"], "sizes": P.TIERS[b["tier"]]["sizes"], "gray": list(P.GRAY),
               "stills": [s["name"] for s in b["stills"]],
               "clips": [{k: c[k] for k in ("id", "kind", "emotion", "loop") if k in c} for c in b["clips"]
                         if (doc["items"].get(f"clip:{c['id']}") or {}).get("status") == "done"]}
        (self.dir(doc["id"]) / "pipeline.json").write_text(json.dumps(cfg, indent=1))

    async def _process(self, pid: str, step: str, *args: str, timeout: float = 1800) -> dict[str, Any]:
        doc = self.doc(pid)
        self._pipeline_cfg(doc)
        doc["processing"] = {"step": step, "args": list(args), "at": now_iso()}
        self.save(doc)
        try:
            return await self.deps.run(step, [str(self.dir(pid)), *args], timeout=timeout)
        finally:
            doc = self.doc(pid)
            doc["processing"] = None
            self.save(doc)

    async def _phase_design(self, pid: str) -> None:
        doc = self.doc(pid)
        b = doc["brief"]
        unit = self._stage_unit(doc, "design")
        redraw = b["reference"]["mode"] == "redraw"
        target = int(doc.get("_design_target") or b["candidates"])
        have = sorted(k for k in doc["items"] if k.startswith("design:"))
        n = len(have)
        while n < target:
            n += 1
            self._item(doc, f"design:c{n}", "design", PL.IMAGE_JOB, f"design/c{n}.png", unit)
        self.save(doc)
        ref = [str(self.dir(pid) / "ref" / f) for f in b["reference"].get("files") or []]
        note = doc.get("design_note") or ""

        def flags(d: dict[str, Any], it: dict[str, Any]) -> list[str]:
            prompt = P.design_prompt(" ".join(x for x in (d["brief"]["design"]["prompt"], note) if x), redraw=redraw)
            out = ["--prompt", prompt, "--aspect_ratio", PL.IMAGE_PARAMS["aspect_ratio"], "--resolution",
                   PL.IMAGE_PARAMS["resolution"]]
            for r in (ref if redraw else []):
                out += ["--image-references", r]
            return out

        keys = sorted((k for k in self.doc(pid)["items"] if k.startswith("design:")), key=lambda k: int(k[8:]))
        await self._jobs(pid, keys, flags, PARALLEL["design"])
        doc = self.doc(pid)
        ok = [k for k in keys if doc["items"][k]["status"] == "done"]
        if not ok:
            raise RuntimeError("no candidate could be made")
        for k in ok:
            cid = k.split(":")[1]
            if not (self.dir(pid) / "thumbs" / f"{cid}.jpg").is_file():
                await self.deps.run("thumb", [str(self.dir(pid) / f"design/{cid}.png"),
                                              str(self.dir(pid) / f"thumbs/{cid}.jpg")], timeout=120)
        doc.pop("_design_target", None)
        self.save(doc)

    async def _phase_home(self, pid: str) -> None:
        doc = self.doc(pid)
        d = self.dir(pid)
        m = d / "masters"
        m.mkdir(parents=True, exist_ok=True)
        if doc["picked"] == "ref":
            src = d / "ref" / doc["brief"]["reference"]["files"][-1]
        else:
            src = d / doc["items"][f"design:{doc['picked']}"]["out"]
        await asyncio.to_thread(_to_png, src, m / "candidate.png", self.deps)
        it = self._item(doc, "home", "home", PL.CUTOUT_JOB, "masters/candidate.cut.png", self._stage_unit(doc, "home"))
        it.setdefault("source", str(src))
        self.save(doc)
        await self._process(pid, "prep", timeout=300)
        await self._jobs(pid, ["home"], lambda _d, _i: ["--image-references", str(m / "candidate.cutin.jpg")], 1)
        doc = self.doc(pid)
        if doc["items"]["home"]["status"] != "done":
            raise RuntimeError("the cut-out failed: " + str(doc["items"]["home"].get("error") or ""))
        res = await self._process(pid, "home", timeout=600)
        doc = self.doc(pid)
        doc["home"] = res
        self.save(doc)

    async def _phase_stills(self, pid: str) -> None:
        doc = self.doc(pid)
        d = self.dir(pid)
        unit = self._stage_unit(doc, "stills")
        try:
            job_aspect = json.loads((d / "masters" / "info.json").read_text()).get("job_aspect") or "3:4"
        except (OSError, ValueError):
            job_aspect = "3:4"
        keys = []
        for s in doc["brief"]["stills"]:
            key = f"still:{s['name']}"
            self._item(doc, key, "stills", PL.IMAGE_JOB, f"stills/{s['name']}.raw.png", unit)
            keys.append(key)
        self.save(doc)
        faces = {f"still:{s['name']}": s["face"] for s in doc["brief"]["stills"]}

        def flags(dd: dict[str, Any], it: dict[str, Any]) -> list[str]:
            face = faces[it["key"]] + (f"; {it['note']}" if it.get("note") else "")
            return ["--prompt", P.face_prompt(face, dd["brief"]["pronoun"]), "--aspect_ratio", job_aspect,
                    "--resolution", PL.IMAGE_PARAMS["resolution"], "--image-references",
                    str(d / "masters" / "candidate.ref.jpg")]

        await self._jobs(pid, keys, flags, PARALLEL["stills"])
        await self._process(pid, "stills", timeout=900)

    async def _phase_clips(self, pid: str) -> None:
        doc = self.doc(pid)
        d = self.dir(pid)
        b = doc["brief"]
        unit = self._stage_unit(doc, "clips")
        params = PL.clip_params(b)
        keys = []
        for c in b["clips"]:
            key = f"clip:{c['id']}"
            self._item(doc, key, "clips", PL.CLIP_JOB, f"clips/{c['id']}.mp4", unit)
            keys.append(key)
        self.save(doc)
        actions = {f"clip:{c['id']}": c["action"] for c in b["clips"]}
        home = str(d / "masters" / "home-gray.jpg")

        def flags(dd: dict[str, Any], it: dict[str, Any]) -> list[str]:
            action = actions[it["key"]] + (f", {it['note']}" if it.get("note") else "")
            return ["--prompt", P.clip_prompt(action, dd["brief"]["pronoun"]), "--start-image", home, "--end-image",
                    home, "--aspect_ratio", params["aspect_ratio"], "--duration", str(params["duration"]), "--mode",
                    params["mode"], "--sound", params["sound"]]

        await self._jobs(pid, keys, flags, PARALLEL["clips"])

    async def _phase_matte(self, pid: str) -> None:
        doc = self.doc(pid)
        d = self.dir(pid)
        unit = self._stage_unit(doc, "matte")
        for c in doc["brief"]["clips"]:
            clip = doc["items"].get(f"clip:{c['id']}")
            if not clip or clip["status"] != "done":
                continue
            key = f"matte:{c['id']}"
            self._item(doc, key, "matte", PL.MATTE_JOB, f"clips/{c['id']}.nobg.mp4", unit)
            self.save(doc)
            await self._jobs(pid, [key], lambda _d, _i, cid=c["id"]: ["--video-references",
                                                                     str(d / "clips" / f"{cid}.mp4")], 1)
            doc = self.doc(pid)
            it = doc["items"][key]
            if it["status"] == "done" and not it.get("processed"):
                res = await self._process(pid, "matte", c["id"], timeout=1800)
                doc = self.doc(pid)
                doc["items"][key]["processed"] = True
                doc["items"][key]["matte"] = res
                self.save(doc)

    async def _phase_encode(self, pid: str) -> None:
        doc = self.doc(pid)
        d = self.dir(pid)
        try:
            before = json.loads((d / "web" / "box.json").read_text()).get("box")
        except (OSError, ValueError):
            before = None
        only = list(doc.get("reencode") or [])
        res = await self._process(pid, "encode", ",".join(only) if (only and before) else "", timeout=3600)
        if only and before and res.get("box") != before:
            await self._process(pid, "encode", "", timeout=3600)  # the crop changed: every clip again
        doc = self.doc(pid)
        doc["reencode"] = []
        self.save(doc)

    async def _phase_check(self, pid: str) -> None:
        res = await self._process(pid, "check", timeout=1800)
        doc = self.doc(pid)
        doc["check"] = res
        self.save(doc)

    async def _phase_export(self, pid: str) -> None:
        res = await self._process(pid, "export", f"avatar-{pid}", timeout=900)
        doc = self.doc(pid)
        doc["result"] = {**res, "at": now_iso()}
        self.save(doc)

    # ---------------------------------------------------------------- apply / restore

    async def apply(self, pid: str, *, mate_id: str | None = None, new_name: str | None = None) -> dict[str, Any]:
        """Put the made avatar on a mate (its current avatar is kept as a backup) or on a new mate."""
        async with self._lock(pid):
            doc = self.doc(pid)
            exp = self.dir(pid) / "export"
            if not (exp / "rig.json").is_file():
                raise AvatarError("the avatar is not ready yet", 409)
            if new_name is not None:
                name = new_name.strip() or doc["brief"]["target"].get("name") or "New mate"
                lang = doc.get("language") or "en"
                mate = self.mates.create({"name": name, "persona": {"language": lang}})
                mate_id = mate["id"]
                backup = None
            else:
                if not mate_id:
                    raise AvatarError("which mate?")
                mate = self.mates.get(mate_id)
                backup = await asyncio.to_thread(self._backup, pid, mate)
            avatar = await asyncio.to_thread(mate_files.import_folder_pack, mate_id, exp)
            mate = self.mates.update(mate_id, {"avatar": avatar})
            doc["applied"] = {"mate_id": mate_id, "name": mate["name"], "at": now_iso(), "backup": backup,
                              "new": new_name is not None}
            doc["status"] = "applied"
            self._history(doc, "applied", mate=mate_id)
            self.save(doc)
        self._event(pid, "applied", f"The user put the avatar on “{mate['name']}”. Congratulate them in one sentence.")
        return {"project": self.view(pid), "mate": mate}

    def _backup(self, pid: str, mate: dict[str, Any]) -> dict[str, Any]:
        """The mate's avatar now, with copies of the imported folders it uses (applying a new pack removes them)."""
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = self.dir(pid) / "backups" / f"{mate['id']}-{stamp}"
        base.mkdir(parents=True, exist_ok=True)
        dirs = sorted(mate_files.import_dirs_of(mate["avatar"], mate["id"]))
        for name in dirs:
            src = mate_files.assets_dir(mate["id"]) / name
            if src.is_dir():
                shutil.copytree(src, base / name, dirs_exist_ok=True)
        (base / "avatar.json").write_text(json.dumps(mate["avatar"], ensure_ascii=False, indent=1))
        return {"path": str(base.relative_to(self.dir(pid))), "dirs": dirs, "kind": mate["avatar"].get("kind")}

    async def restore(self, pid: str) -> dict[str, Any]:
        async with self._lock(pid):
            doc = self.doc(pid)
            ap = doc.get("applied") or {}
            bk = ap.get("backup")
            if not bk:
                raise AvatarError("there is no backup to restore", 409)
            base = self.dir(pid) / bk["path"]
            avatar = json.loads((base / "avatar.json").read_text())
            mid = ap["mate_id"]

            def put_back() -> None:
                for name in bk.get("dirs") or []:
                    dst = mate_files.assets_dir(mid) / name
                    if not dst.exists() and (base / name).is_dir():
                        shutil.copytree(base / name, dst)
            await asyncio.to_thread(put_back)
            mate = self.mates.update(mid, {"avatar": avatar})
            doc["applied"] = {**ap, "restored_at": now_iso()}
            doc["status"] = "ready"
            self._history(doc, "restored", mate=mid)
            self.save(doc)
        return {"project": self.view(pid), "mate": mate}


# ---------------------------------------------------------------- small helpers (no numpy here)

def _gray_png(w: int, h: int) -> bytes:
    import struct
    import zlib

    raw = b"".join(b"\x00" + bytes(P.GRAY) * w for _ in range(h))

    def chunk(t: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _small_jpeg(p: Path, deps: Deps) -> bytes | None:
    """A ≤1024px JPEG of a picture for the model (made by the pipeline's thumb step when it isn't one already)."""
    import subprocess

    if p.suffix.lower() in (".jpg", ".jpeg") and p.stat().st_size < 600_000:
        return p.read_bytes()
    out = p.with_name(f".look-{p.stem}.jpg")
    if not out.is_file() or out.stat().st_mtime < p.stat().st_mtime:
        r = subprocess.run([str(deps_python(deps)), "-I", str(Path(__file__).with_name("pipeline.py")), "thumb",
                            str(p), str(out), "1024"], capture_output=True, timeout=120)
        if r.returncode != 0 or not out.is_file():
            return None
    return out.read_bytes()


def deps_python(deps: Deps) -> Path:
    from app.avatar.deps import venv_python

    return venv_python()


def _to_png(src: Path, dst: Path, deps: Deps) -> None:
    """The chosen picture as masters/candidate.png (a byte copy when it is a PNG already)."""
    import subprocess

    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() == ".png":
        shutil.copyfile(src, dst)
        return
    code = ("import sys; from PIL import Image; Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2])")
    r = subprocess.run([str(deps_python(deps)), "-I", "-c", code, str(src), str(dst)], capture_output=True,
                       timeout=120)
    if r.returncode != 0:
        raise RuntimeError("could not read the picture: " + r.stderr.decode(errors="replace")[-200:])
