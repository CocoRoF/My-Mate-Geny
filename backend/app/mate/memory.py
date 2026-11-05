"""A mate's memory: kinds, the core it always knows, what it recalls per turn
(docs/mate-memory-affinity.md §4). Pure functions — the store keeps the rows,
the service builds the prompt and the per-turn context block from these.

* **Tokens** (no dependency, Korean + English): NFKC + lower case; Latin words
  (stopwords out, a plural / -ed / -ing end cut), Hangul runs as a *stem* (one
  trailing particle or ending cut) plus their character bigrams (치과예약 and
  치과 예약 still meet), Han/kana bigrams, numbers.
* **Recall**: BM25 relevance + importance + recency + use + a boost for plans
  that are due soon and fresh short-term context. No lexical match, no recall —
  except plans due within 48 h, which are always offered.
* **Core**: pinned + profile + important preferences, always in the system
  prompt; while a mate has few memories all of them are core (as before).
"""

from __future__ import annotations

import math
import re
import unicodedata
from datetime import datetime
from typing import Any, Iterable

KINDS = ("profile", "preference", "fact", "plan", "context")
STATUSES = ("active", "done", "archived")
SOURCES = ("mate", "user", "import", "merge")
MAX_ACTIVE = 500
MAX_ROWS = 2000
CONTEXT_DAYS = 14          # a short-term context memory lives this long…
USED_EXTENDS_DAYS = 7      # …and this much longer each time it is recalled
INJECT_TTL_TURNS = 20      # a recalled memory isn't sent again for this many turns of the same engine session

# core = what the system prompt always carries
CORE_ALL_ITEMS, CORE_ALL_CHARS = 25, 2500     # this few memories: all of them (the behaviour before kinds)
CORE_ITEMS, CORE_CHARS = 24, 1800
# recall levels (prefs.memory.recall): items, characters per turn
RECALL_BUDGET = {"off": (0, 0), "light": (4, 600), "normal": (8, 1200), "rich": (14, 2400)}
DUE_SOON_H = 48
DUE_SOON_MAX = 3

_EN_STOP = set("""a an and are as at be been but by can could did do does doing for from had has have having he her
here hers him his how i if in into is it its just me my no not of on or our ours she so than that the their them then
there these they this those to too up us very was we were what when where which while who whom why will with would
you your yours about after again all am any because before being both did each few further more most other own same
should some such only off over under until also""".split())
_KO_STOP = set("나 너 저 제 내 네 그 이 저것 그것 이것 것 거 좀 더 수 잘 뭐 왜 응 아니 그리고 근데 그냥 정말 진짜 오늘은 우리".split())
# one trailing particle / ending cut from a Hangul run (longest first)
_KO_ENDINGS = sorted("""에서는 에게서 이에요 으로는 이라고 라고 에서 에게 께서 이랑 으로 하고 부터 까지 처럼 보다 이나 예요 했어 해요
했어요 이다 입니다 이야 은 는 이 가 을 를 에 께 와 과 랑 도 만 로 의 요 야 아""".split(), key=len, reverse=True)
_RUN = re.compile(r"[a-z]+|[0-9]+|[가-힣]+|[぀-ヿ一-鿿]+")


def _hangul(s: str) -> bool:
    return "가" <= s[0] <= "힣"


def _ko_stem(run: str) -> str:
    if len(run) >= 2:
        for e in _KO_ENDINGS:
            if run.endswith(e) and len(run) - len(e) >= 1:
                return run[: -len(e)]
    return run


def tokens(text: str) -> list[str]:
    """``w:`` words / stems, ``b:`` character bigrams of Hangul / Han / kana runs."""
    out: list[str] = []
    s = unicodedata.normalize("NFKC", text or "").lower()
    for m in _RUN.finditer(s):
        r = m.group(0)
        c = r[0]
        if "a" <= c <= "z":
            if len(r) < 2 or r in _EN_STOP:
                continue
            for suf in ("ing", "ed", "es", "s"):
                if len(r) > 4 and r.endswith(suf):
                    r = r[: -len(suf)]
                    break
            out.append("w:" + r)
        elif c.isdigit():
            out.append("w:" + r)
        elif _hangul(r):
            stem = _ko_stem(r)
            if stem not in _KO_STOP:
                out.append("w:" + stem)
            if len(r) >= 2:
                out += ["b:" + r[i:i + 2] for i in range(len(r) - 1)]
        else:  # Han / kana
            out += ["b:" + r[i:i + 2] for i in range(len(r) - 1)] if len(r) >= 2 else ["w:" + r]
    return out


def normalized(text: str) -> str:
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", text or "").lower())


