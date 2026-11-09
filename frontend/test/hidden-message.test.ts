// A message the user deleted (backend services/hidden_messages.py): the bubble and its files go — live, from this
// window or another — and a history that hands it out empty draws nothing for it.
import assert from "node:assert/strict";
import test from "node:test";

test.beforeEach(() => {
  if (!(globalThis as any).localStorage) (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
});

const photo = { id: "att_1", name: "me.png", size: 1, mime: "image/png", kind: "image" } as any;
const at = (s: number) => `2026-11-09T00:00:0${s}+00:00`;

test("deleted live: a message and a steer lose their words and files, the reply stays", async () => {
  const { createChatStore } = await import("../src/stores/chatStore");
  const chat = createChatStore();
  chat.getState().reset("s1");
  chat.getState().loadHistory({ session: {}, running: false, messages: [
    { id: "msg_1", role: "user", content: "a secret", created_at: at(0), attachments: [photo] },
  ], events: [
    { eid: 1, seq: 1, type: "session.start", timestamp: at(1), data: {} },
    { eid: 2, seq: 2, type: "text.delta", timestamp: at(2), data: { text: "Nice" } },
    { eid: 3, seq: 3, type: "user.steer", timestamp: at(3), data: { text: "and my cat", message_id: "msg_2", attachments: [photo] } },
    { eid: 4, seq: 4, type: "turn.complete", timestamp: at(4), data: { text: "Nice" } },
  ] } as any);
  const before = chat.getState().turns;
  assert.equal(before[0].text, "a secret");
  assert.equal(before[1].flow.find((f) => f.kind === "steer")?.kind, "steer");

  for (const id of ["msg_1", "msg_2"]) chat.getState().applyEvent({ type: "message.hidden", seq: 0, timestamp: at(5), data: { message_id: id } } as any);
  const [said, reply] = chat.getState().turns;
  assert.deepEqual([said.text, said.attachments, said.meta], ["", [], { hidden: true }]);
  const steer = reply.flow.find((f) => f.kind === "steer") as any;
  assert.deepEqual([steer.text, steer.attachments, steer.meta], ["", [], { hidden: true }]);
  assert.equal(reply.text, "Nice", "the reply stays");
});

test("deleted before: the history hands it out empty, and it is known as deleted", async () => {
  const { createChatStore } = await import("../src/stores/chatStore");
  const chat = createChatStore();
  chat.getState().reset("s2");
  chat.getState().loadHistory({ session: {}, running: false, messages: [
    { id: "msg_1", role: "user", content: "", meta: { hidden: "2026-11-09T00:00:09+00:00" }, created_at: at(0), attachments: [] },
  ], events: [
    { eid: 1, seq: 1, type: "session.start", timestamp: at(1), data: {} },
    { eid: 2, seq: 2, type: "user.steer", timestamp: at(2), data: { message_id: "msg_2", hidden: true, text: "", attachments: [] } },
    { eid: 3, seq: 3, type: "turn.complete", timestamp: at(3), data: { text: "ok" } },
  ] } as any);
  const [said, reply] = chat.getState().turns;
  assert.ok(said.meta?.hidden);
  assert.ok((reply.flow.find((f) => f.kind === "steer") as any).meta?.hidden);
});

test("only what the user wrote has Delete", async () => {
  const { deletable } = await import("../src/lib/messageDelete");
  assert.equal(deletable("msg_1", undefined), true);
  assert.equal(deletable(undefined, undefined), false, "not stored yet");
  assert.equal(deletable("msg_1", { via: { kind: "mate" } }), false, "a mate sent it");
  assert.equal(deletable("msg_1", { internal: true }), false, "the app made it");
  assert.equal(deletable("msg_1", { speech_pending: true }), false, "still being heard");
  assert.equal(deletable("msg_1", { hidden: true }), false, "already gone");
});
