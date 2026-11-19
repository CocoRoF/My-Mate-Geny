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


# ---- nothing there: the folder it belongs in, and what in it was meant (2026-11-19: a chat on /home linked
# output/report_2100/x.docx before the run made it, Agent…_결과요약.docx after it was made again as …_결과보고.docx,
# and 심의보고서_V3-xx_….docx for six files — each said only "not found")


def _work(tmp_path):
    ws = tmp_path / "proj/workspace"
    (ws / "output/report_2100").mkdir(parents=True)
    (ws / "output/report_2100/make_report.py").write_text("x")
    ag = ws / "output/report_ag110"
    ag.mkdir()
    (ag / "Agent심의앱_1.1.0_결과보고.docx").write_text("x")
    for n in ("01", "02", "05"):
        (ag / f"심의보고서_V3-{n}_Agent1.1.0.docx").write_text("x")
    (ag / "make_report_ag110.py").write_text("x")
    # what the chat's tool calls touched (newest first), as paths_in_events gives them
    mentioned = [str(ws / "output/report_2100/make_report.py"), str(ag / "make_report_ag110.py"), str(tmp_path / "proj")]
    return ws, ag, mentioned


def test_a_file_not_made_yet_points_at_the_folder_it_will_be_in(tmp_path):
    ws, _, mentioned = _work(tmp_path)
    got = pr.near("output/report_2100/영상심의분석_2.10.0_결과보고.docx", ["/home"], mentioned)
    assert got["folder"] == str(ws / "output/report_2100") and got["own_folder"] and got["similar"] == []
    # (its own folder isn't there either: the nearest one on its way)
    got = pr.near("output/report_2101/x.docx", ["/home"], mentioned)
    assert got["folder"] == str(ws / "output") and not got["own_folder"]


def test_a_file_made_again_under_another_name_is_found_by_its_likeness(tmp_path):
    ws, ag, mentioned = _work(tmp_path)
    for ref in (str(ag / "Agent심의앱_1.1.0_결과요약.docx"), "Agent심의앱_1.1.0_결과요약.docx"):
        got = pr.near(ref, ["/home"], mentioned)
        assert got["how"] == "similar" and got["similar"] == [str(ag / "Agent심의앱_1.1.0_결과보고.docx")]
        assert got["score"] >= 0.8 and got["sure"]


def test_a_name_standing_for_several_files_finds_them(tmp_path):
    _, ag, mentioned = _work(tmp_path)
    got = pr.near("심의보고서_V3-xx_Agent1.1.0.docx", ["/home"], mentioned)
    assert got["how"] == "pattern" and [p.rsplit("/", 1)[1] for p in got["similar"]] == [
        "심의보고서_V3-01_Agent1.1.0.docx", "심의보고서_V3-02_Agent1.1.0.docx", "심의보고서_V3-05_Agent1.1.0.docx"]
    assert pr.name_pattern("index.html") is None and pr.name_pattern("box_xxl.css") is None
    assert pr.name_pattern("run_<id>.log").match("run_42.log")


def test_nothing_like_it_anywhere_says_not_found(tmp_path):
    _, _, mentioned = _work(tmp_path)
    # (a bare name nothing resembles: no folder of the chat's is "where it belongs")
    assert pr.near("no_such_thing.zzz", ["/home"], mentioned) is None
    assert pr.near("zz/yy/x.md", ["/home"], mentioned) is None
    assert pr.near("/nope/a/b.txt", [], mentioned) is None


def test_short_names_alike_are_not_opened_outright():
    names, how, score = pr.similar_names("later.md", ["mate.md", "notes.md"])
    assert names == []  # (without extensions: "later" / "mate" — not alike enough)
    names, how, score = pr.similar_names("data_v2.json", ["data_v3.json"])
    assert names == ["data_v3.json"] and not pr.sure_match("data_v2.json", names, how, score) or score >= 0.8
    assert not pr.sure_match("a1.md", ["a2.md"], "similar", 0.9)
