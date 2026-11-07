import assert from "node:assert/strict";
import test from "node:test";

test.beforeEach(() => {
  if (!(globalThis as any).localStorage) (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
});

test("a message sent from this tab learns which stored message it is", async () => {
  const { useChatStore } = await import("../src/stores/chatStore");
  const chat = useChatStore.getState();
  chat.reset("s1");
  chat.pushUser("hello", [], "c1");
  assert.equal(useChatStore.getState().turns[0].messageId, undefined);
  useChatStore.getState().applyEvent({ type: "user.message", seq: 0, timestamp: "2026-11-07T00:00:00+00:00", data: { message_id: "msg_1", client_msg_id: "c1", text: "hello" } } as any);
  const turns = useChatStore.getState().turns;
  assert.equal(turns.length, 1, "no second bubble");
  assert.equal(turns[0].messageId, "msg_1");
});

test("another window's message and history know theirs too", async () => {
  const { useChatStore } = await import("../src/stores/chatStore");
  const chat = useChatStore.getState();
  chat.reset("s2");
  useChatStore.getState().applyEvent({ type: "user.message", seq: 0, timestamp: "2026-11-07T00:00:00+00:00", data: { message_id: "msg_2", client_msg_id: "other", text: "from elsewhere" } } as any);
  assert.equal(useChatStore.getState().turns[0].messageId, "msg_2");
  useChatStore.getState().loadHistory({ session: {}, running: false, events: [], messages: [
    { id: "msg_h", role: "user", content: "old", created_at: "2026-11-07T00:00:00+00:00", attachments: [] },
  ] } as any);
  assert.equal(useChatStore.getState().turns[0].messageId, "msg_h");
});

test("what goes back to the composer: the message, what was queued, what was being written", async () => {
  const { composerAfterRewind } = await import("../src/lib/rewind");
  assert.equal(composerAfterRewind("sent", [], ""), "sent");
  assert.equal(composerAfterRewind("sent", ["queued 1", "queued 2"], "writing"), "sent\n\nqueued 1\n\nqueued 2\n\nwriting");
  assert.equal(composerAfterRewind("", [], "writing"), "writing");
});

test("files of a rewound message wait in the composer once", async () => {
  const { useComposerStore } = await import("../src/stores/composerStore");
  const att = { id: "att_1", name: "a.txt", size: 1, mime: "text/plain", kind: "file" } as any;
  useComposerStore.getState().restore("s3", [att]);
  useComposerStore.getState().restore("s3", [att]);
  const items = useComposerStore.getState().items.filter((i) => i.sessionId === "s3");
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "done");
  assert.equal(items[0].attachment?.id, "att_1");
});
