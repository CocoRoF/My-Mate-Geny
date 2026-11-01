/**
 * Split a mate's (streaming) reply into speakable sentences.
 *
 * Ported from Geny `sentenceBoundaryDetector.ts` (accumulating-buffer strategy, short-sentence coalescing that never
 * merges across an emotion cue) and ailism-mate `lines.ts` (one line = one sentence, stage directions dropped).
 * Korean ends sentences with `요.` `다.` `!` `?` `~` `…`; CJK `。！？` end one without a space.
 *
 * Markdown-aware (docs/mate.md §3 "Replies"): the scanner runs over the whole reply as it grows, so a ``` fenced code
 * block or a | table | is one silent piece (never read line by line, nothing said for it); no sentence ends inside a
 * `code span` or a [link](…) (a dot in a URL or label is not an end); what a sentence says has no markdown, URLs,
 * emoji or stage directions (markdown.ts speechText), what it shows (captions) no markdown.
 *
 * Deterministic: the sentences of a reply depend only on its text, never on how it arrived — every window follows the
 * same reply and the one voice is handed over by sentence index (voiceOwner.ts). The scanner only decides what it can
 * decide for good (an unclosed fence, link, code span or a table's next line waits for more text), and an over-long
 * run is cut exactly where char-by-char streaming would cut it.
 */
import { parseEmotionText, type Emotion } from "./emotion.ts";
import { closesFence, fenceOf, plainText, speechText, startsTable } from "./markdown.ts";

export { plainText } from "./markdown.ts";

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
  /** the sentence as shown (captions): no emotion tags, no markdown */
  text: string;
  /** what to send to TTS: no tags, no markdown, no stage directions, no URLs, no emoji ("" = nothing to say) */
  speech: string;
  /** the sentence as it arrived (with tags and markdown) */
  raw: string;
  /** the latest emotion tag inside this sentence, or null */
  emotion: Emotion | null;
  intensity: number;
}

/** a piece of the reply: a sentence (or a run cut for length), or a silent block (code, table) */
interface Piece {
  text: string;
  silent: boolean;
}

type Found = { end: number; silent: boolean } | { pending: "block" | "text"; open?: boolean };

const lineEnd = (text: string, from: number) => {
  const k = text.indexOf("\n", from);
  return k < 0 ? text.length : k;
};

/**
 * A fenced code block or a table starting on the line at `ls`: its end (exclusive — the newline after its last line,
 * or the end of the text), "pending" (it may be one: wait for more text), "open" (it is one, still being written), or
 * null.
 *
 * A table for the voice starts with a pipe (`| a | b |` + a delimiter row; its rows are the lines that start with a
 * pipe): decided from the line's first character, so a sentence is never said and later found to be a table header.
 */
function blockAt(text: string, ls: number, final: boolean): number | "pending" | "open" | null {
  const n = text.length;
  if (ls >= n) return null;
  // (any indentation: a fence or a table inside a list item is indented)
  let k = ls;
  while (k < n && (text[k] === " " || text[k] === "\t")) k++;
  if (k >= n) return final ? null : "pending";
  const c = text[k];
  if (c !== "`" && c !== "~" && c !== "|") return null;
  const eol = lineEnd(text, ls);
  const complete = eol < n || final;
  if (c === "|") {
    if (!complete) return "pending";
    if (eol >= n) return null;
    const e2 = lineEnd(text, eol + 1);
    if (e2 >= n && !final) return "pending";
    if (!startsTable(text.slice(ls, eol), text.slice(eol + 1, e2))) return null;
    let end = e2;
    while (end < n) {
      const s = end + 1;
      let q = s;
      while (q < n && (text[q] === " " || text[q] === "\t")) q++;
      if (q >= n) {
        if (final) break;
        return "open";
      }
      if (text[q] !== "|") break;
      const e = lineEnd(text, s);
      if (e >= n && !final) return "open";
      end = e;
    }
    return end;
  }
  let j = k;
  while (text[j] === c) j++;
  if (j - k < 3) return j >= n && !final ? "pending" : null;
  if (!complete) return "pending";
  const f = fenceOf(text.slice(ls, eol));
  if (!f) return null;
  let s = eol + 1;
  while (s <= n) {
    if (s === n) return final ? n : "open";
    const e = lineEnd(text, s);
    if (closesFence(text.slice(s, e), f.marker)) return e >= n && !final ? "open" : e;
    if (e >= n) return final ? n : "open";
    s = e + 1;
  }
  return final ? n : "open";
}

