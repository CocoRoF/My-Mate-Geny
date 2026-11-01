/**
 * Markdown in a mate's replies (docs/mate.md §3 "Replies: bubbles, captions, speech"). Pure functions, no React, so
 * node's test runner checks them as they are (test/mate-markdown.test.ts).
 *
 *   segmentReply(text, { streaming })  the reply as display blocks: one bubble per conversational line (light inline
 *                                      markdown), one bubble per block construct (code, list, table, quote, heading,
 *                                      image) rendered as markdown; emotion tags and stage-direction lines dropped;
 *                                      while streaming nothing half-typed shows as raw markdown
 *   plainText(md) / plainPreview(md)   the words without markdown (captions, notifications)
 *   speechText(md)                     what the voice says (also no URLs, emoji, stage directions)
 *   safeHref(url) / imageSource(url)   the only links / images a reply may carry
 *
 * The block grammar is a deliberately small, line-based subset of CommonMark/GFM (what chat replies use). The voice's
 * sentence scanner (sentences.ts) shares the fence / table rules below.
 */
import { normalizeEmotion } from "./emotion.ts";

// ── block syntax ────────────────────────────────────────────────────────

export interface Fence {
  indent: number;
  /** ``` / ~~~ (3 or more) */
  marker: string;
  info: string;
}

/**
 * A fence line: indentation (any: a fence inside a list item is indented), 3+ backticks or tildes, an info string.
 * Backtick fences: no backtick in the info (CommonMark). Tilde fences: one word or nothing — Korean chat writes
 * "~~~ 그렇구나", which stays text.
 */
export function fenceOf(line: string): Fence | null {
  const m = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const info = m[3].trim();
  if (m[2][0] === "`" ? m[3].includes("`") : !/^[\w+#.-]*$/.test(info)) return null;
  return { indent: m[1].length, marker: m[2], info };
}

/** the line that ends a fence opened with `marker` */
export function closesFence(line: string, marker: string): boolean {
  const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1][0] === marker[0] && m[1].length >= marker.length;
}

const DELIM_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
/** a table's second line: `|---|:--:|` (at least one pipe) */
export const isDelimiterRow = (line: string) => line.includes("|") && DELIM_ROW.test(line);

/** the cells of a table row */
function cellCount(line: string): number {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).length;
}

/** a header line + its delimiter row (as many cells as the header: GFM) start a table */
export const startsTable = (header: string, delim: string | undefined) =>
  delim !== undefined && header.includes("|") && isDelimiterRow(delim) && cellCount(delim) === cellCount(header);

const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const QUOTE = /^ {0,3}>/;
/** -, *, + or 1. / 1) (up to 3 digits: "2024. 좋은 해" is a sentence, not a list) */
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,3}[.)])(?:[ \t]+|$)/;
const IMAGE_LINE = /^[ \t]*!\[[^\]\n]*\]\([^)\n]*\)[ \t]*$/;
/** a bubble that is only a stage direction: `(웃음)`, `（웃음）`, `*smiles*` (ailism-mate lines.ts) */
const STAGE_LINE = /^(?:\([^()]*\)|（[^（）]*）|\*[^*]+\*)$/;

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length;
const blank = (line: string) => !line.trim();

// ── emotion tags (outside code) ─────────────────────────────────────────

const TAG = /\[\s*([A-Za-z_]{2,16})\s*(?::\s*(\d*\.?\d+))?\s*\]/g;
/** an unfinished tag at the very end of a streaming text ("[jo", "[joy:0.") — hidden until it closes */
const PARTIAL_TAG = /\[\s*[A-Za-z_]{0,16}\s*(?::\s*[\d.]*)?\s*$/;

/** [start, end) of each `code span` in a line (CommonMark: a backtick run closed by a run of the same length) */
export function codeSpans(line: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\\" && line[i + 1] === "`") {
      i += 2;
      continue;
    }
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (line[j] === "`") j++;
    const run = j - i;
    let k = j;
    let end = -1;
    while (k < line.length) {
      if (line[k] !== "`") {
        k++;
        continue;
      }
      let e = k;
      while (line[e] === "`") e++;
      if (e - k === run) {
        end = e;
        break;
      }
      k = e;
    }
    if (end < 0) {
      i = j;
      continue;
    }
    out.push([i, end]);
    i = end;
  }
  return out;
}

