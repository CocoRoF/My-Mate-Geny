// What her face does comes from how she feels (docs/mate-memory-affinity.md §6): frontend/src/mate/stateLook.ts
import assert from "node:assert/strict";
import test from "node:test";
import { clipsFor } from "../src/mate/avatar/shared";
import { restingLook, stateLook } from "../src/mate/stateLook";
import type { MateState, StateLabel } from "../src/api/mates";
import type { RigClip } from "../src/mate/types";

const feeling = (label: StateLabel, level: number): { state: MateState } => ({ state: { label, level, blend: null, valence: 0, arousal: 0.4, top: [] } });

test("each state has its look, and calm has none", () => {
  assert.equal(stateLook(feeling("shy", 0.3)), "shy");
  assert.equal(stateLook(feeling("angry", 0.3)), "angry");
  assert.equal(stateLook(feeling("lonely", 0.3)), "sad");
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
