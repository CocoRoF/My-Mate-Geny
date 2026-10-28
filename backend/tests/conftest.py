"""Test fixtures — isolated SQLite db + a fixed vault key per test session."""

from __future__ import annotations

import os
import tempfile

import pytest
from cryptography.fernet import Fernet

# Fix the vault key BEFORE any app import so SecretVault doesn't touch $HOME.
os.environ.setdefault("VAULT_KEY", Fernet.generate_key().decode())
os.environ.setdefault("AUTH_PASSWORD", "test-pass")
os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault("COOKIE_SECURE", "false")

from app.db import Database  # noqa: E402


@pytest.fixture
def db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    import pathlib

    d = Database(pathlib.Path(path))
    d.bootstrap()
    yield d
    d.close()
    os.unlink(path)
