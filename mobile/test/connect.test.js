// node --test test/*.test.js   (from mobile/)
// The connect page's scripts (www/connect-core.js + www/connect.js) in a
// sandbox, with a fake Capacitor bridge whose CapacitorHttp behaves like the
// native one (HttpURLConnection: no cross-scheme redirects, JSON parsed when
// the server says application/json), against the contract mock server.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WWW = path.join(__dirname, "..", "www");
const MOCK = path.join(__dirname, "..", "..", "desktop", "test", "mock-server.js");

function load(extra = {}) {
  const ctx = { console, URL, setTimeout, clearTimeout, Promise, JSON, ...extra };
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ["connect-core.js", "connect.js"]) vm.runInContext(fs.readFileSync(path.join(WWW, f), "utf8"), ctx, { filename: f });
  return ctx;
}

/** A stand-in for window.Capacitor with the native CapacitorHttp semantics. */
function fakeCapacitor(calls) {
  return {
    isNativePlatform: () => true,
    nativePromise(plugin, method, o) {
      calls.push({ plugin, method, o });
      if (plugin === "GenyServer") return Promise.resolve(method === "getState" ? { server: "", lastServer: "", username: "", remember: true } : undefined);
      assert.equal(plugin, "CapacitorHttp");
      assert.equal(method, "request");
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), o.connectTimeout || 5000);
      return fetch(o.url, { method: o.method, headers: o.headers, body: o.data, redirect: "manual", signal: ctrl.signal })
        .then(async (res) => {
          const text = await res.text();
          const headers = {};
          res.headers.forEach((v, k) => (headers[k.replace(/(^|-)\w/g, (m) => m.toUpperCase())] = v)); // native casing
          let data = text;
          if ((res.headers.get("content-type") || "").includes("application/json")) data = JSON.parse(text);
          return { status: res.status, headers, url: o.url, data };
        })
        .catch((e) => {
          // CapacitorHttp rejects with the Java exception's message + class name
          const code = ctrl.signal.aborted ? "SocketTimeoutException" : /ECONNREFUSED/.test(String(e.cause && e.cause.code)) ? "ConnectException" : "IOException";
          throw Object.assign(new Error(ctrl.signal.aborted ? "timeout" : `Failed to connect to ${o.url}`), { code });
        })
        .finally(() => clearTimeout(t));
    },
  };
}

test("www/connect-core.js is identical to desktop/src/connect-core.js", () => {
  const desktop = path.join(__dirname, "..", "..", "desktop", "src", "connect-core.js");
  if (!fs.existsSync(desktop)) return;
  assert.equal(fs.readFileSync(path.join(WWW, "connect-core.js"), "utf8"), fs.readFileSync(desktop, "utf8"));
});

test("the page scripts load and expose their API", () => {
  const ctx = load();
  assert.equal(typeof ctx.GenyConnect.findServer, "function");
  assert.equal(typeof ctx.GenyMobile.nativeRequest, "function");
  assert.ok(ctx.GenyConnect.parseAddress("192.168.0.10:58080").ok);
});

test("native HTTP flow: find, sign in, exchange URL — and redirects across schemes", async (t) => {
  if (!fs.existsSync(MOCK)) return t.skip("desktop/test/mock-server.js not found");
  const { createMock, createRedirector } = require(MOCK);
  const mock = await createMock().listen();
  const hop = await createRedirector(`http://localhost:${mock.port}`).listen();
  t.after(() => Promise.all([mock.close(), hop.close()]));

  const calls = [];
  const ctx = load();
  const request = ctx.GenyMobile.pickRequest({ Capacitor: fakeCapacitor(calls) });
  const found = await ctx.GenyConnect.findServer(`127.0.0.1:${hop.port}`, request);
  assert.equal(found.ok, true, found.message);
  assert.equal(found.server, `http://localhost:${mock.port}`);

  const r = await ctx.GenyConnect.signIn(found.server, "admin", "secret", request);
  assert.equal(r.ok, true, r.message);
  assert.ok(r.exchangeUrl.startsWith(`http://localhost:${mock.port}/auth/exchange?code=`));
  const post = calls.find((c) => c.o.method === "POST");
  assert.equal(post.o.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(post.o.data), { username: "admin", password: "secret", exchange: true });

  const bad = await ctx.GenyConnect.signIn(found.server, "admin", "wrong", request);
  assert.equal(bad.message, "Wrong username or password");
});

test("native HTTP errors map to the connect page's messages", async (t) => {
  if (!fs.existsSync(MOCK)) return t.skip("desktop/test/mock-server.js not found");
  const { createMock } = require(MOCK);
  const mock = await createMock().listen();
  const port = mock.port;
  await mock.close();
  const ctx = load();
  const request = ctx.GenyMobile.pickRequest({ Capacitor: fakeCapacitor([]) });
  const found = await ctx.GenyConnect.findServer(`127.0.0.1:${port}`, request);
  assert.equal(found.kind, "unreachable");
  assert.equal(found.message, "Can't reach the server");
});

test("outside the app the page falls back to fetch", () => {
  const ctx = load();
  let used = null;
  const request = ctx.GenyMobile.pickRequest({ fetch: (u) => ((used = u), Promise.reject(new TypeError("Failed to fetch"))) });
  return request({ url: "http://example.invalid/health", timeoutMs: 100 }).catch((e) => {
    assert.equal(used, "http://example.invalid/health");
    assert.equal(ctx.GenyConnect.classifyNetworkError(e).kind, "unreachable");
  });
});

test("capacitor.config.json has no built-in server", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "capacitor.config.json"), "utf8"));
  assert.equal(cfg.server.url, undefined);
  assert.equal(cfg.server.allowNavigation, undefined);
  assert.equal(cfg.server.cleartext, true);
  assert.doesNotMatch(JSON.stringify(cfg), /hrletsgo\.me/);
  for (const f of fs.readdirSync(WWW)) {
    if (/\.(html|js)$/.test(f)) assert.doesNotMatch(fs.readFileSync(path.join(WWW, f), "utf8"), /hrletsgo/, f);
  }
});
