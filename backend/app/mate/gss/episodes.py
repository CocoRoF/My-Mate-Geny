"""What she remembers of the two of them (docs/geny-state-system.md, roadmap 5): the moments that matter between them
become memories in her own words — a hurt that stung, making up, a promise kept or broken, romance becoming mutual, trust
broken — so she can bring them up weeks later and see a pattern. Pure: the text of a memory; the service saves it
(``source="gss"``: never counted as a new memory for the relationship)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.mate.josa import josa

DONE_KO = {"violence": "나를 때렸다", "coercion": "내게 억지로 강요했다", "threat": "나를 위협했다",
           "demeaning": "나를 깔보고 모욕했다"}
DONE_EN = {"violence": "they hit me", "coercion": "they forced something on me", "threat": "they threatened me",
           "demeaning": "they put me down"}


def _day(at: datetime, lang: str) -> str:
    return f"{at.month}월 {at.day}일" if lang == "ko" else at.strftime("%b %-d")


def _who_ko(user: str) -> str:
    return josa(user, "이") if user else "그 사람이"


def text(kind: str, data: dict[str, Any], at: datetime, lang: str, user: str = "") -> str:
    """One memory, in her voice and the conversation's language (``lang``: ko | en)."""
    ko = lang == "ko"
    quote = " ".join(str(data.get("quote") or "").split())[:60]
    q = f" (“{quote}”)" if quote else ""
    day = _day(at, lang)
    if kind == "hurt":
        what = data.get("kind")
        if ko:
            done = DONE_KO.get(str(what), "내게 상처 주는 말을 했다")
            return f"[우리 사이] {day}, {_who_ko(user)} {done}{q}."
        return f"[between us] On {day}, {DONE_EN.get(str(what), 'they said something that hurt me')}{q}."
    if kind == "made_up":
        return (f"[우리 사이] {day}, 그 일로 진심으로 사과를 받았고 이제는 풀렸다{q}." if ko else
                f"[between us] On {day}, they truly apologised for it and we made up{q}.")
    if kind == "promise_kept":
        return f"[우리 사이] {day}, 약속을 지켰다: “{data.get('what')}”." if ko else f"[between us] On {day}, they kept their word: “{data.get('what')}”."
    if kind == "promise_broken":
        return (f"[우리 사이] {day}, 약속을 지키지 않았다: “{data.get('what')}”." if ko else
                f"[between us] On {day}, they didn't keep their word: “{data.get('what')}”.")
    if kind == "romance":
        return f"[우리 사이] {day}, 서로 마음이 통한다는 걸 알았다." if ko else f"[between us] On {day}, I knew we felt the same way."
    if kind == "trust_broken":
        return (f"[우리 사이] {day}, 더는 예전처럼 믿을 수가 없게 됐다." if ko else
                f"[between us] On {day}, I stopped trusting them the way I did.")
    return ""


def pattern_line(hurts: int) -> str:
    """How often it happened lately, for her context next to what is still with her."""
    if hurts < 2:
        return ""
    return f"This isn't the first time: {hurts} times like it in the last month."
