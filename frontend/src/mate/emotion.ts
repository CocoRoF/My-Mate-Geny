/**
 * Inline emotion tags in a mate's reply (docs/mate.md §3): `[joy]`, `[joy:0.7]`, usually at the start of a sentence.
 * The client strips them for display and speech and turns the latest one into the avatar's `react`.
 *
 * Only known words (the vocabulary + aliases below) count as tags, so `[1]`, `[TODO]` or a markdown link stay text.
 */

/** the vocabulary the mate prompt asks for */
export const EMOTIONS = [
  "neutral",
  "joy",
  "smile",
  "laugh",
  "shy",
  "surprised",
  "sad",
  "worried",
  "angry",
  "thinking",
  "agree",
  "greet",
  "sleepy",
] as const;

export type Emotion = (typeof EMOTIONS)[number];

/** other words a model writes for the same feeling (Geny emotionMap keys, ailism clip names, common English) */
const INPUT_ALIASES: Record<string, Emotion> = {
  calm: "neutral",
  normal: "neutral",
  default: "neutral",
  happy: "smile",
  smirk: "smile",
  glad: "smile",
  pleased: "smile",
  excited: "joy",
  fun: "joy",
  delighted: "joy",
  laughing: "laugh",
  lol: "laugh",
  embarrassed: "shy",
  blush: "shy",
  flustered: "shy",
  surprise: "surprised",
  shock: "surprised",
  shocked: "surprised",
  fear: "surprised",
  scared: "surprised",
  wow: "surprised",
  sadness: "sad",
  sorry: "sad",
  cry: "sad",
  crying: "sad",
  // (her state words, app/mate/state.py: she writes them as tags too, and none may show as text)
  lonely: "sad",
  lonesome: "sad",
  worry: "worried",
  anxious: "worried",
  nervous: "worried",
  concerned: "worried",
  uneasy: "worried",
  troubled: "worried",
  pout: "angry",
  anger: "angry",
  mad: "angry",
  annoyed: "angry",
  disgust: "angry",
  think: "thinking",
  thoughtful: "thinking",
  hmm: "thinking",
  curious: "thinking",
  nod: "agree",
  yes: "agree",
  ok: "agree",
  okay: "agree",
  wave: "greet",
  hello: "greet",
  hi: "greet",
  bye: "greet",
  tired: "sleepy",
  doze: "sleepy",
  sleep: "sleepy",
  yawn: "sleepy",
};

/**
 * The names to look for in a body, best first: the emotion itself, then the words rigs use for it (ailism-mate's SAME
 * map: still names and clip ids are the same words, a few emotions have other names), then Geny emotionMap keys,
 * then a near feeling when the body has no face for it (angry → a sulk or a start).
 */
const MATCH: Record<Emotion, string[]> = {
  neutral: ["neutral", "calm", "default", "idle"],
  joy: ["joy", "laugh", "happy", "smile", "smirk"],
  smile: ["smile", "happy", "smirk", "joy"],
  laugh: ["laugh", "joy", "happy", "smile"],
  shy: ["shy", "embarrassed", "blush"],
  surprised: ["surprised", "surprise", "shock", "fear"],
  sad: ["sad", "sadness", "pout", "cry"],
  worried: ["worried", "worry", "anxious", "nervous", "sad", "sadness", "thinking"],
  angry: ["angry", "anger", "pout", "disgust", "sad", "surprised", "surprise"],
  thinking: ["thinking", "think", "curious"],
  agree: ["agree", "nod", "yes", "smile", "happy"],
  greet: ["greet", "wave", "hello", "smile", "happy"],
  sleepy: ["sleepy", "doze", "sleep", "tired"],
};

/** a tag word → the vocabulary word (null when it is not an emotion) */
export function normalizeEmotion(word: string): Emotion | null {
  const w = word.trim().toLowerCase();
  if ((EMOTIONS as readonly string[]).includes(w)) return w as Emotion;
  return INPUT_ALIASES[w] ?? null;
}

/** the names a body may know this emotion by, best first (any word: unknown words just match themselves) */
export function emotionCandidates(name: string): string[] {
  const w = name.trim().toLowerCase();
  const canon = normalizeEmotion(w);
  const list = canon ? [w, ...MATCH[canon]] : [w];
  return [...new Set(list)];
}

