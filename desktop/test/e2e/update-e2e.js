// End-to-end check of the in-app update in a PACKAGED desktop app (an AppImage, no HRH_UPDATER_DEV) against a
// real server whose Download service reads the real `apps-latest` release (backend/app/services/downloads.py).
// Linux, headless:
//
//   xvfb-run -a -s "-screen 0 1600x1000x24" node test/e2e/update-e2e.js <server url> <password> <shots dir> \
//     -- <older AppImage> [--expect-latest]
//
// The AppImage is copied into a throwaway HOME (the "installed" app the updater replaces). Steps: sign in through
// the connect screen; Settings → Updates shows this app's version and finds the newer build; Download & install
// with progress (percent, size, speed, time left), a page reload in the middle (the download is still shown), the
// Download page showing the same state; Restart & install → the app quits, the AppImage file is replaced and
// starts again in the new version, which says "up to date". `--expect-latest`: the given AppImage is already the
// newest — only the "up to date" state is checked. Every request the updater makes is recorded in the main
// process (URL, status, whether it carried the session) and printed.
"use strict";
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const [SERVER, PASSWORD, SHOTS] = argv.slice(0, dash);
const [APPIMAGE, ...flags] = argv.slice(dash + 1);
const EXPECT_LATEST = flags.includes("--expect-latest");
if (dash < 0 || !SERVER || !PASSWORD || !SHOTS || !APPIMAGE) {
  console.error("usage: node test/e2e/update-e2e.js <server url> <password> <shots dir> -- <AppImage> [--expect-latest]");
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
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, "base64"));
    console.log(`  shot: ${path.join(SHOTS, file)}`);
  }
}

