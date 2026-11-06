#!/usr/bin/env python3
"""A throwaway server for desktop/test/e2e/mate-outfit-browser.js: no credits, nothing of the real data.

  python3 desktop/test/e2e/mate-outfit-server.py <port> <frontend dist> [<picture> <picture>]

한채린 (the bundled mate) gets two outfits filled with one picture each, and an empty one with a finished project made of
서아's real clips: a whole video set, only to check that wearing it swaps everything. The agent is fake-claude.py.
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
        for name, src, tag in (("캐주얼", srcs[0], "a"), ("여름옷", srcs[1], "b")):
            mates.set_outfit_avatar(mid, mates.add_outfit(mid, name), picture_set(mid, src, tag))
        made = mates.add_outfit(mid, "출근복")
        pid = av.studio_open(mate_id=mid, language="ko", outfit={"id": made})["id"]
        doc = av.doc(pid)
        shutil.copytree(BUILTIN / "seoa", av.dir(pid) / "export")
        doc.update(status="ready", result={"at": "2026-11-06T00:00:00+00:00", "stills": 12, "clips": 15})
        av.save(doc)
        if os.environ.get("OUTFIT_E2E_WAITING"):  # for mate-studio-phone-browser.js: a redo waits for the user's OK
            pid = av.studio_open(mate_id=mid, language="ko", outfit={"id": mates.add_outfit(mid, "여행복")})["id"]
            doc = av.doc(pid)
            (av.dir(pid) / "design").mkdir()
            (av.dir(pid) / "thumbs").mkdir(exist_ok=True)
            for c in ("c1", "c2", "c3"):
                shutil.copyfile(BUILTIN / "seoa/neutral.webp", av.dir(pid) / f"design/{c}.png")
                shutil.copyfile(BUILTIN / "seoa/neutral.webp", av.dir(pid) / f"thumbs/{c}.jpg")
                doc["items"][f"design:{c}"] = {"stage": "design", "job_type": "nano_banana_pro", "status": "done",
                                               "out": f"design/{c}.png", "credits": 2.0, "tries": 1}
            doc["done"]["design"] = True
            doc.update(status="waiting", phase="pick", checkpoint={"stage": "pick", "at": "2026-11-06T00:00:00+00:00"},
                       plan={"id": "plan_e2e", "total": 100.0, "reserve": 15.0, "cap": 115.0, "minutes": 10,
                             "complete": True, "errors": [], "balance": 150.0, "usd": 0, "counts": {},
                             "lines": [{"stage": "design", "job_type": "nano_banana_pro", "count": 3, "unit": 2.0,
                                        "credits": 6.0}]},
                       confirmation={"plan_id": "plan_e2e", "total": 100.0, "cap": 115.0,
                                     "at": "2026-11-06T00:00:00+00:00"},
                       extras=[{"id": "x_e2e", "reason": "3 new candidates", "total": 6.0, "status": "pending",
                                "at": "2026-11-06T00:00:00+00:00",
                                "items": [{"kind": "reroll", "key": "design", "count": 3, "credits": 6.0, "note": "x"}]}])
            av.save(doc)
        yield


app.router.lifespan_context = seeded
uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