/** strip emotion tags from a line, not inside `code`; `partial`: also hide an unfinished tag at its end */
function stripTags(line: string, partial: boolean): string {
  if (!line.includes("[")) return line;
  let out = "";
  let removed = false;
  const gap = (s: string, last: boolean) => {
    let prev = 0;
    TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG.exec(s)) !== null) {
      if (!normalizeEmotion(m[1])) continue;
      out += s.slice(prev, m.index);
      prev = m.index + m[0].length;
      removed = true;
      // "[joy] Hi" → "Hi", "Oh. [sad] No" → "Oh. No", "- [joy] yes" → "- yes" (parseEmotionText's rule)
      if (out === "" || /\s$/.test(out)) while (s[prev] === " " || s[prev] === "\t") prev++;
    }
    let rest = s.slice(prev);
    if (last && partial) {
      const p = PARTIAL_TAG.exec(rest);
      if (p && p[0].length <= 24) {
        rest = rest.slice(0, p.index);
        removed = true;
      }
    }
    out += rest;
  };
  let at = 0;
  for (const [a, b] of codeSpans(line)) {
    gap(line.slice(at, a), false);
    out += line.slice(a, b);
    at = b;
  }
  gap(line.slice(at), true);
  return removed ? out.replace(/[ \t]+$/, "") : out;
}

// ── display blocks ──────────────────────────────────────────────────────

export type BlockType = "code" | "list" | "table" | "quote" | "heading" | "image" | "rule";

export interface MateBlock {
  /** stable while the reply grows (the block's first line): bubbles don't remount as text streams in */
  key: string;
  /** text: a conversational line (inline markdown only) · md: a block construct · rule: a divider */
  kind: "text" | "md" | "rule";
  type?: BlockType;
  /** the markdown to render */
  md: string;
  /** code: the fence's language */
  lang?: string;
  /** still being written (streaming: an unclosed fence, the last block) */
  open?: boolean;
}

/** a conversational line rendered with inline markdown only: leading block syntax stays literal */
function escapeLine(line: string): string {
  // (lists, headings, quotes and fences were taken as blocks already; what is left that CommonMark would still read
  // as a block: a long ordered-list number, a tilde fence with words after it)
  return line
    .replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2") // "2024. 좋은 해" is not an ordered list starting at 2024
    .replace(/^~~~/, "\\~~~"); // "~~~ 그렇구나" is not a code block
}

/** the end of a line still being written: auto-close `code`, **bold**, *italic*; a half-written link shows its label */
export function closeInline(line: string): string {
  let s = line;
  // an unmatched backtick run: the rest of the line is a code span being written (closed for now), or, with nothing
  // after it yet, hidden
  const spans = codeSpans(s);
  const inSpan = (i: number) => spans.some(([a, b]) => i >= a && i < b);
  let openCode = -1;
  let openRun = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] !== "`" || inSpan(i)) continue;
    let j = i;
    while (s[j] === "`") j++;
    openCode = i;
    openRun = j - i;
    break;
  }
  let code = "";
  if (openCode >= 0) {
    const body = s.slice(openCode + openRun);
    code = body.trim() ? "`".repeat(openRun) + body + "`".repeat(openRun) : "";
    s = s.slice(0, openCode);
  }
  // a link / image being written at the end: the label as plain text (an image: nothing) until it is complete
  s = s.replace(/(!?)\[([^[\]\n]*)(?:\](?:\([^)\n]*)?)?$/, (_m, bang: string, label: string) => (bang ? "" : label));
  s = closeEmphasis(s);
  return code ? s + code : s;
}

const isWs = (c: string | undefined) => c === undefined || /\s/.test(c);
const isPunct = (c: string | undefined) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

