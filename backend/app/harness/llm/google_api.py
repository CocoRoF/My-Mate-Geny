"""Gemini through the Gemini API (``google-genai`` SDK, streamed).

- Function calling is driven by the harness (the SDK's automatic calling is off).
- Thought summaries stream as thinking (``include_thoughts``); the reasoning level is ``thinking_level`` on Gemini 3 and
  later, a thinking budget on 2.5.
- Every part that carries a ``thought_signature`` goes back with it, unchanged — Gemini needs those to continue its
  reasoning across tool calls — but only to the model that made it.
- Gemini caches repeated prompt prefixes by itself; those tokens come back as cached and are billed at the cached rate.
"""

from __future__ import annotations

import base64
import itertools
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
    image_bytes,
    result_text,
    same_model,
)

PROVIDER = "google"
_BUDGET = {"minimal": 512, "low": 1024, "medium": 8192, "high": 24576}
_clients: dict[str, Any] = {}
_ids = itertools.count(1)
_SKIP_SIGNATURE = b"skip_thought_signature_validator"


def _client(key: str):
    from google import genai
    from google.genai import types

    c = _clients.get(key)
    if c is None:
        opts = types.HttpOptions(timeout=900_000, base_url=base_url(PROVIDER))
        c = genai.Client(api_key=key, http_options=opts).aio
        if len(_clients) > 32:
            _clients.clear()
        _clients[key] = c
    return c


def _error(exc: Exception) -> LLMError:
    from google.genai import errors

    if isinstance(exc, errors.APIError):
        status = getattr(exc, "code", None)
        msg = getattr(exc, "message", None) or str(exc)
        st = str(getattr(exc, "status", "") or "")
        kind = classify(status if isinstance(status, int) else None, msg, st)
        retry = None
        details = getattr(exc, "details", None)
        if isinstance(details, dict):
            for d in (details.get("error") or {}).get("details") or []:
                if isinstance(d, dict) and str(d.get("retryDelay", "")).endswith("s"):
                    try:
                        retry = float(d["retryDelay"][:-1])
                    except ValueError:
                        pass
        return LLMError(kind, msg, status=status if isinstance(status, int) else None, retry_after=retry)
    name = type(exc).__name__.lower()
    if any(x in name for x in ("connect", "timeout", "network", "readerror", "remoteprotocol")):
        return LLMError("network", str(exc) or name)
    return LLMError("bad_response", str(exc) or type(exc).__name__)


def _sig(b: dict[str, Any]) -> bytes | None:
    s = b.get("signature")
    return base64.b64decode(s) if s else None


# ---- request ----

def contents_for(call: LLMCall) -> list[Any]:
    from google.genai import types

    contents: list[types.Content] = []
    names: dict[str, str] = {}
    for m in call.messages:
        if m["role"] == "user":
            parts: list[types.Part] = []
            after: list[types.Part] = []
            for b in m["content"]:
                t = b.get("type")
                if t == "tool_result":
                    images = []
                    for c in b.get("content") or []:
                        if c.get("type") == "image":
                            got = image_bytes(c)
                            if got:
                                images.append(types.FunctionResponsePart(
                                    inline_data=types.FunctionResponseBlob(mime_type=got[0], data=got[1])))
                    text = result_text(b)
                    response = {"error": text} if b.get("is_error") else {"output": text}
                    fid = b["tool_use_id"]
                    parts.append(types.Part(function_response=types.FunctionResponse(
                        id=fid if not fid.startswith("hrh_") else None,
                        name=b.get("name") or names.get(fid) or "tool", response=response,
                        parts=images or None)))
                elif t == "text" and b.get("text"):
                    after.append(types.Part(text=b["text"]))
                elif t == "image":
                    got = image_bytes(b)
                    after.append(types.Part(inline_data=types.Blob(mime_type=got[0], data=got[1])) if got
                                 else types.Part(text="[image no longer available]"))
            parts.extend(after)
            if parts:
                contents.append(types.Content(role="user", parts=parts))
            continue
        mine = same_model(m, PROVIDER, call.model)
        parts = []
        for b in m["content"]:
            t = b.get("type")
            if t == "thinking":
                if mine and (b.get("text") or b.get("signature")):
                    parts.append(types.Part(text=b.get("text") or "", thought=True, thought_signature=_sig(b)))
            elif t == "text" and (b.get("text") or (mine and b.get("signature"))):
                parts.append(types.Part(text=b.get("text") or "", thought_signature=_sig(b) if mine else None))
            elif t == "tool_use":
                names[b["id"]] = b["name"]
                # (a call another model made has no signature this one can check: Gemini's documented way past that)
                sig = _sig(b) if mine and b.get("signature") else _SKIP_SIGNATURE
                parts.append(types.Part(
                    function_call=types.FunctionCall(id=b["id"] if not b["id"].startswith("hrh_") else None,
                                                     name=b["name"], args=b.get("input") or {}),
                    thought_signature=sig))
        if parts:
            contents.append(types.Content(role="model", parts=parts))
    merged: list[types.Content] = []  # (one turn per role in a row: a steer after tool results joins them)
    for c in contents:
        if merged and merged[-1].role == c.role:
            merged[-1] = types.Content(role=c.role, parts=[*(merged[-1].parts or []), *(c.parts or [])])
        else:
            merged.append(c)
    return merged


