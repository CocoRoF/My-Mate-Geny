"""Geny Net's way in from the internet without any server (docs/geny-net.md "From the internet, directly"): the desktop
asks its own router to forward a port to its TLS listener — UPnP IGD (most home routers: ipTIME, ASUS, Netgear …), or
NAT-PMP (RFC 6886) where that's what the router speaks — and learns the router's public address. A paired phone away
from home then connects straight to it; the relay is only for when this can't work (no UPnP, or the router isn't on
a public address: a second router in front, an ISP's carrier-grade NAT).

No library: SSDP discovery (UDP multicast), the device description (XML over HTTP) and the SOAP calls the IGD spec
names (``AddPortMapping`` / ``GetExternalIPAddress`` / ``DeletePortMapping``); NAT-PMP is two small UDP packets. Only
private addresses are ever contacted (a reply on the LAN can't point us anywhere else).
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
import random
import re
import socket
import struct
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urljoin, urlsplit

import httpx

log = logging.getLogger("app.net.portmap")

SSDP = ("239.255.255.250", 1900)
SEARCH_TARGETS = (
    "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
    "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
    "urn:schemas-upnp-org:service:WANIPConnection:2",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
)
WAN_SERVICES = ("WANIPConnection", "WANPPPConnection")
NATPMP_PORT = 5351
LEASE_S = 3600
DESCRIPTION = "My Mate Geny (Geny Net)"


class PortMapError(Exception):
    pass


def private(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private and not ip.is_loopback


def public(host: str) -> bool:
    """an address the internet can reach (not private, not the ISPs' shared 100.64/10, not reserved)"""
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return False


def local_ip_toward(host: str) -> str:
    """this machine's address on the interface that reaches `host` (no packet is sent)"""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect((host, 9))
        return s.getsockname()[0]


@dataclass
class Mapping:
    method: str            # "upnp" | "natpmp"
    external_ip: str
    external_port: int
    internal_port: int
    lease: int             # seconds (0: until removed)
    # how to remove it
    control_url: str = ""
    service: str = ""
    gateway: str = ""


# -- UPnP IGD ----------------------------------------------------------------------------------------------------------

async def ssdp_search(timeout: float = 2.5, target: tuple[str, int] = SSDP) -> list[str]:
    """the description URLs of the gateways that answered (LOCATION), on private addresses only"""
    loop = asyncio.get_running_loop()
    found: list[str] = []
    done = loop.create_future()

    class Proto(asyncio.DatagramProtocol):
        def datagram_received(self, data: bytes, addr) -> None:  # noqa: ANN001
            m = re.search(rb"(?im)^location:\s*(\S+)", data)
            if not m:
                return
            url = m.group(1).decode("latin-1")
            host = urlsplit(url).hostname or ""
            if private(host) and url not in found:
                found.append(url)

    transport, _ = await loop.create_datagram_endpoint(Proto, local_addr=("0.0.0.0", 0), family=socket.AF_INET)
    try:
        for st in SEARCH_TARGETS:
            msg = (f"M-SEARCH * HTTP/1.1\r\nHOST: {SSDP[0]}:{SSDP[1]}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n")
            transport.sendto(msg.encode(), target)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(done, timeout)
    finally:
        transport.close()
    return found


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


async def wan_service(client: httpx.AsyncClient, location: str) -> tuple[str, str] | None:
    """(control URL, service type) of the gateway's WAN connection service, from its device description"""
    r = await client.get(location)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    base = location
    for el in root.iter():
        if _local(el.tag) == "URLBase" and (el.text or "").strip():
            base = el.text.strip()
    for svc in root.iter():
        if _local(svc.tag) != "service":
            continue
        fields = {_local(c.tag): (c.text or "").strip() for c in svc}
        stype = fields.get("serviceType", "")
        if any(f":{w}:" in stype for w in WAN_SERVICES) and fields.get("controlURL"):
            url = urljoin(base, fields["controlURL"])
            if private(urlsplit(url).hostname or ""):
                return url, stype
    return None


async def soap(client: httpx.AsyncClient, control_url: str, service: str, action: str, args: dict[str, str | int]
               ) -> dict[str, str]:
    body = "".join(f"<{k}>{v}</{k}>" for k, v in args.items())
    envelope = (
        '<?xml version="1.0"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
        f'<u:{action} xmlns:u="{service}">{body}</u:{action}></s:Body></s:Envelope>'
    )
    r = await client.post(control_url, content=envelope.encode(), headers={
        "Content-Type": 'text/xml; charset="utf-8"', "SOAPAction": f'"{service}#{action}"'})
    out: dict[str, str] = {}
    try:
        root = ET.fromstring(r.content)
        for el in root.iter():
            out[_local(el.tag)] = (el.text or "").strip()
    except ET.ParseError:
        pass
    if r.status_code != 200:
        raise PortMapError(f"{action}: {out.get('errorCode', r.status_code)} {out.get('errorDescription', '')}".strip())
    return out


async def upnp_map(internal_port: int, *, want_port: int = 0, timeout: float = 4.0,
                   ssdp_target: tuple[str, int] = SSDP) -> Mapping:
    locations = await ssdp_search(target=ssdp_target)
    if not locations:
        raise PortMapError("no UPnP gateway answered")
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
        errors: list[str] = []
        for loc in locations:
            try:
                svc = await wan_service(client, loc)
                if svc is None:
                    continue
                control, stype = svc
                gateway = urlsplit(control).hostname or ""
                me = local_ip_toward(gateway)
                ext_ip = (await soap(client, control, stype, "GetExternalIPAddress", {})).get("NewExternalIPAddress", "")
                ports = [want_port or internal_port] + [random.randint(20000, 60000) for _ in range(4)]
                for port in ports:
                    for lease in (LEASE_S, 0):
                        try:
                            await soap(client, control, stype, "AddPortMapping", {
                                "NewRemoteHost": "", "NewExternalPort": port, "NewProtocol": "TCP",
                                "NewInternalPort": internal_port, "NewInternalClient": me, "NewEnabled": 1,
                                "NewPortMappingDescription": DESCRIPTION, "NewLeaseDuration": lease})
                            return Mapping("upnp", ext_ip, port, internal_port, lease, control, stype, gateway)
                        except PortMapError as e:
                            msg = str(e)
                            if " 725 " in f" {msg} " or "OnlyPermanentLeases" in msg:
                                continue  # (this router only keeps mappings until removed: lease 0)
                            if " 718 " in f" {msg} " or "Conflict" in msg:
                                break  # (that external port is someone else's: another)
                            raise
                errors.append("every port tried was taken")
            except (httpx.HTTPError, ET.ParseError, PortMapError, OSError) as e:
                errors.append(f"{type(e).__name__}: {e}")
        raise PortMapError("; ".join(errors) or "no WAN connection service")


async def upnp_unmap(m: Mapping, timeout: float = 3.0) -> None:
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        await soap(client, m.control_url, m.service, "DeletePortMapping",
                   {"NewRemoteHost": "", "NewExternalPort": m.external_port, "NewProtocol": "TCP"})


# -- NAT-PMP (RFC 6886) ------------------------------------------------------------------------------------------------

async def _natpmp(gateway: str, packet: bytes, port: int = NATPMP_PORT, timeout: float = 1.0) -> bytes:
    loop = asyncio.get_running_loop()
    fut = loop.create_future()

    class Proto(asyncio.DatagramProtocol):
        def datagram_received(self, data: bytes, addr) -> None:  # noqa: ANN001
            if addr[0] == gateway and not fut.done():
                fut.set_result(data)

    transport, _ = await loop.create_datagram_endpoint(Proto, remote_addr=(gateway, port), family=socket.AF_INET)
    try:
        for attempt in range(2):
            transport.sendto(packet)
            try:
                return await asyncio.wait_for(asyncio.shield(fut), timeout * (attempt + 1))
            except asyncio.TimeoutError:
                continue
        raise PortMapError(f"no NAT-PMP answer from {gateway}")
    finally:
        transport.close()


def gateway_guesses(lan: list[str]) -> list[str]:
    """the usual router addresses next to this machine's (a.b.c.1 / .254)"""
    out: list[str] = []
    for a in lan:
        parts = a.split(".")
        if len(parts) == 4:
            for last in ("1", "254"):
                g = ".".join(parts[:3] + [last])
                if g != a and g not in out:
                    out.append(g)
    return out


async def natpmp_map(internal_port: int, gateways: list[str], *, want_port: int = 0, natpmp_port: int = NATPMP_PORT
                     ) -> Mapping:
    errors: list[str] = []
    for gw in gateways:
        try:
            r = await _natpmp(gw, struct.pack("!BB", 0, 0), natpmp_port)
            if len(r) < 12 or r[1] != 128 or struct.unpack("!H", r[2:4])[0] != 0:
                raise PortMapError("refused the address request")
            ext_ip = socket.inet_ntoa(r[8:12])
            r = await _natpmp(gw, struct.pack("!BBHHHI", 0, 2, 0, internal_port, want_port or internal_port, LEASE_S),
                              natpmp_port)
            if len(r) < 16 or r[1] != 130:
                raise PortMapError("a broken answer")
            result, _, _priv, ext_port, lease = struct.unpack("!HIHHI", r[2:16])
            if result != 0:
                raise PortMapError(f"refused (result {result})")
            return Mapping("natpmp", ext_ip, ext_port, internal_port, lease, gateway=gw)
        except (PortMapError, OSError) as e:
            errors.append(f"{gw}: {e}")
    raise PortMapError("; ".join(errors) or "no gateway to ask")


async def natpmp_unmap(m: Mapping, natpmp_port: int = NATPMP_PORT) -> None:
    await _natpmp(m.gateway, struct.pack("!BBHHHI", 0, 2, 0, m.internal_port, 0, 0), natpmp_port)


# -- the node's side ---------------------------------------------------------------------------------------------------

class PortMapper:
    """Keeps a port forwarded to the listener while Geny Net is on: maps, renews before the lease ends, tries again
    every few minutes when it can't, removes the mapping when stopped."""

    RETRY_S = 300

    def __init__(self, internal_port: int, lan: Callable[[], list[str]], on_change: Callable[[], None],
                 *, ssdp_target: tuple[str, int] = SSDP, natpmp_port: int = NATPMP_PORT) -> None:
        self.internal_port = internal_port
        self.lan = lan
        self.on_change = on_change
        self.ssdp_target = ssdp_target
        self.natpmp_port = natpmp_port
        self.mapping: Mapping | None = None
        self.state = "trying"      # trying | open | unavailable
        self.error = ""
        self._task: asyncio.Task | None = None
        self._want = 0

    @property
    def endpoint(self) -> str:
        """``ip:port`` the internet reaches this node at, or "" """
        m = self.mapping
        return f"{m.external_ip}:{m.external_port}" if m and self.state == "open" else ""

    def start(self, want_port: int = 0) -> None:
        self._want = want_port
        self._task = asyncio.create_task(self._run())

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(BaseException):
                await self._task
        m, self.mapping = self.mapping, None
        if m is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(upnp_unmap(m) if m.method == "upnp" else natpmp_unmap(m, self.natpmp_port), 3)
                log.info("removed the port mapping %s:%d", m.external_ip, m.external_port)

    async def once(self) -> Mapping:
        errors: list[str] = []
        try:
            return await upnp_map(self.internal_port, want_port=self._want, ssdp_target=self.ssdp_target)
        except (PortMapError, OSError) as e:
            errors.append(f"UPnP: {e}")
        try:
            return await natpmp_map(self.internal_port, gateway_guesses(self.lan()), want_port=self._want,
                                    natpmp_port=self.natpmp_port)
        except (PortMapError, OSError) as e:
            errors.append(f"NAT-PMP: {e}")
        raise PortMapError(" · ".join(errors))

    async def _run(self) -> None:
        while True:
            try:
                m = await self.once()
                self.mapping, self._want = m, m.external_port  # (the same port again at renewal)
                if public(m.external_ip):
                    self.state, self.error = "open", ""
                else:
                    # (the router itself is behind another NAT: a second router, or the ISP's) — nothing to reach
                    self.state, self.error = "unavailable", f"the router's own address is not public ({m.external_ip})"
                log.info("port mapping (%s): %s:%d → %d, lease %ds", m.method, m.external_ip, m.external_port,
                         m.internal_port, m.lease)
                self.on_change()
                await asyncio.sleep(max(60, m.lease // 2) if m.lease else 1800)  # (renew; re-check a lease-0 one)
                continue
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - no gateway / refused: try later, the relay covers meanwhile
                self.state, self.error = "unavailable", str(e)[:300]
                log.info("no port mapping: %s", self.error)
                self.on_change()
            await asyncio.sleep(self.RETRY_S)
