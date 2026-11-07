// What she is doing in her own day plays while nothing else is going on (components/mate/life, mate/avatar/shared.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { moodPool } from "../src/mate/avatar/shared";
import { lifeName, needStep, needTone } from "../src/components/mate/life/needs";
import type { RigClip } from "../src/mate/types";

const clip = (id: string, kind: RigClip["kind"], doing?: string): RigClip => ({ id, kind, src: `${id}.mp4`, ...(doing ? { doing } : {}) });
const CLIPS = [clip("idle_a", "idle"), clip("idle_b", "idle"), clip("talk_a", "talk"), clip("doze", "away"), clip("life_eat", "life", "eat"), clip("life_game", "life", "game")];
const ids = (p: { clips: RigClip[] }) => [...new Set(p.clips.map((c) => c.id))];

test("idle, she does what she is doing, and breathes now and then", () => {
  const pool = moodPool(CLIPS, "idle", "game");
  assert.deepEqual(ids(pool), ["life_game", "idle_a", "idle_b"]);
  assert.ok(pool.clips.filter((c) => c.id === "life_game").length > 1);
});

test("nothing she is doing, or nothing for it in this outfit: her usual idle", () => {
  assert.deepEqual(ids(moodPool(CLIPS, "idle")), ["idle_a", "idle_b"]);
  assert.deepEqual(ids(moodPool(CLIPS, "idle", "workout")), ["idle_a", "idle_b"]);
});

test("a life clip is never idle by itself", () => {
  assert.ok(!ids(moodPool(CLIPS, "idle")).includes("life_eat"));
});

test("talking and listening go on as ever", () => {
  assert.deepEqual(ids(moodPool(CLIPS, "talking", "game")), ["talk_a"]);
});

test("asleep: her own sleeping clip, else she dozes, and never just stands there", () => {
  assert.deepEqual(ids(moodPool(CLIPS, "idle", "sleep")), ["doze"]);
  const withSleep = [...CLIPS, clip("life_sleep", "life", "sleep")];
  assert.deepEqual(ids(moodPool(withSleep, "idle", "sleep")), ["life_sleep"]);
  assert.deepEqual(ids(moodPool([clip("idle_a", "idle")], "idle", "sleep")), ["idle_a"]);
});

test("a switched-off clip stays off", () => {
  const off = CLIPS.map((c) => (c.id === "life_game" ? { ...c, disabled: true } : c));
  assert.deepEqual(ids(moodPool(off, "idle", "game")), ["idle_a", "idle_b"]);
});

test("needs come in the same steps she is told", () => {
  assert.deepEqual([0, 0.29, 0.3, 0.49, 0.5, 0.74, 0.75, 1].map(needStep), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(needTone(0.9), "bg-danger");
  assert.equal(needTone(0.1), "bg-success");
});

test("a bundled name in the UI's language, whatever is missing", () => {
  assert.equal(lifeName({ ko: "집", en: "Home" }, "ko"), "집");
  assert.equal(lifeName({ ko: "집", en: "Home" }, "en"), "Home");
  assert.equal(lifeName({ en: "Home" }, "ko"), "Home");
  assert.equal(lifeName(undefined, "ko", "home"), "home");
});
