// Mood families (frontend/src/mate/avatar/shared.ts): a rig whose clips carry a `face` stays in that mood while she feels it —
// her breathing, talking and listening all in that face — instead of smiling between one sulk and the next
import assert from "node:assert/strict";
import test from "node:test";
import { faceFor, moodPool } from "../src/mate/avatar/shared";
import type { RigClip } from "../src/mate/types";

const c = (id: string, kind: RigClip["kind"], face?: string, emotion?: string): RigClip => ({ id, kind, src: `/${id}.mp4`, ...(face ? { face } : {}), ...(emotion ? { emotion } : {}) });
const rig: RigClip[] = [
  c("idle_a", "idle"), c("talk_a", "talk"), c("listen", "listen"), c("laugh", "react", undefined, "joy"), c("doze", "away"),
  c("angry", "react", "angry", "angry"), c("angry_idle_a", "idle", "angry"), c("angry_talk", "talk", "angry"),
  c("sad_idle_a", "idle", "sad"), c("calm_idle_a", "idle", "calm"), c("calm_talk", "talk", "calm"),
];

test("her look picks the mood she stays in: its own family, 무표정 for a look her smile doesn't fit, else her rest face", () => {
  assert.equal(faceFor(rig, "angry"), "angry");
  assert.equal(faceFor(rig, "sad"), "sad");
  assert.equal(faceFor(rig, "worried"), "sad"); // (no worried family here: the nearest feeling's, as every body does)
  assert.equal(faceFor(rig.filter((x) => x.face !== "angry" && x.face !== "sad"), "angry"), "calm"); // (none near: no smile either)
  assert.equal(faceFor(rig, "smile"), undefined);
  assert.equal(faceFor(rig, "shy"), undefined);
  assert.equal(faceFor(rig, undefined), undefined);
  assert.equal(faceFor(rig.filter((x) => !x.face), "angry"), undefined); // (a rig without families: as before)
});

test("in a mood every kind comes from that mood; at rest no mood's clip ever plays", () => {
  assert.deepEqual(moodPool(rig, "talking", undefined, "angry").clips.map((x) => x.id), ["angry_talk"]);
  assert.deepEqual(moodPool(rig, "listening", undefined, "angry").clips.map((x) => x.id), ["angry_idle_a"]); // (its breathing)
  assert.deepEqual(moodPool(rig, "idle", undefined, "calm").clips.map((x) => x.id), ["calm_idle_a"]);
  assert.deepEqual(moodPool(rig, "away", undefined, "angry").clips.map((x) => x.id), ["doze"]); // (dozing off is her rest face's)
  assert.deepEqual(moodPool(rig, "idle").clips.map((x) => x.id), ["idle_a"]);
  assert.deepEqual(moodPool(rig, "talking").clips.map((x) => x.id), ["talk_a"]);
});
