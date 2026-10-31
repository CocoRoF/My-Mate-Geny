// A tiny My Mate Geny server for tests (Node http, no deps) implementing the
// app sign-in contract:
//   GET  /health                → {"status":"ok","service":…}   (CORS *)
//   POST /api/auth/login        → {ok, token, exchange_code, expires_in} | 401/403 {detail}
//   GET  /auth/exchange?code=&next= → Set-Cookie hrh_session + 302 next (expired → /login?error=expired)
//   GET  /                      → the "console" (needs the cookie, else 302 /login)
//   GET  /login                 → the server's own login page
//   POST /api/auth/logout       → deletes the cookie
//
//   node test/mock-server.js [--port 0] [--base /geny] [--service my-mate-geny]
// prints {"url": …} on stdout once listening.
"use strict";
const http = require("http");
const https = require("https");
const crypto = require("crypto");

function createMock(opts = {}) {
  const o = {
    base: "", // served under a sub-path, e.g. "/geny"
    service: "my-mate-geny",
    username: "admin",
    password: "secret",
    exchange: true, // false: an old server (no exchange_code)
    maxFails: 3,
    codeTtlMs: 60_000,
    ...opts,
  };
  const codes = new Map(); // code → expiry
  const sessions = new Set();
  const log = [];
  let fails = 0;
  const banned = () => fails >= o.maxFails;

  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...cors, ...extra });
    res.end(JSON.stringify(body));
  };
  const html = (res, status, body, extra = {}) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...extra });
    res.end(body);
  };
  const cookieOf = (req) => (/(?:^|;\s*)hrh_session=([^;]+)/.exec(req.headers.cookie || "") || [])[1] || "";

  function handler(req, res) {
    const url = new URL(req.url, "http://x");
    let p = url.pathname;
    const entry = { method: req.method, path: p, cookie: cookieOf(req), origin: req.headers.origin || "" };
    log.push(entry);
    if (o.base) {
      if (p !== o.base && !p.startsWith(o.base + "/")) return html(res, 404, "not here");
      p = p.slice(o.base.length) || "/";
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    if (banned() && p !== "/login") return json(res, 403, { detail: "too many failed attempts — IP temporarily blocked" });
    if (p === "/health") return json(res, 200, { status: "ok", service: o.service, version: "test" });
    if (p === "/api/auth/login" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {}
        entry.body = { ...body, password: body.password ? "***" : "" };
        if (body.username !== o.username || body.password !== o.password) {
          fails++;
          if (banned()) return json(res, 403, { detail: "too many failed attempts — IP blocked" });
          return json(res, 401, { detail: "wrong username or password" });
        }
        fails = 0;
        const token = crypto.randomBytes(12).toString("hex");
        sessions.add(token);
        if (!o.exchange || !body.exchange) return json(res, 200, { ok: true, token });
        const code = crypto.randomBytes(12).toString("hex");
        codes.set(code, { exp: Date.now() + o.codeTtlMs, token });
        json(res, 200, { ok: true, token, exchange_code: code, expires_in: Math.round(o.codeTtlMs / 1000) });
      });
      return;
    }
    if (p === "/auth/exchange") {
      const c = codes.get(url.searchParams.get("code") || "");
      codes.delete(url.searchParams.get("code") || "");
      if (!c || c.exp < Date.now()) {
        res.writeHead(302, { Location: `${o.base}/login?error=expired` });
        return res.end();
      }
      const next = url.searchParams.get("next") || "/";
      res.writeHead(302, {
        Location: `${o.base}${next.startsWith("/") && !next.startsWith("//") ? next : "/"}`,
        "Set-Cookie": `hrh_session=${c.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      });
      return res.end();
    }
    if (p === "/api/auth/logout" && req.method === "POST") {
      sessions.delete(entry.cookie);
      return json(res, 200, { ok: true }, { "Set-Cookie": "hrh_session=; Path=/; Max-Age=0" });
    }
    if (p === "/login") return html(res, 200, `<!doctype html><title>Login — mock</title><h1 id="login">Server login page</h1>`);
    if (!sessions.has(entry.cookie)) {
      res.writeHead(302, { Location: `${o.base}/login` });
      return res.end();
    }
    entry.authed = true;
    if (p === "/") return html(res, 200, `<!doctype html><title>Console — mock</title><h1 id="console">Mock console</h1>`);
    return html(res, 404, "not found");
  }

  return {
    log,
    opts: o,
    reset() {
      fails = 0;
      log.length = 0;
    },
    expireCodes() {
      for (const v of codes.values()) v.exp = 0;
    },
    listen(port = 0, host = "127.0.0.1", tls = null) {
      const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const a = server.address();
          const h = a.family === "IPv6" ? `[${a.address}]` : a.address;
          this.server = server;
          this.url = `${tls ? "https" : "http"}://${h}:${a.port}${o.base}`;
          this.port = a.port;
          resolve(this);
        });
      });
    },
    close() {
      return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
    },
  };
}

/** Answers every request with a redirect to `target` + the same path. */
function createRedirector(target, status = 301) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { Location: target + req.url });
    res.end();
  });
  return {
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve) => server.listen(port, host, () => {
        this.url = `http://${host}:${server.address().port}`;
        this.port = server.address().port;
        resolve(this);
      }));
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Something that answers HTTP but is not My Mate Geny. */
function createOther(handler) {
  const server = http.createServer(handler || ((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "Content-Type": "text/html" });
    res.end("<html>nginx</html>");
  }));
  return {
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve) => server.listen(port, host, () => {
        this.url = `http://${host}:${server.address().port}`;
        this.port = server.address().port;
        resolve(this);
      }));
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

module.exports = { createMock, createRedirector, createOther };

if (require.main === module) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const mock = createMock({ base: arg("base", ""), service: arg("service", "my-mate-geny") });
  mock.listen(Number(arg("port", 0)), arg("host", "127.0.0.1")).then((m) => {
    console.log(JSON.stringify({ url: m.url, port: m.port }));
    // the e2e driver reads the request log over stdin commands
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      for (const line of d.split("\n").filter(Boolean)) {
        if (line === "log") console.log(JSON.stringify({ log: mock.log }));
        if (line === "quit") process.exit(0);
      }
    });
  });
}
