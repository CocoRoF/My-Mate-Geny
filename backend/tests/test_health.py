from fastapi.testclient import TestClient

from app.main import app


def _login(client: TestClient) -> None:
    r = client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"})
    assert r.status_code == 200


def test_health_is_public():
    with TestClient(app) as client:
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json()["service"] == "my-mate-geny"


def test_config_requires_auth():
    with TestClient(app) as client:
        r = client.get("/api/config")
        assert r.status_code == 401


def test_config_after_login():
    with TestClient(app) as client:
        _login(client)
        r = client.get("/api/config")
        assert r.status_code == 200
        assert set(r.json()["providers"]) == {"claude", "codex", "anthropic", "openai", "google"}


def test_bad_password_rejected():
    with TestClient(app) as client:
        r = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
        assert r.status_code in (401, 403)


def test_bearer_token_auth():
    # Native clients authenticate with the token (returned in the login body)
    # via Authorization: Bearer, no cookie.
    with TestClient(app) as client:
        r = client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"})
        token = r.json()["token"]
        client.cookies.clear()
        r2 = client.get("/api/config", headers={"Authorization": f"Bearer {token}"})
        assert r2.status_code == 200


def test_cross_origin_post_with_cookie_is_blocked():
    with TestClient(app) as client:
        _login(client)
        r = client.post("/api/sessions", json={"provider": "claude", "workspace_path": "/tmp", "title": "x"},
                        headers={"Origin": "https://evil.example"})
        assert r.status_code == 403
        ok = client.post("/api/sessions", json={"provider": "claude", "workspace_path": "/tmp", "title": "x"},
                         headers={"Origin": "http://testserver"})
        assert ok.status_code == 200
    with TestClient(app) as anon:
        assert anon.get("/login-anything").status_code == 401  # not public by prefix
