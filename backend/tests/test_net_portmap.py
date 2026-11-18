"""Geny Net from the internet without a server (docs/geny-net.md "From the internet, directly"): the desktop asks its
router to forward a port (UPnP IGD, NAT-PMP) — here a fake router on loopback; the relay tries that port from outside;
and the listener, now maybe on the internet, refuses what keeps failing."""

from __future__ import annotations

import asyncio
import json
import socket
import struct

import pytest
import uvicorn
import websockets
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI, Request
from fastapi.responses import Response

from app.net import portmap, relay
from app.net.identity import b64u, node_id_of, spki
from app.net.service import BLOCK_S, FAILS_MAX, NetService


@pytest.fixture(autouse=True)
def _loopback_is_the_lan(monkeypatch):
    # (the fake router lives on 127.0.0.1; the real code only ever talks to private addresses)
    monkeypatch.setattr(portmap, "private", lambda host: host.startswith(("127.", "10.", "192.168.", "172.")))


# -- a fake UPnP router ---------------------------------------------------------------------------------------------

DESC = """<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><deviceList><device><deviceList><device>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<controlURL>/ctl/IPConn</controlURL></service></serviceList></device></deviceList></device></deviceList>
</device></root>"""


def _fault(code: int, text: str) -> Response:
    body = (f'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail>'
            f'<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>{code}</errorCode>'
            f'<errorDescription>{text}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>')
    return Response(body, status_code=500, media_type="text/xml")


class FakeRouter:
    def __init__(self, external_ip: str = "1.2.3.4", permanent_only: bool = True, taken: tuple[int, ...] = ()) -> None:
        self.external_ip = external_ip
        self.permanent_only = permanent_only
        self.taken = set(taken)
        self.maps: dict[int, dict] = {}
        self.calls: list[str] = []
        app = FastAPI()

        @app.get("/desc.xml")
        async def desc() -> Response:
            return Response(DESC, media_type="text/xml")

        @app.post("/ctl/IPConn")
        async def ctl(request: Request) -> Response:
            action = request.headers["soapaction"].strip('"').split("#")[1]
            body = (await request.body()).decode()
            args = dict(__import__("re").findall(r"<(New\w+)>([^<]*)</New\w+>", body))
            self.calls.append(action)
            if action == "GetExternalIPAddress":
                return Response(f"<r><NewExternalIPAddress>{self.external_ip}</NewExternalIPAddress></r>",
                                media_type="text/xml")
            if action == "AddPortMapping":
                port = int(args["NewExternalPort"])
                if self.permanent_only and args["NewLeaseDuration"] != "0":
                    return _fault(725, "OnlyPermanentLeasesSupported")
                if port in self.taken:
                    return _fault(718, "ConflictInMappingEntry")
                self.maps[port] = args
                return Response("<r/>", media_type="text/xml")
            if action == "DeletePortMapping":
                self.maps.pop(int(args["NewExternalPort"]), None)
                return Response("<r/>", media_type="text/xml")
            return _fault(401, "Invalid Action")

        self.app = app

    async def __aenter__(self) -> "FakeRouter":
        http = socket.socket()
        http.bind(("127.0.0.1", 0))
        http.listen(16)
        self.http_port = http.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(self.app, log_level="warning", lifespan="off"))
        self.task = asyncio.create_task(self.server.serve(sockets=[http]))
        while not self.server.started:
            await asyncio.sleep(0.02)
        loop = asyncio.get_running_loop()
        location = f"http://127.0.0.1:{self.http_port}/desc.xml"
        searches = self.searches = []

        class Ssdp(asyncio.DatagramProtocol):
            def connection_made(self, transport) -> None:  # noqa: ANN001
                self.t = transport

            def datagram_received(self, data: bytes, addr) -> None:  # noqa: ANN001
                searches.append(data)
                self.t.sendto(f"HTTP/1.1 200 OK\r\nST: x\r\nLOCATION: {location}\r\n\r\n".encode(), addr)

        self.ssdp, _ = await loop.create_datagram_endpoint(Ssdp, local_addr=("127.0.0.1", 0))
        self.ssdp_addr = self.ssdp.get_extra_info("sockname")
        return self

    async def __aexit__(self, *exc) -> None:
        self.ssdp.close()
        self.server.should_exit = True
        await asyncio.wait_for(self.task, 10)


