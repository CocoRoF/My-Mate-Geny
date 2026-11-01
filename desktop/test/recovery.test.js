// src/recovery.js: no black windows — load failures, crashes, hangs and blank pages lead to the retry page.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const rec = require("../src/recovery");

function fakeClock() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, at: t + ms, every: ms });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, x] = next;
        t = x.at;
        if (x.every) x.at += x.every;
        else timers.delete(id);
        await x.fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
    },
  };
}

test("retry delay grows 2 s, 4 s, 8 s … and stops at 60 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 20].map(rec.retryDelay), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(rec.retryDelay(-1), 2000);
  assert.equal(rec.retryDelay("x"), 2000);
});

test("only main-frame failures that are not 'aborted' count", () => {
  assert.equal(rec.isRealLoadFailure(-105, true), true); // name not resolved
  assert.equal(rec.isRealLoadFailure(-102, true), true); // connection refused
  assert.equal(rec.isRealLoadFailure(-3, true), false); // aborted: another load replaced it
  assert.equal(rec.isRealLoadFailure(-105, false), false); // a subframe
});

test("failures show the retry page with a growing delay; a page that stayed up resets it", () => {
  const c = fakeClock();
  const shown = [];
  const r = rec.createRecovery({ show: (i) => shown.push(i), ...c });
  assert.equal(r.failLoad(-3, "", true), null);
  r.failLoad(-102, "ERR_CONNECTION_REFUSED", true);
  r.failLoad(-102, "ERR_CONNECTION_REFUSED", true);
  r.gone({ reason: "crashed" });
  assert.deepEqual(shown.map((x) => [x.reason, x.attempt, x.delay]), [["offline", 0, 2000], ["offline", 1, 4000], ["crashed", 2, 8000]]);
  assert.equal(shown[0].error, "ERR_CONNECTION_REFUSED");
  assert.equal(r.gone({ reason: "clean-exit" }), null, "a clean exit is no crash");
  // loaded, crashed again quickly: the backoff goes on (no tight crash loop)
  r.loaded();
  c.now();
  r.gone({ reason: "oom" });
  assert.equal(shown.at(-1).attempt, 3);
  // loaded and up for a while: back to the first delay
  r.loaded();
  const t0 = c.now();
  c.setTimeout(() => {}, 0);
  return c.advance(rec.STABLE_MS + 1).then(() => {
    assert.ok(c.now() - t0 > rec.STABLE_MS);
    r.failLoad(-106, "ERR_INTERNET_DISCONNECTED", true);
    assert.deepEqual([shown.at(-1).attempt, shown.at(-1).delay], [0, 2000]);
  });
});

test("unresponsive: replaced after the grace time, unless it answers again", async () => {
  const c = fakeClock();
  const shown = [];
  const r = rec.createRecovery({ show: (i) => shown.push(i), ...c });
  r.unresponsive();
  await c.advance(rec.UNRESPONSIVE_GRACE - 100);
  r.responsive();
  await c.advance(10_000);
  assert.equal(shown.length, 0, "it came back in time");
  r.unresponsive();
  r.unresponsive(); // (repeated events: one timer)
  await c.advance(rec.UNRESPONSIVE_GRACE + 1);
  assert.deepEqual(shown.map((x) => x.reason), ["unresponsive"]);
});

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.url = "http://srv/";
    this.loads = [];
    this.root = 1;
    this.visible = true;
    this.destroyed = false;
    const wc = new EventEmitter();
    wc.getURL = () => this.url;
    wc.isLoading = () => false;
    wc.executeJavaScript = async () => this.root;
    this.webContents = wc;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  loadFile(file, opts) {
    this.loads.push({ file, query: opts.query });
    this.url = `file://${file}`;
    return Promise.resolve();
  }
}

const isApp = (u) => u.startsWith("http://srv/");

test("attach: did-fail-load / render-process-gone / unresponsive put the retry page up, with the window's kind", async () => {
  const c = fakeClock();
  const w = new FakeWindow();
  rec.attach(w, { kind: "chat", isAppUrl: isApp, retryPage: "/app/offline.html", server: () => "http://srv", timers: c });
  w.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://srv/", true);
  assert.equal(w.loads.length, 0);
  w.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://srv/", true);
  assert.equal(w.loads.length, 1);
  assert.deepEqual(w.loads[0], { file: "/app/offline.html", query: { kind: "chat", reason: "offline", server: "http://srv", error: "ERR_CONNECTION_REFUSED", attempt: "0", delay: "2000" } });
  w.url = "http://srv/?surface=mate-chat";
  w.webContents.emit("did-finish-load");
  w.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(w.loads.at(-1).query.reason, "crashed");
  w.url = "http://srv/?surface=mate-chat";
  w.emit("unresponsive");
  await c.advance(rec.UNRESPONSIVE_GRACE + 1);
  assert.equal(w.loads.at(-1).query.reason, "unresponsive");
  w.emit("closed");
});

test("attach: a loaded page that draws nothing (empty #root, twice in a row) is replaced; a drawn one is left alone", async () => {
  const c = fakeClock();
  const w = new FakeWindow();
  rec.attach(w, { kind: "console", isAppUrl: isApp, retryPage: "/app/offline.html", watchBlank: true, timers: c });
  w.webContents.emit("did-finish-load");
  await c.advance(rec.BLANK_EVERY * 5);
  assert.equal(w.loads.length, 0, "drawn: nothing happens");
  w.root = 0; // React unmounted (e.g. an old page whose code chunk vanished in a deploy)
  await c.advance(rec.BLANK_EVERY);
  assert.equal(w.loads.length, 0, "one empty look is not enough");
  await c.advance(rec.BLANK_EVERY);
  assert.equal(w.loads.length, 1);
  assert.equal(w.loads[0].query.reason, "blank");
  // the retry page itself is not watched
  await c.advance(rec.BLANK_EVERY * 4);
  assert.equal(w.loads.length, 1);
  // a hidden window is not judged (no work while hidden)
  w.url = "http://srv/";
  w.webContents.emit("did-finish-load");
  w.visible = false;
  await c.advance(rec.BLANK_EVERY * 4);
  assert.equal(w.loads.length, 1);
  // pages without #root (the login page) are never "blank"
  w.visible = true;
  w.root = -1;
  await c.advance(rec.BLANK_EVERY * 4);
  assert.equal(w.loads.length, 1);
  w.emit("closed");
});
