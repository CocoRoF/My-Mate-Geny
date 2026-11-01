// src/updater.js: the in-app update state machine (check → download with progress → ready → install), with a fake
// electron-updater.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdater, compareVersions, support, restartArgs, restartCommand } = require("../src/updater");

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

function fakeUpdater({ latest = "0.4.20", size = 1000, fail = null } = {}) {
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
  u.quitAndInstall = (silent, run) => u.calls.push(["install", silent, run]);
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
  assert.equal(support({ isPackaged: false, platform: "win32", server: "s" }).ok, false);
  assert.equal(support({ isPackaged: false, platform: "win32", env: { HRH_UPDATER_DEV: "1" }, server: "s" }).ok, true);
  assert.equal(support({ isPackaged: true, platform: "win32", server: "" }).ok, false);
});

test("check → available → download with progress (speed, ETA) → ready → install", async () => {
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
  assert.equal(done.status, "ready");
  await up.install();
  assert.ok(states.includes("before-install"), "the app is told it is quitting for real");
  assert.deepEqual(u.calls.at(-1), ["install", true, true]);
  assert.equal(up.state.status, "installing");
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
  assert.equal((await again).status, "ready");
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
  assert.equal((await r).status, "ready");
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
  await d.up.install();
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
  assert.equal((await p).status, "ready");
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
});

test("the feed declines (not an AppImage / .deb / installer it knows): an error, never 'up to date'", async () => {
  const { up, u } = make();
  u.checkForUpdates = async () => null;
  const s = await up.check();
  assert.equal(s.status, "error");
  assert.match(s.error, /cannot replace itself/);
});

// electron-updater 6.3.9's BaseUpdater.quitAndInstall / AppImageUpdater.doInstall, as far as the updater sees them
function installingUpdater(fail) {
  const u = fakeUpdater();
  u.spawned = [];
  u.spawnLog = async (cmd, args) => u.spawned.push([cmd, args]);
  u.quitAndInstall = (silent, run) => {
    u.calls.push(["install", silent, run]);
    if (fail) return u.emit("error", new Error(fail)); // install() → dispatchError, returns false: no quit
    u.spawnLog("/home/me/Apps/my-mate-geny-0.4.16-linux-x86_64.AppImage", [], {});
  };
  return u;
}

async function readyToInstall(opts) {
  const m = make(opts);
  await m.up.check();
  const p = m.up.download();
  await settle();
  m.u.pending.resolve();
  await p;
  return m;
}

test("AppImage: the restart is ours — the new file with this app's arguments, after this process exits", async () => {
  const restarted = [];
  const { up, u } = await readyToInstall({ u: installingUpdater(), platform: "linux", env: { APPIMAGE: "/home/me/Apps/my-mate-geny-0.4.14-linux-x86_64.AppImage" }, deps: { restartAfter: (f) => restarted.push(f) } });
  const own = u.spawnLog;
  await up.install();
  assert.deepEqual(u.calls.at(-1), ["install", true, true]);
  assert.deepEqual(restarted, ["/home/me/Apps/my-mate-geny-0.4.16-linux-x86_64.AppImage"], "the file electron-updater put in place");
  assert.deepEqual(u.spawned, [], "electron-updater's own argument-less start did not happen");
  assert.equal(u.spawnLog, own, "electron-updater is left as it was");
  assert.equal(up.state.status, "installing");
});

test("Windows keeps electron-updater's own restart (the NSIS installer's --force-run)", async () => {
  const restarted = [];
  const { up, u } = await readyToInstall({ u: installingUpdater(), platform: "win32", deps: { restartAfter: (f) => restarted.push(f) } });
  await up.install();
  assert.deepEqual(u.calls.at(-1), ["install", true, true]);
  assert.deepEqual(restarted, []);
  assert.equal(u.spawned.length, 1);
});

test("an install that fails says so (not 'Installing…' forever); Retry installs again", async () => {
  const undone = [];
  const u = installingUpdater("EACCES: permission denied, unlink '/opt/my-mate-geny.AppImage'");
  const { up } = await readyToInstall({ u, platform: "linux", env: { APPIMAGE: "/opt/my-mate-geny.AppImage" }, deps: { restartAfter: () => {}, installFailed: () => undone.push(1) } });
  const s = await up.install();
  assert.equal(s.status, "error");
  assert.equal(s.during, "install");
  assert.match(s.error, /EACCES/);
  assert.equal(undone.length, 1, "the app is no longer 'quitting'");
  const r = await up.retry();
  assert.equal(u.calls.filter((c) => c[0] === "install").length, 2, "Retry installs again");
  assert.equal(r.status, "error");
});

test("restart arguments: this app's own, never a hidden start; the command waits for this process", () => {
  assert.deepEqual(restartArgs(["/tmp/.mount_x/hr-harnessor-desktop", "--no-sandbox", "--ozone-platform=x11", "--hidden"]), ["--no-sandbox", "--ozone-platform=x11"]);
  const [cmd, args] = restartCommand(4242, "/a/b c.AppImage", ["--no-sandbox"]);
  assert.equal(cmd, "/bin/sh");
  assert.deepEqual(args.slice(2), ["sh", "4242", "/a/b c.AppImage", "--no-sandbox"]);
  assert.match(args[1], /kill -0 "\$1".*exec "\$@"/);
});
