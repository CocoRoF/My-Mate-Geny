"""Additional folders on any host (app/services/folders.py, folder_routing.py, workspaces/this_host.py,
workspaces/mcp_remote_bridge.py) and Git on SSH hosts (services/session_git.py)."""

from __future__ import annotations

import asyncio
import importlib
import json
import time
import os
import pathlib
import stat
import subprocess

import pytest

from app.config import settings
from app.db import Database
from app.providers.base import ProviderEvent, TurnRequest
from app.providers.claude_code import ClaudeCodeProvider
from app.providers.codex import CodexProvider
from app.services import folder_routing, folders as folder_model
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_git import _CLONE, SessionGit, clean_clone_url, GitOpError
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from app.workspaces import this_host

FAKE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n"


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    # the connectors write key files / scratch dirs under the mount root: never the real one
    monkeypatch.setattr(settings, "mount_root", str(tmp_path / "mnt"))
    this_host.forget()
    folder_routing._eq_cache.clear()


def _stack(db):
    vault = SecretVault(db)
    conns = ConnectionService(db, vault)
    ws = WorkspaceService(conns)
    return SessionService(db, ProviderService(db, vault), ws), conns, ws


def _conn(conns, name, host="203.0.113.7", port=22):
    return conns.create(name=name, host=host, port=port, username="u", private_key_pem=FAKE_KEY,
                        default_path="/home/u")["id"]


# ---- the folder model + migration ----


def test_normalize_reads_old_and_new_shapes():
    old = ["/a", "/a/", "/b"]
    assert folder_model.normalize(old, "conn_x") == [
        {"path": "/a", "connection_id": "conn_x"}, {"path": "/b", "connection_id": "conn_x"}]
    new = [{"path": "/a", "connection_id": None}, {"path": "/a", "connection_id": "c2"}, {"bad": 1}, ""]
    assert folder_model.normalize(json.dumps(new), None) == [
        {"path": "/a", "connection_id": None}, {"path": "/a", "connection_id": "c2"}]
    assert folder_model.legacy_paths(folder_model.normalize(new, None), None) == ["/a"]


def test_old_rows_are_migrated_and_keep_working(tmp_path):
    path = tmp_path / "old.db"
    d = Database(pathlib.Path(path))
    d.bootstrap()
    d.execute("INSERT INTO sessions (id, title, provider, model, connection_id, workspace_path, extra_dirs,"
              " created_at, updated_at) VALUES ('s1','t','claude','m','conn_r','/srv/app','[\"/srv/lib\", \"/srv/x\"]',"
              " 'now','now'), ('s2','t','claude','m',NULL,'/w','[\"/w2\"]','now','now')")
    d.close()
    d = Database(pathlib.Path(path))
    d.bootstrap()  # the migration
    raw = {r["id"]: json.loads(r["extra_dirs"]) for r in d.query("SELECT id, extra_dirs FROM sessions")}
    assert raw["s1"] == [{"path": "/srv/lib", "connection_id": "conn_r"}, {"path": "/srv/x", "connection_id": "conn_r"}]
    assert raw["s2"] == [{"path": "/w2", "connection_id": None}]
    svc, _, _ = _stack(d)
    s1 = svc.get("s1")
    assert s1["extra_dirs"] == ["/srv/lib", "/srv/x"]  # the old view: the workspace's host only
    assert s1["folders"][0] == {"path": "/srv/lib", "connection_id": "conn_r"}
    d.bootstrap()  # idempotent
    d.close()


