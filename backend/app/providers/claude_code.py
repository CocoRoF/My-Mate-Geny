"""Claude Code CLI provider.

Spawns ``claude`` in stream-json mode and normalizes its output. The argv
builder mirrors geny-executor's ``claude_code_argv`` with the compat fixes that
matter for CLI >= 2.1.x:

* ``--verbose`` is required alongside ``--output-format stream-json``.
* ``--bare`` is only used on the api_key path; on the OAuth subscription path
  we must NOT pass ``--bare`` and must NOT inject ``ANTHROPIC_API_KEY``.
* ``bypassPermissions`` is blocked when running as root, so we pre-allow tools
  via an inline ``--settings`` permission allow-list instead.
"""

from __future__ import annotations

import json
import os
import shutil
from typing import AsyncIterator

from app.config import settings
from app.providers._cli_runtime import CLIProcessRunner
from app.providers._stream_json import StreamJsonAccumulator
from app.providers.base import (
    AuthStatus,
    Provider,
    ProviderEvent,
    TurnRequest,
)

# Built-in tools we pre-allow so the agent runs without interactive prompts.
_DEFAULT_ALLOW = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"]


class ClaudeCodeProvider(Provider):
    name = "claude"

    def __init__(self, binary: str | None = None) -> None:
        self._binary = binary or settings.claude_binary

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
        return AuthStatus(
            provider=self.name,
            connected=has_auth,
            auth_mode="oauth",
            detail="subscription auth detected" if has_auth else "run `claude setup-token`",
        )

    # ---- argv ----

    def _build_argv(self, req: TurnRequest) -> list[str]:
        model = req.model or "sonnet"
        allow = req.allow_tools or _DEFAULT_ALLOW
        settings_inline = json.dumps({"permissions": {"allow": allow}})

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
            "--settings",
            settings_inline,
        ]

        # api_key path uses --bare; OAuth path must not.
        if req.api_key:
            argv.append("--bare")

        if req.cli_session_id:
            argv += ["--resume", req.cli_session_id]

        if req.mcp_config:
            argv += ["--mcp-config", json.dumps(req.mcp_config), "--strict-mcp-config"]

        return argv

    def _build_stdin(self, req: TurnRequest) -> bytes:
        """Render the latest user message as a single stream-json envelope.

        History continuity is handled by ``--resume`` (cli_session_id) when
        present; otherwise the caller flattens prior context into the message.
        """
        last_user = ""
        for msg in reversed(req.messages):
            if msg.get("role") == "user":
                last_user = msg.get("content", "")
                break
        envelope = {
            "type": "user",
            "message": {"role": "user", "content": last_user},
        }
        return (json.dumps(envelope) + "\n").encode()

    # ---- turn ----

    async def run_turn_stream(self, req: TurnRequest) -> AsyncIterator[ProviderEvent]:
        env_extras = dict(req.extra_env)
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
            data={"provider": self.name, "model": req.model or "sonnet", "workspace": req.cwd},
        )

        saw_terminal = False
        try:
            async for line in runner.stream(argv, stdin=stdin):
                for ev in accum.feed_line(line):
                    if ev.type in ("turn.complete", "error"):
                        saw_terminal = True
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
                        "cost_usd": accum.cost_usd,
                        "stop_reason": accum.stop_reason or "end_turn",
                        "cli_session_id": accum.session_id,
                    },
                )
