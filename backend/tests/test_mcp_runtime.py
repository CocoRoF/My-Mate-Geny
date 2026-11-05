import asyncio
import json
import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import psutil
import pytest
from test_sessions import _services

from app.mcp_runtime.service import McpService
from app.mcp_runtime.store import Definition, McpStore
from app.providers.base import TurnRequest
from app.providers.codex import CodexProvider
from app.services.log_service import LogService
from app.vault import SecretVault

SERVER = str(Path(__file__).parent / "fixtures/mcp_server.py")


def definition(**values):
    return {"name": "Test MCP", "command": sys.executable, "args": [SERVER], **values}


def test_mcp_catalog_encrypts_config_and_preserves_write_only_keys(db):
    store = McpStore(db, SecretVault(db))
    spec = store.save(
        "one",
        definition(
            env={"SERVICE_KEY": "secret-12345"}, headers={"Authorization": "Bearer secret-98765"}
        ),
        create=True,
    )
    assert store.public(spec)["env"] == {"SERVICE_KEY": None}
    assert "secret-" not in json.dumps(store.public(spec))
    store.save("one", {"name": "Renamed", "env": {"SERVICE_KEY": None}})
    assert store.get("one")["env"]["SERVICE_KEY"] == "secret-12345"
    assert b"secret-12345" not in bytes(
        db.query_one("SELECT ciphertext FROM secrets WHERE scope='mcp'")["ciphertext"]
    )
    store.save("one", {"env": {}})
    assert store.get("one")["env"] == {}
    store.delete("one")
    assert store.ids() == []


@pytest.mark.parametrize(
    "patch",
    [
        {"transport": "http", "url": "file:///etc/passwd"},
        {"transport": "http", "url": "https://user:secret@host/mcp"},
        {"headers": {"Authorization": "secret\r\nX: yes"}},
        {"headers": {"Host": "elsewhere"}},
        {"env": {"INVALID=KEY": "value"}},
        {"args": ["\0"]},
        {"enabled": "true"},
        {"unexpected": True},
    ],
)
def test_mcp_config_validation(patch):
    with pytest.raises(ValueError):
        Definition.model_validate(definition(**patch))


def test_managed_mcp_timeouts_reach_both_cli_engines(db, tmp_path):
    # No external process: check the config each engine actually consumes.
    sessions = _services(db)
    svc = McpService(db, SecretVault(db), sessions, LogService(db))
    sessions.mcp = svc
    try:
        svc.store.save("timing", definition(timeout_s=900), create=True)
        sid = sessions.create(provider="claude", model="sonnet", workspace_path=str(tmp_path))["id"]
        sessions.update(sid, mcp={"timing": True})
        req = TurnRequest(messages=[], model="test", cwd=str(tmp_path))
        svc.configure(sid, req)
        spec = json.loads(Path(req.mcp_config_file).read_text())["mcpServers"]["geny_timing"]
        assert spec["timeout"] == 910000 and req.extra_env["MCP_TIMEOUT"] == "35000"
        args = CodexProvider._mcp_overrides(req)
        assert "mcp_servers.geny_timing.tool_timeout_sec=910" in args
        assert "mcp_optional_startup_grace_ms=0" in args
    finally:
        svc.logger.removeHandler(svc.log_handler)
        svc.logger.propagate = svc.previous_propagate
        svc.directory.cleanup()


@pytest.mark.asyncio
async def test_dead_stdio_server_is_reported_and_can_be_reconnected(db, tmp_path, monkeypatch):
    from app.mcp_runtime import client

    monkeypatch.setattr(client, "HEALTH_INTERVAL", 0.1)
    sessions = _services(db)
    svc = McpService(db, SecretVault(db), sessions, LogService(db))
    pidfile = tmp_path / "pid"
    try:
        item = await svc.save(definition(env={"FIXTURE_PID": str(pidfile)}))
        psutil.Process(int(pidfile.read_text())).kill()
        for _ in range(100):
            if svc.entry(item["id"])["state"] != "connected":
                break
            await asyncio.sleep(0.05)
        assert svc.entry(item["id"])["state"] == "error"
        assert (await svc.connect(item["id"], force=True))["state"] == "connected"
    finally:
        await svc.stop()


@pytest.mark.asyncio
async def test_deadline_cancels_upstream_without_disconnecting_other_calls(db, tmp_path):
    sessions = _services(db)
    svc = McpService(db, SecretVault(db), sessions, LogService(db))
    marker = tmp_path / "deadline.pid"
    try:
        item = await svc.save(definition(env={"FIXTURE_PID": str(marker)}))
        connection = svc.clients[item["id"]]
        connection.spec["timeout_s"] = 0.15
        with pytest.raises(TimeoutError):
            await connection.request("tools/call", {"name": "slow", "arguments": {"seconds": 30}})
        for _ in range(50):
            if marker.with_suffix(".pid.cancelled").exists():
                break
            await asyncio.sleep(0.02)
        else:
            pytest.fail("Deadline left upstream work running")
        connection.spec["timeout_s"] = 120
        assert connection.state == "connected"
        assert (
            await connection.request("tools/call", {"name": "echo", "arguments": {"text": "alive"}})
        )["content"][0]["text"] == "echo: alive"
    finally:
        await svc.stop()


