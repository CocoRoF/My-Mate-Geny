/**
 * The Mate panel's guide (components/mate/guide/MateGuide.tsx), what it decides without React: its pages and how a
 * button moves between them, whether this account saw it on this device, and what each step saves — only what the
 * user changed there of what is saved now, nothing for a step skipped or left as it was.
 *
 * Steps: profile (name, intro, personality, birthday) · conversation style (what she calls you, warmth, humour) · her
 * avatar's emotions (the ones she shows) · her voice · this device (asking before a capture, the picture's size,
 * speaking first, the volume) — then the closing page.
 */
import type { Mate, MatePatch, MatePrefs, MateVoice, Persona, ToneLevel, TtsEngine } from "../api/mates";
import type { DevicePreferences, DeviceScreen } from "../stores/devicePreferences";
import { clipsFor, stillNameFor } from "./avatar/shared";
import { expressionFor } from "./avatar/livliv";
import { EMOTIONS } from "./emotion";
import type { Avatar, Rig } from "./types";

// ── pages ──

export const GUIDE_STEPS = ["profile", "style", "avatar", "voice", "device"] as const;
export type GuideStep = (typeof GUIDE_STEPS)[number];
/** a step, or the closing page */
export type GuidePage = GuideStep | "done";
/** next: save the step, then on · skip: on, nothing saved · back · later: the guide closes (so does any other way out) */
export type GuideAction = "next" | "skip" | "back" | "later";

/** where a button leads (null: the guide closes) */
export function guideMove(page: GuidePage, action: GuideAction): GuidePage | null {
  if (action === "later") return null;
  const i = page === "done" ? GUIDE_STEPS.length : GUIDE_STEPS.indexOf(page);
  if (action === "back") return i > 0 ? GUIDE_STEPS[i - 1] : page;
  // (next / skip on the closing page: done)
  if (page === "done") return null;
  return i + 1 < GUIDE_STEPS.length ? GUIDE_STEPS[i + 1] : "done";
}

/** 1 – 5 (the closing page counts as the last step) */
export const stepNumber = (page: GuidePage): number => (page === "done" ? GUIDE_STEPS.length : GUIDE_STEPS.indexOf(page) + 1);

// ── seen: once per account on this device ──

export const GUIDE_SEEN_KEY = "hrh_mate_guide_seen_v1";

/** a browser a test drives (Playwright, WebDriver): the guide never opens there by itself — it would stand over what
 *  the test presses (its button still opens it) */
export const automated = (): boolean => typeof navigator !== "undefined" && navigator.webdriver === true;

/** `raw`: what the device keeps — the accounts that saw it (a JSON list); "1": every account */
export function guideSeen(raw: string | null, account: string): boolean {
  if (!raw) return false;
  if (raw === "1") return true;
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) && list.includes(account);
  } catch {
    return false;
  }
}

/** what the device keeps once `account` saw it */
export function markGuideSeen(raw: string | null, account: string): string {
  if (raw === "1") return raw;
  let list: string[] = [];
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    if (Array.isArray(v)) list = v.filter((x): x is string => typeof x === "string");
  } catch {
    /* not ours: start over */
  }
  return JSON.stringify([...new Set([...list, account])].slice(-20));
}

// ── 1. profile ──

export interface ProfileDraft {
  name: string;
  description: string;
  personality: string;
  /** "MM-DD", "" */
  birthday: string;
}

export const profileDraft = (m: Pick<Mate, "name" | "persona">): ProfileDraft => ({
  name: m.name,
  description: m.persona.description,
  personality: m.persona.personality,
  birthday: m.persona.birthday ?? "",
});

/** what to save: what `d` changed of `saved` (null: nothing). An emptied name keeps hers. */
export function profilePatch(saved: ProfileDraft, d: ProfileDraft): MatePatch | null {
  const patch: MatePatch = {};
  const name = d.name.trim();
  if (name && name !== saved.name) patch.name = name;
  const persona: Partial<Persona> = {};
  for (const k of ["description", "personality", "birthday"] as const) if (d[k] !== saved[k]) persona[k] = d[k];
  if (Object.keys(persona).length) patch.persona = persona;
  return Object.keys(patch).length ? patch : null;
}

// ── 2. conversation style ──

export interface StyleDraft {
  address: string;
  warmth: ToneLevel;
  humor: ToneLevel;
}