def test_folders_on_several_hosts_validated_and_legacy_updates_keep_the_others(db, tmp_path):
    svc, conns, _ = _stack(db)
    a, b = _conn(conns, "srv-a"), _conn(conns, "srv-b")
    (tmp_path / "here").mkdir()
    s = svc.create(provider="claude", connection_id=a, workspace_path="/home/u/app")
    out = svc.update(s["id"], folders=[
        {"path": str(tmp_path / "here"), "connection_id": None},
        {"path": "/home/u/lib/", "connection_id": a},
        {"path": "/data/x", "connection_id": b},
        {"path": "/home/u/app", "connection_id": a},  # the workspace itself: dropped
        {"path": "/data/x", "connection_id": b},      # duplicate: dropped
    ])
    assert out["folders"] == [{"path": str(tmp_path / "here"), "connection_id": None},
                              {"path": "/home/u/lib", "connection_id": a},
                              {"path": "/data/x", "connection_id": b}]
    assert out["extra_dirs"] == ["/home/u/lib"]
    with pytest.raises(ValueError):
        svc.update(s["id"], folders=[{"path": "/x", "connection_id": "conn_nope"}])  # not the user's connection
    with pytest.raises(ValueError):
        svc.update(s["id"], folders=[{"path": "relative/x", "connection_id": b}])
    with pytest.raises(ValueError):
        svc.update(s["id"], folders=[{"path": str(tmp_path / "missing"), "connection_id": None}])
    # an old client replaces only the workspace host's folders
    out = svc.update(s["id"], extra_dirs=["/home/u/other"])
    assert out["folders"] == [{"path": "/home/u/other", "connection_id": a},
                              {"path": str(tmp_path / "here"), "connection_id": None},
                              {"path": "/data/x", "connection_id": b}]


# ---- this host? ----


class _LocalShell:
    """An "SSH" connector whose shell is this machine (sh -c): it IS this host."""

    def __init__(self, cid="c_here", prefix=("sh", "-c")):
        from app.workspaces.remote_ssh import SshSpec

        self._spec = SshSpec(connection_id=cid, host="h", port=22, username="u", private_key_pem=None)
        self._prefix = list(prefix)

    def ssh_prefix(self):
        return self._prefix


async def test_this_host_detection_nonce_and_same_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(settings.__class__, "home_dir", property(lambda self: tmp_path / "home"))
    here = _LocalShell()
    assert await this_host.is_this_host(here) is True
    assert not list((tmp_path / "home" / "tmp").iterdir())  # the probe file is gone
    (tmp_path / "proj").mkdir()
    eq = await this_host.local_equivalents(here, [str(tmp_path / "proj"), str(tmp_path / "nope")])
    assert eq == {str(tmp_path / "proj"): str(tmp_path / "proj")}
    # a host that doesn't see our files (the nonce never comes back) is another machine
    other = _LocalShell("c_other", prefix=("sh", "-c", "echo not-it", "x"))
    assert await this_host.is_this_host(other) is False
    assert await this_host.local_equivalents(other, [str(tmp_path / "proj")]) == {}


# ---- routing: which tools reach which folder ----


async def test_plan_routes_each_host_with_an_allow_list(db, tmp_path, monkeypatch):
    svc, conns, ws = _stack(db)
    a, b = _conn(conns, "srv-2224"), _conn(conns, "srv 2222 (box)")
    (tmp_path / "local").mkdir()

    async def not_here(connector, paths):
        return {}
    monkeypatch.setattr(this_host, "local_equivalents", not_here)
    s = svc.create(provider="claude", connection_id=a, workspace_path="/home/u/app")
    s = svc.update(s["id"], folders=[{"path": str(tmp_path / "local"), "connection_id": None},
                                     {"path": "/home/u/lib", "connection_id": a},
                                     {"path": "/data/x", "connection_id": b}, {"path": "/data/y", "connection_id": b}])
    r = await folder_routing.plan(s, ws, uploads_remote="~/.hr-harnessor/uploads/" + s["id"])
    assert r.local_dirs == [str(tmp_path / "local")]
    hosts = {h["name"]: h for h in json.loads(r.mcp_config["mcpServers"]["remote"]["env"]["HRH_REMOTE_HOSTS"])}
    assert set(hosts) == {"srv-2224", "srv-2222-box"}
    assert hosts["srv-2224"]["default"] and hosts["srv-2224"]["cwd"] == "/home/u/app"
    assert hosts["srv-2224"]["roots"] == ["/home/u/app", "/home/u/lib", "~/.hr-harnessor/uploads/" + s["id"]]
    assert hosts["srv-2222-box"]["roots"] == ["/data/x", "/data/y"] and not hosts["srv-2222-box"]["default"]
    assert a in hosts["srv-2224"]["aliases"] and stat.S_IMODE(os.stat(hosts["srv-2224"]["key_file"]).st_mode) == 0o600
    assert "Folders in this chat" in r.note and 'host="srv-2222-box"' in r.note and str(tmp_path / "local") in r.note


