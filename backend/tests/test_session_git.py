"""A chat's Git repository (app/services/session_git.py + /api/sessions/{sid}/git)."""

from __future__ import annotations

import os
import subprocess

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.session_git import SessionGit, parse_status, qpath

ENV = {**os.environ, "GIT_AUTHOR_NAME": "Dev", "GIT_AUTHOR_EMAIL": "dev@example.com",
       "GIT_COMMITTER_NAME": "Dev", "GIT_COMMITTER_EMAIL": "dev@example.com"}


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True, env=ENV).stdout


@pytest.fixture
def repo(tmp_path):
    """ws/app: main one commit ahead of origin, 1 modified + 2 untracked; origin has feature/x."""
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    ws = tmp_path / "ws"
    ws.mkdir()
    app_dir = ws / "app"
    subprocess.run(["git", "clone", "-q", str(origin), str(app_dir)], check=True, capture_output=True)
    (app_dir / "README.md").write_text("# app\n")
    git(app_dir, "add", "-A")
    git(app_dir, "commit", "-qm", "Initial commit")
    git(app_dir, "push", "-q", "origin", "main")
    git(app_dir, "checkout", "-qb", "feature/x")
    (app_dir / "f.txt").write_text("f\n")
    git(app_dir, "add", "-A")
    git(app_dir, "commit", "-qm", "feature")
    git(app_dir, "push", "-q", "origin", "feature/x")
    git(app_dir, "checkout", "-q", "main")
    git(app_dir, "branch", "-qD", "feature/x")
    (app_dir / "README.md").write_text("# app\nmore\n")
    git(app_dir, "commit", "-qam", "Second commit")
    (app_dir / "README.md").write_text("# app\nmore\nand more\n")
    (app_dir / "new file.txt").write_text("n\n")
    (app_dir / "other.txt").write_text("o\n")
    # a repo two levels down, and a sibling repo
    (ws / "plain" / "tools").mkdir(parents=True)
    git(ws / "plain" / "tools", "init", "-q", "-b", "main")
    (ws / "lib").mkdir()
    git(ws / "lib", "init", "-q", "-b", "develop")
    return {"ws": ws, "app": app_dir, "origin": origin, "tmp": tmp_path}


def _login(client):
    assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200


