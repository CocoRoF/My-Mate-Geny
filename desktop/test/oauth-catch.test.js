// The localhost catcher for Higgsfield's sign-in redirect (src/oauth-catch.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { catchRedirect, callbackPage } = require("../src/oauth-catch");

const PORT = 18700 + Math.floor(Math.random() * 200);
const get = (path, port = PORT) =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
const listening = (port) =>
  new Promise((resolve) => {
    const tryIt = (n) =>
      http.get({ host: "127.0.0.1", port, path: "/" }, (r) => (r.resume(), resolve(true))).on("error", () =>
        n > 0 ? setTimeout(() => tryIt(n - 1), 20) : resolve(false));
    tryIt(50);
  });

test("hands over the callback address once, with a page for the browser", async () => {
  const c = catchRedirect({ port: PORT, path: "/callback", timeoutMs: 5000, page: (ok) => callbackPage({ ok, title: "Signed in", body: "Close <this>" }) });
  assert.ok(await listening(PORT));
  assert.equal((await get("/favicon.ico")).status, 404); // other paths are not the answer
  const res = await get("/callback?code=abc123&state=st4te");
  assert.equal(res.status, 200);
  assert.match(res.body, /Signed in/);
  assert.match(res.body, /Close &#60;this&#62;/); // escaped
  assert.deepEqual(await c.done, { url: `http://localhost:${PORT}/callback?code=abc123&state=st4te` });
  // and stops listening right after
  await assert.rejects(get("/callback?code=again"));
});

test("a refused sign-in is handed over too (the server says why)", async () => {
  const c = catchRedirect({ port: PORT + 1, timeoutMs: 5000 });
  assert.ok(await listening(PORT + 1));
  await get("/callback?error=access_denied", PORT + 1);
  assert.equal((await c.done).url, `http://localhost:${PORT + 1}/callback?error=access_denied`);
});

test("a taken port, a timeout and a cancel end it without an address", async () => {
  const other = http.createServer((q, r) => r.end()).listen(PORT + 2, "127.0.0.1");
  await new Promise((r) => other.once("listening", r));
  assert.deepEqual(await catchRedirect({ port: PORT + 2, timeoutMs: 5000 }).done, { error: "busy" });
  other.close();
  assert.deepEqual(await catchRedirect({ port: PORT + 3, timeoutMs: 50 }).done, { error: "timeout" });
  const c = catchRedirect({ port: PORT + 4, timeoutMs: 5000 });
  c.cancel();
  assert.deepEqual(await c.done, { error: "cancelled" });
});
