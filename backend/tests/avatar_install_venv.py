"""Manual helper (not a test): build the avatar processing venv with the app's own installer.

    AVATAR_VENV=~/.cache/hrh-avatar-venv PYTHONPATH=. python -P tests/avatar_install_venv.py
"""

import asyncio
import json

from app.avatar.deps import Deps


async def main() -> None:
    d = Deps()
    async for item in d.install_stream():
        print(json.dumps(item, ensure_ascii=False)[:300], flush=True)


asyncio.run(main())
