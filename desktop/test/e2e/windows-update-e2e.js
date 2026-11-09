// End-to-end check of the in-app update on Windows with the real NSIS installers: the older build installed as a
// user installs it, then ONE press of Download & install → the app quits, the installer replaces its folder, and
// the newer build starts by itself. Windows only (the CI job: .github/workflows/windows-update.yml):
//
//   node test/e2e/windows-update-e2e.js <older dist dir> <newer dist dir> [--rounds N] [--modes local,server]
//
// <dist dir>: electron-builder's output for one version (the setup .exe and latest.yml). The newer one is the update
// feed, served from 127.0.0.1 (the app's own feed — the GitHub release — is pointed there through its main-process
// inspector; everything else is the app as a user runs it). Modes: `local` — Local execution, so the bundled backend
// runs from the app's folder while it is replaced; `server` — the connect screen, nothing but the app.
//
// Each round starts from nothing (uninstalled, a fresh profile). When an install does not happen, the round says how
// it ended (what ran from the app's folder, second by second; electron-updater's log; the app's main.log) and tries
// once more from the start, as a user would — the "it needs a second go" this test was written for.
"use strict";
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const [OLD_DIST, NEW_DIST] = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const ROUNDS = Number(flag("--rounds", "2"));
const MODES = flag("--modes", "local,server").split(",");
const OUT = path.resolve(flag("--out", "e2e-out"));
const PRODUCT = "My Mate Geny";
const EXE = `${PRODUCT}.exe`;
const APPDATA = process.env.APPDATA;
const PROFILE = path.join(APPDATA, "hr-harnessor"); // (desktop/src/main.js pins userData here)

if (process.platform !== "win32") throw new Error("Windows only");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const say = (m) => console.log(`${stamp()} ${m}`);
async function until(what, fn, ms = 30000, every = 250) {
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
  if (r.error) throw r.error;
  return (r.stdout || "").trim();
}
const json = (s) => (s && s !== "null" ? JSON.parse(s) : null);
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** the installed app as Windows' "Apps" list has it (the per-user uninstall entry NSIS writes; its folder is the
 *  uninstaller's — electron-builder leaves InstallLocation out of that entry) */
function installed() {
  const k = json(
    ps(`$k = Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -eq ${q(PRODUCT)} } | Select-Object -First 1 DisplayVersion,InstallLocation,QuietUninstallString,UninstallString
if ($k) { $k | ConvertTo-Json -Compress } else { 'null' }`),
  );
  if (k && !k.InstallLocation) k.InstallLocation = path.dirname((/^"([^"]+)"/.exec(k.UninstallString || "") || [])[1] || "") || null;
  return k;
}
/** processes started from `dir` (the app's folder) */
function runningFrom(dir) {
  return list(json(ps(`$d = ${q(dir.replace(/\\?$/, "\\"))}
$p = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) } | Select-Object ProcessId,ParentProcessId,Name)
if ($p.Count) { ConvertTo-Json -InputObject $p -Compress } else { 'null' }`)));
}
/** every 250 ms, when it changed: what runs from the app's folder, and the installer / uninstaller processes */
function sampler(dir, file) {
  const script = `$d = ${q(dir.replace(/\\?$/, "\\"))}; $out = ${q(file)}; $last = ''
while ($true) {
  $p = Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) -or $_.Name -like 'my-mate-geny-*' -or $_.Name -eq 'old-uninstaller.exe' -or $_.Name -like 'Un_*.exe' -or $_.Name -eq 'Au_.exe' -or $_.Name -eq 'elevate.exe' }
  $now = (($p | Sort-Object ProcessId | ForEach-Object { "$($_.ProcessId)<$($_.ParentProcessId) $($_.Name)" }) -join ' | ')
  if ($now -ne $last) { Add-Content -Path $out -Value ((Get-Date).ToString('HH:mm:ss.fff') + '  ' + $(if ($now) { $now } else { '(nothing)' })); $last = $now }
  Start-Sleep -Milliseconds 250
}`;
  const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "ignore", windowsHide: true });
  return () => {
    try {
      p.kill();
    } catch {}
  };
}
function killApp(dir) {
  spawnSync("taskkill", ["/f", "/t", "/im", EXE], { stdio: "ignore", windowsHide: true });
  if (dir) for (const p of runningFrom(dir)) spawnSync("taskkill", ["/f", "/t", "/pid", String(p.ProcessId)], { stdio: "ignore", windowsHide: true });
}
async function uninstallAll() {
  const k = installed();
  if (k) {
    killApp(k.InstallLocation);
    const cmd = k.QuietUninstallString || `${k.UninstallString} /S`;
    spawnSync("cmd.exe", ["/d", "/s", "/c", `"${cmd}"`], { stdio: "ignore", windowsHide: true, timeout: 120000, windowsVerbatimArguments: true });
    // (the uninstaller copies itself away and returns at once: its uninstall entry going is the end)
    await until("the uninstall", () => !installed(), 120000, 500);
    if (k.InstallLocation) await removeDir(k.InstallLocation);
  }
  await removeDir(PROFILE);
}
async function removeDir(dir) {
  await until(`${dir} removed`, () => (fs.rmSync(dir, { recursive: true, force: true }), true), 30000, 1000);
}
function setupOf(dist) {
  const yml = fs.readFileSync(path.join(dist, "latest.yml"), "utf8");
  const version = /^version:\s*(\S+)/m.exec(yml)[1];
  const file = /^path:\s*(\S+)/m.exec(yml)[1];
  return { version, file: path.join(dist, file) };
}
function asarVersion(dir) {
  const asar = require("@electron/asar");
  return JSON.parse(asar.extractFile(path.join(dir, "resources", "app.asar"), "package.json").toString()).version;
}

