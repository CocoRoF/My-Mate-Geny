from fastapi.testclient import TestClient

from app.main import app


def _login(client: TestClient) -> None:
    r = client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"})
    assert r.status_code == 200


def test_health_is_public():
    with TestClient(app) as client:
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json()["service"] == "hr-harnessor"


def test_config_requires_auth():
    with TestClient(app) as client:
        r = client.get("/api/config")
        assert r.status_code == 401


def test_config_after_login():
    with TestClient(app) as client:
        _login(client)
        r = client.get("/api/config")
        assert r.status_code == 200
        assert set(r.json()["providers"]) == {"claude", "codex"}


def test_bad_password_rejected():
    with TestClient(app) as client:
        r = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
        assert r.status_code in (401, 403)
