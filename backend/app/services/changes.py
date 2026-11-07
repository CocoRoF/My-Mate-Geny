"""Exact per-turn file changes via git snapshots.

Before and after every turn the working tree of each git root the agent can
touch (workspace + additional folders) is written into a git *tree object*
through a temporary index file:

    cp -p .git/index $tmp; GIT_INDEX_FILE=$tmp git add -A; GIT_INDEX_FILE=$tmp git write-tree

(-p: the index's own time is how git knows to look closer at a file that changed
right after it was written; without it, an edit of the same size in the same
second goes unseen.) The user's real index, HEAD and working tree are never
modified (only loose objects are added, which git prunes as usual). Diffing the two trees gives the
exact files and line counts the turn changed — whether the edit came from
Claude, Codex, or a `sed`/codegen command in a shell. The same scripts run
locally (bash) or on a remote workspace (over SSH), so remote turns get it too.
"""

from __future__ import annotations

import asyncio
import os
import shlex
from typing import Any

MAX_FILES = 400
_REVERT_BATCH = 200
PATCH_LIMIT = 2 * 1024 * 1024
_TIMEOUT = 20.0

_SNAPSHOT = r'''
cd -- {path} 2>/dev/null || exit 3
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 3
cd -- "$top" || exit 3
tmp=$(mktemp) || exit 4
idx=$(git rev-parse --git-path index)
[ -f "$idx" ] && cp -p "$idx" "$tmp" || rm -f "$tmp"
GIT_INDEX_FILE="$tmp" git add -A >/dev/null 2>&1
tree=$(GIT_INDEX_FILE="$tmp" git write-tree 2>/dev/null) || {{ rm -f "$tmp"; exit 5; }}
rm -f "$tmp"
printf '%s\n%s\n' "$top" "$tree"
'''

_SUMMARY = r'''
cd -- {top} || exit 3
git -c core.quotepath=false diff --no-color -M --numstat -z {a} {b}
printf '\001'
git -c core.quotepath=false diff --no-color -M --name-status -z {a} {b}
'''

_PATCH = r'''
cd -- {top} || exit 3
git -c core.quotepath=false diff --no-color -M {a} {b} -- {paths}
'''

_REVERT = r'''
cd -- {top} || exit 3
{restore} || exit 4
{remove}
'''


class ShellRunner:
    """Runs a bash script locally or on a remote host (via an ssh argv prefix)."""

    def __init__(self, ssh_prefix: list[str] | None = None) -> None:
        self._prefix = ssh_prefix

    async def run(self, script: str, timeout: float = _TIMEOUT) -> tuple[int, bytes]:
        argv = [*self._prefix, "bash -c " + shlex.quote(script)] if self._prefix else ["bash", "-c", script]
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return 124, b""
        return proc.returncode or 0, out


async def snapshot(runner: ShellRunner, path: str) -> tuple[str, str] | None:
    """(repo root, tree sha) of the working tree containing ``path``, or None."""
    rc, out = await runner.run(_SNAPSHOT.format(path=shlex.quote(path)))
    if rc != 0:
        return None
    lines = out.decode(errors="replace").strip().splitlines()
    if len(lines) != 2 or len(lines[1]) < 40:
        return None
    return lines[0], lines[1]


async def snapshot_all(runner: ShellRunner, paths: list[str]) -> dict[str, str]:
    """{repo root: tree} for every distinct git root among ``paths``."""
    results = await asyncio.gather(*(snapshot(runner, p) for p in paths), return_exceptions=True)
    out: dict[str, str] = {}
    for r in results:
        if isinstance(r, tuple):
            out.setdefault(r[0], r[1])
    return out


