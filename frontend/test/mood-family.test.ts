// Mood families (frontend/src/mate/avatar/shared.ts): a rig whose clips carry a `face` stays in that mood while she feels it —
// her breathing, talking and listening all in that face — instead of smiling between one sulk and the next
import assert from "node:assert/strict";
import test from "node:test";
import { faceFor, faceMix, facesIn, familyShare, moodPool, pickFace } from "../src/mate/avatar/shared";
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

test("how strongly she feels it says how much of what she plays is that mood: now and then when weak, all the time when strong", () => {
  assert.equal(familyShare(0.2), 0);
  assert.equal(familyShare(0.25), 0.15);
  assert.ok(familyShare(0.35) > 0.15 && familyShare(0.35) < 0.35);
  assert.ok(Math.abs(familyShare(0.45) - 0.35) < 1e-9);
  assert.ok(familyShare(0.6) > 0.35 && familyShare(0.6) < 1);
  assert.equal(familyShare(0.7), 1);
  assert.equal(familyShare(0.95), 1);
  assert.equal(familyShare(undefined), 1); // (a look with no strength: held as it is)
  for (let v = 0.2; v < 1; v += 0.05) assert.ok(familyShare(v + 0.05) >= familyShare(v)); // (never less for more)
});

test("between her mood's clips: 무표정 for a look her smile doesn't fit, else her rest face; strong, only the mood", () => {
  const weak = faceMix(rig, "angry", 0.3);
  assert.equal(weak.face, "angry");
  assert.equal(weak.between, "calm");
  assert.equal(pickFace(weak, 0.05), "angry");
  assert.equal(pickFace(weak, 0.5), "calm"); // (mostly calm)
  assert.deepEqual(facesIn(weak), ["angry", "calm"]);
  const strong = faceMix(rig, "angry", 0.8);
  assert.equal(strong.share, 1);
  for (const roll of [0, 0.5, 0.999]) assert.equal(pickFace(strong, roll), "angry");
  assert.deepEqual(facesIn(strong), ["angry"]);
  // (a rig without 무표정: her rest face between)
  assert.equal(faceMix(rig.filter((x) => x.face !== "calm"), "sad", 0.3).between, undefined);
  // (no family: her rest face, as before)
  assert.deepEqual(faceMix(rig, "smile", 0.9), { face: undefined, between: undefined, share: 0 });
  assert.deepEqual(facesIn(faceMix(rig, undefined, 0.9)), [undefined]);
  // (clip by clip, with a fixed sequence of rolls: about as often as the share says — mostly 무표정 when weak, every clip the
  // mood when strong)
  let seed = 7;
  const roll = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const plays = (mix: ReturnType<typeof faceMix>) =>
    Array.from({ length: 400 }, () => moodPool(rig, "idle", undefined, pickFace(mix, roll())).clips[0].id);
  const weakPlays = plays(weak);
  const angryShare = weakPlays.filter((id) => id === "angry_idle_a").length / weakPlays.length;
  assert.ok(angryShare > 0.1 && angryShare < 0.35, `weak: ${angryShare}`);
  assert.ok(weakPlays.every((id) => id === "angry_idle_a" || id === "calm_idle_a"));
  assert.ok(plays(strong).every((id) => id === "angry_idle_a"));
});