async def test_upnp_forwards_a_port_and_takes_it_back() -> None:
    async with FakeRouter(permanent_only=True, taken=(40001,)) as r:
        m = await portmap.upnp_map(5555, want_port=40001, ssdp_target=r.ssdp_addr)
        # (40001 is someone else's: another port; this router only keeps permanent mappings: lease 0)
        assert m.method == "upnp" and m.external_ip == "1.2.3.4" and m.external_port != 40001 and m.lease == 0
        args = r.maps[m.external_port]
        assert args["NewInternalPort"] == "5555" and args["NewProtocol"] == "TCP" and args["NewInternalClient"] == "127.0.0.1"
        await portmap.upnp_unmap(m)
        assert r.maps == {}


async def test_the_mapper_says_open_only_for_a_public_address() -> None:
    changes = []
    async with FakeRouter(permanent_only=False) as r:
        pm = portmap.PortMapper(6000, lambda: [], lambda: changes.append(1), ssdp_target=r.ssdp_addr, natpmp_port=1)
        pm.start(want_port=41000)
        for _ in range(100):
            if pm.state != "trying":
                break
            await asyncio.sleep(0.05)
        assert pm.state == "open" and pm.endpoint == "1.2.3.4:41000" and pm.mapping.lease == portmap.LEASE_S
        await pm.close()
        assert r.maps == {} and "DeletePortMapping" in r.calls
    async with FakeRouter(external_ip="100.64.3.9") as r:  # (the ISP's own NAT in front: not reachable)
        pm = portmap.PortMapper(6000, lambda: [], lambda: None, ssdp_target=r.ssdp_addr, natpmp_port=1)
        pm.start()
        for _ in range(100):
            if pm.state != "trying":
                break
            await asyncio.sleep(0.05)
        assert pm.state == "unavailable" and pm.endpoint == "" and "100.64.3.9" in pm.error
        await pm.close()


async def test_nat_pmp_where_there_is_no_upnp() -> None:
    loop = asyncio.get_running_loop()
    seen = []

    class Pmp(asyncio.DatagramProtocol):
        def connection_made(self, transport) -> None:  # noqa: ANN001
            self.t = transport

        def datagram_received(self, data: bytes, addr) -> None:  # noqa: ANN001
            seen.append(data)
            if data[1] == 0:
                self.t.sendto(struct.pack("!BBHI", 0, 128, 0, 1) + socket.inet_aton("5.6.7.8"), addr)
            elif data[1] == 2:
                _v, _op, _r, internal, want, lease = struct.unpack("!BBHHHI", data)
                self.t.sendto(struct.pack("!BBHIHHI", 0, 130, 0, 1, internal, want or 0, lease), addr)

    t, _ = await loop.create_datagram_endpoint(Pmp, local_addr=("127.0.0.1", 0))
    port = t.get_extra_info("sockname")[1]
    try:
        m = await portmap.natpmp_map(7000, ["127.0.0.1"], want_port=42000, natpmp_port=port)
        assert (m.method, m.external_ip, m.external_port, m.internal_port) == ("natpmp", "5.6.7.8", 42000, 7000)
        await portmap.natpmp_unmap(m, natpmp_port=port)
        assert struct.unpack("!BBHHHI", seen[-1])[5] == 0  # (lease 0: removed)
    finally:
        t.close()
    assert portmap.gateway_guesses(["192.168.0.23"]) == ["192.168.0.1", "192.168.0.254"]


# -- the listener on the internet ---------------------------------------------------------------------------------

def test_an_address_that_keeps_failing_is_refused(db, tmp_path) -> None:
    net = NetService(db, tmp_path, 1, name="Desk")
    for _ in range(FAILS_MAX - 1):
        net._fail("198.51.100.7")
    assert not net._is_blocked("198.51.100.7")
    net._fail("198.51.100.7")
    assert net._is_blocked("198.51.100.7")
    net._blocked["198.51.100.7"] -= BLOCK_S + 1
    assert not net._is_blocked("198.51.100.7")
    for _ in range(FAILS_MAX * 2):
        net._fail("127.0.0.1")  # (the relay's pipes: loopback is never blocked here)
    assert not net._is_blocked("127.0.0.1")


# -- the relay: tries the router's port from outside; what it pipes is capped --------------------------------------

@pytest.fixture
async def relay_server(monkeypatch):
    monkeypatch.setattr(relay, "PROBE_PRIVATE", True)
    app = FastAPI()
    app.include_router(relay.router)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(64)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="off"))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        await asyncio.sleep(0.02)
    yield f"ws://127.0.0.1:{sock.getsockname()[1]}", app
    server.should_exit = True
    await asyncio.wait_for(task, 10)


