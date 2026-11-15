"""Reading a web page for a mate's memory (docs/mate-memory-graph.md "Reading"): fetched by the server, safely, and
turned into plain text she can quote exactly.

* **Only the public web.** http(s) only; the host's every address must be public (no loopback, private, link-local,
  multicast, reserved, CGNAT — the server's own admin API and the LAN stay out of reach); each redirect is checked
  again (at most 5); 8 MB at most, 25 s.
* **Polite.** A clear User-Agent; one request per host at a time with a pause between them; robots.txt is honoured for
  what she reads on her own initiative (a page the user hands her is read like their browser would).
* **Text.** HTML: the main content (``<article>`` / ``<main>`` when there is one), headings as ``#``, list items as
  ``-``, table rows as ``a | b``, scripts / styles / navigation / forms dropped; the title, the site name, a published
  date when the page states one (meta tags). Plain text and JSON as they are. PDFs and other binaries are refused.
"""

from __future__ import annotations

import asyncio
import html
import ipaddress
import json
import re
import socket
import time
import urllib.robotparser
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

USER_AGENT = "MyMateGeny/1.0 (+https://github.com/CocoRoF/My-Mate-Geny; a personal AI companion reading for its user)"
MAX_BYTES = 8 * 1024 * 1024
TIMEOUT = 25.0
MAX_REDIRECTS = 5
HOST_GAP = 1.0           # seconds between two requests to one host
MAX_TEXT = 400_000       # characters kept of one page


class ReadError(Exception):
    pass


@dataclass
class Page:
    url: str
    title: str
    text: str
    site: str = ""
    published: str | None = None
    links: list[tuple[str, str]] = field(default_factory=list)  # (text, absolute url), in order
    content_type: str = "text/html"


# ---- where it may go ----

def _public(ip: str) -> bool:
    a = ipaddress.ip_address(ip)
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    cgnat = isinstance(a, ipaddress.IPv4Address) and a in ipaddress.ip_network("100.64.0.0/10")
    return not (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved
                or a.is_unspecified or cgnat)


async def check_url(url: str) -> str:
    """The URL when it may be fetched (http/https, a public host on every address) → else ReadError."""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        raise ReadError("not a URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ReadError("only http(s) addresses can be read")
    if parts.username or parts.password:
        raise ReadError("addresses with a login in them are not read")
    host = parts.hostname
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80),
                                                              type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        raise ReadError(f"{host}: no such host") from None
    ips = {i[4][0] for i in infos}
    if not ips or not all(_public(ip) for ip in ips):
        raise ReadError(f"{host} is not on the public internet")
    return url.strip()


# ---- politeness ----

_last: dict[str, float] = {}
_locks: dict[str, asyncio.Lock] = {}
_robots: dict[str, tuple[float, urllib.robotparser.RobotFileParser | None]] = {}


async def _robots_allow(client, url: str) -> bool:
    parts = urlsplit(url)
    base = f"{parts.scheme}://{parts.netloc}"
    hit = _robots.get(base)
    if hit is None or time.monotonic() - hit[0] > 3600:
        rp: urllib.robotparser.RobotFileParser | None = urllib.robotparser.RobotFileParser()
        try:
            r = await client.get(base + "/robots.txt", timeout=10)
            if r.status_code == 200:
                rp.parse(r.text.splitlines())  # type: ignore[union-attr]
            else:
                rp = None  # (no robots.txt: everything allowed)
        except Exception:  # noqa: BLE001 - unreachable robots.txt: allowed
            rp = None
        _robots[base] = hit = (time.monotonic(), rp)
    return hit[1] is None or hit[1].can_fetch(USER_AGENT, url)


async def fetch(url: str, *, respect_robots: bool = False, transport=None) -> Page:
    """The page at ``url`` as text (see the module's rules) → Page, else ReadError."""
    import httpx

    url = await check_url(url)
    host = urlsplit(url).hostname or ""
    lock = _locks.setdefault(host, asyncio.Lock())
    async with lock:
        wait = HOST_GAP - (time.monotonic() - _last.get(host, 0.0))
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,"
                                                  "text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
                                                  "Accept-Language": "ko,en;q=0.8"},
                                         follow_redirects=False, timeout=TIMEOUT, transport=transport) as client:
                if respect_robots and not await _robots_allow(client, url):
                    raise ReadError("the site asks bots not to read this page (robots.txt)")
                current = url
                for _ in range(MAX_REDIRECTS + 1):
                    async with client.stream("GET", current) as r:
                        # (the address it actually connected to, again: a name that resolved to a public address for
                        #  the check and a private one for the connection — DNS rebinding — is dropped here)
                        stream = r.extensions.get("network_stream")
                        peer = stream.get_extra_info("server_addr") if stream is not None else None
                        if peer and not _public(str(peer[0])):
                            raise ReadError(f"{host} is not on the public internet")
                        if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                            current = await check_url(urljoin(current, r.headers["location"]))
                            continue
                        if r.status_code >= 400:
                            raise ReadError(f"the page answered HTTP {r.status_code}")
                        ctype = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
                        if ctype and not (ctype.startswith("text/") or ctype in ("application/xhtml+xml", "application/json",
                                                                                  "application/ld+json", "application/xml")):
                            raise ReadError(f"not a page that can be read as text ({ctype})")
                        body = bytearray()
                        async for part in r.aiter_bytes():
                            body += part
                            if len(body) > MAX_BYTES:
                                raise ReadError("the page is too large")
                        charset = r.charset_encoding
                        break
                else:
                    raise ReadError("too many redirects")
        except httpx.HTTPError as exc:
            raise ReadError(f"could not read the page ({type(exc).__name__})") from None
        finally:
            _last[host] = time.monotonic()
    raw = bytes(body)
    text = _decode(raw, charset)
    if ctype in ("application/json", "application/ld+json"):
        try:
            text = json.dumps(json.loads(text), ensure_ascii=False, indent=1)
        except ValueError:
            pass
        return Page(url=current, title=urlsplit(current).path.rsplit("/", 1)[-1] or host, text=text[:MAX_TEXT],
                    site=host, content_type=ctype)
    if ctype == "text/plain":
        return Page(url=current, title=text.strip().split("\n", 1)[0][:120] or host, text=text[:MAX_TEXT], site=host,
                    content_type=ctype)
    page = extract(text, current)
    if len(page.text.strip()) < 40:
        raise ReadError("the page has almost no readable text (it may need a browser to show it)")
    return page


