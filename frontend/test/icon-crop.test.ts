// A profile picture's square crop (src/lib/iconCrop.ts; the crop dialog, MateThumb): it stays inside the picture, the
// slider zooms about its middle, a drag moves the picture with the finger, her face is where her rig says, and the CSS
// shows exactly that square.   Run: npm run test:unit
import assert from "node:assert/strict";
import test from "node:test";
import { centreCrop, clampCrop, cropBoxStyle, faceCrop, maxZoom, MAX_ZOOM, panCrop, zoomCrop, zoomOf } from "../src/lib/iconCrop";

const inside = (c: { x: number; y: number; size: number }, w: number, h: number) =>
  c.x >= 0 && c.y >= 0 && c.x + c.size <= w + 1e-9 && c.y + c.size <= h + 1e-9 && c.size > 0;

test("a crop stays inside the picture, never bigger than its short side", () => {
  assert.deepEqual(clampCrop({ x: -50, y: 900, size: 5000 }, 800, 1200), { x: 0, y: 400, size: 800 });
  assert.deepEqual(clampCrop({ x: 700, y: -10, size: 200 }, 800, 1200), { x: 600, y: 0, size: 200 });
  assert.equal(clampCrop({ x: 0, y: 0, size: 1 }, 800, 1200).size, 16, "not smaller than 16 px");
  assert.equal(clampCrop({ x: 0, y: 0, size: 1 }, 10, 10).size, 10, "a tiny picture: its short side");
  assert.deepEqual(clampCrop({ x: NaN, y: 0, size: 10 }, 100, 50), { x: 0, y: 0, size: 50 });
});

test("a picked picture starts on its middle, the whole short side", () => {
  assert.deepEqual(centreCrop(1600, 900), { x: 350, y: 0, size: 900 });
  assert.deepEqual(centreCrop(600, 1000), { x: 0, y: 200, size: 600 });
  assert.equal(zoomOf(centreCrop(1600, 900), 1600, 900), 1);
});

test("the slider zooms about the middle, between 1 and the most", () => {
  const w = 1000;
  const h = 1000;
  const c = zoomCrop(centreCrop(w, h), 2, w, h);
  assert.deepEqual(c, { x: 250, y: 250, size: 500 });
  assert.equal(zoomOf(c, w, h), 2);
  assert.equal(zoomCrop(c, 100, w, h).size, w / MAX_ZOOM, "no further than MAX_ZOOM");
  assert.equal(zoomCrop(c, 0.2, w, h).size, 1000, "no further out than the whole short side");
  assert.equal(maxZoom(64, 64), 4, "a small picture zooms less (a crop of 16 px at least)");
  // at the edge it moves back inside rather than past it
  const corner = zoomCrop({ x: 0, y: 0, size: 250 }, 1, w, h);
  assert.ok(inside(corner, w, h));
  // the wheel at a point keeps that point where it is
  const at = zoomCrop({ x: 100, y: 100, size: 400 }, 5, w, h, 0, 0);
  assert.deepEqual(at, { x: 100, y: 100, size: 200 });
});

test("a drag moves the picture with the finger (the crop the other way), in the picture's pixels", () => {
  const c = { x: 200, y: 200, size: 400 };
  // a 200 px wide view of a 400 px crop: one screen px is two picture px
  assert.deepEqual(panCrop(c, 50, -25, 200, 1000, 1000), { x: 100, y: 250, size: 400 });
  assert.deepEqual(panCrop(c, 5000, 5000, 200, 1000, 1000), { x: 0, y: 0, size: 400 }, "not past the edge");
  assert.deepEqual(panCrop(c, 10, 10, 0, 1000, 1000), c, "no view: no move");
});

test("her face: where the rig's frame says, else the top in the middle", () => {
  // Chaerin's bundled set (backend/app/mate/builtin/assets/chaerin/rig.json)
  const [w, h] = [1130, 1294];
  const c = faceCrop(w, h, [0.4841, 0.3165, 0.3072]);
  assert.ok(inside(c, w, h));
  const fx = (0.4841 * w - c.x) / c.size;
  const fy = (0.3165 * h - c.y) / c.size;
  assert.ok(Math.abs(fx - 0.5) < 0.01, `face in the middle across: ${fx}`);
  assert.ok(fy > 0.4 && fy < 0.5, `face a little above the middle: ${fy}`);
  assert.ok(c.size > 0.3072 * h && c.size < w, "her whole face, not the whole picture");
  // a face near the top edge: moved back inside
  assert.ok(inside(faceCrop(w, h, [0.5, 0.02, 0.2]), w, h));
  // no frame (or a broken one): the top of the picture, in the middle
  for (const face of [null, [0.5, 0.5, 0], [NaN, 1, 1], [0.5]]) {
    const top = faceCrop(900, 1600, face);
    assert.equal(top.size, 540);
    assert.equal(top.x, 180);
    assert.ok(top.y < 100);
  }
});

test("the CSS puts exactly the crop in the box", () => {
  assert.deepEqual(cropBoxStyle({ x: 250, y: 100, size: 500 }, 1000, 2000), { width: "200%", height: "400%", left: "-50%", top: "-20%" });
  assert.deepEqual(cropBoxStyle({ x: 0, y: 0, size: 0 }, 10, 10), { width: "0%", height: "0%", left: "0%", top: "0%" });
});
