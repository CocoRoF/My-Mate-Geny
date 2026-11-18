"""A node's line to a Geny Net relay (app/net/relay.py; docs/geny-net.md "The relay").

One WebSocket held open to ``<relay>/net/relay/host`` (outbound: nothing to open on the router), on which the node
proves its id (the relay's challenge, signed with the node's CA key) and says where it is on its own network (so a
device can try it directly next time) — and, when the router forwards a port to it (portmap.py), that port: the relay
tries it from outside and says whether it works (``reach``). When a device asks the relay for this node, the relay sends ``open``; the node
opens ``<relay>/net/relay/accept`` (signed again) and pipes it into its own TLS listener through loopback — the device
and the node talk TLS end to end; the relay forwards bytes it can't read.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode

if TYPE_CHECKING:
    from .service import NetService

log = logging.getLogger("app.net.relay")

MAX_SESSIONS = 32


def ws_base(url: str) -> str:
    url = url.rstrip("/")
    return "wss://" + url[8:] if url.startswith("https://") else "ws://" + url[7:] if url.startswith("http://") else url


class RelayLink:
    def __init__(self, net: "NetService", url: str) -> None:
        self.net = net
        self.url = url
        self.state = "connecting"         # connecting | online | offline
        self.error = ""
        self._task: asyncio.Task | None = None
        self._sessions: set[asyncio.Task] = set()
        self._ours: dict[tuple[str, int], str] = {}  # loopback ports of the relayed connections into the listener
        self._ws: Any = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(BaseException):
                await self._task
        for t in list(self._sessions):
            t.cancel()

    def is_ours(self, addr: tuple[str, int]) -> bool:
        return tuple(addr) in self._ours

    async def _run(self) -> None:
        import websockets

        from .service import lan_addresses

        backoff = 1.0
        while True:
            try:
                q = urlencode({"n": self.net.identity.id})
                async with websockets.connect(f"{ws_base(self.url)}/net/relay/host?{q}", max_size=2**16,
                                              ping_interval=25, ping_timeout=20, open_timeout=15) as ws:
                    hello = json.loads(await asyncio.wait_for(ws.recv(), 15))
                    challenge = str(hello.get("challenge") or "")
                    await ws.send(json.dumps({
                        "pub": self.net.identity.ca_spki,
                        "sig": self.net.identity.sign(("geny-net-host|" + challenge).encode()),
                        "lan": lan_addresses() if self.net.lan_on else [],
                        "port": self.net.port if self.net.lan_on else 0,
                        "public_port": self._public_port(),
                    }))
                    ok = json.loads(await asyncio.wait_for(ws.recv(), 20))
                    if not ok.get("ok"):
                        raise RuntimeError(str(ok.get("error") or "refused"))
                    self._heard(ok)
                    self._ws = ws
                    self.state, self.error, backoff = "online", "", 1.0
                    self.net.on_change()
                    log.info("relay %s: online as %s", self.url, self.net.identity.id)
                    async for msg in ws:
                        m = json.loads(msg) if isinstance(msg, str) else {}
                        if "reach" in m:
                            self._heard(m)
                            continue
                        sid = str(m.get("open") or "")
                        if sid and len(self._sessions) < MAX_SESSIONS:
                            t = asyncio.create_task(self._session(sid))
                            self._sessions.add(t)
                            t.add_done_callback(self._sessions.discard)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - the relay is down or unreachable: try again later
                self.error = f"{type(e).__name__}: {e}"[:200]
                log.info("relay %s: %s", self.url, self.error)
            self._ws = None
            self.state = "offline"
            self.net.on_change()
            await asyncio.sleep(backoff)
            backoff = min(60.0, backoff * 2)
            self.state = "connecting"

    def _public_port(self) -> int:
        wan = self.net.wan
        return int(wan.rsplit(":", 1)[1]) if wan else 0

    def _heard(self, m: dict) -> None:
        """the relay's word on the router's forwarded port, tried from outside"""
        if "reach" in m and self._public_port():
            self.net.reach = m.get("reach") if isinstance(m.get("reach"), bool) else None
            self.net.on_change()

    def tell_public(self) -> None:
        """the router's forwarded port changed: the relay tries it (again)"""
        ws = self._ws
        if ws is not None:
            asyncio.ensure_future(_quiet(ws.send(json.dumps({"public_port": self._public_port()}))))

    async def _session(self, sid: str) -> None:
        """a device came through the relay: its WebSocket ↔ this node's TLS listener, byte for byte"""
        import websockets

        q = urlencode({"n": self.net.identity.id, "s": sid,
                       "sig": self.net.identity.sign(("geny-net-accept|" + sid).encode())})
        try:
            async with websockets.connect(f"{ws_base(self.url)}/net/relay/accept?{q}", max_size=2**20,
                                          ping_interval=25, ping_timeout=20, open_timeout=15) as ws:
                r, w = await asyncio.open_connection("127.0.0.1", self.net.port)
                key = tuple(w.get_extra_info("sockname")[:2])
                self._ours[key] = sid
                try:
                    await _ws_tcp(ws, r, w)
                finally:
                    if self._ours.get(key) == sid:  # (a closed connection's port comes back at once on loopback)
                        del self._ours[key]
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.info("relay session %s: %s", sid, e)


async def _quiet(coro: Any) -> None:
    with contextlib.suppress(Exception):
        await coro


async def _ws_tcp(ws: Any, r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
    async def up() -> None:  # WebSocket → TCP
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                w.write(msg)
                await w.drain()

    async def down() -> None:  # TCP → WebSocket
        while True:
            data = await r.read(65536)
            if not data:
                break
            await ws.send(data)

    a, b = asyncio.ensure_future(up()), asyncio.ensure_future(down())
    try:
        await asyncio.wait({a, b}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (a, b):
            t.cancel()
        with contextlib.suppress(Exception):
            w.close()
        with contextlib.suppress(Exception):
            await ws.close()
