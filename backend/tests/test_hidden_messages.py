"""Deleting what the user wrote from their view (services/hidden_messages.py): a message or a steer, with the files sent
along, is gone from every read a chat window makes — and stays whole for the engine and a mate."""

import asyncio
import io

import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient
from starlette.datastructures import Headers

from app.config import settings
from app.main import app
from app.providers.base import ProviderEvent
from app.services import hidden_messages
from app.services.attachment_service import AttachmentService
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00"
       b"\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x03\x01\x01\x00\xc9\xfe\x92\xef\x00\x00\x00\x00IEND\xaeB`\x82")


@pytest.fixture
def chat(db, tmp_path, monkeypatch):
    """A chat: the user's message with a photo, the reply, a steer with a photo, a reply — and the service."""
    monkeypatch.setattr(settings, "uploads_root", str(tmp_path / "uploads"))
    vault = SecretVault(db)
    atts = AttachmentService(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)), attachments=atts)
    sid = svc.create(provider="claude", workspace_path=str(tmp_path), title="Chat")["id"]

    async def photo(name):
        return await atts.save(sid, UploadFile(file=io.BytesIO(PNG), filename=name, headers=Headers({"content-type": "image/png"})))

    first, second = asyncio.run(photo("me.png")), asyncio.run(photo("cat.png"))
    said = svc._add_message(sid, "user", "a secret, and my photo")
    atts.link([first["id"]], said)
    svc._add_event(sid, ProviderEvent(type="session.start", data={"provider": "claude"}))
    svc._add_event(sid, ProviderEvent(type="text.delta", data={"text": "Nice photo"}))
    steer = svc._add_message(sid, "steer", "and my cat")
    atts.link([second["id"]], steer)
    svc._add_event(sid, ProviderEvent(type="user.steer", data={"text": "and my cat", "message_id": steer,
                                                               "attachments": [atts.out(second)]}))
    svc._add_event(sid, ProviderEvent(type="turn.complete", data={"text": "Nice photo. Cute cat", "cost_usd": 0.1}))
    svc._add_message(sid, "assistant", "Nice photo. Cute cat")
    return svc, sid, said, steer


def _shown(svc, sid):
    """every read a chat window makes, as (messages, events)"""
    full = (svc.messages(sid, view=True), svc.events(sid, view=True))
    page = svc.history_page(sid, turns=5)
    lite = svc.history_page(sid, turns=5, lite=True)
    return [full, (page["messages"], page["events"]), (lite["messages"], lite["events"])]


def test_a_deleted_message_and_steer_are_gone_from_every_view_with_their_files(chat):
    svc, sid, said, steer = chat
    for messages, events in _shown(svc, sid):
        assert any(m["content"] == "a secret, and my photo" and m["attachments"] for m in messages)
    svc.hide_message(sid, said)
    svc.hide_message(sid, steer)
    for messages, events in _shown(svc, sid):
        mine = {m["id"]: m for m in messages}
        for mid in (said, steer):
            assert mine[mid]["content"] == "" and mine[mid]["attachments"] == [] and set(mine[mid]["meta"]) == {"hidden"}
        assert "Nice photo. Cute cat" in [m["content"] for m in messages], "the replies stay"
        [ev] = [e for e in events if e["type"] == "user.steer"]
        assert ev["data"] == {"message_id": steer, "hidden": True, "text": "", "attachments": []}
        assert "and my cat" not in str(events) and "cat.png" not in str(events)
    # the page still starts its turn at the message (it is there, empty)
    assert svc.history_page(sid, turns=5)["page"]["turns"] == 1
    eid = next(e["eid"] for e in svc.events(sid) if e["type"] == "user.steer")
    assert svc.events_by_id(sid, [eid])[0]["data"]["hidden"] is True
    # the engine and a mate know it as it was
    whole = {m["id"]: m for m in svc.messages(sid)}
    assert whole[said]["content"] == "a secret, and my photo" and whole[said]["attachments"]
    assert whole[steer]["content"] == "and my cat"
    assert next(e for e in svc.events(sid) if e["type"] == "user.steer")["data"]["text"] == "and my cat"


def test_only_what_the_user_wrote(chat):
    svc, sid, said, _steer = chat
    reply = next(m["id"] for m in svc.messages(sid) if m["role"] == "assistant")
    made = svc._add_message(sid, "user", "[delegation result]", meta={"internal": True, "kind": "delegation_result"})
    sent = svc._add_message(sid, "user", "from your mate", meta={"via": {"kind": "mate", "name": "Seoa"}})
    for mid in (reply, made, sent):
        with pytest.raises(hidden_messages.NotYours):
            svc.hide_message(sid, mid)
    with pytest.raises(KeyError):
        svc.hide_message(sid, "msg_nope")
    other = svc.create(provider="claude", workspace_path="/tmp", title="Other")["id"]
    with pytest.raises(KeyError):
        svc.hide_message(other, said)
    assert all(not (m["meta"] or {}).get("hidden") for m in svc.messages(sid))


def test_every_window_of_the_chat_drops_it_at_once(chat):
    svc, sid, said, _steer = chat

    async def run():
        q = svc.subscribe(sid)
        svc.hide_message(sid, said)
        svc.hide_message(sid, said)  # (again: the same, no harm)
        return [q.get_nowait(), q.get_nowait()]

    got = asyncio.run(run())
    assert got[0] == {"type": "message.hidden", "data": {"message_id": said}} == got[1]
    meta = svc.messages(sid)[0]["meta"]
    assert meta["hidden"] and set(meta) == {"hidden"}


def test_through_the_api(tmp_path):
    with TestClient(app) as client:
        assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        svc = app.state.session_service
        sid = svc.create(provider="claude", workspace_path=str(tmp_path), title="Chat")["id"]
        mid = svc._add_message(sid, "user", "delete me")
        reply = svc._add_message(sid, "assistant", "ok")
        assert client.post(f"/api/sessions/{sid}/messages/{mid}/hide").json() == {"message_id": mid, "hidden": True}
        assert client.post(f"/api/sessions/{sid}/messages/{reply}/hide").status_code == 400
        assert client.post(f"/api/sessions/{sid}/messages/msg_nope/hide").status_code == 404
        shown = client.get(f"/api/sessions/{sid}/messages").json()
        assert [m["content"] for m in shown] == ["", "ok"]
        full = client.get(f"/api/history/{sid}").json()
        assert [m["content"] for m in full["messages"]] == ["", "ok"]
        page = client.get(f"/api/history/{sid}", params={"turns": 5}).json()
        assert [m["content"] for m in page["messages"]] == ["", "ok"]
