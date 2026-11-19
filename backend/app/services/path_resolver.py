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

And when nothing is there (``near``): the file was named before it was made ("when the run finishes I'll write
``output/report/x.docx``"), made again under another name, or the name stands for several files
(``report_V3-xx.docx``). Then the folder it belongs in, and the files there it most likely means, are what helps.

Pure functions + a small local filesystem walk; the router wires in the
session's events.
"""

from __future__ import annotations

import difflib
import json
import os
import posixpath
import re
import time
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


# ---- when nothing is there: the folder it belongs in, and what in it was meant

# A part of a name that stands for many (V3-xx, run_NN, *, <id>, {date}): not letters of a word
_PLACEHOLDER = re.compile(r"(?<![A-Za-z])(?:[xX]{2,}|N{2,}|n{2,}|#{2,}|\*+|\?{2,}|<[^<>/]+>|\{[^{}/]+\})(?![A-Za-z])")


def name_pattern(name: str) -> re.Pattern[str] | None:
    """'심의보고서_V3-xx_Agent1.1.0.docx' → the pattern of the files it stands for (V3-01, V3-02…); None: a plain name."""
    if not _PLACEHOLDER.search(name):
        return None
    out, last = [], 0
    for m in _PLACEHOLDER.finditer(name):
        out += [re.escape(name[last:m.start()]), r".+?"]
        last = m.end()
    out.append(re.escape(name[last:]))
    return re.compile("^" + "".join(out) + "$", re.IGNORECASE)


def similar_names(name: str, entries: Iterable[str], *, limit: int = 8) -> tuple[list[str], str | None, float]:
    """(names in a folder the reference most likely means, how — "pattern" | "similar" | None, best score)"""
    pat = name_pattern(name)
    if pat is not None:
        hits = sorted(e for e in entries if pat.match(e))
        return hits[:limit], ("pattern" if hits else None), 1.0 if hits else 0.0
    stem, ext = os.path.splitext(name.lower())
    scored = []
    for e in entries:
        e_stem, e_ext = os.path.splitext(e.lower())
        if ext and e_ext != ext:
            continue
        # (the names without their extension: "later.md" is not "mate.md")
        sm = difflib.SequenceMatcher(None, stem, e_stem)
        if sm.real_quick_ratio() < 0.7 or sm.quick_ratio() < 0.7:
            continue
        r = sm.ratio()
        if r >= 0.7:
            scored.append((r, e))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [e for _, e in scored[:limit]], ("similar" if scored else None), (scored[0][0] if scored else 0.0)


def sure_match(name: str, names: list[str], how: str | None, score: float) -> bool:
    """One file, nearly the same long name ("…_결과요약.docx" made again as "…_결과보고.docx"): what was meant, to
    open outright. Short names are too easily alike for that ("a.md" / "b.md")."""
    return how == "similar" and len(names) == 1 and score >= 0.8 and len(os.path.splitext(name)[0]) >= 6


def near_candidates(ref: str, tried: list[str], mentioned: list[str], *, limit: int = 30) -> list[str]:
    """Where the reference would be, best first: itself (absolute), or under the roots the client tried and the
    folders the conversation worked in."""
    ref = clean_ref(ref)
    if not ref:
        return []
    if ref.startswith("/"):
        return [posixpath.normpath(ref)]
    out = [posixpath.normpath(posixpath.join(b, ref)) for b in [*tried, *candidate_bases(mentioned)[:limit]]]
    # + the folders the conversation put files in (newest first), that end the way the reference's own folder does:
    # "x.docx" could be in any of them, "out/r/x.docx" only under one ending in "/out/r"
    head, name = posixpath.split(ref)
    dirs: dict[str, None] = {}
    for p in mentioned:
        d = p if not os.path.splitext(p)[1] else posixpath.dirname(p)
        if d in _TOP_LEVEL or (head and not d.endswith("/" + head)):
            continue
        dirs[d] = None
        if len(dirs) >= 400:
            break
    out += [posixpath.join(d, name) for d in dirs]
    return list(dict.fromkeys(out))


def nearest_folder(path: str, isdir: Callable[[str], bool], *, max_up: int = 6) -> tuple[str | None, int]:
    """(the deepest existing folder on the way to ``path``, how many levels above the file it is — 1 = its own folder)"""
    d, up = posixpath.dirname(path), 1
    while d and up <= max_up:
        if d in _TOP_LEVEL:
            return None, up
        if isdir(d):
            return d, up
        d, up = posixpath.dirname(d), up + 1
    return None, up


def near(ref: str, tried: list[str], mentioned: list[str], *, isdir: Callable[[str], bool] = os.path.isdir,
         listdir: Callable[[str], list[str]] = os.listdir, max_lists: int = 400,
         budget_s: float = 1.5) -> dict | None:
    """Nothing is at the reference: the folder it belongs in and the files there it most likely means — of the places
    it could be, the one whose folder has such files (a bare name, "report_V3-xx.docx", could be under any of them);
    else its own folder if that is there, else the nearest one on the way. None: nothing better than "not found"."""
    found: list[tuple[int, int, str, str]] = []  # (levels up, rank, folder, candidate)
    for rank, cand in enumerate(near_candidates(ref, tried, mentioned)):
        folder, up = nearest_folder(cand, isdir)
        if folder is not None:
            found.append((up, rank, folder, cand))
    if not found:
        return None
    best: dict | None = None
    lists = 0
    deadline = time.monotonic() + budget_s
    for up, rank, folder, cand in sorted(x for x in found if x[0] == 1):
        if lists >= max_lists or time.monotonic() > deadline:
            break
        lists += 1
        try:
            entries = listdir(folder)[:5000]
        except OSError:
            continue
        names, how, score = similar_names(posixpath.basename(cand), entries)
        if names and (best is None or score > best["score"]):
            best = {"folder": folder, "own_folder": True, "expected": cand,
                    "similar": [posixpath.join(folder, n) for n in names], "how": how, "score": round(score, 3),
                    "sure": sure_match(posixpath.basename(cand), names, how, score)}
            if how == "pattern":
                break
    if best is not None:
        return best
    # no file like it anywhere: only a folder of the reference's own is worth showing ("out/r2/x.docx": out/r2, or out)
    # — not one of the conversation's folders a bare name was merely tried in
    ref = clean_ref(ref)
    own = len(posixpath.dirname(ref).split("/")) if posixpath.dirname(ref) and not ref.startswith("/") else 0
    found = [x for x in found if ref.startswith("/") or x[0] <= own]
    if not found:
        return None
    up, _, folder, cand = min(found)
    return {"folder": folder, "own_folder": up == 1, "expected": cand, "similar": [], "how": None, "score": 0.0,
            "sure": False}
