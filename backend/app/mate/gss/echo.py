"""Not repeating herself (docs/geny-state-system.md, roadmap 2): a person doesn't say the same line, act out the same stage
direction or give the same telling-off twice in a row. Her last replies are kept, small (``doc["said"]``); when one of her
lines or stage directions shows up again, she is told, before her next reply, what she has already said."""

from __future__ import annotations

import re
from typing import Any

KEEP, LINES = 8, 12
_TAG = re.compile(r"\[[^\]\n]{1,40}\]")
_STAGE = re.compile(r"\(([^()\n]{6,160})\)|\*([^*\n]{6,160})\*")
_SPLIT = re.compile(r"(?<=[.!?。！？~…])\s+|\n+")


def _norm(s: str) -> str:
    return re.sub(r"[\s.,!?~…·'\"“”‘’()*\-]+", "", s).lower()


def parts(text: str) -> dict[str, list[str]]:
    """Her reply's stage directions and her lines (expression tags out)."""
    text = _TAG.sub("", text or "")
    stages = [" ".join((a or b).split()) for a, b in _STAGE.findall(text)]
    body = _STAGE.sub(" ", text)
    lines = [" ".join(x.split()) for x in _SPLIT.split(body) if len(_norm(x)) >= 6]
    return {"stage": stages[:4], "lines": lines[:LINES]}


def note(doc: dict[str, Any], text: str) -> None:
    """She replied: kept, the oldest out."""
    p = parts(text)
    if p["stage"] or p["lines"]:
        doc["said"] = [*(doc.get("said") or []), p][-KEEP:]


def repeats(doc: dict[str, Any]) -> list[str]:
    """What she said or acted out more than once lately, as she wrote it (the newest wording), stage directions first."""
    seen: dict[str, tuple[int, str, bool]] = {}
    for reply in doc.get("said") or []:
        for kind in ("stage", "lines"):
            for x in set(reply.get(kind) or []):
                k = _norm(x)
                if len(k) < 6:
                    continue
                n, _w, _s = seen.get(k, (0, x, kind == "stage"))
                seen[k] = (n + 1, x, kind == "stage")
    again = [(stage, x) for n, x, stage in seen.values() if n >= 2]
    return [x for _s, x in sorted(again, key=lambda e: not e[0])][:5]


def line(doc: dict[str, Any]) -> str:
    rep = repeats(doc)
    if not rep:
        return ""
    return ("You have already said or acted these out more than once lately — say something new, in other words: "
            + " / ".join(f"“{x[:100]}”" for x in rep))
