"""Codex (OpenAI CLI) provider.

Spawns ``codex exec --json`` and normalizes its JSONL event stream (see
:mod:`app.providers._codex_json`). Non-interactive automation uses
``--dangerously-bypass-approvals-and-sandbox`` because the harness is the
sandbox boundary (same spirit as the Claude provider's permission allow-list).

A *sealed* request (a Mate) runs differently: in its own CODEX_HOME with only
its instructions and MCP bridge, none of Codex's tools, read-only sandbox and
no approvals (see :mod:`app.providers._codex_sealed`).

Auth: ``codex login`` (ChatGPT OAuth, stored under ``~/.codex``) or an
``OPENAI_API_KEY`` passed through. Execution requires one of these — the
provider surfaces a clear error otherwise.
"""

from __future__ import annotations

import asyncio
import json
import re
import os
import shutil
from typing import AsyncIterator

from app.config import settings
from app.providers import _codex_sealed
from app.providers._attachments import compose_text
from app.providers._cli_runtime import CLIProcessRunner
from app.providers._codex_json import CodexJsonAccumulator
from app.providers.catalog import codex_model_known
from app.providers.base import AuthStatus, Provider, ProviderEvent, SteerMessage, TurnRequest

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

    def _build_argv(
        self, req: TurnRequest, *, resume_id: str | None = None, images: list | None = None
    ) -> list[str]:
        # NB: `exec resume` accepts far fewer flags than `exec` (no -C, --sandbox,
        # --add-dir). The working dir comes from the process cwd either way, and
        # the sandbox is set through `-c sandbox_mode=…`, which both accept.
        resume = resume_id if resume_id is not None else req.cli_session_id
        argv = ["exec", "resume", resume] if resume else ["exec"]
        argv.append("--json")
        # Images first, each as its own `--image <path>` and always followed by
        # another flag: `-i` takes multiple values and would otherwise swallow
        # the trailing prompt argument.
        for a in req.attachments if images is None else images:
            if a.is_image:
                argv += ["--image", a.inline_path]
        argv.append("--skip-git-repo-check")
        if req.sealed:
            pass  # sandbox, approvals, tools and MCP servers: the sealed home's config.toml
        elif req.mode == "plan":
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
        if not req.sealed:  # (sealed: in its config file — the bridge token stays out of the process list)
            argv += self._mcp_overrides(req)
        # Prompt comes from stdin (`-`): safe for any text, including text that
        # starts with "-" or is very long.
        argv.append("-")
        return argv

    @staticmethod
    def _mcp_overrides(req: TurnRequest) -> list[str]:
        """MCP servers (e.g. the remote-workspace bridge) as `-c mcp_servers.*`
        config overrides — values are TOML (JSON strings/arrays are valid TOML)."""
        servers = (req.mcp_config or {}).get("mcpServers") or {}
        out: list[str] = []
        for name, spec in servers.items():
            if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not spec.get("command"):
                continue
            out += ["-c", f"mcp_servers.{name}.command={json.dumps(spec['command'])}"]
            out += ["-c", f"mcp_servers.{name}.args={json.dumps(list(spec.get('args') or []))}"]
            env = spec.get("env") or {}
            if env:
                table = ", ".join(f"{json.dumps(str(k))} = {json.dumps(str(v))}" for k, v in env.items())
                out += ["-c", f"mcp_servers.{name}.env={{{table}}}"]
        return out

    def _build_prompt(self, req: TurnRequest) -> bytes:
        last_user = next(
            (m["content"] for m in reversed(req.messages) if m.get("role") == "user"), ""
        )
        has_images = any(a.is_image for a in req.attachments)
        if req.preamble:
            last_user = f"{req.preamble}\n\n{last_user}"
        text = compose_text(last_user, req.attachments, inline_images=has_images, inline_files=req.inline_files)
        if req.extra_dirs:
            text += "\n\n<additional_folders>\nYou may also read and edit these folders:\n" + "\n".join(
                f"- {d}" for d in req.extra_dirs
            ) + "\n</additional_folders>"
        if req.system_append and req.note_in_prompt:
            # (Codex's developer_instructions would replace the user's own: the note rides in the message,
            # once per thread / when it changes)
            text = f"<environment_note>\n{req.system_append}\n</environment_note>\n\n{text}"
        if req.mode == "plan":
            text = _PLAN_PREFIX + text
        return text.encode()

    @staticmethod
    def _steer_prompt(req: TurnRequest, msgs: list[SteerMessage]) -> bytes:
        atts = [a for m in msgs for a in m.attachments]
        body = "\n\n".join(m.text for m in msgs if m.text.strip())
        text = compose_text(
            "The user sent additional instructions while you were working "
            "(your current step was interrupted to apply them). Take them into account "
            "and continue the task:\n\n" + body,
            atts,
            inline_images=any(a.is_image for a in atts),
            inline_files=req.inline_files or any(m.inline_files for m in msgs),
        )
        return ((_PLAN_PREFIX if req.mode == "plan" else "") + text).encode()

    async def run_turn_stream(self, req: TurnRequest) -> AsyncIterator[ProviderEvent]:
        env_extras = {**({} if req.sealed else req.tool_env), **req.extra_env}
        if req.api_key:
            env_extras["OPENAI_API_KEY"] = req.api_key
        warnings: list[str] = []
        if req.sealed:
            # A Mate: its own CODEX_HOME with only its instructions + MCP
            # bridge; the login of this turn's account linked in.
            if not req.engine_home:
                yield ProviderEvent(type="error", data={
                    "code": "exec.cli.sealed_home", "message": "sealed Codex engine without a home directory"})
                return
            source = env_extras.get("CODEX_HOME") or os.path.expanduser("~/.codex")
            try:
                env, warnings = await asyncio.to_thread(_codex_sealed.prepare, req, source)
            except OSError as exc:
                yield ProviderEvent(type="error", data={
                    "code": "exec.cli.sealed_home", "message": f"could not prepare the Codex engine: {exc}"})
                return
            env_extras.update(env)

        accum = CodexJsonAccumulator()
        model = self._model(req)

        yield ProviderEvent(
            type="session.start",
            data={"provider": self.name, "model": model or "default", "workspace": req.cwd},
        )
        for w in warnings:
            yield ProviderEvent(type="notice", data={"level": "warning", "code": "codex.sealed", "message": w})
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

        # `codex exec` reads its prompt once, so steering = interrupt the
        # current step and resume the SAME thread with the new instructions.
        inbox = req.inbox
        argv = self._build_argv(req)
        prompt = self._build_prompt(req)
        try:
            while True:
                runner = CLIProcessRunner(
                    binary=self._binary,
                    cwd=req.cwd,
                    env_extras=env_extras,
                    timeout_s=req.timeout_s or settings.turn_timeout_s,
                )
                pending: list[SteerMessage] = []
                interrupted = asyncio.Event()

                async def watch() -> None:
                    msg = await inbox.queue.get()
                    pending.append(msg)
                    # Need a thread id to resume into; it arrives right away.
                    while not (accum.thread_id or req.cli_session_id) and runner.last_result is None:
                        await asyncio.sleep(0.2)
                    while not inbox.queue.empty():
                        pending.append(inbox.queue.get_nowait())
                    for m in pending:
                        m.resolve(True)
                    interrupted.set()
                    runner.terminate()

                watcher = asyncio.create_task(watch()) if inbox is not None else None
                accum.begin_run()
                try:
                    async for line in runner.stream(argv, stdin=prompt):
                        for ev in accum.feed_line(line):
                            yield ev
                finally:
                    if watcher is not None:
                        watcher.cancel()

                if not pending:
                    break
                for m in pending:  # applied below, whatever the watcher got to
                    m.resolve(True)
                if interrupted.is_set() and not accum.completed:
                    for ev in accum.close_open_tools("(interrupted to apply your new instructions)"):
                        yield ev
                    yield ProviderEvent(type="notice", data={
                        "level": "info", "code": "codex.steered",
                        "message": "Interrupted the current step to apply your instructions",
                    })
                thread = accum.thread_id or req.cli_session_id
                if not thread:  # nothing to resume into — give up on steering
                    break
                images = [a for m in pending for a in m.attachments]
                argv = self._build_argv(req, resume_id=thread, images=images)
                prompt = self._steer_prompt(req, pending)
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
        finally:
            if inbox is not None:
                inbox.close()

        result = runner.last_result
        if not accum.completed and not accum.failed and result is not None and result.returncode != 0:
            accum.last_error = (result.stderr or accum.last_error or "codex exited non-zero")[-2000:]
        yield accum.terminal(model=model or "codex (default)", cli_session_id=req.cli_session_id)
