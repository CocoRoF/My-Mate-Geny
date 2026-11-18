"""Geny Net (docs/geny-net.md): a phone pairs with the desktop and reaches it — directly, and through a relay.

The backend runs here for real (uvicorn on its two loopback sockets, the node's TLS listener, the relay routes); the
"phone" is this test: an EC key of its own, TLS pinned to the node's CA, raw HTTP over it.
"""

from __future__ import annotations

import asyncio
import json
import socket
import ssl
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
import uvicorn
import websockets
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI, Request, WebSocket

from app.auth import COOKIE_NAME, AuthManager, AuthMiddleware
from app.config import settings
from app.net import relay
from app.net.identity import Identity, b64u, node_id_of, spki, unb64u, verify_node
from app.net.ingress import NetIngress
from app.net.service import NetService, proof_of, sas_of
from app.routers import net as net_router
from app.ws.gate import admit


# -- the node's identity ------------------------------------------------------------------------------------------

def test_identity_is_kept_private_and_stable(tmp_path: Path) -> None:
    a = Identity(tmp_path / "net")
    for f in ("node.key", "node.crt", "server.key", "server.crt"):
        assert (tmp_path / "net" / f).stat().st_mode & 0o077 == 0
    b = Identity(tmp_path / "net")
    assert a.id == b.id and a.ca_fingerprint == b.ca_fingerprint and len(a.id) == 26
    assert a.id == node_id_of(a.ca_key.public_key())


def test_a_device_certificate_is_for_its_own_key_and_chains_to_the_node(tmp_path: Path) -> None:
    ident = Identity(tmp_path / "net")
    key = ec.generate_private_key(ec.SECP256R1())
    issued = ident.issue(spki(key.public_key()), "Pixel")
    assert issued.device_id.startswith("d_")
    assert spki(issued.cert.public_key()) == spki(key.public_key())
    ident.ca_cert.public_key().verify(issued.cert.signature, issued.cert.tbs_certificate_bytes,
                                      ec.ECDSA(issued.cert.signature_hash_algorithm))
    with pytest.raises(ValueError):  # (only P-256)
        ident.issue(spki(ec.generate_private_key(ec.SECP384R1()).public_key()), "x")


def test_only_the_key_holder_can_claim_a_node_id(tmp_path: Path) -> None:
    ident = Identity(tmp_path / "a")
    other = Identity(tmp_path / "b")
    sig = ident.sign(b"geny-net-host|abc")
    assert verify_node(ident.id, ident.ca_spki, b"geny-net-host|abc", sig)
    assert not verify_node(ident.id, ident.ca_spki, b"geny-net-host|abd", sig)
    assert not verify_node(other.id, ident.ca_spki, b"geny-net-host|abc", sig)  # (someone else's id)
    assert not verify_node(ident.id, other.ca_spki, b"geny-net-host|abc", other.sign(b"geny-net-host|abc"))


# -- the backend, for real ----------------------------------------------------------------------------------------

def _app(db, net_holder: dict) -> FastAPI:
    app = FastAPI()

    @app.get("/api/whoami")
    async def whoami(request: Request) -> dict:
        return {"client": request.client.host if request.client else ""}

    @app.get("/api/internal/thing")
    async def internal_thing() -> dict:
        return {"secret": True}

    @app.get("/api/cookie")
    async def set_cookie(request: Request):
        from fastapi.responses import JSONResponse

        r = JSONResponse({"ok": True})
        r.set_cookie("lang", "ko")
        return r

    @app.websocket("/ws/echo")
    async def echo(ws: WebSocket) -> None:
        ip = await admit(ws)
        if ip is None:
            return
        await ws.accept()
        await ws.send_text(ip)
        await ws.close()

    app.include_router(net_router.router)
    app.include_router(relay.router)
    app.add_middleware(AuthMiddleware)
    app.add_middleware(NetIngress)
    app.state.auth = AuthManager(db)
    return app


def _sock() -> socket.socket:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    s.listen(64)
    return s


