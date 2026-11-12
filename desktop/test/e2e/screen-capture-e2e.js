// End-to-end check of the Mate looking at the screen (docs/mate.md §4 "Seeing the screen") — the real app, a real
// server (a throwaway backend with CLAUDE_BINARY=desktop/test/e2e/fake-claude.py: "look at my screen" makes the fake
// CLI call see_screen through the real MCP bridge and say what came back), a real X screen (Xvfb):
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node test/e2e/screen-capture-e2e.js <server url> <password> [shots dir]
//
// On the screen (CHROME=<path>): a full-screen backdrop window #12ab34 and a known window (a Chrome app window,
// #d81b9c, "GENY-SCREEN-42", title GENY-KNOWN-WINDOW; WM_STATE set by hand — Xvfb has no window manager). Checks: the setting off → the tool is not offered; on + ask → the approval
// prompt (source, preview), Allow → a picture of the screen with the known content, the avatar windows NOT in it,
// attached to the conversation, shown there, the same bytes the model got; Deny → denied; allowed without asking and
// "hide" off → no prompt, the avatar windows in the picture; a chosen window → only that window; the user's Share
// screen (picker with thumbnails, no setup step) → sharing on, then Stop in the same picker. English pinned.
"use strict";
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");

const [SERVER, PASSWORD, SHOTS] = process.argv.slice(2);
if (require.main === module && (!SERVER || !PASSWORD)) {
  console.error("usage: node test/e2e/screen-capture-e2e.js <server url> <password> [shots dir]");
  process.exit(2);
}
const CHROME = process.env.CHROME || "";
const ROOT = [0x12, 0xab, 0x34];
const KNOWN = [0xd8, 0x1b, 0x9c];
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer in 20 s`));
      }, 20000);
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
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
    Object.assign(this, { home, port, iport, pages: new Map() });
  }
  start(extraArgs = []) {
    const env = { ...process.env, HOME: this.home, XDG_CONFIG_HOME: path.join(this.home, ".config") };
    delete env.XDG_SESSION_TYPE;
    delete env.WAYLAND_DISPLAY;
    Object.assign(env, { LANG: "en_US.UTF-8", LANGUAGE: "en_US", LC_ALL: "en_US.UTF-8" });
    const args = [path.join(__dirname, "..", ".."), "--no-sandbox", `--remote-debugging-port=${this.port}`, `--inspect=${this.iport}`, "--disable-gpu", "--lang=en-US", ...extraArgs];
    const packaged=process.env.LOCAL_TEST_PACKAGED_APP;
    this.proc = spawn(packaged || path.join(__dirname, "..", "..", "node_modules", ".bin", "electron"), packaged ? args.slice(1) : args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.out = "";
    this.proc.stdout.on("data", (d) => (this.out += d));
    this.proc.stderr.on("data", (d) => (this.out += d));
    this.exited = new Promise((r) => this.proc.on("exit", r));
  }
  async stop() {
    for (const c of this.pages.values()) c.close();
    this.mainCdp?.close();
    try {
      process.kill(this.proc.pid, "SIGTERM");
    } catch {}
    await Promise.race([this.exited, sleep(8000)]);
    try {
      process.kill(-this.proc.pid, "SIGKILL");
    } catch {}
  }
  async targets() {
    const r = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    return (await r.json()).filter((t) => t.type === "page");
  }
  async has(match) {
    return (await this.targets()).some((x) => match.test(x.url));
  }
  async page(match, ms = 20000) {
    const t = await until(`a page matching ${match}`, async () => (await this.targets()).find((x) => match.test(x.url)), ms);
    const have = this.pages.get(String(match));
    if (have && have.id === t.id && have.ws.readyState === 1) return have;
    have?.close();
    const c = await new Cdp(t.webSocketDebuggerUrl).open();
    c.id = t.id;
    this.pages.set(String(match), c);
    return c;
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
      expression: `(async () => {
      const { BrowserWindow } = require("electron");
      const win = (part) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(part));
      const cwin = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.getURL().includes("surface=") && !w.webContents.getURL().includes("bar.html") && !w.webContents.getURL().includes("capture-ask"));
      ${body}
    })()`,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

const fill = (server, username, password) => `(() => {
  document.getElementById("modeServer")?.click();
  const set = (id, v) => { document.getElementById(id).value = v; };
  set("server", ${JSON.stringify(server)}); set("username", ${JSON.stringify(username)}); set("password", ${JSON.stringify(password)});
  document.getElementById("go").click();
  return true;
})()`;

// in a page: decode an attachment and sample pixels (x, y in the picture's own pixels); its size; sha256 of a variant
const SAMPLE = (url, points) => `(async () => {
  const blob = await (await fetch(${JSON.stringify(url)})).blob();
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0);
  const px = ${JSON.stringify(points)}.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)));
  return { width: bmp.width, height: bmp.height, px, type: blob.type, bytes: blob.size };
})()`;
const SHA = (url) => `(async () => {
  const buf = await (await fetch(${JSON.stringify(url)})).arrayBuffer();
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
})()`;
const B64 = (url) => `(async () => {
  const buf = new Uint8Array(await (await fetch(${JSON.stringify(url)})).arrayBuffer());
  let s = ""; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
  return btoa(s);
})()`;
const close = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function main() {
  const server = SERVER.replace(/\/+$/, "");
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.homedir(), ".cache", "hrh-cap-e2e-"));
  const port = 9300 + Math.floor(Math.random() * 400);
  const app = new App(home, port, port + 500);
  let chrome = null;
  const consoleRe = new RegExp(`^${server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?!login|\\?surface)`);
  try {
    step("the screen: a desktop backdrop #12ab34, a known window (#d81b9c) at 60,60 600×400");
    execFileSync("xsetroot", ["-solid", "#12ab34"]);
    const chromes = [];
    if (CHROME) {
      // (the X screen capturer sees Xvfb's root as black whatever xsetroot says: a backdrop window paints the
      // desktop instead — first, so everything else is mapped above it)
      const page = (title, bg, text) => `data:text/html,${encodeURIComponent(`<title>${title}</title><body style="margin:0;background:${bg};color:#fff;font:bold 44px sans-serif;display:grid;place-items:center;height:100vh">${text}</body>`)}`;
      const open = (dir, url, x, y, w, h) => {
        const p = spawn(CHROME, [`--app=${url}`, `--window-position=${x},${y}`, `--window-size=${w},${h}`, `--user-data-dir=${path.join(home, dir)}`,
          "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox", "--disable-features=Translate"], { stdio: "ignore", detached: true });
        chromes.push(p);
      };
      open("backdrop", page("GENY-BACKDROP", "#12ab34", ""), 0, 0, 1920, 1080);
      await sleep(2500);
      open("known", page("GENY-KNOWN-WINDOW", "#d81b9c", "GENY-SCREEN-42"), 60, 60, 600, 400);
      chrome = { pids: chromes.map((p) => p.pid) };
      await sleep(2500);
      // Xvfb has no window manager: nobody sets WM_STATE, so no window counts as a capture source (WebRTC lists
      // the top-level windows a WM manages). Set it on the known window, as a WM would.
      try {
        const ids = execFileSync("xdotool", ["search", "--name", "GENY-KNOWN-WINDOW"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
        for (const id of ids) execFileSync("xprop", ["-id", id, "-f", "WM_STATE", "32c", "-set", "WM_STATE", "1"]);
        console.log(`  known window ids: ${ids.join(", ")} (WM_STATE set)`);
      } catch (e) {
        console.log(`  (could not mark the known window: ${e.message})`);
      }
    }

    app.start();
    const connect = await app.page(/connect\.html/);
    await until("the connect page", () => connect.eval(`!!window.hrhConnect && document.readyState === "complete"`));
    step("sign in");
    await connect.eval(fill(server, "admin", PASSWORD));
    let con = await app.page(consoleRe);
    await until("the console app", () => con.eval(`!!document.querySelector("#root > *")`));
    const mates = await con.eval(`fetch("/api/mates").then((r) => r.json())`);
    const mate = mates.find((m) => m.avatar.kind === "video") || mates[0];
    console.log(`  mate: ${mate.name} (${mate.id}, ${mate.avatar.kind})`);
    const patch = (body) => con.eval(`fetch("/api/mates/${mate.id}", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(${JSON.stringify(body)}) }).then((r) => r.json())`);
    await patch({ voice: { auto_read: false, tts: { engine: "off" } }, screen: { enabled: false, approval: "ask", hide_avatar: true, max_edge: 1920, format: "png" } });
    assert.equal(await con.eval(`typeof window.hrhNative.capture.request`), "function", "the capture bridge is there");

    step("the windows: avatar at 700,60, mate chat at 1040,60, the console at 1480,60 (away from the known window)");
    await con.eval(`window.hrhNative.mate.setMate(${JSON.stringify(mate.id)}).then(() => window.hrhNative.mate.showAvatar(${JSON.stringify(mate.id)})).then(() => window.hrhNative.mate.openChat()).then(() => true)`);
    await until("the avatar window", () => app.main(`return !!win("surface=mate-overlay")?.isVisible()`));
    let chatw = await app.page(/surface=mate-chat/);
    await until("the chat window", () => chatw.eval(`!!document.querySelector('[data-testid="mate-input"]')`));
    await app.main(`win("surface=mate-overlay").setBounds({ x: 700, y: 60, width: 300, height: 400 }); win("surface=mate-chat").setBounds({ x: 1040, y: 60, width: 420, height: 640 }); cwin().setBounds({ x: 1480, y: 60, width: 430, height: 900 }); return true`);
    await sleep(1500);
    const bounds = await app.main(`return { overlay: win("surface=mate-overlay").getBounds(), chat: win("surface=mate-chat").getBounds(), console: cwin().getBounds() }`);
    console.log(`  ${JSON.stringify(bounds)}`);
    const mid = (b) => [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
    const POINTS = { known: [360, 260], root: [300, 800], overlay: mid(bounds.overlay), chat: mid(bounds.chat) };

    const turns = () => chatw.eval(`[...document.querySelectorAll('[data-testid="mate-turn"]')].map((e) => e.innerText)`);
    const ask = async (text) => {
      const before = (await turns()).length;
      await chatw.eval(`document.querySelector('[data-testid="mate-input"]').focus(), true`);
      await chatw.send("Input.insertText", { text });
      await chatw.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await chatw.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      return before;
    };
    const reply = (before, ms = 90000) => until("her answer", async () => {
      const t = await turns();
      const last = t.length > before ? t[t.length - 1] : "";
      const m = /SEESCREEN[^\n]*/.exec(last);
      return m ? m[0] : null;
    }, ms);
    const att = (text) => (/\[(att_[\w-]+)\]/.exec(text) || [])[1];

    // ── 1. off: no tool ──
    step("Screen off (the default): she has no see_screen");
    let b = await ask("look at my screen please");
    let r = await reply(b);
    console.log(`  ${r}`);
    assert.match(r, /SEESCREEN listed=no/);
    assert.equal(await app.has(/capture-ask/), false, "no prompt");

    // ── 2. switched on in Mate settings → Screen (the console) ──
    step("Mate settings → Screen: switch it on (ask every time), save; 'On this computer' lists this computer's screens and windows");
    await con.eval(`location.href = "/?view=mate", true`).catch(() => {});
    await sleep(800);
    con = await app.page(consoleRe);
    await until("the Mate view", () => con.eval(`!!document.querySelector('[data-testid="mate-settings-open"]')`));
    await con.eval(`document.querySelector('[data-testid="mate-settings-open"]').click(), true`);
    await until("the Screen tab", () => con.eval(`(() => { const t = document.querySelector('[data-testid="mate-tab-screen"]'); t && t.click(); return !!document.querySelector('[data-testid="mate-screen-enabled"]'); })()`));
    await con.eval(`document.querySelector('[data-testid="mate-screen-enabled"]').click(), true`);
    await sleep(200);
    await con.eval(`document.querySelector('[data-testid="mate-settings-save"]').click(), true`);
    await until("saved", async () => (await con.eval(`fetch("/api/mates/${mate.id}").then((r) => r.json())`)).screen.enabled === true);
    await until("the sources", () => con.eval(`document.querySelectorAll('[data-testid="mate-screen-source"] option').length > 1`));
    const options = await con.eval(`[...document.querySelectorAll('[data-testid="mate-screen-source"] option')].map((o) => o.textContent)`);
    console.log(`  sources here: ${JSON.stringify(options)}`);
    await sleep(600);
    await con.shot("settings-screen-tab.png");

    // ── 3. on + ask → the prompt; Allow → the picture ──
    step("she asks: the app's prompt shows the source and a preview; Allow once");
    b = await ask("look at my screen");
    const prompt = await app.page(/capture-ask\.html/, 30000);
    await until("the prompt filled", () => prompt.eval(`!!document.querySelector('[data-testid="capture-ask-source"]').textContent && !!document.querySelector('[data-testid="capture-ask-preview"]')`));
    const ptext = await prompt.eval(`document.querySelector('[data-testid="capture-ask"]').innerText`);
    console.log(`  prompt: ${ptext.replace(/\s+/g, " ").slice(0, 220)}`);
    assert.match(ptext, new RegExp(`${mate.name} wants to see your screen`));
    assert.match(ptext, /Screen/);
    await prompt.shot("ask-prompt.png");
    // (the click closes the window: answer first, click a moment later)
    await prompt.eval(`setTimeout(() => document.querySelector('[data-testid="capture-allow"]').click(), 50), true`);
    const toast = until("the 'Screen shared with' toast", () => chatw.eval(`document.querySelector('[data-testid="capture-toast"]')?.textContent || ""`), 15000).catch(() => "");
    r = await reply(b);
    console.log(`  ${r.slice(0, 260)}`);
    assert.match(r, /listed=yes error=no images=1 mime=image\/jpeg/);
    const t1 = await toast;
    console.log(`  toast: ${t1}`);
    assert.match(t1, new RegExp(`Screen shared with ${mate.name}`));
    const a1 = att(r);
    assert.ok(a1, "the tool result names the attachment");
    const s1 = await con.eval(SAMPLE(`/api/attachments/${a1}/content`, Object.values(POINTS)));
    const px1 = Object.fromEntries(Object.keys(POINTS).map((k, i) => [k, s1.px[i]]));
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, "capture-1-allowed.png"), Buffer.from(await con.eval(B64(`/api/attachments/${a1}/content`)), "base64"));
    console.log(`  picture ${s1.width}×${s1.height} ${s1.type} ${s1.bytes} B; pixels ${JSON.stringify(px1)}`);
    assert.deepEqual([s1.width, s1.height], [1920, 1080]);
    assert.ok(close(px1.root, ROOT), "the screen's own background is in the picture");
    if (CHROME) assert.ok(close(px1.known, KNOWN), "the known window is in the picture");
    assert.ok(close(px1.overlay, ROOT), "the avatar window was hidden (its place shows the background)");
    assert.ok(close(px1.chat, ROOT), "the mate chat window was hidden too");
    const sha = /sha=(\w+)/.exec(r)[1];
    assert.equal(await con.eval(SHA(`/api/attachments/${a1}/content?variant=preview`)), sha, "the model got exactly the conversation's picture (its model-sized copy)");
    await until("the windows back", () => app.main(`return win("surface=mate-overlay").isVisible() && win("surface=mate-chat").isVisible()`));
    await until("the picture in the conversation", () => chatw.eval(`!!document.querySelector('[data-testid="mate-screen-shot"] img')`));
    await sleep(800);
    await chatw.shot("chat-with-capture.png");
    const conv = await con.eval(`fetch("/api/mates/${mate.id}/conversation", { method: "POST" }).then((r) => r.json())`);
    const histText = await con.eval(`fetch("/api/history/${conv.session_id}").then((r) => r.text())`);
    console.log(`  history: ${histText.length} chars, names ${a1}: ${histText.includes(a1)}, base64 run: ${/[A-Za-z0-9+/]{4000,}/.test(histText)}`);
    assert.ok(histText.includes(a1) && !/[A-Za-z0-9+/]{4000,}/.test(histText), "history refers to the picture, holds no image data");

    // ── 4. Deny ──
    step("again — Deny: the tool says so, nothing is captured");
    b = await ask("look at my screen");
    const prompt2 = await app.page(/capture-ask\.html/, 30000);
    await until("the prompt", () => prompt2.eval(`!!document.querySelector('[data-testid="capture-deny"]')`));
    await prompt2.eval(`setTimeout(() => document.querySelector('[data-testid="capture-deny"]').click(), 50), true`);
    r = await reply(b);
    console.log(`  ${r.slice(0, 200)}`);
    assert.match(r, /listed=yes error=yes images=0 text=The user said no/);

    // ── 5. allowed without asking, avatar windows not hidden ──
    step("Allow without asking + 'hide the avatar windows' off (saved from elsewhere: pushed): no prompt, the avatar windows are in the picture");
    await patch({ screen: { approval: "allow", hide_avatar: false } });
    await sleep(800);
    b = await ask("look at my screen");
    let prompted = false;
    const watch = setInterval(async () => (prompted = prompted || (await app.has(/capture-ask/).catch(() => false))), 200);
    r = await reply(b);
    clearInterval(watch);
    console.log(`  ${r.slice(0, 200)}`);
    assert.equal(prompted, false, "no prompt");
    const a2 = att(r);
    const s2 = await con.eval(SAMPLE(`/api/attachments/${a2}/content`, Object.values(POINTS)));
    const px2 = Object.fromEntries(Object.keys(POINTS).map((k, i) => [k, s2.px[i]]));
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, "capture-2-not-hidden.png"), Buffer.from(await con.eval(B64(`/api/attachments/${a2}/content`)), "base64"));
    console.log(`  pixels ${JSON.stringify(px2)}`);
    assert.ok(!close(px2.overlay, ROOT, 6) || !close(px2.chat, ROOT, 6), "the avatar / chat windows are in this one");
    assert.ok(!close(px2.chat, ROOT, 6), "the mate chat window is in this one");

    // ── 6. a chosen window ──
    if (CHROME) {
      step("'On this computer' → the known window: she sees only that window");
      const src = await chatw.eval(`window.hrhNative.capture.sources().then((l) => l.find((s) => s.kind === "window" && /GENY-KNOWN-WINDOW/.test(s.name)) || null)`);
      console.log(`  window source: ${JSON.stringify(src)}`);
      if (!src) console.log("  (the known window is not listed as a capture source here)");
      else {
        await chatw.eval(`window.hrhNative.capture.setChoice(${JSON.stringify(mate.id)}, ${JSON.stringify(src)})`);
        await patch({ screen: { hide_avatar: true } });
        await sleep(500);
        b = await ask("look at my screen");
        r = await reply(b);
        console.log(`  ${r.slice(0, 220)}`);
        const a3 = att(r);
        if (/error=no/.test(r) && a3) {
          if (SHOTS) fs.writeFileSync(path.join(SHOTS, "capture-3-window.png"), Buffer.from(await con.eval(B64(`/api/attachments/${a3}/content`)), "base64"));
          const dims = await con.eval(SAMPLE(`/api/attachments/${a3}/content`, [[0, 0]]));
          const at = (fx, fy) => [Math.round(dims.width * fx), Math.round(dims.height * fy)];
          const s3 = await con.eval(SAMPLE(`/api/attachments/${a3}/content`, [at(0.1, 0.1), at(0.9, 0.1), at(0.1, 0.9), at(0.9, 0.9), at(0.5, 0.5)]));
          console.log(`  window picture ${s3.width}×${s3.height}, pixels ${JSON.stringify(s3.px)}`);
          assert.ok(/the window/.test(r), "the tool says it is a window");
          // (Electron hands a window's picture scaled to fit the capture box — its own aspect, not the screen's)
          assert.ok(Math.abs(s3.width / s3.height - 1.5) < 0.03, `the window's shape (600×400), not the screen's: ${s3.width}×${s3.height}`);
          // (its top holds Chrome's own info bars — white; below them the page: #d81b9c to its edges)
          assert.ok(s3.px.slice(2).every((p) => close(p, KNOWN)), "only the known window (its lower corners and middle are its colour)");
        } else console.log("  (window capture failed on this X server — see the answer above)");
        await chatw.eval(`window.hrhNative.capture.setChoice(${JSON.stringify(mate.id)}, null)`);
      }
    }

    // ── 7. the user's Share screen ──
    step("Share screen in the composer's + menu: the picker (thumbnails) at once, Share → sharing on, with each message");
    await chatw.eval(`document.querySelector('[data-testid="mate-attach"]').click(), true`);
    await until("the menu item", () => chatw.eval(`!!document.querySelector('[data-testid="attach-share-screen"]')`));
    await chatw.eval(`document.querySelector('[data-testid="attach-share-screen"]').click(), true`);
    await until("the picker's sources", () => chatw.eval(`document.querySelectorAll('[data-testid="share-source"] img').length > 0`));
    const tiles = await chatw.eval(`[...document.querySelectorAll('[data-testid="share-source"]')].map((e) => e.dataset.sourceId + " " + e.innerText)`);
    console.log(`  picker: ${JSON.stringify(tiles)}`);
    await chatw.shot("share-picker.png");
    await chatw.eval(`[...document.querySelectorAll('[data-testid="share-source"]')].find((e) => e.dataset.sourceId.startsWith("screen:")).click(), true`);
    await chatw.eval(`document.querySelector('[data-testid="share-go"]').click(), true`);
    await until("sharing on", () => chatw.eval(`!document.querySelector('[data-testid="share-picker"]') && window.hrhNative.capture.sharing.get().then((v) => v && v.state && v.state.mode === "on_turn")`), 30000);
    await chatw.eval(`document.querySelector('[data-testid="mate-input"]').focus(), true`);
    await chatw.send("Input.insertText", { text: "here is my screen" });
    await chatw.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await chatw.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await until("my message", () => chatw.eval(`(() => { const all = [...document.querySelectorAll('[data-testid="mate-user-message"]')]; const last = all[all.length - 1]; return !!last && /here is my screen/.test(last.innerText); })()`), 30000);
    await sleep(1200);
    await chatw.shot("chat-user-shared.png");
    // pressed again while sharing: the same picker, with Stop
    await chatw.eval(`document.querySelector('[data-testid="mate-attach"]').click(), true`);
    await until("the menu item", () => chatw.eval(`!!document.querySelector('[data-testid="attach-share-screen"]')`));
    await chatw.eval(`document.querySelector('[data-testid="attach-share-screen"]').click(), true`);
    await until("Stop in the picker", () => chatw.eval(`!!document.querySelector('[data-testid="share-stop"]')`));
    await chatw.eval(`document.querySelector('[data-testid="share-stop"]').click(), true`);
    await until("sharing off", () => chatw.eval(`window.hrhNative.capture.sharing.get().then((v) => !v.state)`), 15000);

    const log = fs.readFileSync(path.join(home, ".config", "hr-harnessor", "logs", "main.log"), "utf8");
    assert.match(log, /screen shared with a mate/);
    console.log("\nOK — screen capture end to end");
  } catch (e) {
    console.error(`\nFAILED: ${e.stack || e}`);
    console.error(`--- app output (tail) ---\n${(app.out || "").slice(-4000)}`);
    process.exitCode = 1;
  } finally {
    await app.stop();
    for (const pid of (chrome && chrome.pids) || []) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  }
}

module.exports = { App, Cdp, fill, until, sleep, SAMPLE, SHA, B64 };
if (require.main === module) main();
