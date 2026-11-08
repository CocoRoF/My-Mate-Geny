// What her face does comes from how she feels (docs/mate-memory-affinity.md §6): frontend/src/mate/stateLook.ts
import assert from "node:assert/strict";
import test from "node:test";
import { clipsFor } from "../src/mate/avatar/shared";
import { parseEmotionText } from "../src/mate/emotion";
import { restingLook, stateLook } from "../src/mate/stateLook";
import type { MateState, StateLabel } from "../src/api/mates";
import type { RigClip } from "../src/mate/types";

const feeling = (label: StateLabel, level: number): { state: MateState } => ({ state: { label, level, blend: null, valence: 0, arousal: 0.4, top: [] } });

test("each state has its look, and calm has none", () => {
  assert.equal(stateLook(feeling("shy", 0.3)), "shy");
  assert.equal(stateLook(feeling("angry", 0.3)), "angry");
  assert.equal(stateLook(feeling("lonely", 0.3)), "sad");
  assert.equal(stateLook(feeling("worried", 0.3)), "worried");
  assert.equal(stateLook(feeling("excited", 0.3)), "joy");
  assert.equal(stateLook(feeling("calm", 0)), undefined);
  assert.equal(stateLook(null), undefined);
});

test("she rests on that face only once she feels it enough", () => {
  assert.equal(restingLook(feeling("shy", 0.3)), undefined);
  assert.equal(restingLook(feeling("shy", 0.5)), "shy");
});

test("the user can switch it off, and a preview goes first", () => {
  const off = { ...feeling("shy", 0.9), relation: { avatar_mood: false } };
  assert.equal(stateLook(off), undefined);
  assert.equal(restingLook(off), undefined);
  assert.equal(stateLook(off, true), "shy");
  assert.equal(stateLook(feeling("shy", 0.9), false), undefined);
});

const clip = (id: string, kind: RigClip["kind"], emotion?: string): RigClip => ({ id, kind, src: `/${id}.mp4`, ...(emotion ? { emotion } : {}) }) as RigClip;

test("sleepy dozes off where there is no reaction for it, and angry falls to a near feeling", () => {
  const clips = [clip("idle_a", "idle"), clip("doze", "away"), clip("sad", "react", "sad")];
  assert.deepEqual(clipsFor({ clips, emotions: {} }, "sleepy").clips.map((c) => c.id), ["doze"]);
  assert.deepEqual(clipsFor({ clips, emotions: { sad: ["sad"] } }, "angry").clips.map((c) => c.id), ["sad"]);
  assert.deepEqual(clipsFor({ clips: clips.slice(0, 1), emotions: {} }, "sleepy").clips, []);
});

test("worried is a face of its own; a body without one shows sad", () => {
  const clips = [clip("idle_a", "idle"), clip("sad", "react", "sad"), clip("worried", "react", "worried")];
  assert.deepEqual(clipsFor({ clips, emotions: { sad: ["sad"], worried: ["worried"] } }, "worried").clips.map((c) => c.id), ["worried"]);
  assert.deepEqual(clipsFor({ clips: clips.slice(0, 2), emotions: { sad: ["sad"] } }, "worried").clips.map((c) => c.id), ["sad"]);
});

test("her state words as tags never show as text", () => {
  // (she wrote "[worried] ...하렴아, 요즘 많이 힘들어?" and the tag stood in the bubble)
  const p = parseEmotionText("[worried] ...요즘 많이 힘들어? [lonely] 보고 싶었어. [nervous:0.6] 괜찮을까?");
  assert.equal(p.text.includes("["), false);
  assert.deepEqual(p.tags.map((t) => t.emotion), ["worried", "sad", "worried"]);
  assert.equal(p.emotion, "worried");
  assert.equal(p.intensity, 0.6);
});