def _parse_summary(raw: bytes) -> list[dict[str, Any]]:
    numstat, _, names = raw.partition(b"\x01")
    files: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    # --name-status -z: STATUS\0path\0   or   Rxx\0old\0new\0
    parts = names.split(b"\0")
    i = 0
    while i < len(parts) - 1:
        st = parts[i].decode(errors="replace")
        if not st:
            i += 1
            continue
        if st[:1] in ("R", "C"):
            old, new = parts[i + 1].decode(errors="replace"), parts[i + 2].decode(errors="replace")
            files[new] = {"path": new, "old_path": old, "status": st[:1]}
            order.append(new)
            i += 3
        else:
            p = parts[i + 1].decode(errors="replace")
            files[p] = {"path": p, "status": st[:1]}
            order.append(p)
            i += 2
    # --numstat -z: add\tdel\tpath\0   or   add\tdel\t\0old\0new\0
    parts = numstat.split(b"\0")
    i = 0
    while i < len(parts):
        rec = parts[i].decode(errors="replace")
        if not rec:
            i += 1
            continue
        cols = rec.split("\t")
        if len(cols) < 3:
            i += 1
            continue
        added, removed, path = cols[0], cols[1], cols[2]
        if path == "":  # rename: next two entries are old/new
            path = parts[i + 2].decode(errors="replace") if i + 2 < len(parts) else ""
            i += 3
        else:
            i += 1
        f = files.setdefault(path, {"path": path, "status": "M"})
        if path not in order:
            order.append(path)
        if added == "-":
            f["binary"] = True
            f["added"] = f["removed"] = 0
        else:
            f["added"], f["removed"] = int(added), int(removed)
    return [files[p] for p in order]


async def summarize(runner: ShellRunner, top: str, before: str, after: str, *, strict: bool = False,
                    limit: int | None = MAX_FILES) -> dict[str, Any] | None:
    """What changed between two snapshots, None if nothing did. ``strict``: a diff that fails raises instead of looking the
    same as nothing having changed (tracking a turn can live with that, undoing one can't). ``limit``: None = every file."""
    if before == after:
        return None
    rc, out = await runner.run(_SUMMARY.format(top=shlex.quote(top), a=before, b=after), timeout=120.0 if strict else _TIMEOUT)
    if rc != 0:
        if strict:
            raise RuntimeError(f"could not compare the files in {top} with how they were")
        return None
    files = _parse_summary(out)
    if not files:
        return None
    truncated = limit is not None and len(files) > limit
    if limit is not None:
        files = files[:limit]
    return {
        "root": top,
        "before": before,
        "after": after,
        "files": files,
        "added": sum(f.get("added", 0) for f in files),
        "removed": sum(f.get("removed", 0) for f in files),
        "truncated": truncated,
    }


async def patch(runner: ShellRunner, top: str, before: str, after: str, paths: list[str]) -> str:
    q = " ".join(shlex.quote(p) for p in paths) if paths else "."
    rc, out = await runner.run(_PATCH.format(top=shlex.quote(top), a=before, b=after, paths=q), timeout=30)
    text = out[:PATCH_LIMIT].decode(errors="replace")
    if len(out) > PATCH_LIMIT:
        text += "\n… (diff truncated)"
    return text


async def revert(runner: ShellRunner, repo: dict[str, Any], paths: list[str] | None = None) -> list[str]:
    """Put the turn's files back to their before-state (working tree only)."""
    files = [f for f in repo["files"] if not paths or f["path"] in paths]
    for k in range(0, len(files), _REVERT_BATCH):  # (a command line has a limit; a restore may be every file there is)
        batch = files[k:k + _REVERT_BATCH]
        restore = [f["old_path"] if f.get("status") == "R" else f["path"] for f in batch if f.get("status") != "A"]
        remove = [f["path"] for f in batch if f.get("status") in ("A", "R")]
        script = _REVERT.format(
            top=shlex.quote(repo["root"]),
            restore=(f"git restore --source={repo['before']} --worktree -- " + " ".join(shlex.quote(p) for p in restore))
            if restore else ":",
            remove=("rm -f -- " + " ".join(shlex.quote(p) for p in remove)) if remove else ":",
        )
        rc, _ = await runner.run(script, timeout=30)
        if rc != 0:
            raise RuntimeError("revert failed")
    return [f["path"] for f in files]


def local_runner() -> ShellRunner:
    return ShellRunner(None)


def is_sha(value: str) -> bool:
    return len(value) in (40, 64) and all(c in "0123456789abcdef" for c in value)


def env_ok() -> bool:
    return os.path.exists("/usr/bin/git") or os.path.exists("/bin/git")
