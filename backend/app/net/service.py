"""Geny Net on a node (docs/geny-net.md): the desktop's local backend reachable from the user's own paired devices —
on the same network directly, from anywhere through a relay — and from nothing else.

* **The listener** — TLS (1.3; 1.2 for older phones), on the LAN (``0.0.0.0``, its port kept across starts): it shows the node's server
  certificate (devices pin the node's CA by the fingerprint in the QR code) and asks for a client certificate — one
  this node issued to a paired device that isn't revoked. A connection without one may only pair (``scope`` "pair").
* **The ingress** — the backend's second, loopback-only socket (local_main.py): each TLS connection is piped into it,
  and the connection's local port is recorded first (``self.peers``), so the ASGI layer (app/net/ingress.py) knows
  which device a request came from — and refuses any connection to the ingress it didn't make.
* **The relay** (app/net/relay.py) — the node keeps a WebSocket open to it (outbound only: nothing to open on the
  router) and proves its id with its CA key; a device away from home connects to the relay, the relay asks the node
  to accept, and the node pipes that WebSocket into its own listener: the TLS runs end to end, the relay forwards
  bytes it can't read.
* **Pairing** — an offer (a one-time secret, 5 minutes, in the QR code with the CA fingerprint and how to reach the
  node); the device proves it has the secret over the pinned TLS channel and sends its public key; both screens show
  the same six digits; the user allows it on the desktop; the node issues the device its certificate.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import ssl
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlencode

from cryptography import x509

from .identity import Identity, fingerprint, unb64u

log = logging.getLogger("app.net")

OFFER_TTL_S = 300          # a QR code's life
REQUEST_TTL_S = 180        # a pairing request waiting for the user
MAX_OFFERS = 3
MAX_PENDING = 5
MAX_DEVICES = 32
MAX_PAIRING_CONNECTIONS = 8  # (at once, without a certificate: someone on the network can't hold the listener)
PAIR_PATHS = ("/api/net/pair/request", "/api/net/pair/result")
DEFAULT_RELAY = "https://agent.hrletsgo.me"  # (the project's own relay: Settings → 디바이스 인증 changes it)


def sas_of(secret: bytes, device_spki: bytes) -> str:
    """the six digits both screens show: from the offer's secret and the device's key (a swapped key shows others)"""
    d = hmac.new(secret, b"geny-net-sas|" + device_spki, hashlib.sha256).digest()
    return f"{int.from_bytes(d[:4], 'big') % 1_000_000:06d}"


def proof_of(secret: bytes, node_id: str, device_spki: bytes) -> bytes:
    """what the device sends to show it read the QR code: binds the secret to its key and to this node"""
    return hmac.new(secret, b"geny-net-pair|" + node_id.encode() + b"|" + device_spki, hashlib.sha256).digest()


# (interfaces a phone can't be on: containers' and VMs' bridges, VPN tunnels)
_VIRTUAL_IF = ("docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "cni", "flannel", "cali", "tailscale", "zt",
               "tun", "tap", "wg", "utun", "lo", "bridge", "awdl", "llw")
_VIRTUAL_IN = ("VirtualBox", "VMware", "Default Switch", "WSL")  # (Windows names; an external Hyper-V switch stays)


def lan_addresses() -> list[str]:
    """this machine's private IPv4 addresses (the ones a phone on the same network may reach)"""
    out: list[str] = []
    try:
        import psutil

        stats = psutil.net_if_stats()
        for name, addrs in psutil.net_if_addrs().items():
            if name.startswith(_VIRTUAL_IF) or any(v in name for v in _VIRTUAL_IN):
                continue
            if name in stats and not stats[name].isup:
                continue
            for a in addrs:
                if getattr(a, "family", None) is not None and a.family.name == "AF_INET":
                    ip = ipaddress.ip_address(a.address)
                    if ip.is_private and not ip.is_loopback and not ip.is_link_local:
                        out.append(a.address)
    except Exception:  # noqa: BLE001 - no addresses: the relay still works
        pass
    # (home networks first: a 192.168 / 10 address before a container bridge)
    rank = lambda s: (0 if s.startswith("192.168.") else 1 if s.startswith("10.") else 2)  # noqa: E731
    return sorted(dict.fromkeys(out), key=rank)[:6]