/** with lineBreaks off: a line that starts a block still breaks the sentence before it */
const startsBlock = (text: string, ls: number) => /^ {0,3}(?:```|~~~|\|)/.test(text.slice(ls, ls + 8));

/** the ) that closes the ( at `open` on this line (nested parens count), or -1 */
function closeParen(text: string, open: number, eol: number): number {
  let depth = 0;
  for (let k = open; k < eol; k++) {
    if (text[k] === "\\") {
      k++;
      continue;
    }
    if (text[k] === "(") depth++;
    else if (text[k] === ")" && --depth === 0) return k;
  }
  return -1;
}

/**
 * The first piece of `text` starting at `from`. With `final`, the end of the text decides what is still open;
 * otherwise anything that more text could change waits ({pending}): "block" (a fence / table maybe — never cut),
 * "text" (no end yet — an over-long run may be cut).
 */
function firstPiece(text: string, from: number, final: boolean, lineBreaks: boolean): Found {
  const n = text.length;
  if (from === 0 || text[from - 1] === "\n") {
    const b = blockAt(text, from, final);
    if (b === "pending" || b === "open") return { pending: "block", open: b === "open" };
    if (b !== null) return { end: b, silent: true };
  }
  for (let i = from; i < n; i++) {
    const ch = text[i];
    if (ch === "\n") {
      const before = text.slice(from, i).trim();
      if (before) {
        if (lineBreaks || /^\n[ \t]*\n/.test(text.slice(i, i + 64)) || startsBlock(text, i + 1)) return { end: i, silent: false };
        continue;
      }
      const b = blockAt(text, i + 1, final);
      if (b === "pending" || b === "open") return { pending: "block", open: b === "open" };
      if (b !== null) return { end: b, silent: true };
      continue;
    }
    if (ch === "\\" && (text[i + 1] === "`" || text[i + 1] === "[")) {
      i++;
      continue;
    }
    if (ch === "`") {
      // a code span: no sentence ends inside it
      let j = i;
      while (text[j] === "`") j++;
      if (j >= n && !final) return { pending: "text" };
      const run = j - i;
      const eol = lineEnd(text, j);
      let close = -1;
      for (let k = j; k < eol; ) {
        if (text[k] !== "`") {
          k++;
          continue;
        }
        let e = k;
        while (text[e] === "`") e++;
        if (e - k === run) {
          close = e;
          break;
        }
        k = e;
      }
      if (close >= 0) {
        i = close - 1;
        continue;
      }
      if (eol >= n && !final) return { pending: "text" };
      i = j - 1;
      continue;
    }
    if (ch === "[") {
      // a [link](…): no sentence ends in its label or URL
      const eol = lineEnd(text, i);
      const close = text.indexOf("]", i + 1);
      if (close < 0 || close >= eol) {
        if (eol >= n && !final && eol - i < 300) return { pending: "text" };
        continue;
      }
      if (close + 1 >= n) {
        if (!final) return { pending: "text" };
        continue;
      }
      if (text[close + 1] !== "(") continue;
      const paren = closeParen(text, close + 1, eol);
      if (paren >= 0) {
        i = paren;
        continue;
      }
      if (eol >= n && !final && eol - i < 2000) return { pending: "text" };
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
    const piece = text.slice(from, j).trim();
    const atEnd = j >= n;
    const spaced = !atEnd && /\s/.test(text[j]);
    let ok = (atEnd && final) || spaced || (cjk && !atEnd);
    if (ok && ch === ".") {
      // "1. 항목" (a list number), "Mr. Kim": not an end
      if (/^\d{1,3}\.$/.test(piece) || ABBREV.test(text.slice(Math.max(from, i - 8), i + 1))) ok = false;
    }
    if (ok && piece) return { end: j, silent: false };
    i = j - 1;
  }
  return { pending: "text" };
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
  let cut = max;
  if (comma > max * 0.3) cut = comma;
  else {
    const space = head.lastIndexOf(" ");
    if (space > max * 0.3) cut = space + 1;
  }
  // never in the middle of a URL when there are words before it: cut before it (it is not said anyway)
  if (/\S/.test(run[cut] ?? "")) {
    const frag = /\S*$/.exec(run.slice(0, cut))![0];
    const start = cut - frag.length;
    if (frag && URLISH.test(frag) && run.slice(0, start).trim()) cut = start;
  }
  return cut;
}

const URLISH = /(?:https?:\/\/|www\.)\S*$/i;

/** the first L with text.slice(p, L).trim().length > max (the moment streaming would cut), or -1 */
function overLimit(text: string, p: number, max: number): number {
  let s = p;
  while (s < text.length && /\s/.test(text[s])) s++;
  for (let k = s + max; k < text.length; k++) if (!/\s/.test(text[k])) return k + 1;
  return -1;
}

/** what a sentence sounds like: no tags, no markdown, no stage directions, no URLs, no emoji */
export function speakable(text: string): string {
  return speechText(parseEmotionText(text).text);
}

/**
 * One sentence from one or more pieces (short ones coalesced): each piece is cleaned on its own (a list mark or a
 * quote mark only means something at the start of its line), then the words are joined.
 */
