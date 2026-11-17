// node --import ./test/ts-resolve.mjs --test test/image-edit.test.ts
// The picture editor's model (src/lib/imageEdit.ts): turning, cutting, marks, erasing, what a finished picture is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addPoint, cropToRatio, dragCrop, edited, editedName, erase, handleAt, initialEdit, markHit, MIN_CROP, outputType,
  textAt, turnClockwise, turnedSize, type EditState, type Mark,
} from "../src/lib/imageEdit.ts";

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test("a quarter turn turns the crop and the marks with the picture; four come back where they were", () => {
  const w = 400;
  const h = 300;
  let s: EditState = {
    turn: 0,
    crop: { x: 10, y: 20, w: 100, h: 50 },
    marks: [
      { kind: "pen", color: "#fff", size: 4, points: [[10, 20], [110, 70]] },
      { kind: "arrow", color: "#f00", size: 3, from: [0, 0], to: [400, 300] },
      { kind: "text", color: "#000", size: 20, at: [50, 60], text: "여기" },
    ],
  };
  const once = turnClockwise(s, w, h);
  assert.equal(once.turn, 90);
  assert.deepEqual(turnedSize(w, h, 90), [300, 400]);
  // (x, y) in a picture 300 high → (300 - y, x)
  assert.deepEqual(once.crop, { x: 300 - 70, y: 10, w: 50, h: 100 });
  assert.deepEqual((once.marks[0] as any).points, [[280, 10], [230, 110]]);
  assert.deepEqual((once.marks[1] as any).from, [300, 0]);
  assert.deepEqual((once.marks[2] as any).at, [240, 50]);
  for (let i = 0; i < 4; i++) s = turnClockwise(s, w, h);
  assert.equal(s.turn, 0);
  assert.deepEqual(s.crop, { x: 10, y: 20, w: 100, h: 50 });
  assert.deepEqual((s.marks[0] as any).points, [[10, 20], [110, 70]]);
});

test("edited: the whole picture as it was is no change; a turn, a crop or a mark is", () => {
  const s = initialEdit(640, 480);
  assert.equal(edited(s, 640, 480), false);
  assert.equal(edited({ ...s, crop: { x: 0, y: 0, w: 600, h: 480 } }, 640, 480), true);
  assert.equal(edited(turnClockwise(s, 640, 480), 640, 480), true);
  assert.equal(edited({ ...s, marks: [{ kind: "pen", color: "#fff", size: 2, points: [[1, 1]] }] }, 640, 480), true);
});

test("the crop's handles: corners, then edges, then the inside", () => {
  const c = { x: 100, y: 100, w: 200, h: 100 };
  assert.equal(handleAt(c, [102, 98], 10), "nw");
  assert.equal(handleAt(c, [300, 200], 10), "se");
  assert.equal(handleAt(c, [200, 95], 10), "n");
  assert.equal(handleAt(c, [295, 150], 10), "e");
  assert.equal(handleAt(c, [200, 150], 10), "move");
  assert.equal(handleAt(c, [20, 20], 10), null);
});

test("dragging the crop: inside the picture, never smaller than the minimum, moved whole", () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(dragCrop(start, "se", 50, 30, 400, 300), { x: 100, y: 100, w: 250, h: 130 });
  assert.deepEqual(dragCrop(start, "se", 500, 500, 400, 300), { x: 100, y: 100, w: 300, h: 200 }, "the picture's edge");
  assert.deepEqual(dragCrop(start, "nw", -500, -500, 400, 300), { x: 0, y: 0, w: 300, h: 200 });
  const tiny = dragCrop(start, "e", -1000, 0, 400, 300);
  assert.equal(tiny.w, MIN_CROP);
  assert.deepEqual(dragCrop(start, "move", 500, -500, 400, 300), { x: 200, y: 0, w: 200, h: 100 });
});

test("a ratio is kept while dragging, the far corner stays, and it fits the picture", () => {
  const start = { x: 100, y: 100, w: 100, h: 100 };
  const r = dragCrop(start, "se", 60, 10, 400, 300, 1);
  assert.ok(close(r.w, r.h), `square: ${r.w} × ${r.h}`);
  assert.equal(r.x, 100);
  assert.equal(r.y, 100);
  const big = dragCrop(start, "se", 1000, 1000, 400, 300, 1);
  assert.ok(close(big.w, 200) && close(big.h, 200), `as big as fits from its corner: ${big.w}`);
  const nw = dragCrop(start, "nw", -50, -10, 400, 300, 16 / 9);
  assert.ok(close(nw.w / nw.h, 16 / 9, 1e-6), `16:9 ${nw.w / nw.h}`);
  assert.ok(close(nw.x + nw.w, 200) && close(nw.y + nw.h, 200), "the far (se) corner stayed");
});

test("a preset ratio: the largest crop of it, about the old crop's middle, inside the picture", () => {
  const c = cropToRatio({ x: 0, y: 0, w: 400, h: 300 }, 1, 400, 300);
  assert.deepEqual(c, { x: 50, y: 0, w: 300, h: 300 });
  const wide = cropToRatio({ x: 300, y: 0, w: 100, h: 100 }, 16 / 9, 400, 300);
  assert.ok(close(wide.w, 400) && close(wide.h, 225) && wide.y >= 0 && wide.y + wide.h <= 300);
  assert.deepEqual(cropToRatio({ x: 5, y: 5, w: 10, h: 10 }, null, 400, 300), { x: 0, y: 0, w: 400, h: 300 });
});

test("marks are hit along their lines; the eraser takes what it goes over", () => {
  const pen: Mark = { kind: "pen", color: "#fff", size: 6, points: [[0, 0], [100, 0]] };
  const box: Mark = { kind: "rect", color: "#f00", size: 4, from: [200, 200], to: [300, 260] };
  const words: Mark = { kind: "text", color: "#000", size: 20, at: [50, 150], text: "안녕" };
  assert.ok(markHit(pen, [50, 2], 0));
  assert.ok(!markHit(pen, [50, 20], 0));
  assert.ok(markHit(box, [250, 201], 0), "its edge");
  assert.ok(!markHit(box, [250, 230], 0), "not its inside");
  assert.ok(markHit(words, [60, 140], 0));
  assert.deepEqual(erase([pen, box, words], [[50, 10]], 8), [box, words]);
  assert.equal(textAt([pen, words, box], [60, 140], 2), 1);
  assert.equal(textAt([pen, box], [60, 140], 2), -1);
});

test("a stroke's points are thinned", () => {
  let pts = addPoint([], [0, 0], 2);
  pts = addPoint(pts, [1, 0], 2);
  assert.equal(pts.length, 1);
  pts = addPoint(pts, [3, 0], 2);
  assert.equal(pts.length, 2);
});

test("a finished picture: lossless stays PNG, a photo is JPEG; its name says it was edited", () => {
  assert.equal(outputType("image/png"), "image/png");
  assert.equal(outputType("image/webp"), "image/png");
  assert.equal(outputType("image/jpeg"), "image/jpeg");
  assert.equal(outputType("image/heic"), "image/jpeg");
  assert.equal(editedName("IMG_0001.HEIC", "image/jpeg"), "IMG_0001-edited.jpg");
  assert.equal(editedName("shot-edited.png", "image/png"), "shot-edited.png", "edited again: not -edited-edited");
  assert.equal(editedName("", "image/png"), "image-edited.png");
});
