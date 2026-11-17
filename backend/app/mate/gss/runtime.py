"""The Geny-State-System at work (docs/geny-state-system.md): what runs around a mate's turns on top of how she feels
(state.py) and the relationship (affinity.py) — reading each message by a model before she answers (``prepare``), promises,
what she remembers of the two of them, making up, her own unfairness owned, not repeating herself (``after_turn``), what she
is told of it (``context_lines``), each mate's temperament (``derive_temperament``), and the journal of all of it."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from app.mate import affinity as A
from app.mate import state as S
from app.mate.gss import echo, episodes as E, promises as P, temperament as T
from app.mate.gss.appraisal import MODEL, Appraiser
from app.mate.gss.journal import Journal

RECENT = 6
AWAY_WORDS = re.compile(r"출장|여행|한동안|며칠 ?(동안|간)? ?(못|안)|다녀올게|휴가|입원|군대|\bbusiness trip\b|\bvacation\b|"
                        r"\bfor a (few|couple of) days\b|\bfor a while\b", re.I)
AWAY_GUESS = timedelta(days=3)  # (gone, with no word of how long)
HURT_EPISODE_FROM = S.GRUDGE_STINGS  # (a hurt worth remembering: one that stung)


class GSSRuntime:
    def __init__(self, mates: Any) -> None:
        self.mates = mates
        self.store = mates.store
        self.journal = Journal(self.store._db)
        self.appraiser = Appraiser(self._fast_key, self._slow)
        self.appraiser.on_read = self._on_read
        self._deriving: set[str] = set()

    # ---- the model: an API key's fast way, else a Claude Code one-shot ----

    def _fast_key(self) -> str | None:
        """An Anthropic API key, read without taking a turn of any account (the pool's balancing is for the chats), or None:
        the pool's API-key accounts, else the Claude provider's key."""
        svc = self.mates._svc
        pool = svc._pool
        if pool is not None:
            for name in ("anthropic", "claude"):
                try:
                    accounts = pool.list(name)
                except Exception:  # noqa: BLE001 - no such provider
                    accounts = []
                for acc in accounts:
                    if (name == "anthropic" or acc.get("auth_mode") == "api_key") and acc.get("enabled", 1) not in (0, False):
                        key = pool.api_key(acc)
                        if key:
                            return key
        try:
            return svc._providers.resolved_api_key("claude") or None
        except Exception:  # noqa: BLE001
            return None

    async def _slow(self, system: str, user: str) -> str | None:
        """Claude Code on the lightest model, no tools, nothing on disk: one answer."""
        from app.mate import files
        from app.providers.base import TurnRequest
        from app.services.session_service import get_provider

        svc = self.mates._svc
        lease, env, key = None, {}, None
        try:
            if svc._pool is not None:
                lease = await asyncio.to_thread(svc._pool.select, "claude", begin_turn=True)
                if lease is not None:
                    if not lease.is_primary:
                        env["CLAUDE_CONFIG_DIR"] = lease.config_dir
                    if lease.auth_mode == "api_key":
                        key = lease.api_key
            root = files.root() / ".gss-reader"  # (a folder of its own: nothing of any mate's)
            root.mkdir(parents=True, exist_ok=True)
            req = TurnRequest(messages=[{"role": "user", "content": user}], model=MODEL, effort="low", cwd=str(root), api_key=key,
                              extra_env=env, timeout_s=60, system_prompt=system, sealed=True, ephemeral=True,
                              require_sealed_catalog=True, tools=[], allowed_tools=[], mcp_config={"mcpServers": {}})
            text = ""
            async with asyncio.timeout(70):
                async for ev in get_provider("claude").run_turn_stream(req):
                    if ev.type == "tool.start":
                        return None
                    if ev.type == "text.delta":
                        text += str(ev.data.get("text") or "")
                    if ev.type == "error":
                        return None
                    if ev.type == "turn.complete":
                        text = str(ev.data.get("text") or text)
            return text
        except Exception:  # noqa: BLE001 - no reading: the words stand
            return None
        finally:
            if lease is not None:
                svc._pool.end_turn(lease)
                svc._pool.release(lease)

    async def ask(self, system: str, user: str) -> str | None:
        fast = await asyncio.to_thread(self._fast_key)
        if fast is not None:
            try:
                return await Appraiser._ask_api(fast, system, user)
            except Exception:  # noqa: BLE001
                pass
        async with self.appraiser.slow_gate:  # (one Claude Code one-shot at a time: this machine is tight on memory)
            return await self._slow(system, user)

    # ---- before her turn ----

    def _recent(self, sid: str, but: str) -> list[str]:
        rows = self.store._db.query("SELECT id, role, content, meta FROM messages WHERE session_id = ? AND role IN ('user', 'steer', "
                                    "'assistant') ORDER BY rowid DESC LIMIT ?", (sid, RECENT + 2))
        out = []
        for r in reversed(rows):
            if r["id"] == but:
                continue
            try:
                meta = json.loads(r["meta"] or "null") or {}
            except ValueError:
                meta = {}
            if isinstance(meta, dict) and meta.get("internal"):
                continue
            who = "User" if r["role"] in ("user", "steer") else "Her"
            out.append(f"{who}: {' '.join(str(r['content'] or '').split())[:300]}")
        return out[-RECENT:]

    async def prepare(self, session: dict[str, Any]) -> None:
        """A turn of hers is about to start: read the user's message (briefly waited for, the fast way), and what their writing
        settles — promises to be in touch, a hurt that has passed since."""
        mate_id, sid = session.get("mate_id") or "", session.get("id") or ""
        said = self.mates._users_latest(sid) if sid else None
        if not mate_id or not said:
            return
        try:
            mate = self.store.get(mate_id)
        except KeyError:
            return
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc, w = self.store.state_doc(mate_id), self.store.state_who(mate_id)
        words = A.cues(said["content"], name=mate["name"])
        open_things = (S.grudge(doc, w, now) >= S.GRUDGE_SHOWN or S.levels(doc, w, now, tz)["angry"]["v"] >= S.SHOWN_FROM
                       or bool(P.open_ones(doc)))
        settled: list[dict[str, Any]] = []

        last = A._t(doc.get("heard_at"))  # (their message before this one)

        def contact(d: dict[str, Any], who: dict[str, Any], at: datetime, zone: Any) -> None:
            settled.extend(P.heard_from_them(d, at, last))
            for p in settled:
                if p["status"] == "broken":
                    S.broken_promise(d, who, p["what"], at, zone)
            settled.extend(P.tick(d, at))

        self.mates._state_event(mate_id, contact)
        self._promises_settled(mate_id, mate, settled, now, tz)
        self._repair(mate_id, mate, now, tz)
        if AWAY_WORDS.search(said["content"] or ""):  # (they say they'll be gone: the quiet days until then count for nothing)
            self.mates._relation_costs(mate_id, [{"code": "away", "until": A._iso(now + AWAY_GUESS)}], now, tz)
        await self.appraiser.read(mate_id, said["id"], mate["name"], said["content"], self._recent(sid, said["id"]),
                                  P.open_ones(self.store.state_doc(mate_id)), words=words, open_things=open_things)

    # ---- a reading came ----

    def _on_read(self, mate_id: str, message_id: str, reading: dict[str, Any]) -> None:
        self.journal.record(mate_id, "heard", "reading", {"message": message_id, **reading})
        try:
            mate = self.store.get(mate_id)
        except KeyError:
            return
        now, tz = datetime.now(timezone.utc), self.store.tz()
        kept: list[dict[str, Any]] = []
        made: list[dict[str, Any]] = []

        def promises(d: dict[str, Any], who: dict[str, Any], at: datetime, zone: Any) -> None:
            kept.extend(P.fulfil(d, reading.get("fulfills") or [], at))
            for whose, p in (("user", reading.get("promise")), ("her", reading.get("her_promise"))):
                if p:
                    added = P.add(d, whose, p["what"], p.get("kind") or "other", at, p.get("due_in_hours"), message_id)
                    if added:
                        made.append(added)

        self.mates._state_event(mate_id, promises)
        for p in made:
            self.journal.record(mate_id, "promise", "made", p)
            if p["who"] == "user" and p["kind"] == "contact" and P._t(p["due_at"]) and P._t(p["due_at"]) - now >= timedelta(hours=20):
                self.mates._relation_costs(mate_id, [{"code": "away", "until": p["due_at"]}], now, tz)  # (back by then, they said)
        self._promises_settled(mate_id, mate, kept, now, tz)

    def _promises_settled(self, mate_id: str, mate: dict[str, Any], settled: list[dict[str, Any]], now: datetime, tz: Any) -> None:
        costs = []
        for p in settled:
            self.journal.record(mate_id, "promise", p["status"], p)
            if p.get("who") == "user" and p["status"] in ("kept", "broken"):
                costs.append({"code": f"promise_{p['status']}"})
                if not self._remembered(mate_id, f"promise_{p['status']}", days=1):  # (one a day: they don't crowd out the rest)
                    self._remember(mate, f"promise_{p['status']}", {"what": p["what"]}, now)
        if costs:
            self.mates._relation_costs(mate_id, costs, now, tz)

    def _repair(self, mate_id: str, mate: dict[str, Any], now: datetime, tz: Any) -> None:
        """A hurt that stung, owned and passed: they made up (trust comes out of it a little stronger, and she remembers)."""
        done: list[dict[str, Any]] = []
        self.mates._state_event(mate_id, lambda d, who, at, zone: done.extend([m] if (m := S.made_up(d, who, at)) else []))
        for m in done:
            self.journal.record(mate_id, "grudge", "made_up", m)
            self.mates._relation_costs(mate_id, [{"code": "made_up"}], now, tz)
            self._remember(mate, "made_up", {"quote": (m.get("why") or {}).get("quote")}, now)

    # ---- after her turn ----

    def after_turn(self, mate_id: str, outcome: dict[str, Any], before: dict[str, Any] | None) -> None:
        """What her reply and the turn leave: her words kept (not to repeat them), a hurt worth remembering, the bonds' turning
        points."""
        text = str(outcome.get("text") or "")
        try:
            mate = self.store.get(mate_id)
        except KeyError:
            return
        now, tz = datetime.now(timezone.utc), self.store.tz()
        hurt: list[dict[str, Any]] = []

        def note(d: dict[str, Any], who: dict[str, Any], at: datetime, zone: Any) -> None:
            if text.strip() and not outcome.get("refused"):
                echo.note(d, text)
            g = d.get("grudge") if isinstance(d.get("grudge"), dict) else None
            if g and float(g.get("weight") or 0) >= HURT_EPISODE_FROM and not g.get("remembered") and S.grudge(d, who, at) >= S.GRUDGE_SHOWN:
                g["remembered"] = True
                hurt.append(dict(g))

        self.mates._state_event(mate_id, note)
        if text.strip() and not outcome.get("refused"):
            self.journal.record(mate_id, "said", "reply", {"text": text[:600]})
        for g in hurt:
            why = g.get("why") or {}
            self.journal.record(mate_id, "episode", "hurt", why)
            self._remember(mate, "hurt", {"kind": why.get("kind"), "quote": why.get("quote")}, now)
        rel = self.store.relation_doc(mate_id)
        if rel is not None and before is not None:
            was, now_words = A.bond_words(before), A.bond_words(rel)
            if was["romance"] != "mutual" and now_words["romance"] == "mutual" and not self._remembered(mate_id, "romance"):
                self._remember(mate, "romance", {}, now)
            if was["trust"] != "broken" and now_words["trust"] == "broken" and not self._remembered(mate_id, "trust_broken", days=30):
                self._remember(mate, "trust_broken", {}, now)

    def _remembered(self, mate_id: str, kind: str, days: int | None = None) -> bool:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds") if days else ""
        return bool(self.store._db.query_one("SELECT 1 FROM mate_gss_events WHERE mate_id = ? AND layer = 'episode' AND kind = ? "
                                             "AND at >= ?", (mate_id, kind, since)))

    def _remember(self, mate: dict[str, Any], kind: str, data: dict[str, Any], at: datetime) -> None:
        """A moment between them, as one of her memories (never counted as a new memory for the relationship)."""
        lang = str(((mate.get("persona") or {}).get("language") or "ko"))[:2]
        user = str(((mate.get("prefs") or {}).get("user_name") or "")).strip()
        text = E.text(kind, data, at.astimezone(self.store.tz()), "ko" if lang == "ko" else "en", user)
        if not text:
            return
        if kind != "hurt":
            self.journal.record(mate["id"], "episode", kind, data, at)
        try:
            self.store.add_memory(mate["id"], text, kind="fact", importance=4, source="gss")
        except Exception:  # noqa: BLE001 - a memory that can't be saved (forgotten before, a duplicate): the journal has it
            pass

    # ---- what she is told ----

    def context_lines(self, mate: dict[str, Any], st: dict[str, Any], turn: int, now: datetime, tz: Any,
                      rel: dict[str, Any] | None) -> list[str]:
        """Lines for her <context>, each only when it changed (or now and then): the bonds in words, promises, what she may
        own of her own, what she has already said, how often it happened."""
        mate_id = mate["id"]
        out: list[str] = []
        if rel and rel.get("enabled") and not rel.get("paused") and rel.get("started_at"):
            words = A.bond_words(rel)
            sig = [words["trust"], words["romance"], words["respect"]]
            if st.get("bonds") != sig or turn - int(st.get("bonds_turn") or 0) >= 30:
                st["bonds"], st["bonds_turn"] = sig, turn
                line = f"Between you: trust {words['trust']}; romance {words['romance']}"
                line += f"; respect {words['respect']}." if words["respect"] != "fine" else "."
                if words["trust"] in ("broken", "shaken") and A.STAGES.index(rel["stage"]) >= 2:
                    line += " You are close, but right now you don't trust them: guarded, and nothing romantic until that changes."
                elif words["romance"] in ("none", "a spark"):
                    line += " It isn't romantic between you (yet): warmth, not love talk."
                out.append(line)
        told: list[str] = []
        unfair: list[str] = []
        hurts = 0

        def lines(d: dict[str, Any], who: dict[str, Any], at: datetime, zone: Any) -> None:
            told.extend(P.lines(d, at))
            u = S.unfair_line(d, who, at, zone)
            if u:
                unfair.append(u)

        self.mates._state_event(mate_id, lines)
        out += told + unfair
        doc = self.store.state_doc(mate_id)
        prefs = mate.get("prefs") or {}
        rep = echo.line(doc, " ".join(str(x or "") for x in (prefs.get("speech_style"), (prefs.get("defaults") or {}).get("speech_style"),
                                                            (mate.get("persona") or {}).get("personality"))))
        if rep and st.get("echo") != rep:
            st["echo"] = rep
            out.append(rep)
        w = self.store.state_who(mate_id)
        if S.grudge(doc, w, now) >= S.GRUDGE_SHOWN:
            since = (now - timedelta(days=30)).isoformat(timespec="seconds")
            hurts = int(self.store._db.query_one("SELECT COUNT(*) AS n FROM mate_gss_events WHERE mate_id = ? AND layer = 'episode' "
                                                 "AND kind = 'hurt' AND at >= ?", (mate_id, since))["n"])
            pat = E.pattern_line(hurts)
            if pat and st.get("pattern") != hurts:
                st["pattern"] = hurts
                out.append(pat)
        return out

    # ---- her temperament ----

    async def derive_temperament(self, mate_id: str) -> dict[str, Any]:
        """Read her temperament from her persona (a model, once; kept in her prefs, hers to edit). → what was read."""
        mate = self.store.get(mate_id)
        if mate_id in self._deriving:
            return {}
        self._deriving.add(mate_id)
        try:
            system, user = T.request(mate.get("persona") or {}, mate["name"])
            found = T.parse(await self.ask(system, user) or "")
            if found:  # (only that: whatever else was changed meanwhile stays)
                self.store.update(mate_id, {"prefs": {"temperament": found}})
                self.journal.record(mate_id, "temperament", "derived", found)
            return found
        finally:
            self._deriving.discard(mate_id)

    # ---- the State Inspector ----

    def inspect(self, mate_id: str, *, limit: int = 200, before: int | None = None) -> dict[str, Any]:
        mate = self.store.get(mate_id)
        now, tz = datetime.now(timezone.utc), self.store.tz()
        doc, w = self.store.state_doc(mate_id), self.store.state_who(mate_id)
        rel = self.store.relation_doc(mate_id) or A.new()
        view = S.view(doc, w, now, tz)
        return {"mate": {"id": mate_id, "name": mate["name"], "builtin": mate.get("builtin")},
                "state": {**view, "grudge": S.held(doc, w, now), "episodes": S.episodes(doc, now),
                          "line": S.line(S.summary(doc, w, now, tz))},
                "temperament": w["temperament"], "temperament_custom": (mate.get("prefs") or {}).get("temperament") or {},
                "bonds": {**{b: round(float(rel.get(b) or 0.0), 1) for b in A.BONDS}, "affinity": round(float(rel["affinity"]), 1),
                          "stage": rel["stage"], "words": A.bond_words(rel), "romance_open": A.romance_open(rel)},
                "promises": list(reversed(P.listed(doc))), "repeats": echo.repeats(doc),
                "journal": self.journal.recent(mate_id, limit=limit, before=before)}
