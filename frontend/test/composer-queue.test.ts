import assert from "node:assert/strict";
import test from "node:test";

test.beforeEach(() => {
  if (!(globalThis as any).localStorage) (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
});

const at = "2026-11-09T00:00:00+00:00";
const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, seq: 0, timestamp: at, data }) as any;

test("the queue waits for the server's word that the run ended, not for an answer that looks done", async () => {
  const { createChatStore } = await import("../src/stores/chatStore");
  const { readyToSend } = await import("../src/lib/queue");
  const store = createChatStore();
  const s = () => store.getState();
  const ready = () => readyToSend({ isStreaming: s().isStreaming, runActive: s().runActive, connection: "open", queued: 1 });
  s().reset("s1");
  s().pushUser("first", [], "c1");
  s().setStreaming(true);
  assert.equal(ready(), false);
  s().applyEvent(ev("turn.complete", { text: "done" }));
  assert.equal(s().isStreaming, false, "the answer is in");
  assert.equal(ready(), false, "but the server is still closing the run");
  s().applyEvent(ev("run.state", { running: false }));
  assert.equal(ready(), true);
  s().applyEvent(ev("run.state", { running: true })); // a background turn starts by itself
  assert.equal(ready(), false);
  assert.equal(readyToSend({ isStreaming: false, runActive: false, connection: "closed", queued: 1 }), false);
  assert.equal(readyToSend({ isStreaming: false, runActive: false, connection: "open", queued: 0 }), false);
});

test("a message the server refused because a run was on comes back to be sent first, not lost", async () => {
  const { createChatStore } = await import("../src/stores/chatStore");
  const store = createChatStore();
  const s = () => store.getState();
  s().reset("s2");
  s().pushUser("too early", [{ id: "att_1", name: "a.txt" } as any], "c9");
  s().setStreaming(true);
  s().applyEvent(ev("error", { code: "turn.busy", message: "a turn is already running", client_msg_id: "c9" }));
  assert.equal(s().turns.filter((t) => t.role === "user").length, 0, "off the screen");
  const back = s().takeBounced();
  assert.equal(back.length, 1);
  assert.equal(back[0].text, "too early");
  assert.equal(back[0].attachments[0].id, "att_1");
  assert.equal(s().runActive, true, "a run is still on: it goes once that one ends");
  // (an old server without the message id: nothing to give back, nothing breaks)
  s().applyEvent(ev("error", { code: "turn.busy", message: "busy" }));
  assert.equal(s().takeBounced().length, 0);
});

test("a send that started nothing doesn't hold the queue up", async () => {
  const { createChatStore } = await import("../src/stores/chatStore");
  const store = createChatStore();
  const s = () => store.getState();
  s().reset("s3");
  s().pushUser("with a bad file", [], "c5");
  s().setStreaming(true);
  s().applyEvent(ev("error", { code: "attachment.invalid", message: "unknown attachment", client_msg_id: "c5" }));
  assert.equal(s().runActive, false);
});

test("what was refused goes first, in its order; what is queued on purpose goes last", async () => {
  const { putFirst, putLast } = await import("../src/lib/queue");
  let q = putLast([], { text: "q1", attachments: [] });
  q = putLast(q, { text: "q2", attachments: [] });
  q = putFirst(q, [{ text: "now-a", attachments: [] }, { text: "now-b", attachments: [] }]);
  assert.deepEqual(q.map((m) => m.text), ["now-a", "now-b", "q1", "q2"]);
  assert.equal(new Set(q.map((m) => m.id)).size, 4, "every entry has its own id");
});
