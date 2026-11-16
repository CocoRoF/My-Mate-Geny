"""Reading a message the way she would (docs/geny-state-system.md, roadmap 1): a small, fast model says what the user's
message does to her — aimed at her or not, what it is (an insult, a threat, an apology that owns what they did, affection,
venting about someone else …), how strong, whether it is sarcastic — and what was promised. The words' patterns
(app/mate/affinity.py, state.py) stay as the first guess and the fallback; her reply's face still has the last word.

When the fast way is there (an Anthropic API key: the pool's, or the Claude provider's) it is waited for briefly before she
answers. Otherwise a Claude Code one-shot reads it on the side, for messages worth a look, and what it finds counts when the
turn ends (``state.reappraise``, the relationship) and for what comes after. Nothing here ever blocks a turn for long."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

ACTS = ("insult", "threat", "violence", "coercion", "demeaning", "dismissal", "apology", "affection", "flirt", "compliment",
        "gratitude", "teasing", "joke", "venting", "distress", "request", "promise", "neutral")
HOSTILE_ACTS = ("violence", "coercion", "threat", "demeaning")  # (the order: the worst first, as affinity.hostile)
MODEL = "claude-haiku-5-5"
WAIT_FAST_S = 2.0      # how long her turn waits for the fast reading
CACHE = 400

SYSTEM = """\
You read one message a user sent to {name}, a character in a one-to-one story they share, and say what it does to her. \
You are not {name} and you don't answer the user: you only read. Return one JSON object and nothing else:
{{"aimed_at_her": true|false, "acts": [...], "intensity": 0.0-1.0, "owns_it": true|false, "sarcastic": true|false,
 "promise": null | {{"what": "...", "due_in_hours": number|null, "kind": "contact"|"task"|"other"}},
 "her_promise": null | {{"what": "...", "due_in_hours": number|null}},
 "fulfills": ["promise ids"], "note": "a few words why"}}
