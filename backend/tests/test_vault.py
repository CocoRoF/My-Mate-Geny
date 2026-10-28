from app.vault import SecretVault, VaultError
import pytest


def test_vault_round_trip(db):
    vault = SecretVault(db)
    ref = vault.put("provider", "claude.api_key", "sk-secret-123")
    assert ref == "provider:claude.api_key"
    assert vault.exists(ref)
    assert vault.read(ref) == "sk-secret-123"


def test_vault_update_overwrites(db):
    vault = SecretVault(db)
    vault.put("conn", "k", "first")
    ref = vault.put("conn", "k", "second")
    assert vault.read(ref) == "second"


def test_vault_delete(db):
    vault = SecretVault(db)
    ref = vault.put("conn", "k", "x")
    vault.delete(ref)
    assert not vault.exists(ref)
    with pytest.raises(VaultError):
        vault.read(ref)
