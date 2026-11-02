"""Pure helpers for Settings → Providers → CLI versions (no I/O, unit-tested).

* version strings: what ``<cli> --version`` prints, parsed and compared
  (``2.1.309 (Claude Code)``, ``codex-cli 0.166.0``,
  ``higgsfield 1.2.2 (<sha>) built 2026-10-16T23:42:35Z``);
* the registries' answers: npm ``dist-tags``, Claude Code's CHANGELOG.md,
  GitHub release bodies → a short list of what changed;
* how a binary was installed (from its real path) and which command upgrades
  that install — or, when it can't be written (an image-baked ``/usr`` copy),
  an app-managed copy under ``~/.hr-harnessor/cli`` that the app switches to.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Callable

# x.y.z with an optional -prerelease; not part of a longer dotted number or a date.
_VER_RE = re.compile(
    r"(?<![\d.])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?(?![\d])"
)
_EXACT_RE = re.compile(r"^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$")
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")


def parse_version(text: str | None) -> str | None:
    """The first x.y.z[-pre] in a ``--version`` output (without a leading v)."""
    if not text:
        return None
    m = _VER_RE.search(text)
    if not m:
        return None
    major, minor, patch, pre = m.groups()
    return f"{int(major)}.{int(minor)}.{int(patch)}" + (f"-{pre}" if pre else "")


def is_exact_version(s: str) -> bool:
    return bool(_EXACT_RE.match(s.strip()))


def version_key(v: str) -> tuple:
    """Sort key per semver precedence: a release sorts after its prereleases;
    numeric prerelease identifiers compare as numbers, before alphanumerics."""
    parsed = parse_version(v)
    if parsed is None:
        raise ValueError(f"not a version: {v!r}")
    core, _, pre = parsed.partition("-")
    nums = tuple(int(x) for x in core.split("."))
    if not pre:
        return (*nums, (1,))
    ids = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in re.split(r"[.-]", pre))
    return (*nums, (0, ids))


def compare_versions(a: str, b: str) -> int:
    """-1 / 0 / 1 like a <=> b."""
    ka, kb = version_key(a), version_key(b)
    return (ka > kb) - (ka < kb)


def is_newer(candidate: str | None, installed: str | None) -> bool:
    """True only when both are versions and ``candidate`` is strictly newer —
    nothing is "available" for an unknown or unparseable install."""
    if not candidate or not installed:
        return False
    try:
        return compare_versions(candidate, installed) > 0
    except ValueError:
        return False


def strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)


# ---- registries ----------------------------------------------------------------


def parse_dist_tags(data: object) -> dict[str, str]:
    """npm ``/-/package/<pkg>/dist-tags`` (or a packument's ``dist-tags``):
    tag → version, only the plain channel tags (codex publishes one tag per
    platform build, e.g. ``linux-x64: 0.166.0-linux-x64`` — not channels)."""
    if isinstance(data, dict) and isinstance(data.get("dist-tags"), dict):
        data = data["dist-tags"]
    if not isinstance(data, dict):
        return {}
    out: dict[str, str] = {}
    for tag, ver in data.items():
        if not isinstance(tag, str) or not isinstance(ver, str) or not is_exact_version(ver):
            continue
        if re.search(r"(linux|darwin|win32)-(x64|arm64)$", ver) or tag.startswith("release-"):
            continue
        out[tag] = ver.lstrip("v")
    return out


def channel_target(tags: dict[str, str], channel: str) -> str | None:
    """The version a channel points at (unknown channel → latest)."""
    return tags.get(channel) or tags.get("latest")


_PR_REFS = re.compile(r"\s*\((?:#\d+(?:,\s*)?)+\)\s*$")


def _bullet(line: str) -> str | None:
    s = line.strip()
    if not s.startswith(("- ", "* ")):
        return None
    s = _PR_REFS.sub("", s[2:].strip())
    return s or None


def parse_changelog(md: str, after: str | None, upto: str, *, limit: int = 12) -> list[dict]:
    """Claude Code's CHANGELOG.md (``## x.y.z`` sections, newest first): the
    entries of every version in (after, upto], newest first, at most ``limit``
    bullets in total (each section keeps its full ``count``)."""
    sections: list[dict] = []
    cur: dict | None = None
    for line in md.splitlines():
        if line.startswith("## "):
            v = parse_version(line[3:])
            cur = {"version": v, "items": [], "count": 0} if v else None
            if cur:
                sections.append(cur)
            continue
        if cur is not None:
            b = _bullet(line)
            if b:
                cur["count"] += 1
                cur["items"].append(b)
    out: list[dict] = []
    left = limit
    for s in sections:
        v = s["version"]
        try:
            if compare_versions(v, upto) > 0:
                continue
            if after and compare_versions(v, after) <= 0:
                continue
        except ValueError:
            continue
        items = s["items"][: max(0, left)]
        left -= len(items)
        out.append({"version": v, "items": items, "count": s["count"]})
    return out


def release_bullets(body: str | None, *, limit: int = 8) -> tuple[list[str], int]:
    """A GitHub release body → (its first ``limit`` bullet points, how many there are)."""
    items = [b for b in (_bullet(x) for x in (body or "").splitlines()) if b]
    return items[:limit], len(items)


# ---- installs --------------------------------------------------------------------


@dataclass
class Install:
    """How the binary in use got there."""

    method: str                 # native | npm | managed | unknown | missing
    prefix: str | None = None   # npm --prefix, or the native install's data dir (…/share/claude)
    writable: bool = False      # this process can replace it in place
    detail: str = ""


def detect_install(
    pkg: str,
    path: str | None,
    realpath: str | None,
    managed_prefix: str,
    *,
    native: bool = False,
    access: Callable[[str, int], bool] = os.access,
) -> Install:
    """Classify ``path`` (as found on PATH) by its resolved ``realpath``:

    * managed: under the app's own npm prefix (``~/.hr-harnessor/cli``);
    * native:  Claude Code's native installer (``~/.local/share/claude/versions/<v>``,
      linked from ``~/.local/bin/claude``) — upgraded by ``claude install <v>``;
    * npm:     ``<prefix>/lib/node_modules/<pkg>/…`` — ``npm i -g --prefix <prefix>``;
    * unknown: anything else (Homebrew, a copied binary…).
    """
    if not path or not realpath:
        return Install("missing", detail="not found")
    mp = managed_prefix.rstrip("/") + "/"
    if realpath.startswith(mp):
        prefix = managed_prefix.rstrip("/")
        ok = access(os.path.join(prefix, "lib", "node_modules"), os.W_OK) and access(os.path.join(prefix, "bin"), os.W_OK)
        return Install("managed", prefix, ok)
    if native:
        m = re.match(r"^(.*/share/claude)/versions/[^/]+$", realpath)
        if m:
            data = m.group(1)
            ok = access(os.path.join(data, "versions"), os.W_OK) and access(os.path.dirname(path), os.W_OK)
            return Install("native", data, ok)
    marker = f"/lib/node_modules/{pkg}/"
    i = realpath.find(marker)
    if i >= 0:
        prefix = realpath[:i] or "/"
        ok = access(os.path.join(prefix, "lib", "node_modules"), os.W_OK) and access(os.path.join(prefix, "bin"), os.W_OK)
        return Install("npm", prefix, ok)
    return Install("unknown", None, False, detail=realpath)


@dataclass
class Plan:
    """The command that upgrades a tool, and what it changes."""

    method: str                       # native | npm | managed
    argv: list[str]
    in_place: bool                    # replaces the copy in use
    switch_to_managed: bool = False   # installs the app's own copy and switches to it
    reason: str = ""                  # why not in place: read_only | unknown_install | missing
    prefix: str | None = None
    env: dict[str, str] = field(default_factory=dict)


class PlanError(Exception):
    """No way to upgrade here (``code`` is shown translated in the UI)."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


