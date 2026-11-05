"""Real MCP SDK fixture. No provider APIs, installations or paid calls."""

import asyncio
import os
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("Geny test catalog", stateless_http=True)
if os.environ.get("FIXTURE_PID"):
    Path(os.environ["FIXTURE_PID"]).write_text(str(os.getpid()))
print("fixture log " + os.environ.get("FIXTURE_KEY", "no-key"), file=sys.stderr, flush=True)


@mcp.tool()
def echo(text: str) -> str:
    """Echo a test string."""
    return "echo: " + text


@mcp.tool()
async def slow(seconds: float = 30) -> str:
    """Wait until cancelled (tests only)."""
    try:
        await asyncio.sleep(seconds)
        return "finished"
    except asyncio.CancelledError:
        if os.environ.get("FIXTURE_PID"):
            Path(os.environ["FIXTURE_PID"] + ".cancelled").write_text("cancelled before disconnect")
        raise


@mcp.tool()
def inherited_secrets() -> str:
    """Ensure the backend does not implicitly pass its own secrets."""
    return (
        ",".join(k for k in ("AUTH_PASSWORD", "VAULT_KEY", "SESSION_SECRET") if os.environ.get(k))
        or "none"
    )


@mcp.resource("fixture://hello")
def resource() -> str:
    return "fixture resource"


@mcp.prompt()
def greeting(name: str = "Geny") -> str:
    return "Hello " + name


if __name__ == "__main__":
    for index in range(int(os.environ.get("FIXTURE_MANY_TOOLS", "0"))):

        def tool_factory(index):
            def extra() -> str:
                return f"extra {index}"

            return extra

        mcp.tool(name=f"extra_{index}")(tool_factory(index))
    if len(sys.argv) > 1:
        import uvicorn
        from starlette.responses import PlainTextResponse

        transport, port = sys.argv[1], int(sys.argv[2])
        app = mcp.streamable_http_app() if transport == "http" else mcp.sse_app()

        async def secured(scope, receive, send):
            if (
                scope["type"] == "http"
                and dict(scope["headers"]).get(b"x-test-key") != b"fixture-http-key"
            ):
                await PlainTextResponse("auth required", status_code=401)(scope, receive, send)
            else:
                await app(scope, receive, send)

        uvicorn.run(secured, host="127.0.0.1", port=port, log_level="error")
    else:
        mcp.run(transport="stdio")