async def test_plan_local_workspace_with_remote_folders_and_this_host_folders(db, tmp_path, monkeypatch):
    svc, conns, ws = _stack(db)
    far, same = _conn(conns, "far"), _conn(conns, "2223 (this host)")
    (tmp_path / "w").mkdir()
    (tmp_path / "mounted").mkdir()

    async def eq(connector, paths):
        return {p: p for p in paths} if connector.spec.connection_id == same else {}
    monkeypatch.setattr(this_host, "local_equivalents", eq)
    s = svc.create(provider="codex", workspace_path=str(tmp_path / "w"))
    s = svc.update(s["id"], folders=[{"path": "/srv/far", "connection_id": far},
                                     {"path": str(tmp_path / "mounted"), "connection_id": same}])
    r = await folder_routing.plan(s, ws)
    assert r.local_dirs == [str(tmp_path / "mounted")]  # the same folder here: the CLI's own tools, no SSH
    hosts = json.loads(r.mcp_config["mcpServers"]["remote"]["env"]["HRH_REMOTE_HOSTS"])
    assert [(h["name"], h["roots"], h["default"]) for h in hosts] == [("far", ["/srv/far"], False)]
    # nothing attached: no bridge, no note (a plain local chat launches as before)
    plain = svc.create(provider="claude", workspace_path=str(tmp_path / "w"))
    r2 = await folder_routing.plan(plain, ws)
    assert r2.mcp_config is None and r2.note == "" and r2.local_dirs == []


class _Capture:
    name = "claude"

    def __init__(self):
        self.reqs: list[TurnRequest] = []

    async def run_turn_stream(self, req):
        self.reqs.append(req)
        yield ProviderEvent(type="session.start", data={"model": "fake"})
        yield ProviderEvent(type="turn.complete", data={"text": "ok", "cli_session_id": "c"}, seq=1)


