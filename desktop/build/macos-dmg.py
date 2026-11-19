#!/usr/bin/env python3
"""Package the verified .app without mounting/customizing/detaching a DMG.

The image contains the app and an Applications shortcut. hdiutil creates the
compressed read-only image directly from that folder; Finder scripting and
device-busy detach retries are unnecessary. Only app files enter the image.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


def clone_file(source: str, target: str) -> str:
    # The staging folder is on the same volume. Hardlinks avoid copying the
    # entire embedded Python runtime again; fall back for other filesystems.
    try:
        os.link(source, target)
        return target
    except OSError:
        return shutil.copy2(source, target)


def digest(path: Path) -> str:
    h = hashlib.sha512()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return base64.b64encode(h.digest()).decode()


def write_feed(directory: Path, version: str, arch: str | None = None) -> Path:
    """latest-mac-<arch>.yml: one architecture's feed, published the moment that build is (the desktop's update source
    serves it to that architecture as latest-mac.yml); without an arch, one feed for both (the release has both)."""
    files = sorted(directory.glob(f"my-mate-geny-{version}-macos-{arch or '*'}.dmg"))
    if arch is None and {f.name.rsplit("-", 1)[-1] for f in files} != {"x64.dmg", "arm64.dmg"}:
        raise RuntimeError(
            "Both verified macOS architectures are required before publishing the feed"
        )
    if not files:
        raise RuntimeError(f"No verified {arch} image to describe")
    # A signed build also has a zip per architecture, which is what a running app updates itself from: first in the feed.
    zips = sorted(directory.glob(f"my-mate-geny-{version}-macos-{arch or '*'}.zip"))
    entries = [(f.name, digest(f), f.stat().st_size) for f in [*zips, *files]]
    lines = [f"version: {json.dumps(version)}", "files:"]
    for name, sha, size in entries:
        lines += [f"  - url: {json.dumps(name)}", f"    sha512: {sha}", f"    size: {size}"]
    lines += [
        f"path: {json.dumps(entries[0][0])}",
        f"sha512: {entries[0][1]}",
        f"releaseDate: {json.dumps(datetime.now(timezone.utc).isoformat())}",
    ]
    path = directory / (f"latest-mac-{arch}.yml" if arch else "latest-mac.yml")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def quiet_scanners() -> None:
    """On the Actions runners only: XProtect scans each file as hdiutil writes it into the image, which made one image
    take anywhere from 1 to 13 minutes there (2026-11-19). An ephemeral runner, sudo without a password: it is stopped
    for the image. A developer's own Mac is left alone."""
    if os.environ.get("GITHUB_ACTIONS") != "true" or sys.platform != "darwin":
        return
    subprocess.run(["sudo", "-n", "pkill", "-9", "XProtect"], capture_output=True)
    for _ in range(10):
        if subprocess.run(["pgrep", "XProtect"], capture_output=True).returncode != 0:
            break
        time.sleep(3)


def build(directory: Path, version: str, arch: str) -> Path:
    if sys.platform != "darwin":
        raise RuntimeError("DMG creation requires macOS")
    source = directory / ("mac-arm64" if arch == "arm64" else "mac") / "My Mate Geny.app"
    if not (source / "Contents/MacOS/My Mate Geny").is_file():
        raise RuntimeError(f"Missing packaged app: {source}")
    output = directory / f"my-mate-geny-{version}-macos-{arch}.dmg"
    with tempfile.TemporaryDirectory(prefix=".dmg-stage-", dir=directory) as temp:
        stage = Path(temp)
        shutil.copytree(source, stage / source.name, symlinks=True, copy_function=clone_file)
        (stage / "Applications").symlink_to("/Applications", target_is_directory=True)
        quiet_scanners()
        started = time.monotonic()
        subprocess.run(
            [
                "hdiutil",
                "create",
                "-ov",
                "-fs",
                "HFS+",
                "-format",
                "ULFO",
                "-volname",
                "My Mate Geny",
                "-srcfolder",
                str(stage),
                str(output),
            ],
            check=True,
            # (a ~530 MB image on the Intel runners takes 9–12 min, so 10 min failed twice in a row on 2026-11-18)
            timeout=1800,
        )
        print(f"DMG_CREATED in {time.monotonic() - started:.0f} s", flush=True)
    subprocess.run(["hdiutil", "verify", str(output)], check=True, timeout=120)
    print(f"DMG_VERIFIED {output} ({output.stat().st_size} bytes)", flush=True)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--arch", choices=("arm64", "x64"))
    parser.add_argument("--directory", type=Path, default=Path("dist"))
    parser.add_argument("--write-feed", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        parser.error("Expected a numeric release version")
    if args.write_feed:
        write_feed(args.write_feed, args.version, args.arch)
    elif args.arch:
        build(args.directory.resolve(), args.version, args.arch)
    else:
        parser.error("--arch or --write-feed is required")
