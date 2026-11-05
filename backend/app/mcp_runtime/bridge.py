"""Session-scoped SDK gateway. Upstream credentials remain in the backend.

The SDK handles concurrent RPC requests and cancellation notifications. An
instance prefix keeps request IDs separate across engine restarts.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import sys
from pathlib import Path

import anyio
import httpx
from mcp import McpError, types
from mcp.server.lowlevel import Server
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server

REQUESTS = (
    (types.ListToolsRequest, types.ListToolsResult),
    (types.CallToolRequest, types.CallToolResult),
    (types.ListResourcesRequest, types.ListResourcesResult),
    (types.ListResourceTemplatesRequest, types.ListResourceTemplatesResult),
    (types.ReadResourceRequest, types.ReadResourceResult),
    (types.ListPromptsRequest, types.ListPromptsResult),
    (types.GetPromptRequest, types.GetPromptResult),
)


async def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    server = Server("Geny MCP gateway")
    instance = secrets.token_urlsafe(12)
    base = os.environ["GENY_MCP_API"] + "/api/internal/mcp/"
    token_path = Path(os.environ["GENY_MCP_TOKEN_FILE"])
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(3610, connect=5, pool=5),
        limits=httpx.Limits(max_connections=16, max_keepalive_connections=16),
    ) as http:

        async def forward(route, body, timeout=None):
            response = await http.post(
                base + route,
                json=body,
                headers={"X-MCP-Token": token_path.read_text().strip()},
                **({"timeout": timeout} if timeout else {}),
            )
            response.raise_for_status()
            return response.json()

        info = await forward("call", {"method": "bridge/info", "params": {}})
        # Only advertise features the gateway actually forwards. A changed
        # catalog is picked up at the next turn/reconnect, not through subscriptions.
        capabilities = {
            k: {} for k in info["capabilities"] if k in ("tools", "resources", "prompts")
        }
        options = InitializationOptions(
            server_name=info["name"],
            server_version="1.0.0",
            capabilities=types.ServerCapabilities.model_validate(capabilities),
        )

        def handler(result_type):
            async def dispatch(request):
                data = request.model_dump(mode="json", by_alias=True, exclude_none=True)
                request_id = instance + ":" + str(server.request_context.request_id)
                try:
                    result = await forward(
                        "call",
                        {
                            "method": data["method"],
                            "params": data.get("params") or {},
                            "request_id": request_id,
                        },
                    )
                    return types.ServerResult(result_type.model_validate(result))
                except asyncio.CancelledError:
                    with anyio.CancelScope(shield=True):
                        try:
                            await forward("cancel", {"request_id": request_id}, timeout=3)
                        except Exception:
                            pass
                    raise
                except Exception:
                    # No tokens, upstream response bodies or tool arguments in an error.
                    raise McpError(
                        types.ErrorData(
                            code=-32000,
                            message="MCP unavailable or disabled; check Geny MCP settings.",
                        )
                    ) from None

            return dispatch

        for request_type, result_type in REQUESTS:
            server.request_handlers[request_type] = handler(result_type)
        async with stdio_server() as (read, write):
            await server.run(read, write, options)


if __name__ == "__main__":
    try:
        anyio.run(main)
    except Exception:
        print(
            "Geny MCP gateway could not connect; check the session and MCP connection.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
