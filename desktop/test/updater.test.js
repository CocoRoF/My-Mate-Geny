// src/updater.js: the in-app update state machine (check → download with progress → ready → install), with a fake
// electron-updater.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdater, compareVersions, support, restartArgs, restartCommand } = require("../src/updater");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeUpdateConfig } = require("../build/after-pack");

// (a few turns of the event loop: the updater awaits the cookie, electron-updater and a fresh look at the feed)
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

class FakeToken {
  constructor() {
    this.cancelled = false;
    this.onCancel = null;
  }
  cancel() {
    this.cancelled = true;
    this.onCancel?.();
  }
}

function fakeUpdater({ latest = "0.4.20", size = 1000, fail = null, start = null } = {}) {
  const u = new EventEmitter();
  u.calls = [];
  u.setFeedURL = (o) => {
    u.calls.push(["feed", o.url]);
    u.checked = false; // (electron-updater forgets the checked update: "Please check update first")
  };
  u.checkForUpdates = async () => {
    u.calls.push(["check", u.requestHeaders]);
    u.checked = true;
    if (fail === "check") throw new Error("HttpError: 401 Unauthorized authentication required");
    return { updateInfo: { version: latest, files: [{ size }] } };
  };
  u.downloadUpdate = (token) =>
    new Promise((resolve, reject) => {
      if (!u.checked) return reject(new Error("Please check update first"));
      u.calls.push(["download"]);
      u.pending = { resolve, reject, token };
      token.onCancel = () => reject(new Error("cancelled"));
    });
  // electron-updater 6.3.9's BaseUpdater.install / quitAndInstall with NsisUpdater.doInstall, as far as the updater
  // sees them: the installer is started, not waited for; a start Windows refuses (EACCES / UNKNOWN) is tried again
  // through elevate.exe, any other failure is an "error" event. `start`: the error code a start fails with (by file)
  u.spawned = [];
  u.quits = 0;
  u.app = { quit: () => u.quits++ };
  u.spawnLog = async (cmd, args) => {
    u.spawned.push([cmd, args]);
    const code = typeof start === "function" ? start(cmd) : start;
    if (code) throw Object.assign(new Error(`spawn ${cmd} ${code}`), { code });
    return true;
  };
  u.install = (silent, run) => {
    u.calls.push(["install", silent, run]);
    if (u.quitAndInstallCalled) return false; // ("install call ignored: quitAndInstallCalled is set to true")
    u.quitAndInstallCalled = true;
    const args = ["--updated", ...(silent ? ["/S"] : []), ...(run ? ["--force-run"] : [])];
    u.spawnLog("setup.exe", args).catch((e) => {
      if (e.code === "EACCES" || e.code === "UNKNOWN") u.spawnLog("elevate.exe", ["setup.exe", ...args]).catch((err) => u.emit("error", err));
      else u.emit("error", e);
    });
    return true;
  };
  u.quitAndInstall = (silent, run) => {
    if (u.install(silent, run)) setImmediate(() => u.app.quit());
    else u.quitAndInstallCalled = false;
  };
  return u;
}

function make(opts = {}) {
  const u = opts.u || fakeUpdater(opts);
  const states = [];
  let t = 1_000_000;
  const up = createUpdater({
    autoUpdater: async () => u,
    cancelToken: () => new FakeToken(),
    version: "0.4.11",
    platform: opts.platform || "win32",
    isPackaged: opts.isPackaged ?? true,
    env: opts.env || {},
    server: () => (opts.server === undefined ? "https://srv" : opts.server),
    cookieHeader: async () => "hrh_session=abc",
    beforeInstall: () => states.push("before-install"),
    quit: () => states.push("quit"),
    onState: (s) => states.push(s),
    now: () => t,
    ...(opts.deps || {}),
  });
  return { up, u, states, tick: (ms) => (t += ms) };
}

test("versions compare numerically", () => {
  assert.equal(compareVersions("0.4.12", "0.4.9"), 1);
  assert.equal(compareVersions("0.4.9", "0.4.12"), -1);
  assert.equal(compareVersions("0.4.11", "0.4.11"), 0);
});

test("support: Windows / AppImage / deb yes; macOS (unsigned), dev runs and no server: no, with what to do", () => {
  assert.equal(support({ isPackaged: true, platform: "win32", server: "s" }).how, "installer");
  assert.equal(support({ isPackaged: true, platform: "linux", env: { APPIMAGE: "/a" }, server: "s" }).how, "appimage");
  assert.equal(support({ isPackaged: true, platform: "linux", env: {}, server: "s" }).how, "deb");
  assert.match(support({ isPackaged: true, platform: "darwin", server: "s" }).reason, /\.dmg/);
  assert.equal(support({ isPackaged: true, platform: "darwin", server: "s", macSigned: true }).how, "mac");
  assert.equal(support({ isPackaged: false, platform: "win32", server: "s" }).ok, false);
  assert.equal(support({ isPackaged: false, platform: "win32", env: { HRH_UPDATER_DEV: "1" }, server: "s" }).ok, true);
  assert.equal(support({ isPackaged: true, platform: "win32", server: "" }).ok, false);
});

