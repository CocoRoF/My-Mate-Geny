"""[Reset her memory] (docs/mate.md): as if they had never talked, affinity included; she stays who she is."""

from __future__ import annotations

from test_mate_style import _ctx, _service

from app.mate import files
from app.providers import accounts


def _count(db, table, where, *args):
    return db.query_one(f"SELECT COUNT(*) AS n FROM {table} WHERE {where}", args)["n"]  # noqa: S608


async def test_she_forgets_everything_and_stays_who_she_is(db, tmp_path, monkeypatch):
    mates = _service(db)
    cha = mates.store.by_builtin("chaerin")
    mid, other = cha["id"], mates.store.by_builtin("seoa")["id"]
    mates.update(mid, {"prefs": {"user_name": "하렴"}})
    ctx, old_sid = await _ctx(mates, mid)
    mates._svc.seed_message(old_sid, "user", "내 고양이 이름은 나비야", provider="claude")
    mates.store.add_memory(mid, "고양이 이름은 나비", kind="fact")
    mates.store.add_memory(other, "서아의 기억은 남아야 한다", kind="fact")
    await mates.call_tool(ctx, "feel", {"emotion": "happy", "strength": "strong", "reason": "나비 얘기를 들어서"})
    mates.relation_update(mid, {"affinity": 70})
    before = mates.get(mid)
    mates.wear_outfit(mid, "builtin-gray-band")

    # what the engines keep, in the host's login and another one
    monkeypatch.setattr(accounts, "_host_config_dir", lambda p: tmp_path / "host" / ".claude")
    monkeypatch.setattr(accounts.settings, "data_home", str(tmp_path / "app"), raising=False)
    home = files.home_dir(mid)
    name = "".join(c if c.isascii() and c.isalnum() else "-" for c in str(home))
    kept = [tmp_path / "host" / ".claude" / "projects" / name, tmp_path / "app" / "accounts" / "claude" / "a1" / ".claude" / "projects" / name]
    for folder in kept:
        folder.mkdir(parents=True)
        (folder / "t.jsonl").write_text("나비")
    somebody_else = tmp_path / "host" / ".claude" / "projects" / "-another-project"
    somebody_else.mkdir(parents=True)
    codex = files.mate_dir(mid) / "codex"
    codex.mkdir(parents=True, exist_ok=True)
    (codex / "history.jsonl").write_text("나비")

    mate = mates.wipe_memory(mid)

    assert _count(db, "mate_memories", "mate_id=?", mid) == 0 and mates.store.memories(mid) == []
    assert _count(db, "memory_audit", "mate_id=?", mid) == 0
    assert _count(db, "sessions", "id=?", old_sid) == 0 and _count(db, "messages", "session_id=?", old_sid) == 0
    assert not any(folder.exists() for folder in kept) and not codex.exists() and somebody_else.exists()
    assert mates.state_view(mid)["log"] == [] and mate["state"]["label"] in ("calm", "shy", "sleepy", "happy")
    assert "나비" not in str(mates.store.state_doc(mid))

    # a new conversation, with only her greeting; the engine has nothing to resume
    sid = mate["session_id"]
    assert sid and sid != old_sid
    said = mates._svc.messages(sid)
    assert [m["role"] for m in said] == ["assistant"] and said[0]["meta"]["kind"] == "greeting"
    assert not mates._svc.get(sid).get("cli_session_id")

    # they start over: what her affinity opened is closed again, and she is back in her usual clothes
    assert mate["relation"]["affinity"] == 0 and mate["relation"]["stage"] == "new"
    assert mates.relation_view(mid)["stats"]["turns"] == 0
    assert mate["outfits"]["worn"] == "default"
    assert next(c for c in mate["outfits"]["items"] if c["id"] == "builtin-gray-band")["locked"] == {"affinity": 60}

    # who she is stays, and nobody else forgets
    assert mate["persona"] == before["persona"] and mate["avatar"] == before["avatar"]
    assert mate["prefs"]["user_name"] == "하렴"
    assert [m["text"] for m in mates.store.memories(other)] == ["서아의 기억은 남아야 한다"]