- acts: any of {acts}. Only what the words do to HER: venting about a boss, a friend's story, a monster in a game, a quote, \
or a scene they describe is not aimed at her ("venting", "neutral"). Acted out in (parentheses) or *asterisks*, it is done to her.
- Between people who are close, playful teasing is "teasing", not an insult, unless it is plainly meant to hurt; \
sarcasm that puts her down is an "insult" with "sarcastic": true.
- "apology": they say sorry. "owns_it": the apology names what they did, says they were wrong, or that they won't do it \
again — a bare "sorry"/"미안" doesn't.
- "affection": love, missing her, caring for her; "flirt": romantic play; "compliment": about her looks or what she did; \
"gratitude": thanks.
- intensity: how strongly it lands on her, 0 (nothing) to 1 (as bad or as sweet as it gets).
- promise: something concrete the user commits to doing ("I'll call you tonight", "내일 또 올게", "이따 파일 보내줄게"), \
with when it is due from now in hours if they said or implied it (tonight ≈ until midnight; tomorrow ≈ 24), "contact" when \
it is about talking or calling her again. her_promise: the same for a promise {name} made in her last reply, if any.
- fulfills: ids of the open promises below that this message keeps (they did what they said).
Their language may be Korean or English; read it as a native speaker would."""


def _clip(s: str, n: int) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def request(name: str, text: str, recent: list[str], promises: list[dict[str, Any]]) -> tuple[str, str]:
    """(system, user) for one reading."""
    lines = []
    if recent:
        lines.append("The conversation just before (oldest first):\n" + "\n".join(recent[-6:]))
    if promises:
        lines.append("Open promises:\n" + "\n".join(f"- [{p['id']}] {p['who']}: {_clip(p['what'], 120)}" for p in promises[:8]))
    lines.append(f"The message to read:\n{_clip(text, 1500)}")
    return SYSTEM.format(name=name or "the character", acts=", ".join(ACTS)), "\n\n".join(lines)


_JSON = re.compile(r"\{.*\}", re.S)


def parse(raw: str) -> dict[str, Any] | None:
    """The model's answer → a clean reading (None when it isn't one)."""
    m = _JSON.search(raw or "")
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except ValueError:
        return None
    if not isinstance(d, dict):
        return None
    acts = [a for a in d.get("acts") or [] if isinstance(a, str) and a in ACTS]
    try:
        intensity = max(0.0, min(1.0, float(d.get("intensity") or 0.0)))
    except (TypeError, ValueError):
        intensity = 0.0

    def promise(p: Any, kinds: bool) -> dict[str, Any] | None:
        if not isinstance(p, dict) or not str(p.get("what") or "").strip():
            return None
        try:
            due = float(p["due_in_hours"]) if p.get("due_in_hours") is not None else None
        except (TypeError, ValueError):
            due = None
        out = {"what": _clip(p["what"], 160), "due_in_hours": None if due is None else max(0.25, min(24 * 30, due))}
        if kinds:
            out["kind"] = p.get("kind") if p.get("kind") in ("contact", "task", "other") else "other"
        return out

    return {"aimed": bool(d.get("aimed_at_her")), "acts": acts, "intensity": round(intensity, 2), "owns": bool(d.get("owns_it")),
            "sarcastic": bool(d.get("sarcastic")), "promise": promise(d.get("promise"), True),
            "her_promise": promise(d.get("her_promise"), False),
            "fulfills": [str(x) for x in d.get("fulfills") or [] if isinstance(x, (str, int))][:8],
            "note": _clip(d.get("note") or "", 160), "by": "model"}


def cues(reading: dict[str, Any] | None) -> dict[str, Any] | None:
    """What a reading means for how she feels and for the relationship, in the words' cues' shape (affinity.cues):
    {hostile: kind | None, rude, dismissed, apology, owned, warm, love, looks, flirt, distress}. None without a reading."""
    if not reading:
        return None
    acts, aimed, strong = set(reading.get("acts") or []), bool(reading.get("aimed")), float(reading.get("intensity") or 0.0)
    hostile = next((k for k in HOSTILE_ACTS if k in acts), None) if aimed else None
    if hostile == "demeaning" and strong < 0.35:  # (a light put-down is a rude word, not something done to her)
        hostile = None
    rude = aimed and (hostile is not None or "insult" in acts or bool("demeaning" in acts and hostile is None)
                      or (reading.get("sarcastic") and strong >= 0.3))
    kind = not rude
    return {"hostile": hostile, "rude": bool(rude), "dismissed": aimed and "dismissal" in acts, "apology": "apology" in acts,
            "owned": "apology" in acts and bool(reading.get("owns")), "warm": kind and bool(acts & {"gratitude", "affection", "compliment"}),
            "love": kind and bool(acts & {"affection", "flirt"}), "looks": kind and "compliment" in acts, "flirt": kind and "flirt" in acts,
            "distress": "distress" in acts and not hostile, "intensity": strong}


def worth_a_look(text: str, words: dict[str, Any], open_things: bool) -> bool:
    """For the slow way only: a message the words found something in, one said while something is open between them (a
    grudge, her anger, a promise), or one that may promise something. Small talk goes by the words alone."""
    if open_things or any(words.get(k) for k in ("hostile", "rude", "warm", "pos")):
        return True
    return bool(re.search(r"미안|죄송|사과|할게|갈게|줄게|올게|볼게|약속|사랑|좋아해|보고 ?싶|됐어|됐고|귀찮|"
                          r"\bsorry\b|\bi'?ll\b|\bpromise\b|\blove\b|\bwhatever\b", text or "", re.I))


class Appraiser:
    """Readings by message id (kept for a while; a turn and its end ask for the same one). ``fast_key()`` → an API key and
    what to call when done, or None; ``slow(system, user)`` → the raw answer of a Claude Code one-shot (or None)."""

    def __init__(self, fast_key: Callable[[], Any], slow: Callable[[str, str], Any] | None = None) -> None:
        self._fast_key, self._slow = fast_key, slow
        self._tasks: dict[str, asyncio.Task] = {}
        self._done: dict[str, dict[str, Any]] = {}
        self.on_read: Callable[[str, str, dict[str, Any]], None] | None = None  # (mate id, message id, reading)

    def get(self, message_id: str) -> dict[str, Any] | None:
        return self._done.get(message_id)

    def put(self, message_id: str, reading: dict[str, Any]) -> None:
        self._done[message_id] = reading
        while len(self._done) > CACHE:
            self._done.pop(next(iter(self._done)))

    async def read(self, mate_id: str, message_id: str, name: str, text: str, recent: list[str], promises: list[dict[str, Any]],
                   *, words: dict[str, Any], open_things: bool) -> dict[str, Any] | None:
        """Start reading a message (once), and wait for it briefly when the fast way is there. → the reading, if it came."""
        if message_id in self._done:
            return self._done[message_id]
        task = self._tasks.get(message_id)
        fast = None
        if task is None:
            fast = await asyncio.to_thread(self._fast_key)
            if fast is None and (self._slow is None or not worth_a_look(text, words, open_things)):
                return None
            system, user = request(name, text, recent, promises)
            task = asyncio.create_task(self._run(mate_id, message_id, system, user, fast))
            self._tasks[message_id] = task
        if fast is None:
            return None  # (the slow way: it counts when the turn ends)
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=WAIT_FAST_S)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001 - a reading that didn't come in time: the words go on alone
            return None

    async def settle(self, message_id: str, timeout: float = 0.0) -> dict[str, Any] | None:
        """The reading of a message, if it came (waiting at most ``timeout``)."""
        if message_id in self._done or timeout <= 0 or message_id not in self._tasks:
            return self._done.get(message_id)
        try:
            return await asyncio.wait_for(asyncio.shield(self._tasks[message_id]), timeout=timeout)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001
            return None

    async def _run(self, mate_id: str, message_id: str, system: str, user: str, fast: Any) -> dict[str, Any] | None:
        try:
            raw = await (self._ask_api(fast, system, user) if fast is not None else self._slow(system, user))
            reading = parse(raw or "")
            if reading is not None:
                self.put(message_id, reading)
                if self.on_read is not None:
                    self.on_read(mate_id, message_id, reading)
            return reading
        except Exception:  # noqa: BLE001 - no reading: the words' guess stands
            return None
        finally:
            self._tasks.pop(message_id, None)

    @staticmethod
    async def _ask_api(fast: Any, system: str, user: str) -> str:
        from app.harness.llm.anthropic_api import _client

        key, release = fast
        try:
            msg = await _client(key).messages.create(model=MODEL, max_tokens=400, system=system,
                                                     messages=[{"role": "user", "content": user}])
            return "".join(getattr(b, "text", "") for b in msg.content)
        finally:
            if release is not None:
                release()


def due_at(reading_promise: dict[str, Any] | None, now: datetime) -> str | None:
    if not reading_promise or reading_promise.get("due_in_hours") is None:
        return None
    return (now + timedelta(hours=float(reading_promise["due_in_hours"]))).astimezone(timezone.utc).isoformat(timespec="seconds")
