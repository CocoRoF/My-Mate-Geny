"""Testing an API key: does the vendor accept it, and can it actually generate (a key with no credit lists models
fine and fails the first real call)."""

from __future__ import annotations

import time
from typing import Any

from app.harness.llm import adapter
from app.harness.llm.base import Done, LLMCall, LLMError
from app.harness.vendors import chat_model


async def check_key(provider: str, key: str, *, model: str | None = None) -> dict[str, Any]:
    """→ {ok, models, latency_ms, generation?, kind?, error?}"""
    llm = adapter(provider)
    started = time.monotonic()
    try:
        listed = await llm.list_models(key)
    except LLMError as exc:
        return {"ok": False, "kind": exc.kind, "error": str(exc)[:500], "outcome": exc.account_outcome}
    out: dict[str, Any] = {
        "ok": True,
        "models": sum(1 for m in listed if chat_model(provider, m["id"], actions=m.get("actions"),
                                                    lifecycle=m.get("lifecycle"))),
        "latency_ms": int((time.monotonic() - started) * 1000),
    }
    if model:
        started = time.monotonic()
        call = LLMCall(model=model, system="", messages=[{"role": "user", "content": [
            {"type": "text", "text": "Reply with the single word OK."}]}], max_tokens=256, effort="default",
            show_thinking=False)
        try:
            text = ""
            async for ev in llm.stream(call, key):
                if isinstance(ev, Done):
                    text = "".join(b.get("text", "") for b in ev.message["content"] if b.get("type") == "text")
            out["generation"] = {"ok": True, "model": model, "text": text.strip()[:80],
                                 "latency_ms": int((time.monotonic() - started) * 1000)}
        except LLMError as exc:
            out.update(ok=False, kind=exc.kind, error=str(exc)[:500], outcome=exc.account_outcome)
            out["generation"] = {"ok": False, "model": model, "error": str(exc)[:500]}
    return out
