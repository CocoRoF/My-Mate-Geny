"""Test fixtures — isolated SQLite db + a fixed vault key per test session."""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile

import pytest
from cryptography.fernet import Fernet

# Set env BEFORE any app import so the cached Settings pick it up. Isolate the
# DB to a temp file so the TestClient-based tests never touch the prod DB.
# (pytest-xdist: a worker inherits these from the process that started it, and each must have its own)
if os.environ.get("PYTEST_XDIST_WORKER"):
    for _shared in ("DB_PATH", "UPLOADS_ROOT", "MATES_ROOT", "HIGGSFIELD_ROOT", "AVATAR_ROOT", "VOICE_HOME"):
        os.environ.pop(_shared, None)
os.environ.setdefault("VAULT_KEY", Fernet.generate_key().decode())
os.environ.setdefault("AUTH_PASSWORD", "test-pass")
os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("STATIC_DIR", "")
# The run's own folders, removed when it ends (each pytest-xdist worker has its own; they used to stay in /tmp, about
# 30 MB a run). Only made when the environment doesn't name one already.
_made: list[str] = []


def _temp(prefix: str) -> str:
    d = tempfile.mkdtemp(prefix=prefix)
    _made.append(d)
    return d


def _default(key: str, make) -> None:
    if not os.environ.get(key):
        os.environ[key] = make()


def _clean() -> None:
    for d in _made:
        shutil.rmtree(d, ignore_errors=True)


atexit.register(_clean)


def pytest_unconfigure(config) -> None:  # (a pytest-xdist worker may end without running atexit)
    _clean()
# a fresh database every run: one left by an earlier run points at that run's MATES_ROOT (gone now)
_default("DB_PATH", lambda: os.path.join(_temp("hrh_test_db_"), "hrh_test_app.db"))
_default("UPLOADS_ROOT", lambda: _temp("hrh_test_uploads_"))
_default("MATES_ROOT", lambda: _temp("hrh_test_mates_"))
_default("HIGGSFIELD_ROOT", lambda: _temp("hrh_test_higgsfield_"))
_default("AVATAR_ROOT", lambda: _temp("hrh_test_avatars_"))
# local voice models (app/voicehost): never the machine's own models, history or clips — on a GPU host the app under
# test would otherwise find (and could load) the models installed there
_default("VOICE_HOME", lambda: _temp("hrh_test_voice_"))
# no registry / GitHub lookups from the CLI-versions service (tests/test_cli_tools.py fakes them)
os.environ.setdefault("CLI_UPDATE_CHECK", "false")
os.environ.setdefault("MEMORY_CONSOLIDATION_ENABLED", "false")
os.environ.setdefault("LIFE_WORLD", "false")  # (no weather / holiday lookups: app/mate/life/world.py)

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
    # (nor whether a bundled woman's off day happens to fall on it: test_mate_off_day.py is about that)
    monkeypatch.setattr(state, "_off_day", lambda w, now: None)
    # (nor what she happens to be doing at that hour: a test about her day turns it on)
    from app.mate.life import profile

    monkeypatch.setattr(profile, "own", lambda key: False)


def words_reading(user: str) -> str:
    """A reading as the reader would give it, made from the message's words: tests never start Claude Code or Codex, and
    their mates still feel what a message does (test_gss.py tests the reading itself)."""
    import json
    import re

    from app.mate import affinity as A
    from app.mate import state as S

    m = re.search(r"<message>\n(.*)\n</message>", user, re.S)
    text = m.group(1) if m else ""
    name = (re.search(r"Her name: (.*?)\.", user) or [None, ""])[1]
    c = A.cues(text, name=name)
    acts = []
    if c["hostile"]:
        acts.append(c["hostile"])
    elif c["rude"]:
        acts.append("insult")
    if S._APOLOGY.search(text):
        acts.append("apology")
    if S._DISMISSED.search(text):
        acts.append("dismissal")
    if c["warm"]:
        acts.append("gratitude")
    if S._LOVE.search(text):
        acts.append("affection")
    if S._LOOKS.search(text):
        acts.append("compliment")
    if c["distress"]:
        acts.append("distress")
    aimed = bool(c["hostile"] or c["rude"] or A.aimed(text, name) or acts)
    return json.dumps({"aimed_at_her": aimed, "acts": acts or ["neutral"], "intensity": 0.5, "owns_it": bool(S._OWNED.search(text)),
                       "sarcastic": False, "promise": None, "her_promise": None, "fulfills": [], "note": "words (tests)"})


@pytest.fixture(autouse=True)
def _a_reader_from_the_words(monkeypatch):
    """The Geny-State-System's reader (Claude Code kept warm, else Codex) is never started in tests."""
    from app.mate.gss import reader

    async def ask(self, user):
        return words_reading(user)

    monkeypatch.setattr(reader.Reader, "ask", ask)
