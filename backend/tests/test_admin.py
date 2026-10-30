from fastapi.testclient import TestClient

from app.main import app
from app.services.log_service import LogService


def _login(client: TestClient) -> None:
    r = client.post("/api/auth/login", json={"username": "admin", "password": "test-pass"})
    assert r.status_code == 200


def test_log_service_filters_and_stats(db):
    logs = LogService(db)
    logs.record("error", "provider", "claude exited", code="exec.cli.exited", session_id="s1",
                detail={"stderr": "x" * 50000})
    logs.record("warning", "tool", "No such file", code="Bash")
    logs.record("info", "auth", "unban", code="auth.unbanned")
    assert len(logs.list()["items"]) == 3
    assert [r["code"] for r in logs.list(level="error")["items"]] == ["exec.cli.exited"]
    assert [r["source"] for r in logs.list(q="such file")["items"]] == ["tool"]
    assert logs.list(session_id="s1")["items"][0]["detail"]["stderr"].endswith("more chars]")
    st = logs.stats()
    assert st["last_24h"] == {"error": 1, "warning": 1, "info": 1}
    assert st["by_source_24h"] == {"provider": 1, "tool": 1}
    assert len(st["hourly"]) == 24 and st["hourly"][-1]["error"] == 1
    page = logs.list(limit=2)
    assert page["has_more"] and len(page["items"]) == 2
    rest = logs.list(before_id=page["items"][-1]["id"])
    assert len(rest["items"]) == 1
    assert logs.clear() == 3


def test_admin_endpoints_and_unhandled_errors_are_logged():
    async def boom():
        raise RuntimeError("kaboom")

    app.add_api_route("/api/__test_boom", boom)
    with TestClient(app, raise_server_exceptions=False) as client:
        _login(client)
        r = client.get("/api/__test_boom")
        assert r.status_code == 500 and r.json()["log_id"]
        row = client.get(f"/api/admin/logs/{r.json()['log_id']}").json()
        assert row["source"] == "http" and "kaboom" in row["detail"]["traceback"]

        assert client.post("/api/admin/client-log", json={"message": "TypeError: x is undefined",
                                                          "stack": "at foo"}).json()["ok"]
        assert client.get("/api/admin/logs", params={"source": "client"}).json()["items"]

        sysinfo = client.get("/api/admin/system").json()
        assert {"counts", "storage", "cli", "active_runs"} <= set(sysinfo)
        assert "attempts" in client.get("/api/admin/security").json()


def test_failed_login_is_logged():
    with TestClient(app) as client:
        r = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
        assert r.status_code == 401
        _login(client)  # clears the failure so the test IP is not banned
        items = client.get("/api/admin/logs", params={"source": "auth"}).json()["items"]
        assert any(i["code"] == "auth.login_failed" for i in items)
