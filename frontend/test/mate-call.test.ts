// Phone calls with her (docs/mate-calls.md), the page's pure parts: the call's state machine (dial / ring / accept /
// decline / connected / ended / another window took it), its clock, voice activity (thresholds, the noise floor, blips,
// pre-roll, stricter while she speaks, the end after a pause) and the line's tones.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { callClock, callLength, IDLE, reduceCall, type CallEvent, type CallMachine } from "../src/mate/call/machine.ts";
import { Framer, frameRms, Vad } from "../src/mate/call/vad.ts";
import { cycleLength, schedule, tonePlan } from "../src/mate/call/tones.ts";

const run = (events: CallEvent[], from: CallMachine = IDLE) => events.reduce(reduceCall, from);

test("calling her: dialing until her first sound, then the clock runs; hanging up before it is a cancelled call", () => {
  let s = run([{ type: "dial", mateId: "m1", at: 1000 }, { type: "dialed", callId: "c1" }]);
  assert.equal(s.phase, "dialing");
  assert.equal(s.callId, "c1");
  assert.equal(s.direction, "outgoing");
  assert.equal(run([{ type: "dial", mateId: "m2", at: 1100 }], s), s, "one call at a time");
  s = reduceCall(s, { type: "connected", at: 2500 });
  assert.equal(s.phase, "active");
  assert.equal(s.connectedAt, 2500);
  assert.equal(reduceCall(s, { type: "connected", at: 9000 }).connectedAt, 2500, "the clock starts once");
  const done = reduceCall(s, { type: "hangup", at: 5000 });
  assert.equal(done.phase, "ended");
  assert.equal(done.endReason, "hangup");
  const early = run([{ type: "dial", mateId: "m1", at: 1 }, { type: "hangup", at: 2 }]);
  assert.equal(early.endReason, "cancelled");
  assert.deepEqual(reduceCall(done, { type: "dismiss" }), { ...IDLE, speaker: done.speaker });
});

test("she calls: ringing until it is taken, turned down, missed — or taken in another window", () => {
  const ring = run([{ type: "ring", callId: "c2", mateId: "m1", at: 0 }]);
  assert.equal(ring.phase, "incoming");
  assert.equal(ring.direction, "incoming");
  const taken = reduceCall(ring, { type: "accept", at: 100 });
  assert.equal(taken.phase, "active");
  assert.equal(taken.connectedAt, null, "the timer waits for her first sound");
  assert.equal(reduceCall(ring, { type: "decline", at: 5 }).endReason, "declined");
  assert.equal(reduceCall(ring, { type: "hangup", at: 5 }).endReason, "declined", "the red button while ringing turns it down");
  const missed = reduceCall(ring, { type: "remote", callId: "c2", status: "ended", endReason: "missed", at: 30000 });
  assert.equal(missed.endReason, "missed");
  const elsewhere = reduceCall(ring, { type: "remote", callId: "c2", status: "active", at: 4000 });
  assert.equal(elsewhere.phase, "ended");
  assert.equal(elsewhere.endReason, "elsewhere");
  assert.equal(reduceCall(ring, { type: "remote", callId: "other", status: "ended", at: 1 }), ring, "another call's news is not this one's");
  assert.equal(reduceCall(taken, { type: "ring", callId: "c3", mateId: "m2", at: 1 }), taken, "busy: a second ring is not shown");
  assert.equal(reduceCall(taken, { type: "remote", callId: "c2", status: "ended", endReason: "weird", at: 1 }).endReason, "gone");
});

test("on the line: mute, speaker, minimize, a dropped line", () => {
  let s = run([{ type: "dial", mateId: "m1", at: 0 }, { type: "dialed", callId: "c" }, { type: "connected", at: 10 }]);
  assert.equal(s.speaker, true, "the loudspeaker by default: they look at her while they talk");
  s = run([{ type: "mute" }, { type: "speaker" }, { type: "minimize", on: true }], s);
  assert.equal(s.muted, true);
  assert.equal(s.speaker, false);
  assert.equal(s.minimized, true);
  s = reduceCall(s, { type: "lost" });
  assert.equal(s.reconnecting, true);
  assert.equal(reduceCall(s, { type: "resumed" }).reconnecting, false);
  const gone = reduceCall(s, { type: "ended", reason: "network", at: 99 });
  assert.equal(gone.endReason, "network");
  assert.equal(gone.minimized, false, "the end is shown in full");
  assert.equal(gone.reconnecting, false);
  const after = run([{ type: "dismiss" }, { type: "dial", mateId: "m1", at: 200 }], gone);
  assert.equal(after.speaker, false, "the speaker choice stays for the next call");
  assert.equal(reduceCall(IDLE, { type: "minimize", on: true }).minimized, false);
});

