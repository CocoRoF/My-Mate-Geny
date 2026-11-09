"""A stand-in for the Anthropic, OpenAI and Gemini APIs, speaking each one's real streaming format, for the harness
tests (and the browser tests: ``python -m tests.fake_vendors <port>``).

Each vendor takes scripted answers from its own queue (``FakeVendors.script``): a list of blocks — thinking, text, tool
calls — with a stop reason and usage, or an HTTP error. Every request body is kept (``requests``) so a test can check
what was sent: the conversation, the tools, the signatures that had to come back.
"""

from __future__ import annotations

import asyncio
import base64
import json
import socket
import threading
import time
from collections import defaultdict, deque
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

MODELS = {
    "anthropic": [
        {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "max_input_tokens": 1_000_000, "max_tokens": 128_000},
        {"id": "claude-sonnet-5-5", "display_name": "Claude Sonnet 5.5", "max_input_tokens": 1_000_000, "max_tokens": 128_000},
        {"id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5", "max_input_tokens": 1_000_000, "max_tokens": 128_000},
        {"id": "claude-opus-4-8", "display_name": "Claude Opus 4.8", "max_input_tokens": 1_000_000, "max_tokens": 128_000},
    ],
    "openai": ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.4-mini", "text-embedding-3-large", "gpt-6-realtime",
               "dall-e-3", "whisper-1", "gpt-6.1-sol-2026-09-01"],
    "google": [
        {"name": "models/gemini-4-argon", "displayName": "Gemini 4 Argon", "inputTokenLimit": 2_000_000,
         "outputTokenLimit": 65_536, "supportedGenerationMethods": ["generateContent", "countTokens"], "thinking": True},
        {"name": "models/gemini-3.8-flash", "displayName": "Gemini 3.8 Flash", "inputTokenLimit": 1_048_576,
         "outputTokenLimit": 65_536, "supportedGenerationMethods": ["generateContent"], "thinking": True},
        {"name": "models/gemini-embedding-2", "displayName": "Embedding", "inputTokenLimit": 8192,
         "outputTokenLimit": 1, "supportedGenerationMethods": ["embedContent"]},
        {"name": "models/gemini-3.5-flash-lite", "displayName": "Gemini 3.5 Flash-Lite", "inputTokenLimit": 1_048_576,
         "outputTokenLimit": 65_536, "supportedGenerationMethods": ["generateContent"], "thinking": True},
    ],
}

DEFAULT_USAGE = {"input": 1000, "cached": 0, "output": 50}


