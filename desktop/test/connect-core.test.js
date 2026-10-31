// node --test test/   (from desktop/)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const core = require("../src/connect-core");
const { createMock, createRedirector, createOther } = require("./mock-server");

const bases = (input) => {
  const r = core.parseAddress(input);
  assert.ok(r.ok, `${JSON.stringify(input)} should parse: ${r.message}`);
  return r.candidates.map((c) => c.base);
};
const kind = (input) => core.parseAddress(input).kind;

// ── the normalizer ──────────────────────────────────────────────

test("public host names: https first, then http", () => {
  assert.deepEqual(bases("example.com"), ["https://example.com", "http://example.com"]);
  assert.deepEqual(bases("geny.example.org"), ["https://geny.example.org", "http://geny.example.org"]);
  assert.deepEqual(bases("1.2.3.4"), ["https://1.2.3.4", "http://1.2.3.4"]);
});

test("explicit schemes are kept and only those are tried", () => {
  assert.deepEqual(bases("http://example.com"), ["http://example.com"]);
  assert.deepEqual(bases("https://example.com/"), ["https://example.com"]);
  assert.deepEqual(bases("HTTPS://EXAMPLE.COM"), ["https://example.com"]);
  assert.deepEqual(bases("Http://Example.com:8080/"), ["http://example.com:8080"]);
  assert.deepEqual(bases("https//example.com"), ["https://example.com"]);
  assert.deepEqual(bases("https:/example.com"), ["https://example.com"]);
  assert.deepEqual(bases("wss://example.com"), ["https://example.com"]);
  assert.deepEqual(bases("ws://example.com:58080"), ["http://example.com:58080"]);
});

test("explicit ports: non-443 tries http first; 443 https first", () => {
  assert.deepEqual(bases("example.com:8080"), ["http://example.com:8080", "https://example.com:8080"]);
  assert.deepEqual(bases("example.com:443"), ["https://example.com", "http://example.com:443"]);
  assert.deepEqual(bases("example.com:80"), ["http://example.com", "https://example.com:80"]);
  assert.deepEqual(bases("https://example.com:443"), ["https://example.com"]);
  assert.deepEqual(bases("http://example.com:80/"), ["http://example.com"]);
});

test("localhost, private IPs and LAN names: http first", () => {
  assert.deepEqual(bases("localhost:8080"), ["http://localhost:8080", "https://localhost:8080"]);
  assert.deepEqual(bases("localhost"), ["http://localhost", "https://localhost"]);
  assert.deepEqual(bases("192.168.0.10:58080"), ["http://192.168.0.10:58080", "https://192.168.0.10:58080"]);
  assert.deepEqual(bases("10.0.0.5"), ["http://10.0.0.5", "https://10.0.0.5"]);
  assert.deepEqual(bases("172.20.1.1"), ["http://172.20.1.1", "https://172.20.1.1"]);
  assert.deepEqual(bases("172.32.1.1"), ["https://172.32.1.1", "http://172.32.1.1"]);
  assert.deepEqual(bases("100.101.102.103"), ["http://100.101.102.103", "https://100.101.102.103"]);
  assert.deepEqual(bases("127.0.0.1:58080"), ["http://127.0.0.1:58080", "https://127.0.0.1:58080"]);
  assert.deepEqual(bases("nas"), ["http://nas", "https://nas"]);
  assert.deepEqual(bases("geny.local"), ["http://geny.local", "https://geny.local"]);
  assert.deepEqual(bases("box.lan:3000"), ["http://box.lan:3000", "https://box.lan:3000"]);
  assert.deepEqual(bases("app.localhost"), ["http://app.localhost", "https://app.localhost"]);
});

test("IPv6", () => {
  assert.deepEqual(bases("[::1]:8080"), ["http://[::1]:8080", "https://[::1]:8080"]);
  assert.deepEqual(bases("http://[::1]:8080/"), ["http://[::1]:8080"]);
  assert.deepEqual(bases("::1"), ["http://[::1]", "https://[::1]"]);
  assert.deepEqual(bases("[fd00::5]"), ["http://[fd00::5]", "https://[fd00::5]"]);
  assert.deepEqual(bases("fe80::1"), ["http://[fe80::1]", "https://[fe80::1]"]);
  assert.deepEqual(bases("[2001:db8::1]:9000"), ["http://[2001:db8::1]:9000", "https://[2001:db8::1]:9000"]);
  assert.deepEqual(bases("[2001:db8::1]"), ["https://[2001:db8::1]", "http://[2001:db8::1]"]);
});