test("the call's clock", () => {
  assert.equal(callClock(0), "00:00");
  assert.equal(callClock(83_400), "01:23");
  assert.equal(callClock(3_723_000), "1:02:03");
  assert.equal(callLength(192), "3:12");
  assert.equal(callLength(7), "0:07");
  assert.equal(callLength(3723), "1:02:03");
});

// ---- voice activity ----

const FRAME = 480; // 30 ms at 16 kHz
const frame = (level: number) => {
  const amp = Math.round(level * Math.SQRT2 * 0x7fff);
  return Int16Array.from({ length: FRAME }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * 300 * i) / 16000)));
};
function feed(v: Vad, levels: number[], t0 = 0) {
  const out = [];
  let t = t0;
  for (const l of levels) {
    out.push(...v.push(frame(l), t));
    t += 30;
  }
  return out;
}
const repeat = (level: number, ms: number) => Array.from({ length: Math.round(ms / 30) }, () => level);

test("vad: a frame's loudness", () => {
  assert.ok(Math.abs(frameRms(frame(0.1)) - 0.1) < 0.005);
  assert.equal(frameRms(new Int16Array(10)), 0);
});

test("vad: an utterance starts after a little speech, ends after a pause, keeps its first syllable", () => {
  const v = new Vad();
  const ev = feed(v, [...repeat(0.002, 600), ...repeat(0.08, 900), ...repeat(0.002, 900)]);
  const start = ev.find((e) => e.type === "start");
  const end = ev.find((e) => e.type === "end");
  assert.ok(start && start.at === 600, `starts where the speech does (${start?.at})`);
  assert.ok(end && end.type === "end");
  if (end.type !== "end") return;
  assert.ok(Math.abs(end.speechMs - 900) <= 30, `speech ${end.speechMs} ms`);
  assert.ok(Math.abs(end.at - 1500) <= 30, `ends after the last word (${end.at})`);
  const ms = end.audio.reduce((n, f) => n + f.length, 0) / 16;
  assert.ok(ms >= 900 + 250 && ms <= 900 + 300 + 250, `the audio: pre-roll + speech + a little quiet (${ms} ms)`);
  assert.equal(v.speaking, false);
});

test("vad: a click or a cough is not speech; a short word is a blip", () => {
  const v = new Vad();
  assert.deepEqual(feed(v, [...repeat(0.002, 300), 0.3, 0.002, 0.3, ...repeat(0.002, 300)]), []);
  const ev = feed(v, [...repeat(0.08, 150), ...repeat(0.002, 900)]);
  assert.deepEqual(ev.map((e) => e.type), ["start", "drop"]);
});

test("vad: the noise floor follows the room; a pause shorter than the end is still one utterance", () => {
  const v = new Vad();
  feed(v, repeat(0.02, 3000)); // (a fan: louder than the absolute floor)
  assert.ok(v.noise > 0.015, `noise ${v.noise}`);
  assert.deepEqual(feed(v, repeat(0.03, 600)), [], "the fan a little louder is not speech");
  const ev = feed(v, [...repeat(0.15, 600), ...repeat(0.02, 400), ...repeat(0.15, 600), ...repeat(0.02, 900)]);
  assert.deepEqual(ev.map((e) => e.type), ["start", "end"]);
});

test("vad: while she speaks it takes clearer and longer speech (her voice may leak from the loudspeaker)", () => {
  const v = new Vad();
  feed(v, repeat(0.002, 600));
  v.guard = true;
  assert.deepEqual(feed(v, [...repeat(0.03, 180), ...repeat(0.002, 300)]), [], "her echo, quieter than the user");
  assert.ok(feed(v, repeat(0.12, 300)).some((e) => e.type === "start"), "the user talking over her");
});

test("vad: framer cuts any stream into frames", () => {
  const f = new Framer(FRAME);
  const a = f.push(new Int16Array(1000));
  const b = f.push(new Int16Array(500));
  assert.equal(a.length, 2);
  assert.equal(b.length, 1);
  assert.ok([...a, ...b].every((x) => x.length === FRAME));
});

// ---- tones ----

test("tones: the ring-back is Korean style; hanging up beeps three times; picking up is a click", () => {
  const rb = tonePlan("ringback");
  assert.deepEqual(rb.segs[0].freqs, [440, 480]);
  assert.equal(cycleLength(rb), 3);
  assert.equal(rb.times, Infinity);
  const s = schedule(rb, 2);
  assert.deepEqual(s.map((x) => x.at), [0, 3]);
  const hang = schedule(tonePlan("hangup"), 10);
  assert.equal(hang.length, 3, "three beeps, however many asked");
  assert.ok(hang.every((x) => x.dur <= 0.25));
  const ring = tonePlan("ringtone");
  assert.ok(ring.segs.length >= 3 && cycleLength(ring) < 3);
  assert.equal(schedule(tonePlan("connect"), 5).length, 1);
});
