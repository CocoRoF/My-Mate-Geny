"""Who reads the user's messages (app/mate/gss/appraisal.py): the same coding agents the app runs on, never an API key on the
side and never the words' patterns. Claude Code on the lightest model is kept warm — one stream-json process for every reading,
like a phone call's engine (app/mate/calls.py), so a reading takes a second or two instead of a process start — and started
again now and then so what it read before never piles up. Without Claude Code, Codex reads each message on its own.

The reading is a turn of a pooled account like any other (begin_turn / end_turn around it), on an account bound to the warm
process while it lives."""

from __future__ import annotations

import asyncio
from typing import Any

MODEL_CLAUDE = "claude-haiku-5-5"
MODEL_CODEX = "gpt-6-luna"  # (unless the live Codex list has a newer luna)


def codex_light() -> str:
    """The lightest Codex model: the newest "luna" in the live list the app keeps, else MODEL_CODEX."""
    from app.providers import catalog

    ids = [m.get("id") or "" for m in (catalog._cached("codex") or [])]
    lunas = sorted((i for i in ids if "luna" in i), reverse=True)
    return lunas[0] if lunas else MODEL_CODEX


def engine_of(provider: str | None) -> str:
    """Which agent reads for a mate on ``provider`` (her AI provider setting): Codex for Codex (and OpenAI), else Claude Code."""
    return "codex" if provider in ("codex", "openai") else "claude"
FRESH_AFTER = 30          # readings before the warm process is started again (what it read before stays out of the next)
TIMEOUT_S = 40.0


class Reader:
    def __init__(self, svc: Any, system: str, workdir: Any) -> None:
        self.svc, self.system, self.workdir = svc, system, workdir
        self._engine: Any = None
        self._lease: Any = None
        self._uses = 0
        self._lock = asyncio.Lock()
        self.failed: str = ""   # (why the warm way failed last, for the log and the Inspector)

    # ---- Claude Code, kept warm ----

    async def _start(self) -> None:
        from app.providers.base import TurnRequest
        from app.providers.claude_code import CLI_ENV
        from app.providers.claude_engine import ClaudeEngine
        from app.services.session_service import get_provider

        await self.close()
        provider = get_provider("claude")
        env: dict[str, str] = {}
        key = None
        pool = self.svc._pool
        if pool is not None:
            lease = await asyncio.to_thread(pool.select, "claude")
            if lease is not None:
                self._lease = lease
                if not lease.is_primary:
                    from app.providers.accounts import link_shared_state

                    await asyncio.to_thread(link_shared_state, "claude", lease.account_id)
                    env["CLAUDE_CONFIG_DIR"] = lease.config_dir
                if lease.auth_mode == "api_key" and lease.api_key:
                    key = lease.api_key
        self.workdir.mkdir(parents=True, exist_ok=True)
        prompt_file = self.workdir / "reader.md"
        prompt_file.write_text(self.system, "utf-8")
        req = TurnRequest(messages=[], model=MODEL_CLAUDE, effort="low", cwd=str(self.workdir), system_prompt_file=str(prompt_file),
                          sealed=True, ephemeral=True, tools=[], allowed_tools=[], mcp_config={"mcpServers": {}}, api_key=key,
                          mode="agent")
        extras = {**CLI_ENV, **env, **({"ANTHROPIC_API_KEY": key} if key else {})}
        self._engine = ClaudeEngine(binary=provider._binary, argv=provider.engine_argv(req), cwd=str(self.workdir), env_extras=extras,
                                    fingerprint="gss-reader", model=MODEL_CLAUDE, mode="agent")
        self._provider = provider
        await self._engine.start()
        self._uses = 0

    async def _ask_warm(self, user: str) -> str:
        if self._engine is None or not self._engine.alive or self._uses >= FRESH_AFTER:
            await self._start()
        e = self._engine
        pool, lease = self.svc._pool, self._lease
        if pool is not None and lease is not None:
            pool.begin_turn(lease)
        try:
            await e.send_user(self._provider._envelope(user, []))
            self._uses += 1
            text = ""
            while True:
                ev = await asyncio.wait_for(e.events.get(), timeout=TIMEOUT_S)
                if ev.type == "text.delta":
                    text += str(ev.data.get("text") or "")
                elif ev.type in ("tool.start", "tool.use"):
                    await self.close()  # (it has none: whatever it was doing, it starts again)
                    return ""
                elif ev.type == "turn.complete":
                    return str(ev.data.get("text") or text)
                elif ev.type in ("error", "engine.exit"):
                    await self.close()
                    raise RuntimeError(str(ev.data.get("message") or ev.type))
        except asyncio.TimeoutError:
            await self.close()
            raise
        finally:
            if pool is not None and lease is not None:
                pool.end_turn(lease)

    # ---- Codex, one message at a time ----

    async def _ask_codex(self, user: str, system: str | None = None) -> str:
        from app.providers.base import TurnRequest
        from app.services.session_service import get_provider

        svc = self.svc
        lease, env = None, {}
        try:
            if svc._pool is not None:
                lease = await asyncio.to_thread(svc._pool.select, "codex", begin_turn=True)
                if lease is not None and not lease.is_primary:
                    env["CODEX_HOME"] = lease.config_dir
            root = self.workdir / "codex"
            root.mkdir(parents=True, exist_ok=True)
            req = TurnRequest(messages=[{"role": "user", "content": user}], model=codex_light(), effort="low", cwd=str(root),
                              extra_env=env, timeout_s=90, system_prompt=system or self.system, sealed=True, ephemeral=True,
                              require_sealed_catalog=True, tools=[], allowed_tools=[], mcp_config={"mcpServers": {}},
                              engine_home=str(root / "home"))
            (root / "reader.md").write_text(system or self.system, "utf-8")
            req.system_prompt_file = str(root / "reader.md")
            text = ""
            async with asyncio.timeout(100):
                async for ev in get_provider("codex").run_turn_stream(req):
                    if ev.type == "tool.start":
                        return ""
                    if ev.type == "text.delta":
                        text += str(ev.data.get("text") or "")
                    if ev.type == "error":
                        return ""
                    if ev.type == "turn.complete":
                        text = str(ev.data.get("text") or text)
            return text
        finally:
            if lease is not None:
                svc._pool.end_turn(lease)
                svc._pool.release(lease)

    async def ask(self, user: str, provider: str | None = "claude") -> str | None:
        """One reading's answer (raw), by the agent her AI provider setting says: Claude Code (Haiku, kept warm) or Codex (luna).
        None when it couldn't read it (why: ``failed``)."""
        async with self._lock:  # (one at a time: the warm process answers in order, and this machine is tight on memory)
            try:
                if engine_of(provider) == "codex":
                    return await self._ask_codex(user)
                return await self._ask_warm(user)
            except Exception as exc:  # noqa: BLE001 - no reading: the message counts for nothing but that they talked
                self.failed = f"{engine_of(provider)}: {type(exc).__name__}: {str(exc)[:200]}"
                return None

    async def close(self) -> None:
        e, self._engine = self._engine, None
        if e is not None:
            try:
                await e.close(grace=0.5)
            except Exception:  # noqa: BLE001
                pass
        lease, self._lease = self._lease, None
        if lease is not None and self.svc._pool is not None:
            self.svc._pool.release(lease)