@pytest.fixture
async def node(db, tmp_path, monkeypatch):
    main, ingress = _sock(), _sock()
    monkeypatch.setattr(settings, "execution_mode", "local")
    monkeypatch.setattr(settings, "net_ingress_port", ingress.getsockname()[1])
    app = _app(db, {})
    net = NetService(db, tmp_path, ingress.getsockname()[1], name="Desk")
    net.store.put_setting("relay", False)
    net.store.put_setting("upnp", False)  # (never this machine's real router: test_net_portmap.py has a fake one)
    app.state.net = net
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="off", loop="asyncio",
                                           proxy_headers=False))  # (as local_main.py runs it)
    task = asyncio.create_task(server.serve(sockets=[main, ingress]))
    while not server.started:
        await asyncio.sleep(0.02)
    yield {"app": app, "net": net, "main": main.getsockname()[1], "ingress": ingress.getsockname()[1]}
    await net.stop()
    server.should_exit = True
    await asyncio.wait_for(task, 10)


def _client_ctx(net: NetService, key=None, cert_pem: str = "", tmp: Path | None = None) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_3
    ctx.load_verify_locations(cadata=net.identity.ca_pem)  # (the app pins it by the QR code's fingerprint)
    if key is not None:
        assert tmp is not None
        (tmp / "dev.key").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                         serialization.NoEncryption()))
        (tmp / "dev.crt").write_text(cert_pem)
        ctx.load_cert_chain(str(tmp / "dev.crt"), str(tmp / "dev.key"))
    return ctx


async def _http(port: int, ctx: ssl.SSLContext | None, method: str, path: str, body=None, host: str = "",
                headers: dict | None = None) -> tuple[int, dict, bytes]:
    r, w = await asyncio.open_connection("127.0.0.1", port, ssl=ctx, server_hostname=host or None)
    return await _exchange(r, w, method, path, body, headers)


async def _exchange(r, w, method, path, body=None, headers=None) -> tuple[int, dict, bytes]:
    data = b"" if body is None else json.dumps(body).encode()
    head = [f"{method} {path} HTTP/1.1", "Host: 127.0.0.1:41234", "Connection: close",
            f"Content-Length: {len(data)}", "Content-Type: application/json"]
    head += [f"{k}: {v}" for k, v in (headers or {}).items()]
    w.write(("\r\n".join(head) + "\r\n\r\n").encode() + data)
    await w.drain()
    raw = b""
    try:
        while chunk := await asyncio.wait_for(r.read(65536), 30):
            raw += chunk
    except (ConnectionError, ssl.SSLError):
        pass
    w.close()
    if not raw:
        return 0, {}, b""
    top, _, rest = raw.partition(b"\r\n\r\n")
    lines = top.decode("latin-1").split("\r\n")
    hdrs: dict = {}
    for ln in lines[1:]:
        k, _, v = ln.partition(":")
        hdrs.setdefault(k.strip().lower(), []).append(v.strip())
    return int(lines[0].split()[1]), hdrs, rest


def _offer_parts(uri: str) -> dict:
    u = urlsplit(uri)
    assert u.scheme == "geny" and u.netloc == "link"
    return {k: v[0] for k, v in parse_qs(u.query).items()}