async def test_launch_wiring_for_both_engines(db, tmp_path, monkeypatch):
    svc, conns, _ = _stack(db)
    svc.persistent_engines = False
    a, b = _conn(conns, "srv-2224"), _conn(conns, "srv-2222")
    (tmp_path / "local").mkdir()

    async def not_here(connector, paths):
        return {}
    monkeypatch.setattr(this_host, "local_equivalents", not_here)
    cap = _Capture()
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: cap)

    async def no_snapshot(session, connector=None):
        return None
    monkeypatch.setattr(svc, "_snapshot_before", no_snapshot)  # (git snapshots would ssh to the fake hosts)
    s = svc.create(provider="claude", connection_id=a, workspace_path="/home/u/app")
    svc.update(s["id"], folders=[{"path": str(tmp_path / "local"), "connection_id": None},
                                 {"path": "/data/x", "connection_id": b}])
    q = svc.subscribe(s["id"])
    svc.start_turn(s["id"], "hi")
    while (m := await asyncio.wait_for(q.get(), timeout=10))["type"] != "run.state" or m["data"]["running"]:
        pass
    req = cap.reqs[0]
    assert req.extra_dirs == [str(tmp_path / "local")]
    assert req.cwd.startswith(str(tmp_path / "mnt"))  # the remote workspace's local scratch dir
    # Claude: --add-dir for this server's folder, the bridge for both SSH hosts, the note in the system prompt
    argv = ClaudeCodeProvider()._build_argv(req)
    assert argv[argv.index("--add-dir") + 1] == str(tmp_path / "local")
    cfg = json.loads(argv[argv.index("--mcp-config") + 1])
    hosts = json.loads(cfg["mcpServers"]["remote"]["env"]["HRH_REMOTE_HOSTS"])
    assert {h["name"]: h["roots"] for h in hosts} == {
        "srv-2224": ["/home/u/app", f"~/.hr-harnessor/uploads/{s['id']}"], "srv-2222": ["/data/x"]}
    prompt = argv[argv.index("--append-system-prompt") + 1]
    assert "Folders in this chat" in prompt and "`/data/x` on server \"srv-2222\"" in prompt
    assert "<remote_jobs>" not in prompt
    assert ClaudeCodeProvider().engine_fingerprint(req) != ClaudeCodeProvider().engine_fingerprint(
        TurnRequest(messages=req.messages, model=req.model, cwd=req.cwd, mcp_config=req.mcp_config,
                    extra_dirs=req.extra_dirs))  # the note is part of the launch: a change restarts the engine
    # Codex: the same bridge as -c mcp_servers.remote.*, the note with the message
    cx = CodexProvider()
    cargv = cx._build_argv(req)
    cfgs = [cargv[i + 1] for i, x in enumerate(cargv) if x == "-c"]
    assert any(c.startswith("mcp_servers.remote.env=") and "HRH_REMOTE_HOSTS" in c and "srv-2222" in c for c in cfgs)
    text = cx._build_prompt(req).decode()
    assert "<folders>" in text and str(tmp_path / "local") in text and "<additional_folders>" not in text

    # A remote job running: it reaches the agent with the turn's message, and the engine isn't restarted for it
    svc._on_task(s["id"], {"task_id": "remote_" + "a" * 32, "task_type": "remote_bash", "status": "running",
                           "description": "Wait for the suites", "started_at": time.time() - 600})
    svc.start_turn(s["id"], "next")
    while (m := await asyncio.wait_for(q.get(), timeout=10))["type"] != "run.state" or m["data"]["running"]:
        pass
    next_req = cap.reqs[-1]
    assert "a" * 32 in next_req.preamble and "Wait for the suites" in next_req.preamble
    assert "running 10 min" in next_req.preamble and "remote_stop" in next_req.preamble
    assert ClaudeCodeProvider().engine_fingerprint(next_req) == ClaudeCodeProvider().engine_fingerprint(req)


# ---- the bridge: host allow-list + path confinement ----


def _bridge(monkeypatch, hosts):
    base = pathlib.Path(hosts[0]['cwd']).parent / 'job-test'
    for h in hosts:
        h['job_root'] = str(base/h['name'])
    monkeypatch.setenv('HRH_REMOTE_JOBS_ROOT', str(base/'local'))
    monkeypatch.setenv('HRH_REMOTE_SESSION_ID', 'bridge-test')
    monkeypatch.setenv("HRH_REMOTE_HOSTS", json.dumps(hosts))
    import app.workspaces.mcp_remote_bridge as mod

    mod = importlib.reload(mod)
    monkeypatch.setattr(mod, "_ssh_prefix", lambda h: ["sh", "-c"])  # "remote" = a local shell
    return mod


def _txt(res):
    return res["content"][0]["text"], res["isError"]


