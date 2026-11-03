import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationLocation, LAST_CONVERSATION_KEY, readLastConversation, rememberConversation, startupConversation } from "../src/lib/lastConversation.ts";

const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

test("the last mate restores its conversation instead of the older coding session", () => {
  const s = storage();
  s.setItem("hrh_last_session", "older-session");
  rememberConversation({ kind: "chat", id: "older-session" }, s);
  rememberConversation({ kind: "mate", id: "mate-b" }, s);
  const restored = startupConversation("", readLastConversation(s));
  assert.deepEqual(restored, { kind: "mate", id: "mate-b" });
  assert.deepEqual(conversationLocation(restored!), { view: "mate", session: null, tab: null });
  assert.equal(s.getItem("hrh_last_session"), "older-session");
  rememberConversation({ kind: "chat", id: "session-c" }, s);
  assert.deepEqual(conversationLocation(readLastConversation(s)!), { view: "chat", session: "session-c", tab: null });
});

test("explicit links, settings, studios and secondary windows retain their own destination", () => {
  const saved = { kind: "mate" as const, id: "mate-a" };
  for (const search of ["?view=chat&session=s", "?view=chat", "?session=s", "?view=mate", "?view=settings&tab=usage", "?view=mate&create=new", "?surface=mate-quick", "?surface=device-runtime"]) {
    assert.equal(startupConversation(search, saved), null, search);
  }
});

test("legacy devices, corrupt records and unavailable local storage keep the existing startup fallback", () => {
  const s = storage();
  assert.equal(readLastConversation(s), null);
  for (const raw of ["invalid json", "null", "{}", '{"version":2,"kind":"mate","id":"a"}', '{"version":1,"kind":"settings","id":"a"}', '{"version":1,"kind":"mate","id":""}']) {
    s.setItem(LAST_CONVERSATION_KEY, raw);
    assert.equal(readLastConversation(s), null);
  }
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readLastConversation(blocked), null);
  assert.doesNotThrow(() => rememberConversation({ kind: "mate", id: "a" }, blocked));
});

test("conversation choice stays local to each device", () => {
  const a = storage(), b = storage();
  rememberConversation({ kind: "mate", id: "mate-a" }, a);
  rememberConversation({ kind: "chat", id: "session-b" }, b);
  assert.equal(readLastConversation(a)?.kind, "mate");
  assert.equal(readLastConversation(b)?.kind, "chat");
});
