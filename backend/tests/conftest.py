"""Test fixtures — isolated SQLite db + a fixed vault key per test session."""

from __future__ import annotations

import os
import tempfile

import pytest
from cryptography.fernet import Fernet

# Set env BEFORE any app import so the cached Settings pick it up. Isolate the
# DB to a temp file so the TestClient-based tests never touch the prod DB.
os.environ.setdefault("VAULT_KEY", Fernet.generate_key().decode())
os.environ.setdefault("AUTH_PASSWORD", "test-pass")
os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("STATIC_DIR", "")
# a fresh database every run: one left by an earlier run points at that run's MATES_ROOT (gone now)
os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(prefix="hrh_test_db_"), "hrh_test_app.db"))
os.environ.setdefault("UPLOADS_ROOT", tempfile.mkdtemp(prefix="hrh_test_uploads_"))
os.environ.setdefault("MATES_ROOT", tempfile.mkdtemp(prefix="hrh_test_mates_"))
os.environ.setdefault("HIGGSFIELD_ROOT", tempfile.mkdtemp(prefix="hrh_test_higgsfield_"))

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