def _thinking(call: LLMCall) -> Any:
    from google.genai import types

    if (call.caps or {}).get("thinking") is False:
        return None
    effort = call.effort if call.effort and call.effort != "default" else None
    mid = call.model.lower()
    if mid.startswith("gemini-2.5") or mid.startswith("gemini-2.0"):
        return types.ThinkingConfig(include_thoughts=call.show_thinking,
                                    thinking_budget=_BUDGET.get(effort) if effort else None)
    level = {"minimal": "MINIMAL", "low": "LOW", "medium": "MEDIUM", "high": "HIGH"}.get(effort or "")
    return types.ThinkingConfig(include_thoughts=call.show_thinking, thinking_level=level)


def config_for(call: LLMCall, *, with_thinking_level: bool = True) -> Any:
    from google.genai import types

    cfg: dict[str, Any] = {
        "automatic_function_calling": types.AutomaticFunctionCallingConfig(disable=True),
    }
    if call.system:
        cfg["system_instruction"] = call.system
    if call.web_search:
        cfg["tools"] = [types.Tool(google_search=types.GoogleSearch())]
    elif call.tools:
        cfg["tools"] = [types.Tool(function_declarations=[
            types.FunctionDeclaration(name=t.name, description=t.description, parameters_json_schema=t.schema)
            for t in call.tools])]
    if call.max_tokens:
        cfg["max_output_tokens"] = call.max_tokens
    thinking = _thinking(call)
    if thinking is not None:
        if not with_thinking_level:
            thinking = types.ThinkingConfig(include_thoughts=call.show_thinking)
        cfg["thinking_config"] = thinking
    return types.GenerateContentConfig(**cfg)


# ---- answer ----

