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
from app.providers.catalog import codex_model_known
from app.providers.base import AuthStatus, Provider, ProviderEvent, TurnRequest

# Model ids that belong to Claude (or mean "no preference") — never pass to Codex.
_NOT_CODEX = {"", "default", "sonnet", "opus", "haiku"}

_PLAN_PREFIX = (
    "[PLAN MODE] Do not modify any files or run state-changing commands. Investigate "
    "read-only, then reply with a concrete step-by-step plan for the request below and "
    "wait for approval.\n\n"
)


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

    @staticmethod
    def _model(req: TurnRequest) -> str | None:
        """The model to pass with -m, or None to let Codex use the account default."""
        if req.model in _NOT_CODEX:
            return None
        return req.model if codex_model_known(req.model) is not False else None

    def _build_argv(self, req: TurnRequest) -> list[str]:
        # NB: `exec resume` accepts far fewer flags than `exec` (no -C, --sandbox,
        # --add-dir). The working dir comes from the process cwd either way, and
        # the sandbox is set through `-c sandbox_mode=…`, which both accept.
        resume = bool(req.cli_session_id)
        argv = ["exec", "resume", req.cli_session_id] if resume else ["exec"]
        argv.append("--json")
        # Images first, each as its own `--image <path>` and always followed by
        # another flag: `-i` takes multiple values and would otherwise swallow
        # the trailing prompt argument.
        for a in req.attachments:
            if a.is_image:
                argv += ["--image", a.inline_path]
        argv.append("--skip-git-repo-check")
        if req.mode == "plan":
            argv += ["-c", 'sandbox_mode="read-only"']
        else:
            argv.append("--dangerously-bypass-approvals-and-sandbox")
        if not resume:
            argv += ["-C", req.cwd]
        model = self._model(req)
        if model:
            argv += ["-m", model]
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
        text = compose_text(last_user, req.attachments, inline_images=has_images)
        if req.extra_dirs:
            text += "\n\n<additional_folders>\nYou may also read and edit these folders:\n" + "\n".join(
                f"- {d}" for d in req.extra_dirs
            ) + "\n</additional_folders>"
        if req.mode == "plan":
            text = _PLAN_PREFIX + text
        return text.encode()

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
        model = self._model(req)

        yield ProviderEvent(
            type="session.start",
            data={"provider": self.name, "model": model or "default", "workspace": req.cwd},
        )
        if req.model and req.model not in _NOT_CODEX and model is None:
            yield ProviderEvent(
                type="notice",
                data={
                    "level": "warning",
                    "code": "codex.model_unavailable",
                    "message": f"'{req.model}' is not available for this Codex account — "
                               "using the account's default model. Pick a model from the list.",
                },
            )

        try:
            async for line in runner.stream(self._build_argv(req), stdin=self._build_prompt(req)):
                for ev in accum.feed_line(line):
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
        if not accum.completed and not accum.failed and result is not None and result.returncode != 0:
            accum.last_error = (result.stderr or accum.last_error or "codex exited non-zero")[-2000:]
        yield accum.terminal(model=model or "codex (default)", cli_session_id=req.cli_session_id)
