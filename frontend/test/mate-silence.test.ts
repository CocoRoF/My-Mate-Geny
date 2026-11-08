// A mate who chose not to answer (furious with the user; backend app/mate/trigger/silence.deliver_reply): her turn is a line of
// narration, marked so it is never a bubble of hers, never read aloud and never captioned (MateMessages.tsx, useMateConversation.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatStore } from "../src/stores/chatStore.ts";

test("a turn she didn't answer comes back from history as narration, and the next one is hers again", () => {
  const store = createChatStore();
  const at = (ms: number) => new Date(1800000000000 + ms).toISOString();
  store.getState().loadHistory({ running: false, messages: [
    { role: "user", content: "(더 세게 때린다)", created_at: at(1) },
    { role: "user", content: "미안해 진짜 잘못했어", created_at: at(10) },
  ], events: [
    { type: "turn.complete", eid: 1, timestamp: at(2), data: { text: "(한채린은 대답하지 않는다)", refused: true } },
    { type: "session.start", eid: 2, timestamp: at(11), data: {} },
    { type: "text.delta", eid: 3, timestamp: at(12), data: { text: "...알았어." } },
    { type: "turn.complete", eid: 4, timestamp: at(13), data: { text: "...알았어." } },
  ] } as any);
  const replies = store.getState().turns.filter((t) => t.role === "assistant");
  assert.deepEqual(replies.map((t) => [t.text, !!t.refused]), [["(한채린은 대답하지 않는다)", true], ["...알았어.", false]]);
});

test("an autonomous [SILENT] is still nothing at all, not a line", () => {
  const store = createChatStore();
  const at = (ms: number) => new Date(1800000000000 + ms).toISOString();
  store.getState().loadHistory({ running: false, messages: [], events: [
    { type: "session.start", eid: 1, timestamp: at(1), data: {} },
    { type: "turn.complete", eid: 2, timestamp: at(2), data: { text: "", silent: true } },
  ] } as any);
  const t = store.getState().turns.find((x) => x.role === "assistant");
  assert.ok(!t || (!t.refused && !t.text));
});