@pytest.mark.asyncio
async def test_real_stdio_catalog_proxy_selections_revocation_logs_and_shutdown(db, tmp_path):
    sessions = _services(db)
    svc = McpService(db, SecretVault(db), sessions, LogService(db))
    sessions.mcp = svc
    sid = sessions.create(provider="claude", model="sonnet", workspace_path=str(tmp_path))["id"]
    other = sessions.create(provider="codex", model="gpt-test", workspace_path=str(tmp_path))["id"]
    pidfile = tmp_path / "mcp.pid"
    try:
        registered = await svc.save(
            definition(
                log_stderr=True,
                env={"FIXTURE_KEY": "secret-for-redaction", "FIXTURE_PID": str(pidfile)},
            )
        )
        mid = registered["id"]
        assert registered["state"] == "connected", registered["error"]
        assert {t["name"] for t in registered["tools"]} == {"echo", "slow", "inherited_secrets"}
        assert sessions.get(sid)["mcp"] == {}
        with pytest.raises(PermissionError):
            await svc.request(sid, mid, "tools/call", {"name": "echo", "arguments": {"text": "x"}})
        sessions.update(sid, mcp={mid: True})
        req = SimpleNamespace(
            mcp_config={"mcpServers": {"remote": {"command": "old"}}}, mcp_config_file=None
        )
        svc.configure(sid, req)
        assert "remote" in req.mcp_config["mcpServers"]
        bridge = req.mcp_config["mcpServers"]["geny_" + mid]
        assert "secret-for-redaction" not in json.dumps(bridge)
        token = Path(bridge["env"]["GENY_MCP_TOKEN_FILE"]).read_text()
        assert svc.token_info(token) == (sid, mid)
        assert Path(req.mcp_config_file).stat().st_mode & 0o777 == 0o600
        echo = await svc.request(
            sid, mid, "tools/call", {"name": "echo", "arguments": {"text": "joined"}}
        )
        assert echo["content"][0]["text"] == "echo: joined"
        inherited = await svc.request(sid, mid, "tools/call", {"name": "inherited_secrets"})
        assert inherited["content"][0]["text"] == "none"
        assert "fixture://hello" in json.dumps(await svc.request(sid, mid, "resources/list", {}))
        assert "fixture resource" in json.dumps(
            await svc.request(sid, mid, "resources/read", {"uri": "fixture://hello"})
        )
        assert "Hello tester" in json.dumps(
            await svc.request(
                sid, mid, "prompts/get", {"name": "greeting", "arguments": {"name": "tester"}}
            )
        )
        with pytest.raises(PermissionError):
            await svc.request(other, mid, "tools/call", {"name": "echo"})
        slow = asyncio.create_task(svc.request(sid, mid, "tools/call", {"name": "slow"}))
        await asyncio.sleep(0.1)
        sessions.update(sid, mcp={mid: False})
        assert svc.token_info(token) is None
        assert not Path(bridge["env"]["GENY_MCP_TOKEN_FILE"]).exists()
        with pytest.raises(asyncio.CancelledError):
            await slow
        for _ in range(50):
            if pidfile.with_suffix(".pid.cancelled").exists():
                break
            await asyncio.sleep(0.02)
        else:
            pytest.fail("Session revocation did not cancel the upstream tool before disconnect")
        assert svc.entry(mid)["state"] == "connected"
        assert "secret-for-redaction" not in json.dumps(svc.logs.list(source="mcp"))
        assert any(
            row["code"] == "mcp.stderr" and "[redacted]" in row["message"]
            for row in svc.logs.list(source="mcp")["items"]
        )
        assert "joined" not in json.dumps(svc.logs.list(source="mcp"))
        assert svc.entry(mid)["metrics"]["calls"] >= 5
        # A second service uses the same encrypted DB values after a restart.
        pid = int(pidfile.read_text())
        await svc.stop()
        assert not psutil.pid_exists(pid)
        svc = McpService(db, SecretVault(db), sessions, LogService(db))
        sessions.mcp = svc
        await svc.start()
        await svc.startup
        assert svc.entry(mid)["state"] == "connected"
        assert sessions.get(sid)["mcp"][mid] is False
        assert svc.store.get(mid)["env"]["FIXTURE_KEY"] == "secret-for-redaction"
    finally:
        await svc.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("transport", ["http", "sse"])
async def test_real_http_and_sse_connections_authentication_and_resource_catalog(
    db, tmp_path, transport
):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    process = subprocess.Popen(
        [sys.executable, SERVER, transport, str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    sessions = _services(db)
    svc = McpService(db, SecretVault(db), sessions, LogService(db))
    sessions.mcp = svc
    sid = sessions.create(provider="codex", model="test", workspace_path=str(tmp_path))["id"]
    try:
        async with httpx.AsyncClient() as client:
            for _ in range(100):
                try:
                    response = await client.get(f"http://127.0.0.1:{port}/")
                    if response.status_code == 401:
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.05)
            else:
                pytest.fail("fixture failed to listen")
        item = await svc.save(
            {
                "name": "HTTP fixture",
                "transport": transport,
                "url": f"http://127.0.0.1:{port}/" + ("mcp" if transport == "http" else "sse"),
                "headers": {"x-test-key": "fixture-http-key"},
            }
        )
        assert item["state"] == "connected", item["error"]
        assert "fixture-http-key" not in json.dumps(item)
        sessions.update(sid, mcp={item["id"]: True})
        result = await svc.request(
            sid, item["id"], "tools/call", {"name": "echo", "arguments": {"text": transport}}
        )
        assert result["content"][0]["text"] == "echo: " + transport
        assert "greeting" in json.dumps(await svc.request(sid, item["id"], "prompts/list", {}))
    finally:
        await svc.stop()
        process.terminate()
        await asyncio.to_thread(process.wait, 5)
