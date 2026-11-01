"""A chat's Git repository (the top bar's Git button): which repo, its status,
branches, switching branch, finding repos in the chat's folders.

The repo is ``sessions.git_repo``: NULL = automatic (the workspace, when it is
in a repo), a path = that repo, ``""`` = disconnected. Every git call runs as
one small shell script — locally, or over SSH on a remote workspace's host —
with ``GIT_OPTIONAL_LOCKS=0`` so a status never takes the index lock from under
the agent's own git commands. Nothing here polls: the UI asks on open, after a
turn and after its own actions.
"""

from __future__ import annotations

import asyncio
import os
import re
import shlex
import subprocess
from typing import Any, Callable

from app.services.git_service import _owner_repo, strip_userinfo

_ENV = "export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat;"
_BRANCH = re.compile(r"^(?!-)(?!.*\.\.)(?!.*//)(?!.*@\{)[A-Za-z0-9._/+-]{1,200}(?<!\.lock)(?<!/)(?<!\.)$")
MAX_FILES = 200


class GitOpError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def qpath(p: str) -> str:
    """Shell-quote a path, keeping a leading ``~`` (remote workspaces use it) expandable."""
    if p == "~":
        return '"$HOME"'
    if p.startswith("~/"):
        return '"$HOME"/' + shlex.quote(p[2:])
    return shlex.quote(p)


def inside(p: str, root: str) -> bool:
    p, root = p.rstrip("/") or "/", root.rstrip("/") or "/"
    return p == root or p.startswith(root + "/") or root == "/"


def repo_name(remote: str, root: str) -> str:
    """owner/repo of a hosted remote; the folder's name for a local-path (or no) remote."""
    hosted = "://" in remote or re.match(r"^[\w.-]+@[\w.-]+:", remote)
    return _owner_repo(remote) if remote and hosted else os.path.basename(root.rstrip("/"))


def _sections(out: str) -> dict[str, list[str]]:
    cur = "_"
    d: dict[str, list[str]] = {cur: []}
    for ln in out.splitlines():
        if ln.startswith("@@") and " " not in ln:
            cur = ln[2:]
            d[cur] = []
        else:
            d[cur].append(ln)
    return d


def parse_status(out: str) -> dict[str, Any]:
    """Parse the status script's output (see :meth:`SessionGit.status`)."""
    sec = _sections(out)
    if "nodir" in sec:
        return {"is_repo": False, "error": "folder not found"}
    if "norepo" in sec or not sec.get("_"):
        return {"is_repo": False}
    root = sec["_"][0].strip()
    remote = strip_userinfo((sec.get("remote") or [""])[0].strip()) if sec.get("remote") else ""
    branch, oid, upstream = "", "", ""
    ahead = behind = 0
    files: list[dict[str, str]] = []
    counts = {"staged": 0, "modified": 0, "untracked": 0, "conflicted": 0, "deleted": 0, "added": 0}
    total = 0
    for ln in sec.get("status", []):
        if ln.startswith("# branch.oid "):
            oid = ln[13:].strip()
        elif ln.startswith("# branch.head "):
            branch = ln[14:].strip()
        elif ln.startswith("# branch.upstream "):
            upstream = ln[18:].strip()
        elif ln.startswith("# branch.ab "):
            m = re.match(r"# branch\.ab \+(\d+) -(\d+)", ln)
            if m:
                ahead, behind = int(m.group(1)), int(m.group(2))
        elif ln.startswith(("1 ", "2 ", "u ", "? ")):
            total += 1
            kind = ln[0]
            if kind == "?":
                counts["untracked"] += 1
                path, xy = ln[2:], "??"
            else:
                parts = ln.split(" ", 8 if kind == "1" else 9 if kind == "2" else 10)
                xy = parts[1]
                path = parts[-1].split("\t")[0]
                if kind == "u":
                    counts["conflicted"] += 1
                else:
                    if xy[0] != ".":
                        counts["staged"] += 1
                    if xy[1] != ".":
                        counts["modified"] += 1
                    if "D" in xy:
                        counts["deleted"] += 1
                    if "A" in xy:
                        counts["added"] += 1
            if len(files) < MAX_FILES:
                letter = "?" if xy == "??" else "U" if kind == "u" else (xy[1] if xy[1] != "." else xy[0])
                files.append({"path": path, "status": letter, "staged": xy[0] not in (".", "?")})
    detached = branch == "(detached)"
    if detached:
        branch = oid[:8]
    log = (sec.get("log") or [""])[0].split("\x1f")
    last = None
    if len(log) == 4 and log[0]:
        last = {"sha": log[0], "subject": log[1], "author": log[2], "date": log[3]}
    return {
        "is_repo": True,
        "root": root,
        "remote": remote,
        "repo": repo_name(remote, root),
        "branch": branch,
        "detached": detached,
        "initial": oid == "(initial)",
        "upstream": upstream or None,
        "ahead": ahead,
        "behind": behind,
        "changes": total,
        "counts": counts,
        "files": files,
        "files_truncated": total > len(files),
        "last_commit": last,
    }