/** close the * / ** / _ / __ still open at the end of a growing line; a run just typed at the very end is hidden */
function closeEmphasis(line: string): string {
  let s = line;
  const spans = codeSpans(s);
  const stack: { ch: string; len: number; at: number; end: number }[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    const span = spans.find(([a]) => a === i);
    if (span) {
      i = span[1];
      continue;
    }
    if (c !== "*" && c !== "_") {
      i++;
      continue;
    }
    let j = i;
    while (s[j] === c) j++;
    const len = j - i;
    const before = s[i - 1];
    const after = s[j];
    const left = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
    const right = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
    let canOpen = left;
    let canClose = right;
    if (c === "_") {
      canOpen = left && (!right || isPunct(before));
      canClose = right && (!left || isPunct(after));
    }
    const top = stack[stack.length - 1];
    if (canClose && top && top.ch === c) {
      let rem = len;
      while (rem > 0 && stack.length && stack[stack.length - 1].ch === c) {
        const t = stack[stack.length - 1];
        if (t.len <= rem) {
          rem -= t.len;
          stack.pop();
        } else {
          t.len -= rem;
          rem = 0;
        }
      }
    } else if (j >= s.length) {
      // just typed, nothing after it yet: hide it (it opens or closes something once the next character comes)
      s = s.slice(0, i);
      break;
    } else if (canOpen) {
      stack.push({ ch: c, len: Math.min(len, 3), at: i, end: j });
    }
    i = j;
  }
  // still open at the end: close it (an opener with nothing after it goes)
  let tail = "";
  for (let k = stack.length - 1; k >= 0; k--) {
    const o = stack[k];
    if (!s.slice(o.end).trim()) s = s.slice(0, o.at) + s.slice(o.end);
    else tail += o.ch.repeat(o.len);
  }
  return tail ? s.trimEnd() + tail : s;
}