/** first key of `map` (matched case-insensitively) that names this emotion */
export function lookupEmotion<T>(map: Record<string, T> | undefined, name: string): T | undefined {
  if (!map) return undefined;
  const keys = Object.keys(map);
  for (const c of emotionCandidates(name)) {
    const k = keys.find((key) => key.toLowerCase() === c);
    if (k !== undefined) return map[k];
  }
  return undefined;
}

export interface EmotionTag {
  emotion: Emotion;
  /** 0..1 (1 when not given) */
  intensity: number;
  /** the word as written */
  raw: string;
  /** where the tag stood in the cleaned text */
  index: number;
}

export interface ParsedEmotionText {
  /** the text without tags (for display and speech) */
  text: string;
  tags: EmotionTag[];
  /** the latest tag, or null */
  emotion: Emotion | null;
  intensity: number;
}

const TAG = /\[\s*([A-Za-z_]{2,16})\s*(?::\s*(\d*\.?\d+))?\s*\]/g;
/** an unfinished tag at the very end of a streaming text ("[jo", "[joy:0."): held back until it closes */
const PARTIAL = /\[\s*[A-Za-z_]{0,16}\s*(?::\s*[\d.]*)?\s*$/;

/**
 * Strip emotion tags. With `streaming`, an unfinished tag at the end is hidden too (it shows up once complete or
 * turns out not to be a tag).
 */
export function parseEmotionText(input: string, opts: { streaming?: boolean } = {}): ParsedEmotionText {
  let src = input;
  if (opts.streaming) {
    const m = PARTIAL.exec(src);
    if (m && m[0].length <= 24) src = src.slice(0, m.index);
  }
  const tags: EmotionTag[] = [];
  let out = "";
  let last = 0;
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(src)) !== null) {
    const emotion = normalizeEmotion(m[1]);
    if (!emotion) continue;
    out += src.slice(last, m.index);
    last = m.index + m[0].length;
    // "[joy] Hi" → "Hi", "Oh. [sad] No" → "Oh. No": the space after a tag goes when one is already there
    if (out === "" || /\s$/.test(out)) while (src[last] === " " || src[last] === "\t") last++;
    const n = m[2] !== undefined ? parseFloat(m[2]) : 1;
    tags.push({ emotion, intensity: Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1, raw: m[1], index: out.length });
  }
  out += src.slice(last);
  // a tag that ended the text (or stood alone on the first line) leaves a space / blank line behind
  const text = tags.length ? out.replace(/[ \t]+$/, "").replace(/^\n+/, "") : out;
  const latest = tags[tags.length - 1] ?? null;
  return { text, tags, emotion: latest?.emotion ?? null, intensity: latest?.intensity ?? 1 };
}

/** just the text without tags */
export function stripEmotionTags(input: string, opts: { streaming?: boolean } = {}): string {
  return parseEmotionText(input, opts).text;
}

/**
 * Follows a streaming reply and reports each *new* latest emotion once (for `react`): feed it the whole text so far.
 *
 *   const t = new EmotionTracker();
 *   onDelta(full => { const e = t.push(full); if (e) setReact({ name: e, at: Date.now() }); });
 */
export class EmotionTracker {
  private seen = 0;
  push(full: string): Emotion | null {
    return this.pushTag(full)?.emotion ?? null;
  }
  /** the same, with the tag's intensity */
  pushTag(full: string): EmotionTag | null {
    const { tags } = parseEmotionText(full, { streaming: true });
    if (tags.length < this.seen) this.seen = 0; // the text was replaced
    if (tags.length === this.seen) return null;
    this.seen = tags.length;
    return tags[tags.length - 1];
  }
  reset(): void {
    this.seen = 0;
  }
}

/**
 * Whether a tag in a reply makes the avatar react at this emotion level (mate prefs.emotion, docs/mate-memory-affinity.md
 * §3): 0 off — never; 1 subtle — only a clear feeling (intensity ≥ 0.5), once per reply; 2 / 3 — every tag.
 * `reacted` = reactions this reply already had.
 */
export function reactsAt(level: number, intensity: number, reacted: number): boolean {
  if (level <= 0) return false;
  if (level === 1) return intensity >= 0.5 && reacted === 0;
  return true;
}

/** the emotion a sentence is spoken with at this level (off: neutral voice) */
export const voiceEmotionAt = (level: number, emotion: string | null | undefined): string | undefined =>
  level <= 0 ? undefined : emotion ?? undefined;