async def _pair(node, tmp_path, name: str = "Pixel 9") -> dict:
    net: NetService = node["net"]
    offer = await net.new_offer()
    q = _offer_parts(offer["uri"])
    assert q["n"] == net.identity.id and q["f"] == net.identity.ca_fingerprint and q["d"] == "Desk"
    assert q["p"] == str(net.port)
    secret = unb64u(q["k"])
    key = ec.generate_private_key(ec.SECP256R1())
    pub = spki(key.public_key())
    ctx = _client_ctx(net)
    host = f"{net.identity.id}.geny.net"
    st, _, body = await _http(net.port, ctx, "POST", "/api/net/pair/request", host=host, body={
        "pub": b64u(pub), "proof": b64u(proof_of(secret, net.identity.id, pub)), "name": name, "platform": "android"})
    assert st == 200, body
    req = json.loads(body)
    assert req["sas"] == sas_of(secret, pub) and len(req["sas"]) == 6
    # the desktop sees it (with the same six digits) and allows it — in its own window
    token = node["app"].state.auth.issue_token(node["app"].state.auth.username)
    st, _, body = await _http(node["main"], None, "GET", "/api/net/status", headers={"Cookie": f"{COOKIE_NAME}={token}"})
    pending = json.loads(body)["pending"]
    assert [p["sas"] for p in pending] == [req["sas"]] and pending[0]["name"] == name
    waiting = asyncio.create_task(_http(net.port, ctx, "POST", "/api/net/pair/result", host=host,
                                        body={"request": req["request"]}))
    await asyncio.sleep(0.2)
    st, _, body = await _http(node["main"], None, "POST", f"/api/net/requests/{req['request']}", body={"allow": True},
                              headers={"Cookie": f"{COOKIE_NAME}={token}"})
    assert st == 200, body
    st, _, body = await waiting
    res = json.loads(body)
    assert st == 200 and res["state"] == "approved" and res["node"] == net.identity.id
    return {"key": key, "cert": res["cert"], "device": res["device"], "host": host,
            "ctx": _client_ctx(net, key, res["cert"], tmp_path)}


async def test_a_phone_pairs_and_is_signed_in_by_its_key(node, tmp_path) -> None:
    net: NetService = node["net"]
    dev = await _pair(node, tmp_path)
    st, hdrs, body = await _http(net.port, dev["ctx"], "GET", "/api/whoami", host=dev["host"])
    assert st == 200, body
    assert json.loads(body)["client"] not in ("127.0.0.1", "::1")  # (never looks like this machine itself)
    # its WebSocket too: the gate sees the session the ingress put on it
    async with websockets.connect(f"wss://{dev['host']}/ws/echo", host="127.0.0.1", port=net.port, ssl=dev["ctx"],
                                  server_hostname=dev["host"]) as ws:
        assert await ws.recv() not in ("127.0.0.1", "")
    # the session cookie never goes to the phone; others do
    st, hdrs, _ = await _http(net.port, dev["ctx"], "GET", "/api/cookie", host=dev["host"])
    assert st == 200 and all(not c.startswith(COOKIE_NAME) for c in hdrs.get("set-cookie", []))
    assert any(c.startswith("lang=") for c in hdrs.get("set-cookie", []))
    rows = net.store.devices()
    assert [r["id"] for r in rows] == [dev["device"]] and rows[0]["last_via"] == "lan"


async def test_what_a_paired_phone_cannot_reach(node, tmp_path) -> None:
    net: NetService = node["net"]
    dev = await _pair(node, tmp_path)
    for method, path in (("GET", "/api/internal/thing"), ("POST", "/api/net/offer"), ("GET", "/api/local/x"),
                         ("POST", f"/api/net/requests/r_x"), ("DELETE", f"/api/net/devices/{dev['device']}"),
                         ("POST", "/api/net/pair/request")):
        st, _, _ = await _http(net.port, dev["ctx"], method, path, host=dev["host"], body={})
        assert st == 404, path
    st, _, body = await _http(net.port, dev["ctx"], "GET", "/api/net/status", host=dev["host"])
    assert st == 200 and json.loads(body) == {"mode": "local", "here": {"device": dev["device"], "via": "lan"},
                                              "name": "Desk"}
    # a forged forwarding header is dropped: it can't pretend to be loopback
    st, _, body = await _http(net.port, dev["ctx"], "GET", "/api/whoami", host=dev["host"],
                              headers={"X-Forwarded-For": "127.0.0.1"})
    assert st == 200, body
    assert json.loads(body)["client"] != "127.0.0.1"