class SessionGit:
    def __init__(self, sessions: Any, workspaces: Any) -> None:
        self._sessions = sessions
        self._workspaces = workspaces

    # ---- plumbing ----

    def _runner(self, session: dict[str, Any]) -> Callable[[str, float], tuple[int, str, str]]:
        cid = session.get("connection_id")
        if cid:
            connector = self._workspaces.connector_for(cid)
            prefix = getattr(connector, "ssh_prefix", None)
            if prefix is None:
                raise GitOpError("no shell access to this workspace")
            argv0 = list(prefix())
        else:
            argv0 = ["sh", "-c"]

        def run(script: str, timeout: float = 20) -> tuple[int, str, str]:
            try:
                p = subprocess.run([*argv0, _ENV + script], capture_output=True, text=True, timeout=timeout,
                                   env={**os.environ, "LC_ALL": "C"})
            except subprocess.TimeoutExpired as exc:
                raise GitOpError("git took too long (timed out)", 504) from exc
            except FileNotFoundError as exc:
                raise GitOpError("git / ssh not available on the server", 500) from exc
            return p.returncode, p.stdout, p.stderr

        return run

    async def _run(self, session: dict[str, Any], script: str, timeout: float = 20) -> tuple[int, str, str]:
        return await asyncio.to_thread(self._runner(session), script, timeout)

    @staticmethod
    def repo_of(session: dict[str, Any]) -> tuple[str, str | None]:
        """(mode, path): auto -> the workspace; set -> that repo; off -> None."""
        g = session.get("git_repo")
        if g is None:
            return "auto", session["workspace_path"]
        if g == "":
            return "off", None
        return "set", g

    def _roots(self, session: dict[str, Any]) -> list[str]:
        return [session["workspace_path"], *(session.get("extra_dirs") or [])]

    async def _real_roots(self, session: dict[str, Any]) -> list[str]:
        """The chat's folders as absolute real paths on their host (remote workspaces may say ``~/proj``),
        comparable with git's ``--show-toplevel``."""
        roots = self._roots(session)
        script = "".join(f"(cd -- {qpath(r)} 2>/dev/null && pwd -P) || echo\n" for r in roots)
        rc, out, _ = await self._run(session, script)
        real = out.splitlines() if rc == 0 else []
        return [(real[i].strip() if i < len(real) and real[i].strip() else r) for i, r in enumerate(roots)]

    async def _status_at(self, session: dict[str, Any], path: str) -> dict[str, Any]:
        script = (
            f"cd -- {qpath(path)} 2>/dev/null || {{ echo @@nodir; exit 0; }}\n"
            "git rev-parse --show-toplevel 2>/dev/null || { echo @@norepo; exit 0; }\n"
            "echo @@remote; git remote get-url origin 2>/dev/null\n"
            "echo @@status; git status --porcelain=v2 --branch 2>/dev/null | head -n 5000\n"
            "echo @@log; git log -1 --format='%h%x1f%s%x1f%an%x1f%cI' 2>/dev/null\n"
        )
        rc, out, err = await self._run(session, script)
        if rc != 0 and not out:
            raise GitOpError((err.strip() or "git status failed")[:300], 502)
        return parse_status(out)

    # ---- API ----

    async def status(self, sid: str) -> dict[str, Any]:
        session = self._sessions.get(sid)
        mode, path = self.repo_of(session)
        if path is None:
            return {"mode": mode, "path": None, "connected": False, "is_repo": False}
        try:
            st = await self._status_at(session, path)
        except GitOpError as exc:
            return {"mode": mode, "path": path, "connected": False, "is_repo": False, "error": str(exc)}
        return {"mode": mode, "path": path, "connected": bool(st.get("is_repo")), **st}

    async def connect(self, sid: str, path: str, add_folder: bool = False) -> dict[str, Any]:
        session = self._sessions.get(sid)
        path = (path or "").strip()
        if not path:
            raise GitOpError("which repository?")
        st = await self._status_at(session, path)
        if not st.get("is_repo"):
            raise GitOpError(st.get("error") or f"not a git repository: {path}")
        root = st["root"]
        roots = await self._real_roots(session)
        if not any(inside(root, r) for r in roots):
            if not add_folder:
                raise GitOpError("connect its folder to this chat first (Folder button)")
            self._sessions.update(sid, extra_dirs=[*(session.get("extra_dirs") or []), root])
        self._sessions.set_git_repo(sid, root)
        return await self.status(sid)

    def disconnect(self, sid: str) -> dict[str, Any]:
        self._sessions.get(sid)
        self._sessions.set_git_repo(sid, "")
        return {"mode": "off", "path": None, "connected": False, "is_repo": False}

    async def branches(self, sid: str) -> dict[str, Any]:
        session = self._sessions.get(sid)
        _, path = self.repo_of(session)
        if path is None:
            raise GitOpError("no repository connected", 409)
        script = (
            f"cd -- {qpath(path)} || exit 3\n"
            "git branch --show-current\n"
            "echo @@refs; git for-each-ref --sort=-committerdate "
            "--format='%(refname)%09%(upstream:short)' refs/heads refs/remotes 2>/dev/null | head -n 400\n"
        )
        rc, out, err = await self._run(session, script)
        if rc != 0:
            raise GitOpError((err.strip() or "could not list branches")[:300])
        sec = _sections(out)
        current = (sec.get("_") or [""])[0].strip()
        local: list[dict[str, Any]] = []
        remote: list[dict[str, Any]] = []
        for ln in sec.get("refs", []):
            ref, _, up = ln.partition("\t")
            if ref.startswith("refs/heads/"):
                local.append({"name": ref[11:], "upstream": up or None})
            elif ref.startswith("refs/remotes/") and not ref.endswith("/HEAD"):
                name = ref[13:]
                remote.append({"name": name, "short": name.split("/", 1)[1] if "/" in name else name})
        have = {b["name"] for b in local}
        remote = [r for r in remote if r["short"] not in have]
        return {"current": current, "local": local, "remote": remote}

    async def checkout(self, sid: str, branch: str, track: bool = False) -> dict[str, Any]:
        session = self._sessions.get(sid)
        if session.get("running"):
            raise GitOpError("the agent is working in this chat — switch branches after its turn", 409)
        _, path = self.repo_of(session)
        if path is None:
            raise GitOpError("no repository connected", 409)
        if not _BRANCH.match(branch or ""):
            raise GitOpError("invalid branch name")
        cmd = f"git switch --track {shlex.quote(branch)}" if track else f"git switch {shlex.quote(branch)}"
        rc, out, err = await self._run(session, f"cd -- {qpath(path)} || exit 3\n{cmd} 2>&1\n", timeout=60)
        if rc != 0:
            msg = (out + err).strip().splitlines()
            raise GitOpError(" ".join(m.strip() for m in msg if m.strip())[:400] or "git switch failed", 409)
        return await self.status(sid)

    async def detect(self, sid: str) -> dict[str, Any]:
        """Repos in the chat's folders: each folder's own repo + repos up to two levels down."""
        session = self._sessions.get(sid)
        roots = self._roots(session)
        dirs = " ".join(qpath(r) for r in roots)
        script = (
            f"for d in {dirs}; do\n"
            '  [ -d "$d" ] || continue\n'
            '  git -C "$d" rev-parse --show-toplevel 2>/dev/null\n'
            '  find "$d" -mindepth 2 -maxdepth 3 \\( -name node_modules -o -name .geny-uploads -o -name .venv \\) -prune'
            " -o -name .git -print 2>/dev/null | head -n 30 | sed 's#/\\.git$##'\n"
            "done | awk '!seen[$0]++' | head -n 30 | while IFS= read -r r; do\n"
            '  printf \'%s\\t%s\\t%s\\n\' "$r" "$(git -C "$r" branch --show-current 2>/dev/null)"'
            ' "$(git -C "$r" remote get-url origin 2>/dev/null)"\n'
            "done\n"
        )
        rc, out, err = await self._run(session, script, timeout=30)
        ws_real = (await self._real_roots(session))[0] if out.strip() else session["workspace_path"]
        repos = []
        for ln in out.splitlines():
            parts = ln.split("\t")
            if len(parts) != 3 or not parts[0]:
                continue
            path, branch, remote = parts[0], parts[1], strip_userinfo(parts[2])
            where = "workspace" if inside(path, ws_real) or inside(path, session["workspace_path"]) else "folder"
            repos.append({
                "path": path, "branch": branch, "remote": remote, "where": where,
                "repo": repo_name(remote, path),
            })
        mode, current = self.repo_of(session)
        return {"repos": repos, "mode": mode, "current": current}