def _usage(u: Any) -> dict[str, int]:
    if u is None:
        return {"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0}
    prompt = int(getattr(u, "prompt_token_count", 0) or 0) + int(getattr(u, "tool_use_prompt_token_count", 0) or 0)
    cached = int(getattr(u, "cached_content_token_count", 0) or 0)
    thoughts = int(getattr(u, "thoughts_token_count", 0) or 0)
    out = int(getattr(u, "candidates_token_count", 0) or 0) + thoughts
    return {"input_tokens": max(0, prompt - cached), "cache_read_input_tokens": cached,
            "cache_creation_input_tokens": 0, "output_tokens": out, "reasoning_output_tokens": thoughts}


_REFUSED = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"}


class GoogleAdapter:
    provider = PROVIDER

    def __init__(self) -> None:
        self._calls = 0
        self._no_level: set[str] = set()

    async def stream(self, call: LLMCall, key: str) -> AsyncIterator[LLMEvent]:
        try:
            async for ev in self._stream(call, key, config_for(call, with_thinking_level=call.model not in self._no_level)):
                yield ev
        except LLMError as exc:
            if exc.kind == "bad_request" and "thinking" in str(exc).lower() and call.model not in self._no_level:
                self._no_level.add(call.model)
                async for ev in self._stream(call, key, config_for(call, with_thinking_level=False)):
                    yield ev
            else:
                raise

    async def _stream(self, call: LLMCall, key: str, config: Any) -> AsyncIterator[LLMEvent]:
        self._calls += 1
        n = self._calls
        client = _client(key)
        blocks: list[dict[str, Any]] = []
        thinking_id: str | None = None
        usage = None
        finish = ""
        citations: list[dict[str, str]] = []
        seen_urls: set[str] = set()

        def close_thinking():
            nonlocal thinking_id
            done, thinking_id = thinking_id, None
            return done

        try:
            stream = await client.models.generate_content_stream(model=call.model, contents=contents_for(call),
                                                                 config=config)
            async for chunk in stream:
                if getattr(chunk, "usage_metadata", None) is not None:
                    usage = chunk.usage_metadata
                for cand in (chunk.candidates or [])[:1]:
                    if cand.finish_reason:
                        finish = str(getattr(cand.finish_reason, "value", cand.finish_reason))
                    gm = getattr(cand, "grounding_metadata", None)
                    for g in (getattr(gm, "grounding_chunks", None) or []) if gm else []:
                        web = getattr(g, "web", None)
                        if web and web.uri and web.uri not in seen_urls:
                            seen_urls.add(web.uri)
                            citations.append({"url": web.uri, "title": web.title or web.domain or web.uri})
                    for part in (cand.content.parts if cand.content and cand.content.parts else []):
                        sig = base64.b64encode(part.thought_signature).decode() if part.thought_signature else None
                        if part.function_call is not None:
                            done = close_thinking()
                            if done:
                                yield ThinkingEnd(done)
                            fc = part.function_call
                            fid = fc.id or f"hrh_{next(_ids)}"
                            block = {"type": "tool_use", "id": fid, "name": fc.name, "input": dict(fc.args or {})}
                            if sig:
                                block["signature"] = sig
                            blocks.append(block)
                            yield ToolInputDelta(fid, fc.name, "")
                        elif part.thought:
                            if thinking_id is None:
                                thinking_id = f"google:{n}:{len(blocks)}"
                                blocks.append({"type": "thinking", "text": ""})
                                yield ThinkingStart(thinking_id)
                            last = blocks[-1]
                            last["text"] += part.text or ""
                            if sig:
                                last["signature"] = sig
                            if part.text:
                                yield ThinkingDelta(thinking_id, part.text)
                        elif part.text is not None or sig:
                            done = close_thinking()
                            if done:
                                yield ThinkingEnd(done)
                            if not blocks or blocks[-1]["type"] != "text" or blocks[-1].get("signature"):
                                blocks.append({"type": "text", "text": ""})
                            blocks[-1]["text"] += part.text or ""
                            if sig:
                                blocks[-1]["signature"] = sig
                            if part.text:
                                yield TextDelta(part.text)
        except LLMError:
            raise
        except Exception as exc:
            raise _error(exc) from exc
        done = close_thinking()
        if done:
            yield ThinkingEnd(done)
        if finish == "MALFORMED_FUNCTION_CALL" and not any(b["type"] == "tool_use" for b in blocks):
            raise LLMError("bad_response", "the model wrote a malformed tool call")
        blocks = [b for b in blocks if b["type"] != "text" or b["text"] or b.get("signature")]
        message = {"role": "assistant", "provider": PROVIDER, "model": call.model, "content": blocks}
        if any(b["type"] == "tool_use" for b in blocks):
            stop = "tool_use"
        elif finish == "MAX_TOKENS":
            stop = "max_tokens"
        elif finish in _REFUSED:
            stop = "refusal"
        else:
            stop = "end_turn"
        yield Done(message, _usage(usage), stop, citations=citations)

    async def list_models(self, key: str) -> list[dict[str, Any]]:
        client = _client(key)
        out = []
        try:
            pager = await client.models.list(config={"page_size": 1000})
            async for m in pager:
                name = (m.name or "").removeprefix("models/")
                out.append({
                    "id": name,
                    "label": m.display_name or name,
                    "description": m.description or "",
                    "context_window": m.input_token_limit,
                    "max_output": m.output_token_limit,
                    "actions": list(m.supported_actions or []),
                    "caps": {"thinking": bool(m.thinking) if m.thinking is not None else True},
                    "vision": True,
                })
        except Exception as exc:
            raise _error(exc) from exc
        return out
