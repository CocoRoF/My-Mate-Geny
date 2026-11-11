// The desktop's pointer for an avatar that looks at it (src/cursor-feed.js, frontend mate/avatar/desktopCursor.ts), in the
// real app (`electron .`) against a real server, the pointer moved by xdotool. Linux, headless:
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node test/e2e/cursor-follow-e2e.js <server url> <password>
//
// Checks: her small window asks for the pointer (as a Live2D / LivLiv body does) → with the pointer outside the window,
// where it is comes in, in the window's coordinates, once per move; over the window, nothing (its own events); after
// follow(false), nothing.
"use strict";
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");

const [SERVER, PASSWORD] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
async function until(what, fn, ms = 30000) {
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer in 15 s`));
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
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
  mouse(type, x, y, extra = {}) {
    return this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  }
  async drag(x0, y0, x1, y1, steps = 8) {
    await this.mouse("mouseMoved", x0, y0, { buttons: 0 });
    await this.mouse("mousePressed", x0, y0);
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
      await sleep(30);
    }
    await this.mouse("mouseReleased", x1, y1);
  }
}


const mouse = (x, y) => execFileSync("xdotool", ["mousemove", String(x), String(y)]);

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hrh-cursor-e2e-"));
  const port = 9900 + Math.floor(Math.random() * 50), iport = port + 100;
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), LANG: "en_US.UTF-8", LANGUAGE: "en_US", LC_ALL: "en_US.UTF-8" };
  delete env.XDG_SESSION_TYPE;
  delete env.WAYLAND_DISPLAY;
  const electron = path.join(__dirname, "..", "..", "node_modules", ".bin", "electron");
  const proc = spawn(electron, [path.join(__dirname, "..", ".."), "--no-sandbox", `--remote-debugging-port=${port}`, `--inspect=${iport}`, "--disable-gpu", "--lang=en-US"], { env, stdio: "ignore", detached: true });
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page");
  const page = async (re) => new Cdp((await until(`a page ${re}`, async () => (await targets()).find((t) => re.test(t.url)), 60000)).webSocketDebuggerUrl).open();
  let mainCdp = null;
  const main = async (body) => {
    if (!mainCdp) {
      const t = await until("the inspector", async () => (await (await fetch(`http://127.0.0.1:${iport}/json/list`)).json())[0]);
      mainCdp = await new Cdp(t.webSocketDebuggerUrl).open();
    }
    const r = await mainCdp.send("Runtime.evaluate", { includeCommandLineAPI: true, awaitPromise: true, returnByValue: true,
      expression: `(async () => { const { BrowserWindow } = require("electron"); const win = (part) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(part)); ${body} })()` });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  try {
    const connect = await page(/connect\.html/);
    await until("the connect page", () => connect.eval(`!!window.hrhConnect && document.readyState === "complete"`));
    await connect.eval(`(() => { document.getElementById("modeServer")?.click(); const set = (id, v) => { document.getElementById(id).value = v; };
      set("server", ${JSON.stringify(SERVER)}); set("username", "admin"); set("password", ${JSON.stringify(PASSWORD)}); document.getElementById("go").click(); return true; })()`);
    const con = await page(new RegExp(`^${SERVER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?!login|\\?surface)`));
    await until("the console", () => con.eval(`!!document.querySelector("#root > *")`), 60000);
    const mate = (await con.eval(`fetch("/api/mates").then((r) => r.json())`))[0];
    await con.eval(`window.hrhNative.mate.showAvatar(${JSON.stringify(mate.id)}).then(() => true)`);
    const ov = await page(/surface=mate-overlay/);
    await until("her small window shown", () => main(`return win("surface=mate-overlay")?.isVisible()`), 30000);
    await sleep(800);
    const b = await main(`return win("surface=mate-overlay").getContentBounds()`);
    console.log(`  her window: ${JSON.stringify(b)}`);

    step("she asks for the pointer: outside her window, where it is comes in, in her window's coordinates");
    await ov.eval(`(window.__pts = [], window.__off = window.hrhNative.cursor.onPoint((p) => window.__pts.push(p)), window.hrhNative.cursor.follow(true), true)`);
    const out = { x: Math.max(0, b.x - 300), y: Math.max(0, b.y - 200) };
    mouse(out.x, out.y);
    const first = await until("a point", async () => (await ov.eval(`window.__pts`))[0], 5000);
    assert.deepEqual(first, { x: out.x - b.x, y: out.y - b.y });
    await sleep(500);
    assert.equal((await ov.eval(`window.__pts.length`)), 1, "once per move, not every tick");
    mouse(out.x + 40, out.y + 10);
    await until("the next point", async () => (await ov.eval(`window.__pts.length`)) === 2, 5000);

    step("over her window: nothing from the feed (the page's own pointer events)");
    mouse(b.x + Math.floor(b.width / 2), b.y + Math.floor(b.height / 2));
    await sleep(600);
    assert.equal((await ov.eval(`window.__pts.length`)), 2);

    step("follow(false): nothing more");
    await ov.eval(`(window.hrhNative.cursor.follow(false), true)`);
    mouse(5, 5);
    await sleep(600);
    assert.equal((await ov.eval(`window.__pts.length`)), 2);
    console.log("OK");
  } finally {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