def _decode(raw: bytes, charset: str | None) -> str:
    if not charset:
        m = re.search(rb"<meta[^>]+charset=[\"']?([a-zA-Z0-9_\-]+)", raw[:4096], re.IGNORECASE)
        charset = m.group(1).decode() if m else None
    for cs in (charset, "utf-8", "cp949", "latin-1"):
        if not cs:
            continue
        try:
            return raw.decode(cs)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


# ---- HTML → text ----

_DROP = {"script", "style", "noscript", "svg", "template", "iframe", "canvas", "form", "button", "select", "nav",
         "footer", "aside", "header"}
_BLOCK = {"p", "div", "section", "article", "main", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre",
          "blockquote", "table", "ul", "ol", "dl", "dt", "dd", "figcaption", "hr"}
_VOID = {"br", "hr", "img", "meta", "link", "input", "source", "wbr", "area", "base", "col", "embed", "track"}


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.drop = 0
        self.title = ""
        self.in_title = False
        self.meta: dict[str, str] = {}
        self.links: list[tuple[str, str]] = []
        self.href: str | None = None
        self.link_text: list[str] = []
        self.cell = False
        self.stack: list[str] = []
        self.main_depth: int | None = None
        self.main_parts: list[str] = []

    def _emit(self, s: str) -> None:
        self.out.append(s)
        if self.main_depth is not None:
            self.main_parts.append(s)

    def handle_starttag(self, tag: str, attrs) -> None:
        a = dict(attrs)
        if tag == "meta":
            k = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            if k and a.get("content"):
                self.meta.setdefault(k, a["content"])
            return
        if tag == "title":
            self.in_title = True
            return
        if tag in _VOID and tag not in ("br", "hr"):
            return
        role = (a.get("role") or "").lower()
        hidden = "hidden" in a or (a.get("aria-hidden") or "").lower() == "true" or role in ("navigation", "banner",
                                                                                                "contentinfo", "search")
        self.stack.append(tag)
        if tag in _DROP or hidden or self.drop:
            self.drop += 1
            return
        if tag in ("article", "main") and self.main_depth is None:
            self.main_depth = len(self.stack)
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._emit("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self._emit("\n- ")
        elif tag in ("td", "th"):
            self._emit(" | " if self.cell else "")
            self.cell = True
        elif tag == "tr":
            self._emit("\n")
            self.cell = False
        elif tag in _BLOCK:
            self._emit("\n\n" if tag in ("p", "pre", "blockquote", "table", "section", "article") else "\n")
        if tag == "a" and a.get("href"):
            self.href = a["href"]
            self.link_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
            return
        if tag in _VOID and tag not in ("br", "hr"):
            return
        if tag not in self.stack:
            return
        while self.stack:
            t = self.stack.pop()
            if self.drop:
                self.drop -= 1
            elif self.main_depth is not None and len(self.stack) < self.main_depth:
                self.main_depth = None
            if t == tag:
                break
        if tag == "a" and self.href is not None:
            text = " ".join("".join(self.link_text).split())
            if text:
                self.links.append((text[:120], self.href))
            self.href = None
        if tag in _BLOCK and not self.drop:
            self._emit("\n")

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title += data
            return
        if self.drop:
            return
        self._emit(data)
        if self.href is not None:
            self.link_text.append(data)


def _tidy(text: str) -> str:
    text = html.unescape(text).replace("\xa0", " ")
    lines = [re.sub(r"[ \t\r\f\v]+", " ", ln).strip() for ln in text.split("\n")]
    out, blank = [], 0
    for ln in lines:
        if not ln or ln in ("-", "|"):
            blank += 1
            continue
        if blank and out:
            out.append("")
        blank = 0
        out.append(ln)
    return "\n".join(out).strip()


def extract(markup: str, url: str = "") -> Page:
    p = _Text()
    try:
        p.feed(markup)
        p.close()
    except Exception:  # noqa: BLE001 - broken markup: what was read so far
        pass
    whole = _tidy("".join(p.out))
    main = _tidy("".join(p.main_parts))
    text = main if len(main) >= max(300, len(whole) * 0.25) else whole
    m = p.meta
    title = _tidy(m.get("og:title") or p.title or "")[:300] or (urlsplit(url).hostname or "")
    published = m.get("article:published_time") or m.get("datepublished") or m.get("date") or m.get("pubdate")
    site = m.get("og:site_name") or urlsplit(url).hostname or ""
    links = []
    seen = set()
    for t, href in p.links:
        absu = urljoin(url, href.strip())
        if absu.startswith(("http://", "https://")) and absu not in seen:
            seen.add(absu)
            links.append((t, absu.split("#", 1)[0]))
    return Page(url=url, title=title, text=text[:MAX_TEXT], site=site[:200], published=(published or None),
                links=links[:300])
