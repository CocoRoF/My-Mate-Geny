"""Claude through the Anthropic Messages API (``anthropic`` SDK, streamed).

- Thinking: adaptive with readable summaries where the model takes it, a token budget on models that only take that;
  the reasoning level goes in ``output_config.effort``. Thinking blocks go back unchanged (with their signatures), but
  only to the model that wrote them.
- Caching: the system prompt and the conversation so far are cached (``cache_control``), so each step of a long
  agent loop pays full price only for what is new.
- Tools stream their input as it is generated (``eager_input_streaming``); an input cut off by the output limit is not
  run (the engine answers it with an error instead).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from app.harness.llm.base import (
    Done,
    LLMCall,
    LLMError,
    LLMEvent,
    TextDelta,
    ThinkingDelta,
    ThinkingEnd,
    ThinkingStart,
    ToolInputDelta,
    base_url,
    classify,
    image_b64,
    result_text,
    retry_after,
)

PROVIDER = "anthropic"
_BUDGET = {"low": 2048, "medium": 8000, "high": 16000, "xhigh": 32000, "max": 48000}
_clients: dict[str, Any] = {}


def _client(key: str):
    import anthropic

    c = _clients.get(key)
    if c is None:
        c = anthropic.AsyncAnthropic(api_key=key, base_url=base_url(PROVIDER), max_retries=0,
                                     timeout=anthropic.Timeout(900.0, connect=15.0))
        if len(_clients) > 32:
            _clients.clear()
        _clients[key] = c
    return c


def _error(exc: Exception) -> LLMError:
    import anthropic

    if isinstance(exc, anthropic.APIStatusError):
        body = exc.body if isinstance(exc.body, dict) else {}
        err = body.get("error") if isinstance(body.get("error"), dict) else {}
        msg = err.get("message") or exc.message or str(exc)
        return LLMError(classify(exc.status_code, msg, err.get("type", "")), msg, status=exc.status_code,
                        retry_after=retry_after(exc.response.headers if exc.response is not None else None))
    if isinstance(exc, (anthropic.APIConnectionError, anthropic.APITimeoutError)):
        return LLMError("network", str(exc) or "connection failed")
    return LLMError("bad_response", str(exc) or type(exc).__name__)


# ---- request ----

def _user_block(b: dict[str, Any]) -> dict[str, Any] | None:
    t = b.get("type")
    if t == "text":
        return {"type": "text", "text": b["text"]} if b.get("text") else None
    if t == "image":
        img = image_b64(b)
        if img is None:
            return {"type": "text", "text": "[image no longer available]"}
        return {"type": "image", "source": {"type": "base64", "media_type": img[0], "data": img[1]}}
    if t == "tool_result":
        content: list[dict[str, Any]] = []
        for c in b.get("content") or []:
            if c.get("type") == "text" and c.get("text"):
                content.append({"type": "text", "text": c["text"]})
            elif c.get("type") == "image":
                img = image_b64(c)
                if img is not None:
                    content.append({"type": "image", "source": {"type": "base64", "media_type": img[0], "data": img[1]}})
        if not content:
            content = [{"type": "text", "text": result_text(b)}]
        return {"type": "tool_result", "tool_use_id": b["tool_use_id"], "content": content,
                "is_error": bool(b.get("is_error"))}
    return None


def messages_for(call: LLMCall) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in call.messages:
        if m["role"] == "user":
            blocks = [x for x in (_user_block(b) for b in m["content"]) if x]
            # (tool results first: they answer the calls of the message before)
            blocks.sort(key=lambda x: 0 if x["type"] == "tool_result" else 1)
            if blocks:
                out.append({"role": "user", "content": blocks})
            continue
        # Thinking blocks go back unchanged on every call, also after a model switch: the API drops (unbilled) the ones
        # the current model can't read, while leaving one out is an edit of the history that the newest models refuse.
        mine = m.get("provider") == PROVIDER
        blocks = []
        for b in m["content"]:
            t = b.get("type")
            if t == "thinking":
                if not mine:
                    continue
                if b.get("redacted"):
                    blocks.append({"type": "redacted_thinking", "data": b["redacted"]})
                elif b.get("signature"):
                    blocks.append({"type": "thinking", "thinking": b.get("text", ""), "signature": b["signature"]})
            elif t == "text" and b.get("text"):
                blocks.append({"type": "text", "text": b["text"]})
            elif t == "tool_use":
                blocks.append({"type": "tool_use", "id": b["id"], "name": b["name"], "input": b.get("input") or {}})
        if blocks:
            out.append({"role": "assistant", "content": blocks})
    return out


def _thinking(call: LLMCall) -> dict[str, Any] | None:
    caps = call.caps or {}
    th = caps.get("thinking")
    types = (th or {}).get("types") or {}
    if th is not None and not th.get("supported"):
        return None
    adaptive = (types.get("adaptive") or {}).get("supported")
    if adaptive or (th is None and not call.model.startswith(("claude-3", "claude-haiku-4"))):
        return {"type": "adaptive", "display": "summarized" if call.show_thinking else "omitted"}
    if (types.get("enabled") or {}).get("supported") and call.effort in _BUDGET:
        budget = _BUDGET[call.effort]
        return {"type": "enabled", "budget_tokens": min(budget, max(1024, (call.max_tokens or 32000) - 1024))}
    return None


def _effort(call: LLMCall) -> str | None:
    if not call.effort or call.effort == "default":
        return None
    effort = (call.caps or {}).get("effort")
    if isinstance(effort, dict):
        return call.effort if (effort.get(call.effort) or {}).get("supported") else None
    return call.effort  # (no capability data: let the API decide)


def request(call: LLMCall, *, eager: bool = True) -> dict[str, Any]:
    params: dict[str, Any] = {
        "model": call.model,
        "max_tokens": call.max_tokens or 32000,
        "messages": messages_for(call),
        "cache_control": {"type": "ephemeral"},
    }
    if call.system:
        params["system"] = [{"type": "text", "text": call.system, "cache_control": {"type": "ephemeral"}}]
    if call.web_search:
        params["tools"] = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 5}]
    elif call.tools:
        params["tools"] = [
            {"name": t.name, "description": t.description, "input_schema": t.schema,
             **({"eager_input_streaming": True} if eager else {})}
            for t in call.tools
        ]
    thinking = _thinking(call)
    if thinking:
        params["thinking"] = thinking
    effort = _effort(call)
    if effort:
        params["output_config"] = {"effort": effort}
    return params


# ---- answer ----

def _neutral(message: Any, call: LLMCall) -> dict[str, Any]:
    blocks: list[dict[str, Any]] = []
    for b in message.content:
        t = getattr(b, "type", "")
        if t == "thinking":
            blocks.append({"type": "thinking", "text": b.thinking or "", "signature": b.signature})
        elif t == "redacted_thinking":
            blocks.append({"type": "thinking", "text": "", "redacted": b.data})
        elif t == "text":
            blocks.append({"type": "text", "text": b.text})
        elif t == "tool_use":
            blocks.append({"type": "tool_use", "id": b.id, "name": b.name,
                           "input": b.input if isinstance(b.input, dict) else {"__invalid__": str(b.input)}})
    return {"role": "assistant", "provider": PROVIDER, "model": call.model, "content": blocks}


def _usage(u: Any) -> dict[str, int]:
    return {
        "input_tokens": int(getattr(u, "input_tokens", 0) or 0),
        "cache_read_input_tokens": int(getattr(u, "cache_read_input_tokens", 0) or 0),
        "cache_creation_input_tokens": int(getattr(u, "cache_creation_input_tokens", 0) or 0),
        "output_tokens": int(getattr(u, "output_tokens", 0) or 0),
    }


def _citations(message: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    seen = set()
    for b in message.content:
        if getattr(b, "type", "") == "web_search_tool_result" and isinstance(getattr(b, "content", None), list):
            for r in b.content:
                url = getattr(r, "url", "")
                if url and url not in seen:
                    seen.add(url)
                    out.append({"url": url, "title": getattr(r, "title", "") or url})
    return out


async def _one(call: LLMCall, key: str, params: dict[str, Any], n: int) -> AsyncIterator[LLMEvent]:
    client = _client(key)
    open_thinking: str | None = None
    tool_names: dict[int, tuple[str, str]] = {}
    try:
        async with client.messages.stream(**params) as stream:
            async for ev in stream:
                t = ev.type
                if t == "content_block_start":
                    block = ev.content_block
                    if block.type in ("thinking", "redacted_thinking"):
                        open_thinking = f"anthropic:{n}:{ev.index}"
                        yield ThinkingStart(open_thinking)
                    elif block.type == "tool_use":
                        tool_names[ev.index] = (block.id, block.name)
                elif t == "content_block_delta":
                    d = ev.delta
                    if d.type == "text_delta" and d.text:
                        yield TextDelta(d.text)
                    elif d.type == "thinking_delta" and d.thinking and open_thinking:
                        yield ThinkingDelta(open_thinking, d.thinking)
                    elif d.type == "input_json_delta" and ev.index in tool_names:
                        tid, name = tool_names[ev.index]
                        yield ToolInputDelta(tid, name, d.partial_json)
                elif t == "content_block_stop" and open_thinking:
                    yield ThinkingEnd(open_thinking)
                    open_thinking = None
            final = await stream.get_final_message()
    except LLMError:
        raise
    except Exception as exc:
        raise _error(exc) from exc
    stop = final.stop_reason or "end_turn"
    yield Done(_neutral(final, call), _usage(final.usage), stop, citations=_citations(final),
               raw=[b.model_dump(exclude_none=True) for b in final.content])


class AnthropicAdapter:
    provider = PROVIDER

    def __init__(self) -> None:
        self._calls = 0
        self._no_eager = False

    async def stream(self, call: LLMCall, key: str) -> AsyncIterator[LLMEvent]:
        self._calls += 1
        params = request(call, eager=not self._no_eager)
        try:
            async for ev in self._paused(call, key, params):
                yield ev
        except LLMError as exc:
            low = str(exc).lower()
            if exc.kind == "bad_request" and "eager_input_streaming" in low and not self._no_eager:
                self._no_eager = True  # (a gateway that doesn't know the field)
                async for ev in self._paused(call, key, request(call, eager=False)):
                    yield ev
            elif exc.kind in ("bad_request", "not_found") and call.web_search and "web_search_20260209" in low:
                params["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}]
                async for ev in self._paused(call, key, params):
                    yield ev
            else:
                raise

    async def _paused(self, call: LLMCall, key: str, params: dict[str, Any]) -> AsyncIterator[LLMEvent]:
        """A server tool (web search) can pause a long turn: send it back as it is and it goes on."""
        for _ in range(4):
            done: Done | None = None
            async for ev in _one(call, key, params, self._calls):
                if isinstance(ev, Done):
                    done = ev
                else:
                    yield ev
            if done is None:
                return
            if done.stop_reason != "pause_turn" or not done.raw:
                yield done
                return
            params = {**params, "messages": [*params["messages"], {"role": "assistant", "content": done.raw}]}
        raise LLMError("bad_response", "the model kept pausing")

    async def list_models(self, key: str) -> list[dict[str, Any]]:
        client = _client(key)
        out = []
        try:
            async for m in client.models.list(limit=1000):
                caps = m.capabilities.model_dump() if getattr(m, "capabilities", None) else None
                out.append({
                    "id": m.id,
                    "label": m.display_name or m.id,
                    "created": m.created_at.isoformat() if getattr(m, "created_at", None) else None,
                    "context_window": getattr(m, "max_input_tokens", None),
                    "max_output": getattr(m, "max_tokens", None),
                    "lifecycle": getattr(m, "lifecycle", None),
                    "caps": caps,
                    "vision": bool(((caps or {}).get("image_input") or {}).get("supported", True)),
                })
        except Exception as exc:
            raise _error(exc) from exc
        return out


def to_json(params: dict[str, Any]) -> str:  # (tests)
    return json.dumps(params, sort_keys=True)
