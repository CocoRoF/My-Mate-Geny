const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCaptureNotifier } = require("../src/capture-notification");
const win = (id, visible = true) => ({
  id, isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false,
});
test("one capture goes to exactly one visible app window; duplicate delivery never stacks", () => {
  const a = win(1), b = win(2), hidden = win(3, false), sent = [];
  const n = createCaptureNotifier({ windows: () => [a, b, hidden], focused: () => b, send: (...x) => sent.push(x) });
  n.done({ id: "shot1" });
  n.done({ id: "shot1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], b);
  assert.equal(sent[0][1].notification_id, "shot1");
  n.done({ id: "shot2" });
  assert.equal(sent.length, 2);
});
test("capture notification never shows a hidden app or chooses a foreign window", () => {
  const hidden = win(1, false), avatar = win(2), other = win(3), sent = [];
  const n = createCaptureNotifier({ windows: () => [hidden, avatar], focused: () => other, send: (...x) => sent.push(x) });
  n.done({ id: "shot" });
  assert.equal(sent[0][0], avatar);
  const none = createCaptureNotifier({ windows: () => [hidden], focused: () => null, send: () => assert.fail("no visible recipient") });
  none.done({ id: "none" });
});