def npm_install_argv(npm: str, prefix: str, pkg: str, version: str) -> list[str]:
    return [
        npm, "install", "--global", "--prefix", prefix,
        "--no-audit", "--no-fund", "--foreground-scripts", "--loglevel=http",
        f"{pkg}@{version}",
    ]


def plan_upgrade(
    *,
    pkg: str,
    install: Install,
    binary_path: str | None,
    version: str,
    npm: str | None,
    managed_prefix: str,
) -> Plan:
    """Pick the updater for this install method (see :func:`detect_install`)."""
    if install.method == "native" and install.writable and binary_path:
        # the native installer itself: downloads <version> into …/share/claude/versions and
        # re-points the ~/.local/bin/claude link (an exact version also pins / rolls back)
        return Plan("native", [binary_path, "install", version], in_place=True, prefix=install.prefix)
    if install.method in ("npm", "managed") and install.writable and install.prefix:
        if not npm:
            raise PlanError("npm_missing", "npm was not found")
        return Plan(install.method, npm_install_argv(npm, install.prefix, pkg, version), in_place=True,
                    prefix=install.prefix)
    if not npm:
        raise PlanError("npm_missing", "npm was not found")
    reason = {"missing": "missing", "unknown": "unknown_install"}.get(install.method, "read_only")
    return Plan("managed", npm_install_argv(npm, managed_prefix, pkg, version), in_place=False,
                switch_to_managed=True, reason=reason, prefix=managed_prefix)


def npm_for_prefix(prefix: str | None, which: Callable[[str], str | None], exists: Callable[[str], bool]) -> str | None:
    """The npm that belongs to an install prefix (an nvm node's own npm), else the one on PATH."""
    if prefix:
        own = os.path.join(prefix, "bin", "npm")
        if exists(own):
            return own
    return which("npm")


def capped_argv(argv: list[str], capped: str | None, mem: str) -> list[str]:
    """Run inside this host's per-command memory cap when it is available."""
    if not capped:
        return list(argv)
    return [capped, "-m", mem, "--", *argv]


def split_output(buf: str) -> tuple[list[str], str]:
    """Complete lines (on \\n or \\r — progress bars redraw with \\r) and the rest."""
    parts = re.split(r"\r\n|\r|\n", buf)
    rest = parts.pop()
    return [strip_ansi(p).rstrip() for p in parts if strip_ansi(p).strip()], rest
