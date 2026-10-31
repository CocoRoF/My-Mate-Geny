/**
 * Split a mate's (streaming) reply into speakable sentences and display bubbles.
 *
 * Ported from Geny `sentenceBoundaryDetector.ts` (accumulating-buffer strategy, short-sentence coalescing that never
 * merges across an emotion cue) and ailism-mate `lines.ts` (one bubble per line, stage directions and markdown
 * emphasis dropped). Korean ends sentences with `요.` `다.` `!` `?` `~` `…`; CJK `。！？` end one without a space.
 */
import { parseEmotionText, type Emotion } from "./emotion";

const TERMINATORS = new Set([".", "!", "?", "…", "~", "～", "。", "！", "？", "‼", "⁉"]);
/** these end a sentence even with no space after them (CJK text has none) */
const CJK_TERMINATORS = new Set(["。", "！", "？"]);
const CLOSERS = new Set(["'", '"', "”", "’", ")", "]", "』", "」", "】", "》", "）"]);
/** "Mr. Kim", "e.g. this": a dot after these words is not the end of a sentence */
const ABBREV = /(?:^|[\s(])(?:mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|no|p|pp|fig|approx)\.$/i;

export interface SentenceOptions {
  /** coalesce sentences shorter than this with the next one (TTS has a fixed cost per clip). Default 0 = off. */
  minChars?: number;
  /** cut a sentence that grows past this many characters at a comma / space (streaming latency). Default 160. */
  maxChars?: number;
  /** a single newline ends a sentence too (chat-style replies: one line = one bubble). Default true. */
  lineBreaks?: boolean;
}

export interface Sentence {
  /** the sentence without emotion tags (for display) */
  text: string;
  /** what to send to TTS: no tags, no markdown, no stage directions ("" = nothing to say) */
  speech: string;
  /** the sentence as it arrived (with tags) */
  raw: string;
  /** the latest emotion tag inside this sentence, or null */
  emotion: Emotion | null;
  intensity: number;
}

/**
 * End offsets (exclusive) of the complete sentences in `text`. With `final`, a terminator at the very end counts;
 * otherwise it waits for what follows ("요." may still become "요...", or get a closing quote).
 */
function boundaries(text: string, final: boolean, lineBreaks: boolean): number[] {
  const out: number[] = [];
  let start = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch === "\n") {
      const blank = /^\n[ \t]*\n/.test(text.slice(i, i + 64));
      if ((lineBreaks || blank) && text.slice(start, i).trim()) {
        out.push(i);
        start = i;
      }
      continue;
    }
    if (!TERMINATORS.has(ch)) continue;
    let j = i;
    let cjk = false;
    while (j < n && TERMINATORS.has(text[j])) {
      if (CJK_TERMINATORS.has(text[j])) cjk = true;
      j++;
    }
    while (j < n && CLOSERS.has(text[j])) j++;
    const piece = text.slice(start, j).trim();
    const atEnd = j >= n;
    const spaced = !atEnd && /\s/.test(text[j]);
    let ok = (atEnd && final) || spaced || (cjk && !atEnd);
    if (ok && ch === ".") {
      // "1. 항목" (a list number), "Mr. Kim": not an end
      if (/^\d{1,3}\.$/.test(piece) || ABBREV.test(text.slice(Math.max(0, i - 8), i + 1))) ok = false;
    }
    if (ok && piece) {
      out.push(j);
      start = j;
    }
    i = j - 1;
  }
  return out;
}

/** a soft cut inside an over-long run: after the last comma-ish mark, else the last space, before `max` */
function softCut(run: string, max: number): number {
  const head = run.slice(0, max);
  const comma = Math.max(
    ...[", ", "，", "、", "; ", ": "].map((p) => {
      const k = head.lastIndexOf(p);
      return k < 0 ? -1 : k + p.length;
    }),
  );
  if (comma > max * 0.3) return comma;
  const space = head.lastIndexOf(" ");
  if (space > max * 0.3) return space + 1;
  return max;
}

/** markdown emphasis / headings / list marks / code / links → their words (chat bubbles draw no markdown) */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]\n]+)\]\((?:[^)\n]*)\)/g, "$1")
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__/g, (_, a?: string, b?: string) => a ?? b ?? "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}(?:[-*+•]|\d{1,3}[.)])\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "");
}

/** a line that is only a stage direction: `(웃음)`, `*smiles*`, `[wink]` (ailism-mate lines.ts STAGE) */
const STAGE = /^(?:\([^()\n]*\)|（[^（）\n]*）|\[[^[\]\n]*\]|\*[^*\n]+\*)$/;

