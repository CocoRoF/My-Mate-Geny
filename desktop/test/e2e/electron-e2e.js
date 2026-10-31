// End-to-end check of a built desktop app against the contract mock server,
// driven over the Chrome DevTools Protocol. Linux, headless:
//
//   xvfb-run -a node test/e2e/electron-e2e.js dist/my-mate-geny-<v>-linux-x86_64.AppImage
//
// (or dist/linux-unpacked/my-mate-geny-desktop). Uses a throwaway HOME, so
// it never touches a real profile. Needs Node ≥ 22 (global WebSocket).
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { createMock } = require("../mock-server");

const APP = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(APP)) {
  console.error("usage: node test/e2e/electron-e2e.js <AppImage or unpacked binary>");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);

async function until(what, fn, ms = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

class App {
  constructor(home, port) {
    this.home = home;
    this.port = port;
  }
  start() {
    const env = { ...process.env, HOME: this.home, XDG_CONFIG_HOME: path.join(this.home, ".config"), APPIMAGE_EXTRACT_AND_RUN: "1", ELECTRON_ENABLE_LOGGING: "0" };
    delete env.XDG_SESSION_TYPE;
    this.proc = spawn(APP, ["--no-sandbox", `--remote-debugging-port=${this.port}`, "--disable-gpu"], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.out = "";
    this.proc.stdout.on("data", (d) => (this.out += d));
    this.proc.stderr.on("data", (d) => (this.out += d));
    this.exited = new Promise((r) => this.proc.on("exit", r));
  }
  async stop() {
    if (this.ws) this.ws.close();
    this.ws = null;
    try {
      process.kill(-this.proc.pid, "SIGTERM");
    } catch {}
    await Promise.race([this.exited, sleep(5000)]);
    try {
      process.kill(-this.proc.pid, "SIGKILL");
    } catch {}
    await sleep(500);
  }
  async targets() {
    const r = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    return (await r.json()).filter((t) => t.type === "page");
  }
  /** Attach to the console window's page (the one whose URL matches). */
  async attach(match) {
    const t = await until(`a page matching ${match}`, async () => (await this.targets()).find((x) => match.test(x.url)));
    if (this.ws && this.wsTarget === t.id) return;
    if (this.ws) this.ws.close();
    this.wsTarget = t.id;
    this.ws = new WebSocket(t.webSocketDebuggerUrl);
    this.pending = new Map();
    this.seq = 0;
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    };
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async url() {
    return (await this.targets()).find((t) => t.id === this.wsTarget)?.url || "";
  }
}

const fill = (server, username, password) => `(() => {
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; };
  set("server", ${JSON.stringify(server)}); set("username", ${JSON.stringify(username)}); set("password", ${JSON.stringify(password)});
  document.getElementById("go").click();
  return true;
})()`;
const statusText = `document.getElementById("status").textContent`;

async function main() {
  const mock = await createMock({ maxFails: 20 }).listen();
  const server = `http://127.0.0.1:${mock.port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "geny-e2e-"));
  const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), "geny-e2e-legacy-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  let app = new App(home, port);
  try {
    // ── first start: the connect screen ──
    app.start();
    await app.attach(/connect\.html/);
    step("first start shows the local connect screen");
    await until("the page script", () => app.eval(`!!window.hrhConnect && document.readyState === "complete"`));
    assert.equal(await app.eval(`document.getElementById("server").value`), "");
    assert.ok(await app.eval(`document.querySelector(".head img").naturalWidth > 0`), "the logo loads");
    assert.equal(await app.eval(`typeof window.hrhConnect.signIn`), "function");

    step("unreachable server → \"Can't reach the server\"");
    const closed = await createMock().listen();
    const closedPort = closed.port;
    await closed.close();
    await app.eval(fill(`127.0.0.1:${closedPort}`, "admin", "secret"));
    await until("the unreachable error", async () => /Can't reach the server/.test(await app.eval(statusText)));

    step("wrong password → \"Wrong username or password\"");
    await app.eval(fill(` 127.0.0.1:${mock.port}/ `, "admin", "nope"));
    await until("the credentials error", async () => /Wrong username or password/.test(await app.eval(statusText)));
    assert.equal(await app.eval(`document.getElementById("server").value`), server, "the address is normalized in the field");

    step("connect → exchange → console with the cookie");
    mock.log.length = 0;
    await app.eval(fill(`127.0.0.1:${mock.port}`, "admin", "secret"));
    await until("the console", async () => (await app.url()) === `${server}/`);
    await app.attach(new RegExp(`^${server}/$`));
    await until("the console page", () => app.eval(`!!document.getElementById("console")`));
    const ex = mock.log.find((e) => e.path === "/auth/exchange");
    assert.ok(ex, "the window loaded /auth/exchange");
    const root = mock.log.filter((e) => e.path === "/" && e.authed);
    assert.ok(root.length > 0, "the console request carried the session cookie");
    assert.ok(!mock.log.some((e) => e.path === "/api/auth/login" && e.origin), "login came from the main process (no Origin)");
    const cookies = (await app.send("Network.getCookies", { urls: [`${server}/`] })).cookies;
    assert.ok(cookies.some((c) => c.name === "hrh_session" && c.httpOnly), "hrh_session cookie set first-party");
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".config", "hr-harnessor", "settings.json"), "utf8"));
    assert.equal(settings.serverUrl, server);
    assert.equal(settings.username, "admin");
    assert.ok(!JSON.stringify(settings).includes("secret"), "the password is never stored");
    assert.equal(await app.eval(`typeof window.hrhNative.switchServer + typeof window.hrhNative.signOut`), "functionfunction");
    assert.equal(await app.eval(`typeof window.hrhConnect`), "undefined", "the connect API is not exposed to the server's pages");

    step("the Mate avatar loads from the chosen server (bridge accepts that origin)");
    assert.equal(await app.eval(`window.hrhNative.mate.showAvatar().then(() => true)`), true);
    await until("the avatar window", async () => (await app.targets()).some((t) => t.url.startsWith(`${server}/?surface=mate-overlay`)));
    const st = await app.eval(`window.hrhNative.mate.getState()`);
    assert.ok(st && typeof st === "object", "mate:state answered for the server's origin");
    await app.eval(`window.hrhNative.mate.hideAvatar().then(() => true)`);
    await until("the avatar gone", async () => !(await app.targets()).some((t) => t.url.includes("surface=mate-overlay")));

    step("next launch goes straight to the saved server");
    await app.stop();
    app = new App(home, port);
    mock.log.length = 0;
    app.start();
    await app.attach(new RegExp(`^${server}/$`));
    await until("the console page", () => app.eval(`!!document.getElementById("console")`));
    assert.ok(mock.log.some((e) => e.path === "/" && e.authed));

    step("expired session → the server's own /login page");
    mock.expireSessions();
    await app.eval(`location.reload(), true`).catch(() => {});
    await until("the login page", async () => (await app.url()) === `${server}/login`);

    step("Switch server… → connect screen prefilled; Back returns");
    await app.attach(/\/login$/);
    await app.eval(`window.hrhNative.switchServer(), true`).catch(() => {});
    await app.attach(/connect\.html/);
    await until("prefill", async () => (await app.eval(`document.getElementById("server").value`)) === server);
    assert.equal(await app.eval(`document.getElementById("username").value`), "admin");
    assert.equal(await app.eval(`document.getElementById("password").value`), "");
    assert.equal(await app.eval(`document.getElementById("cancel").hidden`), false);
    await app.eval(`document.getElementById("cancel").click(), true`);
    await until("back on the server", async () => (await app.url()).startsWith(server));

    step("sign in again from the switch screen");
    await app.attach(new RegExp(`^${server}`));
    await app.eval(`window.hrhNative.switchServer(), true`).catch(() => {});
    await app.attach(/connect\.html/);
    await until("prefill", async () => (await app.eval(`document.getElementById("server").value`)) === server);
    await app.eval(`document.getElementById("password").value = "secret"; document.getElementById("go").click(), true`);
    await until("the console", async () => (await app.url()) === `${server}/`);

    step("Sign out → cookies cleared, Mate windows closed, connect screen");
    await app.attach(new RegExp(`^${server}/$`));
    await app.eval(`window.hrhNative.mate.showAvatar().then(() => true)`);
    await until("the avatar window", async () => (await app.targets()).some((t) => t.url.startsWith(`${server}/?surface=mate-overlay`)));
    mock.log.length = 0;
    await app.eval(`window.hrhNative.signOut(), true`).catch(() => {});
    await app.attach(/connect\.html/);
    await until("the signed-out notice", () => app.eval(`!document.getElementById("notice").hidden`));
    assert.ok(mock.log.some((e) => e.method === "POST" && e.path === "/api/auth/logout"), "the server's logout was called");
    const left = (await app.send("Network.getCookies", { urls: [`${server}/`] })).cookies;
    assert.equal(left.filter((c) => c.name === "hrh_session").length, 0, "no session cookie left");
    const after = JSON.parse(fs.readFileSync(path.join(home, ".config", "hr-harnessor", "settings.json"), "utf8"));
    assert.equal(after.serverUrl, undefined);
    assert.equal(after.lastServer, server);
    assert.equal(after.mateVisible, true, "the Mate stays wanted");
    assert.ok(!(await app.targets()).some((t) => t.url.includes("surface=mate-")), "no Mate window left on the old server");

    step("signing in again brings the Mate back");
    await app.eval(fill(server, "admin", "secret"));
    await until("the avatar window", async () => (await app.targets()).some((t) => t.url.startsWith(`${server}/?surface=mate-overlay`)));
    await app.attach(new RegExp(`^${server}/$`));
    await app.eval(`window.hrhNative.mate.hideAvatar().then(() => true)`);
    await app.eval(`window.hrhNative.signOut(), true`).catch(() => {});
    await app.attach(/connect\.html/);
    await until("the signed-out notice", () => app.eval(`!document.getElementById("notice").hidden`));

    step("after sign-out a restart shows the connect screen, prefilled");
    await app.stop();
    app = new App(home, port);
    app.start();
    await app.attach(/connect\.html/);
    await until("prefill", async () => (await app.eval(`document.getElementById("server")?.value`)) === server);
    await app.stop();

    step("pre-0.4 install without a saved server → old address prefilled, not used");
    fs.mkdirSync(path.join(legacyHome, ".config", "hr-harnessor"), { recursive: true });
    fs.writeFileSync(path.join(legacyHome, ".config", "hr-harnessor", "settings.json"), JSON.stringify({ bounds: { width: 1000, height: 700 } }));
    app = new App(legacyHome, port);
    app.start();
    await app.attach(/connect\.html/);
    await until("legacy prefill", async () => (await app.eval(`document.getElementById("server")?.value`)) === "https://agent.hrletsgo.me");
    await app.stop();

    console.log("\nE2E OK");
  } catch (e) {
    console.error(`\nE2E FAILED: ${e.stack || e}`);
    try {
      console.error(`pages: ${JSON.stringify((await app.targets()).map((t) => t.url))}`);
      console.error(`mock log: ${JSON.stringify(mock.log.slice(-8))}`);
    } catch {}
    if (app && app.out) console.error(`--- app output (tail) ---\n${app.out.slice(-3000)}`);
    process.exitCode = 1;
    if (app && app.proc) await app.stop();
  } finally {
    await mock.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(legacyHome, { recursive: true, force: true });
  }
}

main();