test("check → available → download with progress (speed, ETA) → ready → installed at once: one press", async () => {
  const { up, u, states, tick } = make();
  const s1 = await up.check();
  assert.equal(s1.status, "available");
  assert.equal(s1.version, "0.4.20");
  assert.deepEqual(u.calls[0], ["feed", "https://srv/api/downloads/update"]);
  assert.deepEqual(u.calls[1], ["check", { Cookie: "hrh_session=abc" }], "the session cookie goes along");
  const p = up.download();
  await settle();
  assert.equal(up.state.status, "downloading");
  u.emit("download-progress", { percent: 25, transferred: 250, total: 1000, bytesPerSecond: 50 });
  tick(1000);
  u.emit("download-progress", { percent: 50, transferred: 500, total: 1000, bytesPerSecond: 0 });
  const mid = up.state;
  assert.equal(mid.percent, 50);
  assert.equal(mid.bytesPerSecond, 250, "measured when the event has no speed");
  assert.equal(mid.eta, 2);
  u.emit("update-downloaded", { version: "0.4.20" });
  u.pending.resolve();
  const done = await p;
  assert.ok(states.some((s) => s.status === "ready"), "ready on the way");
  assert.equal(done.status, "installing", "Download & install needs no second press");
  assert.ok(states.includes("before-install"), "the app is told it is quitting for real");
  assert.deepEqual(u.calls.at(-1), ["install", false, true], "Windows: the installer's progress on screen, then the app");
  assert.deepEqual(u.spawned, [["setup.exe", ["--updated", "--force-run"]]]);
  assert.ok(states.indexOf("quit") > states.indexOf("before-install"), "the app quits once the installer runs");
  assert.equal(u.quits, 0, "and it is the app that quits, not electron-updater on its next turn");
  await up.install();
  assert.equal(u.calls.filter((c) => c[0] === "install").length, 1, "a second press does nothing more");
});

test("cancel → back to available (retry downloads again); the state survives for a page that asks later", async () => {
  const { up, u } = make();
  await up.check();
  const p = up.download();
  await settle();
  u.emit("download-progress", { percent: 10, transferred: 100, total: 1000, bytesPerSecond: 100 });
  up.cancel();
  const s = await p;
  assert.equal(s.status, "available");
  assert.equal(s.cancelled, true);
  // a page that reloads reads the same state
  assert.equal(up.state.status, "available");
  const again = up.download();
  await settle();
  assert.equal(up.state.status, "downloading");
  u.pending.resolve();
  assert.equal((await again).status, "installing");
});

test("errors say what happened, and Retry repeats what failed", async () => {
  const { up, u } = make({ fail: "check" });
  const s = await up.check();
  assert.equal(s.status, "error");
  assert.match(s.error, /sign in/);
  const u2 = fakeUpdater();
  Object.assign(u, { checkForUpdates: u2.checkForUpdates });
  assert.equal((await up.retry()).status, "available");
  const p = up.download();
  await settle();
  u.pending.reject(new Error("sha512 checksum mismatch"));
  const e = await p;
  assert.equal(e.status, "error");
  assert.equal(e.during, "download");
  assert.match(e.error, /damaged/);
  const r = up.retry();
  await settle();
  assert.equal(up.state.status, "downloading", "retry goes straight back to downloading");
  u.pending.resolve();
  assert.equal((await r).status, "installing");
});

test("up to date; unsupported platforms never touch electron-updater; Linux .deb installs without silent/force-run", async () => {
  const a = make({ latest: "0.4.11" });
  assert.equal((await a.up.check()).status, "latest");
  const m = make({ platform: "darwin" });
  const s = await m.up.check();
  assert.equal(s.status, "unsupported");
  assert.match(s.reason, /dmg/);
  assert.equal(m.u.calls.length, 0);
  const d = make({ platform: "linux", env: {} });
  await d.up.check();
  const p = d.up.download();
  await settle();
  d.u.pending.resolve();
  await p;
  assert.deepEqual(d.u.calls.at(-1), ["install", false, false]);
});

