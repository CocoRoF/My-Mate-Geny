#!/usr/bin/env python3
"""A throwaway server for desktop/test/e2e/mate-outfit-browser.js: no credits, nothing of the real data.

  python3 desktop/test/e2e/mate-outfit-server.py <port> <frontend dist> [<casual picture> <swimwear picture>]

한채린 (the bundled mate) gets two picture-only sets in her wardrobe, and a finished project made of 서아's real clips:
a whole video set, only to check that wearing it swaps everything. The agent is fake-claude.py.
"""

import os
import shutil
import sys
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from cryptography.fernet import Fernet

PORT, DIST = int(sys.argv[1]), sys.argv[2]
PICTURES = sys.argv[3:5]
REPO = Path(__file__).resolve().parents[3]
ROOT = Path(tempfile.mkdtemp(prefix="hrh-outfit-e2e-", dir=os.path.expanduser("~/.cache")))
os.environ.update({
    "DB_PATH": str(ROOT / "app.db"), "DATA_HOME": str(ROOT), "VAULT_KEY": Fernet.generate_key().decode(),
    "MATES_ROOT": str(ROOT / "mates"), "UPLOADS_ROOT": str(ROOT / "uploads"), "AVATAR_ROOT": str(ROOT / "avatars"),
    "HIGGSFIELD_ROOT": str(ROOT / "higgsfield"), "MOUNT_ROOT": str(ROOT / "mounts"), "REPOS_ROOT": str(ROOT / "repos"),
    "AUTH_USERNAME": "admin", "AUTH_PASSWORD": "outfit-test-only", "SESSION_SECRET": "outfit-test-only",
    "COOKIE_SECURE": "false", "MONITOR_ENABLED": "false", "CLI_UPDATE_CHECK": "false", "PLAN_USAGE_FETCH": "false",
    "MEMORY_CONSOLIDATION_ENABLED": "false", "GITHUB_TOKEN": "", "CODEX_BINARY": "/nonexistent/codex",
    "CLAUDE_BINARY": str(REPO / "desktop/test/e2e/fake-claude.py"), "STATIC_DIR": DIST,
})
sys.path.insert(0, str(REPO / "backend"))

import uvicorn  # noqa: E402

import app.providers.accounts as accounts  # noqa: E402
from app.main import app  # noqa: E402
from app.mate import files  # noqa: E402

accounts._host_config_dir = lambda p: ROOT / "empty-provider" / p
accounts.AccountPool._host_cred_dir = staticmethod(lambda p: str(ROOT / "empty-provider" / p))
original = app.router.lifespan_context
BUILTIN = REPO / "backend/app/mate/builtin/assets"


def picture_set(mid: str, src: Path, tag: str) -> dict:
    pack = files.assets_dir(mid) / f"pack-{tag * 12}"
    pack.mkdir(parents=True)
    shutil.copyfile(src, pack / f"n{src.suffix}")
    url = files.asset_url(mid, f"{pack.name}/n{src.suffix}")
    return {"kind": "photo", "rig": {"aspect": [3, 4], "home": url, "stills": {"neutral": url}, "clips": []}}


@asynccontextmanager
async def seeded(app):
    async with original(app):
        mates, av = app.state.mate_service, app.state.avatar_service
        mid = mates.store.by_builtin("chaerin")["id"]
        srcs = [Path(p) for p in PICTURES] or [BUILTIN / "seoa/neutral.webp", BUILTIN / "estelle/neutral.webp"]
        mates.add_outfit(mid, name="데일리 캐주얼", avatar=picture_set(mid, srcs[0], "a"), preset="casual",
                         note="a white t-shirt and an open gray cardigan")
        mates.add_outfit(mid, name="수영복", avatar=picture_set(mid, srcs[1], "b"), preset="swimwear",
                         note="a black long-sleeve rash guard with a white towel")
        pid = av.studio_open(mate_id=mid, language="ko", outfit={"preset": "office"})["id"]
        doc = av.doc(pid)
        shutil.copytree(BUILTIN / "seoa", av.dir(pid) / "export")
        doc.update(status="ready", result={"at": "2026-11-06T00:00:00+00:00", "stills": 12, "clips": 15})
        av.save(doc)
        yield


app.router.lifespan_context = seeded
uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