def test_bridge_routes_hosts_and_confines_paths(monkeypatch, tmp_path):
    a, b, outside = tmp_path / "a", tmp_path / "b", tmp_path / "secret"
    for d in (a, b, outside):
        d.mkdir()
    (a / "f.txt").write_text("in a\n")
    (outside / "s.txt").write_text("nope\n")
    (a / "link").symlink_to(outside)
    mod = _bridge(monkeypatch, [
        {"name": "srv-a", "aliases": ["conn_a"], "host": "x", "cwd": str(a), "roots": [str(a)], "default": True},
        {"name": "srv-b", "aliases": ["conn_b"], "host": "y", "cwd": str(b), "roots": [str(b)], "default": False},
    ])
    names = [t["name"] for t in mod.TOOLS]
    assert names == ["remote_bash", "remote_read", "remote_write", "remote_list", "remote_poll", "remote_stop"]  # existing names retained; durable job control appended
    assert "srv-b" in mod.TOOLS[0]["inputSchema"]["properties"]["host"]["description"]
    assert _txt(mod.call("remote_read", {"path": "f.txt"})) == ("in a\n", False)  # default host, relative
    out, err = mod.call("remote_write", {"path": "new.txt", "content": "hello", "host": "srv-b"}).values()
    assert (b / "new.txt").read_text() == "hello"
    assert _txt(mod.call("remote_read", {"path": str(b / "new.txt"), "host": "CONN_B"}))[0] == "hello"  # alias
    for bad in ({"path": str(outside / "s.txt")}, {"path": "../secret/s.txt"}, {"path": "link/s.txt"},
                {"path": str(b / "new.txt")}):  # b's folder through a's host: not attached there
        text, is_err = _txt(mod.call("remote_read", bad))
        assert is_err and "refused" in text, bad
    text, is_err = _txt(mod.call("remote_write", {"path": str(outside / "w.txt"), "content": "x"}))
    assert is_err and not (outside / "w.txt").exists()
    assert _txt(mod.call("remote_bash", {"command": "pwd", "host": "srv-b"}))[0].strip() == str(b)
    text, is_err = _txt(mod.call("remote_bash", {"command": "pwd", "cwd": str(outside)}))
    assert is_err and "refused" in text
    text, is_err = _txt(mod.call("remote_list", {"host": "srv-zzz"}))
    assert is_err and "unknown host" in text
    assert "f.txt" in _txt(mod.call("remote_list", {}))[0]


def test_bridge_without_a_default_host_asks_which(monkeypatch, tmp_path):
    mod = _bridge(monkeypatch, [
        {"name": "one", "host": "x", "cwd": str(tmp_path), "roots": [str(tmp_path)]},
        {"name": "two", "host": "y", "cwd": str(tmp_path), "roots": [str(tmp_path)]},
    ])
    assert mod.TOOLS[1]["inputSchema"]["required"] == ["path", "host"]
    text, is_err = _txt(mod.call("remote_read", {"path": "x"}))
    assert is_err and "say which server" in text


def test_bridge_legacy_env_still_works(monkeypatch, tmp_path):
    monkeypatch.delenv("HRH_REMOTE_HOSTS", raising=False)
    monkeypatch.setenv("HRH_SSH_HOST", "h")
    monkeypatch.setenv("HRH_SSH_CWD", str(tmp_path))
    import app.workspaces.mcp_remote_bridge as mod

    mod = importlib.reload(mod)
    monkeypatch.setattr(mod, "_ssh_prefix", lambda h: ["sh", "-c"])
    (tmp_path / "f").write_text("ok")
    assert _txt(mod.call("remote_read", {"path": "f"})) == ("ok", False)
    monkeypatch.delenv("HRH_SSH_HOST")
    importlib.reload(mod)


# ---- Git on SSH hosts ----


class _ShellConnector:
    """A connection whose shell is local sh — stands in for ssh user@host."""

    def ssh_prefix(self):
        return ["sh", "-c"]


class _Ws:
    def __init__(self, ids):
        self.ids = ids

    def connector_for(self, cid):
        if cid not in self.ids:
            raise KeyError(cid)
        return _ShellConnector()

    def connections(self):
        return [{"id": i, "name": f"name-{i}"} for i in self.ids]


class _Sessions:
    def __init__(self, s):
        self.s = s

    def get(self, sid):
        return dict(self.s)

    def update(self, sid, folders=None):
        self.s["folders"] = folders
        return dict(self.s)

    def set_git_repo(self, sid, path, connection_id=None):
        self.s["git_repo"], self.s["git_repo_host"] = path, connection_id
        return dict(self.s)


def _git(cwd, *args):
    env = {**os.environ, "GIT_AUTHOR_NAME": "D", "GIT_AUTHOR_EMAIL": "d@x", "GIT_COMMITTER_NAME": "D",
           "GIT_COMMITTER_EMAIL": "d@x"}
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True, env=env).stdout


def _repo(path, branch="main"):
    path.mkdir(parents=True)
    _git(path, "init", "-q", "-b", branch)
    (path / "a.txt").write_text("a\n")
    _git(path, "add", "-A")
    _git(path, "commit", "-qm", "init")
    return path


