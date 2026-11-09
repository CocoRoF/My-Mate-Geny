"""WebFetch and WebSearch.

WebFetch downloads the page, turns HTML into readable text and has the chat's model answer the given prompt about it —
a separate small call, so a long page doesn't flood the conversation. WebSearch is the vendor's own web search
(Anthropic's web_search tool, OpenAI's web_search, Gemini's Google Search grounding) in a separate call, returning
what it found with its sources.
"""

from __future__ import annotations

import html
import re
import time
from html.parser import HTMLParser
from typing import Any

from app.harness.tools.base import Tool, ToolContext, ToolOutput, obj, truncate_middle

MAX_BYTES = 10 * 1024 * 1024
MAX_CHARS = 100_000
_cache: dict[str, tuple[float, str, str]] = {}  # url -> (when, final url, text)
_TTL = 15 * 60


class _Text(HTMLParser):
    _BLOCK = {"p", "div", "section", "article", "header", "footer", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6",
              "pre", "blockquote", "table", "ul", "ol", "dl", "dt", "dd", "hr"}
    _SKIP = {"script", "style", "noscript", "svg", "iframe", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0
        self.href: str | None = None
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP:
            self.skip += 1
            return
        if tag == "title":
            self._in_title = True
        if tag in self._BLOCK:
            self.out.append("\n")
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.out.append("#" * int(tag[1]) + " ")
        if tag == "li":
            self.out.append("- ")
        if tag == "a":
            self.href = dict(attrs).get("href")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if tag == "title":
            self._in_title = False
        if tag == "a" and self.href and self.href.startswith("http"):
            self.out.append(f" ({self.href})")
            self.href = None
        if tag in self._BLOCK:
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
            return
        if not self.skip:
            self.out.append(data)


def html_text(raw: str) -> tuple[str, str]:
    p = _Text()
    try:
        p.feed(raw)
    except Exception:  # noqa: BLE001 - broken HTML: what was read so far
        pass
    text = "".join(p.out)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return html.unescape(p.title.strip()), text.strip()


async def fetch(url: str) -> tuple[str, str, str]:
    """(final url, content type, text)."""
    import httpx

    hit = _cache.get(url)
    if hit and time.monotonic() - hit[0] < _TTL:
        return hit[1], "cached", hit[2]
    headers = {"User-Agent": "Mozilla/5.0 (compatible; MyMateGeny/1.0; +https://github.com/CocoRoF/My-Mate-Geny)",
               "Accept": "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5"}
    async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30.0, connect=10.0), headers=headers) as c:
        async with c.stream("GET", url) as r:
            r.raise_for_status()
            chunks, size = [], 0
            async for chunk in r.aiter_bytes():
                size += len(chunk)
                if size > MAX_BYTES:
                    break
                chunks.append(chunk)
            ctype = r.headers.get("content-type", "")
            final = str(r.url)
            raw = b"".join(chunks).decode(r.encoding or "utf-8", errors="replace")
    if "html" in ctype or raw.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        title, text = html_text(raw)
        text = f"# {title}\n\n{text}" if title else text
    else:
        text = raw
    _cache[url] = (time.monotonic(), final, text)
    if len(_cache) > 64:
        oldest = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest, None)
    return final, ctype, text


class WebFetch(Tool):
    name = "WebFetch"
    description = ("Fetch a web page (or any URL) and get an answer to `prompt` about its content — read from the "
                   "page, not from memory. HTML is turned into text first; results are cached for 15 minutes. If the "
                   "URL redirects to another host you are told so; fetch the new URL. Prefer an MCP tool for sites it "
                   "covers (logins, private pages).")
    schema = obj({
        "url": {"type": "string", "description": "The URL"},
        "prompt": {"type": "string", "description": "What to find out from the page"},
    }, ["url", "prompt"])
    read_only = True
    parallel = True

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        url = str(args.get("url") or "").strip()
        prompt = str(args.get("prompt") or "").strip() or "Summarize this page."
        if not re.match(r"^https?://", url):
            return ToolOutput.error("The URL must start with http:// or https://")
        try:
            final, _ctype, text = await fetch(url)
        except Exception as exc:  # noqa: BLE001 - a fetch that failed is an answer
            return ToolOutput.error(f"Could not fetch {url}: {exc}")
        from urllib.parse import urlparse

        if urlparse(final).netloc and urlparse(final).netloc != urlparse(url).netloc:
            return ToolOutput(f"The URL redirected to another host: {final}\nFetch that URL to read it.")
        content = truncate_middle(text, MAX_CHARS)
        if ctx.ask is None:
            return ToolOutput(content)
        answer = await ctx.ask(
            "You answer a question about one web page, using only its content below. Be concise and specific; quote "
            "exact text (code, numbers, names) where it matters. If the page doesn't answer it, say so.",
            f"<page url=\"{final}\">\n{content}\n</page>\n\nQuestion: {prompt}",
        )
        return ToolOutput(answer.text or "(no answer)")


class WebSearch(Tool):
    name = "WebSearch"
    description = ("Search the web for current information (news, docs, releases, prices) and get what was found "
                   "with links. Cite the sources you use in your answer. `allowed_domains` / `blocked_domains` narrow "
                   "the sites.")
    schema = obj({
        "query": {"type": "string", "description": "The search query"},
        "allowed_domains": {"type": "array", "items": {"type": "string"}, "description": "Only these sites"},
        "blocked_domains": {"type": "array", "items": {"type": "string"}, "description": "Never these sites"},
    }, ["query"])
    read_only = True
    parallel = True

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        query = str(args.get("query") or "").strip()
        if len(query) < 2:
            return ToolOutput.error("The query is too short.")
        if ctx.ask is None:
            return ToolOutput.error("Web search isn't available here.")
        scope = []
        if args.get("allowed_domains"):
            scope.append("Only use results from: " + ", ".join(map(str, args["allowed_domains"])) + ".")
        if args.get("blocked_domains"):
            scope.append("Never use results from: " + ", ".join(map(str, args["blocked_domains"])) + ".")
        answer = await ctx.ask(
            "Search the web and report what you find: the facts that answer the query, each with its source. Be "
            "concise; prefer recent, primary sources. " + " ".join(scope),
            query, web_search=True,
        )
        links = "\n".join(f"- [{c['title']}]({c['url']})" for c in answer.citations[:20])
        text = f"Web search results for query: \"{query}\"\n\n{answer.text or '(nothing found)'}"
        if links:
            text += f"\n\nLinks:\n{links}"
        return ToolOutput(text)
