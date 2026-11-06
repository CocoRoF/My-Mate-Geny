// Every set of one mate stands in the same place at the same size (src/mate/avatar/framing.ts)
import assert from "node:assert/strict";
import test from "node:test";
import { placeSet } from "../src/mate/avatar/framing";
import type { RigFrame } from "../src/mate/types";

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
