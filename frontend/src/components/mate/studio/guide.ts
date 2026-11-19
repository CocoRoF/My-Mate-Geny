/**
 * The studio's Guide tab, pure (frontend/test/studio-guide.test.ts; docs/avatar-create.md §11 "The guide"): the steps
 * of making a mate in the one order a beginner follows — concept → name and personality → how she talks → temperament
 * → her look (drawn by AI, a file the user has, or later) → voice → language model → create — and where each stands,
 * from the project and the mate the server sends and what the user marked as looked at (`checked`, this browser).
 * Editing an existing mate lists the same steps, each one open to change.
 */
import type { AvatarProject } from "../../../api/avatar";
import { prefsOf, type Mate } from "../../../api/mates";
import { waitingFor } from "./canvas/graph";

export type GuideStepId = "concept" | "profile" | "style" | "temperament" | "look" | "voice" | "model" | "finish";
/** how her look is made: drawn by AI (Higgsfield), from a file the user has (Live2D, LivLiv, a clip pack), or later */
export type LookPath = "draw" | "file" | "later";

export const GUIDE_STEPS: GuideStepId[] = ["concept", "profile", "style", "temperament", "look", "voice", "model", "finish"];
/** steps a beginner may pass over (the defaults are fine) */
export const OPTIONAL: ReadonlySet<GuideStepId> = new Set(["concept", "temperament", "model"]);
/** the node each step's window is (a click on 자세히 / 고치기) */
export const STEP_NODE: Record<Exclude<GuideStepId, "look" | "finish">, string> = {
  concept: "concept",
  profile: "profile",
  style: "style",
  temperament: "temperament",
  voice: "voice",
  model: "model",
};

/** the steps the user looked at or passed over, and `file`: a file brought in here (a clip pack has nothing to match) */
export type Checked = Partial<Record<GuideStepId | "file", boolean>>;

/** her avatar is one the user brought from a file (or one that came with her) */
export const fileAvatar = (m: Mate) => m.avatar.kind === "live2d" || m.avatar.kind === "livliv";

/** the way her look is being made: a skipped avatar or a run first, then what the user picked, then her file look */
export function lookPathOf(p: AvatarProject, m: Mate, picked: LookPath | null): LookPath | null {
  if (p.studio?.avatar_skipped) return "later";
  // (a run asked for or going: the picture way, whatever was picked before)
  if (p.plan || p.confirmation || p.status === "ready" || p.status === "applied") return "draw";
  if (picked) return picked;
  return fileAvatar(m) ? "file" : null;
}

/** where the picture way stands, one step at a time (what the guide asks for next) */
export type DrawStage = "brief" | "estimate" | "pick" | "home" | "stills" | "extra" | "making" | "ready" | "failed";

export function drawStage(p: AvatarProject): DrawStage {
  const w = waitingFor(p);
  if (w === "extra" || w === "cap") return "extra";
  if (w === "estimate") return "estimate";
  if (w === "pick" || w === "home" || w === "stills") return w;
  if (p.status === "ready" || p.status === "applied") return "ready";
  if (p.status === "failed") return "failed";
  if (p.confirmation) return "making";
  return "brief";
}

/** whether each step is done (a step is never "done" by being looked at unless it is one the defaults cover) */
export function stepsDone(p: AvatarProject, m: Mate, checked: Checked, path: LookPath | null): Record<GuideStepId, boolean> {
  const st = p.studio;
  const prefs = prefsOf(m);
  const named = !!m.name.trim();
  const who = !!(m.persona.description.trim() || m.persona.personality.trim());
  const look = path === "later" || m.avatar.kind !== "none" || (path === "draw" && !!p.confirmation);
  return {
    concept: !!(st?.concept.pitch?.trim() || checked.concept || (named && who)),
    profile: named && who,
    style: !!(checked.style || prefs.speech_style.trim() || prefs.formality !== "auto" || prefs.address.trim()),
    temperament: !!(checked.temperament || prefs.temperament),
    look: look && (path !== "file" || !!checked.look || !fileAvatar(m)),
    voice: !!(st?.voice_ok || checked.voice),
    model: !!checked.model,
    finish: !!st?.finished_at,
  };
}

