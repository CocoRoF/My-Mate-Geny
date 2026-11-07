import asyncio
import json
import sys
from pathlib import Path

import pytest
from test_mcp_api import client as api_client_fixture
from test_mcp_runtime import definition
from test_sessions import _services

from app.config import settings
from app.main import app
from app.mcp_runtime.catalog import definition as recipe_definition
from app.mcp_runtime.client import Connection
from app.mcp_runtime.installations import Installations
from app.mcp_runtime.service import McpService
from app.mcp_runtime.store import McpStore
from app.services.log_service import LogService
from app.vault import SecretVault


@pytest.fixture
def client():
    yield from api_client_fixture.__wrapped__()


@pytest.fixture(autouse=True)
def private_packages(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_home", str(tmp_path / "app"))


def test_browsing_catalog_downloads_and_launches_nothing(client, monkeypatch):
    monkeypatch.setattr(
        app.state.mcp.installations, "start", lambda *a: pytest.fail("Auto-download")
    )
    catalog = client.get("/api/mcp/recipes").json()
    assert [x["id"] for x in catalog["items"]] == ["atlassian"]
    assert all(x["source"].startswith("https://github.com/") for x in catalog["items"])
    assert not app.state.mcp.installations.root.exists()


def test_atlassian_recipe_has_named_cloud_and_data_center_credentials(tmp_path):
    spec = recipe_definition(
        "atlassian",
        {
            "service": "both",
            "deployment": "cloud",
            "jira_url": "https://company.atlassian.net",
            "jira_email": "fixture@example.com",
            "jira_token": "fixture-jira-secret",
            "confluence_url": "https://company.atlassian.net/wiki",
            "confluence_email": "fixture@example.com",
            "confluence_token": "fixture-confluence-secret",
            "read_only": True,
        },
        data_dir=tmp_path,
    )
    assert spec["command"] == "geny-managed" and spec["args"] == []
    assert spec["env"]["JIRA_API_TOKEN"] == "fixture-jira-secret"
    assert spec["env"]["CONFLUENCE_URL"].endswith("/wiki")
    assert spec["env"]["READ_ONLY_MODE"] == "true"
    dc = recipe_definition(
        "atlassian",
        {
            "service": "jira",
            "deployment": "server",
            "jira_url": "https://jira.internal",
            "jira_token": "fixture-pat",
        },
        data_dir=tmp_path,
    )
    assert dc["env"]["JIRA_PERSONAL_TOKEN"] == "fixture-pat"
    assert "JIRA_USERNAME" not in dc["env"]
    assert dc["env"]["READ_ONLY_MODE"] == "false"  # publishing works unless read-only is chosen
    with pytest.raises(ValueError, match="jira_url"):
        recipe_definition(
            "atlassian", {"service": "jira", "jira_token": "fixture"}, data_dir=tmp_path
        )
    with pytest.raises(ValueError, match="jira_email"):
        recipe_definition(
            "atlassian",
            {"service": "jira", "jira_url": "https://company.atlassian.net", "jira_token": "fixture"},
            data_dir=tmp_path,
        )


def test_missing_executable_and_missing_directory_are_distinct_failed_tests_not_entries(
    client, tmp_path
):
    before = len(client.get("/api/mcp").json()["items"])
    result = client.post(
        "/api/mcp/test",
        json={
            "definition": {
                "name": "Missing executable",
                "command": "geny-deliberately-missing-executable",
            }
        },
    ).json()
    assert not result["ok"] and result["error_code"] == "executable_missing"
    result = client.post(
        "/api/mcp/test", json={"definition": definition(cwd=str(tmp_path / "missing"))}
    ).json()
    assert not result["ok"] and result["error_code"] == "working_directory_missing"
    assert len(client.get("/api/mcp").json()["items"]) == before


def test_registration_promotes_exact_tested_connection_and_preserves_session_selection(
    client, tmp_path
):
    pid_file = tmp_path / "mcp.pid"
    checked = client.post(
        "/api/mcp/test",
        json={
            "definition": definition(
                env={"FIXTURE_PID": str(pid_file), "SERVICE_KEY": "fixture-secret"}
            )
        },
    ).json()
    assert checked["ok"] and checked["tool_count"] == 3
    assert "fixture-secret" not in json.dumps(checked)
    pid = int(pid_file.read_text())
    registered = client.post("/api/mcp/tests/" + checked["test_id"] + "/register").json()
    assert registered["state"] == "connected"
    assert int(pid_file.read_text()) == pid
    assert registered["env"]["SERVICE_KEY"] is None
    assert client.post("/api/mcp/tests/" + checked["test_id"] + "/register").status_code == 400
    mid = registered["id"]
    sid = client.post(
        "/api/sessions", json={"provider": "claude", "workspace_path": str(tmp_path)}
    ).json()["id"]
    client.patch("/api/sessions/" + sid, json={"mcp": {mid: True}})
    updated = client.post(
        "/api/mcp/test",
        json={"existing_id": mid, "definition": {"name": "Updated", "env": {"SERVICE_KEY": None}}},
    ).json()
    assert updated["ok"]
    assert client.post("/api/mcp/tests/" + updated["test_id"] + "/register").json()["id"] == mid
    assert client.get("/api/sessions/" + sid).json()["mcp"][mid] is True
    client.delete("/api/sessions/" + sid)


def test_saved_config_changes_after_testing_require_retest(client):
    item = client.post("/api/mcp", json=definition()).json()
    checked = client.post(
        "/api/mcp/test", json={"existing_id": item["id"], "definition": {"name": "Tested draft"}}
    ).json()
    client.patch("/api/mcp/" + item["id"], json={"name": "Changed elsewhere"})
    result = client.post("/api/mcp/tests/" + checked["test_id"] + "/register")
    assert result.status_code == 400 and "mcp_config_changed" in result.text
    assert client.get("/api/mcp").json()["items"][0]["name"] == "Changed elsewhere"


def test_credentials_in_legacy_arguments_are_write_only_and_kept_without_echo(db):
    store = McpStore(db, SecretVault(db))
    token = "ATATT" + "fixture_only_" * 8 + "=not-real"
    store.save(
        "legacy",
        {
            "name": "Old Docker",
            "command": "docker",
            "args": ["run", "-e", "JIRA_API_TOKEN=fixture-old-secret", "-e", token],
            "enabled": False,
        },
        create=True,
    )
    visible = store.public(store.get("legacy"))
    assert visible["args"] == ["run", "-e", None, "-e", None]
    assert token not in json.dumps(visible)
    store.save("legacy", {"args": visible["args"]})
    assert store.get("legacy")["args"][-1] == token
    with pytest.raises(ValueError):
        store.prepare({"name": "New", "command": "test", "args": [None]})


def test_catalog_repair_defaults_keep_saved_tokens_private(client):
    token = "ATATT" + "fixture_only_" * 8
    item = client.post(
        "/api/mcp",
        json={
            "name": "Old",
            "command": "docker",
            "args": ["run", "-i", "-e", token, "ghcr.io/sooperset/mcp-atlassian:latest"],
            "enabled": False,
        },
    ).json()
    defaults = client.get("/api/mcp/recipes/atlassian/defaults?existing_id=" + item["id"]).json()
    assert set(defaults["saved_fields"]) == {"jira_token", "confluence_token"}
    assert not defaults["values"]["jira_token"] and token not in json.dumps(defaults)


@pytest.mark.asyncio
async def test_docker_failure_reports_missing_runtime_before_any_spawn(monkeypatch):
    from app.mcp_runtime import diagnostics

    monkeypatch.setattr(diagnostics.shutil, "which", lambda *a, **kw: None)
    spec = {"id": "docker", **definition(command="docker", args=[])}
    from app.mcp_runtime.store import Definition

    spec = {
        "id": "docker",
        **Definition.model_validate({k: v for k, v in spec.items() if k != "id"}).model_dump(),
    }
    connection = Connection(spec, lambda *a: None)
    try:
        await connection.ready
        assert connection.error_code == "docker_missing"
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_test_expiry_releases_real_process(db, monkeypatch):
    import app.mcp_runtime.setup as setup

    monkeypatch.setattr(setup, "TEST_TTL", 0.15)
    service = McpService(db, SecretVault(db), _services(db), LogService(db))
    try:
        checked = await service.setup.test(definition())
        connection = service.setup.pending[checked["test_id"]]["connection"]
        await asyncio.sleep(0.4)
        assert checked["test_id"] not in service.setup.pending
        assert connection.task.done()
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_download_is_isolated_cancellable_and_survives_interpreter_path_changes(
    tmp_path, monkeypatch
):
    installs = Installations()
    calls = []

    async def version(r):
        return "0.0.1"

    async def execute(argv, job, cwd):
        calls.append(argv)
        target = Path(argv[argv.index("--target") + 1])
        meta = target / "mcp_atlassian-0.0.1.dist-info"
        meta.mkdir(parents=True)
        (meta / "METADATA").write_text("Name: mcp-atlassian\nVersion: 0.0.1\n")
        (meta / "entry_points.txt").write_text("[console_scripts]\nmcp-atlassian = fixture:main\n")

    monkeypatch.setattr(installs, "_version", version)
    monkeypatch.setattr(installs, "_exec", execute)
    assert not installs.state("atlassian")["installed"]
    installs.start("atlassian")
    await installs.tasks["atlassian"]
    assert installs.state("atlassian")["installed"]
    assert "--target" in calls[0] and "--no-build" in calls[0]
    spec = {"command": "geny-managed", "catalog_id": "atlassian", "args": [], "env": {}}
    assert installs.materialize(spec)["command"] == sys.executable
    assert (installs.root / "python-runner-v1.py").is_file()
    monkeypatch.setattr(sys, "executable", "/a/new/bundled/python")
    assert installs.materialize(spec)["command"] == "/a/new/bundled/python"

    pointer = installs.root / "atlassian" / "current.json"
    pointer.write_text("{damaged")
    assert not installs.manifest("atlassian")

    async def pause(*a):
        await asyncio.sleep(30)

    monkeypatch.setattr(installs, "_version", pause)
    installs.start("atlassian")
    await asyncio.sleep(0.01)
    with pytest.raises(ValueError, match="busy"):
        Installations().start("atlassian")
    await installs.cancel("atlassian")
    assert installs.state("atlassian")["phase"] == "cancelled"
    assert not installs.manifest("atlassian")


async def test_a_server_that_went_away_comes_back_and_stops_trying(db, monkeypatch):
    import app.mcp_runtime.service as service_module

    monkeypatch.setattr(service_module, "COMEBACK_DELAYS", (0.01, 0.01))
    logs = LogService(db)
    service = McpService(db, SecretVault(db), _services(db), logs)
    mid = "one"
    service.store.save(mid, {**definition(), "enabled": True}, create=True)
    made = []

    class Fake:
        def __init__(self, spec, event, prepare=None):
            self.spec, self.event, self.tools, self.error, self.error_code = spec, event, [], "", ""
            self.state, self.connected_at, self.protocol, self.server_info, self.capabilities = "connected", 1.0, "", {}, {}
            self.task = asyncio.get_running_loop().create_future()
            self.ready = asyncio.get_running_loop().create_future()
            self.ready.set_result(True)
            made.append(self)

        async def close(self):
            pass

    monkeypatch.setattr(service_module, "Connection", Fake)
    monkeypatch.setattr(service_module.time, "time", lambda: 2.0)  # (it never held for long)
    try:
        await service.connect(mid)
        assert len(made) == 1
        for expected in (2, 3):
            service._event(mid, "error", "BrokenResourceError:")
            for _ in range(50):
                if len(made) == expected:
                    break
                await asyncio.sleep(0.01)
            assert len(made) == expected  # (connected again by itself)
        made[-1].connected_at = None
        service._event(mid, "error", "again")  # (out of tries)
        await asyncio.sleep(0.05)
        assert len(made) == 3 and not service.comebacks
        levels = [r["level"] for r in logs.list(source="mcp")["items"] if r["code"] == "mcp.error"]
        assert levels == ["error", "warning", "warning"]  # (newest first: only giving up is an error)
    finally:
        await service.stop()