test("spaces, case, trailing slashes, query, fragment, credentials", () => {
  assert.deepEqual(bases("  example.com  "), ["https://example.com", "http://example.com"]);
  assert.deepEqual(bases("\texample.com/\n"), ["https://example.com", "http://example.com"]);
  assert.deepEqual(bases("EXAMPLE.com///"), ["https://example.com", "http://example.com"]);
  assert.deepEqual(bases("example.com."), ["https://example.com", "http://example.com"]);
  assert.deepEqual(bases("https://example.com/?view=downloads#x"), ["https://example.com"]);
  assert.deepEqual(bases("https://admin:pw@example.com/"), ["https://example.com"]);
  assert.deepEqual(bases('"https://example.com"'), ["https://example.com"]);
  assert.deepEqual(bases("<https://example.com/>"), ["https://example.com"]);
  assert.deepEqual(bases("example. com"), ["https://example.com", "http://example.com"]);
});

test("sub-paths are kept (case too), with parents as fallbacks", () => {
  assert.deepEqual(bases("https://example.com/geny"), ["https://example.com/geny", "https://example.com"]);
  assert.deepEqual(bases("https://example.com/Geny/"), ["https://example.com/Geny", "https://example.com"]);
  assert.deepEqual(bases("example.com/apps/geny//"), [
    "https://example.com/apps/geny", "https://example.com/apps", "https://example.com",
    "http://example.com/apps/geny", "http://example.com/apps", "http://example.com",
  ]);
  assert.deepEqual(bases("https://example.com/a/./b/../c"), ["https://example.com/a/c", "https://example.com/a", "https://example.com"]);
  assert.deepEqual(bases("https://example.com/login"), ["https://example.com/login", "https://example.com"]);
  const deep = bases("https://example.com/a/b/c/d/e/f");
  assert.equal(deep[0], "https://example.com/a/b/c/d/e/f");
  assert.equal(deep[deep.length - 1], "https://example.com");
  assert.ok(deep.length <= 5);
});

test("bad input", () => {
  assert.equal(kind(""), "empty");
  assert.equal(kind("   "), "empty");
  assert.equal(kind(null), "empty");
  assert.equal(kind("ftp://example.com"), "scheme");
  assert.equal(kind("file:///etc/passwd"), "scheme");
  assert.equal(kind("http://"), "invalid");
  assert.equal(kind(":8080"), "invalid");
  assert.equal(kind("example.com:99999"), "invalid");
  assert.equal(kind("example.com:0"), "invalid");
  assert.equal(kind("exa<mple.com"), "invalid");
  assert.equal(kind("a".repeat(3000)), "invalid");
  assert.equal(kind("http://exa mple .com:8080"), undefined); // spaces dropped → valid
});

test("isPrivateHost", () => {
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.1.1", "100.64.0.1", "::1", "[::1]", "fd12::1", "fe80::1", "nas", "x.local", "x.home.arpa", "::ffff:192.168.0.1"]) {
    assert.equal(core.isPrivateHost(h), true, h);
  }
  for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1", "geny.example.org"]) {
    assert.equal(core.isPrivateHost(h), false, h);
  }
});

test("cleanBase and exchangeUrl", () => {
  assert.equal(core.cleanBase("https://Example.com/geny/"), "https://example.com/geny");
  assert.equal(core.cleanBase("http://x:80/"), "http://x");
  assert.equal(core.cleanBase("javascript:alert(1)"), "");
  assert.equal(core.cleanBase(""), "");
  assert.equal(core.exchangeUrl("https://example.com/geny", "a b/c"), "https://example.com/geny/auth/exchange?code=a%20b%2Fc&next=%2F");
});