/** the newer build as an update feed (electron-updater's generic provider: latest.yml and the files it names) */
function startFeed(dist) {
  const served = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://x").pathname.split("/").pop() || "");
    const file = path.join(dist, name);
    served.push(`${req.method} ${name}`);
    if (!name || name.includes("..") || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-length": fs.statSync(file).size, "content-type": name.endsWith(".yml") ? "text/yaml" : "application/octet-stream" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, served, close: () => server.close() })));
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
  send(method, params = {}, ms = 30000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })),
      sleep(ms).then(() => {
        throw new Error(`${method}: no answer in ${ms} ms`);
      }),
    ]);
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
    this.port = 9600 + Math.floor(Math.random() * 200);
    this.iport = this.port + 300;
  }
  start() {
    // as a user starts it — not a child of this script (no job object, no pipes), the app's own arguments only
    this.proc = spawn(path.join(this.dir, EXE), [`--remote-debugging-port=${this.port}`, `--inspect=${this.iport}`, "--lang=en-US"], { detached: true, stdio: "ignore", env: process.env });
    this.proc.unref();
  }
  async main(body) {
    const t = await until("the main-process inspector", async () => (await (await fetch(`http://127.0.0.1:${this.iport}/json/list`)).json())[0], 90000);
    const c = await new Cdp(t.webSocketDebuggerUrl).open();
    try {
      return await c.eval(`(async () => { const req = process.mainModule.require; const electron = req("electron"); ${body} })()`);
    } finally {
      // (a Node inspector still attached keeps a quitting app waiting for it)
      c.close();
    }
  }
  async page(match, ms = 90000) {
    const t = await until(`a page matching ${match}`, async () => (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).find((x) => x.type === "page" && match.test(x.url) && !x.url.includes("surface=")), ms, 500);
    return new Cdp(t.webSocketDebuggerUrl).open();
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const tail = (file, n = 40) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-n).map((l) => `      ${l}`).join("\n") : "      (none)");

