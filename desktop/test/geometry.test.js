// The Mate windows' geometry (src/geometry.js): avatar edge resize, the quick
// card's remembered place (clamped to a live display) and its growth.
const test = require("node:test");
const assert = require("node:assert/strict");
const { REACH, reachable, resizeRect, quickPlacement, quickGrow } = require("../src/geometry");

const MIN = { width: 120, height: 140 };
const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 0, width: 1280, height: 1000 };

test("resize from the east / south edges grows the size, keeps the origin", () => {
  const r = resizeRect({ x: 100, y: 100, w: 300, h: 400 }, "se", 50, 30, MIN, AREA);
  assert.deepEqual(r, { x: 100, y: 100, w: 350, h: 430 });
});

test("resize from the west / north edges moves the origin, the opposite edge stays", () => {
  const r = resizeRect({ x: 100, y: 100, w: 300, h: 400 }, "nw", 40, -20, MIN, AREA);
  assert.deepEqual(r, { x: 140, y: 80, w: 260, h: 420 });
  assert.equal(r.x + r.w, 400); // right edge
  assert.equal(r.y + r.h, 500); // bottom edge
});

test("resize clamps to the minimum and the display, without drifting the far edge", () => {
  const small = resizeRect({ x: 100, y: 100, w: 300, h: 400 }, "w", 1000, 0, MIN, AREA);
  assert.equal(small.w, 120);
  assert.equal(small.x + small.w, 400);
  const big = resizeRect({ x: 0, y: 0, w: 300, h: 400 }, "s", 0, 5000, MIN, AREA);
  assert.equal(big.h, 1040);
  // the dragged edge stops at the display's edge: no window pushed off screen, none shifted
  const atRight = resizeRect({ x: 1590, y: 600, w: 314, h: 400 }, "se", 80, 60, MIN, AREA);
  assert.deepEqual(atRight, { x: 1590, y: 600, w: 330, h: 440 });
  const atLeft = resizeRect({ x: 20, y: 10, w: 300, h: 400 }, "nw", -100, -100, MIN, AREA);
  assert.deepEqual(atLeft, { x: 0, y: 0, w: 320, h: 410 });
  assert.deepEqual(resizeRect({ x: 1, y: 2, w: 300, h: 400 }, "bogus", 10, 10, MIN, AREA), { x: 1, y: 2, w: 300, h: 400 });
});

test("the quick card opens where it was dropped", () => {
  const p = quickPlacement({ x: 300, y: 500 }, 640, 76, [AREA, RIGHT], AREA);
  assert.deepEqual(p, { x: 300, y: 500, width: 640, height: 76 });
  // on the second display
  assert.deepEqual(quickPlacement({ x: 2000, y: 100 }, 640, 76, [AREA, RIGHT], AREA), { x: 2000, y: 100, width: 640, height: 76 });
});

test("a remembered place half off its display is pulled inside it", () => {
  const p = quickPlacement({ x: 1700, y: 1000 }, 640, 76, [AREA], AREA);
  assert.deepEqual(p, { x: 1280, y: 964, width: 640, height: 76 });
});

test("a place on an unplugged monitor falls back to the display under the pointer", () => {
  const p = quickPlacement({ x: 2000, y: 100 }, 640, 76, [AREA], AREA);
  assert.deepEqual(p, { x: 640, y: Math.round(1040 * 0.16), width: 640, height: 76 });
  assert.deepEqual(quickPlacement(null, 640, 76, [AREA], AREA), p);
  assert.deepEqual(quickPlacement({ x: NaN, y: 3 }, 640, 76, [AREA], AREA), p);
});

test("the quick card grows downwards at a fixed width and top edge", () => {
  const b = { x: 300, y: 200, width: 640, height: 76 };
  assert.deepEqual(quickGrow(b, 116, 640, AREA, 56, 640), { x: 300, y: 200, width: 640, height: 116 });
  // a width the page measured never changes the window (it used to shrink line by line)
  assert.equal(quickGrow({ ...b, width: 500 }, 116, 640, AREA, 56, 640).width, 640);
  // capped, then the text scrolls inside the card
  assert.equal(quickGrow(b, 2000, 640, AREA, 56, 640).height, 640);
  assert.equal(quickGrow(b, 10, 640, AREA, 56, 640).height, 56);
});

test("near the bottom of the screen the card moves up just enough to stay on it", () => {
  const b = { x: 300, y: 960, width: 640, height: 76 };
  const g = quickGrow(b, 200, 640, AREA, 56, 640);
  assert.equal(g.height, 200);
  assert.equal(g.y + g.height, 1040);
});

test("the avatar's window stays where it is put — past the bottom, over the taskbar, off a side (the report: it wouldn't go lower)", () => {
  const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };
  // (lower than the work area's bottom — over the taskbar, half below the screen: kept)
  for (const b of [{ x: 1500, y: 700, width: 400, height: 500 }, { x: 1500, y: 900, width: 400, height: 500 }, { x: -250, y: 300, width: 400, height: 500 }, { x: 1700, y: -300, width: 400, height: 500 }]) {
    assert.deepEqual(reachable(b, SCREEN), b);
  }
  // only never all the way out: a piece of it (REACH px) stays on the screen to grab
  assert.deepEqual(reachable({ x: 1500, y: 2000, width: 400, height: 500 }, SCREEN), { x: 1500, y: 1080 - REACH, width: 400, height: 500 });
  assert.deepEqual(reachable({ x: -900, y: 100, width: 400, height: 500 }, SCREEN), { x: -400 + REACH, y: 100, width: 400, height: 500 });
  // a window bigger than the screen is the screen's size at most
  assert.deepEqual(reachable({ x: 0, y: 0, width: 4000, height: 300 }, SCREEN).width, 1920);
});

test("a window put past the work area's edge isn't pulled back in by a resize there", () => {
  // (its bottom over the taskbar, below the work area's: the south edge grows it, never snaps it shorter)
  const r = resizeRect({ x: 100, y: 800, w: 300, h: 400 }, "s", 0, 20, MIN, AREA);
  assert.deepEqual(r, { x: 100, y: 800, w: 300, h: 400 });
  const shrink = resizeRect({ x: 100, y: 800, w: 300, h: 400 }, "s", 0, -50, MIN, AREA);
  assert.equal(shrink.h, 350);
});