def _session(client, path, dirs=()):
    r = client.post("/api/sessions", json={"provider": "claude", "model": "sonnet", "connection_id": None,
                                           "workspace_path": str(path), "title": "t", "extra_dirs": [str(d) for d in dirs]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_parse_status_porcelain_v2():
    out = "\n".join([
        "/r",
        "@@remote", "https://user:secret@github.com/acme/widgets.git",
        "@@status",
        "# branch.oid 0123456789abcdef", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1",
        "1 .M N... 100644 100644 100644 aaa bbb src/a b.py",
        "1 A. N... 000000 100644 100644 000 ccc new.py",
        "1 D. N... 100644 000000 000000 ddd 000 gone.py",
        "2 R. N... 100644 100644 100644 eee eee R100 renamed.py\told.py",
        "u UU N... 100644 100644 100644 100644 a b c conflict.py",
        "? untracked dir/",
        "@@log", "abc1234\x1fFix the thing\x1fDev\x1f2026-11-01T10:00:00+09:00",
    ])
    st = parse_status(out)
    assert st["root"] == "/r" and st["repo"] == "acme/widgets"
    assert "secret" not in st["remote"]
    assert (st["branch"], st["upstream"], st["ahead"], st["behind"]) == ("main", "origin/main", 2, 1)
    assert st["changes"] == 6
    assert st["counts"] == {"staged": 3, "modified": 1, "untracked": 1, "conflicted": 1, "deleted": 1, "added": 1}
    assert [f["path"] for f in st["files"]] == ["src/a b.py", "new.py", "gone.py", "renamed.py", "conflict.py", "untracked dir/"]
    assert [f["status"] for f in st["files"]] == ["M", "A", "D", "R", "U", "?"]
    assert st["last_commit"] == {"sha": "abc1234", "subject": "Fix the thing", "author": "Dev", "date": "2026-11-01T10:00:00+09:00"}
    assert parse_status("@@norepo") == {"is_repo": False}
    detached = parse_status("/r\n@@status\n# branch.oid 0123456789abcdef\n# branch.head (detached)\n")
    assert detached["detached"] and detached["branch"] == "01234567"


def test_qpath():
    assert qpath("/a b/c") == "'/a b/c'"
    assert qpath("~/proj x") == "\"$HOME\"/'proj x'"
    assert qpath("~") == '"$HOME"'
    assert qpath("/x'; rm -rf /") == "'/x'\"'\"'; rm -rf /'"


def test_status_branches_switch(repo):
    with TestClient(app) as client:
        _login(client)
        sid = _session(client, repo["app"])
        st = client.get(f"/api/sessions/{sid}/git").json()
        assert st["mode"] == "auto" and st["connected"] is True
        assert st["root"] == str(repo["app"]) and st["branch"] == "main" and st["upstream"] == "origin/main"
        assert (st["ahead"], st["behind"]) == (1, 0)
        assert st["changes"] == 3 and st["counts"]["modified"] == 1 and st["counts"]["untracked"] == 2
        assert {f["path"] for f in st["files"]} == {"README.md", "new file.txt", "other.txt"}
        assert st["last_commit"]["subject"] == "Second commit"
        assert st["remote"] == str(repo["origin"])
        assert st["repo"] == "app"  # a local-path remote: the folder's name, not "<dir>/origin"

        br = client.get(f"/api/sessions/{sid}/git/branches").json()
        assert br["current"] == "main"
        assert [b["name"] for b in br["local"]] == ["main"]
        assert [b["name"] for b in br["remote"]] == ["origin/feature/x"]  # origin/main has a local branch

        # git's own refusal reaches the UI (README.md differs on that branch)
        r = client.post(f"/api/sessions/{sid}/git/checkout", json={"branch": "origin/feature/x", "track": True})
        assert r.status_code == 409 and "would be overwritten" in r.json()["detail"]
        git(repo["app"], "checkout", "--", "README.md")
        # a remote branch: switch creates the tracking branch (untracked files come along)
        r = client.post(f"/api/sessions/{sid}/git/checkout", json={"branch": "origin/feature/x", "track": True})
        assert r.status_code == 200, r.text
        assert r.json()["branch"] == "feature/x" and r.json()["upstream"] == "origin/feature/x"
        assert client.post(f"/api/sessions/{sid}/git/checkout", json={"branch": "main"}).json()["branch"] == "main"

        for bad in ("-f", "a..b", "x;rm -rf /", "x y", "$(id)", "a/", "a.lock", ""):
            assert client.post(f"/api/sessions/{sid}/git/checkout", json={"branch": bad}).status_code == 400, bad
        r = client.post(f"/api/sessions/{sid}/git/checkout", json={"branch": "nope"})
        assert r.status_code == 409 and "nope" in r.json()["detail"]

        # never while the agent works in the chat
        svc = app.state.session_service
        svc._tasks[sid] = object()
        try:
            assert client.post(f"/api/sessions/{sid}/git/checkout", json={"branch": "main"}).status_code == 409
        finally:
            svc._tasks.pop(sid, None)


def test_detect_connect_disconnect(repo):
    ws = repo["ws"]
    with TestClient(app) as client:
        _login(client)
        sid = _session(client, ws / "plain", dirs=[ws / "lib"])  # the workspace is not a repo
        st = client.get(f"/api/sessions/{sid}/git").json()
        assert st["mode"] == "auto" and st["connected"] is False

        found = client.get(f"/api/sessions/{sid}/git/detect").json()["repos"]
        by = {r["path"]: r for r in found}
        assert set(by) == {str(ws / "plain" / "tools"), str(ws / "lib")}
        assert by[str(ws / "lib")]["where"] == "folder" and by[str(ws / "lib")]["branch"] == "develop"
        assert by[str(ws / "plain" / "tools")]["where"] == "workspace"

        # connect one found in the chat's folders
        st = client.put(f"/api/sessions/{sid}/git", json={"path": str(ws / "lib")}).json()
        assert st["mode"] == "set" and st["connected"] and st["branch"] == "develop" and st["initial"] is True
        assert client.get(f"/api/sessions/{sid}").json()["git_repo"] == str(ws / "lib")

        # a repo outside the chat's folders: only with its folder (e.g. a fresh clone)
        r = client.put(f"/api/sessions/{sid}/git", json={"path": str(repo["app"])})
        assert r.status_code == 400
        st = client.put(f"/api/sessions/{sid}/git", json={"path": str(repo["app"]), "add_folder": True}).json()
        assert st["root"] == str(repo["app"])
        assert client.get(f"/api/sessions/{sid}").json()["extra_dirs"] == [str(ws / "lib"), str(repo["app"])]

        # not a repo
        assert client.put(f"/api/sessions/{sid}/git", json={"path": str(repo["tmp"])}).status_code == 400

        # disconnect: off (even though the workspace has repos around)
        assert client.delete(f"/api/sessions/{sid}/git").json()["connected"] is False
        st = client.get(f"/api/sessions/{sid}/git").json()
        assert st["mode"] == "off" and st["connected"] is False
        assert client.get(f"/api/sessions/{sid}/git/branches").status_code == 409

        # the repo's folder disconnected → back to the workspace's own (auto)
        client.put(f"/api/sessions/{sid}/git", json={"path": str(repo["app"])})
        client.patch(f"/api/sessions/{sid}", json={"extra_dirs": [str(ws / "lib")]})
        assert client.get(f"/api/sessions/{sid}").json()["git_repo"] is None
        assert client.get(f"/api/sessions/{sid}/git").json()["mode"] == "auto"

        assert client.get("/api/sessions/nope/git").status_code == 404


def test_needs_login():
    with TestClient(app) as client:
        assert client.get("/api/sessions/x/git").status_code == 401


class _Ssh:
    """A "remote" workspace whose shell is local sh (ssh_prefix stands in for ssh user@host)."""

    def ssh_prefix(self):
        return ["sh", "-c"]


class _Ws:
    def connector_for(self, cid):
        return _Ssh()


class _Sessions:
    def __init__(self, s):
        self.s = s

    def get(self, sid):
        return dict(self.s)

    def set_git_repo(self, sid, path, connection_id=None):
        self.s["git_repo"] = path
        self.s["git_repo_host"] = connection_id
        return dict(self.s)


def test_remote_workspace_runs_over_the_ssh_prefix(repo, monkeypatch):
    import asyncio

    home = repo["tmp"]
    monkeypatch.setenv("HOME", str(home))
    sessions = _Sessions({"id": "s", "connection_id": "c1", "workspace_path": "~/ws/app", "extra_dirs": [], "git_repo": None})
    svc = SessionGit(sessions, _Ws())
    st = asyncio.run(svc.status("s"))
    assert st["connected"] and st["branch"] == "main" and st["root"] == str(repo["app"])
    found = asyncio.run(svc.detect("s"))["repos"]
    assert [(r["path"], r["where"]) for r in found] == [(str(repo["app"]), "workspace")]  # "~/ws/app" resolved on the host
    st = asyncio.run(svc.connect("s", "~/ws/app"))  # inside the chat's folders once "~" is resolved
    assert st["mode"] == "set" and sessions.s["git_repo"] == str(repo["app"])
