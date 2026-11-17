"""The scenario simulator (docs/geny-state-system.md, roadmap 3): a scripted conversation run through the same engine on
fresh copies — how she feels, what stays with her and the bonds, step by step and after — so tuning a temperament or a
number is measured, not guessed. Words only (no model reading): the same script always gives the same curves.

A script is a list of steps ``{after_min, say?, reply?, event?}``: ``say`` a message of theirs, ``reply`` hers (its expression
tags count), ``event`` something else they did (``ignored``: she spoke three times and they didn't answer; ``declined_call``;
``poke``). ``then_hours``: when to look again after the last step."""

from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
from typing import Any

from app.mate import affinity as A
from app.mate import state as S

START = datetime(2026, 1, 5, 20, 0, tzinfo=timezone.utc)  # (a Monday evening, nothing special about it)
MAX_STEPS, MAX_LOOKS = 60, 20


def _minutes(v: Any) -> float:
    try:
        x = float(v or 0.0)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return 0.0 if x != x else max(0.0, min(60 * 24 * 14, x))

PRESETS: dict[str, dict[str, Any]] = {
    "threat_sorry_love": {"steps": [{"after_min": 0, "say": "죽여버린다 너"}, {"after_min": 1, "say": "미안"},
                                    {"after_min": 1, "say": "사랑해"},
                                    {"after_min": 2, "say": "내가 심했어, 진짜 미안해. 다시는 안 그럴게"}],
                          "then_hours": [1, 6, 24, 48]},
    "pout_and_sweet": {"steps": [{"after_min": 0, "say": "됐어 관심 없어"}, {"after_min": 2, "say": "귀여워"}],
                       "then_hours": [1, 6]},
    "repeat_offender": {"steps": [{"after_min": 0, "say": "멍청아"}, {"after_min": 1, "say": "미안해, 내가 심했어"},
                                  {"after_min": 600, "say": "멍청아"}, {"after_min": 1, "say": "미안해, 내가 심했어"},
                                  {"after_min": 600, "say": "멍청아"}, {"after_min": 1, "say": "미안해, 내가 심했어"}],
                        "then_hours": [6, 24]},
    "left_unanswered": {"steps": [{"after_min": 0, "event": "ignored"}, {"after_min": 180, "say": "미안 이제 봤어"}],
                        "then_hours": [2, 12]},
}


def _point(doc: dict[str, Any], rel: dict[str, Any], w: dict[str, Any], at: datetime, minute: float, label: str) -> dict[str, Any]:
    lv = S.levels(doc, w, at, timezone.utc)
    s = S.summary(doc, w, at, timezone.utc)
    return {"minute": round(minute, 1), "label": label, "feelings": {e: lv[e]["v"] for e in S.EMOTIONS},
            "angry_why": S.why_for_her(lv["angry"]["why"]), "grudge": round(S.grudge(doc, w, at), 3),
            "furious": S.furious(doc, w, at, timezone.utc), "line": S.line(s),
            "bonds": {"affinity": round(rel["affinity"], 2), **{b: round(float(rel[b]), 2) for b in A.BONDS}}}


def run(w: dict[str, Any], script: dict[str, Any], *, relation: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run ``script`` for the mate ``w`` (state.who) from a fresh state; ``relation``: the relationship to start from (a copy of
    hers, else a new one at the given affinity)."""
    doc = S.new()
    rel = A.clone(relation) if relation else A.new()
    rel["enabled"], rel["paused"] = True, False
    if rel.get("started_at") is None:
        rel["started_at"] = A._iso(START - timedelta(days=1))
    # (her own day and what she has on are left out: the same script always gives the same curves)
    w = {**copy.deepcopy(w), "closeness": float(rel["affinity"]) / 100, "life": None, "outfit": None}
    at, minute, points = START, 0.0, []
    steps = script.get("steps") if isinstance(script.get("steps"), list) else []
    steps = [s for s in steps if isinstance(s, dict)][:MAX_STEPS]
    for i, step in enumerate(steps):
        gap = _minutes(step.get("after_min"))
        at, minute = at + timedelta(minutes=gap), minute + gap
        A.advance(rel, at, timezone.utc)
        said = str(step.get("say") or "").strip()
        reply = str(step.get("reply") or "")
        event = step.get("event")
        if event == "ignored":
            for k in range(3):
                S.spoke(doc, "저기…?", at - timedelta(minutes=3 - k))
            label = "(she spoke three times, no answer)"
        elif event == "declined_call":
            S.call_unanswered(doc, w, True, 1, at, timezone.utc)
            label = "(they turned her call down)"
        elif event == "poke":
            for _ in range(S.POKE_TOO_MANY):
                S.poked(doc, w, at, timezone.utc)
            label = "(poked again and again)"
        else:
            label = said or "(nothing)"
        if said:
            S.hear(doc, w, said, f"sim{i}", at, timezone.utc)
            S.reply(doc, w, reply, said, at, timezone.utc)
            A.credit_turn(rel, at, timezone.utc, said, reply, w.get("name") or "")
        for owed in S.take_owed(doc):
            A.cost(rel, owed["code"], at, timezone.utc)
        points.append(_point(doc, rel, w, at, minute, label))
    looks = script.get("then_hours") if isinstance(script.get("then_hours"), list) else []
    hours = sorted({float(x) for x in looks if isinstance(x, (int, float)) and not isinstance(x, bool) and 0 < x <= 24 * 30})
    for h in hours[:MAX_LOOKS]:
        t = at + timedelta(hours=h)
        A.advance(rel, t, timezone.utc)
        points.append(_point(doc, rel, w, t, minute + h * 60, f"+{h:g} h"))
    return {"points": points}
