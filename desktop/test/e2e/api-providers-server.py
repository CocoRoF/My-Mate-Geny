#!/usr/bin/env python3
"""A throwaway server for desktop/test/e2e/api-providers-browser.js: the app, with the Anthropic / OpenAI / Gemini APIs
replaced by backend/tests/fake_vendors.py (scripted answers, nothing real).

  python3 desktop/test/e2e/api-providers-server.py <port> <fake vendors port> <frontend dist> <workspace dir>
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from cryptography.fernet import Fernet

PORT, FAKE_PORT, DIST, WORK = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], Path(sys.argv[4])
REPO = Path(__file__).resolve().parents[3]
ROOT = Path(tempfile.mkdtemp(prefix="hrh-api-e2e-", dir=os.path.expanduser("~/.cache")))
os.environ.update({
    "DB_PATH": str(ROOT / "app.db"), "DATA_HOME": str(ROOT), "VAULT_KEY": Fernet.generate_key().decode(),
    "MATES_ROOT": str(ROOT / "mates"), "UPLOADS_ROOT": str(ROOT / "uploads"), "AVATAR_ROOT": str(ROOT / "avatars"),
    "HIGGSFIELD_ROOT": str(ROOT / "higgsfield"), "MOUNT_ROOT": str(ROOT / "mounts"), "REPOS_ROOT": str(ROOT / "repos"),
    "AUTH_USERNAME": "admin", "AUTH_PASSWORD": "api-test-only", "SESSION_SECRET": "api-test-only",
    "COOKIE_SECURE": "false", "MONITOR_ENABLED": "false", "CLI_UPDATE_CHECK": "false", "PLAN_USAGE_FETCH": "false",
    "MEMORY_CONSOLIDATION_ENABLED": "false", "GITHUB_TOKEN": "", "CODEX_BINARY": "/nonexistent/codex",
    "CLAUDE_BINARY": "/nonexistent/claude", "STATIC_DIR": DIST,
})
sys.path.insert(0, str(REPO / "backend"))

from tests.fake_vendors import Server  # noqa: E402

fake = Server(FAKE_PORT).start()
for vendor, url in fake.urls().items():
    os.environ[f"HRH_{vendor.upper()}_BASE_URL"] = url

WORK.mkdir(parents=True, exist_ok=True)
for args in (["init", "-q"], ["config", "user.email", "t@e"], ["config", "user.name", "t"]):
    subprocess.run(["git", *args], cwd=WORK, check=True)
(WORK / "README.md").write_text("# demo\n")
subprocess.run(["git", "add", "-A"], cwd=WORK, check=True)
subprocess.run(["git", "commit", "-qm", "init"], cwd=WORK, check=True)

import uvicorn  # noqa: E402

import app.providers.accounts as accounts  # noqa: E402
from app.main import app  # noqa: E402

accounts._host_config_dir = lambda p: ROOT / "empty-provider" / p
accounts.AccountPool._host_cred_dir = staticmethod(lambda p: str(ROOT / "empty-provider" / p))
uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
