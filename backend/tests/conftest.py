"""Test fixtures — isolated SQLite db + a fixed vault key per test session."""

from __future__ import annotations

import os
import tempfile

import pytest
from cryptography.fernet import Fernet

# Set env BEFORE any app import so the cached Settings pick it up. Isolate the
# DB to a temp file so the TestClient-based tests never touch the prod DB.
# (pytest-xdist: a worker inherits these from the process that started it, and each must have its own)
if os.environ.get("PYTEST_XDIST_WORKER"):
    for _shared in ("DB_PATH", "UPLOADS_ROOT", "MATES_ROOT", "HIGGSFIELD_ROOT", "AVATAR_ROOT"):
        os.environ.pop(_shared, None)
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
os.environ.setdefault("AVATAR_ROOT", tempfile.mkdtemp(prefix="hrh_test_avatars_"))
# no registry / GitHub lookups from the CLI-versions service (tests/test_cli_tools.py fakes them)
os.environ.setdefault("CLI_UPDATE_CHECK", "false")
os.environ.setdefault("MEMORY_CONSOLIDATION_ENABLED", "false")

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


@pytest.fixture(autouse=True)
def _whatever_time_it_really_is(monkeypatch):
    """Past 21:00 a mate gets sleepy, and that would outweigh what a test is about whenever the suite happens to run then."""
    from app.mate import state

    monkeypatch.setattr(state, "_late", lambda now, tz: 0.0)
    # (nor what she happens to be doing at that hour: a test about her day turns it on)
    from app.mate.life import profile

    monkeypatch.setattr(profile, "own", lambda key: False)
