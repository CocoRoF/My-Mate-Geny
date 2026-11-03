"""A chat's Git repository (the top bar's Git button): which repo, its status,
branches, switching branch, finding repos in the chat's folders.

The repo is ``sessions.git_repo``: NULL = automatic (the workspace, when it is
in a repo), a path = that repo, ``""`` = disconnected; ``git_repo_conn`` = the
host it is on (a chat's folders can be on several hosts). Every git call runs as
one small shell script — locally, or over SSH on that host —
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


_WS = object()  # "the workspace's host" (an API call that didn't say)

# Clone onto a host (this server or over SSH), token-free on disk: the token (if any) comes in on stdin,
# lives in a 0600 file inside a 0700 mktemp dir only while git runs (GIT_ASKPASS reads it), and the dir
# is removed on exit — never in argv, the environment, the repo's config or a credential helper (an
# empty ``credential.helper`` also keeps the host's own helpers from storing it).
_CLONE = r"""
url=$1; dest=$2; user=$3
if [ -d "$dest/.git" ]; then echo @@exists; exit 0; fi
if [ -e "$dest" ] && [ -n "$(ls -A -- "$dest" 2>/dev/null)" ]; then echo @@notempty; exit 3; fi
existed=; [ -e "$dest" ] && existed=1
mkdir -p -- "$(dirname -- "$dest")" || { echo @@mkdir; exit 4; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/geny-clone.XXXXXXXX") || { echo @@tmp; exit 5; }
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM
IFS= read -r tok || true
if [ -n "${tok:-}" ]; then
  ( umask 077; printf '%s' "$tok" > "$tmp/t"; printf '%s' "$user" > "$tmp/u"
    cat > "$tmp/askpass" <<'EOF'
#!/bin/sh
d=$(dirname -- "$0")
case "$1" in [Uu]sername*) cat "$d/u" ;; *) cat "$d/t" ;; esac
EOF
    chmod 700 "$tmp/askpass" )
  tok=
  ask="$tmp/askpass"
else
  ask=/bin/false
fi
GIT_ASKPASS="$ask" SSH_ASKPASS= GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c core.askPass="$ask" \
  clone --quiet -- "$url" "$dest" 2>&1
rc=$?
if [ $rc -ne 0 ]; then
  [ -z "$existed" ] && rm -rf -- "$dest"
  echo "@@failed $rc"; exit 6
