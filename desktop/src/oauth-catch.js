// Catches one OAuth redirect on this computer — Higgsfield's CLI client signs in to http://localhost:8765/callback,
// a page a server can't receive (docs/higgsfield.md). While a sign-in waits, the app listens on localhost:<port>;
// the browser lands there, gets a "you can close this tab" page, and the console is handed the address, which it
// sends to the server exactly as if the user had pasted it (the server holds the PKCE verifier and exchanges the
// code). Works whichever server the app is connected to. One sign-in at a time; nothing is listened to otherwise.
"use strict";

const http = require("http");

/**
 * Listen until a request to `path` with `code` or `error` in its query arrives (→ {url}), the time is up
 * (→ {error: "timeout"}), it is cancelled (→ {error: "cancelled"}) or the port is taken (→ {error: "busy"}).
 * Returns {done: Promise, cancel()}.
 */
function catchRedirect({ port = 8765, path = "/callback", timeoutMs = 15 * 60 * 1000, page = () => "" } = {}) {
  const servers = [];
  let finish;
  const done = new Promise((resolve) => {
    finish = (result) => {
      if (!finish.called) {
        finish.called = true;
        clearTimeout(timer);
        for (const s of servers) {
          s.close();
          if (typeof s.closeIdleConnections === "function") setImmediate(() => s.closeIdleConnections());
        }
        resolve(result);
      }
    };
  });
  const timer = setTimeout(() => finish({ error: "timeout" }), timeoutMs);

  const handle = (req, res) => {
    let u;
    try {
      u = new URL(req.url || "/", `http://localhost:${port}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const answer = u.pathname === path && (u.searchParams.has("code") || u.searchParams.has("error"));
    if (!answer) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
    res.end(page(!u.searchParams.has("error")));
    finish({ url: `http://localhost:${port}${u.pathname}${u.search}` });
  };

  // the browser may resolve localhost to either address: listen on both (IPv6 may be missing)
  let pending = 2;
  let listening = 0;
  for (const host of ["127.0.0.1", "::1"]) {
    const s = http.createServer(handle);
    servers.push(s);
    s.once("error", (err) => {
      pending -= 1;
      if (err && err.code === "EADDRINUSE") finish({ error: "busy" });
      else if (pending === 0 && listening === 0) finish({ error: "unavailable" });
    });
    s.listen(port, host, () => {
      listening += 1;
      pending -= 1;
    });
  }
  return { done, cancel: () => finish({ error: "cancelled" }) };
}

/** the page the browser shows after the redirect (`ok` false: the sign-in was refused) */
function callbackPage({ title, body, ok }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.2rem;margin:0 0 .5rem}p{opacity:.75;margin:0}</style>
<main><h1>${ok ? "&#10003; " : ""}${esc(title)}</h1><p>${esc(body)}</p></main>`;
}

module.exports = { catchRedirect, callbackPage };
