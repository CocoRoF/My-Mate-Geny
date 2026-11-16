// When her reply shows is behaviour too (frontend/src/mate/replyTiming.ts, docs/geny-state-system.md §6): angry at what they
// did, she takes her time — longer the angrier — and what has arrived is never held longer than that
import assert from "node:assert/strict";
import test from "node:test";
import { AT_THEM, heldBack, heldUntil, replyDelay, TAKES_LEAST_MS, TAKES_MOST_MS } from "../src/mate/replyTiming";
import { restsOn } from "../src/mate/stateLook";
import type { MateState, StateEmotion } from "../src/api/mates";
import type { Turn } from "../src/stores/chatStore";

const feeling = (emotion: StateEmotion, v: number, code: string): MateState => ({
  label: emotion, level: v, blend: null, valence: -0.5, arousal: 0.8, top: [{ emotion, v, why: { code } }],
});

test("angry at them, she takes her time: about 1.5 s when quite angry, up to about 5 s when furious", () => {
  assert.equal(replyDelay(feeling("angry", 0.45, "rude")), TAKES_LEAST_MS);
  assert.equal(TAKES_LEAST_MS, 1500);
  assert.equal(replyDelay(feeling("angry", 0.9, "hostile")), TAKES_MOST_MS);
  assert.equal(TAKES_MOST_MS, 5000);
  assert.equal(replyDelay(feeling("angry", 1, "said")), TAKES_MOST_MS); // (never more)
  const mid = replyDelay(feeling("angry", 0.675, "dismissed"));
  assert.ok(mid > 3000 && mid < 3500, String(mid));
  assert.ok(replyDelay(feeling("angry", 0.6, "rude")) < replyDelay(feeling("angry", 0.7, "rude"))); // (angrier, longer)
});

test("only anger at them, and enough of it: her day's temper, a little put out, or any other feeling answers at once", () => {
  assert.equal(replyDelay(feeling("angry", 0.4, "rude")), 0);
  for (const code of ["hungry", "stressed", "off_day", "nature", "doing"]) assert.equal(replyDelay(feeling("angry", 0.9, code)), 0, code);
  assert.equal(replyDelay({ ...feeling("angry", 0.9, "rude"), top: [{ emotion: "angry", v: 0.9, why: { text: "버스를 놓쳤어" } }] }), 0);
  assert.equal(replyDelay(feeling("sad", 0.9, "rude")), 0);
  assert.equal(replyDelay(feeling("excited", 0.9, "loves")), 0);
  assert.equal(replyDelay(undefined), 0);
  assert.equal(replyDelay(null), 0);
  // (angry at them as the second feeling counts too)
  const both: MateState = { ...feeling("sad", 0.8, "hostile"), top: [{ emotion: "sad", v: 0.8, why: { code: "hostile" } }, { emotion: "angry", v: 0.9, why: { code: "hostile" } }] };
  assert.equal(replyDelay(both), TAKES_MOST_MS);
  // (the same codes as app/mate/state.py AT_THEM)
  assert.deepEqual([...AT_THEM].sort(), ["apology", "brushed_over", "curt", "declined_call", "dismissed", "hostile", "ignored", "interrupted", "missed_call", "pestered", "poked", "rude", "said"]);
});

test("what has arrived waits at most the delay, whatever the clocks say", () => {
  const seen = 1_000_000;
  assert.equal(heldUntil(seen - 1000, seen, 3000), seen + 2000); // (she began a second ago: two more)
  assert.equal(heldUntil(seen - 10_000, seen, 3000), seen); // (the model took longer than that: at once)
  assert.equal(heldUntil(seen + 60_000, seen, 3000), seen + 3000); // (a server clock ahead: never more than the delay)
  assert.equal(heldUntil(undefined, seen, 3000), seen + 3000);
  assert.equal(heldUntil(seen - 1000, seen, 0), 0); // (not angry at them: not held)
  for (const started of [seen - 5000, seen - 100, seen, seen + 100, undefined]) {
    const until = heldUntil(started, seen, TAKES_MOST_MS);
    assert.ok(until - seen <= TAKES_MOST_MS && until - seen >= 0);
  }
});

test("held back, her turn shows as still being written: no words, her typing dots, what she did kept", () => {
  const turn = {
    key: "a1", role: "assistant", text: "됐어.", complete: true, tools: [],
    flow: [{ kind: "tool", toolId: "t1" }, { kind: "text", text: "됐어." }],
  } as unknown as Turn;
  const shown = heldBack(turn);
  assert.equal(shown.text, "");
  assert.equal(shown.complete, false);
  assert.deepEqual(shown.flow, [{ kind: "tool", toolId: "t1" }]);
  assert.equal(turn.text, "됐어."); // (the turn itself is untouched)
});

test("her face rests on a look once she feels it enough; a look without a strength is held as it is", () => {
  assert.equal(restsOn("angry", 0.3), undefined);
  assert.equal(restsOn("angry", 0.45), "angry");
  assert.equal(restsOn("angry", undefined), "angry");
  assert.equal(restsOn(undefined, 0.9), undefined);
});
