// The Mate view's layout (src/mate/layout.ts): side by side or stacked, by the user's pick and the view's own box.
//   Run: npm run test:unit
import assert from "node:assert/strict";
import test from "node:test";
import { readLayout, SPLIT_MIN, splitNow } from "../src/mate/layout";

test("automatic: side by side in a wide view, stacked in a narrow or tall one (sidebar folded or not)", () => {
  assert.equal(splitNow("auto", 1180, 850, false), true, "a laptop window beside the sidebar");
  assert.equal(splitNow("auto", 840, 1000, false), false, "a portrait window with the sidebar folded: wide enough, but tall");
  assert.equal(splitNow("auto", 1020, 1880, false), false, "a portrait monitor");
  assert.equal(splitNow("auto", 600, 400, false), false, "too narrow for both halves");
  assert.equal(splitNow("auto", 0, 0, false), false, "not measured yet");
});

test("automatic keeps what it has near the line (no flicker while resizing)", () => {
  // entering needs a bit more than staying
  assert.equal(splitNow("auto", 900, 920, false), false);
  assert.equal(splitNow("auto", 900, 920, true), true);
  assert.equal(splitNow("auto", 900, 1050, true), false, "well past the line: stacked");
  assert.equal(splitNow("auto", SPLIT_MIN + 5, 400, false), false, "just past the width: not yet");
  assert.equal(splitNow("auto", SPLIT_MIN + 5, 400, true), true);
  assert.equal(splitNow("auto", SPLIT_MIN - 1, 400, true), false, "below the width it can't stay");
});

test("the user's pick: 위아래 always stacks, 좌우 holds while the halves fit", () => {
  assert.equal(splitNow("stacked", 1600, 900, true), false);
  assert.equal(splitNow("split", 700, 1400, false), true);
  assert.equal(splitNow("split", SPLIT_MIN - 1, 400, true), false);
  assert.equal(readLayout("split"), "split");
  assert.equal(readLayout("stacked"), "stacked");
  assert.equal(readLayout(null), "auto");
  assert.equal(readLayout("sideways"), "auto");
});
