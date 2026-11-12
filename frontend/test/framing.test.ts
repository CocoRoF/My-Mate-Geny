// Every set of one mate stands in the same place at the same size (src/mate/avatar/framing.ts)
import assert from "node:assert/strict";
import test from "node:test";
import { figureOf, frameBox, placeSet, widenFor } from "../src/mate/avatar/framing";
import type { Avatar, RigFrame } from "../src/mate/types";

// han Chaerin as measured: her default set and her crop top, cut with other margins and another head height
const usual = { aspect: [848, 970], frame: { face: [0.481, 0.314, 0.308], top: 0.042, how: "face" } as RigFrame };
const cropTop = { aspect: [1046, 964], frame: { face: [0.52, 0.278, 0.297], top: 0.037, how: "face" } as RigFrame };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

test("her default set fills the box exactly", () => {
  const p = placeSet(usual, usual);
  near(p.left, 0);
  near(p.top, 0);
  near(p.width, 1);
  near(p.height, 1);
});

test("another set's face lands on her default face, at its size", () => {
  const p = placeSet(cropTop, usual);
  const box = usual.aspect[0] / usual.aspect[1];
  near(p.left + cropTop.frame.face[0] * p.width, usual.frame.face[0]);
  near(p.top + cropTop.frame.face[1] * p.height, usual.frame.face[1]);
  near(cropTop.frame.face[2] * p.height, usual.frame.face[2]);
  near(p.width / p.height, cropTop.aspect[0] / cropTop.aspect[1] / box); // (not stretched)
});

test("her head stays on the page", () => {
  const high = { aspect: [848, 970], frame: { face: [0.5, 0.2, 0.308], top: 0.0, how: "face" } as RigFrame };
  const to = { aspect: [848, 970], frame: { face: [0.5, 0.1, 0.308], top: 0.0, how: "face" } as RigFrame };
  near(placeSet(high, to).top, 0);
});

test("she stands on the bottom edge, never floating above it", () => {
  const low = { aspect: [848, 970], frame: { face: [0.5, 0.5, 0.308], top: 0.2, how: "face" } as RigFrame };
  const to = { aspect: [848, 970], frame: { face: [0.5, 0.2, 0.308], top: 0.0, how: "face" } as RigFrame };
  const p = placeSet(low, to);
  assert.ok(p.top + p.height >= 1);
});

test("a set measured only by its outline is compared by outlines", () => {
  const old = { aspect: [848, 970], frame: { face: [0.48, 0.25, 0.3], top: 0.04, how: "outline" } as RigFrame };
  const made = { aspect: [1046, 964], frame: { face: [0.52, 0.28, 0.3], outline: [0.53, 0.24, 0.28], top: 0.04, how: "face" } as RigFrame };
  const p = placeSet(made, old);
  near(p.height, 0.3 / 0.28);
  near(p.left + 0.53 * p.width, 0.48);
  near(p.top + 0.24 * p.height, 0.25);
});

test("what can't be compared, or looks wrong, only shares her height and her spot", () => {
  const plain = { aspect: [1046, 964] };
  const box = usual.aspect[0] / usual.aspect[1];
  for (const set of [plain, { ...cropTop, frame: { face: [0.5, 0.3, 0.3], how: "outline" } as RigFrame }, { ...cropTop, frame: { face: [0.5, 0.3, 0.05], how: "face" } as RigFrame }]) {
    const p = placeSet(set, usual);
    near(p.height, 1);
    near(p.top, 0);
    near(p.left + p.width / 2, 0.5);
    near(p.width, 1046 / 964 / box);
  }
  near(placeSet(usual, { aspect: [848, 970] }).width, 1);
});

test("a wider set widens the fitted box evenly: never cut off at the sides, her default set still centred", () => {
  // her default set: nothing to widen
  const own = widenFor(placeSet(usual, usual));
  near(own.span, 1);
  near(own.place.left, 0);
  // her crop top reaches past both sides (more on the left)
  const p = placeSet(cropTop, usual);
  const { span, place } = widenFor(p);
  assert.ok(span > 1);
  near(span, 2 * Math.max(0.5 - p.left, p.left + p.width - 0.5));
  assert.ok(place.left >= -1e-9 && place.left + place.width <= 1 + 1e-9, "inside the widened box");
  // her default box stays in the middle of the widened one: the set sits where it sat, next to it
  const frameLeft = (1 - 1 / span) / 2;
  near(frameLeft + p.left / span, place.left);
  near(place.width, p.width / span);
  near(place.top, p.top);
});

test("what the stage keeps her pan / zoom against is the box she is fitted in: her default set's, widened for this one", () => {
  const rig = (r: typeof usual) => ({ aspect: r.aspect as [number, number], frame: r.frame, home: "", stills: {}, clips: [] });
  const wearing: Avatar = { kind: "video", rig: rig(cropTop) };
  const fb = frameBox(cropTop, usual);
  near(fb.shape, (usual.aspect[0] / usual.aspect[1]) * widenFor(placeSet(cropTop, usual)).span);
  near(figureOf(wearing, usual)!.aspect, fb.shape);
  assert.equal(figureOf(wearing, usual)!.anchorY, undefined); // (on the bottom edge)
  // no default set to stand in: the picture itself
  near(figureOf({ kind: "photo", rig: rig(usual) })!.aspect, 848 / 970);
  near(figureOf({ kind: "photo", rig: { ...rig(usual), aspect: [0, 0] } })!.aspect, 3 / 4);
  // LivLiv: its drawing, in the middle; Live2D: its body says; nothing: nothing to say
  assert.deepEqual(figureOf({ kind: "livliv", livliv: { model: "m", canvas: [1024, 1536] } }), { aspect: 1024 / 1536, anchorY: 0.5 });
  assert.equal(figureOf({ kind: "live2d", live2d: { model: "m" } }), undefined);
  assert.equal(figureOf({ kind: "none" }), null);
});
