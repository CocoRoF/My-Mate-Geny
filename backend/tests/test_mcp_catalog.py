import asyncio
import base64
import json
import sys
from pathlib import Path

import pytest
from test_mcp_api import client as api_client_fixture
from test_mcp_runtime import definition
from test_sessions import _services

from app.config import settings
from app.main import app
from app.mcp_runtime.catalog import RECIPES
from app.mcp_runtime.catalog import definition as recipe_definition
from app.mcp_runtime.client import Connection
from app.mcp_runtime.diagnostics import ConnectionIssue
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


def test_atlassian_recipe_uses_the_official_server_with_basic_or_bearer(tmp_path):
    values = {"email": "fixture@example.com", "token": "fixture-secret"}
    spec = recipe_definition("atlassian", values, data_dir=tmp_path)
    assert spec["transport"] == "http" and spec["url"] == "https://mcp.atlassian.com/v2/mcp"
    assert not spec["command"] and not spec["env"]
    basic = base64.b64decode(spec["headers"]["Authorization"].removeprefix("Basic "))
    assert basic == b"fixture@example.com:fixture-secret"
    key = recipe_definition("atlassian", {"auth": "bearer", "token": "key"}, data_dir=tmp_path)
    assert key["headers"] == {"Authorization": "Bearer key"}
    with pytest.raises(ValueError, match="required_field:email"):
        recipe_definition("atlassian", {"token": "fixture-secret"}, data_dir=tmp_path)


def test_package_connections_move_to_the_official_server_under_the_same_id(db):
    service = McpService(db, SecretVault(db), _services(db), LogService(db))
    package = {"catalog_id": "atlassian", "command": "geny-managed"}
    service.store.save(
        "cloud",
        {
            **package,
            "name": "sooperset-mcp-atlassian",
            "env": {
                "JIRA_USERNAME": "fixture@example.com",
                "JIRA_API_TOKEN": "fixture-secret",
                "READ_ONLY_MODE": "true",
            },
        },
        create=True,
    )
    moved = service._to_official_atlassian("cloud", service.store.get("cloud"))
    assert moved == service.store.get("cloud")
    assert moved["id"] == "cloud" and moved["name"] == "Atlassian · Jira / Confluence"
    assert moved["transport"] == "http" and moved["url"] == "https://mcp.atlassian.com/v2/mcp"
    assert moved["env"] == {} and moved["headers"]["Authorization"].startswith("Basic ")
    assert service._to_official_atlassian("cloud", moved) == moved

    # A Data Center token can't reach the official server: the entry stays and fails with a reason.
    service.store.save(
        "server",
        {**package, "name": "Server", "env": {"JIRA_PERSONAL_TOKEN": "fixture-secret"}},
        create=True,
    )
    stays = service._to_official_atlassian("server", service.store.get("server"))
    assert stays["transport"] == "stdio" and stays["env"]["JIRA_PERSONAL_TOKEN"]
    with pytest.raises(ConnectionIssue, match="set it up again"):
        service.installations.materialize(stays)


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
    assert defaults["saved_fields"] == ["token"]
    assert not defaults["values"]["token"] and token not in json.dumps(defaults)


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
    monkeypatch.setitem(
        RECIPES,
        "fixture",
        {
            "kind": "python",
            "package": "mcp-fixture",
            "entry": "mcp-fixture",
            "source": "https://github.com/example/mcp-fixture",
        },
    )
    installs = Installations()
    calls = []

    async def version(r):
        return "0.0.1"

    async def execute(argv, job, cwd):
        calls.append(argv)
        target = Path(argv[argv.index("--target") + 1])
        meta = target / "mcp_fixture-0.0.1.dist-info"
        meta.mkdir(parents=True)
        (meta / "METADATA").write_text("Name: mcp-fixture\nVersion: 0.0.1\n")
        (meta / "entry_points.txt").write_text("[console_scripts]\nmcp-fixture = fixture:main\n")

    monkeypatch.setattr(installs, "_version", version)
    monkeypatch.setattr(installs, "_exec", execute)
    assert not installs.state("fixture")["installed"]
    installs.start("fixture")
    await installs.tasks["fixture"]
    assert installs.state("fixture")["installed"]
    assert "--target" in calls[0] and "--no-build" in calls[0]
    spec = {"command": "geny-managed", "catalog_id": "fixture", "args": [], "env": {}}
    assert installs.materialize(spec)["command"] == sys.executable
    assert (installs.root / "python-runner-v1.py").is_file()
    monkeypatch.setattr(sys, "executable", "/a/new/bundled/python")
    assert installs.materialize(spec)["command"] == "/a/new/bundled/python"

    pointer = installs.root / "fixture" / "current.json"
    pointer.write_text("{damaged")
    assert not installs.manifest("fixture")

    async def pause(*a):
        await asyncio.sleep(30)

    monkeypatch.setattr(installs, "_version", pause)
    installs.start("fixture")
    await asyncio.sleep(0.01)
    with pytest.raises(ValueError, match="busy"):
        Installations().start("fixture")
    await installs.cancel("fixture")
    assert installs.state("fixture")["phase"] == "cancelled"
    assert not installs.manifest("fixture")
