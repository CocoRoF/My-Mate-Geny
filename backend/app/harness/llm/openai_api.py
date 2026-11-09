"""GPT through the OpenAI Responses API (``openai`` SDK, streamed).

- Nothing is stored on OpenAI's side (``store: false``): the whole conversation goes with every call, and a reasoning
  model's reasoning comes back encrypted (``reasoning.encrypted_content``) to be sent back with it, so the model keeps
  its train of thought across tool calls. That data only goes back to the model that made it.
- ``prompt_cache_key`` keeps one chat on one cache; cached input is billed at the cached rate.
- Reasoning summaries stream as thinking; the reasoning level is ``reasoning.effort``.
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
    same_model,
)
from app.harness.vendors import reasoning_model

PROVIDER = "openai"
_clients: dict[str, Any] = {}


def _client(key: str):
    import openai

    c = _clients.get(key)
    if c is None:
        c = openai.AsyncOpenAI(api_key=key, base_url=base_url(PROVIDER), max_retries=0,
                               timeout=openai.Timeout(900.0, connect=15.0))
        if len(_clients) > 32:
            _clients.clear()
        _clients[key] = c
    return c


def _error(exc: Exception) -> LLMError:
    import openai

    if isinstance(exc, openai.APIStatusError):
        body = exc.body if isinstance(exc.body, dict) else {}
        err = body.get("error") if isinstance(body.get("error"), dict) else body
        msg = (err or {}).get("message") or exc.message or str(exc)
        code = str((err or {}).get("code") or (err or {}).get("type") or "")
        return LLMError(classify(exc.status_code, msg, code), msg, status=exc.status_code,
                        retry_after=retry_after(exc.response.headers if exc.response is not None else None))
    if isinstance(exc, (openai.APIConnectionError, openai.APITimeoutError)):
        return LLMError("network", str(exc) or "connection failed")
    return LLMError("bad_response", str(exc) or type(exc).__name__)


# ---- request ----

def _image_part(b: dict[str, Any]) -> dict[str, Any] | None:
    img = image_b64(b)
    if img is None:
        return None
    return {"type": "input_image", "image_url": f"data:{img[0]};base64,{img[1]}", "detail": "auto"}


def _result_output(b: dict[str, Any]) -> str | list[dict[str, Any]]:
    images = [p for p in (_image_part(c) for c in b.get("content") or [] if c.get("type") == "image") if p]
    text = result_text(b)
    if b.get("is_error"):
        text = f"Error: {text}"
    if not images:
        return text
    return [{"type": "input_text", "text": text}, *images]


def _replay(item: dict[str, Any]) -> dict[str, Any] | None:
    """One of the model's own output items, as input for the next call (nothing is stored server-side, so only what
    stands on its own goes back: reasoning with its encrypted content, the text, the calls)."""
    t = item.get("type")
    if t == "reasoning":
        if not item.get("encrypted_content"):
            return None
        return {"type": "reasoning", "id": item["id"], "summary": item.get("summary") or [],
                "encrypted_content": item["encrypted_content"]}
    if t == "message":
        text = "".join(c.get("text", "") for c in item.get("content") or [] if c.get("type") == "output_text")
        return {"role": "assistant", "content": text} if text else None
    if t == "function_call":
        return {"type": "function_call", "call_id": item["call_id"], "name": item["name"],
                "arguments": item.get("arguments") or "{}"}
    return None


def input_for(call: LLMCall) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for m in call.messages:
        if m["role"] == "user":
            parts: list[dict[str, Any]] = []
            for b in m["content"]:
                t = b.get("type")
                if t == "tool_result":
                    items.append({"type": "function_call_output", "call_id": b["tool_use_id"], "output": _result_output(b)})
                elif t == "text" and b.get("text"):
                    parts.append({"type": "input_text", "text": b["text"]})
                elif t == "image":
                    part = _image_part(b)
                    parts.append(part or {"type": "input_text", "text": "[image no longer available]"})
            if parts:
                items.append({"role": "user", "content": parts})
            continue
        vendor = (m.get("vendor") or {}).get("items")
        if vendor and same_model(m, PROVIDER, call.model):
            items.extend(x for x in (_replay(i) for i in vendor) if x)
            continue
        text = "".join(b.get("text", "") for b in m["content"] if b.get("type") == "text")
        if text:
            items.append({"role": "assistant", "content": text})
        for b in m["content"]:
            if b.get("type") == "tool_use":
                items.append({"type": "function_call", "call_id": b["id"], "name": b["name"],
                              "arguments": json.dumps(b.get("input") or {}, ensure_ascii=False)})
    return items


def request(call: LLMCall, *, with_effort: bool = True) -> dict[str, Any]:
    params: dict[str, Any] = {
        "model": call.model,
        "input": input_for(call),
        "store": False,
        "stream": True,
    }
    if call.system:
        params["instructions"] = call.system
    if call.web_search:
        params["tools"] = [{"type": "web_search"}]
    elif call.tools:
        params["tools"] = [{"type": "function", "name": t.name, "description": t.description,
                            "parameters": t.schema, "strict": False} for t in call.tools]
        params["parallel_tool_calls"] = True
    if call.cache_key:
        params["prompt_cache_key"] = call.cache_key[:64]
    if call.max_tokens:
        params["max_output_tokens"] = call.max_tokens
    if reasoning_model(PROVIDER, call.model):
        reasoning: dict[str, Any] = {"summary": "auto"} if call.show_thinking else {}
        if with_effort and call.effort and call.effort != "default":
            reasoning["effort"] = call.effort
        if reasoning:
            params["reasoning"] = reasoning
        params["include"] = ["reasoning.encrypted_content"]
    return params


# ---- answer ----

def _dump(item: Any) -> dict[str, Any]:
    return item.model_dump(exclude_none=True) if hasattr(item, "model_dump") else dict(item)


def _neutral(output: list[dict[str, Any]], call: LLMCall) -> dict[str, Any]:
    blocks: list[dict[str, Any]] = []
    for item in output:
        t = item.get("type")
        if t == "reasoning":
            text = "\n\n".join(s.get("text", "") for s in item.get("summary") or [] if s.get("text"))
            if text:
                blocks.append({"type": "thinking", "text": text})
        elif t == "message":
            for c in item.get("content") or []:
                if c.get("type") == "output_text" and c.get("text"):
                    blocks.append({"type": "text", "text": c["text"]})
                elif c.get("type") == "refusal" and c.get("refusal"):
                    blocks.append({"type": "text", "text": c["refusal"]})
        elif t == "function_call":
            try:
                args = json.loads(item.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {"__invalid__": item.get("arguments") or ""}
            blocks.append({"type": "tool_use", "id": item["call_id"], "name": item["name"],
                           "input": args if isinstance(args, dict) else {"__invalid__": item.get("arguments")}})
    return {"role": "assistant", "provider": PROVIDER, "model": call.model, "content": blocks,
            "vendor": {"items": output}}


def _usage(u: Any) -> dict[str, int]:
    if u is None:
        return {"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0}
    d = _dump(u)
    total = int(d.get("input_tokens") or 0)
    det = d.get("input_tokens_details") or {}
    cached = int(det.get("cached_tokens") or 0)
    written = int(det.get("cache_write_tokens") or 0)
    out = int(d.get("output_tokens") or 0)
    reasoning = int((d.get("output_tokens_details") or {}).get("reasoning_tokens") or 0)
    return {"input_tokens": max(0, total - cached - written), "cache_read_input_tokens": cached,
            "cache_creation_input_tokens": written, "output_tokens": out, "reasoning_output_tokens": reasoning}


def _citations(output: list[dict[str, Any]]) -> list[dict[str, str]]:
    out, seen = [], set()
    for item in output:
        for c in item.get("content") or [] if item.get("type") == "message" else []:
            for a in c.get("annotations") or []:
                url = a.get("url")
                if a.get("type") == "url_citation" and url and url not in seen:
                    seen.add(url)
                    out.append({"url": url, "title": a.get("title") or url})
    return out


class OpenAIAdapter:
    provider = PROVIDER

    def __init__(self) -> None:
        self._no_effort: set[str] = set()

    async def stream(self, call: LLMCall, key: str) -> AsyncIterator[LLMEvent]:
        try:
            async for ev in self._stream(call, key, request(call, with_effort=call.model not in self._no_effort)):
                yield ev
        except LLMError as exc:
            if exc.kind == "bad_request" and "reasoning" in str(exc).lower() and call.model not in self._no_effort:
                self._no_effort.add(call.model)  # (a level this model doesn't take: its own default)
                async for ev in self._stream(call, key, request(call, with_effort=False)):
                    yield ev
            else:
                raise

    async def _stream(self, call: LLMCall, key: str, params: dict[str, Any]) -> AsyncIterator[LLMEvent]:
        client = _client(key)
        open_reasoning: set[str] = set()
        summary_parts: dict[str, int] = {}
        calls: dict[str, tuple[str, str]] = {}
        final: Any = None
        status = "completed"
        try:
            stream = await client.responses.create(**params)
            async for ev in stream:
                t = ev.type
                if t == "response.output_item.added":
                    item = ev.item
                    if item.type == "reasoning":
                        open_reasoning.add(item.id)
                        yield ThinkingStart(f"openai:{item.id}")
                    elif item.type == "function_call":
                        calls[item.id or item.call_id] = (item.call_id, item.name)
                elif t == "response.reasoning_summary_part.added":
                    n = summary_parts.get(ev.item_id, 0)
                    summary_parts[ev.item_id] = n + 1
                    if n:
                        yield ThinkingDelta(f"openai:{ev.item_id}", "\n\n")
                elif t in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
                    if ev.delta:
                        yield ThinkingDelta(f"openai:{ev.item_id}", ev.delta)
                elif t in ("response.output_text.delta", "response.refusal.delta"):
                    if ev.delta:
                        yield TextDelta(ev.delta)
                elif t == "response.function_call_arguments.delta":
                    cid, name = calls.get(ev.item_id, (ev.item_id, ""))
                    yield ToolInputDelta(cid, name, ev.delta)
                elif t == "response.output_item.done":
                    if ev.item.type == "reasoning" and ev.item.id in open_reasoning:
                        open_reasoning.discard(ev.item.id)
                        yield ThinkingEnd(f"openai:{ev.item.id}")
                elif t in ("response.completed", "response.incomplete"):
                    final = ev.response
                    status = "completed" if t == "response.completed" else "incomplete"
                elif t == "response.failed":
                    err = getattr(ev.response, "error", None)
                    msg = getattr(err, "message", None) or "the response failed"
                    code = str(getattr(err, "code", "") or "")
                    raise LLMError(classify(500 if "server" in code else 400, msg, code), msg)
                elif t == "error":
                    msg = getattr(ev, "message", None) or "stream error"
                    code = str(getattr(ev, "code", "") or "")
                    raise LLMError(classify(None if not code else 500, msg, code), msg)
        except LLMError:
            raise
        except Exception as exc:
            raise _error(exc) from exc
        for rid in open_reasoning:
            yield ThinkingEnd(f"openai:{rid}")
        if final is None:
            raise LLMError("bad_response", "the stream ended without a response")
        output = [_dump(i) for i in (final.output or [])]
        message = _neutral(output, call)
        if any(b["type"] == "tool_use" for b in message["content"]):
            stop = "tool_use"
        elif status == "incomplete":
            reason = getattr(getattr(final, "incomplete_details", None), "reason", "") or ""
            stop = "max_tokens" if "max_output_tokens" in reason else "refusal" if "content_filter" in reason else "max_tokens"
        else:
            stop = "end_turn"
        yield Done(message, _usage(getattr(final, "usage", None)), stop, citations=_citations(output))

    async def list_models(self, key: str) -> list[dict[str, Any]]:
        client = _client(key)
        out = []
        try:
            async for m in client.models.list():
                created = getattr(m, "created", None)
                out.append({"id": m.id, "label": m.id, "created": created, "owned_by": getattr(m, "owned_by", None)})
        except Exception as exc:
            raise _error(exc) from exc
        return out