def similarity(a: str, b: str) -> float:
    """1.0 when one text contains the other (normalized), else the Jaccard index of their tokens."""
    na, nb = normalized(a), normalized(b)
    if na and nb and (na in nb or nb in na):
        return 1.0
    ta, tb = set(tokens(a)), set(tokens(b))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


MERGE_AT, SIMILAR_AT = 0.85, 0.55


def similar(text: str, kind: str, rows: Iterable[dict[str, Any]], *, exclude: str | None = None) -> list[tuple[float, dict]]:
    """Active memories of the same kind like ``text``, most similar first (≥ SIMILAR_AT)."""
    out = []
    for r in rows:
        if r.get("id") == exclude or r.get("status") != "active" or r.get("kind") != kind:
            continue
        s = similarity(text, r["text"])
        if s >= SIMILAR_AT:
            out.append((s, r))
    out.sort(key=lambda x: -x[0])
    return out


def guess_kind(text: str) -> str:
    """For memories saved before kinds existed (migration): a few bilingual cue words, else ``fact``."""
    t = (text or "").lower()
    if re.search(r"이름|부르|호칭|직업|나이|생일|살고|사는 곳|가족|\bname\b|call (me|him|her|them)|\bi'?m\b|birthday|lives in|works (as|at)", t):
        return "profile"
    if re.search(r"좋아|싫어|선호|원해|원함|싫다|좋다|취향|prefer|likes?\b|loves?\b|hates?\b|dislikes?|favou?rite|wants? (it|things|reports)", t):
        return "preference"
    return "fact"


# ---- dates ----

_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$")


def parse_due(value: Any) -> str | None:
    """``YYYY-MM-DD`` or ``YYYY-MM-DDTHH:MM`` (the user's local time) → that string, normalized; else ValueError."""
    if value in (None, ""):
        return None
    m = _DATE.match(str(value).strip())
    if not m:
        raise ValueError("due must be a date: YYYY-MM-DD or YYYY-MM-DDTHH:MM")
    y, mo, d, hh, mm = m.groups()
    datetime(int(y), int(mo), int(d), int(hh or 0), int(mm or 0))  # (a real date)
    return f"{y}-{mo}-{d}" + (f"T{hh}:{mm}" if hh else "")


def due_local(due: str | None) -> datetime | None:
    """A due string as a naive local datetime (a date alone: the end of that day)."""
    if not due:
        return None
    try:
        dt = datetime.fromisoformat(due)
    except ValueError:
        return None
    return dt if "T" in due else dt.replace(hour=23, minute=59)


def _age_days(iso: str | None, now_utc: datetime) -> float:
    if not iso:
        return 365.0
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return 365.0
    if t.tzinfo is None:
        t = t.replace(tzinfo=now_utc.tzinfo)
    return max(0.0, (now_utc - t).total_seconds() / 86400)


# ---- core ----

def line(m: dict[str, Any]) -> str:
    """One memory as the prompt shows it: ``[id] (kind, due …) text``."""
    tag = m.get("kind") or "fact"
    if m.get("kind") == "plan" and m.get("due_at"):
        tag += f", due {m['due_at'].replace('T', ' ')}"
    source = m.get("evidence_type")
    provenance = f" {{source={source}; verify original}}" if source in ("legacy", "reported") else ""
    return f"[{m['id']}] ({tag}) {m['text']}{provenance}"


