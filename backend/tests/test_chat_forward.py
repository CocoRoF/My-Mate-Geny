"""+ → 대화 전달 (docs/chat-forward.md): another chat's conversation forwarded into this one — its transcript as the user
sees it, a pending attachment of the composer, and in the message the agent gets, in full, whatever the engine."""

import json

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.providers._attachments import compose_text
from app.providers.base import ProviderEvent, TurnRequest
from app.providers.claude_code import ClaudeCodeProvider
from app.services.attachment_service import AttachmentService
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


@pytest.fixture
def chats(db, tmp_path, monkeypatch):
    """Two chats: "Deploy" (a turn with a command and an answer, a message the user deleted) and an empty one."""
    monkeypatch.setattr(settings, "uploads_root", str(tmp_path / "uploads"))
    vault = SecretVault(db)
    atts = AttachmentService(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)), attachments=atts)
    src = svc.create(provider="claude", workspace_path=str(tmp_path), title="Deploy the website")["id"]
    here = svc.create(provider="codex", workspace_path=str(tmp_path), title="Release notes")["id"]
    svc._add_message(src, "user", "7.2.0 웹사이트 배포해 줘")
    svc._add_event(src, ProviderEvent(type="session.start", data={"provider": "claude"}))
    svc._add_event(src, ProviderEvent(type="tool.use", data={"name": "Bash", "input": {"command": "npm run deploy"}}))
    svc._add_message(src, "assistant", "배포 끝났어요. https://example.test 에서 7.2.0 확인됨.", provider="claude")
    gone = svc._add_message(src, "user", "my password is hunter2")
    svc.hide_message(src, gone)
    return svc, atts, src, here


def test_the_forward_is_the_conversation_as_the_user_sees_it(chats):
    svc, atts, src, here = chats
    att = svc.forward(here, src)
    assert att["origin"] == "forward" and att["kind"] == "file" and att["name"] == "Deploy the website.md"
    row = atts.get(att["id"])
    assert row["session_id"] == here and row["message_id"] is None  # (a pending attachment of this chat's composer)
    doc = open(row["path"], encoding="utf-8").read()
    assert doc.startswith("# Conversation forwarded from the chat “Deploy the website”")
    assert "[User]\n7.2.0 웹사이트 배포해 줘" in doc and "npm run deploy" in doc and "7.2.0 확인됨" in doc
    assert "hunter2" not in doc  # (what they deleted from their view stays out)
    assert "- Agent: Claude Code" in doc and "- Exchanges: 1" in doc
    with pytest.raises(ValueError):
        svc.forward(here, here)
    with pytest.raises(KeyError):
        svc.forward(here, "sess_nope")


def test_sent_it_goes_into_the_message_in_full_for_every_engine(chats):
    svc, atts, src, here = chats
    att = svc.forward(here, src)
    [row] = atts.pending(here, [att["id"]])
    a = atts.to_provider(row)
    assert a.forwarded
    # a coding agent: in the message itself, not only a path to open
    req = TurnRequest(messages=[{"role": "user", "content": "이거 이어서 릴리즈 노트 써 줘"}], model="sonnet",
                      cwd=svc.get(here)["workspace_path"], attachments=[a])
    text = json.loads(ClaudeCodeProvider()._build_stdin(req))["message"]["content"]
    text = text if isinstance(text, str) else text[-1]["text"]
    assert text.startswith("이거 이어서 릴리즈 노트 써 줘")
    assert '<forwarded_chat id="' + a.id + '"' in text and "npm run deploy" in text and "<attachments>" not in text
    # nothing written: told what it is and what to do with it
    alone = compose_text("", [a], inline_images=False)
    assert alone.startswith("(No message text — the user forwarded the conversation below")
    # an engine without file tools (a mate): the same, never listed as a file to read
    mate = compose_text("봐 봐", [a], inline_images=False, inline_files=True)
    assert "<forwarded_chat" in mate and "<attachments>" not in mate


def test_the_route(tmp_path):
    with TestClient(app) as client:
        assert client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"}).status_code == 200
        new = lambda title: client.post("/api/sessions", json={  # noqa: E731
            "provider": "claude", "model": "sonnet", "connection_id": None, "workspace_path": str(tmp_path),
            "title": title}).json()["id"]
        src, here = new("Other"), new("Here")
        r = client.post(f"/api/sessions/{here}/forward", json={"session_id": src})
        assert r.status_code == 200, r.text
        att = r.json()
        assert att["origin"] == "forward" and "path" not in att
        served = client.get(att["url"])
        assert served.status_code == 200 and served.headers["content-type"].startswith("text/plain")
        assert "Conversation forwarded from the chat" in served.text
        assert client.post(f"/api/sessions/{here}/forward", json={"session_id": here}).status_code == 400
        assert client.post(f"/api/sessions/{here}/forward", json={"session_id": "sess_nope"}).status_code == 404
        assert client.delete(f"/api/attachments/{att['id']}").status_code == 200  # (taken back off the composer)