function toSentence(raws: string[]): Sentence {
  const raw = raws.map((r) => r.trim()).join(" ");
  const p = parseEmotionText(raw);
  const parts = raws.map((r) => parseEmotionText(r).text);
  const join = (xs: string[]) => xs.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
  return { text: join(parts.map((x) => plainText(x))), speech: join(parts.map(speechText)), raw, emotion: p.emotion, intensity: p.intensity };
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
  private holding: string[] | null = null;
  private urlTail = false;
  private readonly minChars: number;
  private readonly maxChars: number;
  private readonly lineBreaks: boolean;

  constructor(opts: SentenceOptions = {}) {
    this.minChars = Math.max(0, opts.minChars ?? 0);
    this.maxChars = Math.max(20, opts.maxChars ?? 160);
    this.lineBreaks = opts.lineBreaks ?? true;
  }

  /**
   * A piece as it goes on: one that starts in the middle of a URL (the run before it was cut inside a URL that began
   * the run — nothing before it to cut at) loses that URL's tail, which no longer looks like a URL.
   */
  private piece(text: string, silent: boolean, cutInWord: boolean): Piece {
    let t = text;
    const tail = this.urlTail;
    if (tail) t = t.replace(/^\S+/, "");
    this.urlTail = cutInWord && (URLISH.test(text) || (tail && !/\s/.test(text)));
    return { text: t, silent };
  }

  private take(full: string, final: boolean): Piece[] {
    if (!full.startsWith(this.prefix)) {
      // the text was replaced (a regenerated reply): start over
      this.consumed = 0;
      this.holding = null;
      this.urlTail = false;
    }
    const pieces: Piece[] = [];
    let p = this.consumed;
    const n = full.length;
    while (p < n) {
      // Where streaming char by char would have cut this run for length: decide on the text up to that moment, so
      // the result is the same however the text arrived. A block (code, table) is never cut.
      const at = overLimit(full, p, this.maxChars);
      let r: Found | null = null;
      if (at >= 0) {
        r = firstPiece(full.slice(0, at), p, false, this.lineBreaks);
        if ("pending" in r) {
          if (r.pending === "text") {
            const cut = softCut(full.slice(p), this.maxChars);
            pieces.push(this.piece(full.slice(p, p + cut), false, /\S/.test(full[p + cut] ?? "")));
            p += cut;
            continue;
          }
          r = null;
        }
      }
      if (!r) r = firstPiece(full, p, final, this.lineBreaks);
      if ("pending" in r) {
        if (final) {
          pieces.push(this.piece(full.slice(p), false, false));
          p = n;
        } else if (r.open) {
          // a code block / table being written: what is held for coalescing is said now (as it will be once the
          // block is complete — the same sentences either way)
          pieces.push({ text: "", silent: true });
        }
        break;
      }
      pieces.push(this.piece(full.slice(p, r.end), r.silent, false));
      p = r.end;
    }
    this.consumed = p;
    this.prefix = full.slice(0, p);
    return pieces.filter((x) => x.silent || x.text.trim());
  }

  private coalesce(pieces: Piece[], force: boolean): Sentence[] {
    const out: string[][] = [];
    let buf: string[] = this.holding ?? [];
    // (the length of the pieces joined by a space, tags left out — as it always was)
    const size = (xs: string[]) => parseEmotionText(xs.map((x) => x.trim()).join(" ")).text.trim().length;
    for (const piece of pieces) {
      if (piece.silent) {
        // (what was said before a code block is said now, not after it)
        if (buf.length) out.push(buf);
        buf = [];
        continue;
      }
      const p = piece.text;
      if (this.minChars <= 0) {
        out.push([p]);
        continue;
      }
      if (buf.length && startsWithTag(p)) {
        out.push(buf);
        buf = [];
      }
      buf = [...buf, p];
      if (size(buf) >= this.minChars) {
        out.push(buf);
        buf = [];
      }
    }
    if (force && buf.length) {
      out.push(buf);
      buf = [];
    }
    this.holding = buf.length ? buf : null;
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
    this.urlTail = false;
  }
}

/** all sentences of a finished text */
export function splitSentences(text: string, opts: SentenceOptions = {}): Sentence[] {
  return new SentenceStream(opts).flush(text);
}

/**
 * Display lines as plain text (the avatar lab): one per conversational line or block, tags stripped, no markdown.
 * (The conversation itself renders markdown: components/mate/MateReply.tsx with markdown.ts segmentReply.)
 */
export function splitBubbles(text: string, opts: { streaming?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const line of plainText(parseEmotionText(text, opts).text).split("\n")) {
    const l = line.trim();
    if (l && !/^(?:\([^()\n]*\)|（[^（）\n]*）|\[[^[\]\n]*\]|\*[^*\n]+\*)$/.test(l)) out.push(l);
  }
  return out;
}
