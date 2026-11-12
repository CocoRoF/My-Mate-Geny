// The Mate panel's guide (src/mate/guide.ts): how its buttons move, once per account on this device, and what each
// step saves — only what was changed there; the feelings her avatar shows; ElevenLabs gets its model picked.
//   Run: npm run test:unit
import assert from "node:assert/strict";
import test from "node:test";
import {
  avatarPatch,
  deviceDraft,
  devicePatch,
  emotionList,
  GUIDE_ELEVEN_MODEL,
  GUIDE_EMOTIONS,
  GUIDE_STEPS,
  guideMove,
  guideSeen,
  guideTts,
  markGuideSeen,
  profileDraft,
  profilePatch,
  stepNumber,
  styleDraft,
  stylePatch,
  voicePatch,
  withEmotionShown,
  withEmotionToggles,
  withTtsEngine,
  type GuidePage,
} from "../src/mate/guide";
import type { Avatar } from "../src/mate/types";

test("next and skip go on to the closing page, back goes back, later closes", () => {
  const seen: GuidePage[] = [];
  let p: GuidePage | null = "profile";
  while (p) {
    seen.push(p);
    p = guideMove(p, "next");
  }
  assert.deepEqual(seen, [...GUIDE_STEPS, "done"]);
  assert.equal(guideMove("style", "skip"), "avatar");
  assert.equal(guideMove("device", "skip"), "done");
  assert.equal(guideMove("profile", "back"), "profile", "nothing before the first step");
  assert.equal(guideMove("voice", "back"), "avatar");
  assert.equal(guideMove("done", "back"), "device");
  for (const page of [...GUIDE_STEPS, "done"] as GuidePage[]) assert.equal(guideMove(page, "later"), null);
  assert.deepEqual([...GUIDE_STEPS, "done"].map((x) => stepNumber(x as GuidePage)), [1, 2, 3, 4, 5, 5]);
});

test("seen once per account on this device", () => {
  assert.equal(guideSeen(null, "admin"), false);
  const raw = markGuideSeen(null, "admin");
  assert.equal(guideSeen(raw, "admin"), true);
  assert.equal(guideSeen(raw, "hrjang"), false, "another account sees it once too");
  const both = markGuideSeen(raw, "hrjang");
  assert.ok(guideSeen(both, "admin") && guideSeen(both, "hrjang"));
  assert.equal(markGuideSeen(both, "admin"), both, "the same account: nothing new");
  assert.equal(guideSeen("1", "anyone"), true, "\"1\": every account (tests, scripts)");
  assert.equal(guideSeen("{not json", "admin"), false);
  assert.equal(guideSeen(markGuideSeen("{not json", "admin"), "admin"), true);
});

const mate = {
  name: "하린",
  persona: { description: "A barista.", personality: "warm", greeting: "", language: "ko", instructions: "", birthday: "" },
};

test("the profile step saves only what was changed; an emptied name keeps hers", () => {
  const saved = profileDraft(mate);
  assert.equal(profilePatch(saved, saved), null);
  assert.deepEqual(profilePatch(saved, { ...saved, birthday: "06-21" }), { persona: { birthday: "06-21" } });
  assert.deepEqual(profilePatch(saved, { ...saved, name: "  하린 ", personality: "shy" }), { persona: { personality: "shy" } });
  assert.deepEqual(profilePatch(saved, { ...saved, name: "Harin", description: "" }), { name: "Harin", persona: { description: "" } });
  assert.equal(profilePatch(saved, { ...saved, name: "   " }), null);
});

test("the style step: what she calls you, warmth and humour", () => {
  const saved = styleDraft({ address: "", tone: { warmth: "auto", humor: "auto", initiative: "high" } });
  assert.deepEqual(saved, { address: "", warmth: "auto", humor: "auto" });
  assert.equal(stylePatch(saved, saved), null);
  assert.deepEqual(stylePatch(saved, { ...saved, address: " 현석 씨 ", humor: "high" }), { prefs: { address: "현석 씨", tone: { humor: "high" } } });
});

const tts = { engine: "openai" as const, voice: "nova", model: "gpt-4o-mini-tts", speed: 1.5, profile: "", language: "" };

test("voice: another engine drops the voice and model; ElevenLabs gets its model picked", () => {
  const eleven = withTtsEngine(tts, "elevenlabs", tts, [0.7, 1.2]);
  assert.equal(eleven.engine, "elevenlabs");
  assert.equal(eleven.model, GUIDE_ELEVEN_MODEL);
  assert.equal(eleven.voice, "");
  assert.equal(eleven.speed, 1.2, "within the engine's speed range");
  assert.deepEqual(withTtsEngine(eleven, "openai", tts), tts, "back to hers: hers again");
  assert.equal(withTtsEngine(tts, "browser", tts).model, "");
  assert.deepEqual(voicePatch(tts, eleven), { voice: { tts: { engine: "elevenlabs", voice: "", model: GUIDE_ELEVEN_MODEL, speed: 1.2 } } });
  assert.equal(voicePatch(tts, { ...tts }), null);
  // she already speaks with ElevenLabs on its default model: the step shows the guide's
  assert.equal(guideTts({ ...tts, engine: "elevenlabs", model: "" }).model, GUIDE_ELEVEN_MODEL);
  assert.equal(guideTts({ ...tts, engine: "elevenlabs", model: "eleven_v3" }).model, "eleven_v3");
});