test("network errors are classified across stacks", () => {
  const k = (e) => core.classifyNetworkError(e).kind;
  const undici = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
  assert.equal(k(undici("ECONNREFUSED")), "unreachable");
  assert.equal(k(undici("ENOTFOUND")), "unreachable");
  assert.equal(k(undici("DEPTH_ZERO_SELF_SIGNED_CERT")), "tls");
  assert.equal(k(undici("CERT_HAS_EXPIRED")), "tls");
  assert.equal(k(undici("ERR_TLS_CERT_ALTNAME_INVALID")), "tls");
  assert.equal(k(undici("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), "tls");
  assert.equal(core.classifyNetworkError(undici("ERR_SSL_WRONG_VERSION_NUMBER")).protocol, true);
  assert.equal(k(Object.assign(new Error("timed out"), { name: "TimeoutError" })), "timeout");
  // Electron net
  assert.equal(k(new Error("net::ERR_CERT_AUTHORITY_INVALID")), "tls");
  assert.equal(k(new Error("net::ERR_CERT_DATE_INVALID")), "tls");
  assert.equal(k(new Error("net::ERR_CERT_COMMON_NAME_INVALID")), "tls");
  assert.equal(k(new Error("net::ERR_CONNECTION_REFUSED")), "unreachable");
  assert.equal(k(new Error("net::ERR_NAME_NOT_RESOLVED")), "unreachable");
  assert.equal(k(new Error("net::ERR_CONNECTION_TIMED_OUT")), "timeout");
  // Android HttpURLConnection (CapacitorHttp rejects with message + class name)
  assert.equal(k({ code: "SSLHandshakeException", message: "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found." }), "tls");
  assert.equal(k({ code: "SSLPeerUnverifiedException", message: "Hostname example.com not verified" }), "tls");
  assert.equal(k({ code: "UnknownHostException", message: "Unable to resolve host \"nope.invalid\"" }), "unreachable");
  assert.equal(k({ code: "ConnectException", message: "Failed to connect to /10.0.0.9:80" }), "unreachable");
  assert.equal(k({ code: "SocketTimeoutException", message: "timeout" }), "timeout");
  assert.equal(k({ code: "UnknownServiceException", message: "CLEARTEXT communication to 10.0.0.9 not permitted by network security policy" }), "cleartext");
  assert.equal(k(new TypeError("Failed to fetch")), "unreachable");
});

// ── against the mock server ─────────────────────────────────────

const request = core.fetchRequest(fetch);

test("finds the server, signs in, exchange sets the cookie", async (t) => {
  const mock = await createMock().listen();
  t.after(() => mock.close());
  const host = `127.0.0.1:${mock.port}`;
  const found = await core.findServer(host, request);
  assert.equal(found.ok, true, found.message);
  assert.equal(found.server, `http://${host}`);
  assert.equal(found.service, "my-mate-geny");

  const r = await core.signIn(found.server, " admin ", "secret", request);
  assert.equal(r.ok, true, r.message);
  assert.match(r.exchangeUrl, new RegExp(`^http://${host}/auth/exchange\\?code=[0-9a-f]+&next=%2F$`));
  assert.ok(r.expiresIn > 0);
  const login = mock.log.find((e) => e.path === "/api/auth/login");
  assert.deepEqual(login.body, { username: "admin", password: "***", exchange: true });

  const ex = await fetch(r.exchangeUrl, { redirect: "manual" });
  assert.equal(ex.status, 302);
  assert.equal(ex.headers.get("location"), "/");
  const cookie = ex.headers.get("set-cookie").split(";")[0];
  const page = await fetch(`http://${host}/`, { headers: { cookie }, redirect: "manual" });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Mock console/);

  // a code works once
  const again = await fetch(r.exchangeUrl, { redirect: "manual" });
  assert.equal(again.headers.get("location"), "/login?error=expired");
});

test("the legacy service name is accepted", async (t) => {
  const mock = await createMock({ service: "hr-harnessor" }).listen();
  t.after(() => mock.close());
  const found = await core.findServer(`localhost:${mock.port}`, request);
  assert.equal(found.ok, true);
  assert.equal(found.server, `http://localhost:${mock.port}`);
});

test("sub-path servers keep their path, also when given a deeper URL", async (t) => {
  const mock = await createMock({ base: "/geny" }).listen();
  t.after(() => mock.close());
  for (const input of [`127.0.0.1:${mock.port}/geny`, `http://127.0.0.1:${mock.port}/geny/`, `127.0.0.1:${mock.port}/geny/login`]) {
    const found = await core.findServer(input, request);
    assert.equal(found.ok, true, `${input}: ${found.message}`);
    assert.equal(found.server, `http://127.0.0.1:${mock.port}/geny`);
  }
  const r = await core.signIn(`http://127.0.0.1:${mock.port}/geny`, "admin", "secret", request);
  assert.equal(r.ok, true);
  assert.ok(r.exchangeUrl.startsWith(`http://127.0.0.1:${mock.port}/geny/auth/exchange?code=`));
  const ex = await fetch(r.exchangeUrl, { redirect: "manual" });
  assert.equal(ex.headers.get("location"), "/geny/");
});

test("without the sub-path the server is not found", async (t) => {
  const mock = await createMock({ base: "/geny" }).listen();
  t.after(() => mock.close());
  const found = await core.findServer(`127.0.0.1:${mock.port}`, request);
  assert.equal(found.ok, false);
  assert.equal(found.kind, "not_geny");
  assert.equal(found.message, "Not a My Mate Geny server");
});

test("not a My Mate Geny server", async (t) => {
  const other = await createOther().listen();
  t.after(() => other.close());
  const found = await core.findServer(`127.0.0.1:${other.port}`, request);
  assert.equal(found.ok, false);
  assert.equal(found.kind, "not_geny");
  const json = await createOther((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "something-else" }));
  }).listen();
  t.after(() => json.close());
  assert.equal((await core.findServer(`127.0.0.1:${json.port}`, request)).kind, "not_geny");
});