@dataclass
class Offer:
    id: str
    secret: bytes
    expires: float
    used: bool = False


@dataclass
class Request:
    id: str
    name: str
    platform: str
    spki: bytes
    sas: str
    created: float
    state: str = "pending"            # pending | approved | denied | expired
    device_id: str = ""
    cert_pem: str = ""
    done: asyncio.Event = field(default_factory=asyncio.Event)


class NetStore:
    def __init__(self, db) -> None:
        self.db = db
        db.execute("CREATE TABLE IF NOT EXISTS net_devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL "
                   "DEFAULT '', fingerprint TEXT NOT NULL, created_at REAL NOT NULL, last_seen REAL, last_via TEXT, "
                   "revoked_at REAL)")
        db.execute("CREATE TABLE IF NOT EXISTS net_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    def devices(self, include_revoked: bool = False) -> list[dict[str, Any]]:
        q = "SELECT * FROM net_devices" + ("" if include_revoked else " WHERE revoked_at IS NULL") + " ORDER BY created_at DESC"
        return [dict(r) for r in self.db.query(q)]

    def device(self, device_id: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM net_devices WHERE id=?", (device_id,))
        return dict(r) if r else None

    def add(self, device_id: str, name: str, platform: str, fp: str) -> None:
        self.db.execute("INSERT INTO net_devices(id, name, platform, fingerprint, created_at) VALUES(?,?,?,?,?)",
                        (device_id, name, platform, fp, time.time()))

    def seen(self, device_id: str, via: str) -> None:
        self.db.execute("UPDATE net_devices SET last_seen=?, last_via=? WHERE id=?", (time.time(), via, device_id))

    def revoke(self, device_id: str) -> bool:
        if not self.device(device_id):
            return False
        self.db.execute("UPDATE net_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (time.time(), device_id))
        return True

    def rename(self, device_id: str, name: str) -> None:
        self.db.execute("UPDATE net_devices SET name=? WHERE id=?", (name[:60], device_id))

    def setting(self, key: str, default: Any = None) -> Any:
        r = self.db.query_one("SELECT value FROM net_settings WHERE key=?", (key,))
        return json.loads(r["value"]) if r else default

    def put_setting(self, key: str, value: Any) -> None:
        self.db.execute("INSERT INTO net_settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (key, json.dumps(value)))


@dataclass
class Peer:
    scope: str                        # "device" | "pair"
    device_id: str = ""
    via: str = ""                     # "lan" | "relay"
    addr: str = ""                    # the device's address on the LAN (a relayed one has none here)


class NetService:
    """A node's Geny Net: started by the desktop's local backend (app/main.py) once there is something to serve."""

    def __init__(self, db, home: Path, ingress_port: int, *, name: str = "", on_change: Callable[[], None] | None = None
                 ) -> None:
        self.store = NetStore(db)
        self.home = Path(home)
        self.ingress_port = int(ingress_port)
        self.name = name or _machine_name()
        self.on_change = on_change or (lambda: None)
        self._identity: Identity | None = None
        self.offers: dict[str, Offer] = {}
        self.requests: dict[str, Request] = {}
        # the ingress's view: (host, port) of each connection this node opened to it → whose it is
        self.peers: dict[tuple[str, int], Peer] = {}
        self._conns: dict[str, set[asyncio.Task]] = {}   # device id → its live pipes (closed when it's revoked)
        self._pairing = 0
        self._server: asyncio.base_events.Server | None = None
        self.port = 0
        self.relay = None                 # RelayLink (relay_client.py), while the relay is on
        self._started = False

    # -- the identity, made only when Geny Net is first used ---------------------------------------------------------
    @property
    def identity(self) -> Identity:
        if self._identity is None:
            self._identity = Identity(self.home / "net", self.name)
        return self._identity

    @property
    def relay_url(self) -> str:
        return str(self.store.setting("relay_url", DEFAULT_RELAY) or "")

    @property
    def relay_on(self) -> bool:
        return bool(self.store.setting("relay", True)) and bool(self.relay_url)

    @property
    def lan_on(self) -> bool:
        return bool(self.store.setting("lan", True))

    # -- lifecycle ---------------------------------------------------------------------------------------------------
    async def start_if_used(self) -> None:
        """at the backend's start: on if any device is paired (nothing listens on a machine that never paired one)"""
        if self.store.devices():
            await self.start()

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        await self._listen()
        if self.relay_on:
            await self._relay_up()
        self.on_change()

    async def stop(self) -> None:
        self._started = False
        if self.relay is not None:
            await self.relay.close()
            self.relay = None
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._server.wait_closed(), 2)
            self._server = None
        for tasks in list(self._conns.values()):
            for t in tasks:
                t.cancel()
        self._conns.clear()

    async def apply_settings(self, patch: dict[str, Any]) -> None:
        if "relay" in patch:
            self.store.put_setting("relay", bool(patch["relay"]))
        if "relay_url" in patch:
            url = str(patch["relay_url"] or "").strip().rstrip("/")
            if url and not url.startswith(("https://", "http://")):
                raise ValueError("The relay is an http(s) address")
            self.store.put_setting("relay_url", url or DEFAULT_RELAY)
        if "lan" in patch:
            self.store.put_setting("lan", bool(patch["lan"]))
        if self._started:  # (applied now)
            await self.stop()
            await self.start()
        self.on_change()

    def _tls_context(self) -> ssl.SSLContext:
        chain, key, ca = self.identity.server_files()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        # TLS 1.3 (Android 10+); 1.2 for older phones, forward-secret AEAD suites only
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.set_ciphers("ECDHE+AESGCM:ECDHE+CHACHA20")
        ctx.load_cert_chain(certfile=str(chain), keyfile=str(key))
        ctx.verify_mode = ssl.CERT_OPTIONAL  # (no certificate: it may only pair)
        ctx.load_verify_locations(cafile=str(ca))
        return ctx

    async def _listen(self) -> None:
        """the TLS listener: the LAN (0.0.0.0) when same-network connections are on, else loopback (the relay's way in)"""
        host = "0.0.0.0" if self.lan_on else "127.0.0.1"
        want = int(self.store.setting("port", 0) or 0)
        ctx = self._tls_context()
        for port in ([want] if want else []) + [0]:
            try:
                self._server = await asyncio.start_server(self._accept, host, port, ssl=ctx,
                                                          ssl_handshake_timeout=15)
                break
            except OSError:
                continue
        assert self._server is not None
        self.port = self._server.sockets[0].getsockname()[1]
        self.store.put_setting("port", self.port)
        log.info("Geny Net listening on %s:%d (node %s)", host, self.port, self.identity.id)

    async def _relay_up(self) -> None:
        from .relay_client import RelayLink

        self.relay = RelayLink(self, self.relay_url)
        self.relay.start()

    # -- a connection -----------------------------------------------------------------------------------------------
    async def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = self._who(writer)
        if peer is None or (peer.scope == "pair" and self._pairing >= MAX_PAIRING_CONNECTIONS):
            writer.close()
            return
        task = asyncio.current_task()
        if peer.device_id and task is not None:
            self._conns.setdefault(peer.device_id, set()).add(task)
            self.store.seen(peer.device_id, peer.via)
        if peer.scope == "pair":
            self._pairing += 1
        try:
            await self._pipe_to_ingress(reader, writer, peer)
        finally:
            if peer.device_id and task is not None:
                self._conns.get(peer.device_id, set()).discard(task)
            if peer.scope == "pair":
                self._pairing -= 1

    def _who(self, writer: asyncio.StreamWriter) -> Peer | None:
        sslobj = writer.get_extra_info("ssl_object")
        sock_peer = writer.get_extra_info("peername") or ("", 0)
        # (a relayed connection comes in through loopback, from this process: relay_client.py marks its ports)
        via = "relay" if self.relay is not None and self.relay.is_ours(tuple(sock_peer[:2])) else "lan"
        addr = str(sock_peer[0]) if via == "lan" and not _loopback(str(sock_peer[0])) else ""
        der = sslobj.getpeercert(binary_form=True) if sslobj is not None else None
        if not der:
            return Peer("pair", via=via, addr=addr)
        try:
            cert = x509.load_der_x509_certificate(der)
            device_id = cert.subject.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)[0].value
        except Exception:  # noqa: BLE001
            return None
        row = self.store.device(str(device_id))
        if row is None or row["revoked_at"] is not None or not hmac.compare_digest(row["fingerprint"], fingerprint(cert)):
            return None
        return Peer("device", device_id=str(device_id), via=via, addr=addr)

    async def _pipe_to_ingress(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, peer: Peer) -> None:
        try:
            ir, iw = await asyncio.open_connection("127.0.0.1", self.ingress_port)
        except OSError:
            writer.close()
            return
        key = tuple(iw.get_extra_info("sockname")[:2])
        self.peers[key] = peer  # (before a byte goes in: the ingress looks it up on the first request)
        try:
            await _splice(reader, writer, ir, iw)
        finally:
            # (only if it's still this one's: loopback reuses a closed connection's port at once — tcp_tw_reuse)
            if self.peers.get(key) is peer:
                del self.peers[key]

    def peer_of(self, client: tuple[str, int] | None) -> Peer | None:
        return self.peers.get(tuple(client)) if client else None  # type: ignore[arg-type]

    # -- pairing ----------------------------------------------------------------------------------------------------
    async def new_offer(self) -> dict[str, Any]:
        await self.start()
        now = time.time()
        for k, o in list(self.offers.items()):
            if o.expires <= now or o.used:
                del self.offers[k]
        while len(self.offers) >= MAX_OFFERS:
            del self.offers[next(iter(self.offers))]
        o = Offer("o_" + secrets.token_hex(6), secrets.token_bytes(32), now + OFFER_TTL_S)
        self.offers[o.id] = o
        ident = self.identity
        params = {"v": "1", "n": ident.id, "f": ident.ca_fingerprint, "k": _b64u(o.secret), "d": self.name}
        if self.lan_on and self.port:
            params["h"] = ",".join(lan_addresses())
            params["p"] = str(self.port)
        if self.relay_on:
            params["r"] = self.relay_url
        return {"id": o.id, "expires": o.expires, "uri": "geny://link?" + urlencode(params, quote_via=quote)}

    def pair_request(self, body: dict[str, Any]) -> dict[str, Any]:
        """the device's half (over the pinned TLS, scope "pair"): {pub, proof, name, platform} → {request, sas}"""
        try:
            spki = unb64u(str(body.get("pub") or ""))
            proof = unb64u(str(body.get("proof") or ""))
        except Exception as e:  # noqa: BLE001
            raise PairError("bad request") from e
        if not spki or len(proof) != 32:
            raise PairError("bad request")
        now = time.time()
        offer = None
        for o in self.offers.values():  # (whichever live offer's secret made this proof)
            if not o.used and o.expires > now and hmac.compare_digest(proof_of(o.secret, self.identity.id, spki), proof):
                offer = o
                break
        if offer is None:
            raise PairError("this code has expired or was already used: show a new one", code="expired")
        if len([r for r in self.requests.values() if r.state == "pending"]) >= MAX_PENDING:
            raise PairError("too many waiting requests", code="busy")
        if len(self.store.devices()) >= MAX_DEVICES:
            raise PairError("too many paired devices: remove one first", code="full")
        offer.used = True  # (one device per code)
        name = " ".join(str(body.get("name") or "device").split())[:60] or "device"
        r = Request("r_" + secrets.token_hex(8), name, str(body.get("platform") or "")[:20], spki,
                    sas_of(offer.secret, spki), now)
        self.requests[r.id] = r
        self.on_change()
        return {"request": r.id, "sas": r.sas, "node": self.identity.id, "name": self.name}

    async def pair_result(self, request_id: str, wait: float = 25.0) -> dict[str, Any]:
        r = self.requests.get(request_id)
        if r is None:
            raise PairError("no such request", code="gone")
        self._expire()
        if r.state == "pending":
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(r.done.wait(), wait)
        out: dict[str, Any] = {"state": r.state}
        if r.state == "approved":
            out.update(device=r.device_id, cert=r.cert_pem, ca=self.identity.ca_pem, node=self.identity.id,
                       name=self.name)
            self.requests.pop(r.id, None)  # (handed over once)
        elif r.state in ("denied", "expired"):
            self.requests.pop(r.id, None)
        return out

    def pending(self) -> list[dict[str, Any]]:
        self._expire()
        return [{"id": r.id, "name": r.name, "platform": r.platform, "sas": r.sas, "created": r.created}
                for r in self.requests.values() if r.state == "pending"]

    def decide(self, request_id: str, allow: bool) -> dict[str, Any]:
        self._expire()
        r = self.requests.get(request_id)
        if r is None or r.state != "pending":
            raise PairError("no such request", code="gone")
        if allow:
            issued = self.identity.issue(r.spki, r.name)
            self.store.add(issued.device_id, r.name, r.platform, fingerprint(issued.cert))
            r.device_id, r.cert_pem, r.state = issued.device_id, issued.pem, "approved"
        else:
            r.state = "denied"
        r.done.set()
        self.on_change()
        return {"state": r.state, "device": r.device_id}

    def _expire(self) -> None:
        now = time.time()
        for r in self.requests.values():
            if r.state == "pending" and now - r.created > REQUEST_TTL_S:
                r.state = "expired"
                r.done.set()

    # -- devices ----------------------------------------------------------------------------------------------------
    async def revoke(self, device_id: str) -> bool:
        ok = self.store.revoke(device_id)
        for t in list(self._conns.pop(device_id, set())):
            t.cancel()  # (its open connections go now, not when they next speak)
        for k, p in list(self.peers.items()):
            if p.device_id == device_id:
                self.peers.pop(k, None)
        if self._started and not self.store.devices() and not self._live_offers():
            await self.stop()  # (no device left: nothing listens)
        self.on_change()
        return ok

    def rename(self, device_id: str, name: str) -> bool:
        name = " ".join(str(name or "").split())[:60]
        if not name or not self.store.device(device_id):
            return False
        self.store.rename(device_id, name)
        self.on_change()
        return True

    def _live_offers(self) -> bool:
        now = time.time()
        return any(not o.used and o.expires > now for o in self.offers.values())

    def cancel_offer(self, offer_id: str) -> None:
        self.offers.pop(offer_id, None)

    def status(self) -> dict[str, Any]:
        on = self._started
        ident = self._identity
        return {
            "on": on, "node": ident.id if ident else "", "name": self.name,
            "port": self.port, "lan": lan_addresses() if on and self.lan_on else [],
            "lan_on": self.lan_on, "relay_on": self.relay_on, "relay_url": self.relay_url,
            "relay": self.relay.state if self.relay is not None else "off",
            "devices": [{k: d[k] for k in ("id", "name", "platform", "created_at", "last_seen", "last_via")}
                        | {"online": bool(self._conns.get(d["id"]))} for d in self.store.devices()],
            "pending": self.pending(),
        }


class PairError(Exception):
    def __init__(self, message: str, code: str = "bad_request") -> None:
        super().__init__(message)
        self.code = code


def _b64u(b: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return True


def _machine_name() -> str:
    import platform

    return (platform.node() or "My Mate Geny")[:60]


async def _splice(r1: asyncio.StreamReader, w1: asyncio.StreamWriter, r2: asyncio.StreamReader,
                  w2: asyncio.StreamWriter) -> None:
    """bytes both ways until either side ends"""

    async def pump(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        try:
            while True:
                data = await r.read(65536)
                if not data:
                    break
                w.write(data)
                await w.drain()
        except (ConnectionError, asyncio.IncompleteReadError, ssl.SSLError, OSError):
            pass
        finally:
            with contextlib.suppress(Exception):
                if w.can_write_eof():
                    w.write_eof()

    a = asyncio.ensure_future(pump(r1, w2))
    b = asyncio.ensure_future(pump(r2, w1))
    try:
        # (one side ended: the other gets a moment to finish what it was sending, then both go — HTTP doesn't
        # half-close, and a TLS side can't be half-closed anyway)
        _done, rest = await asyncio.wait({a, b}, return_when=asyncio.FIRST_COMPLETED)
        if rest:
            await asyncio.wait(rest, timeout=1.0)
    finally:
        for t in (a, b):
            t.cancel()
        for w in (w1, w2):
            with contextlib.suppress(Exception):
                w.close()