test("a download looks at the feed again first: an hour-old 'available' takes the build the server has now", async () => {
  const { up, u } = make({ latest: "0.4.14" });
  assert.equal((await up.check()).version, "0.4.14");
  // the rolling release moved on meanwhile (the live log: 0.4.14's file → 404 while the page still offered it)
  const later = fakeUpdater({ latest: "0.4.15" });
  u.checkForUpdates = later.checkForUpdates;
  const p = up.download();
  await settle();
  assert.equal(up.state.status, "downloading");
  assert.equal(up.state.version, "0.4.15", "the download is the current build");
  u.pending.resolve();
  assert.equal((await p).status, "installing");
});

test("a 404 mid-download (the build was replaced): one more look, then the newer build; twice: a clear error", async () => {
  const { up, u } = make();
  await up.check();
  const p = up.download();
  await settle();
  u.pending.reject(new Error("HttpError: 404 Not Found"));
  await settle();
  assert.equal(up.state.status, "downloading", "looked again and downloads anew");
  assert.equal(u.calls.filter((c) => c[0] === "download").length, 2);
  u.pending.reject(new Error("HttpError: 404 Not Found"));
  const e = await p;
  assert.equal(e.status, "error");
  assert.match(e.error, /no longer has that build/);
  assert.equal(e.errorCode, "replaced", "a code for the console to word in its language");
  assert.equal((await up.check()).errorCode, undefined, "a later success clears it");
});

test("the feed declines (not an AppImage / .deb / installer it knows): an error, never 'up to date'", async () => {
  const { up, u } = make();
  u.checkForUpdates = async () => null;
  const s = await up.check();
  assert.equal(s.status, "error");
  assert.match(s.error, /cannot replace itself/);
});

// electron-updater 6.3.9's BaseUpdater.install / AppImageUpdater.doInstall, as far as the updater sees them
function appImageUpdater(fail) {
  const u = fakeUpdater();
  u.install = (silent, run) => {
    u.calls.push(["install", silent, run]);
    if (u.quitAndInstallCalled) return false;
    u.quitAndInstallCalled = true;
    if (fail) {
      u.emit("error", new Error(fail)); // doInstall threw → dispatchError, install returns false
      return false;
    }
    if (run) u.spawnLog("/home/me/Apps/my-mate-geny-0.4.16-linux-x86_64.AppImage", [], {});
    return true;
  };
  return u;
}

/** check, then Download & install: the download, and the install it goes on to */
async function downloadAndInstall(opts) {
  const m = make(opts);
  await m.up.check();
  const p = m.up.download();
  await settle();
  m.u.pending.resolve();
  m.result = await p;
  return m;
}

test("AppImage: the restart is ours — the new file with this app's arguments, after this process exits", async () => {
  const restarted = [];
  const u = appImageUpdater();
  const own = u.spawnLog;
  const { up } = await downloadAndInstall({ u, platform: "linux", env: { APPIMAGE: "/home/me/Apps/my-mate-geny-0.4.14-linux-x86_64.AppImage" }, deps: { restartAfter: (f) => restarted.push(f) } });
  assert.deepEqual(u.calls.at(-1), ["install", true, true]);
  assert.deepEqual(restarted, ["/home/me/Apps/my-mate-geny-0.4.16-linux-x86_64.AppImage"], "the file electron-updater put in place");
  assert.deepEqual(u.spawned, [], "electron-updater's own argument-less start did not happen");
  assert.equal(u.spawnLog, own, "electron-updater is left as it was");
  assert.equal(up.state.status, "installing");
});

test("Windows keeps the installer's own restart (it shows its progress, then starts the app: build/installer.nsh)", async () => {
  const restarted = [];
  const { u } = await downloadAndInstall({ platform: "win32", deps: { restartAfter: (f) => restarted.push(f) } });
  assert.deepEqual(u.calls.at(-1), ["install", false, true]);
  assert.deepEqual(restarted, []);
  assert.equal(u.spawned.length, 1);
});

test("an install that fails says so (not 'Installing…' forever); Retry installs again", async () => {
  const undone = [];
  const u = appImageUpdater("EACCES: permission denied, unlink '/opt/my-mate-geny.AppImage'");
  const { up, result: s, states } = await downloadAndInstall({ u, platform: "linux", env: { APPIMAGE: "/opt/my-mate-geny.AppImage" }, deps: { restartAfter: () => {}, installFailed: () => undone.push(1) } });
  assert.equal(s.status, "error");
  assert.ok(!states.includes("quit"), "the app stays");
  assert.equal(s.during, "install");
  assert.match(s.error, /EACCES/);
  assert.equal(undone.length, 1, "the app is no longer 'quitting'");
  const r = await up.retry();
  assert.equal(u.calls.filter((c) => c[0] === "install").length, 2, "Retry installs again");
  assert.equal(r.status, "error");
});

