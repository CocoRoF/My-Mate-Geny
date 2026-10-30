"""Codex (OpenAI CLI) provider.

Spawns ``codex exec --json`` and normalizes its JSONL event stream (see
:mod:`app.providers._codex_json`). Non-interactive automation uses
``--dangerously-bypass-approvals-and-sandbox`` because the harness is the
sandbox boundary (same spirit as the Claude provider's permission allow-list).

Auth: ``codex login`` (ChatGPT OAuth, stored under ``~/.codex``) or an
``OPENAI_API_KEY`` passed through. Execution requires one of these — the
provider surfaces a clear error otherwise.
"""

from __future__ import annotations

import os
import shutil
from typing import AsyncIterator

from app.config import settings
from app.providers._attachments import compose_text
from app.providers._cli_runtime import CLIProcessRunner
from app.providers._codex_json import CodexJsonAccumulator
from app.providers.base import AuthStatus, Provider, ProviderEvent, TurnRequest

# Model aliases that belong to Claude — ignore them for Codex (use its default).
_CLAUDE_ALIASES = {"", "sonnet", "opus", "haiku"}


class CodexProvider(Provider):
    name = "codex"

    def __init__(self, binary: str | None = None) -> None:
        self._binary = binary or settings.codex_binary

    async def auth_status(self, *, api_key: str | None = None) -> AuthStatus:
        resolved = shutil.which(self._binary) or (
            self._binary if os.path.exists(self._binary) else None
        )
        if resolved is None:
            return AuthStatus(
                provider=self.name,
                connected=False,
                auth_mode="none",
                detail="codex CLI not installed (npm i -g @openai/codex)",
            )
        if api_key:
            return AuthStatus(
                provider=self.name, connected=True, auth_mode="api_key", detail="API key configured"
            )
        auth_file = os.path.expanduser("~/.codex/auth.json")
        has_auth = os.path.exists(auth_file)
        return AuthStatus(
            provider=self.name,
            connected=has_auth,
            auth_mode="oauth",
            detail="codex login detected" if has_auth else "run `codex login` (or set an API key)",
        )

    def _build_argv(self, req: TurnRequest) -> list[str]:
        if req.cli_session_id:
            # Resume the prior thread; otherwise start fresh.
            argv = ["exec", "resume", req.cli_session_id]
        else:
            argv = ["exec"]
        argv.append("--json")
        # Images first, each as its own `--image <path>` and always followed by
        # another flag: `-i` takes multiple values and would otherwise swallow
        # the trailing prompt argument.
        for a in req.attachments:
            if a.is_image:
                argv += ["--image", a.inline_path]
        argv += [
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "-C",
            req.cwd,
        ]
        if req.model and req.model not in _CLAUDE_ALIASES:
            argv += ["-m", req.model]
        if req.effort and req.effort != "default":
            argv += ["-c", f"model_reasoning_effort={req.effort}"]
        # Prompt comes from stdin (`-`): safe for any text, including text that
        # starts with "-" or is very long.
        argv.append("-")
        return argv

    def _build_prompt(self, req: TurnRequest) -> bytes:
        last_user = next(
            (m["content"] for m in reversed(req.messages) if m.get("role") == "user"), ""
        )
        has_images = any(a.is_image for a in req.attachments)
        return compose_text(last_user, req.attachments, inline_images=has_images).encode()

    async def run_turn_stream(self, req: TurnRequest) -> AsyncIterator[ProviderEvent]:
        env_extras = dict(req.extra_env)
        if req.api_key:
            env_extras["OPENAI_API_KEY"] = req.api_key

        runner = CLIProcessRunner(
            binary=self._binary,
            cwd=req.cwd,
            env_extras=env_extras,
            timeout_s=req.timeout_s or settings.turn_timeout_s,
        )
        accum = CodexJsonAccumulator()

        yield ProviderEvent(
            type="session.start",
            data={"provider": self.name, "model": req.model or "default", "workspace": req.cwd},
        )

        saw_error = False
        try:
            async for line in runner.stream(self._build_argv(req), stdin=self._build_prompt(req)):
                for ev in accum.feed_line(line):
                    if ev.type == "error":
                        saw_error = True
                    yield ev
        except TimeoutError:
            yield ProviderEvent(
                type="error", data={"code": "exec.cli.timeout", "message": "codex turn timed out"}
            )
            return
        except FileNotFoundError:
            yield ProviderEvent(
                type="error",
                data={"code": "exec.cli.binary_not_found", "message": f"codex not found: {self._binary}"},
            )
            return

        result = runner.last_result
        if result is not None and result.returncode != 0 and not saw_error:
            yield ProviderEvent(
                type="error",
                data={"code": "exec.cli.exited", "message": (result.stderr or "codex exited non-zero")[:2000]},
            )
            return
        if not saw_error:
            yield accum.terminal(req.cli_session_id)