def core(active: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The memories the system prompt always carries."""
    rows = [m for m in active if m.get("status", "active") == "active"]
    if len(rows) <= CORE_ALL_ITEMS and sum(len(m["text"]) for m in rows) <= CORE_ALL_CHARS:
        return sorted(rows, key=lambda m: (m.get("created_at") or "", m["id"]))
    pick = [m for m in rows if m.get("pinned")
            or (m.get("kind") == "profile" and int(m.get("importance") or 3) >= 3)
            or (m.get("kind") == "preference" and int(m.get("importance") or 3) >= 4)]
    pick.sort(key=lambda m: (0 if m.get("pinned") else 1, -int(m.get("importance") or 3), m.get("updated_at") or ""),
              reverse=False)
    out, chars = [], 0
    for m in pick:
        if len(out) >= CORE_ITEMS or (chars + len(m["text"]) > CORE_CHARS and not m.get("pinned")):
            continue
        out.append(m)
        chars += len(m["text"])
    return out


# ---- recall ----

class Index:
    """BM25 over a set of memories (rebuilt when they change: ≤ 500 short texts, a few ms)."""

    K1, B = 1.2, 0.75

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.docs = [tokens(m["text"]) for m in rows]
        self.n = len(rows)
        self.avgdl = (sum(len(d) for d in self.docs) / self.n) if self.n else 0.0
        self.df: dict[str, int] = {}
        for d in self.docs:
            for t in set(d):
                self.df[t] = self.df.get(t, 0) + 1

    def bm25(self, i: int, q: dict[str, float]) -> tuple[float, int, int]:
        """(score, shared words, shared bigrams)"""
        d = self.docs[i]
        if not d:
            return 0.0, 0, 0
        tf: dict[str, int] = {}
        for t in d:
            tf[t] = tf.get(t, 0) + 1
        s, words, bigrams = 0.0, 0, 0
        dl = len(d)
        for t, w in q.items():
            f = tf.get(t)
            if not f:
                continue
            if t.startswith("w:"):
                words += 1
            else:
                bigrams += 1
            idf = math.log(1 + (self.n - self.df[t] + 0.5) / (self.df[t] + 0.5))
            s += w * idf * f * (self.K1 + 1) / (f + self.K1 * (1 - self.B + self.B * dl / (self.avgdl or 1)))
        return s, words, bigrams


def _query(text: str) -> dict[str, float]:
    q: dict[str, float] = {}
    for t in tokens(text[:2000]):
        q[t] = 1.0 if t.startswith("w:") else 0.5
    return q


def score(m: dict[str, Any], rel: float, now_utc: datetime, now_local: datetime) -> float:
    s = 0.60 * (rel / (rel + 2)) if rel > 0 else 0.0
    s += 0.20 * (max(1, min(5, int(m.get("importance") or 3))) - 1) / 4
    s += 0.10 * math.exp(-_age_days(m.get("updated_at") or m.get("created_at"), now_utc) / 60)
    s += 0.05 * min(1.0, int(m.get("use_count") or 0) / 5)
    if m.get("kind") == "plan":
        due = due_local(m.get("due_at"))
        if due is not None:
            hours = (due - now_local).total_seconds() / 3600
            if 0 <= hours <= 7 * 24:
                s += 0.30
            elif -48 <= hours < 0:
                s += 0.20
    elif m.get("kind") == "context" and _age_days(m.get("created_at"), now_utc) <= 3:
        s += 0.15
    return s


def recall(rows: list[dict[str, Any]], query: str, *, now_utc: datetime, now_local: datetime, level: str = "normal",
           skip: set[str] | None = None, limit: int | None = None, chars: int | None = None,
           due_soon: bool = True) -> list[dict[str, Any]]:
    """The memories worth giving the mate for this message, best first, within the level's budget.
    ``rows``: the candidates (per turn: active, not in the core); ``skip``: ids it already has in its context."""
    n_max, c_max = RECALL_BUDGET.get(level, RECALL_BUDGET["normal"])
    if limit is not None:
        n_max = limit
    if chars is not None:
        c_max = chars
    if n_max <= 0:
        return []
    skip = skip or set()
    pool = [m for m in rows if m["id"] not in skip]
    idx = Index(pool)
    q = _query(query or "")
    ranked: list[tuple[float, dict[str, Any]]] = []
    soon: list[tuple[float, dict[str, Any]]] = []
    for i, m in enumerate(pool):
        rel, words, bigrams = idx.bm25(i, q) if q else (0.0, 0, 0)
        matched = words >= 1 or bigrams >= 2
        due = due_local(m.get("due_at")) if m.get("kind") == "plan" else None
        is_soon = due is not None and 0 <= (due - now_local).total_seconds() / 3600 <= DUE_SOON_H
        if matched:
            ranked.append((score(m, rel, now_utc, now_local), m))
        elif due_soon and is_soon:
            soon.append((score(m, 0.0, now_utc, now_local), m))
    ranked.sort(key=lambda x: -x[0])
    soon.sort(key=lambda x: -x[0])
    out: list[dict[str, Any]] = []
    used = 0
    for _, m in [*soon[:DUE_SOON_MAX], *ranked]:
        if len(out) >= n_max:
            break
        if any(o["id"] == m["id"] for o in out):
            continue
        if used + len(m["text"]) > c_max:
            continue
        out.append(m)
        used += len(m["text"])
    return out


def expired(m: dict[str, Any], now_utc: datetime, now_local: datetime) -> str | None:
    """The status housekeeping moves this memory to ("archived" / "done"), or None."""
    if m.get("status") != "active" or m.get("pinned"):
        return None
    if m.get("kind") == "context" and m.get("expires_at") and int(m.get("importance") or 3) < 4:
        if _age_days(m["expires_at"], now_utc) > 0:  # (the expiry is in the past)
            return "archived"
    return None