test("can't reach the server (refused) — both schemes tried", async () => {
  const mock = await createMock().listen();
  const port = mock.port;
  await mock.close();
  const tried = [];
  const found = await core.findServer(`127.0.0.1:${port}`, request, { onProgress: (p) => tried.push(p.url) });
  assert.equal(found.ok, false);
  assert.equal(found.kind, "unreachable");
  assert.equal(found.message, "Can't reach the server");
  assert.deepEqual(tried, [`http://127.0.0.1:${port}`, `https://127.0.0.1:${port}`]);
});

test("timeouts are short and reported", async (t) => {
  const net = require("net");
  const sockets = [];
  const silent = net.createServer((s) => sockets.push(s)); // accepts, never answers
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  t.after(() => {
    sockets.forEach((s) => s.destroy());
    silent.close();
  });
  const t0 = Date.now();
  const found = await core.findServer(`http://127.0.0.1:${silent.address().port}`, request, { healthTimeoutMs: 300 });
  assert.equal(found.kind, "timeout");
  assert.ok(Date.now() - t0 < 3000);
});

test("http → https style redirects are followed and the final base is used", async (t) => {
  const mock = await createMock().listen();
  const hop = await createRedirector(`http://localhost:${mock.port}`).listen();
  t.after(() => Promise.all([mock.close(), hop.close()]));
  const found = await core.findServer(`127.0.0.1:${hop.port}`, request);
  assert.equal(found.ok, true, found.message);
  assert.equal(found.server, `http://localhost:${mock.port}`);
  // and with a client that doesn't follow redirects (Android HttpURLConnection across schemes)
  const manual = core.fetchRequest((url, init) => fetch(url, { ...init, redirect: "manual" }));
  const found2 = await core.findServer(`127.0.0.1:${hop.port}`, manual);
  assert.equal(found2.ok, true, found2.message);
  assert.equal(found2.server, `http://localhost:${mock.port}`);
});

test("wrong password, then too many attempts", async (t) => {
  const mock = await createMock({ maxFails: 3 }).listen();
  t.after(() => mock.close());
  const server = mock.url;
  let r = await core.signIn(server, "admin", "nope", request);
  assert.equal(r.kind, "credentials");
  assert.equal(r.message, "Wrong username or password");
  r = await core.signIn(server, "someone", "secret", request);
  assert.equal(r.kind, "credentials");
  r = await core.signIn(server, "admin", "nope", request);
  assert.equal(r.kind, "rate");
  assert.equal(r.message, "Too many attempts — try later");
  // a banned client probing /health is told the same
  const found = await core.findServer(server, request);
  assert.equal(found.kind, "rate");
});

test("missing fields never hit the server", async () => {
  const boom = () => Promise.reject(new Error("should not be called"));
  assert.equal((await core.signIn("http://x", "", "pw", boom)).kind, "missing_username");
  assert.equal((await core.signIn("http://x", "admin", "", boom)).kind, "missing_password");
  assert.equal((await core.signIn("nonsense", "admin", "pw", boom)).kind, "invalid");
});

test("a server without exchange support is reported as too old", async (t) => {
  const mock = await createMock({ exchange: false }).listen();
  t.after(() => mock.close());
  const r = await core.signIn(mock.url, "admin", "secret", request);
  assert.equal(r.kind, "old_server");
  const missing = await createOther().listen();
  t.after(() => missing.close());
  assert.equal((await core.signIn(missing.url, "admin", "secret", request)).kind, "old_server");
});

test("server errors", async (t) => {
  const broken = await createOther((req, res) => {
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end("bad gateway");
  }).listen();
  t.after(() => broken.close());
  const r = await core.signIn(broken.url, "admin", "secret", request);
  assert.equal(r.kind, "server_error");
  assert.equal(r.status, 502);
});

function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geny-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
    return { key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("TLS problems are reported as such", async (t) => {
  const tls = selfSigned();
  if (!tls) return t.skip("no openssl");
  const mock = await createMock().listen(0, "127.0.0.1", tls);
  t.after(() => mock.close());
  const found = await core.findServer(`https://localhost:${mock.port}`, request);
  assert.equal(found.ok, false);
  assert.equal(found.kind, "tls");
  assert.match(found.message, /certificate/);
  // no scheme typed: http is tried first (explicit port) and gets garbage from a TLS port → still TLS
  const found2 = await core.findServer(`localhost:${mock.port}`, request);
  assert.equal(found2.kind, "tls");
});

test("the Android copy of connect-core.js is identical", () => {
  const a = fs.readFileSync(path.join(__dirname, "..", "src", "connect-core.js"), "utf8");
  const bPath = path.join(__dirname, "..", "..", "mobile", "www", "connect-core.js");
  if (!fs.existsSync(bPath)) return;
  assert.equal(fs.readFileSync(bPath, "utf8"), a, "copy desktop/src/connect-core.js to mobile/www/connect-core.js");
});
