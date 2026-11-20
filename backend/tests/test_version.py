"""One version for the product: the server, the web console, the desktop and Android apps and the apps workflow's line
(.github/workflows/apps.yml numbers each build <line>.<n>, its first 1.0.0)."""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

from app import __version__

ROOT = Path(__file__).resolve().parents[2]


def test_every_part_says_the_same_version():
    assert re.fullmatch(r"\d+\.\d+\.\d+", __version__)
    assert tomllib.loads((ROOT / "backend/pyproject.toml").read_text())["project"]["version"] == __version__
    for app in ("frontend", "desktop", "mobile"):
        assert json.loads((ROOT / app / "package.json").read_text())["version"] == __version__, app
        lock = json.loads((ROOT / app / "package-lock.json").read_text())
        assert lock["version"] == lock["packages"][""]["version"] == __version__, app
    assert f'LINE_VERSION = "{__version__}"' in (ROOT / "frontend/src/version.ts").read_text()
    line = re.search(r"APP_LINE: '([\d.]+)'", (ROOT / ".github/workflows/apps.yml").read_text())
    assert line and __version__.startswith(line.group(1) + "."), "the apps workflow builds this version's line"


def test_the_server_says_its_builds_version_from_the_app_or_the_deploy_else_the_lines(tmp_path, monkeypatch):
    """Each build is <line>.<n> (the apps workflow): the desktop app passes its own (GENY_APP_VERSION), the deploy writes
    build.json (deploy/app-version.py --write-backend); anything else is the line's."""
    import app as A

    build = tmp_path / "build.json"
    monkeypatch.delenv("GENY_APP_VERSION", raising=False)
    monkeypatch.setattr(A, "_STARTED", A._read_build(build))
    assert A.build_version() == __version__
    build.write_text(json.dumps({"version": "1.1.12", "commit": "c8b0d23"}))
    assert A.build_version() == __version__  # (written after it started: the running code isn't that version yet)
    monkeypatch.setattr(A, "_STARTED", A._read_build(build))  # (the restart that loads it)
    assert A.build_version() == "1.1.12"
    monkeypatch.setenv("GENY_APP_VERSION", "1.1.14")
    assert A.build_version() == "1.1.14"
    monkeypatch.setenv("GENY_APP_VERSION", "dev")
    build.write_text("not json")
    assert A._read_build(build) == ""