/** a line has something to show besides markdown punctuation ("-", "#", "**", "|", "1.", "- [x]" alone: not yet) */
const hasContent = (line: string) =>
  /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(plainInline(line.replace(/^[ \t]*(?:[-*+>#|]+|\d+[.)])(?:[ \t]*\[[ xX]?\]?(?=[ \t]*$))?/, "")));

/**
 * The reply as display blocks. Plain lines keep the chat feel (a bubble each, light inline formatting); block
 * constructs stay together in one bubble rendered as markdown. `streaming`: the text is still growing — an unclosed
 * fence is a code block in progress, a half-typed marker / link / tag / table row is hidden until it is complete.
 */
export function segmentReply(input: string, opts: { streaming?: boolean } = {}): MateBlock[] {
  const streaming = !!opts.streaming;
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const n = lines.length;
  const lastLine = n - 1;
  const out: MateBlock[] = [];
  /** tags stripped (outside code); the text's very last line also loses an unfinished tag */
  const clean = (k: number) => stripTags(lines[k], streaming && k === lastLine);

  let i = 0;
  while (i < n) {
    const raw = lines[i];
    if (blank(raw)) {
      i++;
      continue;
    }
    // ``` fenced code ```
    const f = fenceOf(raw);
    if (f) {
      // the opening line still being typed ("```py"): nothing yet (no language label flickering as it grows)
      if (streaming && i === lastLine) break;
      let j = i + 1;
      let closed = false;
      for (; j < n; j++) {
        if (closesFence(lines[j], f.marker)) {
          closed = true;
          break;
        }
      }
      const body = lines.slice(i + 1, closed ? j : n);
      // the closing fence being typed ("`", "``" on the last line) is not code
      if (!closed && streaming && body.length && /^ {0,3}[`~]{1,}[ \t]*$/.test(body[body.length - 1])) body.pop();
      const strip = new RegExp(`^[ \\t]{0,${f.indent}}`);
      const md = [f.marker + f.info, ...body.map((l) => l.replace(strip, "")), f.marker].join("\n");
      const lang = f.info.split(/\s+/)[0] || undefined;
      out.push({ key: `L${i}`, kind: "md", type: "code", md, lang, open: !closed && streaming });
      i = closed ? j + 1 : n;
      continue;
    }
    // | table |
    if (raw.includes("|")) {
      const next = lines[i + 1];
      const lastIsPartial = (k: number) => streaming && k === lastLine;
      if (startsTable(raw, next)) {
        let j = i + 2;
        while (j < n && !blank(lines[j]) && lines[j].includes("|") && !fenceOf(lines[j])) j++;
        // a row still arriving is left out until its line is complete
        const end = j - 1 === lastLine && lastIsPartial(lastLine) && j - 1 > i + 1 ? j - 1 : j;
        const rows: string[] = [];
        for (let k = i; k < end; k++) rows.push(k < i + 2 ? lines[k] : clean(k));
        out.push({ key: `L${i}`, kind: "md", type: "table", md: rows.join("\n"), open: streaming && j >= n });
        i = j;
        continue;
      }
      // a header whose delimiter row hasn't come yet: wait (no "| a | b |" flashing as text)
      if (streaming && /^\s*\|/.test(raw) && (i === lastLine || (i + 1 === lastLine && /^[ \t|:-]*$/.test(next ?? "")))) break;
    }
    // --- a rule ---
    if (HR.test(raw)) {
      out.push({ key: `L${i}`, kind: "rule", type: "rule", md: "---" });
      i++;
      continue;
    }
    // # heading
    if (HEADING.test(raw)) {
      out.push({ key: `L${i}`, kind: "md", type: "heading", md: clean(i).trim() });
      i++;
      continue;
    }
    // - lists (nested, ordered, tasks), with their indented continuation lines and code
    if (LIST_ITEM.test(raw)) {
      const base = indentOf(raw);
      let j = i + 1;
      let fence: Fence | null = null;
      while (j < n) {
        const l = lines[j];
        if (fence) {
          if (closesFence(l.trimStart(), fence.marker)) fence = null;
          j++;
          continue;
        }
        if (blank(l)) {
          let k = j + 1;
          while (k < n && blank(lines[k])) k++;
          if (k < n && (LIST_ITEM.test(lines[k]) || indentOf(lines[k]) > base + 1)) {
            j = k;
            continue;
          }
          break;
        }
        if (LIST_ITEM.test(l) || indentOf(l) > base) {
          fence = fenceOf(l.trimStart());
          j++;
          continue;
        }
        break;
      }
      const md = lines.slice(i, j).map((_, d) => clean(i + d)).join("\n");
      out.push({ key: `L${i}`, kind: "md", type: "list", md, open: streaming && j >= n });
      i = j;
      continue;
    }
    // > quote
    if (QUOTE.test(raw)) {
      let j = i + 1;
      while (j < n && QUOTE.test(lines[j])) j++;
      const md = lines.slice(i, j).map((_, d) => clean(i + d)).join("\n");
      out.push({ key: `L${i}`, kind: "md", type: "quote", md, open: streaming && j >= n });
      i = j;
      continue;
    }
    // ![image](…) on a line of its own
    if (IMAGE_LINE.test(raw)) {
      out.push({ key: `L${i}`, kind: "md", type: "image", md: raw.trim() });
      i++;
      continue;
    }
    // a conversational line
    const line = clean(i).trim();
    if (line && !STAGE_LINE.test(line)) out.push({ key: `L${i}`, kind: "text", md: escapeLine(line), open: streaming && i === lastLine });
    i++;
  }

  // streaming: the end of the last block is still being typed
  const last = out[out.length - 1];
  if (streaming && last && last.type !== "code" && last.kind !== "rule" && last.type !== "table" && last.type !== "image") {
    const ls = last.md.split("\n");
    const tail = closeInline(ls[ls.length - 1]);
    if (hasContent(tail)) ls[ls.length - 1] = tail;
    else ls.pop();
    if (ls.some((l) => hasContent(l))) last.md = ls.join("\n");
    else out.pop();
  }
  return out;
}

// ── plain text ──────────────────────────────────────────────────────────

const HOLE = "\u0001";

/** inline markdown → its words (`plain`) or what is said (`speech`: also no stage directions, URLs, emoji) */
function inlineText(input: string, speech: boolean): string {
  let s = input;
  // code spans → their words, kept away from the rules below
  const codes: string[] = [];
  const spans = codeSpans(s);
  if (spans.length) {
    let r = "";
    let at = 0;
    for (const [a, b] of spans) {
      const inner = s.slice(a, b).replace(/^`+|`+$/g, "");
      codes.push(inner.trim() ? inner.trim() : inner);
      r += s.slice(at, a) + HOLE + (codes.length - 1) + HOLE;
      at = b;
    }
    s = r + s.slice(at);
  }
  s = s
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style|iframe|object|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<((?:https?|mailto):[^<>\s]*)>/gi, speech ? " " : "$1") // <https://…> autolinks
    .replace(/<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g, " ") // html tags (their text stays)
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)?/g, " ") // images (and one being written)
    .replace(/\[([^[\]\n]*)\]\([^)\n]*\)?/g, "$1") // [label](url) → label
    .replace(/\[([^[\]\n]+)\]\[[^[\]\n]*\]/g, "$1") // [label][ref]
    .replace(/\[\^[^[\]\n]*\]/g, "") // footnote marks
    .replace(/\]\([^)\s]*\)?/g, " ") // the tail of a link split across sentences: "](https://…)"
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    .replace(/__(?=\S)([^\n]*?\S)__(?!\w)/g, "$1");
  // *smiles*: a stage direction, not said (ailism-mate) — not the stars of a ** split from its partner
  if (speech) s = s.replace(/(?<!\*)\*(?=\S)[^*\n]{0,39}(?<=\S)\*(?!\*)/g, " ");
  s = s
    .replace(/(^|[^\w*\\])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w\\])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    // what is left of a marker split from its partner (a sentence ended inside **bold**)
    .replace(/\*{2,}|(?<=^|\s)\*(?=\S)|(?<=\S)\*(?=\s|$)/g, "")
    .replace(/(?<=^|\s)_{1,2}(?=\S)|(?<=\S)_{1,2}(?=\s|$)/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, "$1");
  s = unmatchedBrackets(s);
  if (codes.length) s = s.replace(new RegExp(`${HOLE}(\\d+)${HOLE}`, "g"), (_m, k: string) => codes[Number(k)] ?? "");
  if (speech) {
    s = s
      .replace(/\bhttps?:\/\/\S+|\bwww\.[^\s<>]+\.[^\s<>]+/gi, " ")
      .replace(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*|[\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}️⃣]/gu, " ")
      .replace(/[*_#>|`[\]]/g, " ");
  }
  return s.replace(/`/g, "");
}

/** drop a [ or ] that has no partner on its line (a link cut in two) */
function unmatchedBrackets(s: string): string {
  if (!/[[\]]/.test(s)) return s;
  const open: number[] = [];
  const drop = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "[") open.push(i);
    else if (s[i] === "]") {
      if (open.length) open.pop();
      else drop.add(i);
    } else if (s[i] === "\n") {
      for (const k of open) drop.add(k);
      open.length = 0;
    }
  }
  for (const k of open) drop.add(k);
  if (!drop.size) return s;
  return [...s].map((c, i) => (drop.has(i) ? "" : c)).join("");
}

/** inline markdown → its words */
export const plainInline = (s: string) => inlineText(s, false);

/**
 * The words of a reply (or a part of one) without markdown: code blocks and tables go, headings / list marks / quote
 * marks / checkboxes go, emphasis, code and links become their words. Emotion tags are the caller's business.
 */
export function plainText(text: string, opts: { speech?: boolean } = {}): string {
  const speech = !!opts.speech;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const f = fenceOf(line);
    if (f) {
      let j = i + 1;
      while (j < lines.length && !closesFence(lines[j], f.marker)) j++;
      i = j;
      continue;
    }
    if (startsTable(line, lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && !blank(lines[j]) && lines[j].includes("|")) j++;
      i = j - 1;
      continue;
    }
    if (isDelimiterRow(line) || HR.test(line)) continue;
    line = line
      .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, "")
      .replace(/[ \t]+#+[ \t]*$/, "")
      .replace(/^[ \t]*(?:>[ \t]?)+/, "")
      .replace(/^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+/, "")
      .replace(/^[ \t]*\[[ xX]\][ \t]+/, "");
    // a table row on its own (no delimiter): its cells
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.replace(/^\s*\||\|\s*$/g, "").replace(/\s*\|\s*/g, "  ");
    out.push(inlineText(line, speech));
  }
  return out.join("\n");
}

/** one line of plain text for a notification / preview: the first line with words, cut to `max` */
export function plainPreview(text: string, max = 160): string {
  const line = plainText(text).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find((l) => l) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** a line that is only a stage direction: `(웃음)`, `*smiles*`, `[wink]` (ailism-mate lines.ts STAGE) */
const STAGE = /^(?:\([^()\n]*\)|（[^（）\n]*）|\[[^[\]\n]*\]|\*[^*\n]+\*)$/;

/** what is said: the words (no markdown), without stage directions, URLs and emoji; "" = nothing to say */
export function speechText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !STAGE.test(l.trim().replace(/^(?:[-*+•]|\d{1,3}[.)]|>)\s+/, "")));
  const s = plainText(lines.join("\n"), { speech: true }).replace(/\s+/g, " ").trim();
  // nothing but punctuation is nothing to say
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

/** the text without fenced code (an unclosed fence: to the end) — emotion tags in code are not feelings */
export function withoutCode(text: string): string {
  if (!text.includes("```") && !text.includes("~~~")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const f = fenceOf(lines[i]);
    if (!f) {
      out.push(lines[i]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !closesFence(lines[j], f.marker)) j++;
    out.push("");
    i = j;
  }
  return out.join("\n");
}

// ── links and images ────────────────────────────────────────────────────

/**
 * The only links a reply may carry: absolute http(s) and mailto. Everything else — javascript:, data:, vbscript:,
 * file:, blob:, relative and protocol-relative URLs, schemes hidden behind control characters or entities (the URL
 * parser removes tabs / newlines, so "java\tscript:" is caught) — is no link (null).
 */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const s = url.trim();
  if (!s || s.length > 4096) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol === "http:" || u.protocol === "https:") return u.username || u.password ? null : u.href;
  if (u.protocol === "mailto:") return u.href;
  return null;
}

/** this server's files a reply may show at once: a mate's assets, a chat's attachments (GETs without side effects) */
const OWN_FILES = /^\/api\/(?:mates\/[^/]+\/assets|sessions\/[^/]+\/attachments)\//;

/**
 * Where an image may come from, and whether it loads at once (`ask: false`: this server's own files — a mate's assets,
 * a chat's attachments) or only when the user asks (`ask: true`: any other URL — a remote image tells its host that
 * the reply was read and from where, which a prompt-injected reply could abuse to leak data through the URL; another
 * path of this server could be a request with side effects). Only http(s): data:, blob:, javascript:, file: are no
 * image (null).
 */
export function imageSource(src: string | null | undefined, origin: string): { src: string; ask: boolean; host: string } | null {
  if (typeof src !== "string") return null;
  const s = src.trim();
  if (!s || s.length > 4096) return null;
  let u: URL;
  try {
    // (a path is relative to this server; "//host/x" is another host)
    u = /^[a-z][a-z\d+.-]*:/i.test(s) || s.startsWith("//") ? new URL(s, origin) : new URL(s.startsWith("/") ? s : `/${s}`, origin);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const own = u.origin === new URL(origin).origin && OWN_FILES.test(u.pathname) && !/\.\.|%2e%2e/i.test(u.pathname);
  return { src: u.href, ask: !own, host: u.host };
}