/** the step to do now: the first one not done (an optional one counts once passed over) */
export function currentStep(done: Record<GuideStepId, boolean>, checked: Checked, steps: GuideStepId[] = GUIDE_STEPS): GuideStepId {
  return steps.find((s) => !done[s] && !(OPTIONAL.has(s) && checked[s])) ?? steps[steps.length - 1];
}

/** how far along: the steps done (an optional one passed over counts) of all of them before Create */
export function guideProgress(done: Record<GuideStepId, boolean>, checked: Checked, steps: GuideStepId[] = GUIDE_STEPS): { done: number; total: number } {
  const counted = steps.filter((s) => s !== "finish");
  return { done: counted.filter((s) => done[s] || (OPTIONAL.has(s) && checked[s])).length, total: counted.length };
}

// ── a Live2D model's / LivLiv package's names → her emotions ──

/** words a model's expression or motion names use for each emotion (English, Japanese and Korean files alike) */
const NAME_HINTS: Record<string, string[]> = {
  neutral: ["neutral", "normal", "default", "calm", "base", "通常", "ノーマル", "기본", "평소"],
  joy: ["joy", "happy", "fun", "excite", "delight", "喜", "楽", "기쁨", "신남"],
  smile: ["smile", "happy", "glad", "smirk", "笑顔", "ほほえ", "미소", "웃"],
  laugh: ["laugh", "lol", "grin", "爆笑", "笑", "웃음"],
  shy: ["shy", "blush", "embarrass", "fluster", "照", "恥", "부끄", "수줍"],
  surprised: ["surpris", "shock", "wow", "startle", "驚", "びっくり", "놀람", "놀라"],
  sad: ["sad", "cry", "tear", "sorrow", "悲", "泣", "슬픔", "슬프", "울"],
  worried: ["worr", "anxious", "nervous", "trouble", "concern", "困", "不安", "걱정", "불안"],
  angry: ["angry", "anger", "mad", "pout", "annoy", "怒", "むっ", "화남", "화난", "삐짐"],
  thinking: ["think", "ponder", "curious", "hmm", "考", "생각"],
  agree: ["agree", "nod", "yes", "ok", "うなず", "頷", "끄덕", "동의"],
  greet: ["greet", "wave", "hello", "hi", "bye", "挨拶", "手を振", "인사", "손흔"],
  sleepy: ["sleep", "tired", "yawn", "doze", "drowsy", "眠", "あくび", "졸림", "졸려", "하품"],
};

/** a name holds a word: a short Latin one only as a word of its own ("hi" in "hi_wave", not in "white") */
function holds(name: string, word: string): boolean {
  if (!/^[a-z]{1,3}$/.test(word)) return name.includes(word);
  return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(name);
}

/** the one of `names` that best fits an emotion, or null: its own name first, then a name that holds one of its words */
export function suggestName(emotion: string, names: string[], taken: ReadonlySet<string> = new Set()): string | null {
  const hints = NAME_HINTS[emotion] ?? [emotion];
  const low = names.map((n) => [n, n.toLowerCase()] as const);
  const exact = low.find(([n, l]) => !taken.has(n) && (l === emotion || l.replace(/(\.(exp3|motion3))?(\.json)?$/, "") === emotion));
  if (exact) return exact[0];
  for (const h of hints) {
    const hit = low.find(([n, l]) => holds(l, h) && !taken.has(n));
    if (hit) return hit[0];
  }
  return null;
}

/** emotion → name for every emotion that has none yet and whose words a name holds (an already mapped one stays) */
export function suggestMap(emotions: readonly string[], names: string[], current: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set(Object.values(current).filter((v): v is string => typeof v === "string" && v !== ""));
  for (const e of emotions) {
    if (current[e] !== undefined) continue;
    const n = suggestName(e, names, taken);
    if (n) {
      out[e] = n;
      taken.add(n);
    }
  }
  return out;
}
