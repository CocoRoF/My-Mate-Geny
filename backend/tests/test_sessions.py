from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault


def _services(db):
    vault = SecretVault(db)
    providers = ProviderService(db, vault)
    connections = ConnectionService(db, vault)
    workspaces = WorkspaceService(connections)
    return SessionService(db, providers, workspaces)


def test_session_crud(db, tmp_path):
    svc = _services(db)
    s = svc.create(provider="claude", model="sonnet", workspace_path=str(tmp_path), title="t")
    assert s["provider"] == "claude"
    assert svc.get(s["id"])["id"] == s["id"]
    assert len(svc.list_all()) == 1
    svc.delete(s["id"])
    assert svc.list_all() == []


def test_connection_crud_stores_key_in_vault(db):
    vault = SecretVault(db)
    svc = ConnectionService(db, vault)
    c = svc.create(
        name="prod", host="1.2.3.4", port=2222, username="u", private_key_pem="KEY", default_path="."
    )
    assert c["has_key"] is True
    # Public payload never exposes the key; it lives encrypted in the vault.
    assert "private_key_pem" not in c
    assert vault.read(f"connection:{c['id']}.key") == "KEY"
    svc.delete(c["id"])
    assert svc.list_all() == []
