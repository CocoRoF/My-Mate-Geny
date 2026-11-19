// The studio's Guide tab (src/components/mate/studio/guide.ts): which step is now, what counts as done, how her look
// is being made, where the picture way stands, and her emotions matched to a model's names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentStep, drawStage, guideProgress, lookPathOf, stepsDone, suggestMap, suggestName } from "../src/components/mate/studio/guide.ts";
import type { AvatarProject } from "../src/api/avatar.ts";
import type { Mate } from "../src/api/mates.ts";

function project(over: Partial<AvatarProject> = {}, studio: Record<string, unknown> = {}): AvatarProject {
  return {
    id: "av_1",
    status: "interview",
    brief: { reference: { mode: "none", files: [] }, design: { prompt: "", notes: "" }, clips: [], stills: [], candidates: 4 },
    plan: null,
    confirmation: null,
    extras: [],
    items: {},
    checkpoint: null,
    files: { refs: [], candidates: [], stills: [], clips: [], home: null, face: null },
    studio: { kind: "new", mate_id: "d1", concept: {}, filled: {}, avatar_skipped: false, voice_ok: false, finished_at: null, missing: [], ...studio },
    ...over,
  } as unknown as AvatarProject;
}

function mate(over: Partial<Mate> = {}): Mate {
  return {
    id: "d1",
    name: "",
    persona: { description: "", personality: "", greeting: "", instructions: "", language: "ko" },
    avatar: { kind: "none" },
    llm: { provider: "x", model: "m" },
    voice: { tts: { engine: "off" } },
    prefs: undefined,
    ...over,
  } as unknown as Mate;
}

test("a fresh draft starts at the concept; the concept can be passed over, the name and personality can't", () => {
  const p = project();
  const m = mate();
  const done = stepsDone(p, m, {}, null);
  assert.equal(currentStep(done, {}), "concept");
  // passed over: the next one is now
  assert.equal(currentStep(done, { concept: true }), "profile");
  assert.deepEqual(guideProgress(done, { concept: true }), { done: 1, total: 7 });
  // a name alone isn't enough
  const named = mate({ name: "서아" });
  assert.equal(stepsDone(p, named, { concept: true }, null).profile, false);
  const who = mate({ name: "서아", persona: { description: "", personality: "다정함", greeting: "", instructions: "", language: "ko" } as Mate["persona"] });
  const d2 = stepsDone(p, who, {}, null);
  assert.equal(d2.profile, true);
  // (a name and who she is make the concept count as written too)
  assert.equal(d2.concept, true);
  assert.equal(currentStep(d2, {}), "style");
});

test("how she talks, temperament, voice and model: done when set, or when the user kept the default", () => {
  const p = project({}, { concept: { pitch: "x" } });
  const m = mate({ name: "a", persona: { description: "b", personality: "", greeting: "", instructions: "", language: "ko" } as Mate["persona"] });
  let done = stepsDone(p, m, {}, null);
  assert.equal(currentStep(done, {}), "style");
  const casual = mate({ ...m, prefs: { formality: "banmal" } as Mate["prefs"] });
  done = stepsDone(p, casual, {}, null);
  assert.equal(done.style, true);
  assert.equal(currentStep(done, {}), "temperament");
  assert.equal(currentStep(done, { temperament: true }), "look");
  // the voice: tested on the server, or kept
  assert.equal(stepsDone(project({}, { voice_ok: true }), m, {}, null).voice, true);
  assert.equal(stepsDone(p, m, { voice: true }, null).voice, true);
});

test("her look: the way it is made comes from the project and the mate before the user's pick", () => {
  const m = mate();
  assert.equal(lookPathOf(project(), m, null), null);
  assert.equal(lookPathOf(project(), m, "file"), "file");
  assert.equal(lookPathOf(project({}, { avatar_skipped: true }), m, "draw"), "later");
  assert.equal(lookPathOf(project({ plan: { id: "p", total: 3 } } as Partial<AvatarProject>), m, "file"), "draw");
  const l2d = mate({ avatar: { kind: "live2d", live2d: { model: "/m.model3.json" } } });
  assert.equal(lookPathOf(project(), l2d, null), "file");
  // (a Live2D mate who wants a drawn look: the pick wins until a run starts)
  assert.equal(lookPathOf(project(), l2d, "draw"), "draw");
  // a file look is done once its emotions were looked at
  assert.equal(stepsDone(project(), l2d, {}, "file").look, false);
  assert.equal(stepsDone(project(), l2d, { look: true }, "file").look, true);
  // later: done (the avatar is skipped); drawn: done once confirmed (it lands by itself)
  assert.equal(stepsDone(project(), m, {}, "later").look, true);
  assert.equal(stepsDone(project({ confirmation: { plan_id: "p", total: 1, cap: 1, at: "" } } as Partial<AvatarProject>), m, {}, "draw").look, true);
});

test("the picture way, one step at a time", () => {
  assert.equal(drawStage(project()), "brief");
  assert.equal(drawStage(project({ status: "estimate", plan: { id: "p", total: 3 } } as Partial<AvatarProject>)), "estimate");
  const confirmed = { confirmation: { plan_id: "p", total: 1, cap: 1, at: "" } };
  assert.equal(drawStage(project({ ...confirmed, status: "waiting", checkpoint: { stage: "pick" } } as Partial<AvatarProject>)), "pick");
  assert.equal(drawStage(project({ ...confirmed, status: "waiting", checkpoint: { stage: "home" } } as Partial<AvatarProject>)), "home");
  assert.equal(drawStage(project({ ...confirmed, status: "running" } as Partial<AvatarProject>)), "making");
  assert.equal(drawStage(project({ ...confirmed, status: "ready" } as Partial<AvatarProject>)), "ready");
  assert.equal(drawStage(project({ ...confirmed, status: "failed" } as Partial<AvatarProject>)), "failed");
  assert.equal(drawStage(project({ extras: [{ id: "x", status: "pending" }] } as Partial<AvatarProject>)), "extra");
});

test("emotions matched to a model's names: its own name, then its words, each name once", () => {
  const exps = ["F01", "Smile", "angry_face", "sad.exp3.json", "Blush", "Surprised", "white_eye"];
  assert.equal(suggestName("smile", exps), "Smile");
  assert.equal(suggestName("angry", exps), "angry_face");
  assert.equal(suggestName("sad", exps), "sad.exp3.json");
  assert.equal(suggestName("shy", exps), "Blush");
  assert.equal(suggestName("surprised", exps), "Surprised");
  // a short word only as a word of its own: "hi" is not in "white_eye"
  assert.equal(suggestName("greet", exps), null);
  assert.equal(suggestName("greet", ["hi_wave"]), "hi_wave");
  // Japanese and Korean names
  assert.equal(suggestName("laugh", ["通常", "笑い"]), "笑い");
  assert.equal(suggestName("sleepy", ["기본", "졸림"]), "졸림");
  const map = suggestMap(["joy", "smile", "laugh", "sad", "neutral"], ["happy", "Smile", "sad"], { sad: "" });
  // (joy takes "happy"; smile keeps its own name; a choice already made — sad: none — stays)
  assert.deepEqual(map, { joy: "happy", smile: "Smile" });
});
