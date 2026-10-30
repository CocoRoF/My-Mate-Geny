"""Native app downloads, fed by the CI release pipeline.

GitHub Actions builds the desktop (Windows/macOS/Linux) and Android apps on
every push that touches them and publishes a rolling ``apps-latest`` release.
The repo is private, so release assets aren't publicly downloadable: the
backend reads the release with a server-side token, fetches each asset once
into a local cache, and serves it from disk (range requests, so downloads
resume). The download page therefore always offers the newest build.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from app.config import settings

_API = "https://api.github.com"
_META_TTL = 60.0

# file name -> (platform, arch, kind, label)
_PATTERNS: list[tuple[re.Pattern, str, str, str, str]] = [
    (re.compile(r"windows-x64-setup\.exe$"), "windows", "x64", "installer", "Windows installer (x64)"),
    (re.compile(r"macos-arm64\.dmg$"), "macos", "arm64", "dmg", "macOS · Apple Silicon"),
    (re.compile(r"macos-x64\.dmg$"), "macos", "x64", "dmg", "macOS · Intel"),
    (re.compile(r"linux-x86_64\.AppImage$"), "linux", "x64", "appimage", "Linux AppImage (x64)"),
    (re.compile(r"linux-amd64\.deb$"), "linux", "x64", "deb", "Linux .deb (Debian/Ubuntu)"),
    (re.compile(r"\.apk$"), "android", "universal", "apk", "Android APK"),
]


class _NoAuthRedirect(urllib.request.HTTPRedirectHandler):
    """GitHub answers asset downloads with a redirect to signed storage; the
    Authorization header must NOT follow it (the storage rejects it)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None:
            new.headers.pop("Authorization", None)
            new.unredirected_hdrs.pop("Authorization", None)
        return new


class DownloadService:
    def __init__(self) -> None:
        self._meta: tuple[float, dict[str, Any]] | None = None
        self._lock = threading.Lock()
        self._fetching: dict[int, threading.Lock] = {}

    @property
    def configured(self) -> bool:
        return bool(settings.github_token and settings.apps_repo)

    def _headers(self, accept: str = "application/vnd.github+json") -> dict[str, str]:
        return {
            "Authorization": f"Bearer {settings.github_token}",
            "Accept": accept,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "hr-harnessor",
        }

    def _get(self, url: str) -> Any:
        req = urllib.request.Request(url, headers=self._headers())
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode())

    @staticmethod
    def classify(name: str) -> dict[str, str] | None:
        for rx, platform, arch, kind, label in _PATTERNS:
            if rx.search(name):
                return {"platform": platform, "arch": arch, "kind": kind, "label": label}
        return None

    def latest(self, force: bool = False) -> dict[str, Any]:
        """Latest release metadata (cached for a minute)."""
        if not self.configured:
            return {"available": False, "reason": "not_configured"}
        with self._lock:
            if not force and self._meta and time.monotonic() - self._meta[0] < _META_TTL:
                return self._meta[1]
        try:
            rel = self._get(f"{_API}/repos/{settings.apps_repo}/releases/tags/{settings.apps_release_tag}")
        except urllib.error.HTTPError as exc:
            out = {"available": False, "reason": "no_release" if exc.code == 404 else f"github_{exc.code}"}
            with self._lock:
                self._meta = (time.monotonic(), out)
            return out
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            return {"available": False, "reason": f"unreachable: {exc}"}
        body = rel.get("body") or ""
        meta = {}
        m = re.search(r"<!--\s*hrh-meta\s*(\{.*?\})\s*-->", body, re.S)
        if m:
            try:
                meta = json.loads(m.group(1))
            except ValueError:
                meta = {}
        # The rolling release is updated in place: for a moment it holds both
        # the old and the new file of a platform. Offer only the newest.
        newest: dict[str, dict] = {}
        for a in rel.get("assets") or []:
            if a.get("state", "uploaded") != "uploaded" or self.classify(a["name"]) is None:
                continue
            key = self.classify(a["name"])["label"]
            if key not in newest or (a.get("updated_at") or "") > (newest[key].get("updated_at") or ""):
                newest[key] = a
        assets = []
        for a in newest.values():
            kind = self.classify(a["name"])
            assets.append({
                "id": a["id"],
                "name": a["name"],
                "size": a["size"],
                "updated_at": a.get("updated_at"),
                "url": f"/api/downloads/asset/{a['id']}/{a['name']}",
                **kind,
            })
        out = {
            "available": bool(assets),
            "version": meta.get("version") or rel.get("name") or rel.get("tag_name"),
            "commit": meta.get("commit"),
            "commit_message": meta.get("commit_message"),
            "built_at": meta.get("built_at") or rel.get("published_at"),
            "notes": re.sub(r"<!--.*?-->", "", body, flags=re.S).strip(),
            "assets": assets,
        }
        with self._lock:
            self._meta = (time.monotonic(), out)
        return out

    def asset_path(self, asset_id: int) -> tuple[Path, str]:
        """Local cached file for a release asset (downloaded on first use)."""
        info = self.latest()
        asset = next((a for a in info.get("assets", []) if a["id"] == asset_id), None)
        if asset is None:
            raise KeyError("asset not found")
        cache = settings.home_dir / "downloads" / str(asset_id)
        dest = cache / asset["name"]
        if dest.exists() and dest.stat().st_size == asset["size"]:
            return dest, asset["name"]
        with self._lock:
            lock = self._fetching.setdefault(asset_id, threading.Lock())
        with lock:  # one download per asset, however many people click
            if dest.exists() and dest.stat().st_size == asset["size"]:
                return dest, asset["name"]
            cache.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + ".part")
            opener = urllib.request.build_opener(_NoAuthRedirect)
            req = urllib.request.Request(
                f"{_API}/repos/{settings.apps_repo}/releases/assets/{asset_id}",
                headers=self._headers("application/octet-stream"),
            )
            with opener.open(req, timeout=60) as r, open(tmp, "wb") as fh:
                shutil.copyfileobj(r, fh, 1024 * 1024)
            if tmp.stat().st_size != asset["size"]:
                tmp.unlink(missing_ok=True)
                raise RuntimeError("incomplete download from GitHub")
            os.replace(tmp, dest)
            self._prune(keep=asset_id)
        return dest, asset["name"]

    def _prune(self, keep: int) -> None:
        """Drop cached assets that are no longer in the latest release."""
        live = {a["id"] for a in (self._meta[1] if self._meta else {}).get("assets", [])} | {keep}
        root = settings.home_dir / "downloads"
        for d in root.iterdir() if root.exists() else []:
            if d.is_dir() and d.name.isdigit() and int(d.name) not in live:
                shutil.rmtree(d, ignore_errors=True)