test("this device: asking first, the picture's size, speaking first (for her), the volume", () => {
  const prefs = { screen: { approval: "ask" as const, max_edge: 0, proactive_enabled: null, source: null, hide_avatar: false, proactive_interval: 180 }, volume: 1 };
  const d = deviceDraft(prefs);
  assert.deepEqual(d, { approval: "ask", max_edge: 0, proactive: false, volume: 1 });
  assert.equal(devicePatch(prefs, d, "mate_1"), null);
  assert.deepEqual(devicePatch(prefs, { ...d, proactive: true, volume: 1.5 }, "mate_1"), {
    screen: { proactive_enabled: true, proactive_mate: "mate_1", proactive_interval: 60 },
    volume: 1.5,
  });
  assert.deepEqual(devicePatch(prefs, { ...d, approval: "allow", max_edge: 1920 }, null), { screen: { approval: "allow", max_edge: 1920 } });
});

const photo = (): Avatar => ({
  kind: "photo",
  rig: { aspect: [3, 4], home: "/n.png", stills: { neutral: "/n.png", smile: "/s.png", sad: "/sad.png", blink: "/b.png" }, clips: [], emotion_stills: { shy: "smile" } },
});

test("the feelings a photo avatar shows: switched off, on again (as it was), and what can't show", () => {
  const a = photo();
  const list = emotionList(a)!;
  assert.deepEqual(list.map((x) => x.emotion), [...GUIDE_EMOTIONS]);
  assert.ok(!GUIDE_EMOTIONS.includes("neutral"), "her resting face is always there");
  const by = (l: typeof list, e: string) => l.find((x) => x.emotion === e)!;
  assert.deepEqual(by(list, "smile"), { emotion: "smile", on: true, can: true, picture: "/s.png" });
  assert.equal(by(list, "shy").picture, "/s.png", "the still the Avatar tab chose for it");
  assert.deepEqual(by(list, "angry"), { emotion: "angry", on: true, can: true, picture: "/sad.png" }, "a near feeling stands in");
  assert.deepEqual(by(list, "sleepy"), { emotion: "sleepy", on: false, can: false, picture: null });
  const off = withEmotionShown(a, "shy", false);
  assert.equal(off.kind === "photo" && off.rig.emotion_stills?.shy, "");
  assert.equal(by(emotionList(off)!, "shy").on, false);
  assert.equal(by(emotionList(off)!, "shy").can, false, "no face of its own for it…");
  assert.deepEqual(by(emotionList(off, a)!, "shy"), { emotion: "shy", on: false, can: true, picture: "/s.png" }, "…but it can be on again, as it was");
  const back = withEmotionShown(off, "shy", true, a);
  assert.deepEqual(back, a, "on again: the still it had");
  const smileOff = withEmotionShown(a, "smile", false);
  assert.deepEqual(withEmotionShown(smileOff, "smile", true, a), a, "on again: automatic");
  assert.equal(avatarPatch(a, a), null);
  assert.deepEqual(avatarPatch(a, smileOff), { avatar: smileOff });
  assert.deepEqual(withEmotionToggles(a, { smile: false, shy: true }), smileOff);
});

test("a video avatar: its reaction clips decide; off is no clip and no still", () => {
  const a: Avatar = {
    kind: "video",
    rig: {
      aspect: [3, 4],
      home: "/n.png",
      stills: { neutral: "/n.png", laugh: "/l.png" },
      clips: [
        { id: "idle", kind: "idle", src: "/i.mp4" },
        { id: "laugh", kind: "react", emotion: "laugh", src: "/l.mp4", thumb: "/l.jpg" },
      ],
    },
  };
  const laugh = emotionList(a)!.find((x) => x.emotion === "laugh")!;
  assert.deepEqual(laugh, { emotion: "laugh", on: true, can: true, picture: "/l.jpg" });
  const off = withEmotionShown(a, "laugh", false);
  assert.ok(off.kind === "video" && off.rig.emotions?.laugh?.length === 0 && off.rig.emotion_stills?.laugh === "");
  assert.equal(emotionList(off)!.find((x) => x.emotion === "laugh")!.on, false);
  const again = withEmotionShown(off, "laugh", true, a);
  assert.ok(again.kind === "video" && a.kind === "video");
  assert.deepEqual(again.rig, { ...a.rig, emotions: {}, emotion_stills: {} }, "on again: automatic");
  assert.equal(emotionList(a)!.find((x) => x.emotion === "sad")!.can, false);
});

test("a LivLiv avatar: its expressions; Live2D and no avatar have nothing to switch here", () => {
  const a: Avatar = { kind: "livliv", livliv: { model: "/m.json", expressions: ["smile", "angry"] } };
  const list = emotionList(a)!;
  assert.equal(list.find((x) => x.emotion === "smile")!.on, true);
  assert.equal(list.find((x) => x.emotion === "sad")!.can, false);
  const off = withEmotionShown(a, "angry", false);
  assert.deepEqual(off.kind === "livliv" && off.livliv.emotions, { angry: "" });
  assert.deepEqual(withEmotionShown(off, "angry", true, a), { ...a, livliv: { ...a.livliv, emotions: undefined } });
  assert.equal(emotionList({ kind: "none" }), null);
  assert.equal(emotionList({ kind: "live2d", live2d: { model: "/x.model3.json" } }), null);
});
