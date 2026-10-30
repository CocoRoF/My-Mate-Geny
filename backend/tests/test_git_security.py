"""Git integration never leaks tokens and can't be pointed elsewhere."""
import os
import subprocess

import pytest

from app.config import settings
from app.services.git_service import GitError, GitService, git_info, strip_userinfo
from app.vault import SecretVault


def test_strip_userinfo():
    assert strip_userinfo("https://x-access-token:ghp_SECRET@github.com/o/r.git") == "https://github.com/o/r.git"
    assert strip_userinfo("https://github.com/o/r.git") == "https://github.com/o/r.git"
    assert strip_userinfo("git@github.com:o/r.git") == "git@github.com:o/r.git"


def test_git_info_never_returns_tokens():
    def run(args):
        if args[:2] == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n"
        if args[:2] == ["remote", "get-url"]:
            return 0, "https://oauth2:glpat-SECRET@gitlab.example.com/a/b.git\n"
        return 0, "main\n" if args[0] == "branch" else ""
    info = git_info(run)
    assert "SECRET" not in info["remote"] and info["repo"] == "a/b"


def _account(db, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "repos_root", str(tmp_path / "repos"))
    svc = GitService(db, SecretVault(db))
    ref = "git:test.token"
    SecretVault(db).write(ref, "TOKEN123") if hasattr(SecretVault(db), "write") else None
    db.execute(
        "INSERT INTO git_accounts (id, provider, label, host, username, token_ref, scopes, can_push, created_at) "
        "VALUES ('ga1', 'github', 'me', NULL, 'me', ?, 'repo', 1, 'now')", (ref,))
    monkeypatch.setattr(svc, "_token", lambda aid: ({"id": "ga1", "provider": "github", "host": None, "username": "me"}, "TOKEN123"))
    return svc


def test_clone_rejects_foreign_hosts_and_traversal(db, monkeypatch, tmp_path):
    svc = _account(db, monkeypatch, tmp_path)
    with pytest.raises(GitError):
        svc.clone("ga1", "o/r", "https://evil.example/o/r.git")  # token would go to evil.example
    with pytest.raises(GitError):
        svc.clone("ga1", "o/r", "http://github.com/o/r.git")
    with pytest.raises(GitError):
        svc.clone("ga1", "../../../../home/x", "https://github.com/o/r.git")
    with pytest.raises(GitError):
        svc.clone("ga1", "o/..", "https://github.com/o/r.git")


def test_clone_keeps_origin_clean_and_credentials_outside(db, monkeypatch, tmp_path):
    svc = _account(db, monkeypatch, tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    subprocess.run(["git", "init", "-q", str(src)], check=True)
    (src / "f").write_text("x")
    subprocess.run(["git", "-C", str(src), "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], check=True)
    subprocess.run(["git", "-C", str(src), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], check=True)
    # Point the "remote" at a local bare path through git's url rewriting.
    real = subprocess.run
    def fake_run(argv, **kw):
        if "clone" in argv:
            argv = [*argv[:-2], str(src), argv[-1]]
        return real(argv, **kw)
    monkeypatch.setattr("app.services.git_service.subprocess.run", fake_run)
    out = svc.clone("ga1", "o/r", "https://github.com/o/r.git")
    dest = out["path"]
    origin = subprocess.run(["git", "-C", dest, "remote", "get-url", "origin"], capture_output=True, text=True).stdout
    assert "TOKEN123" not in origin
    helpers = subprocess.run(["git", "-C", dest, "config", "--local", "--get-all", "credential.helper"],
                             capture_output=True, text=True).stdout.splitlines()
    cred = helpers[-1].split("--file=")[1]
    assert not cred.startswith(dest) and oct(os.stat(cred).st_mode & 0o777) == "0o600"
    assert "TOKEN123" in open(cred).read()
    assert "TOKEN123" not in open(os.path.join(dest, ".git", "config")).read()
    svc.delete("ga1")
    assert not os.path.exists(cred)
