"""Chats cut off by something outside them go on by themselves (docs/resume.md).

Two things cut a running chat off that are nobody's choice: the server goes away under it (a deploy, a reboot, a crash,
a power cut — every engine and its background processes die with it) and the connection to the model drops (the
engine gives up on its retries and the turn ends in a connection error). Either way the agent was in the middle of
something the user asked for; it should carry on once it can, not wait for someone to notice and type "continue".

**The journal** (table ``turn_journal``): a turn writes its row when it starts and deletes it when it ends on its own
(done, stopped by the user, failed for a reason a retry won't fix). A clean shutdown marks the rows of the turns it cut
"interrupted"; a crash or a power cut leaves them "running" — which, found at startup, says the same. A running turn
refreshes its row now and then (``beat``), so how long ago it was cut off is known even after a crash.

**At startup** (``SessionService.start_resumer``): every row left — and, for turns from before the journal, a chat
whose last turn started lately and never ended — is continued once the model can be reached: the conversation is
resumed (the engine's own session: everything up to the cut is there) with a note saying what happened and that the
processes it had started are gone. **On a connection error** the same, after a growing pause.

Never forever: a chain of automatic continues stops after a few (a turn that itself brings the server down must not
do it again and again), the user's own message takes over at any time, and a turn cut off too long ago is left as it
was (the chat shows it stopped, with its Continue button).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any

from app.db import Database

# how many automatic continues one chain gets, by why it stopped
MAX_ATTEMPTS = {"restart": 3, "network": 4, "engine": 2}
# the pause before each (seconds), by why — a restart goes on once the model is reachable
BACKOFF = {"restart": [0, 20, 60], "network": [15, 45, 120, 300], "engine": [10, 60]}
# a turn cut off longer ago than this is left as it was (the user may have moved on)
WINDOW_S = 12 * 3600
# how long to wait for the model to be reachable again before giving up on a continue
ONLINE_WAIT_S = 30 * 60

SCHEMA = """
CREATE TABLE IF NOT EXISTS turn_journal (
    session_id  TEXT PRIMARY KEY,
    trigger     TEXT NOT NULL,              -- turn (the user's) | auto (the engine's own) | resume (one of these)
    status      TEXT NOT NULL,              -- running | interrupted
    reason      TEXT,                       -- restart | network | engine (why it was cut off)
    attempts    INTEGER NOT NULL DEFAULT 0, -- automatic continues of this chain so far
    chain_at    TEXT NOT NULL,              -- when the chain's first turn started
    started_at  TEXT NOT NULL,              -- when this turn started
    beat_at     TEXT NOT NULL,              -- last sign of life
    provider    TEXT,
    request     TEXT,                       -- what the user asked (the start of it)
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _age_s(iso: str | None) -> float:
    try:
        return time.time() - datetime.fromisoformat(str(iso)).timestamp()
    except (TypeError, ValueError):
        return float("inf")


class TurnJournal:
    """Which turns are running (durable: it outlives the process)."""

    BEAT_S = 60.0

    def __init__(self, db: Database) -> None:
        self._db = db
        self._beats: dict[str, float] = {}
        db.execute(SCHEMA.strip())

    def begin(self, sid: str, *, trigger: str, provider: str | None, request: str = "", attempt: int = 0) -> None:
        """A turn starts. The user's own turn starts a new chain; a continue (``attempt`` n) and the engine's own turn
        keep the chain's start and what was asked."""
        now = _now()
        old = self.get(sid)
        if trigger == "turn" or old is None:
            chain_at, req, attempts = now, request[:2000], (attempt if trigger == "resume" else 0)
        else:
            chain_at, req = old["chain_at"], old.get("request") or request[:2000]
            attempts = attempt if trigger == "resume" else int(old.get("attempts") or 0)
        self._db.execute(
            "INSERT OR REPLACE INTO turn_journal (session_id, trigger, status, reason, attempts, chain_at, started_at,"
            " beat_at, provider, request) VALUES (?, ?, 'running', NULL, ?, ?, ?, ?, ?, ?)",
            (sid, trigger, attempts, chain_at, now, now, provider, req),
        )
        self._beats[sid] = time.monotonic()

    def beat(self, sid: str) -> None:
        """Still running (throttled: at most once a minute)."""
        last = self._beats.get(sid, 0.0)
        if time.monotonic() - last < self.BEAT_S:
            return
        self._beats[sid] = time.monotonic()
        self._db.execute("UPDATE turn_journal SET beat_at = ? WHERE session_id = ? AND status = 'running'", (_now(), sid))

    def interrupt(self, sid: str, reason: str) -> None:
        """Cut off from outside (``reason``: restart | network | engine): to be continued."""
        self._beats.pop(sid, None)
        self._db.execute("UPDATE turn_journal SET status = 'interrupted', reason = ?, beat_at = ? WHERE session_id = ?",
                         (reason, _now(), sid))

    def end(self, sid: str) -> None:
        """Ended on its own (done, stopped, failed for good): nothing to continue."""
        self._beats.pop(sid, None)
        self._db.execute("DELETE FROM turn_journal WHERE session_id = ?", (sid,))

    def get(self, sid: str) -> dict[str, Any] | None:
        row = self._db.query_one("SELECT * FROM turn_journal WHERE session_id = ?", (sid,))
        return dict(row) if row is not None else None

    def all(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self._db.query("SELECT * FROM turn_journal ORDER BY beat_at")]


# ---- why a turn ended: a cut a continue can mend, or not

# A connection that dropped or a service that was briefly down — not a key, a limit or a bill (those don't mend by
# waiting a minute, and an account that hit its limit is moved off by the pool's failover already).
_NETWORK = re.compile(
    r"(?i)connection error|connection (?:reset|refused|closed|lost|aborted)|ECONNRESET|ECONNREFUSED|ECONNABORTED|"
    r"ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang ?up|fetch failed|network ?error|"
    r"getaddrinfo|request timed out|timed out|timeout|overloaded|server error|service unavailable|bad gateway|"
    r"gateway time|upstream|\b(?:500|502|503|504|529)\b|stream (?:closed|ended) unexpectedly|other side closed")
_NOT_TRANSIENT = re.compile(
    r"(?i)authenticat|unauthori[sz]ed|forbidden|invalid (?:api|x-api)|api key|log ?in|sign ?in|credit|billing|"
    r"usage limit|rate.?limit|quota|context (?:window|length)|too long|prompt is too long|max_tokens|"
    r"attention required|cloudflare|permission|not allowed|policy")
_TRANSIENT_STATUS = {500, 502, 503, 504, 529}
_TRANSIENT_KINDS = {"overloaded_error", "api_error", "timeout_error", "connection_error"}


def cut_reason(err: dict[str, Any] | None) -> str | None:
    """How a failed turn's error event (``data``) was cut off: "network" (the model couldn't be reached / was briefly
    down), "engine" (the agent's process died under it), or None — a stop, or a failure waiting won't mend."""
    if not err:
        return None
    code = str(err.get("code") or "")
    msg = str(err.get("message") or "")
    if code in ("turn.interrupted", "turn.busy", "account.unavailable", "attachment.invalid", "session.not_found") \
            or code.startswith("exec.workspace") or code in ("exec.cli.error_max_turns",):
        return None
    if _NOT_TRANSIENT.search(msg):
        return None
    api = err.get("api_error") if isinstance(err.get("api_error"), dict) else {}
    try:
        status = int(api.get("status") or 0)
    except (TypeError, ValueError):
        status = 0
    if status in _TRANSIENT_STATUS or str(api.get("kind") or "") in _TRANSIENT_KINDS:
        return "network"
    if status in (400, 401, 403, 404, 413, 429):
        return None
    if code == "exec.cli.exited":
        # the engine died: the network if it says so, else the process itself (a crash, killed for its memory)
        return "network" if _NETWORK.search(msg) else "engine"
    if code == "exec.cli.timeout":
        # the engine stopped answering: a hang of its own as often as the network (2026-11-19's Codex timeouts were a
        # bug) — the engine's few tries, not the network's
        return "engine"
    if code in ("exec.cli.api_error", "exec.cli.error_during_execution", "exec.cli.codex_error", "exec.cli.timeout",
                "exec.turn.crashed", "harness.error", "exec.api.error") or code.startswith(("exec.cli.", "exec.api.")):
        return "network" if _NETWORK.search(msg) else None
    return None


# ---- what the agent is told when it goes on

_SAID = {
    "restart": (
        "The server running this chat restarted while you were working, so your last turn was cut off part-way. "
        "Everything you did until then is still in this conversation, but whatever was running at that moment has "
        "stopped with it: background commands, servers you started, watchers, sub-agents, any shell state."),
    "network": (
        "Your last turn was cut off because the connection to the model dropped{detail}. It is back now."),
    "engine": (
        "Your last turn was cut off because the agent process stopped unexpectedly{detail}; whatever it was running "
        "(background commands, sub-agents) stopped with it."),
}


def continue_prompt(reason: str, *, attempt: int, detail: str = "") -> str:
    """The message a continue sends the engine (shown in the chat as a line saying it went on by itself, not as
    something the user typed)."""
    said = _SAID.get(reason, _SAID["restart"]).format(detail=f" ({detail[:200]})" if detail else "")
    return (
        f"[My Mate Geny — automatic continue {attempt}/{MAX_ATTEMPTS.get(reason, 3)}; the user did not type this] "
        f"{said} Check what actually got done first (files, outputs, logs, the state of what you were changing) "
        "rather than assuming, restart whatever is still needed, and carry on with the user's request from where you "
        "left off. If it had already finished, just give the result. Don't apologise at length; say briefly that you "
        "are picking up where you left off."
    )


# ---- is the model reachable

def _hosts(provider: str) -> list[tuple[str, int]]:
    """Where to knock: the provider's API (through the proxy when there is one)."""
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy:
        u = urllib.parse.urlsplit(proxy if "://" in proxy else f"http://{proxy}")
        if u.hostname:
            return [(u.hostname, u.port or (443 if u.scheme == "https" else 80))]
    if provider in ("codex", "openai"):
        return [("chatgpt.com", 443), ("api.openai.com", 443)]
    if provider in ("gemini", "google"):
        return [("generativelanguage.googleapis.com", 443)]
    return [("api.anthropic.com", 443), ("api.openai.com", 443)]


async def reachable(provider: str, timeout: float = 6.0) -> bool:
    for host, port in _hosts(provider):
        try:
            _, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
            w.close()
            return True
        except (OSError, TimeoutError):
            continue
    return False


async def wait_reachable(provider: str, *, limit_s: float = ONLINE_WAIT_S, on_wait: Any = None) -> bool:
    """Until the model can be reached (True), or ``limit_s`` passed (False). ``on_wait()``: called once, when the
    first knock fails."""
    deadline = time.monotonic() + limit_s
    pause, told = 10.0, False
    while True:
        if await reachable(provider):
            return True
        if not told and on_wait is not None:
            told = True
            on_wait()
        if time.monotonic() + pause > deadline:
            return False
        await asyncio.sleep(pause)
        pause = min(pause * 2, 60.0)


def orphan_turns(db: Database, *, within_s: float = 6 * 3600) -> list[dict[str, Any]]:
    """Chats whose last turn has no end and was alive lately — cut off before the journal existed (or without a row of
    its own): ``[{session_id, started_at, last_at}]``."""
    since = datetime.fromtimestamp(time.time() - within_s, timezone.utc).isoformat()
    rows = db.query(
        "SELECT s.id AS sid, (SELECT MAX(id) FROM events e WHERE e.session_id = s.id AND e.type = 'session.start') AS start_id"
        " FROM sessions s WHERE COALESCE(s.kind, 'chat') = 'chat' AND s.updated_at >= ?",
        (since,),
    )
    out = []
    for r in rows:
        if not r["start_id"]:
            continue
        start = db.query_one("SELECT created_at FROM events WHERE id = ?", (r["start_id"],))
        if start is None:
            continue
        ended = db.query_one(
            "SELECT 1 FROM events WHERE session_id = ? AND id > ? AND type IN ('turn.complete', 'error') LIMIT 1",
            (r["sid"], r["start_id"]),
        )
        if ended is not None:
            continue
        # (alive lately — a turn can work for hours: its last sign of life, not its start)
        last = db.query_one("SELECT MAX(created_at) AS at FROM events WHERE session_id = ?", (r["sid"],))
        if last is None or not last["at"] or last["at"] < since:
            continue
        out.append({"session_id": r["sid"], "started_at": start["created_at"], "last_at": last["at"]})
    return out


def as_json(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)