def _sign(key, text: str) -> str:
    return b64u(key.sign(text.encode(), ec.ECDSA(hashes.SHA256())))


async def _host(url: str, key, public_port: int = 0):
    nid = node_id_of(key.public_key())
    ws = await websockets.connect(f"{url}/net/relay/host?n={nid}")
    ch = json.loads(await ws.recv())["challenge"]
    await ws.send(json.dumps({"pub": b64u(spki(key.public_key())), "sig": _sign(key, "geny-net-host|" + ch),
                              "lan": [], "port": 0, "public_port": public_port}))
    return nid, ws, json.loads(await ws.recv())


async def test_the_relay_tries_the_routers_port_from_outside(relay_server) -> None:
    url, _app = relay_server
    listener = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
    open_port = listener.sockets[0].getsockname()[1]
    closed = socket.socket()
    closed.bind(("127.0.0.1", 0))
    closed_port = closed.getsockname()[1]
    closed.close()
    try:
        key = ec.generate_private_key(ec.SECP256R1())
        nid, ws, ok = await _host(url, key, public_port=open_port)
        assert ok["ok"] and ok["reach"] is True
        import httpx

        async with httpx.AsyncClient() as c:
            where = (await c.get(url.replace("ws://", "http://") + f"/net/relay/where?n={nid}")).json()
        assert where["wan"] == f"127.0.0.1:{open_port}"
        await ws.send(json.dumps({"public_port": closed_port}))  # (the router's port changed)
        assert json.loads(await ws.recv())["reach"] is False
        await ws.close()
    finally:
        listener.close()


async def test_what_a_session_pipes_is_capped(relay_server, monkeypatch) -> None:
    url, _app = relay_server
    monkeypatch.setattr(relay, "SESSION_MIB_S", 1.0)
    key = ec.generate_private_key(ec.SECP256R1())

    async def accept(nid, sid):
        async with websockets.connect(f"{url}/net/relay/accept?n={nid}&s={sid}&sig={_sign(key, 'geny-net-accept|' + sid)}",
                                      max_size=2**20) as ws:
            async for m in ws:
                await ws.send(m)

    nid, host_ws, _ = await _host(url, key)

    async def opens():
        async for m in host_ws:
            sid = json.loads(m).get("open")
            if sid:
                asyncio.create_task(accept(nid, sid))

    t = asyncio.create_task(opens())
    chunk = b"x" * 65536
    loop = asyncio.get_running_loop()
    async with websockets.connect(f"{url}/net/relay/connect?n={nid}", max_size=2**20) as ws:
        start = loop.time()
        for _ in range(48):  # 3 MiB there (and back)
            await ws.send(chunk)
        got = 0
        while got < 48 * 65536:
            got += len(await ws.recv())
        took = loop.time() - start
    t.cancel()
    await host_ws.close()
    # 3 MiB each way through a 1 MiB/s session (a second's burst allowed): at least ~2 s
    assert took > 1.6, took


async def test_a_node_offers_its_routers_address(db, tmp_path) -> None:
    from urllib.parse import parse_qs, urlsplit

    async with FakeRouter(permanent_only=False) as r:
        net = NetService(db, tmp_path, 1, name="Desk")
        net.store.put_setting("relay", False)
        net.portmap_options = {"ssdp_target": r.ssdp_addr, "natpmp_port": 1}
        offer = await net.new_offer()
        for _ in range(100):
            if net.wan:
                break
            await asyncio.sleep(0.05)
        assert net.wan == f"1.2.3.4:{net.port}"  # (the same port outside as inside, when it's free)
        assert r.maps[net.port]["NewInternalPort"] == str(net.port)
        offer = await net.new_offer()
        q = {k: v[0] for k, v in parse_qs(urlsplit(offer["uri"]).query).items()}
        assert q["w"] == net.wan
        st = net.status()
        assert st["upnp_on"] and st["wan"]["state"] == "open" and st["wan"]["method"] == "upnp"
        assert net.where()["wan"] == net.wan
        await net.stop()  # (the router's port goes with it)
        assert r.maps == {}
        await net.apply_settings({"upnp": False})
        await net.new_offer()
        assert net.portmap is None and net.status()["wan"]["state"] == "off"
        await net.stop()