async def test_without_a_certificate_only_pairing(node, tmp_path) -> None:
    net: NetService = node["net"]
    await net.start()
    ctx = _client_ctx(net)
    host = f"{net.identity.id}.geny.net"
    # nothing being paired: a connection without a certificate isn't answered at all
    st, _, _ = await _http(net.port, ctx, "GET", "/health", host=host)
    assert st == 0
    await net.new_offer()
    for path in ("/api/whoami", "/api/net/status", "/api/internal/thing"):
        st, _, _ = await _http(net.port, ctx, "GET", path, host=host)
        assert st == 404, path
    # a made-up proof, or no live code
    key = ec.generate_private_key(ec.SECP256R1())
    st, _, body = await _http(net.port, ctx, "POST", "/api/net/pair/request", host=host,
                              body={"pub": b64u(spki(key.public_key())), "proof": b64u(b"x" * 32)})
    assert st == 410 and json.loads(body)["code"] == "expired"


async def test_a_code_pairs_one_device_only(node, tmp_path) -> None:
    net: NetService = node["net"]
    offer = await net.new_offer()
    secret = unb64u(_offer_parts(offer["uri"])["k"])
    ctx = _client_ctx(net)
    host = f"{net.identity.id}.geny.net"
    codes = []
    for _ in range(2):
        pub = spki(ec.generate_private_key(ec.SECP256R1()).public_key())
        st, _, _ = await _http(net.port, ctx, "POST", "/api/net/pair/request", host=host,
                               body={"pub": b64u(pub), "proof": b64u(proof_of(secret, net.identity.id, pub))})
        codes.append(st)
    assert codes == [200, 410]


async def test_pairing_is_spoken_only_over_geny_net(node) -> None:
    st, _, _ = await _http(node["main"], None, "POST", "/api/net/pair/request", body={})
    assert st == 404


async def test_the_ingress_refuses_connections_the_node_did_not_open(node) -> None:
    token = node["app"].state.auth.issue_token(node["app"].state.auth.username)
    st, _, _ = await _http(node["ingress"], None, "GET", "/api/whoami", headers={"Cookie": f"{COOKIE_NAME}={token}"})
    assert st == 403


async def test_a_removed_phone_is_cut_off_at_once(node, tmp_path) -> None:
    net: NetService = node["net"]
    dev = await _pair(node, tmp_path)
    r, w = await asyncio.open_connection("127.0.0.1", net.port, ssl=dev["ctx"], server_hostname=dev["host"])
    st, _, _ = await _exchange(r, w, "GET", "/api/whoami")
    assert st == 200
    # a connection held open (keep-alive) ends when the device is removed
    r, w = await asyncio.open_connection("127.0.0.1", net.port, ssl=dev["ctx"], server_hostname=dev["host"])
    w.write(b"GET /api/whoami HTTP/1.1\r\nHost: x\r\n\r\n")
    await w.drain()
    first = await asyncio.wait_for(r.read(65536), 10)
    assert b" 200 " in first
    token = node["app"].state.auth.issue_token(node["app"].state.auth.username)
    st, _, _ = await _http(node["main"], None, "DELETE", f"/api/net/devices/{dev['device']}",
                           headers={"Cookie": f"{COOKIE_NAME}={token}"})
    assert st == 200
    rest = await asyncio.wait_for(r.read(65536), 10)
    assert rest == b""
    w.close()
    assert not net._started  # (no device left: nothing listens)


# -- through a relay ----------------------------------------------------------------------------------------------

class TlsOverWs:
    """the phone's side of a relayed connection: TLS to the node, its records in WebSocket messages"""

    def __init__(self, ws, ctx: ssl.SSLContext, host: str) -> None:
        self.ws = ws
        self.inc, self.out = ssl.MemoryBIO(), ssl.MemoryBIO()
        self.tls = ctx.wrap_bio(self.inc, self.out, server_hostname=host)

    async def _flush(self) -> None:
        data = self.out.read()
        if data:
            await self.ws.send(data)

    async def _fill(self) -> bool:
        try:
            self.inc.write(await asyncio.wait_for(self.ws.recv(), 20))
            return True
        except websockets.ConnectionClosed:
            self.inc.write_eof()
            return False

    async def handshake(self) -> None:
        while True:
            try:
                self.tls.do_handshake()
                break
            except ssl.SSLWantReadError:
                await self._flush()
                await self._fill()
        await self._flush()

    async def request(self, raw: bytes) -> bytes:
        self.tls.write(raw)
        await self._flush()
        got = b""
        while True:
            try:
                chunk = self.tls.read(65536)
                if not chunk:
                    break
                got += chunk
            except ssl.SSLWantReadError:
                await self._flush()
                if not await self._fill():
                    break
            except (ssl.SSLZeroReturnError, ssl.SSLEOFError):
                break
        return got