/** one try of the update from the running older app: how many presses it took, and where it ended */
async function attempt({ dir, mode, feed, newer, label }) {
  const app = new App(dir);
  const quitLog = path.join(OUT, `${label}-electron-updater.log`);
  const procLog = path.join(OUT, `${label}-processes.log`);
  const stopSampling = sampler(dir, procLog);
  const r = { label, mode, presses: 0 };
  try {
    app.start();
    say(`${label}: the app starts (${mode})`);
    const facts = await app.main(`
      const fs = req("fs");
      const log = (m) => fs.appendFileSync(${JSON.stringify(quitLog)}, new Date().toISOString().slice(11, 23) + " " + String(m).split("\\n").slice(0, 3).join(" | ") + "\\n");
      const au = req("electron-updater").autoUpdater;
      const set = au.setFeedURL.bind(au);
      au.setFeedURL = () => set({ provider: "generic", url: ${JSON.stringify(feed.url)} });
      set({ provider: "generic", url: ${JSON.stringify(feed.url)} });
      const logger = { info: (m) => log("info: " + m), warn: (m) => log("warn: " + m), error: (m) => log("error: " + m), debug: () => {} };
      au._logger = logger;
      Object.defineProperty(au, "logger", { configurable: true, get: () => logger, set: () => {} });
      au.on("error", (e) => log("error event: " + (e && e.message)));
      for (const ev of ["before-quit", "will-quit", "quit"]) electron.app.on(ev, () => log("app " + ev));
      const quit = electron.app.quit.bind(electron.app);
      electron.app.quit = () => (log("app.quit()"), quit());
      return { pid: process.pid, version: electron.app.getVersion(), packaged: electron.app.isPackaged };`);
    r.from = facts.version;
    say(`${label}: running ${facts.version} (pid ${facts.pid}, packaged ${facts.packaged})`);
    const con = await app.page(mode === "local" ? /^http:\/\/127\.0\.0\.1:\d+\// : /^file:/);
    await until("the page's bridge", () => con.eval(`!!(window.hrhNative && window.hrhNative.updates)`), 90000, 500);
    if (mode === "local") {
      const backend = await until("the local backend, from the app's folder", () => {
        const p = runningFrom(dir).filter((x) => !/^my mate geny\.exe$/i.test(x.Name));
        return p.length ? p : null;
      }, 120000, 1000);
      r.backend = backend.map((x) => x.Name).join(", ");
      say(`${label}: Local execution — running from the app's folder: ${r.backend}`);
    }
    const checked = await con.eval(`window.hrhNative.updates.check()`, 120000);
    say(`${label}: check → ${checked.status} ${checked.version || ""} ${checked.errorCode || ""}`);
    if (checked.status !== "available" || checked.version !== newer) throw new Error(`the check found ${JSON.stringify(checked)}`);

    // the press: Download & install (what the card's button does), not waited for — the app may be gone before it answers
    r.presses = 1;
    await con.eval(`window.hrhNative.updates.download().then((s) => (window.__hrhDone = s)), true`);
    let seen = "";
    const state = async () => {
      const s = await con.eval(`window.hrhNative.updates.getState()`, 3000);
      const now = `${s.status}${s.percent != null && s.status === "downloading" ? ` ${Math.round(s.percent)}%` : ""}${s.errorCode ? ` ${s.errorCode}: ${s.error}` : ""}`;
      if (now.replace(/ \d+%$/, "") !== seen.replace(/ \d+%$/, "")) say(`${label}:   ${(seen = now)}`);
      return s;
    };
    const after = await until("the download to end (the app quitting, ready, or an error)", async () => {
      if (!alive(facts.pid)) return { status: "gone" };
      try {
        const s = await state();
        return ["ready", "error"].includes(s.status) ? s : null;
      } catch {
        return alive(facts.pid) ? null : { status: "gone" };
      }
    }, 300000, 250);
    if (after.status === "error") throw new Error(`the update failed in the app: ${after.errorCode} ${after.error}`);
    if (after.status === "ready") {
      // the build this was written against: downloaded, then Restart & install wanted a press of its own
      r.presses = 2;
      say(`${label}: "ready" — a second press (Restart & install)`);
      await con.eval(`window.hrhNative.updates.install().then((s) => (window.__hrhDone = s)), true`).catch(() => {});
    }
    const pressed = Date.now();
    con.close();
    const gone = await until("the old app to quit", () => !alive(facts.pid), 60000, 200).catch(() => false);
    r.quitMs = Date.now() - pressed;
    if (!gone) throw new Error("the old app did not quit");
    say(`${label}: the old app quit after ${r.quitMs} ms`);
    const done = await until(`the installer to register ${newer}`, () => installed()?.DisplayVersion === newer, 180000, 1000).catch(() => false);
    r.installedMs = Date.now() - pressed;
    if (!done) throw new Error(`no install: the app's entry still says ${installed()?.DisplayVersion}`);
    say(`${label}: installed ${newer} after ${r.installedMs} ms`);
    const back = await until("the new version to start by itself", () => runningFrom(dir).some((x) => /^my mate geny\.exe$/i.test(x.Name)), 120000, 1000).catch(() => false);
    r.restartedMs = Date.now() - pressed;
    if (!back) throw new Error("installed, but the app did not start again");
    r.to = asarVersion(dir);
    if (r.to !== newer) throw new Error(`the running app's folder holds ${r.to}, not ${newer}`);
    say(`${label}: ${newer} runs again (${r.restartedMs} ms after the press)`);
    r.ok = true;
  } catch (e) {
    r.ok = false;
    r.error = e.message;
    say(`${label}: FAILED — ${e.message}`);
  } finally {
    await sleep(1500);
    stopSampling();
  }
  if (!r.ok) {
    console.log(`    what ran (from the app's folder, the installer):\n${tail(procLog, 60)}`);
    console.log(`    electron-updater and the app's quit:\n${tail(quitLog, 40)}`);
    console.log(`    main.log:\n${tail(path.join(PROFILE, "logs", "main.log"), 40)}`);
  }
  killApp(dir);
  await sleep(1000);
  return r;
}

async function main() {
  const older = setupOf(path.resolve(OLD_DIST));
  const newer = setupOf(path.resolve(NEW_DIST));
  say(`older ${older.version} (${path.basename(older.file)}), newer ${newer.version} (${path.basename(newer.file)})`);
  const feed = await startFeed(path.resolve(NEW_DIST));
  say(`the update feed: ${feed.url}`);
  const results = [];
  for (const mode of MODES) {
    for (let round = 1; round <= ROUNDS; round++) {
      const label = `${mode}-${round}`;
      await uninstallAll();
      const began = Date.now();
      const run = spawnSync(older.file, ["/S"], { stdio: "ignore", windowsHide: true, timeout: 600000 });
      say(`${label}: the older setup ran ${Math.round((Date.now() - began) / 1000)} s (exit ${run.status}${run.error ? `, ${run.error.message}` : ""})`);
      const k = await until("the older build installed", () => installed()?.DisplayVersion === older.version && installed(), 180000, 1000).catch((e) => {
        console.log(`    uninstall entries:\n${ps(`Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall, HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.DisplayName -like '*Mate*' -or $p.DisplayName -like '*harnessor*') { $_.Name + ' = ' + $p.DisplayName + ' ' + $p.DisplayVersion + ' @ ' + $p.InstallLocation } }`)}`);
        console.log(`    %LOCALAPPDATA%\\Programs: ${fs.readdirSync(path.join(process.env.LOCALAPPDATA, "Programs")).join(", ")}`);
        throw e;
      });
      say(`${label}: installed ${k.DisplayVersion} in ${k.InstallLocation}`);
      fs.mkdirSync(PROFILE, { recursive: true });
      fs.writeFileSync(path.join(PROFILE, "settings.json"), JSON.stringify(mode === "local" ? { launchMode: "local" } : {}, null, 2));
      const first = await attempt({ dir: k.InstallLocation, mode, feed, newer: newer.version, label });
      results.push(first);
      if (!first.ok && installed()?.DisplayVersion === older.version) {
        // as a user would: open the app again and update once more
        const again = await attempt({ dir: k.InstallLocation, mode, feed, newer: newer.version, label: `${label}-again` });
        results.push(again);
      }
    }
  }
  feed.close();
  await uninstallAll().catch(() => {});
  console.log("\nresults:");
  for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.label.padEnd(16)} presses ${r.presses}  ${r.from || "?"} → ${r.to || "-"}  quit ${r.quitMs ?? "-"} ms, installed ${r.installedMs ?? "-"} ms, running ${r.restartedMs ?? "-"} ms${r.error ? `  (${r.error})` : ""}`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  const firsts = results.filter((r) => !r.label.endsWith("-again"));
  const bad = firsts.filter((r) => !r.ok || r.presses !== 1);
  if (bad.length) {
    console.log(`\n${bad.length} of ${firsts.length} updates did not finish with one press`);
    process.exit(1);
  }
  console.log(`\nall ${firsts.length} updates: one press, the new version running`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