test("Windows refuses the installer's start (EACCES): electron-updater's elevate.exe start counts, then the app quits", async () => {
  const { u, result, states } = await downloadAndInstall({ u: fakeUpdater({ start: (cmd) => (cmd === "setup.exe" ? "EACCES" : null) }) });
  assert.equal(result.status, "installing");
  assert.deepEqual(u.spawned.map((x) => x[0]), ["setup.exe", "elevate.exe"]);
  assert.ok(states.includes("quit"));
});

test("an installer that does not start keeps the app and says why (no quit with nothing installed); Retry starts it", async () => {
  const undone = [];
  let code = "EBUSY";
  const u = fakeUpdater({ start: () => code });
  const { up, result, states } = await downloadAndInstall({ u, deps: { installFailed: () => undone.push(1) } });
  assert.equal(result.status, "error");
  assert.equal(result.during, "install");
  assert.match(result.error, /EBUSY/);
  assert.ok(!states.includes("quit"), "the app stays");
  assert.equal(u.quits, 0);
  assert.equal(undone.length, 1, "the app is no longer 'quitting' (once)");
  code = null;
  const r = await up.retry();
  assert.equal(r.status, "installing");
  assert.equal(u.spawned.length, 2, "electron-updater's guard against a second start does not swallow Retry");
  assert.ok(states.includes("quit"));
});

test("the app's own processes stop first: the installer starts once beforeInstall is done", async () => {
  const order = [];
  let release;
  const u = fakeUpdater();
  const own = u.spawnLog;
  u.spawnLog = (...a) => (order.push("installer"), own(...a));
  const m = make({ u, deps: { beforeInstall: () => new Promise((r) => { order.push("stopping"); release = () => (order.push("stopped"), r()); }) } });
  await m.up.check();
  const p = m.up.download();
  await settle();
  u.pending.resolve();
  await settle();
  assert.equal(m.up.state.status, "installing");
  assert.deepEqual(order, ["stopping"]);
  release();
  assert.equal((await p).status, "installing");
  assert.deepEqual(order, ["stopping", "stopped", "installer"]);
  assert.ok(m.states.includes("quit"));
});

test("macOS: Squirrel.Mac's own quitAndInstall (it quits once it has the update)", async () => {
  const u = fakeUpdater();
  delete u.install;
  u.quitAndInstall = (silent, run) => u.calls.push(["quitAndInstall", silent, run]);
  const { result, states } = await downloadAndInstall({ u, platform: "darwin", deps: { macSigned: true } });
  assert.equal(result.status, "installing");
  assert.deepEqual(u.calls.at(-1), ["quitAndInstall", true, true]);
  assert.ok(!states.includes("quit"));
});

test("restart arguments: this app's own, never a hidden start; the command waits for this process", () => {
  assert.deepEqual(restartArgs(["/tmp/.mount_x/hr-harnessor-desktop", "--no-sandbox", "--ozone-platform=x11", "--hidden"]), ["--no-sandbox", "--ozone-platform=x11"]);
  const [cmd, args] = restartCommand(4242, "/a/b c.AppImage", ["--no-sandbox"]);
  assert.equal(cmd, "/bin/sh");
  assert.deepEqual(args.slice(2), ["sh", "4242", "/a/b c.AppImage", "--no-sandbox"]);
  assert.match(args[1], /kill -0 "\$1".*exec "\$@"/);
});

test('Quit cancels active downloads, disables install-on-quit, and ignores late updater events',async()=>{
 const {up,u,states}=make();await up.check();const download=up.download();await settle();
 up.shutdown();await download;
 assert.equal(u.autoInstallOnAppQuit,false);assert.equal(u.autoRunAppAfterInstall,false);
 const n=states.length;u.emit('update-downloaded',{version:'9.0.0'});u.emit('error',Error('late failure'));
 await up.install();await up.check();assert.equal(states.length,n);assert.equal(u.calls.some(x=>x[0]==='install'),false);
});
test('Quit while updater initialization is pending cannot run an installer later',async()=>{
 const u=fakeUpdater();let release;
 const {up}=make({u,deps:{autoUpdater:()=>new Promise(r=>{release=r;})}});
 const check=up.check();up.shutdown();release(u);await check;
 assert.equal(u.autoInstallOnAppQuit,false);assert.equal(u.calls.some(x=>x[0]==='check'),false);
});

test("the Mac app carries the file electron-updater reads for its cache folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-config-"));
  const text = fs.readFileSync(writeUpdateConfig(dir, "hr-harnessor-desktop"), "utf8");
  assert.match(text, /^provider: generic$/m);
  assert.match(text, /^updaterCacheDirName: hr-harnessor-desktop-updater$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});
