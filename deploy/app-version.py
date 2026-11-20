#!/usr/bin/env python3
"""The product version of a commit: <line>.<n>, as the apps workflow numbered it (.github/workflows/apps.yml, its release
apps-v<version>). The web console and the server built from that commit say the same version as its apps.

  deploy/app-version.py [<commit>] [--write-backend]

1. a release tag on the commit (apps-v<version>, once its release is public);
2. else this commit's release still being built (a draft, from GitHub with git's stored credential, never printed);
3. else the newest release before it, on the same line (a commit that built no app: nothing of the product changed);
4. else the line's own version (backend/app/__init__.py).
Prints the version. --write-backend also writes backend/app/build.json (the server reports it: app.build_version) — run it
in the live checkout before the backend restarts. swap-frontend.sh --build passes the version to the build (APP_VERSION).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = "CocoRoF/My-Mate-Geny"
TAG = re.compile(r"^apps-v(\d+\.\d+\.\d+)$")


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True).stdout.strip()


def line_version() -> str:
    m = re.search(r'__version__ = "(\d+\.\d+\.\d+)"', (ROOT / "backend/app/__init__.py").read_text())
    return m.group(1) if m else "0.0.0"


def same_line(v: str, line: str) -> bool:
    return v.split(".")[:2] == line.split(".")[:2]


def drafted(sha: str) -> str:
    """This commit's release while it is still a draft (it has no tag until its first platform is published)."""
    cred = subprocess.run(["git", "-C", str(ROOT), "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                          capture_output=True, text=True, timeout=20).stdout
    token = next((x.split("=", 1)[1] for x in cred.splitlines() if x.startswith("password=")), "")
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/releases?per_page=30",
                                 headers={"Accept": "application/vnd.github+json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=20) as r:
        for rel in json.load(r):
            m = TAG.match(str(rel.get("tag_name") or ""))
            if m and str(rel.get("target_commitish") or "") == sha:
                return m.group(1)
    return ""


def version_of(commit: str) -> str:
    line = line_version()
    subprocess.run(["git", "-C", str(ROOT), "fetch", "-q", "--tags", "origin"], capture_output=True, timeout=60)
    sha = git("rev-parse", commit) or commit
    on = sorted((m.group(1) for t in git("tag", "--points-at", sha).splitlines() if (m := TAG.match(t))),
                key=lambda v: tuple(int(x) for x in v.split(".")))
    if on and same_line(on[-1], line):
        return on[-1]
    try:
        v = drafted(sha)
    except Exception:  # noqa: BLE001 - offline, no credential: what git knows
        v = ""
    if v and same_line(v, line):
        return v
    m = TAG.match(git("describe", "--tags", "--abbrev=0", "--match", "apps-v[0-9]*", sha))
    if m and same_line(m.group(1), line):
        return m.group(1)
    return line


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    commit = args[0] if args else "HEAD"
    v = version_of(commit)
    if "--write-backend" in sys.argv:
        (ROOT / "backend/app/build.json").write_text(json.dumps({"version": v, "commit": git("rev-parse", "--short=12", commit)}) + "\n")
    print(v)
    return 0


if __name__ == "__main__":
    sys.exit(main())
