"""Relative paths the agent printed resolve to where it was really working."""

import json
import os

from app.services import path_resolver as pr


def _tool(path_key, value):
    return ("tool.use", json.dumps({"name": "Edit", "input": {path_key: value}}))


def test_relative_ref_resolves_to_the_folder_the_chat_worked_in(tmp_path):
    repo = tmp_path / "home" / "me" / "repo"
    (repo / "docs").mkdir(parents=True)
    (repo / ".git").mkdir()
    (repo / "docs" / "mate.md").write_text("x")
    (repo / "backend").mkdir()
    (repo / "backend" / "main.py").write_text("x")
    rows = [  # newest first
        _tool("file_path", str(repo / "backend" / "main.py")),
        ("turn.complete", json.dumps({"text": f"Edited `{repo}/backend/main.py` — see https://x.io/a/b too"})),
    ]
    mentioned = pr.paths_in_events(rows)
    assert str(repo / "backend" / "main.py") in mentioned
    assert not any(m.startswith("/a/") for m in mentioned)  # URL path not taken
    # the chat's workspace is "/" — joining there finds nothing
    assert pr.resolve("docs/mate.md", ["/"], mentioned) == [str(repo / "docs" / "mate.md")]
    assert pr.resolve("./docs/mate.md", ["/"], mentioned) == [str(repo / "docs" / "mate.md")]


def test_direct_hit_and_bare_filename_search(tmp_path):
    repo = tmp_path / "r"
    (repo / "src" / "deep").mkdir(parents=True)
    target = repo / "src" / "deep" / "thing.ts"
    target.write_text("x")
    mentioned = [str(target)]
    assert pr.resolve("deep/thing.ts", [str(tmp_path / "nowhere")], mentioned)[0] == str(target)
    # only the file name, no context paths: bounded search below the tried root
    assert pr.resolve("thing.ts", [str(repo)], []) == [str(target)]


def test_tried_roots_win_and_absolute_refs_are_left_alone(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "x.md").write_text("x")
    other = tmp_path / "b"
    other.mkdir()
    (other / "x.md").write_text("x")
    got = pr.resolve("x.md", [str(tmp_path / "a")], [str(other / "x.md")])
    assert got[0] == str(tmp_path / "a" / "x.md")
    assert pr.resolve("/etc/hosts", ["/"], []) == []
    assert pr.suffix_search("../x.md", [str(tmp_path)]) == []


def test_candidate_bases_rank_recent_and_frequent_folders():
    paths = ["/home/u/repo/a/b.py", "/home/u/repo/c.py", "/home/u/old/z.py"]
    bases = pr.candidate_bases(paths)
    assert bases.index("/home/u/repo") < bases.index("/home/u/old")
    assert "/home" not in bases and "/" not in bases


def test_copies_under_hidden_folders_rank_last(tmp_path):
    real = tmp_path / "repo" / "docs" / "a.md"
    copy = tmp_path / "repo" / ".claude" / "worktrees" / "w1" / "docs" / "a.md"
    for f in (real, copy):
        f.parent.mkdir(parents=True)
        f.write_text("x")
    mentioned = [str(copy), str(real)]  # the copy is the newest mention
    assert pr.resolve("docs/a.md", ["/"], mentioned)[0] == str(real)