async def test_git_status_detect_and_connect_on_other_hosts(tmp_path):
    ws_repo = _repo(tmp_path / "hostA" / "app")
    other = _repo(tmp_path / "hostB" / "lib", "develop")
    (other / "a.txt").write_text("changed\n")
    sessions = _Sessions({"id": "s", "connection_id": "cA", "workspace_path": str(ws_repo), "git_repo": None,
                          "folders": [{"path": str(tmp_path / "hostB"), "connection_id": "cB"}]})
    svc = SessionGit(sessions, _Ws(["cA", "cB"]))
    found = (await svc.detect("s"))["repos"]
    assert {(r["path"], r["connection_id"], r["where"]) for r in found} == {
        (str(ws_repo), "cA", "workspace"), (str(other), "cB", "folder")}
    st = await svc.connect("s", str(other), connection_id="cB")
    assert st["connected"] and st["branch"] == "develop" and st["changes"] == 1 and st["connection_id"] == "cB"
    assert sessions.s["git_repo"] == str(other) and sessions.s["git_repo_host"] == "cB"
    assert (await svc.branches("s"))["current"] == "develop"
    with pytest.raises(GitOpError):
        await svc.connect("s", str(other), connection_id="c_unknown")
    # a repo outside the folders on that host: attached with it on request
    far = _repo(tmp_path / "hostB2" / "far")
    with pytest.raises(GitOpError):
        await svc.connect("s", str(far), connection_id="cB")
    await svc.connect("s", str(far), add_folder=True, connection_id="cB")
    assert {"path": str(far), "connection_id": "cB"} in sessions.s["folders"]


def test_clean_clone_url():
    assert clean_clone_url("https://github.com/octocat/Hello-World.git", None, None) == (
        "https://github.com/octocat/Hello-World.git", "Hello-World")
    for bad in ("http://github.com/a/b", "https://u:p@github.com/a/b", "https://github.com/a/..", "ssh://g/a/b",
                "https://github.com/a/b?x=1"):
        with pytest.raises(GitOpError):
            clean_clone_url(bad, None, None)
    with pytest.raises(GitOpError):
        clean_clone_url("https://evil.example/a/b", None, "github.com")  # a token never goes to another host


def _fake_git_bin(tmp_path, src, log):
    """``git`` on PATH that asks GIT_ASKPASS like git over https would, records what it saw (argv, env,
    the answers) and then clones the local ``src`` instead of the URL."""
    real = subprocess.run(["sh", "-c", "command -v git"], capture_output=True, text=True).stdout.strip()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "git").write_text(f"""#!/bin/sh
case " $* " in *" clone "*) ;; *) exec {real} "$@";; esac
u=$("$GIT_ASKPASS" "Username for 'https://github.com': ")
p=$("$GIT_ASKPASS" "Password for 'https://$u@github.com': ")
{{ echo "ARGV $*"; env | sed 's/^/ENV /'; echo "USER $u"; echo "PASS $p"; echo "ASKPASS $GIT_ASKPASS"; }} >> {log}
for a; do dest=$a; done
exec {real} clone -q {src} "$dest"
""")
    (bin_dir / "git").chmod(0o755)
    return bin_dir


