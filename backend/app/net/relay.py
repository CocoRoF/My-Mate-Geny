"""The Geny Net relay (docs/geny-net.md "The relay"): any My Mate Geny server can be one (``NET_RELAY=1``).

It joins a device away from home to its node — both reach it outbound, so neither opens a port — and forwards their
bytes without reading them: the TLS between them runs end to end through it (the device pins the node's CA, the node
checks the device's certificate). What the relay knows: node ids that are online, the private addresses a node
reported (handed to whoever asks for that id, so a device can try it directly), and how many bytes went by.

It is the last way in (docs/geny-net.md): a phone tries the LAN, then the node's router (portmap.py — the relay tries
that port from outside and says whether it works: ``reach``), and only then this. What it costs (measured on an
i5-12400F, 2026-11-18): ~100 KiB and next to no CPU per node holding its line; ~30 ms of CPU per MiB piped — so the
bytes it pipes are capped (``NET_RELAY_MIB_S`` in all, 4 MiB/s per session) and so are the sessions.

* ``WS /net/relay/host?n=<node>`` — a node: answers a challenge with a signature by the key its id is made from, then
  waits for ``{"open": session}``.
* ``WS /net/relay/connect?n=<node>`` — a device: the relay asks the node to accept, then pipes the two together.
* ``WS /net/relay/accept?n=<node>&s=<session>&sig=…`` — the node's side of one session.
* ``GET /net/relay/where?n=<node>`` — is it online, and where it said it is on its own network.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import logging
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .identity import verify_node

log = logging.getLogger("app.net.relay")
router = APIRouter()

ACCEPT_TIMEOUT_S = 12
MAX_HOSTS = 5000
MAX_SESSIONS_PER_HOST = 32
MAX_SESSIONS = 256                # in all
SESSION_MIB_S = 4.0               # what one session may pipe per second
IDLE_SESSION_S = 900              # a session nothing went through for this long is closed
CONNECTS_PER_MINUTE = 240         # per client IP (a phone opens a connection per page load or so)
FRAME_MAX = 1 << 20
PROBE_S = 4
PROBE_PRIVATE = False             # (tests: try a node's port on a private address too)


@dataclass
class Host:
    id: str
    ws: WebSocket
    pub: str
    lan: list[str]
    port: int
    ip: str = ""                     # where it connected from (its public address, behind a home router)
    public_port: int = 0             # the port its router forwards to it (portmap.py), if any
    reach: bool | None = None        # that port answered when the relay tried it
    since: float = field(default_factory=time.time)
    pending: dict[str, asyncio.Future] = field(default_factory=dict)
    sessions: int = 0


class Bucket:
    """bytes per second, shared by whoever takes from it (a session's own, and the relay's in all)"""

    def __init__(self, mib_s: float) -> None:
        self.rate = max(0.1, mib_s) * 2**20
        self.tokens = self.rate
        self.t = time.monotonic()

    async def take(self, n: int) -> None:
        now = time.monotonic()
        self.tokens = min(self.rate, self.tokens + (now - self.t) * self.rate)
        self.t = now
        self.tokens -= n
        if self.tokens < 0:
            await asyncio.sleep(-self.tokens / self.rate)


class Hub:
    def __init__(self) -> None:
        from app.config import settings

        self.hosts: dict[str, Host] = {}
        self._rate: dict[str, deque] = {}
        self.bytes = 0
        self.sessions = 0
        self.total = Bucket(settings.net_relay_mib_s)

    def allow(self, ip: str) -> bool:
        now = time.monotonic()
        q = self._rate.setdefault(ip, deque())
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= CONNECTS_PER_MINUTE:
            return False
        q.append(now)
        if len(self._rate) > 10000:  # (forget the quiet ones)
            for k in [k for k, v in self._rate.items() if not v][:5000]:
                self._rate.pop(k, None)
        return True


def hub(app) -> Hub:
    h = getattr(app.state, "net_relay", None)
    if h is None:
        h = app.state.net_relay = Hub()
    return h


def _ip(ws: WebSocket | Request) -> str:
    from app.auth import AuthManager

    return AuthManager.client_ip(ws)  # type: ignore[arg-type]


@router.websocket("/net/relay/host")
async def relay_host(ws: WebSocket) -> None:
    h = hub(ws.app)
    node = ws.query_params.get("n", "")
    await ws.accept()
    if not node or len(h.hosts) >= MAX_HOSTS or not h.allow(_ip(ws)):
        await ws.close(code=4429)
        return
    challenge = secrets.token_urlsafe(24)
    await ws.send_text(json.dumps({"challenge": challenge}))
    try:
        hello = json.loads(await asyncio.wait_for(ws.receive_text(), 15))
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
        with contextlib.suppress(Exception):
            await ws.close(code=4400)
        return
    pub, sig = str(hello.get("pub") or ""), str(hello.get("sig") or "")
    if not verify_node(node, pub, ("geny-net-host|" + challenge).encode(), sig):
        await ws.send_text(json.dumps({"ok": False, "error": "this id isn't yours"}))
        await ws.close(code=4403)
        return
    lan = [str(a)[:45] for a in (hello.get("lan") or [])][:6]
    old = h.hosts.get(node)
    host = Host(node, ws, pub, lan, _int(hello.get("port")), ip=_ip(ws))
    h.hosts[node] = host
    if old is not None:  # (the same node again — a reconnect: the newer line wins)
        with contextlib.suppress(Exception):
            await old.ws.close(code=4409)
    await _probe(host, _int(hello.get("public_port")))
    await ws.send_text(json.dumps({"ok": True, "ip": host.ip, "reach": host.reach}))
    try:
        while True:
            try:
                m = json.loads(await ws.receive_text())
            except ValueError:
                continue
            if isinstance(m, dict) and "public_port" in m:  # (its router's forwarded port changed)
                await _probe(host, _int(m.get("public_port")))
                await ws.send_text(json.dumps({"reach": host.reach, "ip": host.ip}))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if h.hosts.get(node) is host:
            h.hosts.pop(node, None)
        for f in host.pending.values():
            if not f.done():
                f.cancel()


@router.websocket("/net/relay/connect")
async def relay_connect(ws: WebSocket) -> None:
    h = hub(ws.app)
    node = ws.query_params.get("n", "")
    await ws.accept()
    host = h.hosts.get(node)
    if not h.allow(_ip(ws)):
        await ws.close(code=4429)
        return
    if host is None:
        await ws.close(code=4404)  # (not online: the desktop is off, or its app isn't running)
        return
    if host.sessions >= MAX_SESSIONS_PER_HOST or h.sessions >= MAX_SESSIONS:
        await ws.close(code=4429)
        return
    sid = secrets.token_urlsafe(18)
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    host.pending[sid] = fut
    try:
        await host.ws.send_text(json.dumps({"open": sid}))
        other: WebSocket = await asyncio.wait_for(fut, ACCEPT_TIMEOUT_S)
    except (asyncio.TimeoutError, asyncio.CancelledError, RuntimeError, WebSocketDisconnect):
        host.pending.pop(sid, None)
        with contextlib.suppress(Exception):
            await ws.close(code=4504)
        return
    host.pending.pop(sid, None)
    host.sessions += 1
    h.sessions += 1
    try:
        await _pipe(ws, other, h)
    finally:
        host.sessions -= 1
        h.sessions -= 1
        done = getattr(other, "_geny_done", None)
        if done is not None:
            done.set()


@router.websocket("/net/relay/accept")
async def relay_accept(ws: WebSocket) -> None:
    h = hub(ws.app)
    node, sid, sig = (ws.query_params.get(k, "") for k in ("n", "s", "sig"))
    await ws.accept()
    host = h.hosts.get(node)
    fut = host.pending.get(sid) if host is not None else None
    if host is None or fut is None or fut.done() or not verify_node(node, host.pub, ("geny-net-accept|" + sid).encode(), sig):
        await ws.close(code=4403)
        return
    done = asyncio.Event()
    ws._geny_done = done  # type: ignore[attr-defined]  # (the device's side pipes; this side waits for it)
    fut.set_result(ws)
    await done.wait()


@router.get("/net/relay/where")
async def relay_where(request: Request) -> Any:
    h = hub(request.app)
    if not h.allow(_ip(request)):
        return JSONResponse({"detail": "slow down"}, status_code=429)
    host = h.hosts.get(request.query_params.get("n", ""))
    if host is None:
        return {"online": False}
    return {"online": True, "lan": host.lan, "port": host.port,
            "wan": f"{host.ip}:{host.public_port}" if host.reach and host.public_port else ""}


def _int(v: Any) -> int:
    try:
        n = int(v or 0)
    except (TypeError, ValueError):
        return 0
    return n if 0 < n < 65536 else 0


async def _probe(host: Host, port: int) -> None:
    """does the node's router really forward `port` to it? — tried from here, at the address the node came from
    (never anywhere else: a node can't point the relay at someone else's machine)"""
    host.public_port, host.reach = port, None
    if not port:
        return
    try:
        ip = ipaddress.ip_address(host.ip)
    except ValueError:
        return
    if ip.version != 4 or not (ip.is_global or PROBE_PRIVATE):
        return  # (a router forwards an IPv4 port; a node that came over IPv6 is left unchecked)
    try:
        _r, w = await asyncio.wait_for(asyncio.open_connection(host.ip, port), PROBE_S)
        w.close()
        host.reach = True
    except (OSError, asyncio.TimeoutError):
        host.reach = False


async def _pipe(a: WebSocket, b: WebSocket, h: Hub) -> None:
    mine = Bucket(min(SESSION_MIB_S, h.total.rate / 2**20))
    last = [time.monotonic()]

    async def one(src: WebSocket, dst: WebSocket) -> None:
        try:
            while True:
                m = await src.receive()
                if m.get("type") == "websocket.disconnect":
                    break
                data = m.get("bytes")
                if data:
                    if len(data) > FRAME_MAX:
                        break
                    h.bytes += len(data)
                    last[0] = time.monotonic()
                    await mine.take(len(data))
                    await h.total.take(len(data))
                    await dst.send_bytes(data)
        except (WebSocketDisconnect, RuntimeError):
            pass

    async def idle() -> None:
        while time.monotonic() - last[0] < IDLE_SESSION_S:
            await asyncio.sleep(30)

    x, y, z = asyncio.ensure_future(one(a, b)), asyncio.ensure_future(one(b, a)), asyncio.ensure_future(idle())
    try:
        await asyncio.wait({x, y, z}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (x, y, z):
            t.cancel()
        for w in (a, b):
            with contextlib.suppress(Exception):
                await w.close()
