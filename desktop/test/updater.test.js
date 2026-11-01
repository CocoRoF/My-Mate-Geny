// src/updater.js: the in-app update state machine (check → download with progress → ready → install), with a fake
// electron-updater.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdater, compareVersions, support } = require("../src/updater");

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
  await new Promise((r) => setImmediate(r));
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
  await new Promise((r) => setImmediate(r));
  u.emit("download-progress", { percent: 10, transferred: 100, total: 1000, bytesPerSecond: 100 });
  up.cancel();
  const s = await p;
  assert.equal(s.status, "available");
  assert.equal(s.cancelled, true);
  // a page that reloads reads the same state
  assert.equal(up.state.status, "available");
  const again = up.download();
  await new Promise((r) => setImmediate(r));
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
  await new Promise((r) => setImmediate(r));
  u.pending.reject(new Error("sha512 checksum mismatch"));
  const e = await p;
  assert.equal(e.status, "error");
  assert.equal(e.during, "download");
  assert.match(e.error, /damaged/);
  const r = up.retry();
  await new Promise((r2) => setImmediate(r2));
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
  await new Promise((r) => setImmediate(r));
  d.u.pending.resolve();
  await p;
  await d.up.install();
  assert.deepEqual(d.u.calls.at(-1), ["install", false, false]);
});
