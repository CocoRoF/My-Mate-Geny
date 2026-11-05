"""Exercise the actual session gateway of a running, throwaway test app."""

import asyncio
import json
import sys
import time
from pathlib import Path

from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client


async def main(config_path, cancel_marker):
    config = json.load(open(config_path))
    spec = next(v for k, v in config["mcpServers"].items() if k.startswith("geny_"))
    async with stdio_client(
        StdioServerParameters(command=spec["command"], args=spec["args"], env=spec["env"])
    ) as streams:
        async with ClientSession(*streams) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert "echo" in {t.name for t in tools.tools}
            slow = asyncio.create_task(session.call_tool("slow", {"seconds": 1.5}))
            await asyncio.sleep(0.1)
            start = time.monotonic()
            echo = await session.call_tool("echo", {"text": "parallel gateway test"})
            elapsed = time.monotonic() - start
            assert "parallel gateway test" in echo.content[0].text
            assert elapsed < 0.8 and not slow.done(), (
                f"gateway serialized a short call behind a long call: {elapsed}"
            )
            await slow
            request_id = session._request_id
            cancelled = asyncio.create_task(session.call_tool("slow", {"seconds": 30}))
            await asyncio.sleep(0.1)
            # A real engine sends notifications/cancelled, not only a Python task cancellation.
            await session.send_notification(
                types.ClientNotification(
                    types.CancelledNotification(
                        params=types.CancelledNotificationParams(requestId=request_id)
                    )
                )
            )
            cancelled.cancel()
            try:
                await cancelled
                raise AssertionError("Expected cancellation")
            except asyncio.CancelledError:
                pass
            for _ in range(50):
                if Path(cancel_marker).exists():
                    break
                await asyncio.sleep(0.02)
            else:
                raise AssertionError(
                    "The upstream tool was not cancelled before the gateway disconnected"
                )
            echo = await session.call_tool("echo", {"text": "still connected"})
            assert "still connected" in echo.content[0].text
            assert (await session.list_resources()).resources
            assert (await session.list_prompts()).prompts
            print(
                json.dumps(
                    {
                        "parallelGatewayCalls": True,
                        "shortCallSeconds": round(elapsed, 3),
                        "individualCancellation": True,
                        "resourceAndPromptProxy": True,
                    }
                )
            )


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
