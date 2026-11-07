"""Per-turn file changes from git snapshots: exact stats, patches, revert,
and the user's own index/working state left alone."""
import os
import pathlib
import subprocess

from app.providers.base import ProviderEvent
from app.services import changes as change_tracker
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


class Editor:
    """Fake one-shot engine that edits files like an agent (incl. via 'shell')."""

    name = "codex"

    def __init__(self, repo: pathlib.Path):
        self.repo = repo

    async def run_turn_stream(self, req):
        yield ProviderEvent(type="session.start", data={"provider": "codex"})
        (self.repo / "a.txt").write_text("1\ntwo\n3\n")
        (self.repo / "new.txt").write_text("hello\nworld\n")
        (self.repo / "gone.txt").unlink()
        yield ProviderEvent(type="tool.use", data={"id": "t", "name": "shell", "input": {"command": "sed -i …"}}, seq=1)
        yield ProviderEvent(type="tool.result", data={"id": "t", "output": "ok"}, seq=2)
        yield ProviderEvent(type="turn.complete", data={"text": "done", "cli_session_id": "th"}, seq=3)


async def test_turn_changes_patch_and_revert(db, tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "t@t")
    git(repo, "config", "user.name", "t")
    (repo / "a.txt").write_text("1\n2\n3\n")
    (repo / "gone.txt").write_text("bye\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "init")
    (repo / "staged.txt").write_text("mine\n")
    git(repo, "add", "staged.txt")  # the user's own staged work

    monkeypatch.setattr(ss_mod, "get_provider", lambda name: Editor(repo))
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    sid = svc.create(provider="codex", workspace_path=str(repo))["id"]

    evs = [ev async for ev in svc.run_turn(sid, "edit things")]
    types = [e.type for e in evs]
    assert types.index("turn.changes") == types.index("turn.complete") - 1  # inside the turn
    ch = next(e for e in evs if e.type == "turn.changes").data
    files = {f["path"]: f for f in ch["repos"][0]["files"]}
    assert files["a.txt"]["status"] == "M" and (files["a.txt"]["added"], files["a.txt"]["removed"]) == (1, 1)
    assert files["new.txt"]["status"] == "A" and files["new.txt"]["added"] == 2
    assert files["gone.txt"]["status"] == "D" and files["gone.txt"]["removed"] == 1
    assert "staged.txt" not in files  # pre-existing work isn't attributed to the turn
    assert (ch["files"], ch["added"], ch["removed"]) == (3, 3, 2)

    # the user's index is untouched: only their staged file is staged
    assert git(repo, "diff", "--cached", "--name-only").split() == ["staged.txt"]

    eid = next(e["eid"] for e in svc.events(sid) if e["type"] == "turn.changes")
    p = await svc.changes_patch(sid, eid, 0, "a.txt")
    assert "-2" in p and "+two" in p and "new.txt" not in p
    full = await svc.changes_patch(sid, eid, 0, None)
    assert "new.txt" in full and "gone.txt" in full

    out = await svc.revert_changes(sid, eid, None, None)
    assert sorted(out["reverted"]) == ["a.txt", "gone.txt", "new.txt"]
    assert (repo / "a.txt").read_text() == "1\n2\n3\n"
    assert (repo / "gone.txt").read_text() == "bye\n"
    assert not (repo / "new.txt").exists()
    assert git(repo, "diff", "--cached", "--name-only").split() == ["staged.txt"]  # still the user's
    assert svc.events(sid)[-1]["data"]["code"] == "changes.reverted"


async def test_no_changes_event_outside_git_or_without_edits(db, tmp_path, monkeypatch):
    plain = tmp_path / "plain"
    plain.mkdir()

    class Quiet:
        async def run_turn_stream(self, req):
            yield ProviderEvent(type="session.start", data={})
            yield ProviderEvent(type="turn.complete", data={"text": "hi"}, seq=1)

    monkeypatch.setattr(ss_mod, "get_provider", lambda name: Quiet())
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    sid = svc.create(provider="codex", workspace_path=str(plain))["id"]
    evs = [ev async for ev in svc.run_turn(sid, "hi")]
    assert "turn.changes" not in [e.type for e in evs]


async def test_a_snapshot_sees_an_edit_of_the_same_size_at_the_same_time(tmp_path):
    """Git only looks closer at a file whose time isn't older than the index's own."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "core.trustctime", "false")
    git(repo, "config", "core.checkStat", "minimal")
    file, index, past = repo / "a.txt", repo / ".git" / "index", (1_700_000_000, 1_700_000_000)
    file.write_text("v1\n")
    os.utime(file, past)
    git(repo, "add", "-A")
    os.utime(index, past)
    runner = change_tracker.local_runner()
    _top, before = await change_tracker.snapshot(runner, str(repo))

    file.write_text("v2\n")
    os.utime(file, past)
    _top, after = await change_tracker.snapshot(runner, str(repo))

    assert after != before