export const styleDraft = (p: Pick<MatePrefs, "address" | "tone">): StyleDraft => ({ address: p.address, warmth: p.tone.warmth, humor: p.tone.humor });

export function stylePatch(saved: StyleDraft, d: StyleDraft): MatePatch | null {
  const prefs: NonNullable<MatePatch["prefs"]> = {};
  const address = d.address.trim();
  if (address !== saved.address) prefs.address = address;
  const tone: Partial<MatePrefs["tone"]> = {};
  if (d.warmth !== saved.warmth) tone.warmth = d.warmth;
  if (d.humor !== saved.humor) tone.humor = d.humor;
  if (Object.keys(tone).length) prefs.tone = tone;
  return Object.keys(prefs).length ? { prefs } : null;
}

// ── 3. her avatar's emotions ──

/** the feelings her avatar can show (neutral is her resting face: always there) */
export const GUIDE_EMOTIONS: readonly string[] = EMOTIONS.filter((e) => e !== "neutral");

export interface EmotionShow {
  emotion: string;
  /** her avatar shows it */
  on: boolean;
  /** it can (her body has a face for it) */
  can: boolean;
  /** what it looks like (a still, a clip's thumbnail), when there is one */
  picture: string | null;
}

const keyOf = (map: Record<string, unknown> | undefined, e: string) => Object.keys(map ?? {}).find((k) => k.toLowerCase() === e);
const without = <T>(map: Record<string, T> | undefined, e: string): Record<string, T> => {
  const out = { ...(map ?? {}) };
  const k = keyOf(out, e);
  if (k !== undefined) delete out[k];
  return out;
};

/**
 * Each feeling, shown or not (null: nothing to switch here — no avatar, or a Live2D model: its own editor). `base`: the
 * avatar as saved, while switches are being made — a feeling switched off can be switched on again (as it was).
 */
export function emotionList(a: Avatar, base?: Avatar): EmotionShow[] | null {
  const list = shownIn(a);
  const was = base && list ? shownIn(base) : null;
  if (!list || !was) return list;
  return list.map((x, i) => (x.on || !was[i]?.on ? x : { ...x, can: true, picture: x.picture ?? was[i].picture }));
}

function shownIn(a: Avatar): EmotionShow[] | null {
  if (a.kind === "photo" || a.kind === "video") {
    const rig = a.rig;
    const stills = rig.stills ?? {};
    return GUIDE_EMOTIONS.map((e) => {
      const still = stillNameFor(stills, e, rig.emotion_stills);
      const autoStill = stillNameFor(stills, e, without(rig.emotion_stills, e));
      const name = still ?? autoStill;
      const stillPic = name ? stills[name] : null;
      if (a.kind === "photo") return { emotion: e, on: still !== null, can: name !== null, picture: stillPic };
      // (a video body plays a reaction clip for a feeling; its stills only stand in when the video can't play)
      const clips = clipsFor(rig, e).clips;
      const auto = clipsFor({ clips: rig.clips, emotions: without(rig.emotions, e) }, e).clips;
      return { emotion: e, on: clips.length > 0, can: clips.length > 0 || auto.length > 0, picture: (clips[0] ?? auto[0])?.thumb || stillPic };
    });
  }
  if (a.kind === "livliv") {
    const have = a.livliv.expressions ?? [];
    return GUIDE_EMOTIONS.map((e) => {
      const shown = expressionFor(a.livliv, have, e);
      const auto = expressionFor({ ...a.livliv, emotions: without(a.livliv.emotions, e) }, have, e);
      return { emotion: e, on: shown !== null, can: shown !== null || auto !== null, picture: null };
    });
  }
  return null;
}

/** `on`: back to what it was (`base`, the saved avatar, when it chose something for it), else automatic; off: none */
function setIn<T>(map: Record<string, T> | undefined, e: string, on: boolean, off: T, base: Record<string, T> | undefined, empty: (v: T) => boolean): Record<string, T> {
  const out = without(map, e);
  const k = keyOf(map, e) ?? e;
  if (!on) out[k] = off;
  else {
    const bk = keyOf(base, e);
    const was = bk !== undefined ? base![bk] : undefined;
    if (was !== undefined && !empty(was)) out[bk!] = was;
  }
  return out;
}

