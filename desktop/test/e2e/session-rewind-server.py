#!/usr/bin/env python3
"""A throwaway server for desktop/test/e2e/session-rewind-browser.js: fake-claude.py as the engine, nothing real.

  python3 desktop/test/e2e/session-rewind-server.py <port> <frontend dist> <workspace dir>

The workspace is a git repository, so a turn's file changes are tracked as in real use.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from cryptography.fernet import Fernet

PORT, DIST, WORK = int(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
REPO = Path(__file__).resolve().parents[3]
ROOT = Path(tempfile.mkdtemp(prefix="hrh-rewind-e2e-", dir=os.path.expanduser("~/.cache")))
os.environ.update({
    "DB_PATH": str(ROOT / "app.db"), "DATA_HOME": str(ROOT), "VAULT_KEY": Fernet.generate_key().decode(),
    "MATES_ROOT": str(ROOT / "mates"), "UPLOADS_ROOT": str(ROOT / "uploads"), "AVATAR_ROOT": str(ROOT / "avatars"),
    "HIGGSFIELD_ROOT": str(ROOT / "higgsfield"), "MOUNT_ROOT": str(ROOT / "mounts"), "REPOS_ROOT": str(ROOT / "repos"),
    "AUTH_USERNAME": "admin", "AUTH_PASSWORD": "rewind-test-only", "SESSION_SECRET": "rewind-test-only",
    "COOKIE_SECURE": "false", "MONITOR_ENABLED": "false", "CLI_UPDATE_CHECK": "false", "PLAN_USAGE_FETCH": "false",
    "MEMORY_CONSOLIDATION_ENABLED": "false", "GITHUB_TOKEN": "", "CODEX_BINARY": "/nonexistent/codex",
    "CLAUDE_BINARY": str(REPO / "desktop/test/e2e/fake-claude.py"), "STATIC_DIR": DIST,
})
sys.path.insert(0, str(REPO / "backend"))

WORK.mkdir(parents=True, exist_ok=True)
for args in (["init", "-q"], ["config", "user.email", "t@e"], ["config", "user.name", "t"]):
    subprocess.run(["git", *args], cwd=WORK, check=True)
(WORK / "tracked.txt").write_text("before\n")
subprocess.run(["git", "add", "-A"], cwd=WORK, check=True)
subprocess.run(["git", "commit", "-qm", "init"], cwd=WORK, check=True)

import uvicorn  # noqa: E402

import app.providers.accounts as accounts  # noqa: E402
from app.main import app  # noqa: E402

accounts._host_config_dir = lambda p: ROOT / "empty-provider" / p
accounts.AccountPool._host_cred_dir = staticmethod(lambda p: str(ROOT / "empty-provider" / p))
uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