fi
cd -- "$dest" && pwd -P
"""


class SessionGit:
    def __init__(self, sessions: Any, workspaces: Any, git_accounts: Any = None) -> None:
        self._sessions = sessions
        self._workspaces = workspaces
        self._accounts = git_accounts  # app.services.git_service.GitService (clone with an account)

    # ---- plumbing ----

    def _host_name(self, host: str | None) -> str:
        if not host:
            return "this server"
        try:
            return next((c["name"] for c in self._workspaces.connections() if c["id"] == host), host)
        except Exception:  # noqa: BLE001
            return host

    def _argv0(self, host: str | None) -> list[str]:
        if not host:
            return ["sh", "-c"]
        try:
            connector = self._workspaces.connector_for(host)
        except KeyError as exc:
            raise GitOpError("that server's connection was removed", 404) from exc
        prefix = getattr(connector, "ssh_prefix", None)
        if prefix is None:
            raise GitOpError("no shell access to this workspace")
        return list(prefix())

    def _runner(self, session: dict[str, Any], host: Any = _WS) -> Callable[..., tuple[int, str, str]]:
        if host is _WS:
            host = session.get("connection_id") or None
        argv0 = self._argv0(host)
        name = self._host_name(host)

        def run(script: str, timeout: float = 20, *, args: list[str] | None = None,
                stdin: str | None = None) -> tuple[int, str, str]:
            # sh -c '<script>' sh arg1 arg2…  (over ssh the remote shell re-parses: quote everything)
            if host:
                full = [*argv0, " ".join(shlex.quote(x) for x in ["sh", "-c", _ENV + script, "sh", *(args or [])])]
            else:
                full = [*argv0, _ENV + script, "sh", *(args or [])]
            try:
                p = subprocess.run(full, capture_output=True, text=True, timeout=timeout, input=stdin,
                                   env={**os.environ, "LC_ALL": "C"})
            except subprocess.TimeoutExpired as exc:
                raise GitOpError("git took too long (timed out)", 504) from exc
            except FileNotFoundError as exc:
                raise GitOpError("git / ssh not available on the server", 500) from exc
            if host and p.returncode == 255 and not p.stdout:
                raise GitOpError(f"can't reach {name}: {(p.stderr.strip().splitlines() or ['ssh failed'])[-1][:200]}", 502)
            return p.returncode, p.stdout, p.stderr

        return run

    async def _run(self, session: dict[str, Any], script: str, timeout: float = 20, host: Any = _WS,
                   **kw: Any) -> tuple[int, str, str]:
        run = self._runner(session, host)
        return await asyncio.to_thread(lambda: run(script, timeout, **kw))

    @staticmethod
    def repo_of(session: dict[str, Any]) -> tuple[str, str | None]:
        """(mode, path): auto -> the workspace; set -> that repo; off -> None."""
        g = session.get("git_repo")
        if g is None:
            return "auto", session["workspace_path"]
        if g == "":
            return "off", None
        return "set", g

    @staticmethod
    def repo_host(session: dict[str, Any]) -> str | None:
        """The host of the chat's repo: auto = the workspace's; a chosen repo carries its own."""
        if session.get("git_repo"):
            return session.get("git_repo_host", session.get("connection_id")) or None
        return session.get("connection_id") or None

    @staticmethod
    def _folders(session: dict[str, Any]) -> list[dict[str, Any]]:
        if "folders" in session:
            return list(session.get("folders") or [])
        cid = session.get("connection_id") or None  # (a session dict from before hosts)
        return [{"path": p, "connection_id": cid} for p in session.get("extra_dirs") or []]

    def _roots(self, session: dict[str, Any], host: str | None) -> list[str]:
        out = [session["workspace_path"]] if (session.get("connection_id") or None) == host else []
        return out + [f["path"] for f in self._folders(session) if (f.get("connection_id") or None) == host
                      and f["path"] not in out]

    def _hosts(self, session: dict[str, Any]) -> list[str | None]:
        return list(dict.fromkeys([session.get("connection_id") or None,
                                   *[f.get("connection_id") or None for f in self._folders(session)]]))

    async def _real_roots(self, session: dict[str, Any], host: str | None) -> list[str]:
        """The chat's folders on ``host`` as absolute real paths there (remote workspaces may say ``~/proj``),
        comparable with git's ``--show-toplevel``."""
        roots = self._roots(session, host)
        if not roots:
            return []
        script = "".join(f"(cd -- {qpath(r)} 2>/dev/null && pwd -P) || echo\n" for r in roots)
        rc, out, _ = await self._run(session, script, host=host)
        real = out.splitlines() if rc == 0 else []
        return [(real[i].strip() if i < len(real) and real[i].strip() else r) for i, r in enumerate(roots)]

    async def _status_at(self, session: dict[str, Any], path: str, host: Any = _WS) -> dict[str, Any]:
        script = (
            f"cd -- {qpath(path)} 2>/dev/null || {{ echo @@nodir; exit 0; }}\n"
            "git rev-parse --show-toplevel 2>/dev/null || { echo @@norepo; exit 0; }\n"
            "echo @@remote; git remote get-url origin 2>/dev/null\n"
            "echo @@status; git status --porcelain=v2 --branch 2>/dev/null | head -n 5000\n"
            "echo @@log; git log -1 --format='%h%x1f%s%x1f%an%x1f%cI' 2>/dev/null\n"
        )
        rc, out, err = await self._run(session, script, host=host)
        if rc != 0 and not out:
            raise GitOpError((err.strip() or "git status failed")[:300], 502)
        return parse_status(out)

    # ---- API ----

    async def status(self, sid: str) -> dict[str, Any]:
        session = self._sessions.get(sid)
        mode, path = self.repo_of(session)
        host = self.repo_host(session)
        if path is None:
            return {"mode": mode, "path": None, "connected": False, "is_repo": False}
        try:
            st = await self._status_at(session, path, host)
        except GitOpError as exc:
            return {"mode": mode, "path": path, "connection_id": host, "connected": False, "is_repo": False,
                    "error": str(exc)}
        return {"mode": mode, "path": path, "connection_id": host, "connected": bool(st.get("is_repo")), **st}

    async def connect(self, sid: str, path: str, add_folder: bool = False, connection_id: Any = _WS) -> dict[str, Any]:
        """Connect the repo at ``path`` on ``connection_id``'s host (None = this server; not given = the
        workspace's). Outside the chat's folders on that host: ``add_folder`` attaches its folder too."""
        session = self._sessions.get(sid)
        host = (session.get("connection_id") or None) if connection_id is _WS else (connection_id or None)
        if host and host != (session.get("connection_id") or None) and host not in {c["id"] for c in self._connections()}:
            raise GitOpError(f"unknown connection: {host}", 404)
        path = (path or "").strip()
        if not path:
            raise GitOpError("which repository?")
        st = await self._status_at(session, path, host)
        if not st.get("is_repo"):
            raise GitOpError(st.get("error") or f"not a git repository: {path}")
        root = st["root"]
        roots = await self._real_roots(session, host)
        if not any(inside(root, r) for r in roots):
            if not add_folder:
                raise GitOpError("connect its folder to this chat first (Folder button)")
            folders = [*self._folders(session), {"path": root, "connection_id": host}]
            self._sessions.update(sid, folders=folders)
        self._sessions.set_git_repo(sid, root, host)
        return await self.status(sid)

    def _connections(self) -> list[dict[str, Any]]:
        try:
            return self._workspaces.connections()
        except Exception:  # noqa: BLE001 - test doubles
            return []

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
        rc, out, err = await self._run(session, script, host=self.repo_host(session))
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
        rc, out, err = await self._run(session, f"cd -- {qpath(path)} || exit 3\n{cmd} 2>&1\n", timeout=60,
                                       host=self.repo_host(session))
        if rc != 0:
            msg = (out + err).strip().splitlines()
            raise GitOpError(" ".join(m.strip() for m in msg if m.strip())[:400] or "git switch failed", 409)
        return await self.status(sid)

    async def _detect_on(self, session: dict[str, Any], host: str | None) -> list[dict[str, Any]]:
        roots = self._roots(session, host)
        if not roots:
            return []
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
        rc, out, err = await self._run(session, script, timeout=30, host=host)
        main = (session.get("connection_id") or None) == host
        ws_real = ((await self._real_roots(session, host))[0] if out.strip() and main else session["workspace_path"])
        repos = []
        for ln in out.splitlines():
            parts = ln.split("\t")
            if len(parts) != 3 or not parts[0]:
                continue
            path, branch, remote = parts[0], parts[1], strip_userinfo(parts[2])
            where = "workspace" if main and (inside(path, ws_real) or inside(path, session["workspace_path"])) else "folder"
            repos.append({
                "path": path, "branch": branch, "remote": remote, "where": where,
                "repo": repo_name(remote, path), "connection_id": host,
            })
        return repos

    async def detect(self, sid: str) -> dict[str, Any]:
        """Repos in the chat's folders on every host they are on: each folder's own repo + repos up to
        two levels down. A host that can't be reached is reported, the others still answer."""
        session = self._sessions.get(sid)
        hosts = self._hosts(session)
        results = await asyncio.gather(*(self._detect_on(session, h) for h in hosts), return_exceptions=True)
        repos: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        for h, res in zip(hosts, results):
            if isinstance(res, Exception):
                errors.append({"connection_id": h, "error": str(res)[:300]})
            else:
                repos += res
        mode, current = self.repo_of(session)
        return {"repos": repos, "mode": mode, "current": current, "current_host": self.repo_host(session),
                "errors": errors}

    # ---- clone onto a host ----

    async def clone(self, sid: str, *, clone_url: str, connection_id: Any = _WS, account_id: str | None = None,
                    full_name: str | None = None, parent: str | None = None) -> dict[str, Any]:
        """Clone ``clone_url`` (with a Git account's token, or anonymously for a public repo) onto
        ``connection_id``'s host (None = this server, not given = the workspace's), then connect it
        to the chat (its folder attached when outside the chat's folders)."""
        session = self._sessions.get(sid)
        host = (session.get("connection_id") or None) if connection_id is _WS else (connection_id or None)
        if host and host != (session.get("connection_id") or None) and host not in {c["id"] for c in self._connections()}:
            raise GitOpError(f"unknown connection: {host}", 404)
        acc, token = None, None
        if account_id:
            if self._accounts is None:
                raise GitOpError("Git accounts are not available", 500)
            try:
                acc, token = self._accounts.account_token(account_id)
            except Exception as exc:  # noqa: BLE001 - unknown account
                raise GitOpError(str(exc) or "unknown Git account", 404) from exc
        url, name = clean_clone_url(clone_url, full_name, acc and self._accounts.git_host(acc))
        if not host and acc is not None:
            # this server: the account's clone (credentials file outside the repo, so the agent can push)
            owner_repo = full_name or "/".join(s for s in url.split("://", 1)[1].split("/")[1:] if s).removesuffix(".git")
            try:
                res = await asyncio.to_thread(self._accounts.clone, account_id, owner_repo, url)
            except Exception as exc:  # noqa: BLE001 - GitError: bad name / clone failed
                raise GitOpError(str(exc)[:400], 502) from exc
            dest = res["path"]
        else:
            if parent is None or not parent.strip():
                parent = "~/repos" if host else str(_local_repos_parent(url))
            parent = parent.strip()
            if not (parent.startswith("/") or parent == "~" or parent.startswith("~/")) or "\n" in parent:
                raise GitOpError("the destination must be an absolute folder (or ~/…)")
            dest = (parent.rstrip("/") or "/") + "/" + name
            user = ("x-access-token" if acc["provider"] == "github" else "oauth2") if acc else ""
            dest_arg = dest  # "~/…" → the host's home (the script is not a login shell: expand here)
            script = ('case "$2" in "~") set -- "$1" "$HOME" "$3";; "~/"*) set -- "$1" "$HOME/${2#\\~/}" "$3";; esac\n'
                      + _CLONE)
            rc, out, err = await self._run(session, script, timeout=900, host=host, args=[url, dest_arg, user],
                                           stdin=(token + "\n") if token else "")
            lines = [ln for ln in out.splitlines() if ln.strip()]
            if "@@notempty" in lines:
                raise GitOpError(f"{dest} already exists and is not empty", 409)
            if "@@mkdir" in lines:
                raise GitOpError(f"can't create {parent} on {self._host_name(host)} (permission?)", 403)
            if any(ln.startswith("@@failed") for ln in lines) or rc != 0:
                why = " ".join(ln for ln in lines if not ln.startswith("@@"))[-300:] or err.strip()[-300:]
                raise GitOpError(f"clone failed on {self._host_name(host)}: {_scrub(why, token)}", 502)
            if "@@exists" not in lines and lines:
                dest = lines[-1].strip()
            if acc is not None:
                await self._run(session, (
                    f"cd -- {qpath(dest)} && git config user.name {shlex.quote(acc.get('username') or 'My Mate Geny')} && "
                    f"git config user.email {shlex.quote((acc.get('username') or 'geny') + '@users.noreply.' + acc['provider'] + '.com')}"
                ), host=host)
        return await self.connect(sid, dest, add_folder=True, connection_id=host)


