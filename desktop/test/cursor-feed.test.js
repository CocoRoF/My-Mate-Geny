// src/cursor-feed.js: the pointer anywhere on the desktop for a page whose avatar looks at it, and the display in use
// (all screens shared: its picture is the main one).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCursorFeed, createPointerActivity } = require("../src/cursor-feed");

function setup() {
  let pt = { x: 0, y: 0 };
  const timers = [];
  const win = { destroyed: false, visible: true, min: false, isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isMinimized() { return this.min; }, getContentBounds: () => ({ x: 100, y: 200, width: 300, height: 400 }) };
  const wc = { sent: [], dead: false, isDestroyed() { return this.dead; }, send(ch, p) { this.sent.push([ch, p]); }, once() {} };
  const feed = createCursorFeed({
    screen: { getCursorScreenPoint: () => pt },
    fromWebContents: () => win,
    setInterval: (fn) => (timers.push(fn), { unref() {} }),
    clearInterval: () => timers.splice(0),
  });
  return { feed, wc, win, timers, at: (x, y) => (pt = { x, y }) };
}

test("outside her window: where the pointer is, in the window's coordinates; once per move", () => {
  const { feed, wc, timers, at } = setup();
  feed.follow(wc, true);
  assert.equal(timers.length, 1, "the feed runs while someone follows");
  at(50, 150);
  feed.tick();
  feed.tick();
  assert.deepEqual(wc.sent, [["cursor:point", { x: -50, y: -50 }]], "left of and above her window, once");
  at(1000, 900);
  feed.tick();
  assert.deepEqual(wc.sent.at(-1), ["cursor:point", { x: 900, y: 700 }]);
});

test("over her window: nothing (the page's own events); hidden or minimized: nothing", () => {
  const { feed, wc, win, at } = setup();
  feed.follow(wc, true);
  at(150, 250);
  feed.tick();
  assert.deepEqual(wc.sent, []);
  at(0, 0);
  win.visible = false;
  feed.tick();
  win.visible = true;
  win.min = true;
  feed.tick();
  assert.deepEqual(wc.sent, []);
  win.min = false;
  feed.tick();
  assert.equal(wc.sent.length, 1);
});

test("stops when nobody follows, and forgets a page that is gone", () => {
  const { feed, wc, timers, at } = setup();
  feed.follow(wc, true);
  feed.follow(wc, false);
  assert.equal(timers.length, 0);
  assert.equal(feed.size(), 0);
  feed.follow(wc, true);
  wc.dead = true;
  at(5, 5);
  feed.tick();
  assert.equal(feed.size(), 0);
  feed.tick();
  assert.equal(timers.length, 0, "and stops then");
});

test("the display in use: where the pointer last moved (30 s), else the one under it, else the primary", () => {
  let pt = { x: 10, y: 10 }, now = 1000, broken = false;
  // display 1: x < 100; display 2: x ≥ 100 (the primary one)
  let displays = [{ id: 1 }, { id: 2 }];
  const timers = [];
  const activity = createPointerActivity({
    screen: {
      getCursorScreenPoint: () => { if (broken) throw new Error("no pointer"); return pt; },
      getDisplayNearestPoint: (p) => (p.x < 100 ? { id: 1 } : { id: 2 }),
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => ({ id: 2 }),
    },
    now: () => now,
    setInterval: (fn) => (timers.push(fn), { unref() {} }),
    clearInterval: () => timers.splice(0),
  });
  assert.equal(activity.displayId(), "1", "never moved: the display under the pointer");
  activity.run(true);
  assert.equal(timers.length, 1);
  activity.run(true);
  assert.equal(timers.length, 1, "one sampler");
  pt = { x: 150, y: 10 };
  activity.tick();
  pt = { x: 50, y: 10 }; // (it went back, not sampled yet)
  now += 20_000;
  assert.equal(activity.displayId(), "2", "it moved on display 2 within 30 s");
  now += 11_000;
  assert.equal(activity.displayId(), "1", "too long ago: the display under it");
  activity.tick();
  assert.equal(activity.displayId(), "1");
  displays = [{ id: 2 }];
  assert.equal(activity.displayId(), "2", "a display that is gone: the primary one");
  displays = [{ id: 1 }, { id: 2 }];
  broken = true;
  activity.tick();
  now += 60_000;
  assert.equal(activity.displayId(), "2", "no pointer: the primary display");
  activity.run(false);
  assert.equal(timers.length, 0);
  assert.equal(activity.running(), false);
});
