"""Built-in mates: the bundled ailism characters (app/mate/builtin) exist out
of the box, serve their files, survive restarts, and respect the user's
deletions and edits."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.mate import files
from app.mate.service import MateService
from app.mate.store import MateStore
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


def _service(db):
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    return MateService(svc, MateStore(db, vault))


def test_bundled_characters_are_mates_out_of_the_box(db):
    assert files.builtin_keys() == ["estelle", "chaerin", "seoa"]
    mates = _service(db).list()
    by_key = {m["builtin"]: m for m in mates}
    assert set(by_key) == {"estelle", "chaerin", "seoa"} and len(mates) == 3  # no extra "Geny"
    est = by_key["estelle"]
    assert est["is_default"] and est["name"] == "에스텔 루미나르"
    assert est["avatar"]["kind"] == "video" and len(est["avatar"]["rig"]["clips"]) >= 10
    assert est["avatar"]["rig"]["home"].startswith("/api/mates/builtin/estelle/")
    assert est["llm"]["model"] == "claude-sonnet-5-5"
    assert "Your world:" in est["persona"]["description"]
    tts = {k: m["voice"]["tts"] for k, m in by_key.items()}
    assert tts["chaerin"]["ref"] and tts["chaerin"]["ref_text"] and tts["estelle"]["instruct"]


def test_sync_is_idempotent_respects_deletes_and_edits(db):
    mates = _service(db)
    est = mates.store.by_builtin("estelle")
    # a restart (new service on the same DB) creates nothing new
    _service(db)
    assert len(mates.store.list()) == 3
    # the user edits Estelle: a newer bundle no longer overwrites her
    mates.update(est["id"], {"persona": {"greeting": "mine"}})
    mates.store.mark_builtin(est["id"], "estelle", "old-version")
    mates.sync_builtins()
    assert mates.get(est["id"])["persona"]["greeting"] == "mine"
    # an unedited one is refreshed when the bundle changes
    seoa = mates.store.by_builtin("seoa")
    mates.store.mark_builtin(seoa["id"], "seoa", "old-version")
    mates.sync_builtins()
    assert mates.store.by_builtin("seoa")["builtin_hash"] == files.builtin_hash("seoa")
    # deleting a built-in keeps it deleted across restarts, until restored
    mates.delete(seoa["id"])
    _service(db).sync_builtins()
    assert mates.store.by_builtin("seoa") is None
    restored = mates.restore_builtins()
    assert any(m["builtin"] == "seoa" for m in restored)


def test_builtin_files_are_served_and_confined():
    with TestClient(app) as client:
        assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        est = next(m for m in client.get("/api/mates").json() if m["builtin"] == "estelle")
        home = client.get(est["avatar"]["rig"]["home"])
        assert home.status_code == 200 and home.headers["content-type"] == "image/webp"
        clip = est["avatar"]["rig"]["clips"][0]["src"]
        part = client.get(clip, headers={"Range": "bytes=0-99"})
        assert part.status_code == 206 and len(part.content) == 100
        assert client.get("/api/mates/builtin/estelle/..%2F..%2Fmates%2Festelle.json").status_code == 404
        assert client.get("/api/mates/builtin/nobody/neutral.webp").status_code == 404
