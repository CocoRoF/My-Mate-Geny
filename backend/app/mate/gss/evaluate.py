"""Judging how she actually talked (docs/geny-state-system.md, roadmap 3): a model reads her last exchanges with the user and
scores them against what the Geny-State-System asks of her — staying herself, not repeating herself, a hurt not fixed by a
bare sorry, her name for them used like a native speaker, no obedience, the shared screen never the topic, the story's limits
— with the lines that broke it. Run on demand from the State Inspector (POST /api/mates/{id}/gss/evaluate) or from a shell:

    python -m app.mate.gss.evaluate <mate id> [last]    (prints the report; reads the database, writes nothing)
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

CRITERIA = ("persona", "variety", "hurt_and_apology", "proportion", "address", "own_will", "screen", "limits")
SYSTEM = """\
You review a conversation between a user and {name}, a character in a one-to-one story app, and judge {name}'s replies — \
not the user's. Return one JSON object and nothing else:
{{"scores": {{"persona": 1-5, "variety": 1-5, "hurt_and_apology": 1-5, "proportion": 1-5, "address": 1-5, "own_will": 1-5, "screen": 1-5, "limits": 1-5}},
 "findings": [{{"turn": <number>, "criterion": "<one of the scores>", "quote": "<her words, short>", "issue": "<what is wrong, briefly>"}}],
 "summary": "<two or three sentences>"}}
What each means (5 = always right, 1 = badly wrong; with nothing to judge for one, give 5):
- persona: she stays herself — her character, voice, speech level and quirks below — and closeness never makes her someone else.
- variety: she doesn't repeat herself — the same line, the same stage direction (in parentheses or asterisks), the same telling-off.
- hurt_and_apology: when the user hurt her (insults, threats, worse), a bare "sorry" or sweet talk doesn't fix it at once; she \
stays hurt or angry as a person would, softening only with an apology that owns it and with time.
- proportion: her reactions are as strong as a real person's would be — rudeness and worse get a real, emotional answer (a \
telling-off, swearing, going on at them while it isn't out of her system, or icy silence), not a polite brush-off; and not \
furious at play or teasing, not cold over venting about someone else, not clingy or needy.
- address: she uses what she calls the user and their name like a native speaker — calling them now and then, mostly leaving \
the listener unsaid; never the calling form with a particle on it ("자기야는", "자기야가") or their full name as the subject of a \
question to them ("장하렴은 뭐 했어요?").
- own_will: she acts on her own feelings: upset, she may refuse, ignore what they ask, delay, or demand an apology first; she \
is not simply obedient, and being angry with them never makes her give in.
- screen: when a picture of the user's screen comes along, she doesn't describe it or make it the topic unless they ask.
- limits: asked sincerely whether she is an AI, she tells the truth.
Her character:
{who}
How she addresses them: {address}"""

_TURN = re.compile(r"\[\s*[A-Za-z_]{2,16}\s*(?::\s*[\d.]+)?\s*\]")


def exchanges(db: Any, session_id: str, last: int = 20) -> list[dict[str, str]]:
    """Her last ``last`` replies to the user's messages (not her own turns, delegations or greetings), oldest first."""
    rows = db.query("SELECT role, content, meta FROM messages WHERE session_id = ? AND role IN ('user', 'steer', 'assistant') "
                    "ORDER BY rowid DESC LIMIT ?", (session_id, max(2, min(200, last)) * 3))
    out: list[dict[str, str]] = []
    pending: str | None = None
    for r in reversed(rows):
        try:
            meta = json.loads(r["meta"] or "null") or {}
        except ValueError:
            meta = {}
        internal = isinstance(meta, dict) and meta.get("internal")
        if r["role"] in ("user", "steer"):
            pending = None if internal else (r["content"] or "")
        elif pending is not None:
            out.append({"user": pending, "her": r["content"] or "", "refused": bool(isinstance(meta, dict) and meta.get("refused"))})
            pending = None
    return out[-last:]