/** her avatar showing a feeling or not (the same as the Avatar tab's choices: a still / clip list / expression of none) */
export function withEmotionShown(a: Avatar, e: string, on: boolean, base?: Avatar): Avatar {
  const baseRig: Rig | undefined = base && (base.kind === "photo" || base.kind === "video") ? base.rig : undefined;
  if (a.kind === "photo" || a.kind === "video") {
    const rig: Rig = { ...a.rig, emotion_stills: setIn(a.rig.emotion_stills, e, on, "", baseRig?.emotion_stills, (v) => v === "") };
    if (a.kind === "video") rig.emotions = setIn(a.rig.emotions, e, on, [] as string[], baseRig?.emotions, (v) => !v.length);
    return { ...a, rig } as Avatar;
  }
  if (a.kind === "livliv") {
    const map = setIn(a.livliv.emotions, e, on, "", base?.kind === "livliv" ? base.livliv.emotions : undefined, (v) => v === "");
    return { ...a, livliv: { ...a.livliv, emotions: Object.keys(map).length ? map : undefined } };
  }
  return a;
}

/** the user's switches (feeling → shown) put on her avatar as it is saved now */
export function withEmotionToggles(a: Avatar, toggles: Record<string, boolean>): Avatar {
  let out = a;
  for (const [e, on] of Object.entries(toggles)) out = withEmotionShown(out, e, on, a);
  return out;
}

export const avatarPatch = (saved: Avatar, d: Avatar): MatePatch | null => (JSON.stringify(saved) === JSON.stringify(d) ? null : { avatar: d });

// ── 4. voice ──

type Tts = MateVoice["tts"];

/** ElevenLabs in the guide: its model is picked for her (someone setting up a mate needn't know the models) */
export const GUIDE_ELEVEN_MODEL = "eleven_v4_turbo";

/** the voice the step starts from: hers (ElevenLabs without a model: the guide's) */
export const guideTts = (saved: Tts): Tts => (saved.engine === "elevenlabs" && !saved.model ? { ...saved, model: GUIDE_ELEVEN_MODEL } : { ...saved });

/** another engine: a voice / model of one engine means nothing to another (back to hers: hers again) */
export function withTtsEngine(tts: Tts, engine: TtsEngine, saved: Tts, speed: [number, number] = [0.5, 2]): Tts {
  if (engine === tts.engine) return tts;
  if (engine === saved.engine) return guideTts(saved);
  const [lo, hi] = speed;
  return { ...tts, engine, voice: "", profile: "", model: engine === "elevenlabs" ? GUIDE_ELEVEN_MODEL : "", speed: Math.min(hi, Math.max(lo, tts.speed || 1)) };
}

export function voicePatch(saved: Tts, d: Tts): MatePatch | null {
  const tts: Partial<Tts> = {};
  for (const k of ["engine", "voice", "model", "profile", "speed"] as const) if (d[k] !== saved[k]) Object.assign(tts, { [k]: d[k] });
  return Object.keys(tts).length ? { voice: { tts } } : null;
}

// ── 5. this device (the same store as Settings → 메이트 / the 공통 tab) ──

export interface DeviceDraft {
  approval: DeviceScreen["approval"];
  max_edge: number;
  /** she speaks first on this device */
  proactive: boolean;
  volume: number;
}

export const deviceDraft = (p: Pick<DevicePreferences, "screen" | "volume">): DeviceDraft => ({
  approval: p.screen.approval,
  max_edge: p.screen.max_edge,
  proactive: !!p.screen.proactive_enabled,
  volume: p.volume,
});

/** what to write to this device's preferences (speaking first: for `mateId`, as the 공통 tab writes it) */
export function devicePatch(p: Pick<DevicePreferences, "screen" | "volume">, d: DeviceDraft, mateId: string | null): { screen?: Partial<DeviceScreen>; volume?: number } | null {
  const screen: Partial<DeviceScreen> = {};
  if (d.approval !== p.screen.approval) screen.approval = d.approval;
  if (d.max_edge !== p.screen.max_edge) screen.max_edge = d.max_edge;
  if (d.proactive !== !!p.screen.proactive_enabled) Object.assign(screen, { proactive_enabled: d.proactive, proactive_mate: mateId || undefined, proactive_interval: 60 });
  const out: { screen?: Partial<DeviceScreen>; volume?: number } = {};
  if (Object.keys(screen).length) out.screen = screen;
  if (d.volume !== p.volume) out.volume = d.volume;
  return Object.keys(out).length ? out : null;
}