def _scrub(text: str, token: str | None) -> str:
    return text.replace(token, "***") if token else text


def _local_repos_parent(url: str):
    import urllib.parse

    from app.config import settings

    u = urllib.parse.urlsplit(url)
    parts = [p for p in u.path.split("/") if p][:-1]
    return (settings.repos_root_path / "public" / (u.hostname or "git")).joinpath(*parts)


_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")


def clean_clone_url(url: str, full_name: str | None, account_host: str | None) -> tuple[str, str]:
    """(clean https URL, folder name). https only, no credentials in it; with an account, on its host."""
    import urllib.parse

    u = urllib.parse.urlsplit((url or "").strip())
    if u.scheme != "https" or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise GitOpError("use an https clone URL without credentials in it")
    if account_host and u.hostname.lower() != account_host.lower():
        raise GitOpError("clone URL must be on this account's host")
    segs = [s for s in u.path.split("/") if s]
    if not segs or any(s in (".", "..") for s in segs):
        raise GitOpError("invalid repository URL")
    name = (full_name or segs[-1]).rstrip("/").split("/")[-1]
    if name.endswith(".git"):
        name = name[:-4]
    if not _NAME.match(name):
        raise GitOpError("invalid repository name")
    port = f":{u.port}" if u.port else ""
    return urllib.parse.urlunsplit(("https", f"{u.hostname}{port}", u.path, "", "")), name


