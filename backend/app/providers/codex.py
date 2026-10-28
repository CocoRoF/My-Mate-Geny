"""Codex (OpenAI CLI) provider — interface stub.

The ``codex`` CLI is not installed on this host yet. This class implements the
:class:`Provider` contract so the rest of the system (sessions, routing, UI)
can treat Codex as a first-class provider today; ``run_turn_stream`` yields a
single actionable ``error`` event until the CLI is wired.

TODO (when codex is available):
  * Install:  npm i -g @openai/codex   (binary name: ``codex``)
  * Non-interactive run:  ``codex exec --json "<prompt>"`` streams JSONL events,
    OR the richer ``codex proto`` stdin/stdout protocol. Map its events to the
    same normalized schema in a dedicated accumulator (mirror
    ``_stream_json.StreamJsonAccumulator``): message deltas -> text.delta,
    tool/exec calls -> tool.use/tool.result, final -> turn.complete.
  * Auth: ``codex login`` (ChatGPT OAuth) or OPENAI_API_KEY env. Report it in
    :meth:`auth_status` like the Claude provider does for ~/.claude.
  * cwd = workspace path; remote workspaces get the same sshfs-mount treatment.
"""

from __future__ import annotations

import os
import shutil
from typing import AsyncIterator

from app.config import settings
from app.providers.base import AuthStatus, Provider, ProviderEvent, TurnRequest


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
        codex_home = os.path.expanduser("~/.codex")
        has_auth = os.path.exists(os.path.join(codex_home, "auth.json"))
        return AuthStatus(
            provider=self.name,
            connected=has_auth,
            auth_mode="oauth",
            detail="codex login detected" if has_auth else "run `codex login`",
        )

    async def run_turn_stream(self, req: TurnRequest) -> AsyncIterator[ProviderEvent]:
        yield ProviderEvent(
            type="session.start",
            data={"provider": self.name, "model": req.model or "default", "workspace": req.cwd},
        )
        yield ProviderEvent(
            type="error",
            data={
                "code": "exec.cli.not_implemented",
                "message": (
                    "Codex provider is not wired yet. Install the codex CLI "
                    "(npm i -g @openai/codex) and implement run_turn_stream — "
                    "see app/providers/codex.py TODO."
                ),
            },
        )
