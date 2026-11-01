// End-to-end check of the desktop Mate windows against a REAL server (the
// backend serving a frontend build), driven over the Chrome DevTools Protocol
// (pages) and the Node inspector (main process). Linux, headless:
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node test/e2e/mate-windows-e2e.js \
//     <server url> <password> [shots dir] [-- app binary]
//
// The app defaults to `electron .` from this checkout. A throwaway HOME is used.
// Checks: the quick card's one-line alignment, its fixed width + downward
// growth, its remembered (and clamped) place, the draft keeping it open with an
// ✕; the avatar window's resize frame (size kept per mate, across a restart),
// pan / zoom of the avatar (kept per mate); a mate's voice volume reaching the
// overlay from a save elsewhere (server push) and from the Voice tab's slider
// (live preview, back to the saved value when the tab closes).
//
// Window drags by -webkit-app-region need a window manager (Xvfb has none), so
// a user's drag of the quick card is stood in for by moving the window from the
// main process (the same 'move' events); the drag regions are checked by style.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const [SERVER, PASSWORD, SHOTS] = dash >= 0 ? argv.slice(0, dash) : argv;
const APP = dash >= 0 ? path.resolve(argv[dash + 1]) : null;
const SRC = path.join(__dirname, "..", "..", "src"); // (main-process checks need this checkout's sources: `electron .`)
if (!SERVER || !PASSWORD) {
  console.error("usage: node test/e2e/mate-windows-e2e.js <server url> <password> [shots dir] [-- app binary]");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

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

class App {
  constructor(home, port, iport) {
    Object.assign(this, { home, port, iport, pages: new Map() });
  }
  start() {
    const env = { ...process.env, HOME: this.home, XDG_CONFIG_HOME: path.join(this.home, ".config"), APPIMAGE_EXTRACT_AND_RUN: "1" };
    delete env.XDG_SESSION_TYPE;
    delete env.WAYLAND_DISPLAY;
    const args = ["--no-sandbox", `--remote-debugging-port=${this.port}`, `--inspect=${this.iport}`, "--disable-gpu"];
    const [cmd, all] = APP ? [APP, args] : [path.join(__dirname, "..", "..", "node_modules", ".bin", "electron"), [path.join(__dirname, "..", ".."), ...args]];
    this.proc = spawn(cmd, all, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.out = "";
    this.proc.stdout.on("data", (d) => (this.out += d));
    this.proc.stderr.on("data", (d) => (this.out += d));
    this.exited = new Promise((r) => this.proc.on("exit", r));
  }
  async stop() {
    for (const c of this.pages.values()) c.close();
    this.pages.clear();
    this.mainCdp?.close();
    this.mainCdp = null;
    // a quit request (SIGTERM to the app: it quits properly, storage written), then whatever is left
    try {
      process.kill(this.proc.pid, "SIGTERM");
    } catch {}
    await Promise.race([this.exited, sleep(8000)]);
    try {
      process.kill(-this.proc.pid, "SIGKILL");
    } catch {}
    await sleep(500);
  }
  async targets() {
    const r = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    return (await r.json()).filter((t) => t.type === "page");
  }
  /** a CDP session on the page whose URL matches (re-attached when the page changed) */
  async page(match) {
    const t = await until(`a page matching ${match}`, async () => (await this.targets()).find((x) => match.test(x.url)));
    const have = this.pages.get(String(match));
    if (have && have.id === t.id && have.ws.readyState === 1) return have;
    have?.close();
    const c = await new Cdp(t.webSocketDebuggerUrl).open();
    c.id = t.id;
    this.pages.set(String(match), c);
    return c;
  }
  /** evaluate in the MAIN process: `win(part)` finds a window by URL part */
  async main(body) {
    if (!this.mainCdp) {
      const t = await until("the main-process inspector", async () => (await (await fetch(`http://127.0.0.1:${this.iport}/json/list`)).json())[0]);
      this.mainCdp = await new Cdp(t.webSocketDebuggerUrl).open();
      await this.mainCdp.send("Runtime.enable");
    }
    const r = await this.mainCdp.send("Runtime.evaluate", {
      // (the inspector's command-line API has require(); src/ modules by absolute path = the app's instances)
      includeCommandLineAPI: true,
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
      const { BrowserWindow, screen } = require("electron");
      const settings = require(${JSON.stringify(path.join(SRC, "settings.js"))});
      const mateModule = () => require(${JSON.stringify(path.join(SRC, "mate.js"))});
      const win = (part) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(part));
      ${body}
    })()`,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  settings() {
    return JSON.parse(fs.readFileSync(path.join(this.home, ".config", "hr-harnessor", "settings.json"), "utf8"));
  }
}

const fill = (server, username, password) => `(() => {
  const set = (id, v) => { document.getElementById(id).value = v; };
  set("server", ${JSON.stringify(server)}); set("username", ${JSON.stringify(username)}); set("password", ${JSON.stringify(password)});
  document.getElementById("go").click();
  return true;
})()`;

// a recording speechSynthesis (window.__spoken: the texts, 400 ms each; cancel() ends the current one)
const FAKE_TTS = function () {
  window.__spoken = [];
  let cur = null;
  let timer = null;
  const end = () => {
    clearTimeout(timer);
    const u = cur;
    cur = null;
    if (u && u.onend) u.onend(new Event("end"));
  };
  const fake = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [], addEventListener() {}, removeEventListener() {}, pause() {}, resume() {},
    speak(u) {
      if (cur) end();
      cur = u;
      window.__spoken.push(u.text);
      setTimeout(() => u.onstart && u.onstart(new Event("start")), 0);
      timer = setTimeout(end, 400);
    },
    cancel() {
      if (cur) end();
    },
  };
  Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
};

// in a page: rects of the quick card's row
const QUICK_GEOM = `(() => {
  // the region in effect for an element: the nearest one declared on it or an ancestor (it is not inherited)
  const region = (el) => { for (; el; el = el.parentElement) { const v = getComputedStyle(el).getPropertyValue("-webkit-app-region"); if (v && v !== "none") return v; } return "none"; };
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height, cy: b.top + b.height / 2, w: b.width }; };
  const ta = document.querySelector('[data-testid="mate-input"]');
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight);
  const pt = parseFloat(cs.paddingTop);
  return {
    ta: r(ta), attach: r(document.querySelector('[data-testid="mate-attach"]')), mic: r(document.querySelector('[data-testid="mate-mic"]')),
    send: r(document.querySelector('[data-testid="mate-send"]')), thumb: r(document.querySelector('[data-testid="mate-quick-handle"]')),
    card: r(document.querySelector('[data-testid="mate-quick-card"]')),
    fontSize: cs.fontSize, lineHeight: lh, textCy: ta.getBoundingClientRect().top + pt + lh / 2,
    scrolls: ta.scrollHeight > ta.clientHeight + 1, docScrolls: document.documentElement.scrollHeight > innerHeight + 1,
    cardRegion: region(document.querySelector('[data-testid="mate-quick-handle"]')),
    composerRegion: region(document.querySelector('[data-testid="mate-input"]')),
    value: ta.value, pinned: document.querySelector('[data-testid="mate-quick"]').dataset.pinned,
    hasX: !!document.querySelector('[data-testid="mate-quick-close"]'),
  };
})()`;

async function typeLines(p, lines) {
  await p.eval(`document.querySelector('[data-testid="mate-input"]').focus(), true`);
  for (let i = 0; i < lines.length; i++) {
    if (i) {
      await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8, text: "\r", unmodifiedText: "\r" });
      await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
    }
    if (lines[i]) await p.send("Input.insertText", { text: lines[i] });
  }
}

async function clearInput(p) {
  await p.eval(`document.querySelector('[data-testid="mate-input"]').focus(), true`);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
}

async function main() {
  const server = SERVER.replace(/\/+$/, "");
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.homedir(), ".cache", "hrh-mate-e2e-"));
  const port = 9300 + Math.floor(Math.random() * 400);
  const iport = port + 500;
  let app = new App(home, port, iport);
  const consoleRe = new RegExp(`^${server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\?view=mate)?$`);
  try {
    app.start();
    const connect = await app.page(/connect\.html/);
    await until("the connect page", () => connect.eval(`!!window.hrhConnect && document.readyState === "complete"`));
    step("sign in through the connect screen");
    await connect.eval(fill(server, "admin", PASSWORD));
    let con = await app.page(consoleRe);
    await until("the console app", () => con.eval(`!!document.querySelector("#root > *")`));

    // a built-in mate with a body (video / photo), its voice on the browser engine so the Voice tab shows the volume
    const mates = await con.eval(`fetch("/api/mates").then((r) => r.json())`);
    const mate = mates.find((m) => m.avatar.kind === "video" || m.avatar.kind === "photo" || m.avatar.kind === "live2d") || mates[0];
    console.log(`  mate: ${mate.name} (${mate.id}, ${mate.avatar.kind})`);
    await con.eval(`fetch("/api/mates/${mate.id}", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: { volume: 1, auto_read: true, tts: { engine: "browser" } } }) }).then((r) => r.ok)`);

    // ── the quick card ──
    step("quick card: one line — the text centred in its box, +, text, mic and send in one row");
    await con.eval(`window.hrhNative.mate.setMate(${JSON.stringify(mate.id)}).then(() => window.hrhNative.mate.openQuick()).then(() => true)`);
    let quick = await app.page(/surface=mate-quick/);
    await until("the quick composer", () => quick.eval(`!!document.querySelector('[data-testid="mate-input"]')`));
    await until("the quick window visible", () => app.main(`return win("surface=mate-quick")?.isVisible()`));
    await sleep(600);
    const g1 = await quick.eval(QUICK_GEOM);
    console.log(`  one line: box ${g1.ta.h}px (text centre ${g1.textCy.toFixed(1)} vs box centre ${g1.ta.cy.toFixed(1)}), font ${g1.fontSize}, buttons ${g1.attach.h}/${g1.mic.h}/${g1.send.h}px`);
    near(g1.textCy, g1.ta.cy, 0.75, "the line's centre is the box's centre");
    for (const k of ["attach", "mic", "send", "thumb"]) near(g1[k].cy, g1.ta.cy, 1, `${k} centred with the text box`);
    near(g1.ta.h, g1.send.h, 0.5, "one line is as tall as the buttons");
    assert.equal(g1.fontSize, "13.5px", "no phone-size (16px) text in the desktop card");
    assert.equal(g1.scrolls, false, "no scrollbar in a one-line box");
    assert.equal(g1.docScrolls, false, "the page never scrolls");
    assert.equal(g1.cardRegion, "drag", "the card is the window's drag handle");
    assert.equal(g1.composerRegion, "no-drag", "the composer is not");
    const b1 = await app.main(`return win("surface=mate-quick").getBounds()`);
    assert.equal(b1.width, 640, "fixed width");
    near(b1.height, g1.card.h + 16, 2, "the window hugs the card");
    await quick.shot("quick-1-one-line.png");

    step("quick card: Shift+Enter lines grow it downwards at a fixed width (then it scrolls inside)");
    await typeLines(quick, ["우리", "둘째 줄", "셋째 줄"]);
    await sleep(700);
    const g3 = await quick.eval(QUICK_GEOM);
    const b3 = await app.main(`return win("surface=mate-quick").getBounds()`);
    console.log(`  3 lines: window ${b1.width}x${b1.height} → ${b3.width}x${b3.height}, box ${g1.ta.h} → ${g3.ta.h}px`);
    assert.equal(b3.width, 640, "the width stays");
    assert.equal(b3.x, b1.x, "left edge stays");
    assert.equal(b3.y, b1.y, "top edge stays");
    near(b3.height - b1.height, 40, 2, "two more lines = 40px taller");
    near(g3.ta.h, 72, 0.5, "the box holds 3 lines");
    near(g3.send.bottom, g3.ta.bottom, 1, "send stays level with the last line");
    await quick.shot("quick-2-three-lines.png");
    await typeLines(quick, ["", "4", "5", "6", "7", "8"]);
    await sleep(700);
    const g8 = await quick.eval(QUICK_GEOM);
    const b8 = await app.main(`return win("surface=mate-quick").getBounds()`);
    assert.equal(b8.width, 640);
    assert.ok(g8.ta.h <= 120.5 && g8.scrolls, `capped at 120px, then scrolls inside (${g8.ta.h}px, scrolls=${g8.scrolls})`);
    console.log(`  9 lines: window ${b8.width}x${b8.height}, box ${g8.ta.h}px scrolling`);

    step("quick card: a draft keeps it open on a click elsewhere, with an ✕");
    assert.equal(g8.pinned, "true");
    assert.ok(g8.hasX, "the ✕ is shown");
    // (a click elsewhere: the window loses focus — without a window manager the blur is emitted by hand)
    await app.main(`win("surface=mate-quick").emit("blur"); return true`);
    await sleep(500);
    assert.equal(await app.main(`return win("surface=mate-quick").isVisible()`), true, "still open after the blur");
    await quick.shot("quick-3-draft-pinned.png");
    const x = await quick.eval(`(() => { const b = document.querySelector('[data-testid="mate-quick-close"]').getBoundingClientRect(); const c = document.querySelector('[data-testid="mate-quick-card"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, inCorner: b.right > c.right - 4 && b.top < c.top + 4, region: getComputedStyle(document.querySelector('[data-testid="mate-quick-close"]')).getPropertyValue("-webkit-app-region") }; })()`);
    assert.ok(x.inCorner, "the ✕ sits on the card's top-right corner");
    assert.equal(x.region, "no-drag");
    await quick.mouse("mousePressed", x.x, x.y);
    await quick.mouse("mouseReleased", x.x, x.y);
    await until("the ✕ closes it", async () => !(await app.main(`return win("surface=mate-quick").isVisible()`)));
    step("quick card: reopened, the draft is still there");
    await con.eval(`window.hrhNative.mate.openQuick().then(() => true)`);
    await until("visible again", () => app.main(`return win("surface=mate-quick").isVisible()`));
    await sleep(500);
    assert.match((await quick.eval(QUICK_GEOM)).value, /^우리\n둘째 줄/);
    step("quick card: empty → a click elsewhere hides it at once");
    await clearInput(quick);
    await sleep(400);
    const g0 = await quick.eval(QUICK_GEOM);
    assert.equal(g0.value, "");
    assert.equal(g0.pinned, "false");
    assert.equal(g0.hasX, false, "no ✕ without a draft");
    const b0 = await app.main(`return win("surface=mate-quick").getBounds()`);
    near(b0.height, b1.height, 1, "back to one line");
    await app.main(`win("surface=mate-quick").emit("blur"); return true`);
    await until("hidden on blur", async () => !(await app.main(`return win("surface=mate-quick").isVisible()`)));

    step("quick card: where it is dragged is where it opens (and a place off every display is pulled back)");
    await con.eval(`window.hrhNative.mate.openQuick().then(() => true)`);
    await until("visible", () => app.main(`return win("surface=mate-quick").isVisible()`));
    await sleep(500);
    await app.main(`win("surface=mate-quick").setPosition(210, 640); return true`); // (a user's drag: the same 'move')
    await sleep(800);
    assert.deepEqual(app.settings().mateQuickPos, { x: 210, y: 640 }, "saved in settings.json");
    await quick.eval(`window.hrhNative.mate.closeQuick().then(() => true)`);
    await sleep(300);
    await con.eval(`window.hrhNative.mate.openQuick().then(() => true)`);
    await until("visible", () => app.main(`return win("surface=mate-quick").isVisible()`));
    const bp = await app.main(`return win("surface=mate-quick").getBounds()`);
    assert.equal(bp.x, 210);
    assert.equal(bp.y, 640);
    await app.main(`settings.writeSettings({ mateQuickPos: { x: 5000, y: 5000 } }); return true`);
    await quick.eval(`window.hrhNative.mate.closeQuick().then(() => true)`);
    await sleep(300);
    await con.eval(`window.hrhNative.mate.openQuick().then(() => true)`);
    await until("visible", () => app.main(`return win("surface=mate-quick").isVisible()`));
    const bo = await app.main(`const b = win("surface=mate-quick").getBounds(); const a = screen.getPrimaryDisplay().workArea; return { b, a }`);
    assert.ok(bo.b.x >= bo.a.x && bo.b.x + bo.b.width <= bo.a.x + bo.a.width && bo.b.y + bo.b.height <= bo.a.y + bo.a.height, `on screen: ${JSON.stringify(bo)}`);
    await quick.eval(`window.hrhNative.mate.closeQuick().then(() => true)`);

    // ── the avatar window ──
    step("avatar: shown; move mode draws the page's own move bar + resize frame (no whole-page drag)");
    await con.eval(`window.hrhNative.mate.showAvatar(${JSON.stringify(mate.id)}).then(() => true)`);
    let ov = await app.page(/surface=mate-overlay/);
    await until("the overlay", () => ov.eval(`!!document.querySelector('[data-testid="mate-overlay"]')`));
    await until("the avatar window shown", () => app.main(`return win("surface=mate-overlay")?.isVisible()`));
    await sleep(800);
    const a0 = await app.main(`return win("surface=mate-overlay").getBounds()`);
    console.log(`  avatar window ${JSON.stringify(a0)}`);
    await con.eval(`window.hrhNative.mate.setMoveMode(true).then(() => true)`);
    await until("the resize frame", () => ov.eval(`!!document.querySelector('[data-testid="mate-resize-frame"]')`));
    const m = await ov.eval(`({ own: document.documentElement.dataset.hrhOwnMove, body: getComputedStyle(document.body).getPropertyValue("-webkit-app-region"), bar: !!document.querySelector('[data-testid="mate-move-bar"]'), interactive: document.querySelector('[data-testid="mate-overlay"]').dataset.interactive })`);
    assert.equal(m.own, "1");
    assert.notEqual(m.body, "drag", "the injected whole-page drag CSS stays off for this page");
    assert.ok(m.bar);
    assert.equal(m.interactive, "true");
    await ov.shot("avatar-1-move-mode.png");

    step("avatar: drag the move bar → the window moves (and its place is saved)");
    const bar = await ov.eval(`(() => { const b = document.querySelector('[data-testid="mate-move-bar"]').getBoundingClientRect(); return { x: b.left + 14, y: b.top + b.height / 2 }; })()`);
    await ov.drag(bar.x, bar.y, bar.x - 400, bar.y - 300, 10);
    await sleep(700);
    const am = await app.main(`return win("surface=mate-overlay").getBounds()`);
    console.log(`  moved: ${a0.x},${a0.y} → ${am.x},${am.y}`);
    near(am.x - a0.x, -400, 4, "400px left");
    near(am.y - a0.y, -300, 4, "300px up");
    assert.equal(am.width, a0.width, "same size");
    await until("place saved", () => app.settings().mateBounds?.x === am.x);

    step("avatar: drag the south-east corner → the window grows; the size is kept for this mate");
    const se = await ov.eval(`(() => { const b = document.querySelector('[data-testid="mate-resize-se"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await ov.drag(se.x, se.y, se.x + 80, se.y + 60);
    await sleep(700);
    const a1 = await app.main(`return win("surface=mate-overlay").getBounds()`);
    console.log(`  resized: ${am.width}x${am.height} → ${a1.width}x${a1.height}`);
    near(a1.width - am.width, 80, 3, "80px wider");
    near(a1.height - am.height, 60, 3, "60px taller");
    assert.equal(a1.x, am.x, "the left edge stays (east edge dragged)");
    assert.equal(a1.y, am.y, "the top edge stays (south edge dragged)");
    await until("saved", () => app.settings().mateSizes?.[mate.id]?.width === a1.width);
    step("avatar: drag the north-west corner inwards → smaller, the bottom-right corner stays");
    const nw = await ov.eval(`(() => { const b = document.querySelector('[data-testid="mate-resize-nw"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await ov.drag(nw.x, nw.y, nw.x + 30, nw.y + 20);
    await sleep(700);
    const a2 = await app.main(`return win("surface=mate-overlay").getBounds()`);
    console.log(`  resized: ${a1.width}x${a1.height} → ${a2.width}x${a2.height}`);
    assert.ok(a2.width < a1.width && a2.height < a1.height, "smaller");
    near(a2.x + a2.width, a1.x + a1.width, 3, "right edge stays");
    near(a2.y + a2.height, a1.y + a1.height, 3, "bottom edge stays");
    await until("saved", () => app.settings().mateSizes?.[mate.id]?.width === a2.width);

    step("avatar: drag on the avatar pans it, the wheel zooms; kept per mate");
    const area = await ov.eval(`(() => { const b = document.querySelector('[data-testid="mate-avatar-area"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; })()`);
    await ov.drag(area.x, area.y, area.x + 40, area.y + 30);
    await sleep(300);
    let view = (await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.view`)).split(",").map(Number);
    near(view[0], 40 / area.w, 0.01, "panned right");
    near(view[1], 30 / area.h, 0.01, "panned down");
    await ov.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: area.x, y: area.y, deltaX: 0, deltaY: -300 });
    await sleep(500);
    view = (await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.view`)).split(",").map(Number);
    console.log(`  view after pan + zoom: ${view}`);
    assert.ok(view[2] > 1.3, "zoomed in");
    const transform = await ov.eval(`(document.querySelector('[data-mate-view]') || {}).style?.transform || (document.querySelector('[data-mate-body="live2d"]') ? "live2d" : "")`);
    assert.ok(/translate|live2d/.test(transform), `the body follows the view (${transform})`);
    await ov.shot("avatar-2-panned-zoomed.png");
    const stored = await ov.eval(`localStorage.getItem("hrh.mate.view.${mate.id}")`);
    assert.ok(stored && JSON.parse(stored).z > 1.3, "persisted under the mate's view key");

    step("avatar: Done → the frame goes; the window ignores the mouse again (click-through)");
    await ov.eval(`document.querySelector('[data-testid="mate-move-done"]').click(), true`);
    await until("no frame", async () => !(await ov.eval(`!!document.querySelector('[data-testid="mate-resize-frame"]')`)));
    assert.equal(await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.interactive`), "false");
    await ov.shot("avatar-3-click-through.png");

    // ── voice volume across windows ──
    step("volume: saved elsewhere (another device / tab) → the overlay follows (server push)");
    assert.equal(await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.voiceVolume`), "1");
    const t0 = Date.now();
    await con.eval(`fetch("/api/mates/${mate.id}", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: { volume: 0.3 } }) }).then((r) => r.ok)`);
    await until("the overlay at 30 %", async () => (await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.voiceVolume`)) === "0.3", 3000);
    console.log(`  overlay at 0.3 after ${Date.now() - t0} ms`);

    step("volume: the Voice tab's slider previews live in the overlay, the saved value comes back when the tab closes");
    await con.eval(`localStorage.setItem("hrh_mate_active", ${JSON.stringify(mate.id)}); location.href = "/?view=mate"; true`).catch(() => {});
    await sleep(1500);
    con = await app.page(consoleRe);
    await until("the Mate view", () => con.eval(`!!document.querySelector('[data-testid="mate-settings-open"]')`));
    await con.eval(`document.querySelector('[data-testid="mate-settings-open"]').click(), true`);
    await until("Mate settings", () => con.eval(`!!document.querySelector('[data-testid="mate-tab-voice"]')`));
    await con.eval(`document.querySelector('[data-testid="mate-tab-voice"]').click(), true`);
    await until("the volume slider", () => con.eval(`!!document.querySelector('[data-testid="mate-volume-slider"]')`));
    const setSlider = (v) => con.eval(`(() => { const el = document.querySelector('[data-testid="mate-volume-slider"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(String(v))});
      el.dispatchEvent(new Event("input", { bubbles: true })); return el.value; })()`);
    const sliderMax = await con.eval(`document.querySelector('[data-testid="mate-volume-slider"]').max`);
    const scale = Number(sliderMax) > 10 ? 100 : 1; // (percent or fraction)
    await setSlider(1.5 * scale);
    await until("the overlay previewing 1.5", async () => Number(await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.voiceVolume`)) === 1.5, 2000);
    await setSlider(0.6 * scale);
    await until("the overlay previewing 0.6", async () => Number(await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.voiceVolume`)) === 0.6, 2000);
    await con.shot("console-voice-tab.png");
    await con.eval(`document.querySelector('[data-testid="mate-settings-close"]').click(), true`);
    await until("back on the saved 0.3", async () => (await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.voiceVolume`)) === "0.3", 2000);

    // ── one voice: overlay + mate chat window + console Mate view (needs a server whose mate answers: fake-claude.py) ──
    step("one voice: the overlay, the mate chat window and the console's Mate view — a reply is read once, by the overlay");
    await con.eval(`window.hrhNative.mate.openChat().then(() => true)`);
    let chatw = await app.page(/surface=mate-chat/);
    await until("the chat window", () => chatw.eval(`!!document.querySelector('[data-testid="mate-input"]')`));
    // the browser voice recorded instead of spoken (each page reloads with the stub)
    for (const [re, ready] of [[/surface=mate-overlay/, "mate-overlay"], [/surface=mate-chat/, "mate-input"], [consoleRe, "mate-settings-open"]]) {
      const p = await app.page(re);
      await p.send("Page.enable");
      await p.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${FAKE_TTS})()` });
      // (the console drops ?view= from its URL once read: back to the Mate view explicitly)
      await p.eval(ready === "mate-settings-open" ? `location.href = "/?view=mate", true` : `location.reload(), true`).catch(() => {});
      await sleep(500);
      const q = await app.page(re);
      await until(`${ready} after reload`, () => q.eval(`!!document.querySelector('[data-testid="${ready}"]') && !!window.__spoken`), 20000);
    }
    ov = await app.page(/surface=mate-overlay/);
    chatw = await app.page(/surface=mate-chat/);
    con = await app.page(consoleRe);
    await sleep(1500);
    const spokenIn = async (p, n) => (await p.eval(`window.__spoken`).catch(() => [])).filter((t) => t.startsWith(`Reply ${n} `)).map((t) => Number(/number (\d)/.exec(t)[1]));
    const ask = async (text) => {
      await chatw.eval(`document.querySelector('[data-testid="mate-input"]').focus(), true`);
      await chatw.send("Input.insertText", { text });
      await chatw.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await chatw.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    };
    await ask("q1 hello there");
    const n1 = 1;
    await until("the reply read by the overlay", async () => (await spokenIn(ov, n1)).length >= 5, 20000);
    await sleep(1000);
    const r1 = { overlay: await spokenIn(ov, n1), chat: await spokenIn(chatw, n1), console: await spokenIn(con, n1) };
    console.log(`  read per window: ${JSON.stringify(r1)}`);
    assert.deepEqual(r1, { overlay: [1, 2, 3, 4, 5], chat: [], console: [] });

    step("one voice: the avatar hidden mid-reply → the mate chat window (used last) goes on from the next sentence");
    await ask("q2 and again");
    await until("2 sentences read by the overlay", async () => (await spokenIn(ov, 2)).length >= 2, 20000);
    const first = await spokenIn(ov, 2);
    await con.eval(`window.hrhNative.mate.hideAvatar().then(() => true)`);
    await until("the rest read", async () => (await spokenIn(chatw, 2)).includes(5), 20000);
    await sleep(800);
    const rest = await spokenIn(chatw, 2);
    console.log(`  overlay read ${JSON.stringify(first)}, then the chat window ${JSON.stringify(rest)}, the console ${JSON.stringify(await spokenIn(con, 2))}`);
    assert.ok(rest[0] > first[first.length - 1], "went on after the last sentence started");
    assert.equal(new Set([...first, ...rest]).size, first.length + rest.length, "no sentence twice");
    assert.deepEqual(await spokenIn(con, 2), []);
    await con.eval(`window.hrhNative.mate.closeChat().then(() => window.hrhNative.mate.showAvatar(${JSON.stringify(mate.id)})).then(() => true)`);
    ov = await app.page(/surface=mate-overlay/);
    await until("the overlay back", () => ov.eval(`!!document.querySelector('[data-testid="mate-overlay"]')`), 20000);
    await until("the avatar window shown", () => app.main(`return win("surface=mate-overlay")?.isVisible()`));
    console.log(`  shown again: view ${await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.view`)}, stored ${await ov.eval(`localStorage.getItem("hrh.mate.view.${mate.id}")`)}`);

    // ── a restart keeps the avatar's size and view ──
    step("restart: the avatar window keeps the size the user gave it, and the avatar its pan / zoom");
    await app.stop();
    app = new App(home, port, iport);
    app.start();
    ov = await app.page(/surface=mate-overlay/);
    await until("the overlay", () => ov.eval(`!!document.querySelector('[data-testid="mate-overlay"]')`), 30000);
    await until("the avatar window shown", () => app.main(`return win("surface=mate-overlay")?.isVisible()`), 30000);
    await sleep(1500);
    const a3 = await app.main(`return win("surface=mate-overlay").getBounds()`);
    assert.equal(a3.width, a2.width, "width kept (the page's suggested size does not win)");
    assert.equal(a3.height, a2.height, "height kept");
    const v3 = (await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.view`)).split(",").map(Number);
    console.log(`  after restart: view ${v3}, stored ${await ov.eval(`localStorage.getItem("hrh.mate.view.${mate.id}")`)}, active ${await ov.eval(`localStorage.getItem("hrh_mate_active")`)}, keys ${await ov.eval(`Object.keys(localStorage).join(",")`)}`);
    near(v3[2], view[2], 0.001, "zoom kept");
    near(v3[0], view[0], 0.001, "pan kept");
    await app.main(`BrowserWindow.getAllWindows().forEach((w) => { if (!w.webContents.getURL().includes("surface=")) w.hide(); }); return true`);
    await ov.shot("avatar-4-after-restart.png");

    step("tray → Reset Mate position & size: back to the fitted view and the page's size");
    await app.main(`mateModule().resetPlacement(); return true`);
    await until("the view back home", async () => (await ov.eval(`document.querySelector('[data-testid="mate-overlay"]').dataset.view`)) === "0.0000,0.0000,1.0000");
    await sleep(800);
    const a4 = await app.main(`return win("surface=mate-overlay").getBounds()`);
    assert.equal(a4.height, 400, "the page's suggested size again");
    assert.equal(app.settings().mateSizes?.[mate.id], undefined, "the user size is forgotten");
    assert.equal(await ov.eval(`localStorage.getItem("hrh.mate.view.${mate.id}")`), null);
    assert.equal(app.settings().mateQuickPos, undefined);
    console.log("\nMATE WINDOWS E2E OK");
  } catch (e) {
    console.error(`\nMATE WINDOWS E2E FAILED: ${e.stack || e}`);
    try {
      console.error(`pages: ${JSON.stringify((await app.targets()).map((t) => t.url))}`);
    } catch {}
    if (app && app.out) console.error(`--- app output (tail) ---\n${app.out.slice(-3000)}`);
    process.exitCode = 1;
  } finally {
    if (app && app.proc) await app.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main();