class FakeVendors:
    def __init__(self) -> None:
        self.queues: dict[str, deque] = defaultdict(deque)
        self.requests: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.keys: dict[str, list[str]] = defaultdict(list)
        self.bad_keys: set[str] = set()
        self.hold: asyncio.Event | None = None   # a test can keep a stream open
        self.app = self._app()

    def script(self, vendor: str, *answers: dict[str, Any]) -> None:
        self.queues[vendor].extend(answers)

    def reset(self) -> None:
        self.queues.clear()
        self.requests.clear()
        self.keys.clear()
        self.bad_keys.clear()
        self.hold = None

    def _next(self, vendor: str) -> dict[str, Any]:
        q = self.queues[vendor]
        return q.popleft() if q else {"blocks": [{"type": "text", "text": "Done."}]}

    # ---- the app ----

    def _app(self) -> FastAPI:
        app = FastAPI()
        fake = self

        def denied(vendor: str, key: str) -> JSONResponse | None:
            fake.keys[vendor].append(key)
            if key in fake.bad_keys or not key:
                return JSONResponse({"error": {"type": "authentication_error", "message": "invalid x-api-key"}}, 401)
            return None

        def error(answer: dict[str, Any]) -> JSONResponse | None:
            err = answer.get("error")
            if not err:
                return None
            headers = {"retry-after": str(err["retry_after"])} if err.get("retry_after") is not None else {}
            return JSONResponse({"error": {"type": err.get("type", "error"), "message": err.get("message", "boom"),
                                           "code": err.get("code")}}, err.get("status", 500), headers=headers)

        @app.post("/__script/{vendor}")
        async def script(vendor: str, request: Request):  # (a browser test scripts the next answers)
            fake.script(vendor, *(await request.json()))
            return {"queued": len(fake.queues[vendor])}

        @app.post("/__bad_key")
        async def bad_key(request: Request):
            fake.bad_keys.add((await request.json())["key"])
            return {"ok": True}

        @app.get("/__requests/{vendor}")
        async def requests(vendor: str):
            return fake.requests[vendor]

        def anthropic_key(request: Request) -> str:
            return request.headers.get("x-api-key") or request.headers.get("authorization", "").removeprefix("Bearer ")

        @app.get("/v1/models")
        async def models(request: Request):
            if "x-goog-api-key" in request.headers:
                return await gmodels(request)
            if "x-api-key" in request.headers or "anthropic-version" in request.headers:
                bad = denied("anthropic", anthropic_key(request))
                if bad:
                    return bad
                data = [{"type": "model", "id": m["id"], "display_name": m["display_name"],
                         "created_at": "2026-10-01T00:00:00Z", "max_input_tokens": m["max_input_tokens"],
                         "max_tokens": m["max_tokens"]} for m in MODELS["anthropic"]]
                return {"data": data, "has_more": False, "first_id": data[0]["id"], "last_id": data[-1]["id"]}
            bad = denied("openai", request.headers.get("authorization", "").removeprefix("Bearer "))
            if bad:
                return bad
            return {"object": "list", "data": [{"id": m, "object": "model", "created": 1790000000 + i,
                                                "owned_by": "openai"} for i, m in enumerate(MODELS["openai"])]}

        @app.post("/v1/messages")
        async def messages(request: Request):
            bad = denied("anthropic", anthropic_key(request))
            if bad:
                return bad
            body = await request.json()
            fake.requests["anthropic"].append(body)
            answer = fake._next("anthropic")
            return error(answer) or StreamingResponse(fake._anthropic(answer, body), media_type="text/event-stream")

        @app.post("/v1/responses")
        async def responses(request: Request):
            bad = denied("openai", request.headers.get("authorization", "").removeprefix("Bearer "))
            if bad:
                return bad
            body = await request.json()
            fake.requests["openai"].append(body)
            answer = fake._next("openai")
            return error(answer) or StreamingResponse(fake._openai(answer, body), media_type="text/event-stream")

        @app.get("/v1beta/models")
        async def gmodels(request: Request):  # (also /v1/models with a Google key)
            bad = denied("google", request.headers.get("x-goog-api-key", ""))
            if bad:
                return bad
            return {"models": MODELS["google"]}

        @app.post("/v1beta/models/{model}:streamGenerateContent")
        @app.post("/v1/models/{model}:streamGenerateContent")
        async def generate(model: str, request: Request):
            bad = denied("google", request.headers.get("x-goog-api-key", ""))
            if bad:
                return bad
            body = await request.json()
            body["_model"] = model
            fake.requests["google"].append(body)
            answer = fake._next("google")
            return error(answer) or StreamingResponse(fake._google(answer), media_type="text/event-stream")

        return app

    async def _wait(self) -> None:
        if self.hold is not None:
            await self.hold.wait()

    # ---- Anthropic ----

    async def _anthropic(self, answer: dict[str, Any], body: dict[str, Any]):
        def ev(name: str, data: dict[str, Any]) -> bytes:
            return f"event: {name}\ndata: {json.dumps(data)}\n\n".encode()

        u = {**DEFAULT_USAGE, **(answer.get("usage") or {})}
        mid = f"msg_{int(time.time() * 1000)}"
        yield ev("message_start", {"type": "message_start", "message": {
            "id": mid, "type": "message", "role": "assistant", "model": body["model"], "content": [],
            "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": u["input"], "output_tokens": 1, "cache_read_input_tokens": u["cached"],
                      "cache_creation_input_tokens": u.get("written", 0)}}})
        tools = False
        for i, b in enumerate(answer["blocks"]):
            if b["type"] == "thinking":
                yield ev("content_block_start", {"type": "content_block_start", "index": i,
                                                 "content_block": {"type": "thinking", "thinking": "", "signature": ""}})
                yield ev("content_block_delta", {"type": "content_block_delta", "index": i,
                                                 "delta": {"type": "thinking_delta", "thinking": b["text"]}})
                yield ev("content_block_delta", {"type": "content_block_delta", "index": i,
                                                 "delta": {"type": "signature_delta", "signature": b.get("signature", "sig-" + str(i))}})
            elif b["type"] == "text":
                yield ev("content_block_start", {"type": "content_block_start", "index": i,
                                                 "content_block": {"type": "text", "text": ""}})
                for piece in _pieces(b["text"]):
                    yield ev("content_block_delta", {"type": "content_block_delta", "index": i,
                                                     "delta": {"type": "text_delta", "text": piece}})
                    await asyncio.sleep(0)
                await self._wait()
            elif b["type"] == "tool_use":
                tools = True
                tid = b.get("id") or f"toolu_{i}_{int(time.time() * 1000) % 100000}"
                yield ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {
                    "type": "tool_use", "id": tid, "name": b["name"], "input": {}}})
                raw = json.dumps(b["input"])
                for piece in _pieces(raw, 7):
                    yield ev("content_block_delta", {"type": "content_block_delta", "index": i,
                                                     "delta": {"type": "input_json_delta", "partial_json": piece}})
            yield ev("content_block_stop", {"type": "content_block_stop", "index": i})
        stop = answer.get("stop") or ("tool_use" if tools else "end_turn")
        yield ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                                   "usage": {"output_tokens": u["output"], "input_tokens": u["input"],
                                             "cache_read_input_tokens": u["cached"],
                                             "cache_creation_input_tokens": u.get("written", 0)}})
        yield ev("message_stop", {"type": "message_stop"})

    # ---- OpenAI ----

    async def _openai(self, answer: dict[str, Any], body: dict[str, Any]):
        seq = 0

        def ev(data: dict[str, Any]) -> bytes:
            nonlocal seq
            seq += 1
            data["sequence_number"] = seq
            return f"event: {data['type']}\ndata: {json.dumps(data)}\n\n".encode()

        rid = f"resp_{int(time.time() * 1000)}"
        base = {"id": rid, "object": "response", "created_at": int(time.time()), "model": body["model"],
                "status": "in_progress", "output": [], "parallel_tool_calls": True, "tool_choice": "auto", "tools": []}
        yield ev({"type": "response.created", "response": base})
        output: list[dict[str, Any]] = []
        for i, b in enumerate(answer["blocks"]):
            if b["type"] == "thinking":
                item = {"type": "reasoning", "id": f"rs_{i}", "summary": [], "encrypted_content": f"enc-{i}"}
                yield ev({"type": "response.output_item.added", "output_index": i, "item": item})
                yield ev({"type": "response.reasoning_summary_part.added", "item_id": item["id"], "output_index": i,
                          "summary_index": 0, "part": {"type": "summary_text", "text": ""}})
                yield ev({"type": "response.reasoning_summary_text.delta", "item_id": item["id"], "output_index": i,
                          "summary_index": 0, "delta": b["text"]})
                item = {**item, "summary": [{"type": "summary_text", "text": b["text"]}]}
                yield ev({"type": "response.output_item.done", "output_index": i, "item": item})
            elif b["type"] == "text":
                item = {"type": "message", "id": f"msg_{i}", "role": "assistant", "status": "in_progress", "content": []}
                yield ev({"type": "response.output_item.added", "output_index": i, "item": item})
                for piece in _pieces(b["text"]):
                    yield ev({"type": "response.output_text.delta", "item_id": item["id"], "output_index": i,
                              "content_index": 0, "delta": piece, "logprobs": []})
                    await asyncio.sleep(0)
                await self._wait()
                item = {**item, "status": "completed",
                        "content": [{"type": "output_text", "text": b["text"], "annotations": b.get("annotations", [])}]}
                yield ev({"type": "response.output_item.done", "output_index": i, "item": item})
            elif b["type"] == "tool_use":
                cid = b.get("id") or f"call_{i}"
                item = {"type": "function_call", "id": f"fc_{i}", "call_id": cid, "name": b["name"], "arguments": "",
                        "status": "in_progress"}
                yield ev({"type": "response.output_item.added", "output_index": i, "item": item})
                raw = json.dumps(b["input"])
                yield ev({"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": i,
                          "delta": raw})
                item = {**item, "arguments": raw, "status": "completed"}
                yield ev({"type": "response.output_item.done", "output_index": i, "item": item})
            output.append(item)
        u = {**DEFAULT_USAGE, **(answer.get("usage") or {})}
        usage = {"input_tokens": u["input"] + u["cached"], "input_tokens_details": {"cached_tokens": u["cached"]},
                 "output_tokens": u["output"], "output_tokens_details": {"reasoning_tokens": u.get("reasoning", 0)},
                 "total_tokens": u["input"] + u["cached"] + u["output"]}
        final = {**base, "status": "completed", "output": output, "usage": usage}
        if answer.get("stop") == "max_tokens":
            final["status"] = "incomplete"
            final["incomplete_details"] = {"reason": "max_output_tokens"}
            yield ev({"type": "response.incomplete", "response": final})
        else:
            yield ev({"type": "response.completed", "response": final})

    # ---- Gemini ----

    async def _google(self, answer: dict[str, Any]):
        def chunk(parts: list[dict[str, Any]], finish: str | None = None, usage: dict[str, Any] | None = None) -> bytes:
            cand: dict[str, Any] = {"content": {"role": "model", "parts": parts}, "index": 0}
            if finish:
                cand["finishReason"] = finish
            data: dict[str, Any] = {"candidates": [cand], "modelVersion": "fake"}
            if usage:
                data["usageMetadata"] = usage
            return f"data: {json.dumps(data)}\n\n".encode()

        for b in answer["blocks"]:
            if b["type"] == "thinking":
                yield chunk([{"text": b["text"], "thought": True}])
            elif b["type"] == "text":
                for piece in _pieces(b["text"]):
                    yield chunk([{"text": piece}])
                    await asyncio.sleep(0)
                await self._wait()
            elif b["type"] == "tool_use":
                part: dict[str, Any] = {"functionCall": {"name": b["name"], "args": b["input"]}}
                if b.get("id"):
                    part["functionCall"]["id"] = b["id"]
                part["thoughtSignature"] = base64.b64encode(f"gsig-{b['name']}".encode()).decode()
                yield chunk([part])
        u = {**DEFAULT_USAGE, **(answer.get("usage") or {})}
        finish = {"max_tokens": "MAX_TOKENS", "refusal": "SAFETY"}.get(answer.get("stop", ""), "STOP")
        yield chunk([], finish, {"promptTokenCount": u["input"] + u["cached"], "cachedContentTokenCount": u["cached"],
                                 "candidatesTokenCount": u["output"], "thoughtsTokenCount": u.get("reasoning", 0),
                                 "totalTokenCount": u["input"] + u["cached"] + u["output"]})


def _pieces(text: str, size: int = 5) -> list[str]:
    return [text[i:i + size] for i in range(0, len(text), size)] or [""]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    """The fake vendors on a real port, in a thread (the SDKs make real HTTP calls)."""

    def __init__(self, port: int | None = None) -> None:
        import uvicorn

        self.fake = FakeVendors()
        self.port = port or free_port()
        self.server = uvicorn.Server(uvicorn.Config(self.fake.app, host="127.0.0.1", port=self.port, log_level="error"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> Server:
        self.thread.start()
        for _ in range(200):
            if self.server.started:
                return self
            time.sleep(0.02)
        raise RuntimeError("fake vendors didn't start")

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(5)

    def urls(self) -> dict[str, str]:
        base = f"http://127.0.0.1:{self.port}"
        return {"anthropic": base, "openai": f"{base}/v1", "google": base}


if __name__ == "__main__":
    import sys

    s = Server(int(sys.argv[1]) if len(sys.argv) > 1 else None).start()
    print(f"fake vendors on {s.port}", flush=True)
    s.thread.join()
