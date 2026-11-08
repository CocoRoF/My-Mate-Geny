// A LivLiv body's own decisions (frontend/src/mate/avatar/livliv.ts): which expression an emotion plays, the mouth's shape
import assert from "node:assert/strict";
import test from "node:test";
import { expressionFor, vowelOf } from "../src/mate/avatar/livliv";

test("the mouth's shape follows what is being said", () => {
  assert.deepEqual([..."아오우이에으"].map(vowelOf), [0, -1, -1, 1, 1, 0.4]);
  assert.deepEqual([..."aoui"].map(vowelOf), [0, -1, -1, 1]);
});

test("an emotion plays the standard expression of its name, a near one, the user's choice, or none", () => {
  const have = ["smile", "shy", "angry", "sad", "surprised", "laugh", "x_star"];
  const auto = { model: "m" };
  assert.equal(expressionFor(auto, have, "shy"), "shy");
  assert.equal(expressionFor(auto, have, "joy"), "laugh"); // (no "joy" on LivLiv: the nearest)
  assert.equal(expressionFor(auto, have, "worried"), "sad");
  assert.equal(expressionFor(auto, have, "thinking"), null); // (a move instead: a tilt)
  assert.equal(expressionFor(auto, ["smile"], "angry"), null);
  const mine = { model: "m", emotions: { joy: "x_star", sad: "" } };
  assert.equal(expressionFor(mine, have, "joy"), "x_star");
  assert.equal(expressionFor(mine, have, "sad"), null); // (the user said: no face for it)
  assert.equal(expressionFor({ model: "m", emotions: { joy: "gone" } }, have, "joy"), null);
});
