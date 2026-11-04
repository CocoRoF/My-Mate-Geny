"""The CLIs the app drives, and which binary of each it actually runs.

Every place that launches a provider CLI asks :func:`effective_binary` — the
configured one (``CLAUDE_BINARY`` / ``CODEX_BINARY`` / ``HIGGSFIELD_BINARY``),
unless an upgrade installed the app's own copy under ``cli_managed_prefix``
because the configured copy can't be written (Docker: the image's ``/usr``),
in which case that copy is used from then on (``use_managed`` in the state
file, ``~/.hr-harnessor/cli-state.json``; "Use bundled copy" turns it off).
"""

from __future__ import annotations

import json
import os
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path

from app.config import settings


@dataclass(frozen=True)
class ToolSpec:
    id: str
    label: str
    pkg: str                      # npm package
    bin_name: str                 # the executable it installs
    setting: str                  # Settings attribute with the configured binary
    env: str                      # its env var (read directly if Settings has no such field)
    channels: tuple[str, ...] = ("latest",)
    native: bool = False          # has Claude Code's native installer
    fallbacks: tuple[str, ...] = ()  # where to look when it's not on PATH
    notes: str = "github"         # claude_changelog | github
    gh_repo: str = ""
    gh_tag: str = "v{v}"
    changelog_url: str = ""
    restart: str = "next_turn"    # engine_restart: persistent engines keep the old binary until restarted


TOOLS: dict[str, ToolSpec] = {
    "claude": ToolSpec(
        id="claude", label="Claude Code", pkg="@anthropic-ai/claude-code", bin_name="claude",
        setting="claude_binary", env="CLAUDE_BINARY", channels=("latest", "stable"), native=True,
        notes="claude_changelog", gh_repo="anthropics/claude-code",
        changelog_url="https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
        restart="engine_restart", fallbacks=("~/.local/bin/claude", "~/.local/bin/claude.exe"),
    ),
    "codex": ToolSpec(
        id="codex", label="Codex", pkg="@openai/codex", bin_name="codex",
        setting="codex_binary", env="CODEX_BINARY", fallbacks=("~/.local/bin/codex", "~/.local/bin/codex.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs/OpenAI/Codex/bin/codex.exe")), gh_repo="openai/codex", gh_tag="rust-v{v}",
    ),
    "higgsfield": ToolSpec(
        id="higgsfield", label="Higgsfield", pkg="@higgsfield/cli", bin_name="higgsfield",
        setting="higgsfield_binary", env="HIGGSFIELD_BINARY", fallbacks=("~/.local/bin/higgsfield",),
        gh_repo="higgsfield-ai/cli", gh_tag="v{v}",
    ),
}


def release_url(spec: ToolSpec, version: str | None) -> str:
    if spec.changelog_url:
        return spec.changelog_url
    if spec.gh_repo and version:
        return f"https://github.com/{spec.gh_repo}/releases/tag/{spec.gh_tag.format(v=version)}"
    return f"https://github.com/{spec.gh_repo}/releases" if spec.gh_repo else ""


def managed_prefix() -> str:
    return str(Path(os.path.expanduser(settings.cli_managed_prefix)).resolve())


def managed_binary(tool: str) -> str:
    return os.path.join(managed_prefix(), "bin", TOOLS[tool].bin_name)


def state_file() -> Path:
    return settings.home_dir / "cli-state.json"


# ---- persisted per-tool choices: use_managed, auto_upgrade, channel, previous ----

_lock = threading.Lock()
_state: dict | None = None
_state_path: Path | None = None


def load_state() -> dict:
    global _state, _state_path
    path = state_file()
    with _lock:
        if _state is None or _state_path != path:
            try:
                data = json.loads(path.read_text())
            except (OSError, ValueError):
                data = {}
            _state = data if isinstance(data, dict) else {}
            _state_path = path
        return _state


def tool_state(tool: str) -> dict:
    st = load_state().get(tool)
    return st if isinstance(st, dict) else {}


def update_state(tool: str, **patch) -> dict:
    state = load_state()
    with _lock:
        cur = dict(state.get(tool) or {})
        for k, v in patch.items():
            if v is None:
                cur.pop(k, None)
            else:
                cur[k] = v
        state[tool] = cur
        path = state_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2, sort_keys=True))
        os.replace(tmp, path)
        return cur


def reset_state_cache() -> None:
    global _state
    with _lock:
        _state = None


# ---- binaries ----


def configured_binary(tool: str) -> str:
    spec = TOOLS[tool]
    val = getattr(settings, spec.setting, None) or os.environ.get(spec.env) or spec.bin_name
    return str(val)


def resolve_path(binary: str, fallbacks: tuple[str, ...] = ()) -> str | None:
    """Where ``binary`` is, as this process would run it (PATH lookup)."""
    found = shutil.which(binary)
    if found:
        return os.path.abspath(found)
    if os.sep in binary and os.path.isfile(binary) and os.access(binary, os.X_OK):
        return os.path.abspath(binary)
    for fb in fallbacks:
        p = os.path.expandvars(os.path.expanduser(fb))
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def using_managed(tool: str) -> bool:
    return bool(tool_state(tool).get("use_managed")) and os.path.exists(managed_binary(tool))


def effective_binary(tool: str) -> str:
    """The binary sessions launch for ``tool`` (a name looked up on PATH, or a path)."""
    if using_managed(tool):
        return managed_binary(tool)
    spec = TOOLS[tool]
    configured = configured_binary(tool)
    if spec.fallbacks and shutil.which(configured) is None and os.sep not in configured:
        return resolve_path(configured, spec.fallbacks) or configured
    return configured
