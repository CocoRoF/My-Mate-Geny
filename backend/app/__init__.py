"""hr-harnessor backend application package."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

#: the release line (the package.json files, pyproject, frontend/src/version.ts: tests/test_version.py keeps them equal); each
#: build is numbered <line>.<n> by the apps workflow — ``build_version``
__version__ = "1.1.0"

_BUILD = Path(__file__).with_name("build.json")
_VERSION = re.compile(r"\d+\.\d+\.\d+")


def _read_build(path: Path) -> str:
    try:
        v = str(json.loads(path.read_text()).get("version") or "")
    except (OSError, ValueError, AttributeError):
        v = ""
    return v if _VERSION.fullmatch(v) else ""


#: what build.json said when this process started: the version of the code it loaded (a deploy writes the next one before
#: the restart that loads it)
_STARTED = _read_build(_BUILD)


def build_version() -> str:
    """This build's version, as the apps workflow numbered its commit: from the desktop app that runs it (GENY_APP_VERSION),
    else from build.json beside this file as it was when the server started (written at deploy: deploy/app-version.py
    --write-backend), else the line's."""
    env = os.environ.get("GENY_APP_VERSION", "")
    if _VERSION.fullmatch(env):
        return env
    return _STARTED or __version__
