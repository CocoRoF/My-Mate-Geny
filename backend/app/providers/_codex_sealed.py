"""A sealed Codex engine (a Mate): its own CODEX_HOME, nothing of the user's.

Codex's equivalent of the Claude mate's ``--system-prompt-file`` /
``--tools ""`` / ``--strict-mcp-config`` / ``--setting-sources local``:

* **Own home.** ``CODEX_HOME`` (and ``HOME``) point at a private directory the
  provider owns (``TurnRequest.engine_home``). The user's ``~/.codex`` —
  config.toml (their MCP servers, profiles, hooks), AGENTS.md, skills,
  plugins, memories, rules — is never read. Only the account's ``auth.json``
  is linked in (a symlink to the account's own file, so a token refresh
  writes through to it: codex 0.166 writes auth.json in place). The mate's
  threads live here, so ``exec resume`` works whichever pooled account runs
  the next turn.
* **Config.** ``config.toml`` (0600 — it holds the bridge token, which never
  appears in the process list) is regenerated every turn: the instructions
  file as ``model_instructions_file`` (replaces Codex's base instructions;
  a resumed thread picks a changed file up), only the given MCP servers
  (their tools pre-approved), no web search, no AGENTS.md, no skills, the
  shell / unified-exec / image / memory / plugin / app / hook / multi-agent /
  goal … features off, read-only sandbox and ``approval_policy = "never"``
  as the backstop.
* **Model catalog.** Some models bring tools of their own regardless of
  features (``apply_patch_tool_type``, code mode, multi-agent, tool search,
  experimental tools). ``model_catalog_json`` points at a copy of the
  account's ``models_cache.json`` with exactly those fields stripped. When
  there is no cache to copy, the engine still runs (sandbox + approvals keep
  it from changing anything) and the caller gets a warning.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from app.providers.base import TurnRequest

CONFIG = "config.toml"
CATALOG = "sealed-models.json"
# Linked from the account's CODEX_HOME (auth.lock only when it has one: the
# same lock file then guards a token refresh from both homes).
_LINKED = ("auth.json", "auth.lock")

# `codex features list` (0.166): everything that gives the model a tool or
# loads user state. Unknown names only warn, so older/newer CLIs still start.
FEATURES_OFF = (
    "shell_tool", "unified_exec", "shell_snapshot", "view_image", "image_generation", "memories",
    "plugins", "apps", "hooks", "goals", "multi_agent", "multi_agent_v2", "browser_use", "computer_use",
    "in_app_browser", "tool_suggest", "skill_search", "sleep_tool",
)
# Per-model fields that add tools whatever the features say.
_MODEL_TOOL_FIELDS = ("tool_mode", "multi_agent_version", "multi_agent_reasoning_effort")
_SERVER_NAME = re.compile(r"[A-Za-z0-9_-]+")


def _toml_str(v: Any) -> str:
    # A JSON string is a TOML basic string (same escapes); DEL is the one
    # control character JSON leaves raw.
    return json.dumps(str(v), ensure_ascii=False).replace("\x7f", "\\u007f")


def sealed_catalog(models_cache: Path) -> dict[str, Any] | None:
    """The account's model list without the tools models bring themselves."""
    try:
        data = json.loads(models_cache.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    models = data.get("models") if isinstance(data, dict) else None
    out = []
    for m in models if isinstance(models, list) else []:
        if not isinstance(m, dict) or not m.get("slug"):
            continue
        m = {k: v for k, v in m.items() if k not in _MODEL_TOOL_FIELDS}
        m.update(apply_patch_tool_type=None, experimental_supported_tools=[], supports_search_tool=False,
                 node_repl_disabled=True)
        out.append(m)
    return {"models": out} if out else None


def sealed_config(*, instructions_file: str | None, catalog_file: str | None,
                  mcp_servers: dict[str, Any]) -> str:
    lines = [
        "# Written by My Mate Geny for a sealed Mate engine; regenerated every turn.",
        *([f"model_instructions_file = {_toml_str(instructions_file)}"] if instructions_file else []),
        *([f"model_catalog_json = {_toml_str(catalog_file)}"] if catalog_file else []),
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        "project_doc_max_bytes = 0",
        "check_for_update_on_startup = false",
        "include_permissions_instructions = false",
        "include_collaboration_mode_instructions = false",
        "include_apps_instructions = false",
        "",
        "[history]",
        'persistence = "none"',
        "",
        "[skills]",
        "include_instructions = false",
        "bundled = { enabled = false }",
        "",
        "[features]",
        *(f"{f} = false" for f in FEATURES_OFF),
    ]
    for name, spec in mcp_servers.items():
        if not _SERVER_NAME.fullmatch(name) or not isinstance(spec, dict) or not spec.get("command"):
            continue
        env = spec.get("env") or {}
        lines += [
            "",
            f"[mcp_servers.{name}]",
            f"command = {_toml_str(spec['command'])}",
            "args = [" + ", ".join(_toml_str(a) for a in spec.get("args") or []) + "]",
            *(["env = { " + ", ".join(f"{_toml_str(k)} = {_toml_str(v)}" for k, v in env.items()) + " }"]
              if env else []),
            'default_tools_approval_mode = "approve"',
            "startup_timeout_sec = 30",
        ]
    return "\n".join(lines) + "\n"


def _write(path: Path, content: str) -> None:
    """0600, atomically, and only when it changed."""
    try:
        if path.read_text("utf-8") == content:
            return
    except OSError:
        pass
    tmp = path.with_name(path.name + ".part")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(content)
    os.replace(tmp, path)


def _link_auth(source: Path, home: Path) -> None:
    for name in _LINKED:
        src, dst = source / name, home / name
        if src.exists():
            if dst.is_symlink() and os.readlink(dst) == str(src):
                continue
            if dst.is_symlink() or dst.is_file():
                dst.unlink()
            dst.symlink_to(src)
        elif dst.is_symlink() or dst.is_file():
            dst.unlink()  # signed out / API key: no stale credentials of another account


def prepare(req: TurnRequest, source_home: str) -> tuple[dict[str, str], list[str]]:
    """Build ``req.engine_home`` for this turn -> (env for the CLI, warnings).
    ``source_home``: the CODEX_HOME whose login this turn uses (the host's
    ``~/.codex`` or a pooled account's). Blocking file I/O: run in a thread."""
    assert req.engine_home
    home = Path(req.engine_home)
    home.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(home, 0o700)
    except OSError:
        pass
    source = Path(source_home)
    _link_auth(source, home)
    warnings: list[str] = []
    # (the engine's own cache, from an earlier turn, when the account has none)
    catalog = sealed_catalog(source / "models_cache.json") or sealed_catalog(home / "models_cache.json")
    catalog_file = None
    if catalog is not None:
        catalog_file = str(home / CATALOG)
        _write(home / CATALOG, json.dumps(catalog, ensure_ascii=False))
    else:
        (home / CATALOG).unlink(missing_ok=True)
        warnings.append("No Codex model list to seal (models_cache.json): the mate runs with the model's "
                        "default tool set, held read-only by the sandbox. Open a Codex chat once to fetch it.")
    _write(home / CONFIG, sealed_config(
        instructions_file=req.system_prompt_file, catalog_file=catalog_file,
        mcp_servers=(req.mcp_config or {}).get("mcpServers") or {},
    ))
    return {"CODEX_HOME": str(home), "HOME": str(home)}, warnings
