import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import app

SERVER = str(Path(__file__).parent / "fixtures/mcp_server.py")


@pytest.fixture
def client():
    with TestClient(app, client=("127.0.0.1", 1234)) as client:
        assert client.get("/api/mcp").status_code == 401
        assert (
            client.post(
                "/api/auth/login", json={"username": "admin", "password": "test-pass"}
            ).status_code
            == 200
        )
        yield client
        for item in client.get("/api/mcp").json()["items"]:
            client.delete("/api/mcp/" + item["id"])


def test_mcp_api_catalog_import_round_trip_and_session_bridge_authorization(client, tmp_path):
    payload = {
        "mcpServers": {
            "Test import": {
                "command": sys.executable,
                "args": [SERVER],
                "env": {"API_KEY": "a-secret-value"},
            }
        }
    }
    imported = client.post("/api/mcp/import", json=payload)
    assert imported.status_code == 200, imported.text
    mid = imported.json()["items"][0]["id"]
    assert imported.json()["items"][0]["state"] == "disabled"
    assert "a-secret-value" not in imported.text
    assert client.post("/api/mcp/import", json=payload).json()["skipped"] == ["Test import"]
    item = client.patch("/api/mcp/" + mid, json={"enabled": True}).json()
    assert item["state"] == "connected", item
    assert item["env"] == {"API_KEY": None}
    sid = client.post(
        "/api/sessions", json={"provider": "claude", "workspace_path": str(tmp_path)}
    ).json()["id"]
    assert client.patch("/api/sessions/" + sid, json={"mcp": {mid: "yes"}}).status_code == 422
    assert (
        client.patch("/api/sessions/" + sid, json={"mcp": {"not-a-catalog-id": True}}).status_code
        == 400
    )
    assert (
        client.patch("/api/sessions/" + sid, json={"mcp": {mid: True}}).json()["mcp"][mid] is True
    )
    req = SimpleNamespace(mcp_config=None, mcp_config_file=None)
    app.state.mcp.configure(sid, req)
    token_file = req.mcp_config["mcpServers"]["geny_" + mid]["env"]["GENY_MCP_TOKEN_FILE"]
    token = Path(token_file).read_text()
    body = {
        "method": "tools/call",
        "params": {"name": "echo", "arguments": {"text": "actual bridge request"}},
    }
    response = client.post("/api/internal/mcp/call", json=body, headers={"x-mcp-token": token})
    assert response.status_code == 200, response.text
    assert response.json()["content"][0]["text"] == "echo: actual bridge request"
    assert client.post("/api/internal/mcp/call", json=body).status_code == 401
    assert (
        client.post(
            "/api/internal/mcp/call",
            json=body,
            headers={"x-mcp-token": token, "x-forwarded-for": "127.0.0.1"},
        ).status_code
        == 404
    )
    assert client.patch("/api/sessions/" + sid, json={"mcp": {mid: False}}).status_code == 200
    assert (
        client.post("/api/internal/mcp/call", json=body, headers={"x-mcp-token": token}).status_code
        == 401
    )
    client.patch("/api/mcp/" + mid, json={"name": "renamed", "env": {"API_KEY": None}})
    assert app.state.mcp.store.get(mid)["env"]["API_KEY"] == "a-secret-value"
    records = client.get("/api/admin/logs?source=mcp").json()
    assert "a-secret-value" not in json.dumps(records)
    assert "actual bridge request" not in json.dumps(records)
    client.delete("/api/sessions/" + sid)


def test_mcp_import_validates_before_any_write_and_never_echoes_secret_inputs(client):
    before = len(client.get("/api/mcp").json()["items"])
    result = client.post(
        "/api/mcp/import",
        json={
            "mcpServers": {
                "valid": {"command": sys.executable},
                "invalid": {"command": sys.executable, "env": {"KEY": ["secret-in-invalid-field"]}},
            }
        },
    )
    assert result.status_code == 422
    assert "secret-in-invalid-field" not in result.text
    assert len(client.get("/api/mcp").json()["items"]) == before
    result = client.post(
        "/api/mcp",
        json={
            "name": "test",
            "command": sys.executable,
            "headers": {"Authorization": "secret\r\nvalue"},
        },
    )
    assert result.status_code == 422 and "secret" not in result.text


def test_large_mcp_catalog_fetches_tool_details_in_pages(client):
    response = client.post(
        "/api/mcp",
        json={
            "name": "Large fixture",
            "command": sys.executable,
            "args": [SERVER],
            "env": {"FIXTURE_MANY_TOOLS": "120"},
        },
    )
    assert response.status_code == 200, response.text
    item = response.json()
    assert item["tool_count"] == 123
    assert len(item["tools"]) == 8
    assert "inputSchema" not in json.dumps(item["tools"])
    pages = [
        client.get(f"/api/mcp/{item['id']}/tools?offset={offset}&limit=50").json()
        for offset in (0, 50, 100)
    ]
    assert [len(page["items"]) for page in pages] == [50, 50, 23]
    assert [page["has_more"] for page in pages] == [True, True, False]
    assert len({tool["name"] for page in pages for tool in page["items"]}) == 123
    assert all(page["total"] == 123 for page in pages)
    assert client.get(f"/api/mcp/{item['id']}/tools?offset=-1").status_code == 422
    assert client.get(f"/api/mcp/{item['id']}/tools?limit=1000").status_code == 422
    assert app.state.mcp.entry(item["id"])["metrics"]["calls"] == 0
