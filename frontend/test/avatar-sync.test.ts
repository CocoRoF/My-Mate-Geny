// node --import ./test/ts-resolve.mjs --test test/avatar-sync.test.ts
// One mate, one face on this computer (docs/mate.md §2 "In step"): her mouth, her reactions and her clips go from the
// window that leads to the others over BroadcastChannels; a player that stops moving says so (src/mate/avatar/player.ts
// StallWatch). Another window is played here by a BroadcastChannel of the test's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STALL_LOADING_MS, STALL_MS, StallWatch } from "../src/mate/avatar/player.ts";
import { leaderClip, onClip, onReact, tellClip, tellReact } from "../src/mate/avatarSync.ts";
import { claimVoice, end, level, REMOTE_QUIET_MS, showsMate, start, voiceBridge } from "../src/mate/voiceBridge.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a player that stops moving is nudged once, then said to have stalled; resting or paused is no stall", () => {
  const seen: string[] = [];
  const w = new StallWatch(() => seen.push("nudge"), () => seen.push("stall"));
  w.check(0, 1.0, true, false);
  w.check(1000, 1.5, true, false); // (moving)
  w.check(1000 + STALL_MS - 1, 1.5, true, false);
  assert.deepEqual(seen, []);
  w.check(1000 + STALL_MS + 1, 1.5, true, false);
  assert.deepEqual(seen, ["nudge"]);
  w.check(1000 + 2 * STALL_MS + 1, 1.5, true, false);
  assert.deepEqual(seen, ["nudge", "stall"]);
  // paused on purpose, or resting at a clip's end with nothing asked for: the clock starts again after
  const quiet: string[] = [];
  const q = new StallWatch(() => quiet.push("nudge"), () => quiet.push("stall"));
  q.check(0, 2, true, false);
  q.check(60_000, -1, false, false);
  q.check(60_001, 2, true, false);
  q.check(60_001 + STALL_MS - 5, 2, true, false);
  assert.deepEqual(quiet, []);
  // a clip still loading has longer
  const loading: string[] = [];
  const l = new StallWatch(() => loading.push("nudge"), () => loading.push("stall"));
  l.check(0, 0, true, true);
  l.check(STALL_MS * 2 + 10, 0, true, true);
  assert.deepEqual(loading, []);
  l.check(STALL_LOADING_MS + 10, 0, true, true);
  assert.deepEqual(loading, ["nudge"]);
});

test("reactions and clips go to the other windows, and come from them", async () => {
  const other = new BroadcastChannel("hrh-mate-avatar");
  const got: any[] = [];
  other.onmessage = (e) => got.push(e.data);
  tellReact("m1", "joy");
  tellClip("m1", "idle_b", 1000);
  await wait(50);
  assert.deepEqual(got.map((m) => [m.type, m.mateId, m.name ?? m.clip]), [["react", "m1", "joy"], ["clip", "m1", "idle_b"]]);
  // what another window says reaches this one
  const reacts: string[] = [];
  const clips: string[] = [];
  const off1 = onReact((mid, name) => reacts.push(`${mid}:${name}`));
  const off2 = onClip((mid, clip, at) => clips.push(`${mid}:${clip}@${at}`));
  other.postMessage({ type: "react", mateId: "m1", name: "shy", from: "elsewhere" });
  other.postMessage({ type: "clip", mateId: "m1", clip: "talk_a", at: 2000, from: "elsewhere" });
  await wait(50);
  assert.deepEqual(reacts, ["m1:shy"]);
  assert.deepEqual(clips, ["m1:talk_a@2000"]);
  assert.deepEqual(leaderClip("m1"), { clip: "talk_a", at: 2000 }, "a body made later still joins the leader's clip");
  off1();
  off2();
  other.close();
});

test("her mouth: this window's voice is told to the others; another's moves an avatar shown here, then stops", async () => {
  const other = new BroadcastChannel("hrh-mate-lips");
  const heard: any[] = [];
  other.onmessage = (e) => heard.push(e.data);
  // nothing claimed: nothing told
  start("solo");
  end("solo");
  await wait(30);
  assert.equal(heard.length, 0);
  // the conversation that speaks for her claims the voice: start, level, end go out with her id
  const release = claimVoice("m1");
  start("mate-voice");
  level(0.3);
  end("mate-voice");
  await wait(50);
  assert.deepEqual(heard.map((m) => [m.mateId, m.e.type]), [["m1", "start"], ["m1", "level"], ["m1", "end"]]);
  release();

  // another window speaks for her: an avatar of her here talks along (a remote id), and nothing is told back
  heard.length = 0;
  const unshow = showsMate("m2");
  other.postMessage({ mateId: "m2", id: "mate-voice", e: { type: "start", id: "mate-voice" } });
  other.postMessage({ mateId: "m2", id: "mate-voice", e: { type: "level", level: 0.4 } });
  await wait(50);
  assert.equal(voiceBridge.speaking, "remote:mate-voice");
  assert.ok(Math.abs(voiceBridge.currentLevel - 0.4) < 1e-9);
  assert.equal(heard.length, 0, "a voice only played along is not told again");
  // another mate's voice moves nothing here
  other.postMessage({ mateId: "m3", id: "x", e: { type: "start", id: "x" } });
  await wait(30);
  assert.equal(voiceBridge.speaking, "remote:mate-voice");
  // it went quiet without its end (the window closed): it ends by itself
  await wait(REMOTE_QUIET_MS + 600);
  assert.equal(voiceBridge.speaking, null);
  // this window's own voice comes first
  start("own");
  other.postMessage({ mateId: "m2", id: "mate-voice", e: { type: "start", id: "mate-voice" } });
  await wait(30);
  assert.equal(voiceBridge.speaking, "own");
  end("own");
  unshow();
  other.close();
});
