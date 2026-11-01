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
// --full: the whole file is downloaded (as on Windows): the installed AppImage gets a few bytes appended, so its
// embedded block map can't be read and electron-updater falls back from the differential download. The app then
// talks to the server through a proxy that sends the installer at ~8 MB/s (progress to watch) and can fail it.
const FULL = flags.includes("--full");

/** a proxy in front of the server: the update's installer slowed down; `fail` answers it with 500 */
async function startProxy(target) {
  const http = require("http");
  const net = require("net");
  const t = new URL(target);
  const P = { fail: false, url: "" };
  const slow = (req) => /\/api\/downloads\/update\/[^/?]+\.(AppImage|exe|deb)/.test(req.url || "");
  P.server = http.createServer((req, res) => {
    if (P.fail && slow(req)) {
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end("update feed down (test)");
    }
    const up = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      if (!slow(req)) return r.pipe(res);
      // ~8 MB/s in 128 KiB steps
      r.on("data", (chunk) => {
        r.pause();
        res.write(chunk);
        setTimeout(() => r.resume(), Math.ceil((chunk.length / (8 * 1024 * 1024)) * 1000));
      });
      r.on("end", () => res.end());
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
    res.on("close", () => up.destroy());
  });
  // the console's WebSockets: passed through as they are
  P.server.on("upgrade", (req, sock, head) => {
    const s = net.connect(Number(t.port), t.hostname, () => {
      s.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries({ ...req.headers, host: t.host }).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head?.length) s.write(head);
      sock.pipe(s).pipe(sock);
    });
    s.on("error", () => sock.destroy());
    sock.on("error", () => s.destroy());
  });
  await new Promise((r) => P.server.listen(0, "127.0.0.1", r));
  P.server.unref();
  P.url = `http://127.0.0.1:${P.server.address().port}`;
  return P;
}
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
    if (!this.proc) {
      // an app the updater restarted (not our child): its main process by PID, asked to quit, then ended
      const pid = this.pid || (await this.main("return process.pid").catch(() => 0));
      this.detach();
      if (!pid) return;
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      await until("the restarted app to quit", async () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 8000).catch(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      });
      return;
    }
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
  const proxy = FULL ? await startProxy(SERVER) : null;
  const server = (proxy ? proxy.url : SERVER).replace(/\/+$/, "");
  fs.mkdirSync(SHOTS, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.homedir(), ".cache", "hrh-update-e2e-"));
  // (as a user keeps it: the downloaded file name, with its version)
  const installed = path.join(home, "Applications", path.basename(APPIMAGE));
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.copyFileSync(APPIMAGE, installed);
  if (FULL) fs.appendFileSync(installed, Buffer.alloc(4096)); // (no readable block map: a full download)
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
      const c3 = await until("the Download page's card", async () => { const c = await con.eval(CARD); return c && c.status !== "checking" ? c : null; }, 30000); // (a page view looks again)
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

    const t2 = Date.now();
    if (FULL) {
      step("the server failing the download (500): a clear error with Retry");
      proxy.fail = true;
      await click(con, "update-download");
      const e1 = await until("the error", async () => {
        const c = await con.eval(CARD);
        return c && c.status === "error" ? c : null;
      }, 60000);
      console.log(`  ${e1.text}`);
      if (!/could not be downloaded/.test(e1.text)) failures.push(`the download error: ${e1.text}`);
      await sleep(300);
      await con.shot(`${facts.version}-settings-2-error.png`);
      proxy.fail = false;
      step("Retry → downloading again: progress (percent, size, speed, time left)");
      await click(con, "update-retry");
    } else {
      step("Download & install: progress (percent, size, speed, time left)");
      await click(con, "update-download");
    }
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
    if (FULL && d1.status !== "downloading") failures.push(`a full download showed no progress (${d1.status})`);
    if (FULL && d1.status === "downloading" && !/left|almost/.test(d1.text)) failures.push(`no time left: ${d1.text}`);

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

    if (FULL && d3.status === "downloading") {
      step("Cancel → 'available' again (cancelled); Download again → the whole way");
      await click(con, "update-cancel");
      const c2 = await until("cancelled", async () => {
        const c = await con.eval(CARD);
        return c && c.status === "available" ? c : null;
      }, 15000).catch((e) => (failures.push(e.message), null));
      if (c2) console.log(`  ${c2.text}`);
      if (c2 && !/cancelled/i.test(c2.text)) failures.push(`cancel: ${c2.text}`);
      await con.shot(`${facts.version}-downloads-2-cancelled.png`);
      await click(con, "update-download");
      const d4 = await until("downloading again", async () => {
        const c = await con.eval(CARD);
        return c && c.status === "downloading" && /MB of/.test(c.text) ? c : null;
      }, 60000);
      console.log(`  ${d4.text}`);
    }

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
      // the restart (desktop/src/main.js restartAfter): what it starts, and its output into restart.log
      const cp = req("child_process");
      const spawn = cp.spawn;
      cp.spawn = (cmd, args, opts = {}) => {
        if (cmd === "/bin/sh" || /\.AppImage$/.test(cmd)) {
          log("restart: " + (cmd === "/bin/sh" ? JSON.stringify(args.slice(2)) : cmd + " " + JSON.stringify(args)));
          const fd = fs.openSync(${JSON.stringify(path.join(home, "restart.log"))}, "a");
          opts = { ...opts, stdio: ["ignore", fd, fd] };
        }
        return spawn(cmd, args, opts);
      };
      log("env: " + ["DISPLAY", "APPIMAGE", "APPDIR", "APPIMAGE_EXTRACT_AND_RUN", "TMPDIR"].map((k) => k + "=" + process.env[k]).join(" "));
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
    // electron-updater puts the new file in place (a versioned name is replaced by the new version's name)
    const nowInstalled = () => fs.readdirSync(path.dirname(installed)).filter((f) => f.endsWith(".AppImage")).map((f) => path.join(path.dirname(installed), f));
    const swapped = await until("the AppImage to be replaced", async () => {
      const files = nowInstalled();
      return files.length === 1 && sha512(files[0]) !== before ? files[0] : null;
    }, 30000).catch(() => (failures.push(`the AppImage was not replaced: ${nowInstalled().join(", ")}`), null));
    if (swapped) console.log(`  installed: ${path.basename(swapped)} (${fs.statSync(swapped).size} bytes), was ${path.basename(installed)}`);

    step("the updater restarts the app by itself — the new version, with the app's arguments");
    // (found through its main-process inspector: the same --inspect port; its DevTools port may still be held for a
    // moment by the old app's leftovers, so the page is driven from the main process)
    const restarted = new App(home, swapped || installed);
    Object.assign(restarted, { port: app.port, iport: app.iport, proc: null });
    const after = await until("the restarted app", async () => {
      const r = await restarted.main(`return { version: electron.app.getVersion(), packaged: electron.app.isPackaged, pid: process.pid, argv: process.argv.slice(1), appimage: process.env.APPIMAGE }`);
      return r && r.pid ? r : null;
    }, 90000).catch(() => null);
    const restartLog = () => {
      const rl = path.join(home, "restart.log");
      return fs.existsSync(rl) ? fs.readFileSync(rl, "utf8").split("\n").map((l) => l.replace(/^\/\S*appimage_extracted_\S*?(?=\[\d+:)/, "")).filter((l) => l && !/^\/\S*appimage_extracted_\S*$/.test(l)).slice(-12).map((l) => `    ${l}`).join("\n") : "    (none)";
    };
    if (!after) {
      failures.push("the updater did not bring the app back (no restarted app within 90 s)");
      console.log(`  processes now: ${procs(home).join(" | ") || "(none)"}\n  the restarted app's output:\n${restartLog()}`);
      await killRelaunched(swapped || installed, 0, home);
      return finish(failures);
    }
    app = restarted;
    app.pid = after.pid;
    console.log(`  restarted: ${JSON.stringify(after)}`);
    if (after.version !== newVersion) failures.push(`after the install the app is ${after.version}, not ${newVersion}`);
    if (!after.argv.includes("--no-sandbox")) failures.push("the restarted app lost its arguments");
    const inPage = (expr) => app.main(`const w = electron.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && /^http/.test(x.webContents.getURL()) && !x.webContents.getURL().includes("surface="));
      return w ? w.webContents.executeJavaScript(${JSON.stringify(expr)}) : null;`);
    await until("the restarted app's console (signed in: the session was kept)", () => inPage(`!!document.querySelector("nav button")`), 60000);
    await inPage(`document.querySelector('[data-testid="nav-settings"]').click(), true`);
    const c9 = await until("the check's result", async () => {
      const c = await inPage(CARD);
      return c && c.status !== "checking" && c.status !== "idle" ? c : null;
    }, 60000);
    console.log(`  card: ${c9.status} — ${c9.text}`);
    if (c9.status !== "latest") failures.push(`after the install: ${c9.status} (${c9.text})`);
    await inPage(`document.querySelector('[data-testid="settings-desktop-update"]')?.scrollIntoView({ block: "center" }), true`);
    await sleep(500);
    const png = await app.main(`const w = electron.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && /^http/.test(x.webContents.getURL()) && !x.webContents.getURL().includes("surface="));
      return (await w.webContents.capturePage()).toPNG().toString("base64");`);
    fs.writeFileSync(path.join(SHOTS, `${after.version}-settings-after-install.png`), Buffer.from(png, "base64"));
    console.log(`  shot: ${path.join(SHOTS, `${after.version}-settings-after-install.png`)}\n  the restarted app's output:\n${restartLog()}`);
    return finish(failures);
  } finally {
    await app.stop();
    await killRelaunched(installed, 0, home);
    console.log(`  app output (tail):\n${(app.out || "(the restarted app: not our child)").split("\n").filter((l) => !l.includes("appimage_extracted")).slice(-15).join("\n")}`);
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
    if (m[2].startsWith(path.dirname(installed) + "/") || m[2].startsWith(path.join(home, "tmp") + "/")) {
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
