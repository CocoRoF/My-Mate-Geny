// Local execution on Windows, end to end with the real NSIS installer (CI: .github/workflows/windows-update.yml):
//
//   node test/e2e/windows-local-e2e.js <dist dir> [--out e2e-out]
//
// The build installed as a user installs it, a fresh profile, the connect screen → Local execution (what its button
// does). Then: the mate's avatar in the console and in her small window — a video drawn on a transparent canvas, not a
// still with its background — with what the page knows (WebGL, the clips, their requests, errors); the app quits and
// starts again — Local execution is remembered and comes up by itself. Facts and screenshots go to <out>.
"use strict";
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const DIST = path.resolve(argv[0]);
const OUT = path.resolve(argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "e2e-out");
const PRODUCT = "My Mate Geny";
const EXE = `${PRODUCT}.exe`;
const PROFILE = path.join(process.env.APPDATA, "hr-harnessor");
if (process.platform !== "win32") throw new Error("Windows only");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${m}`);
async function until(what, fn, ms = 30000, every = 500) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ""}`);
    await sleep(every);
  }
}
function ps(script, timeout = 60000) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", timeout, windowsHide: true });
  return (r.stdout || "").trim();
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
function installed() {
  const out = ps(`$k = Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -eq ${q(PRODUCT)} } | Select-Object -First 1 DisplayVersion,UninstallString,QuietUninstallString
if ($k) { $k | ConvertTo-Json -Compress } else { 'null' }`);
  const k = out && out !== "null" ? JSON.parse(out) : null;
  if (k) k.dir = path.dirname((/^"([^"]+)"/.exec(k.UninstallString || "") || [])[1] || "");
  return k;
}
function screenshot(file) {
  return ps(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save(${q(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
'saved'`);
}
const killApp = () => spawnSync("taskkill", ["/f", "/t", "/im", EXE], { stdio: "ignore", windowsHide: true });
const settings = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROFILE, "settings.json"), "utf8"));
  } catch {
    return null;
  }
};
const tail = (file, n = 60) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-n).map((l) => `    ${l}`).join("\n") : "    (none)");

class Cdp {
  constructor(url) {
    this.url = url;
    this.events = [];
  }
  async open() {
    this.ws = new WebSocket(this.url);
    this.pending = new Map();
    this.seq = 0;
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.method) return void this.events.push(msg);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    };
    this.ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error("closed"));
      this.pending.clear();
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
  send(method, params = {}, ms = 60000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return Promise.race([new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })), sleep(ms).then(() => { throw new Error(`${method}: no answer`); })]);
  }
  async eval(expression, ms) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

class App {
  constructor(dir) {
    this.dir = dir;
    this.port = 9400 + Math.floor(Math.random() * 150);
    this.iport = this.port + 300;
  }
  start() {
    this.proc = spawn(path.join(this.dir, EXE), [`--remote-debugging-port=${this.port}`, `--inspect=${this.iport}`, "--lang=ko-KR"], { detached: true, stdio: "ignore", env: process.env });
    this.proc.unref();
  }
  async targets() {
    return (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).filter((t) => t.type === "page");
  }
  async page(match, ms = 120000) {
    const t = await until(`a page matching ${match}`, async () => (await this.targets()).find((x) => match.test(x.url)), ms);
    const c = await new Cdp(t.webSocketDebuggerUrl).open();
    await c.send("Runtime.enable");
    await c.send("Log.enable").catch(() => {});
    c.target = t;
    return c;
  }
  async main(body) {
    const t = await until("the main-process inspector", async () => (await (await fetch(`http://127.0.0.1:${this.iport}/json/list`)).json())[0], 90000);
    const c = await new Cdp(t.webSocketDebuggerUrl).open();
    try {
      return await c.eval(`(async () => { const req = process.mainModule.require; const electron = req("electron"); ${body} })()`);
    } finally {
      c.close();
    }
  }
}

// what a page knows about the mate's avatar: which body, the clips (their state and errors), WebGL, reduced motion
const AVATAR_FACTS = `(async () => {
  const kinds = [...document.querySelectorAll("[data-mate-kind]")].map((e) => e.dataset.mateKind);
  const layer = document.querySelector(".mate-layer");
  const videos = [...document.querySelectorAll("video")].map((v) => ({ src: (v.currentSrc || v.src || "").replace(location.origin, ""), ready: v.readyState, paused: v.paused, time: v.currentTime, error: v.error ? { code: v.error.code, message: v.error.message } : null, w: v.videoWidth, h: v.videoHeight }));
  const canvases = layer ? layer.querySelectorAll("canvas").length : 0;
  const imgs = layer ? [...layer.querySelectorAll("img")].map((i) => (i.currentSrc || i.src || "").replace(location.origin, "")) : [];
  const gl = (() => { try { const c = document.createElement("canvas"); const g = c.getContext("webgl"); if (!g) return null; const d = g.getExtension("WEBGL_debug_renderer_info"); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "webgl"; } catch (e) { return "error: " + e.message; } })();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let probe = null;
  const src = videos.find((v) => v.src)?.src || [...document.querySelectorAll("source")].map((s) => s.src)[0];
  if (src) {
    try {
      const r = await fetch(src, { headers: { Range: "bytes=0-1023" }, credentials: "include" });
      probe = { url: src, status: r.status, type: r.headers.get("content-type"), range: r.headers.get("content-range"), ranges: r.headers.get("accept-ranges"), length: r.headers.get("content-length") };
    } catch (e) { probe = { url: src, error: e.message }; }
  }
  return { url: location.href.replace(location.origin, ""), kinds, canvases, imgs, videos, gl, reduced, probe };
})()`;

async function main() {
  const setup = fs.readdirSync(DIST).find((f) => /setup\.exe$/.test(f));
  const facts = { steps: [] };
  const note = (k, v) => {
    facts[k] = v;
    say(`${k}: ${JSON.stringify(v).slice(0, 1500)}`);
  };
  killApp();
  if (installed()) {
    const k = installed();
    spawnSync("cmd.exe", ["/d", "/s", "/c", `"${k.QuietUninstallString || k.UninstallString + " /S"}"`], { stdio: "ignore", windowsVerbatimArguments: true, timeout: 120000 });
    await until("the uninstall", () => !installed(), 120000, 1000);
  }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  for (let n = 1; n <= 6; n++) {
    const r = spawnSync(path.join(DIST, setup), ["/S"], { stdio: "ignore", windowsHide: true, timeout: 600000 });
    say(`setup exit ${r.status}`);
    if (r.status === 0) break;
    await sleep(15000);
  }
  const k = await until("installed", () => installed(), 180000, 1000);
  say(`installed ${k.DisplayVersion} in ${k.dir}`);

  // (her small window out, as for a user who has it on: nothing about the execution mode chosen yet)
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, "settings.json"), JSON.stringify({ mateVisible: true }));
  let app = new App(k.dir);
  app.start();
  say("first start: the connect screen → Local execution");
  const connect = await app.page(/connect\.html/);
  await until("the connect page's bridge", () => connect.eval(`!!window.hrhConnect`), 60000);
  note("connectState", await connect.eval(`window.hrhConnect.state()`));
  const started = connect.eval(`window.hrhConnect.startLocal()`, 240000).catch((e) => ({ error: e.message }));
  const con = await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!.*surface=)/, 240000);
  note("startLocal", await Promise.race([started, sleep(5000).then(() => "(still pending)")]));
  note("settingsAfterLocal", settings());
  await con.eval(`localStorage.setItem("hrh_setup_seen_v2", "1"), true`).catch(() => {});
  await con.eval(`location.href = location.origin + "/?view=mate", true`).catch(() => {});
  await sleep(4000);
  const con2 = await app.page(/^http:\/\/127\.0\.0\.1:\d+\/.*view=mate/, 60000);
  await until("the mate's avatar", () => con2.eval(`document.querySelectorAll("[data-mate-kind]").length > 0`), 60000).catch((e) => say(e.message));
  await sleep(8000);
  note("consoleAvatar", await con2.eval(AVATAR_FACTS).catch((e) => ({ error: e.message })));
  const shot = await con2.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (shot) fs.writeFileSync(path.join(OUT, "console-mate.png"), Buffer.from(shot.data, "base64"));
  note("consoleErrors", con2.events.filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error").map((e) => e.params.entry.text.slice(0, 300)).slice(0, 20));

  // her small window (the desktop Mate), if it is out — and if not, put it out
  let avatar = (await app.targets()).find((t) => /surface=mate-avatar/.test(t.url));
  if (!avatar) {
    note("showMate", await app.main(`const w = electron.BrowserWindow.getAllWindows().map((x) => x.webContents.getURL()); return w;`).catch((e) => e.message));
  }
  avatar = await app.page(/surface=mate-avatar/, 30000).catch(() => null);
  if (avatar) {
    await sleep(8000);
    note("windowAvatar", await avatar.eval(AVATAR_FACTS).catch((e) => ({ error: e.message })));
    note("windowErrors", avatar.events.filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error").map((e) => e.params.entry.text.slice(0, 300)).slice(0, 20));
  } else note("windowAvatar", "(no small window)");
  say(`screen: ${screenshot(path.join(OUT, "desktop-first.png"))}`);
  note("gpu", await app.main(`return { feature: electron.app.getGPUFeatureStatus(), info: (await electron.app.getGPUInfo("basic")).gpuDevice };`).catch((e) => e.message));

  say("quit as a user does (Quit), then start again");
  await app.main(`setTimeout(() => electron.app.quit(), 100); return true;`).catch(() => {});
  await sleep(8000);
  killApp();
  note("settingsAfterQuit", settings());
  app = new App(k.dir);
  app.start();
  const back = await until("the second start's page", async () => (await app.targets()).find((t) => !/surface=/.test(t.url) && (/^http:\/\/127\.0\.0\.1/.test(t.url) || /connect\.html/.test(t.url))), 180000, 1000).catch(() => null);
  await sleep(6000);
  const pages = (await app.targets().catch(() => [])).map((t) => t.url);
  note("secondStartPages", pages);
  note("settingsSecondStart", settings());
  const local = pages.some((u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u) && !/surface=/.test(u));
  note("localRemembered", local);
  say(`screen: ${screenshot(path.join(OUT, "desktop-second.png"))}`);
  console.log(`  main.log:\n${tail(path.join(PROFILE, "logs", "main.log"), 80)}`);
  killApp();
  fs.writeFileSync(path.join(OUT, "local-facts.json"), JSON.stringify(facts, null, 2));
  const problems = [];
  if (!local) problems.push("Local execution was not remembered");
  for (const key of ["consoleAvatar", "windowAvatar"]) {
    const f = facts[key];
    if (f && typeof f === "object" && !f.error && !(f.canvases > 0 && f.videos.some((v) => v.ready >= 2 && !v.error))) problems.push(`${key}: no video playing`);
  }
  console.log(problems.length ? `\nPROBLEMS:\n  ${problems.join("\n  ")}` : "\nlocal execution: remembered, her videos play");
  process.exit(problems.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  killApp();
  process.exit(1);
});
