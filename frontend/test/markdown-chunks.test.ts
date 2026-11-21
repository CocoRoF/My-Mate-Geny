// A streaming reply cut where it is safe (src/lib/markdownChunks.ts): blank lines outside code, never inside a fence or
// before an indented continuation. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { stableChunks } from "../src/lib/markdownChunks.ts";

test("paragraphs are chunks, the last one still growing", () => {
  assert.deepEqual(stableChunks("Hello there.\n\nSecond para\nstill second\n\nThird is grow"),
    ["Hello there.", "Second para\nstill second", "Third is grow"]);
  assert.deepEqual(stableChunks("just one"), ["just one"]);
  assert.deepEqual(stableChunks(""), [""]);
});

test("a fence is never cut, closed or still open", () => {
  const text = "Look:\n\n```py\nx = 1\n\ny = 2\n```\n\nDone.";
  assert.deepEqual(stableChunks(text), ["Look:", "```py\nx = 1\n\ny = 2\n```", "Done."]);
  assert.deepEqual(stableChunks("Look:\n\n```\na\n\nb"), ["Look:", "```\na\n\nb"]);
  assert.deepEqual(stableChunks("~~~\na\n\n```\nb\n~~~\n\nend"), ["~~~\na\n\n```\nb\n~~~", "end"]);
});

test("a list item's own paragraph stays with its list", () => {
  assert.deepEqual(stableChunks("- one\n\n  more of one\n- two\n\nAfter"), ["- one\n\n  more of one\n- two", "After"]);
  // (the chunks joined again are the text: nothing is lost or reordered)
  const t = "a\n\nb\n\n```\nc\n\nd\n```\n\ne";
  assert.equal(stableChunks(t).join("\n\n"), t);
});
