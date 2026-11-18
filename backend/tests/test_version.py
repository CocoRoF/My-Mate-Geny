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
    assert f'APP_VERSION = "{__version__}"' in (ROOT / "frontend/src/version.ts").read_text()
    line = re.search(r"APP_LINE: '([\d.]+)'", (ROOT / ".github/workflows/apps.yml").read_text())
    assert line and __version__.startswith(line.group(1) + "."), "the apps workflow builds this version's line"
