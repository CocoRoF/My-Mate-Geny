// The desktop app's "folder on this computer" (src/folders.js, the console's Folder button) against a REAL server on
// this machine, driven over CDP (page) and the Node inspector (main process; the native dialog is stubbed there):
//
//   xvfb-run -a -s "-screen 0 1600x1000x24" node test/e2e/folders-e2e.js <server url> <password> <fixtures dir> [shots dir]
//
// 1. same machine (the server reads the app's probe file): the picked folder is linked as is;
// 2. a server elsewhere (the probe answer is stubbed to "no" in the page): the folder is scanned in the app, read
//    through the bridge and uploaded as a copy (node_modules / .git skipped); the grant ends with it;
// 3. a cancelled dialog does nothing; the bridge never reads outside a picked folder.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");

const [SERVER_ARG, PASSWORD, FIX, SHOTS] = process.argv.slice(2);
if (!SERVER_ARG || !PASSWORD || !FIX) {
  console.error("usage: node test/e2e/folders-e2e.js <server url> <password> <fixtures dir> [shots dir]");
  process.exit(2);
}
const SERVER = SERVER_ARG.replace(/\/+$/, "");
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
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

class Cdp {
  constructor(url) {
    this.url = url;
  }
  async open() {
    this.ws = new WebSocket(this.url);
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
      this.ws.onerror = () => rej(new Error(`cannot open ${this.url}`));
    });
    return this;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => (this.pending.delete(id), reject(new Error(`${method}: no answer`))), 20000);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async shot(file) {
    if (!SHOTS) return;
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, "base64"));
    console.log(`  shot: ${path.join(SHOTS, file)}`);
  }
}