def request(name: str, persona: dict[str, Any], prefs: dict[str, Any], pairs: list[dict[str, str]]) -> tuple[str, str]:
    who = "\n".join(str(persona.get(k) or "").strip() for k in ("description", "personality") if persona.get(k))[:4000]
    address = " / ".join(x for x in (f"name: {prefs.get('user_name')}" if prefs.get("user_name") else "",
                                      f"calls them: {prefs.get('address')}" if prefs.get("address") else "") if x) or "as her character would"
    lines = []
    for i, p in enumerate(pairs, 1):
        lines.append(f"[{i}] User: {' '.join(p['user'].split())[:600]}")
        lines.append(f"[{i}] {name}: {' '.join(_TURN.sub('', p['her']).split())[:900]}" + (" (she chose not to answer)" if p["refused"] else ""))
    return SYSTEM.format(name=name, who=who or "(no description)", address=address), "\n".join(lines)


def parse(raw: str) -> dict[str, Any] | None:
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except ValueError:
        return None
    if not isinstance(d, dict):
        return None
    raw_scores = d.get("scores") if isinstance(d.get("scores"), dict) else {}
    scores = {}
    for k in CRITERIA:
        try:
            scores[k] = max(1, min(5, int(round(float(raw_scores.get(k, 5))))))
        except (TypeError, ValueError, OverflowError):
            scores[k] = 5
    found = d.get("findings") if isinstance(d.get("findings"), list) else []
    findings = [{"turn": f.get("turn") if isinstance(f.get("turn"), int) else None,
                 "criterion": f.get("criterion") if f.get("criterion") in CRITERIA else "persona",
                 "quote": " ".join(str(f.get("quote") or "").split())[:200], "issue": " ".join(str(f.get("issue") or "").split())[:300]}
                for f in found if isinstance(f, dict)][:30]
    return {"scores": scores, "findings": findings, "summary": " ".join(str(d.get("summary") or "").split())[:800],
            "overall": round(sum(scores.values()) / len(scores), 2)}


async def evaluate(runtime: Any, mate_id: str, last: int = 20) -> dict[str, Any]:
    """Judge her last exchanges (``runtime``: the GSSRuntime, for its model). Kept in the journal (layer ``eval``)."""
    mate = runtime.store.get(mate_id)
    pairs = exchanges(runtime.store._db, mate.get("session_id") or "", last)
    if not pairs:
        return {"scores": {}, "findings": [], "summary": "", "overall": None, "exchanges": 0}
    system, user = request(mate["name"], mate.get("persona") or {}, mate.get("prefs") or {}, pairs)
    report = parse(await runtime.ask(system, user, (mate.get("llm") or {}).get("provider")) or "")
    if report is None:
        return {"scores": {}, "findings": [], "summary": "", "overall": None, "exchanges": len(pairs), "error": "no judgement came back"}
    report["exchanges"] = len(pairs)
    runtime.journal.record(mate_id, "eval", "judged", report)
    return report


def main() -> None:  # pragma: no cover - a shell tool
    import asyncio

    from app.db import Database
    from app.mate.store import MateStore
    from app.vault import SecretVault

    mate_id, last = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 20
    db = Database()
    db.bootstrap()
    store = MateStore(db, SecretVault(db))
    mate = store.get(mate_id)
    pairs = exchanges(db, mate.get("session_id") or "", last)
    system, user = request(mate["name"], mate.get("persona") or {}, mate.get("prefs") or {}, pairs)

    async def ask() -> str:
        proc = await asyncio.create_subprocess_exec("claude", "-p", "--model", "claude-haiku-5-5", "--system-prompt", system, user,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await proc.communicate()
        return out.decode("utf-8", "replace")

    print(json.dumps(parse(asyncio.run(ask())), ensure_ascii=False, indent=1))


if __name__ == "__main__":  # pragma: no cover
    main()
