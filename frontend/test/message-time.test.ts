// When each message was said (src/lib/messageTime.ts, components/chat/MessageTime.tsx): its clock time, the whole
// date and time, the day dividers — in the user's timezone, from the stored times (older messages too), in a chat and
// in a mate's conversation alike (both are chatStore turns).
import assert from "node:assert/strict";
import test from "node:test";
import { clockTime, dayBreaks, dayKey, dayLabel, fullDateTime, parseTime, safeZone, turnTime } from "../src/lib/messageTime.ts";

test.beforeEach(() => {
  if (!(globalThis as any).localStorage) (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
});

// (Intl writes a narrow no-break space before AM/PM and between some parts: compared as plain spaces)
const plain = (s: string) => s.replace(/[  ]/g, " ");
const SEOUL = "Asia/Seoul";
const t = (iso: string) => Date.parse(iso);

test("a clock time, the whole date and time, and a day's words — in the user's timezone", () => {
  const at = t("2026-11-19T13:41:05Z"); // 22:41:05 in Seoul
  assert.equal(clockTime(at, "ko", SEOUL), "오후 10:41");
  assert.equal(plain(clockTime(at, "en", SEOUL)), "10:41 PM");
  assert.equal(plain(fullDateTime(at, "ko", SEOUL)), "2026년 11월 19일 목요일 오후 10:41:05");
  assert.match(plain(fullDateTime(at, "en", SEOUL)), /^Thursday, November 19, 2026(,| at) 10:41:05 PM$/);
  assert.equal(dayLabel(at, "ko", SEOUL), "2026년 11월 19일 목요일");
  assert.equal(dayLabel(at, "en", SEOUL), "Thursday, November 19, 2026");
  // the same moment where the user is elsewhere
  assert.equal(clockTime(at, "ko", "UTC"), "오후 1:41");
  assert.equal(clockTime(t("2026-11-19T00:05:00Z"), "ko", SEOUL), "오전 9:05");
});

test("the day turns at the user's midnight, not the server's", () => {
  const before = t("2026-11-19T14:59:00Z"); // 23:59 in Seoul
  const after = t("2026-11-19T15:01:00Z"); //  00:01 the next day in Seoul — still the 19th in UTC
  assert.equal(dayKey(before, SEOUL), "2026-11-19");
  assert.equal(dayKey(after, SEOUL), "2026-11-20");
  assert.equal(dayKey(before, "UTC"), dayKey(after, "UTC"));
  assert.equal(dayLabel(after, "ko", SEOUL), "2026년 11월 20일 금요일");
});

test("a timezone that isn't one (a typo in Settings) never breaks a conversation", () => {
  assert.notEqual(safeZone("Mars/Olympus"), "Mars/Olympus");
  assert.doesNotThrow(() => clockTime(Date.now(), "ko", "Mars/Olympus"));
  assert.equal(safeZone(SEOUL), SEOUL);
  assert.equal(parseTime("not a time"), undefined);
  assert.equal(parseTime("2026-11-19T13:41:05.123456+00:00"), t("2026-11-19T13:41:05.123Z"));
});

test("day dividers: over the first message, then wherever the day changes — a reply by when it came", () => {
  const turn = (key: string, role: "user" | "assistant" | "system", times: Record<string, number | undefined>, extra = {}) =>
    ({ key, role, text: "", flow: [], tools: [], complete: true, ...times, ...extra }) as any;
  const turns = [
    turn("u1", "user", { at: t("2026-11-18T05:00:00Z") }),
    turn("a1", "assistant", { startedAt: t("2026-11-18T05:00:01Z"), endedAt: t("2026-11-18T05:00:09Z") }),
    turn("s1", "system", {}), // (a notice with no time: never moves the day)
    turn("u2", "user", { at: t("2026-11-19T14:59:00Z") }), // 23:59 on the 19th in Seoul
    turn("a2", "assistant", { startedAt: t("2026-11-19T14:59:10Z"), endedAt: t("2026-11-19T15:01:00Z") }), // answered after midnight
    turn("u3", "user", { at: t("2026-11-19T15:02:00Z"), meta: { hidden: true } }), // deleted: draws nothing
    turn("u4", "user", { at: t("2026-11-21T01:00:00Z") }),
  ];
  const shown = (x: any) => !x.meta?.hidden;
  const b = dayBreaks(turns, SEOUL, shown);
  assert.deepEqual([...b.keys()], ["u1", "u2", "a2", "u4"]);
  assert.equal(dayLabel(b.get("a2")!, "ko", SEOUL), "2026년 11월 20일 금요일");
  // a new day that begins on a turn not drawn: its divider goes over the next one drawn
  const b2 = dayBreaks([turns[0], turn("x", "user", { at: t("2026-11-25T01:00:00Z"), meta: { hidden: true } }), turn("y", "system", {})], SEOUL, shown);
  assert.deepEqual([...b2.keys()], ["u1", "y"]);
  assert.equal(dayKey(b2.get("y")!, SEOUL), "2026-11-25");
  assert.equal(turnTime(turns[1]), t("2026-11-18T05:00:09Z"), "a reply: when it came");
  assert.equal(turnTime({ role: "assistant", startedAt: 5 } as any), 5, "still coming: when it began");
});

test("stored messages carry their time into the conversation — older ones too — and live ones theirs", async () => {
  const { createChatStore } = await import("../src/stores/chatStore");
  const chat = createChatStore();
  chat.getState().reset("s1");
  chat.getState().loadHistory({ session: {}, running: false, messages: [
    { id: "msg_g", role: "assistant", content: "안녕!", meta: { kind: "greeting" }, created_at: "2026-11-01T00:00:00+00:00" },
    { id: "msg_1", role: "user", content: "hi", created_at: "2026-11-18T05:00:00.123456+00:00", attachments: [] },
  ], events: [
    { eid: 1, seq: 1, type: "session.start", timestamp: "2026-11-18T05:00:01+00:00", data: {} },
    { eid: 2, seq: 2, type: "text.delta", timestamp: "2026-11-18T05:00:02+00:00", data: { text: "Hello" } },
    { eid: 3, seq: 3, type: "user.steer", timestamp: "2026-11-18T05:00:03+00:00", data: { text: "and this", message_id: "msg_2" } },
    { eid: 4, seq: 4, type: "turn.complete", timestamp: "2026-11-18T05:00:09+00:00", data: { text: "Hello" } },
    { eid: 5, seq: 5, type: "notice", timestamp: "2026-11-18T05:00:10+00:00", data: { code: "x", message: "note", level: "info" } },
  ] } as any);
  const [greeting, said, reply, notice] = chat.getState().turns;
  assert.equal(greeting.endedAt, t("2026-11-01T00:00:00Z"), "her greeting: when it was stored");
  assert.equal(said.at, t("2026-11-18T05:00:00.123Z"));
  assert.equal(reply.endedAt, t("2026-11-18T05:00:09Z"));
  assert.equal((reply.flow.find((f) => f.kind === "steer") as any).at, t("2026-11-18T05:00:03Z"));
  assert.equal(notice.role, "system");
  assert.equal(notice.at, t("2026-11-18T05:00:10Z"));

  // live: another device's message, and this one's own (the moment it's sent, then the server's time)
  chat.getState().applyEvent({ type: "user.message", seq: 6, timestamp: "2026-11-19T13:41:00+00:00", data: { text: "later", message_id: "msg_3" } } as any);
  assert.equal(chat.getState().turns.at(-1)!.at, t("2026-11-19T13:41:00Z"));
  const before = Date.now();
  chat.getState().pushUser("mine", [], "cid-1");
  const mine = chat.getState().turns.at(-1)!;
  assert.ok(mine.at! >= before && mine.at! <= Date.now());
  chat.getState().applyEvent({ type: "user.message", seq: 7, timestamp: "2026-11-19T13:42:00+00:00", data: { text: "mine", message_id: "msg_4", client_msg_id: "cid-1" } } as any);
  assert.equal(chat.getState().turns.at(-1)!.at, t("2026-11-19T13:42:00Z"));
});

test("the user's timezone: Settings' one when it is set (a typo falls back), and Settings saving it moves every time", async () => {
  const { setUserTimezone, useUserTz } = await import("../src/lib/userTimezone");
  setUserTimezone("Asia/Seoul");
  assert.equal(useUserTz.getState().tz, "Asia/Seoul");
  setUserTimezone("America/New_York");
  assert.equal(useUserTz.getState().tz, "America/New_York");
  setUserTimezone("Not/AZone");
  assert.notEqual(useUserTz.getState().tz, "Not/AZone");
});
