"""Claude Code CLI provider.

Spawns ``claude`` in stream-json mode and normalizes its output. The argv
builder mirrors geny-executor's ``claude_code_argv`` with the compat fixes that
matter for CLI >= 2.1.x:

* ``--verbose`` is required alongside ``--output-format stream-json``.
* ``--bare`` is only used on the api_key path; on the OAuth subscription path
  we must NOT pass ``--bare`` and must NOT inject ``ANTHROPIC_API_KEY``.
* Permissions: the runtime runs the CLI as a non-root user, so "agent" mode
  uses ``--permission-mode bypassPermissions`` — every tool works headless
  (subagents/Task, Skill, MCP, NotebookEdit…), exactly like Codex's bypass.
  "plan" mode uses ``--permission-mode plan`` (read-only, proposes a plan).
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from typing import AsyncIterator

from app.config import settings
from app.providers._attachments import claude_image_block, compose_text
from app.providers._cli_runtime import CLIProcessRunner
from app.providers._stream_json import StreamJsonAccumulator
from app.providers.base import (
    AuthStatus,
    Provider,
    ProviderEvent,
    SteerMessage,
    TurnRequest,
)
from app.providers.catalog import DEFAULT_CLAUDE_MODEL
from app.services.cli_tools.tools import effective_binary

_PERMISSION_MODE = {"agent": "bypassPermissions", "plan": "plan"}

# Environment every Claude process gets. Subagent prose/reasoning is only on
# the stream when asked for (``--forward-subagent-text``); the env form is used
# because an older CLI ignores it instead of rejecting an unknown flag.
CLI_ENV = {"CLAUDE_CODE_FORWARD_SUBAGENT_TEXT": "1"}

# Appended to Claude's system prompt. Every check of a sleep/poll loop is a
# full API call that re-reads the whole context (often 400k+ tokens), so
# waiting by polling burns plan usage for nothing; in this harness the engine
# stays alive between turns and a finished background task starts a new turn
# by itself, and the user sees that turn live.
WAIT_GUIDE = (
    "Waiting on long-running work in this environment: start it with Bash run_in_background "
    "(or as a background subagent) and end your turn, or keep doing other useful work. You are "
    "notified automatically when a background task finishes, even after your turn has ended, "
    "and you continue in a new turn that the user sees live. Do not wait with sleep commands, "
    "sleep/poll loops or repeated status checks: every check is a full model call that re-reads "
    "the entire conversation and burns the user's plan usage. If you must watch for a condition, "
    "use one background command that waits for it (or the Monitor tool when available) instead "
    "of polling from your own turn. This native background-notification rule does not apply to "
    "SSH remote_bash jobs: they have their own durable job IDs and live Tasks view. When a final result "
    "is requested, await the same ID with remote_poll(wait_ms=30000), never resubmit it or wrap it in "
    "local Bash. Leave SSH work running only when the user explicitly requested background execution."
)
AUTO_COMPACT_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"


class ClaudeCodeProvider(Provider):
    name = "claude"

    def __init__(self, binary: str | None = None) -> None:
        self._binary_arg = binary

    @property
    def _binary(self) -> str:
        """CLAUDE_BINARY — or the app's own copy after an upgrade switched to it (services/cli_tools)."""
        return self._binary_arg or effective_binary("claude")

    # ---- auth ----

    async def auth_status(self, *, api_key: str | None = None) -> AuthStatus:
        resolved = shutil.which(self._binary) or (
            self._binary if os.path.exists(self._binary) else None
        )
        if resolved is None:
            return AuthStatus(
                provider=self.name,
                connected=False,
                auth_mode="none",
                detail=f"claude binary not found ({self._binary})",
            )
        if api_key:
            return AuthStatus(
                provider=self.name, connected=True, auth_mode="api_key", detail="API key configured"
            )
        # OAuth subscription path: presence of the CLI auth file is our best signal.
        claude_home = os.path.expanduser("~/.claude")
        has_auth = any(
            os.path.exists(os.path.join(claude_home, f))
            for f in (".credentials.json", "credentials.json", "auth.json")
        )
        if not has_auth:
            from .native_login import logged_in
            has_auth = await asyncio.to_thread(logged_in, 'claude', resolved)
        return AuthStatus(
            provider=self.name,
            connected=has_auth,
            auth_mode="oauth",
            detail="subscription auth detected" if has_auth else "run `claude setup-token`",
        )

    # ---- argv ----

    def _build_argv(self, req: TurnRequest) -> list[str]:
        model = req.model or DEFAULT_CLAUDE_MODEL
        argv = [
            "--print",
            "--verbose",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--model",
            model,
            "--permission-mode",
            _PERMISSION_MODE.get(req.mode, "bypassPermissions"),
        ]
        if req.ephemeral:
            argv.append("--no-session-persistence")
        if req.system_prompt_file or req.system_prompt is not None:
            # A prompt of our own (Mate). Snapshot off: the CLI would otherwise
            # keep the first launch's prompt on every --resume, so an edited
            # persona would never reach the model.
            argv += (["--system-prompt-file", req.system_prompt_file] if req.system_prompt_file
                     else ["--system-prompt", req.system_prompt or ""])
            argv += ["--system-prompt-snapshot", "off"]
        else:
            argv += ["--append-system-prompt", WAIT_GUIDE + "".join(
                f"\n\n{x}" for x in (req.folders_note, req.system_append) if x)]
        if not req.sealed:
            for d in req.plugin_dirs:
                argv += ["--plugin-dir", d]
        if req.tools is not None:
            argv += ["--tools", ",".join(req.tools)]  # "" = no built-in tools at all
        if req.allowed_tools:
            argv += ["--allowedTools", ",".join(req.allowed_tools)]
        if req.sealed:
            argv += ["--disable-slash-commands", "--setting-sources", "local"]
        # Extra folders + the per-session uploads dir (attachments live outside
        # the workspace) become additional working directories.
        upload_dirs = {os.path.dirname(os.path.dirname(a.path)) for a in req.attachments}
        if req.uploads_dir:
            upload_dirs.add(req.uploads_dir)
        dirs = list(dict.fromkeys([*req.extra_dirs, *sorted(upload_dirs)]))
        if dirs:
            argv += ["--add-dir", *dirs]
        # Flag settings (highest-priority layer, every account's config dir alike): this app IS the remote
        # access to these sessions, so Claude Code's own Remote Control (claude.ai) never starts with them —
        # the pooled accounts' config dirs don't carry the user's ``remoteControlAtStartup: false``.
        flag_settings: dict = {"remoteControlAtStartup": False}
        if req.allow_tools:
            flag_settings["permissions"] = {"allow": list(req.allow_tools)}
        argv += ["--settings", json.dumps(flag_settings)]

        # Reasoning/think level -> --effort (omit for "default").
        if req.effort and req.effort != "default":
            argv += ["--effort", req.effort]

        # api_key path uses --bare; OAuth path must not.
        if req.api_key:
            argv.append("--bare")

        if req.cli_session_id:
            argv += ["--resume", req.cli_session_id]
            if req.fork_session:
                argv.append("--fork-session")
                if req.resume_at:
                    argv += ["--resume-session-at", req.resume_at]

        if req.mcp_config_file:
            argv += ["--mcp-config", req.mcp_config_file, "--strict-mcp-config"]
        elif req.mcp_config:
            argv += ["--mcp-config", json.dumps(req.mcp_config), "--strict-mcp-config"]

        return argv

    def _build_stdin(self, req: TurnRequest) -> bytes:
        """Render the latest user message as a single stream-json envelope.

        History continuity is handled by ``--resume`` (cli_session_id) when
        present; otherwise the caller flattens prior context into the message.
        Attached images become inline ``image`` blocks; every attachment is
        also listed (with its path) in the text block.
        """
        last_user = next(
            (m.get("content", "") for m in reversed(req.messages) if m.get("role") == "user"), ""
        )
        if req.preamble:
            last_user = f"{req.preamble}\n\n{last_user}"
        return self._envelope(last_user, req.attachments, inline_files=req.inline_files)

    # ---- persistent engine (one process per chat) ----

    def engine_fingerprint(self, req: TurnRequest) -> str:
        """Launch settings that need a process restart to change. Model and
        permission mode are switched live, so they're not part of it."""
        import hashlib

        key = json.dumps({
            "binary": self._binary,
            "cwd": req.cwd,
            "effort": req.effort or "default",
            "dirs": sorted(set(req.extra_dirs) | ({req.uploads_dir} if req.uploads_dir else set())),
            "mcp": req.mcp_config,
            "api_key": hashlib.sha256((req.api_key or "").encode()).hexdigest()[:12],
            "allow": sorted(req.allow_tools or []),
            "auto_compact": req.auto_compact_window or 0,
            "prompt": req.prompt_key or (
                hashlib.sha256(req.system_prompt.encode()).hexdigest() if req.system_prompt is not None
                else (req.system_prompt_file or "")
            ),
            "tools": req.tools,
            "allowed": sorted(req.allowed_tools or []),
            "sealed": req.sealed,
            # (only when set: chats from before keep their engine's fingerprint)
            **({"tool_env": req.tool_env} if req.tool_env else {}),
            **({"append": req.system_append} if req.system_append else {}),
            **({"folders": req.folders_note} if req.folders_note else {}),
            **({"plugins": req.plugin_dirs} if req.plugin_dirs else {}),
        }, sort_keys=True)
        return hashlib.sha256(key.encode()).hexdigest()

    def engine_argv(self, req: TurnRequest) -> list[str]:
        return self._build_argv(req)

    @staticmethod
    def engine_env(req: TurnRequest) -> dict[str, str]:
        """Launch environment from the turn's settings (on top of CLI_ENV)."""
        env: dict[str, str] = dict(req.tool_env)
        if req.auto_compact_window and req.auto_compact_window > 0:
            env[AUTO_COMPACT_ENV] = str(int(req.auto_compact_window))
        return env

    def envelope(self, req: TurnRequest) -> bytes:
        return self._build_stdin(req)

    @staticmethod
    def permission_mode(mode: str) -> str:
        return _PERMISSION_MODE.get(mode, "bypassPermissions")

    @staticmethod
    def _envelope(text: str, attachments: list, *, inline_files: bool = False) -> bytes:
        content: str | list[dict] = text
        if attachments:
            blocks: list[dict] = []
            for a in attachments:
                if a.is_image:
                    try:
                        blocks.append(claude_image_block(a))
                    except OSError:
                        pass
            body = compose_text(text, attachments, inline_images=bool(blocks), inline_files=inline_files)
            content = [*blocks, {"type": "text", "text": body}]
        return (json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n").encode()

    # ---- turn ----

    async def run_turn_stream(self, req: TurnRequest) -> AsyncIterator[ProviderEvent]:
        env_extras = {**CLI_ENV, **self.engine_env(req), **req.extra_env}
        if req.api_key:
            env_extras["ANTHROPIC_API_KEY"] = req.api_key

        runner = CLIProcessRunner(
            binary=self._binary,
            cwd=req.cwd,
            env_extras=env_extras,
            timeout_s=req.timeout_s or settings.turn_timeout_s,
        )
        argv = self._build_argv(req)
        stdin = self._build_stdin(req)
        accum = StreamJsonAccumulator()

        yield ProviderEvent(
            type="session.start",
            data={"provider": self.name, "model": req.model or DEFAULT_CLAUDE_MODEL, "workspace": req.cwd},
        )

        # Steering: stdin stays open while the turn runs; extra instructions are
        # written as further user messages and the CLI folds them into the
        # running turn at its next step (exactly like typing into Claude Code
        # while it works). Input closes once the final result is in.
        inbox = req.inbox
        feeder: asyncio.Task | None = None
        if inbox is not None:
            async def feed() -> None:
                while True:
                    msg: SteerMessage = await inbox.queue.get()
                    msg.resolve(await runner.write(self._envelope(msg.text, msg.attachments, inline_files=msg.inline_files)))

            feeder = asyncio.create_task(feed())

        saw_terminal = False
        try:
            async for line in runner.stream(argv, stdin=stdin, keep_stdin_open=inbox is not None):
                for ev in accum.feed_line(line):
                    if ev.type in ("turn.complete", "error"):
                        saw_terminal = True
                        if inbox is not None:
                            inbox.close()
                            runner.close_stdin()
                    yield ev
        except TimeoutError:  # asyncio.TimeoutError is an alias of TimeoutError on 3.11+
            yield ProviderEvent(
                type="error",
                data={"code": "exec.cli.timeout", "message": "agent turn timed out"},
            )
            return
        except FileNotFoundError:
            yield ProviderEvent(
                type="error",
                data={
                    "code": "exec.cli.binary_not_found",
                    "message": f"claude binary not found: {self._binary}",
                },
            )
            return
        finally:
            if feeder is not None:
                feeder.cancel()
            if inbox is not None:
                inbox.close()
            runner.close_stdin()

        if not saw_terminal:
            result = runner.last_result
            if result is not None and result.returncode != 0:
                yield ProviderEvent(
                    type="error",
                    data={
                        "code": "exec.cli.exited",
                        "message": (result.stderr or "claude exited non-zero")[:2000],
                    },
                )
            else:
                # Stream ended without an explicit result line — synthesize completion.
                yield ProviderEvent(
                    type="turn.complete",
                    data={
                        "text": accum.final_text,
                        "model": accum.model,
                        "usage": accum.usage,
                        **accum.cost_fields(),
                        "stop_reason": accum.stop_reason or "end_turn",
                        "cli_session_id": accum.session_id,
                        "cli_at": accum.assistant_uuid,
                    },
                )
