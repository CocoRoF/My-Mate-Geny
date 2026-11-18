"""A bounded, tool-less model call in a mate's own engine (her diary, what friends remember of an outing): sealed, no tools, no
MCP, ephemeral, with a timeout. -> the text it returned."""

from __future__ import annotations

import asyncio
from typing import Any

from app.harness.vendors import is_api_provider
from app.mate import files
from app.providers import get_provider
from app.providers.base import TurnRequest


async def ask(mates: Any, mate: dict[str, Any], system: str, content: str, folder: str, *, timeout_s: int = 90) -> str:
    """``folder``: her scratch folder for it (under her home: .diary, .social …)."""
    svc = mates._svc
    name = mate["llm"]["provider"]
    provider = get_provider(name)
    key = svc._providers.resolved_api_key(name)
    lease, env = None, {}
    try:
        if svc._pool is not None:
            lease = await asyncio.to_thread(svc._pool.select, name, begin_turn=True)
            if lease is not None:
                if not lease.is_primary and not is_api_provider(name):
                    env["CLAUDE_CONFIG_DIR" if name == "claude" else "CODEX_HOME"] = lease.config_dir
                if lease.auth_mode == "api_key":
                    key = lease.api_key
        root = files.home_dir(mate["id"]) / folder
        root.mkdir(parents=True, exist_ok=True)
        req = TurnRequest(messages=[{"role": "user", "content": content}], model=mate["llm"]["model"], effort="low", cwd=str(root),
                          api_key=key, extra_env=env, timeout_s=timeout_s, system_prompt=system, sealed=True, ephemeral=True,
                          require_sealed_catalog=True, tools=[], allowed_tools=[], mcp_config={"mcpServers": {}},
                          engine_home=str(root / "codex"))
        if name == "codex":
            req.system_prompt_file = files.engine_file(mate["id"], folder.strip(".") or "oneshot", "md", system)
        text = ""
        async with asyncio.timeout(timeout_s + 10):
            async for ev in provider.run_turn_stream(req):
                if ev.type == "tool.start":
                    raise ValueError("a tool-less call tried to use a tool")
                if ev.type == "text.delta":
                    text += str(ev.data.get("text") or "")
                if ev.type == "error":
                    raise ValueError("the call failed")
                if ev.type == "turn.complete":
                    text = str(ev.data.get("text") or text)
        return text
    finally:
        if lease is not None:
            svc._pool.end_turn(lease)
            svc._pool.release(lease)
