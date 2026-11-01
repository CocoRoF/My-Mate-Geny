// A chat's sidebar badge (src/lib/sessionStatus.ts): working, else Complete / Failed / Stopped until it is opened.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionBadge, unseenCount } from "../src/lib/sessionStatus.ts";

const s = (o: Record<string, unknown>) => ({ id: "x", running: false, background: 0, result_unseen: false, last_result: null, ...o }) as any;

test("working wins; then the unseen result; nothing once seen", () => {
  assert.equal(sessionBadge(s({ running: true, result_unseen: true, last_result: "ok" }), false), "working");
  assert.equal(sessionBadge(s({ background: 2, result_unseen: true, last_result: "ok" }), false), "working");
  assert.equal(sessionBadge(s({ result_unseen: true, last_result: "ok" }), false), "ok");
  assert.equal(sessionBadge(s({ result_unseen: true, last_result: "error" }), false), "error");
  assert.equal(sessionBadge(s({ result_unseen: true, last_result: "stopped" }), false), "stopped");
  assert.equal(sessionBadge(s({ result_unseen: false, last_result: "ok" }), false), null);
  assert.equal(sessionBadge(s({}), false), null);
});

test("the chat on screen shows none (opening it is seeing it)", () => {
  assert.equal(sessionBadge(s({ result_unseen: true, last_result: "ok" }), true), null);
  assert.equal(sessionBadge(s({ running: true }), true), "working");
});

test("the count: unseen results, not the chat on screen, not working ones", () => {
  const list = [
    s({ id: "a", result_unseen: true, last_result: "ok" }),
    s({ id: "b", result_unseen: true, last_result: "error" }),
    s({ id: "c", result_unseen: true, last_result: "ok", running: true }),
    s({ id: "d", result_unseen: false, last_result: "ok" }),
  ];
  assert.equal(unseenCount(list, null), 2);
  assert.equal(unseenCount(list, "a"), 1);
});
