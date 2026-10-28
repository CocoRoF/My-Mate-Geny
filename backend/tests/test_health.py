from fastapi.testclient import TestClient

from app.main import app


def test_health():
    with TestClient(app) as client:
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["service"] == "hr-harnessor"


def test_config_lists_providers():
    with TestClient(app) as client:
        r = client.get("/api/config")
        assert r.status_code == 200
        assert set(r.json()["providers"]) == {"claude", "codex"}