async def test_a_phone_away_from_home_comes_through_the_relay(node, tmp_path) -> None:
    net: NetService = node["net"]
    relay_url = f"http://127.0.0.1:{node['main']}"  # (this same app is the relay too)
    dev = await _pair(node, tmp_path)
    await net.apply_settings({"relay": True, "relay_url": relay_url, "lan": False})
    for _ in range(100):
        if net.relay is not None and net.relay.state == "online":
            break
        await asyncio.sleep(0.05)
    assert net.relay.state == "online"
    st, _, body = await _http(node["main"], None, "GET", f"/net/relay/where?n={net.identity.id}")
    assert json.loads(body) == {"online": True, "lan": [], "port": 0, "wan": ""}  # (same-network connections off)

    async with websockets.connect(f"ws://127.0.0.1:{node['main']}/net/relay/connect?n={net.identity.id}") as ws:
        t = TlsOverWs(ws, dev["ctx"], dev["host"])
        await t.handshake()
        got = await t.request(b"GET /api/whoami HTTP/1.1\r\nHost: 127.0.0.1:41234\r\nConnection: close\r\n\r\n")
    assert b" 200 " in got.split(b"\r\n")[0]
    assert json.loads(got.partition(b"\r\n\r\n")[2])["client"] == "100.64.0.1"
    assert net.store.device(dev["device"])["last_via"] == "relay"


async def test_the_relay_hands_a_node_id_only_to_its_key(node, tmp_path) -> None:
    other = Identity(tmp_path / "other")
    async with websockets.connect(f"ws://127.0.0.1:{node['main']}/net/relay/host?n={node['net'].identity.id}") as ws:
        challenge = json.loads(await ws.recv())["challenge"]
        await ws.send(json.dumps({"pub": other.ca_spki, "sig": other.sign(("geny-net-host|" + challenge).encode())}))
        assert json.loads(await ws.recv())["ok"] is False
    # an offline node: the device is told so
    with pytest.raises(websockets.ConnectionClosed) as e:
        async with websockets.connect(f"ws://127.0.0.1:{node['main']}/net/relay/connect?n=nobody") as ws:
            await ws.recv()
    assert e.value.rcvd is not None and e.value.rcvd.code == 4404


# -- server execution: a sign-in QR code ----------------------------------------------------------------------------

async def test_a_server_sign_in_code(node, monkeypatch) -> None:
    monkeypatch.setattr(settings, "execution_mode", "server")
    auth = node["app"].state.auth
    token = auth.issue_token(auth.username)
    st, _, body = await _http(node["main"], None, "POST", "/api/net/login-code",
                              body={"origin": "https://geny.example.com"}, headers={"Cookie": f"{COOKIE_NAME}={token}"})
    assert st == 200, body
    out = json.loads(body)
    u = urlsplit(out["uri"])
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    assert u.scheme == "geny" and u.netloc == "login" and q["u"] == "https://geny.example.com"
    assert auth.consume_exchange_code(q["c"]) is not None  # (one time)
    assert auth.consume_exchange_code(q["c"]) is None
    st, _, _ = await _http(node["main"], None, "POST", "/api/net/login-code", body={"origin": "javascript:x"},
                           headers={"Cookie": f"{COOKIE_NAME}={token}"})
    assert st == 400
    st, _, _ = await _http(node["main"], None, "POST", "/api/net/login-code", body={"origin": "https://x"})
    assert st == 401  # (signed in only)