class App {
  constructor(home, port, iport) {
    Object.assign(this, { home, port, iport });
  }
  start() {
    const env = { ...process.env, HOME: this.home, XDG_CONFIG_HOME: path.join(this.home, ".config") };
    delete env.XDG_SESSION_TYPE;
    delete env.WAYLAND_DISPLAY;
    const bin = path.join(__dirname, "..", "..", "node_modules", ".bin", "electron");
    const args = [path.join(__dirname, "..", ".."), "--no-sandbox", `--remote-debugging-port=${this.port}`, `--inspect=${this.iport}`, "--disable-gpu"];
    this.proc = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.out = "";
    this.proc.stdout.on("data", (d) => (this.out += d));
    this.proc.stderr.on("data", (d) => (this.out += d));
    this.exited = new Promise((r) => this.proc.on("exit", r));
  }
  async stop() {
    this.con?.close();
    this.mainCdp?.close();
    try {
      process.kill(this.proc.pid, "SIGTERM");
    } catch {}
    await Promise.race([this.exited, sleep(8000)]);
    try {
      process.kill(-this.proc.pid, "SIGKILL");
    } catch {}
  }
  async page(match) {
    const t = await until(`a page matching ${match}`, async () =>
      (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).find((x) => x.type === "page" && match.test(x.url)),
    );
    return new Cdp(t.webSocketDebuggerUrl).open();
  }
  async main(body) {
    if (!this.mainCdp) {
      const t = await until("the main-process inspector", async () => (await (await fetch(`http://127.0.0.1:${this.iport}/json/list`)).json())[0]);
      this.mainCdp = await new Cdp(t.webSocketDebuggerUrl).open();
      await this.mainCdp.send("Runtime.enable");
    }
    const r = await this.mainCdp.send("Runtime.evaluate", {
      includeCommandLineAPI: true,
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => { const { dialog } = require("electron"); ${body} })()`,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

function fixtures() {
  fs.rmSync(FIX, { recursive: true, force: true });
  const w = (f, d) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, d));
  fs.mkdirSync(path.join(FIX, "ws", "project"), { recursive: true });
  const pc = path.join(FIX, "pc", "my-notes");
  w(path.join(pc, "todo.md"), "# notes\n");
  w(path.join(pc, "sub", "data.csv"), "a,b\n");
  w(path.join(pc, "sub", "blob.bin"), Buffer.alloc(200000, 3));
  w(path.join(pc, "node_modules", "pkg", "index.js"), "junk");
  w(path.join(pc, ".git", "HEAD"), "ref");
  w(path.join(FIX, "pc", "secret.txt"), "not picked");
  return { ws: path.join(FIX, "ws", "project"), picked: fs.realpathSync(pc) };
}

const click = (con, sel) => con.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
const session = (con, sid) => con.eval(`fetch("/api/sessions/${sid}").then((r) => r.json())`);

async function main() {
  const { ws, picked } = fixtures();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.homedir(), ".cache", "hrh-folders-e2e-"));
  const port = 9300 + Math.floor(Math.random() * 400);
  const app = new App(home, port, port + 500);
  const consoleRe = new RegExp(`^${SERVER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?!login|\\?surface)`);
  try {
    app.start();
    const connect = await app.page(/connect\.html/);
    await until("the connect page", () => connect.eval(`!!window.hrhConnect && document.readyState === "complete"`));
    step("sign in");
    await connect.eval(`(() => { const s = (id, v) => (document.getElementById(id).value = v); s("server", ${JSON.stringify(SERVER)}); s("username", "admin"); s("password", ${JSON.stringify(PASSWORD)}); document.getElementById("go").click(); return true; })()`);
    let con = await app.page(consoleRe);
    await until("the console app", () => con.eval(`!!document.querySelector("#root > *")`));

    step("a chat on a local workspace; the bridge is there");
    const s = await con.eval(`fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude", model: "", connection_id: null, workspace_path: ${JSON.stringify(ws)}, title: "Desktop folders" }) }).then((r) => r.json())`);
    await con.eval(`localStorage.setItem("hrh_last_session", ${JSON.stringify(s.id)}); localStorage.setItem("hrh_session_panel", "0"); localStorage.setItem("hrh_lang", "en"); location.reload(); true`);
    con.close();
    con = await app.page(consoleRe);
    await until("the Folder button", () => con.eval(`!!document.querySelector('[data-testid="topbar-folders"]')`));
    assert.deepEqual(await con.eval(`Object.keys(window.hrhNative.folders || {}).sort()`), ["pick", "read", "release", "scan"]);

    step("1. same machine: the dialog's folder is linked directly (no copy)");
    await app.main(`global.__dialogs = 0; dialog.showOpenDialog = async (w, o) => { global.__dialogs++; global.__dialogOpts = o; return { canceled: false, filePaths: [${JSON.stringify(picked)}] }; }; return true`);
    await click(con, '[data-testid="topbar-folders"]');
    await until("the popover", () => click(con, '[data-testid="folders-tab-local"]'));
    await until("the pick button", () => con.eval(`!!document.querySelector('[data-testid="local-folder-pick"]')`));
    await con.shot("desktop-app-1-local-tab.png");
    await click(con, '[data-testid="local-folder-pick"]');
    await until("linked", async () => (await session(con, s.id)).extra_dirs.includes(picked));
    assert.deepEqual(await app.main(`return global.__dialogOpts.properties`), ["openDirectory", "dontAddToRecent"]);
    assert.ok(!fs.existsSync(path.join(ws, ".geny-uploads")), "no copy was made");
    await sleep(500);
    await con.shot("desktop-app-2-linked.png");
    // the grant ends with the link
    assert.equal(await con.eval(`window.hrhNative.folders.read(${JSON.stringify(picked)}, "todo.md")`), null);
    await con.eval(`fetch("/api/sessions/${s.id}", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ extra_dirs: [] }) }).then((r) => r.ok)`);

    step("2. a server elsewhere (probe says no): scanned in the app, uploaded as a copy");
    await con.eval(`(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes("/api/folder-uploads/probe")
      ? Promise.resolve(new Response(JSON.stringify({ same_host: false, is_dir: false, path: "" }), { status: 200, headers: { "Content-Type": "application/json" } }))
      : f(u, o); return true; })()`);
    await until("the pick button", () => con.eval(`!!document.querySelector('[data-testid="local-folder-pick"]')`));
    await click(con, '[data-testid="local-folder-pick"]');
    await until("the summary", () => con.eval(`!!document.querySelector('[data-testid="local-folder-summary"]')`));
    const summary = await con.eval(`document.querySelector('[data-testid="local-folder-summary"]').innerText`);
    console.log(`  summary: ${summary.replace(/\s+/g, " ")}`);
    assert.match(summary, /3 files/);
    assert.match(summary, /Skipped \.git, node_modules/);
    await con.shot("desktop-app-3-copy-summary.png");
    await click(con, '[data-testid="local-folder-upload"]');
    const copy = path.join(ws, ".geny-uploads", "my-notes");
    await until("the copy connected", async () => (await session(con, s.id)).extra_dirs.includes(copy));
    assert.equal(fs.readFileSync(path.join(copy, "sub", "blob.bin")).length, 200000);
    assert.equal(fs.readFileSync(path.join(copy, "todo.md"), "utf8"), "# notes\n");
    assert.ok(!fs.existsSync(path.join(copy, "node_modules")) && !fs.existsSync(path.join(copy, ".git")));
    await sleep(400);
    await con.shot("desktop-app-4-copied.png");
    assert.equal(await con.eval(`window.hrhNative.folders.read(${JSON.stringify(picked)}, "todo.md")`), null, "released after the upload");

    step("3. nothing outside a picked folder; a cancelled dialog does nothing");
    const secret = path.join(path.dirname(picked), "secret.txt");
    assert.equal(await con.eval(`window.hrhNative.folders.read(${JSON.stringify(path.dirname(picked))}, "secret.txt")`), null);
    assert.equal(await con.eval(`window.hrhNative.folders.scan(${JSON.stringify(path.dirname(picked))})`), null);
    assert.ok(fs.existsSync(secret));
    await app.main(`dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); return true`);
    assert.equal(await con.eval(`window.hrhNative.folders.pick()`), null);
    // a picked folder can be read, but only inside it
    await app.main(`dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(picked)}] }); return true`);
    const g = await con.eval(`window.hrhNative.folders.pick()`);
    assert.equal(g.path, picked);
    assert.ok(fs.existsSync(g.probe.path), "probe file written");
    assert.equal(await con.eval(`window.hrhNative.folders.read(${JSON.stringify(picked)}, "../secret.txt")`), null);
    assert.equal(await con.eval(`window.hrhNative.folders.read(${JSON.stringify(picked)}, "todo.md").then((b) => new TextDecoder().decode(b))`), "# notes\n");
    await con.eval(`window.hrhNative.folders.release(${JSON.stringify(picked)})`);
    assert.ok(!fs.existsSync(g.probe.path), "probe file removed on release");
    console.log("OK");
  } catch (e) {
    console.error(app.out.split("\n").slice(-30).join("\n"));
    throw e;
  } finally {
    await app.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