/** what a sentence sounds like: no tags, no markdown, no stage directions, no URLs, no emoji */
export function speakable(text: string): string {
  let s = plainText(parseEmotionText(text).text);
  s = s
    .split("\n")
    .filter((l) => !STAGE.test(l.trim()))
    .join(" ");
  s = s
    .replace(/\*[^*\n]{1,40}\*/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu, " ")
    .replace(/[*_#>|`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // nothing but punctuation is nothing to say
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

function toSentence(raw: string): Sentence {
  const p = parseEmotionText(raw);
  const text = p.text.trim();
  return { text, speech: speakable(text), raw: raw.trim(), emotion: p.emotion, intensity: p.intensity };
}

/** starts with an emotion tag: never glued onto the sentence before (one clip = one emotion) */
const startsWithTag = (raw: string) => {
  const p = parseEmotionText(raw.trimStart());
  return p.tags.length > 0 && p.tags[0].index === 0;
};

/**
 * Follows a streaming reply: feed it the whole text so far with `push`, get the sentences completed since the last
 * call; `flush` at the end of the turn returns the rest.
 */
export class SentenceStream {
  private consumed = 0;
  private prefix = "";
  private holding: string | null = null;
  private readonly minChars: number;
  private readonly maxChars: number;
  private readonly lineBreaks: boolean;

  constructor(opts: SentenceOptions = {}) {
    this.minChars = Math.max(0, opts.minChars ?? 0);
    this.maxChars = Math.max(20, opts.maxChars ?? 160);
    this.lineBreaks = opts.lineBreaks ?? true;
  }

  private take(full: string, final: boolean): string[] {
    if (!full.startsWith(this.prefix)) {
      // the text was replaced (a regenerated reply): start over
      this.consumed = 0;
      this.holding = null;
    }
    const unseen = full.slice(this.consumed);
    const ends = boundaries(unseen, final, this.lineBreaks);
    const pieces: string[] = [];
    let at = 0;
    for (const e of ends) {
      pieces.push(unseen.slice(at, e));
      at = e;
    }
    let rest = unseen.slice(at);
    // an over-long run with no end in sight: cut it at a comma so speech can start
    while (!final && rest.trim().length > this.maxChars) {
      const cut = softCut(rest, this.maxChars);
      pieces.push(rest.slice(0, cut));
      at += cut;
      rest = rest.slice(cut);
    }
    if (final && rest.trim()) {
      pieces.push(rest);
      at = unseen.length;
    }
    this.consumed += at;
    this.prefix = full.slice(0, this.consumed);
    return pieces.filter((p) => p.trim());
  }

  private coalesce(pieces: string[], force: boolean): Sentence[] {
    if (this.minChars <= 0) {
      const all = this.holding ? [this.holding, ...pieces] : pieces;
      this.holding = null;
      return all.map(toSentence).filter((s) => s.text);
    }
    const out: string[] = [];
    let buf = this.holding ?? "";
    for (const p of pieces) {
      if (buf && startsWithTag(p)) {
        out.push(buf);
        buf = "";
      }
      buf = buf ? `${buf.trimEnd()} ${p.trim()}` : p;
      if (parseEmotionText(buf).text.trim().length >= this.minChars) {
        out.push(buf);
        buf = "";
      }
    }
    if (force && buf) {
      out.push(buf);
      buf = "";
    }
    this.holding = buf || null;
    return out.map(toSentence).filter((s) => s.text);
  }

  /** the sentences completed since the last call */
  push(full: string): Sentence[] {
    return this.coalesce(this.take(full, false), false);
  }

  /** end of the turn: everything not returned yet */
  flush(full: string): Sentence[] {
    const out = this.coalesce(this.take(full, true), true);
    this.reset();
    return out;
  }

  reset(): void {
    this.consumed = 0;
    this.prefix = "";
    this.holding = null;
  }
}

/** all sentences of a finished text */
export function splitSentences(text: string, opts: SentenceOptions = {}): Sentence[] {
  return new SentenceStream(opts).flush(text);
}

/**
 * Display bubbles: one per non-empty line (paragraph), tags stripped, markdown emphasis kept as words, stage-only
 * lines dropped. With `streaming`, an unfinished tag at the end is hidden.
 */
export function splitBubbles(text: string, opts: { streaming?: boolean } = {}): string[] {
  const clean = parseEmotionText(text, opts).text;
  const out: string[] = [];
  for (const raw of plainText(clean).split("\n")) {
    const line = raw.trim();
    if (!line || STAGE.test(line)) continue;
    out.push(line);
  }
  return out;
}