async def test_clone_over_ssh_supplies_the_token_once_and_leaves_none_behind(tmp_path, monkeypatch):
    src = _repo(tmp_path / "src")
    log = tmp_path / "git.log"
    monkeypatch.setenv("PATH", f"{_fake_git_bin(tmp_path, src, log)}:{os.environ['PATH']}")
    monkeypatch.setenv("TMPDIR", str(tmp_path / "rtmp"))
    (tmp_path / "rtmp").mkdir()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))

    class Accounts:
        def account_token(self, aid):
            return {"id": aid, "provider": "github", "username": "octo"}, "TOKEN-SECRET-123"

        def git_host(self, acc):
            return "github.com"

    (tmp_path / "ws").mkdir()
    sessions = _Sessions({"id": "s", "connection_id": "cR", "workspace_path": str(tmp_path / "ws"),
                          "git_repo": None, "folders": []})
    svc = SessionGit(sessions, _Ws(["cR"]), Accounts())
    st = await svc.clone("s", clone_url="https://github.com/octocat/Hello-World.git", account_id="ga",
                         connection_id="cR", parent="~/repos")
    dest = home / "repos" / "Hello-World"
    assert st["connected"] and st["root"] == str(dest) and st["connection_id"] == "cR"
    assert {"path": str(dest), "connection_id": "cR"} in sessions.s["folders"]
    seen = log.read_text()
    assert "USER x-access-token" in seen and "PASS TOKEN-SECRET-123" in seen  # askpass answered
    argv_env = "\n".join(ln for ln in seen.splitlines() if ln.startswith(("ARGV", "ENV")))
    assert "TOKEN-SECRET-123" not in argv_env  # never in the process list or the environment
    askpass_dir = os.path.dirname(seen.split("ASKPASS ")[1].splitlines()[0])
    assert not os.path.exists(askpass_dir) and not list((tmp_path / "rtmp").iterdir())  # temp files removed
    cfg = (dest / ".git" / "config").read_text()
    assert "TOKEN" not in cfg and "credential" not in cfg and "extraheader" not in cfg.lower()
    assert _git(dest, "remote", "get-url", "origin").strip() == str(src)  # (the fake cloned src)
    assert not (home / ".git-credentials").exists()
    # again: the folder is already a clone — connected, not cloned twice
    st = await svc.clone("s", clone_url="https://github.com/octocat/Hello-World.git", connection_id="cR",
                         parent=str(home / "repos"))
    assert st["connected"]


async def test_clone_failure_cleans_up_and_hides_the_token(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "git").write_text('#!/bin/sh\nfor a; do d=$a; done; mkdir -p "$d"; '
                                 'echo "fatal: auth failed for $("$GIT_ASKPASS" Password)"; exit 128\n')
    (bin_dir / "git").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")

    class Accounts:
        def account_token(self, aid):
            return {"id": aid, "provider": "github", "username": "o"}, "TOKEN-XYZ"

        def git_host(self, acc):
            return "github.com"

    sessions = _Sessions({"id": "s", "connection_id": "cR", "workspace_path": str(tmp_path), "git_repo": None,
                          "folders": []})
    svc = SessionGit(sessions, _Ws(["cR"]), Accounts())
    with pytest.raises(GitOpError) as exc:
        await svc.clone("s", clone_url="https://github.com/o/r.git", account_id="ga", connection_id="cR",
                        parent=str(tmp_path / "p"))
    assert "TOKEN-XYZ" not in str(exc.value) and "clone failed" in str(exc.value)
    assert not (tmp_path / "p" / "r").exists()  # no half-cloned folder left


def test_clone_script_is_posix_sh():
    assert subprocess.run(["sh", "-n", "-c", _CLONE]).returncode == 0


def test_session_file_candidates_follow_the_hosts(tmp_path):
    from fastapi import HTTPException

    from app.routers.files import _candidates

    (tmp_path / "loc").mkdir()
    s = {"connection_id": "cA", "workspace_path": "/srv/app",
         "folders": [{"path": str(tmp_path / "loc"), "connection_id": None}, {"path": "/data", "connection_id": "cB"}]}
    assert _candidates(s, "img.png", None) == [("/srv/app/img.png", "cA")]  # relative = the workspace
    assert _candidates(s, str(tmp_path / "loc" / "a.png"), None) == [(str(tmp_path / "loc" / "a.png"), None)]
    assert _candidates(s, "/data/x/y.png", None) == [("/data/x/y.png", "cB")]
    assert _candidates(s, "/data/x/y.png", None, "cB") == [("/data/x/y.png", "cB")]
    for bad in ("/srv/other/f", "../../srv/f", "/data/../srv/f"):
        with pytest.raises(HTTPException):
            _candidates(s, bad, None)
    with pytest.raises(HTTPException):
        _candidates(s, "/data/x", None, "local")  # /data is not attached on this server
