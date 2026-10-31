"""Find what a relative path the agent printed actually points at.

Agents write paths relative to wherever they were working — often not the
chat's workspace (a chat opened on ``/`` that worked in ``/home/x/repo``
prints ``docs/mate.md``). Joining with the workspace alone then says "not
found". This resolves a relative reference the way a person would:

1. the roots the client already tried (workspace, extra folders, a markdown
   file's folder) — cheap, and the common case;
2. the folders the conversation has been working in: absolute paths in the
   chat's recent tool calls and answers. A path that already ends with the
   reference wins outright; otherwise each folder (and its parents up to the
   repo root) is tried as a base, most recent and most used first;
3. a bounded search below the best of those roots for a file whose path ends
   with the reference (``mate.md`` → ``…/docs/mate.md``).

Pure functions + a small local filesystem walk; the router wires in the
session's events.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Callable, Iterable

# An absolute POSIX path inside free text / JSON: /a/b(/c…), names of the
# usual characters (Hangul included). Not preceded by a word char (URLs,
# "a/b" prose) — "https://x/y" is skipped by requiring no ':' right before.
_ABS = re.compile(r"(?<![\w:.~/-])(/(?:[\w.@+\-ㄱ-힝]+/)*[\w.@+\-ㄱ-힝]+)")
_SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build", ".next", "target", ".cache"}
_TOP_LEVEL = {"/", "/home", "/tmp", "/usr", "/etc", "/var", "/opt", "/proc", "/dev", "/sys"}


def clean_ref(ref: str) -> str:
    """'./docs/x.md' → 'docs/x.md'; trailing slash / punctuation dropped."""
    r = ref.strip().strip("`'\"")
    while r.startswith("./"):
        r = r[2:]
    return r.rstrip("/").rstrip(".,:;") or r


def paths_in_events(rows: Iterable[tuple[str, str]]) -> list[str]:
    """Absolute paths mentioned in (type, data-json) event rows, newest first
    (rows are given newest first), each path once."""
    seen: dict[str, None] = {}
    for typ, data in rows:
        if typ == "tool.use":
            try:
                text = json.dumps(json.loads(data).get("input") or {}, ensure_ascii=False)
            except ValueError:
                text = data
        elif typ in ("turn.complete", "tool.result"):
            try:
                d = json.loads(data)
            except ValueError:
                continue
            text = str(d.get("text") or d.get("output") or "")[:20000]
        else:
            continue
        for m in _ABS.findall(text.replace("\\/", "/")):
            p = os.path.normpath(m)
            if p not in seen and p not in _TOP_LEVEL:
                seen[p] = None
    return list(seen)


def candidate_bases(paths: list[str], limit: int = 80) -> list[str]:
    """Folders to try as the base of a relative reference: each mentioned
    path's folder and its parents (not the top-level system folders),
    ranked by how often and how recently they appear."""
    score: dict[str, float] = {}
    n = len(paths) or 1
    for i, p in enumerate(paths):
        recency = 1.0 + (n - i) / n  # newest ≈ 2, oldest ≈ 1
        d = p if not os.path.splitext(p)[1] else os.path.dirname(p)
        depth = 0
        while d and d not in _TOP_LEVEL and depth < 8:
            score[d] = score.get(d, 0.0) + recency / (1 + 0.15 * depth)
            d = os.path.dirname(d)
            depth += 1
    return [d for d, _ in sorted(score.items(), key=lambda kv: -kv[1])][:limit]


def direct_hits(ref: str, paths: list[str]) -> list[str]:
    """Mentioned paths that already end with the reference."""
    tail = "/" + ref.lstrip("/")
    return [p for p in paths if p.endswith(tail)]


def suffix_search(ref: str, roots: list[str], *, max_entries: int = 40000, max_depth: int = 8,
                  limit: int = 10) -> list[str]:
    """Files/folders below ``roots`` whose path ends with ``ref`` (bounded walk)."""
    parts = [x for x in ref.split("/") if x and x != "."]
    if not parts or ".." in parts:
        return []
    name, tail = parts[-1], "/" + "/".join(parts)
    out: list[str] = []
    seen = 0
    for root in roots:
        base_depth = root.rstrip("/").count("/")
        for cur, dirs, files in os.walk(root):
            seen += len(dirs) + len(files)
            if cur.count("/") - base_depth >= max_depth:
                dirs[:] = []
            dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
            for entry in (*files, *dirs):
                if entry == name:
                    full = os.path.join(cur, entry)
                    if full.endswith(tail) and full not in out:
                        out.append(full)
                        if len(out) >= limit:
                            return out
            if seen > max_entries:
                return out
    return out


def resolve(ref: str, tried: list[str], mentioned: list[str], *,
            exists: Callable[[str], bool] = os.path.exists, search: bool = True) -> list[str]:
    """Ranked existing absolute paths the relative ``ref`` most likely means."""
    ref = clean_ref(ref)
    if not ref or ref.startswith(("/", "~")):
        return []
    found: list[str] = []

    def add(p: str) -> None:
        p = os.path.normpath(p)
        if p not in found and exists(p):
            found.append(p)

    for base in tried:
        add(os.path.join(base, ref))
    for p in direct_hits(ref, mentioned):
        add(p)
    bases = candidate_bases(mentioned)
    for base in bases:
        add(os.path.join(base, ref))
        if len(found) >= 5:
            break
    if not found and search:
        roots = [b for b in [*tried, *bases[:6]] if b not in _TOP_LEVEL and os.path.isdir(b)]
        # widest first would be slow; the ranked bases are already the likely repos
        for p in suffix_search(ref, list(dict.fromkeys(roots))):
            add(p)
    # Copies under hidden folders (.claude/worktrees, .cache, …) are rarely
    # what was meant: after the plain paths, keeping the ranking otherwise.
    found.sort(key=lambda p: any(seg.startswith(".") for seg in p.split("/") if seg))
    return found[:10]