class App {
  constructor(home, bin) {
    Object.assign(this, { home, bin, pages: new Map() });
    this.port = 9700 + Math.floor(Math.random() * 200);
    this.iport = this.port + 300;
  }
  start() {
    // a packaged app as a user runs it: no HRH_UPDATER_DEV / HRH_UPDATE_FEED. (The AppImage runtime sets APPIMAGE
    // itself; APPIMAGE_EXTRACT_AND_RUN only stands in for FUSE.)
    const env = { ...process.env, HOME: this.home, XDG_CONFIG_HOME: path.join(this.home, ".config"), XDG_CACHE_HOME: path.join(this.home, ".cache"), APPIMAGE_EXTRACT_AND_RUN: "1" };
    for (const k of ["HRH_UPDATER_DEV", "HRH_UPDATE_FEED", "APPIMAGE", "APPDIR", "XDG_SESSION_TYPE", "WAYLAND_DISPLAY"]) delete env[k];
    Object.assign(env, { LANG: "en_US.UTF-8", LANGUAGE: "en_US", LC_ALL: "en_US.UTF-8", TMPDIR: path.join(this.home, "tmp") });
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    const args = ["--no-sandbox", `--remote-debugging-port=${this.port}`, `--inspect=${this.iport}`, "--disable-gpu", "--lang=en-US"];
    this.proc = spawn(this.bin, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.out = "";
    this.proc.stdout.on("data", (d) => (this.out += d));
    this.proc.stderr.on("data", (d) => (this.out += d));
    this.exited = new Promise((r) => this.proc.on("exit", r));
  }
  detach() {
    for (const c of this.pages.values()) c.close();
    this.pages.clear();
    this.mainCdp?.close();
    this.mainCdp = null;
  }
  async stop() {
    this.detach();
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
  async page(match, ms = 30000) {
    const t = await until(`a page matching ${match}`, async () => (await this.targets()).find((x) => match.test(x.url)), ms);
    const have = this.pages.get(String(match));
    if (have && have.id === t.id && have.ws.readyState === 1) return have;
    have?.close();
    const c = await new Cdp(t.webSocketDebuggerUrl).open();
    c.id = t.id;
    this.pages.set(String(match), c);
    return c;
  }
  /** evaluate in the MAIN process (the packaged app's own modules through process.mainModule.require) */
  async main(body) {
    if (!this.mainCdp) {
      const t = await until("the main-process inspector", async () => (await (await fetch(`http://127.0.0.1:${this.iport}/json/list`)).json())[0]);
      this.mainCdp = await new Cdp(t.webSocketDebuggerUrl).open();
      await this.mainCdp.send("Runtime.enable");
    }
    const r = await this.mainCdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => { const req = process.mainModule.require; const electron = req("electron"); ${body} })()`,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

// every request of the main process (electron-updater's net.request): URL, status, whether the session went along
const RECORD = `
  if (!global.__hrhReq) {
    global.__hrhReq = [];
    const net = electron.net;
    const orig = net.request.bind(net);
    net.request = (o) => {
      const opts = typeof o === "string" ? { url: o } : o || {};
      const url = opts.url || ((opts.protocol || "") + "//" + (opts.hostname || opts.host || "") + (opts.port ? ":" + opts.port : "") + (opts.path || ""));
      const h = {};
      for (const [k, v] of Object.entries(opts.headers || {})) h[k.toLowerCase()] = v;
      const rec = { url, cookie: !!h.cookie, authorization: !!h.authorization, partition: opts.session ? "custom" : opts.partition || "default", t: Date.now() };
      global.__hrhReq.push(rec);
      const r = orig(o);
      const setHeader = r.setHeader.bind(r);
      r.setHeader = (k, v) => { if (/^cookie$/i.test(k)) rec.cookie = true; if (/^authorization$/i.test(k)) rec.authorization = true; return setHeader(k, v); };
      r.on("response", (res) => { rec.status = res.statusCode; rec.location = res.headers && res.headers.location; });
      r.on("redirect", (code, method, to) => { rec.status = code; rec.location = to; });
      r.on("error", (e) => { rec.error = String(e && e.message || e); });
      return r;
    };
  }
  return true;`;

const CARD = `(() => { const c = document.querySelector('[data-testid="update-card"]'); return c ? { status: c.dataset.status, text: c.innerText.replace(/\\s+/g, " ").trim(), pct: document.querySelector('[data-testid="update-percent"]')?.textContent || "" } : null; })()`;
const click = (p, id) => p.eval(`(() => { const b = document.querySelector('[data-testid="${id}"]'); if (!b) return false; b.click(); return true; })()`);
const openView = (p, label) => p.eval(`(() => { const b = [...document.querySelectorAll('nav button, [data-testid="nav-settings"]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
const sha512 = (f) => crypto.createHash("sha512").update(fs.readFileSync(f)).digest("base64");

async function signIn(app, server) {
  const connect = await app.page(/connect\.html/);
  await until("the connect page", () => connect.eval(`!!window.hrhConnect && document.readyState === "complete"`));
  step("sign in through the connect screen");
  await connect.eval(`(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set("server", ${JSON.stringify(server)}); set("username", "admin"); set("password", ${JSON.stringify(PASSWORD)});
    const r = document.getElementById("remember"); if (r && !r.checked) r.click();
    document.getElementById("go").click();
    return true;
  })()`);
}

async function requests(app, since = 0) {
  const list = await app.main(`return (global.__hrhReq || []).filter((r) => r.t >= ${since})`);
  for (const r of list) console.log(`  request: ${r.url.replace(/\?.*$/, "")} → ${r.status ?? r.error ?? "(pending)"}${r.location ? ` → ${r.location}` : ""} · cookie ${r.cookie ? "yes" : "NO"} · authorization ${r.authorization ? "yes" : "no"}`);
  return list;
}

async function main() {
  const server = SERVER.replace(/\/+$/, "");
  fs.mkdirSync(SHOTS, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.homedir(), ".cache", "hrh-update-e2e-"));
  const installed = path.join(home, "Applications", "my-mate-geny.AppImage");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.copyFileSync(APPIMAGE, installed);
  fs.chmodSync(installed, 0o755);
  const before = sha512(installed);
  const consoleRe = new RegExp(`^${server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?!login|\\?surface)`);
  let app = new App(home, installed);
  const failures = [];
  try {
    app.start();
    await app.main(RECORD);
    const facts = await app.main(`return { version: electron.app.getVersion(), packaged: electron.app.isPackaged, appimage: process.env.APPIMAGE || null, dev: process.env.HRH_UPDATER_DEV || null }`);
    console.log(`  app: ${JSON.stringify(facts)}`);
    assert.equal(facts.packaged, true, "a packaged app");
    assert.equal(facts.appimage, installed, "APPIMAGE is the installed file");
    await signIn(app, server);
    let con = await app.page(consoleRe);
    await until("the console app", () => con.eval(`!!document.querySelector("nav button")`), 30000);
    const pageVersion = await con.eval(`window.hrhNative && window.hrhNative.version`);
    console.log(`  hrhNative.version: ${pageVersion}`);
    assert.equal(pageVersion, facts.version, "the page sees the app's version");

    step("Settings → Updates: the desktop app's card (current version, a check of the server's feed)");
    await until("the Settings button", () => openView(con, "Settings"));
    const t0 = Date.now();
    await until("the desktop update card", () => con.eval(`!!document.querySelector('[data-testid="settings-desktop-update"] [data-testid="update-card"]')`), 15000);
    const c1 = await until("the check's result", async () => {
      const c = await con.eval(CARD);
      return c && c.status !== "checking" && c.status !== "idle" ? c : null;
    }, 60000);
    console.log(`  card: ${c1.status} — ${c1.text}`);
    await con.eval(`document.querySelector('[data-testid="settings-desktop-update"]').scrollIntoView({ block: "center" }), true`);
    await sleep(400);
    await con.shot(`${facts.version}-settings-1-${c1.status}.png`);
    const reqs = await requests(app, t0);
    const feedReq = reqs.find((r) => /\/api\/downloads\/update\/latest[^/]*\.yml/.test(r.url));
    if (!feedReq) failures.push("no request for the update feed");
    else if (feedReq.status !== 200) failures.push(`the feed answered ${feedReq.status} (cookie sent: ${feedReq.cookie})`);

    if (EXPECT_LATEST) {
      if (c1.status !== "latest") failures.push(`expected "up to date", got ${c1.status}: ${c1.text}`);
      assert.match(c1.text, new RegExp(facts.version.replace(/\./g, "\\.")), "the card names this version");
      step("Check again → still up to date");
      await click(con, "update-check");
      const c2 = await until("up to date again", async () => {
        const c = await con.eval(CARD);
        return c && c.status === "latest" ? c : null;
      }, 30000).catch((e) => (failures.push(e.message), null));
      if (c2) console.log(`  card: ${c2.text}`);
      step("Download page: the same state");
      await openView(con, "Download");
      const c3 = await until("the Download page's card", () => con.eval(CARD), 15000);
      console.log(`  Download page: ${c3.status} — ${c3.text}`);
      if (c3.status !== "latest") failures.push(`Download page: ${c3.status}`);
      await sleep(400);
      await con.shot(`${facts.version}-downloads-latest.png`);
      return finish(failures);
    }

    if (c1.status !== "available") {
      failures.push(`expected a newer version, got ${c1.status}: ${c1.text}`);
      if (c1.status === "error") {
        step("Retry from the error");
        const t1 = Date.now();
        await click(con, "update-retry");
        await sleep(4000);
        const c = await con.eval(CARD);
        console.log(`  after Retry: ${c && c.status} — ${c && c.text}`);
        await requests(app, t1);
        await con.shot(`${facts.version}-settings-2-retry.png`);
      }
      step("Download page in the same app");
      await openView(con, "Download");
      await sleep(5000);
      const c = await con.eval(CARD);
      console.log(`  Download page: ${c && c.status} — ${c && c.text}`);
      await con.shot(`${facts.version}-downloads-1.png`);
      await requests(app, t0);
      return finish(failures);
    }

    const newVersion = (c1.text.match(/\b(\d+\.\d+\.\d+)\b/g) || []).find((v) => v !== facts.version);
    console.log(`  offered: ${newVersion}`);

    step("Download & install: progress (percent, size, speed, time left)");
    const t2 = Date.now();
    await click(con, "update-download");
    // (an AppImage downloads differentially when it can: only the changed blocks, so it may be quick)
    const seen = [];
    const d1 = await until("downloading with bytes (or done / failed)", async () => {
      const c = await con.eval(CARD);
      if (c && (!seen.length || seen[seen.length - 1] !== `${c.status} ${c.text}`)) seen.push(`${c.status} ${c.text}`);
      return c && ((c.status === "downloading" && /MB of/.test(c.text) && parseInt(c.pct) >= 3) || c.status === "ready" || c.status === "error") ? c : null;
    }, 300000);
    for (const s of seen) console.log(`  seen: ${s}`);
    await con.shot(`${facts.version}-settings-2-${d1.status}.png`);
    if (d1.status === "error") {
      failures.push(`download: ${d1.text}`);
      await requests(app, t2);
      return finish(failures);
    }
    if (d1.status === "downloading") assert.match(d1.text, /\/s/, "a speed");

    step("a page reload in the middle: the download is still shown");
    await con.eval(`location.reload(), true`).catch(() => {});
    await sleep(2000);
    con = await app.page(consoleRe);
    const d2 = await until("still downloading after the reload", async () => {
      const c = await con.eval(CARD);
      return c && (c.status === "downloading" || c.status === "ready") ? c : null;
    }, 20000);
    console.log(`  after reload: ${d2.status} ${d2.pct}`);

    step("the Download page: the same download");
    await openView(con, "Download");
    const d3 = await until("the Download page's card", async () => {
      const c = await con.eval(CARD);
      return c && (c.status === "downloading" || c.status === "ready") ? c : null;
    }, 15000);
    console.log(`  Download page: ${d3.status} — ${d3.text}`);
    await con.shot(`${facts.version}-downloads-2-${d3.status}.png`);

    const r1 = await until("ready", async () => {
      const c = await con.eval(CARD);
      if (c && c.status === "error") return c;
      return c && c.status === "ready" ? c : null;
    }, 600000);
    console.log(`  ${r1.status}: ${r1.text}`);
    await requests(app, t2);
    if (r1.status !== "ready") {
      failures.push(`download: ${r1.text}`);
      await con.shot(`${facts.version}-downloads-3-error.png`);
      return finish(failures);
    }
    await sleep(300);
    await con.shot(`${facts.version}-downloads-3-ready.png`);

    step("Restart & install → the app quits, the AppImage is replaced, the new version starts");
    const oldPid = app.proc.pid;
    console.log(`  before: ${procs(home).join(" | ")}`);
    // what electron-updater and the app do on the way out (printed if the app stays)
    await app.main(`
      const fs = req("fs");
      const log = (m) => fs.appendFileSync(${JSON.stringify(path.join(home, "quit.log"))}, new Date().toISOString().slice(11, 23) + " " + String(m).split("\\n").slice(0, 3).join(" ⏎ ") + "\\n");
      // (the app's own instance: from the module cache — it was loaded by the first check)
      const cache = process.mainModule.constructor._cache;
      const au = cache[Object.keys(cache).find((k) => /electron-updater[\\\\/]out[\\\\/]main\\.js$/.test(k))].exports.autoUpdater;
      au.logger = { info: (m) => log("info: " + m), warn: (m) => log("warn: " + m), error: (m) => log("error: " + m), debug: () => {} };
      au.on("error", (e) => log("error event: " + (e && e.message)));
      for (const ev of ["before-quit", "will-quit", "quit", "window-all-closed"]) electron.app.on(ev, () => log("app " + ev));
      const q = electron.app.quit.bind(electron.app);
      electron.app.quit = () => { log("app.quit()"); return q(); };
      return true;`);
    // (a Node inspector still attached keeps a quitting app waiting for it to disconnect)
    app.mainCdp.close();
    app.mainCdp = null;
    await click(con, "update-install");
    let lastSeen = "";
    const quit = await until("the old app to quit", async () => {
      const now = procs(home).join(" | ");
      if (now !== lastSeen) console.log(`  processes: ${(lastSeen = now) || "(none)"}`);
      return app.proc.exitCode !== null || app.proc.signalCode !== null;
    }, 60000).catch(() => null);
    const quitLog = () => (fs.existsSync(path.join(home, "quit.log")) ? fs.readFileSync(path.join(home, "quit.log"), "utf8").trim().split("\n").map((l) => `    ${l}`).join("\n") : "    (nothing)");
    console.log(`  the app's way out:\n${quitLog()}`);
    if (!quit) {
      failures.push("the app did not quit for the install");
      const card = await con.eval(CARD).catch(() => null);
      if (card) console.log(`  card: ${card.status} — ${card.text}`);
      await con.shot(`${facts.version}-install-stuck.png`).catch(() => {});
      await app.stop();
    }
    app.detach();
    await until("the AppImage to be replaced", async () => fs.existsSync(installed) && sha512(installed) !== before, 30000).catch(() => failures.push("the AppImage was not replaced"));
    console.log(`  installed file: ${fs.statSync(installed).size} bytes (was ${fs.statSync(APPIMAGE).size}), sha512 changed: ${sha512(installed) !== before}`);
    // the updater relaunches the new file itself (a detached process): find its pages on the same debug ports? No —
    // the relaunch gets the old command line minus our flags, so start it the way a user would and check it.
    await sleep(3000);
    const relaunched = await killRelaunched(installed, oldPid, home);
    if (!relaunched) failures.push("the updater did not start the new version");
    app = new App(home, installed);
    app.start();
    await app.main(RECORD);
    const after = await app.main(`return { version: electron.app.getVersion(), packaged: electron.app.isPackaged }`);
    console.log(`  after the install: ${JSON.stringify(after)}`);
    if (after.version !== newVersion) failures.push(`after the install the app is ${after.version}, not ${newVersion}`);
    con = await app.page(consoleRe, 40000).catch(async () => {
      await signIn(app, server);
      return app.page(consoleRe);
    });
    await until("the console app", () => con.eval(`!!document.querySelector("nav button")`), 30000);
    await openView(con, "Settings");
    const c9 = await until("the check's result", async () => {
      const c = await con.eval(CARD);
      return c && c.status !== "checking" && c.status !== "idle" ? c : null;
    }, 60000);
    console.log(`  card: ${c9.status} — ${c9.text}`);
    if (c9.status !== "latest") failures.push(`after the install: ${c9.status} (${c9.text})`);
    await con.eval(`document.querySelector('[data-testid="settings-desktop-update"]')?.scrollIntoView({ block: "center" }), true`);
    await sleep(400);
    await con.shot(`${after.version}-settings-after-install.png`);
    await requests(app);
    return finish(failures);
  } finally {
    await app.stop();
    await killRelaunched(installed, 0, home);
    console.log(`  app output (tail):\n${app.out.split("\n").filter((l) => !l.includes("appimage_extracted")).slice(-15).join("\n")}`);
  }
}

/** this test's processes (the AppImage runtime, the app it unpacked into this HOME): "pid args" */
function procs(home) {
  const { execFileSync } = require("child_process");
  try {
    return execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes(home) && !l.includes("update-e2e.js") && !/--type=/.test(l))
      .map((l) => l.replace(home, "~").slice(0, 110));
  } catch {
    return [];
  }
}

/** the relaunched app (detached, started by the updater): stopped by PID, never by name */
async function killRelaunched(installed, skipPid, home) {
  const { execFileSync } = require("child_process");
  let out = "";
  let found = 0;
  try {
    out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  } catch {
    return 0;
  }
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || Number(m[1]) === skipPid || Number(m[1]) === process.pid) continue;
    // (the AppImage runtime, or the app it unpacked into this HOME's TMPDIR)
    if (m[2].startsWith(installed) || m[2].startsWith(path.join(home, "tmp") + "/")) {
      found++;
      console.log(`  stopping the relaunched app (pid ${m[1]}): ${m[2].slice(0, 120)}`);
      try {
        process.kill(Number(m[1]), "SIGTERM");
      } catch {}
    }
  }
  await sleep(found ? 3000 : 0);
  return found;
}

function finish(failures) {
  if (failures.length) {
    console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exitCode = 1;
  } else console.log("\nall update steps passed");
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exitCode = 1;
});
