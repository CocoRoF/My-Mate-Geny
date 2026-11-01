// What the mate's voice says (src/mate/sentences.ts SentenceStream + src/mate/markdown.ts speechText): markdown-aware
// across the whole streaming reply — code and tables are never read, no symbols, no URLs — deterministic however the
// text is chunked (every window numbers sentences the same), and plain chat exactly as before (compared with the
// previous implementation, test/fixtures/sentences-v1.ts).   Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceStream, speakable, splitSentences, type Sentence } from "../src/mate/sentences.ts";
import * as v1 from "./fixtures/sentences-v1.ts";

/** a seeded PRNG (mulberry32): random chunkings that are the same on every run */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Stream = { push(t: string): Sentence[]; flush(t: string): Sentence[] };
/** feed `text` in chunks (sizes from `sizes`), then flush, like useMateConversation follows a reply */
function streamed(make: () => Stream, text: string, sizes: () => number): Sentence[] {
  const s = make();
  const out: Sentence[] = [];
  let i = 0;
  while (i < text.length) {
    i = Math.min(text.length, i + sizes());
    out.push(...(i < text.length ? s.push(text.slice(0, i)) : s.flush(text)));
  }
  if (!text.length) out.push(...s.flush(text));
  return out;
}
const charByChar = (make: () => Stream, text: string) => streamed(make, text, () => 1);
const randomChunks = (make: () => Stream, text: string, seed: number) => {
  const r = rng(seed);
  return streamed(make, text, () => 1 + Math.floor(r() * (r() < 0.2 ? 80 : 9)));
};
const said = (xs: Sentence[]) => xs.map((s) => s.speech).filter(Boolean);
const shape = (xs: Sentence[]) => xs.map((s) => ({ text: s.text, speech: s.speech, emotion: s.emotion }));

const FENCE = "```";
const MD_REPLY = [
  "[smile] 좋아요! 코드를 **보여** 드릴게요. 설치는 `npm ci` 로 해요.",
  "자세한 건 [공식 문서. 꼭 보세요](https://example.com/docs/v1.2/index.html?x=1. y) 를 참고하세요.",
  "",
  `${FENCE}python`,
  "def hello():",
  '    print("Hello. This must never be spoken!")  # 코드는 읽지 않아요.',
  "    return 1. + 2.",
  FENCE,
  "",
  "| 이름 | 설명 |",
  "|---|---|",
  "| Mr. Kim | 테이블은 읽지 않아요. 정말로! |",
  "| `x` | [링크](https://e.com/t) |",
  "",
  "## 다음 단계",
  "- **첫째**: 테스트를 돌려요.",
  "  - [ ] 둘째 항목이에요",
  "  - [x] 셋째도 끝났어요",
  "1. 순서 있는 항목이에요.",
  "> 인용문도 있어요. *strongly* 말이죠.",
  "---",
  "![고양이 사진](https://images.example.net/cat.png)",
  "<script>alert('never')</script> HTML 태그는 <b>굵게</b> 읽어요.",
  "주소 https://example.org/a.b?c=d 는 읽지 않아요 😀👍",
  "~~~",
  "tilde fenced code. Never spoken.",
  "~~~",
  "[thinking] 마지막으로, 질문 있으면 말씀해 주세요~",
].join("\n");

const NEVER = ["Hello. This", "def hello", "print", "return 1", "코드는 읽지", "Mr. Kim", "테이블은 읽지", "tilde fenced", "Never spoken", "alert", "never", "고양이", "https", "example", "e.com"];
const SYMBOLS = /[*_`#|>[\]<]|\]\(|https?:|-{2,}|~~~/;

test("a markdown reply: code, tables, URLs, images and HTML are never said, and no symbol is", () => {
  for (const make of [() => new SentenceStream({ minChars: 8 }), () => new SentenceStream()]) {
    for (const run of [charByChar(make, MD_REPLY), randomChunks(make, MD_REPLY, 7), make().flush(MD_REPLY)]) {
      const words = said(run);
      assert.ok(words.length >= 8, "the conversational parts are said");
      for (const w of words) {
        for (const bad of NEVER) assert.ok(!w.includes(bad), `"${bad}" said in: ${w}`);
        assert.doesNotMatch(w, SYMBOLS, `a symbol said: ${w}`);
        assert.doesNotMatch(w, /\p{Extended_Pictographic}/u, `an emoji said: ${w}`);
      }
      // the captions (text) have no markdown either
      for (const s of run) assert.doesNotMatch(s.text, /\*\*|`|\]\(|^#|\|/, `caption: ${s.text}`);
    }
  }
  const all = said(splitSentences(MD_REPLY)).join(" / ");
  for (const ok of ["좋아요!", "코드를 보여 드릴게요.", "설치는 npm ci 로 해요.", "공식 문서. 꼭 보세요 를 참고하세요.", "다음 단계", "첫째: 테스트를 돌려요.", "둘째 항목이에요", "셋째도 끝났어요", "순서 있는 항목이에요.", "인용문도 있어요.", "HTML 태그는 굵게 읽어요.", "주소 는 읽지 않아요", "마지막으로, 질문 있으면 말씀해 주세요~"])
    assert.ok(all.includes(ok), `"${ok}" not in: ${all}`);
});

test("char by char: no code is spoken at any moment of a streaming code block (open fence mid-stream)", () => {
  const text = "Here it is:\n```js\nconst a = 1. // not a sentence. Really.\nconsole.log(a); alert(1)! Done?\n";
  const s = new SentenceStream({ minChars: 8 });
  const got: Sentence[] = [];
  for (let i = 1; i <= text.length; i++) got.push(...s.push(text.slice(0, i)));
  assert.deepEqual(said(got), ["Here it is:"], "what came before the code is said at once");
  // the reply ends inside the unclosed fence: still silent
  got.push(...s.flush(text));
  assert.deepEqual(said(got), ["Here it is:"]);
  // tables too, and a table still arriving
  const t = "Look:\n| a | b |\n|---|---|\n| one. two. | three! |\n| four";
  const s2 = new SentenceStream();
  const g2: Sentence[] = [];
  for (let i = 1; i <= t.length; i++) g2.push(...s2.push(t.slice(0, i)));
  g2.push(...s2.flush(t));
  assert.deepEqual(said(g2), ["Look:"]);
});

test("deterministic: the same reply chunked any way gives the same sentences (indices match in every window)", () => {
  const long = "이건 마침표 없이 아주 길게 이어지는 문장이라서 중간에 잘려야 하는데 어디서 잘리는지는 텍스트가 어떻게 도착했는지와 상관없이 항상 같아야 해요 그래야 창마다 같은 번호가 붙고 목소리가 넘어갈 때 같은 문장을 두 번 읽거나 건너뛰지 않으니까요 [링크 라벨도 여기 있어요](https://example.com/a.b) 그리고 계속 이어지고 `코드 조각. 도` 있고 끝은 여기. 다음 문장!";
  const replies = [MD_REPLY, long, long + "\n" + MD_REPLY, "x".repeat(500), `${"word ".repeat(120)}end.`, "a, ".repeat(200), "| t |\n|---|\n" + "| row |\n".repeat(30) + "after."];
  for (const text of replies) {
    for (const opts of [{ minChars: 8 }, {}, { maxChars: 40 }]) {
      const want = shape(charByChar(() => new SentenceStream(opts), text));
      assert.deepEqual(shape(new SentenceStream(opts).flush(text)), want, "one chunk = char by char");
      for (let seed = 1; seed <= 12; seed++) assert.deepEqual(shape(randomChunks(() => new SentenceStream(opts), text, seed)), want, `seed ${seed}`);
      // a window that joins mid-reply: the text so far at once, then the rest char by char
      for (const at of [10, 77, Math.floor(text.length / 2)]) {
        const s = new SentenceStream(opts);
        const got = [...s.push(text.slice(0, at))];
        for (let i = at + 1; i <= text.length; i++) got.push(...(i < text.length ? s.push(text.slice(0, i)) : s.flush(text)));
        assert.deepEqual(shape(got), want, `joined at ${at}`);
      }
    }
  }
});

test("links: no sentence ends inside a label or URL, even split across chunks; only the label is said", () => {
  const text = "See [the docs. And more](https://example.com/a.b?c=1. d) now. Then [x](https://e.com) too.";
  const want = ["See the docs. And more now.", "Then x too."];
  assert.deepEqual(said(splitSentences(text)), want);
  assert.deepEqual(said(charByChar(() => new SentenceStream(), text)), want);
  // an unclosed [ that is no link: read once its line is over
  assert.deepEqual(said(splitSentences("[참고: 이건 링크가 아니에요. 그냥 괄호예요\n다음 줄.")), ["참고: 이건 링크가 아니에요.", "그냥 괄호예요", "다음 줄."]);
  // a link cut for length leaves no symbols
  const cut = splitSentences(`[${"label word ".repeat(30)}](https://example.com/very/long)`, { maxChars: 60 });
  for (const s of cut) assert.doesNotMatch(s.speech, /[[\]()]|https?:/);
});

test("a long run cut for length is never cut inside a URL that would then be read", () => {
  const url = `https://example.org/very/long/path/${"segment/".repeat(12)}0123456789abcdefghijklmnopqrstuvwxyz`;
  const giant = `https://example.org/${"x".repeat(500)}`;
  const texts = [
    `자세한 건 [공식 문서](https://example.com/docs) 와 ${url} 를 보세요 😀`,
    `${giant} 이 주소는 읽지 않아요 그리고 뒤에 오는 말은 읽어요`,
    `앞의 말 ${giant}${giant} 뒤의 말`,
  ];
  for (const text of texts) {
    for (const run of [splitSentences(text), charByChar(() => new SentenceStream({ minChars: 8 }), text), randomChunks(() => new SentenceStream(), text, 5)]) {
      for (const w of said(run)) assert.doesNotMatch(w, /x{5}|0123456789|segment|example|https?/, `a URL piece said: ${w}`);
    }
  }
  assert.ok(said(splitSentences(texts[1])).join(" ").includes("뒤에 오는 말은 읽어요"));
  assert.ok(said(splitSentences(texts[2])).join(" ").includes("뒤의 말"));
});

test("emphasis and code split across a sentence boundary leave no symbols", () => {
  const text = "**First sentence. Second sentence** and *one. two* and __a. b__ done. `x. y` ok.";
  const got = said(charByChar(() => new SentenceStream(), text));
  for (const w of got) assert.doesNotMatch(w, /[*_`]/, w);
  assert.deepEqual(got, ["First sentence.", "Second sentence and one.", "two and a.", "b done.", "x. y ok."]);
  assert.ok(got.join(" ").includes("x. y ok."), "a code span is one piece: its inner words are said");
});

test("list marks, checkboxes, quotes, headings, rules, html, emoji, emotion tags", () => {
  const cases: [string, string[]][] = [
    ["- one\n* two\n+ three\n1. four\n2) five", ["one", "two", "three", "four", "five"]],
    ["  - nested\n    - deeper", ["nested", "deeper"]],
    ["- [ ] todo\n- [x] done", ["todo", "done"]],
    ["> quoted. two\n> > nested", ["quoted.", "two", "nested"]],
    ["# Title\n### Sub ###", ["Title", "Sub"]],
    ["before\n---\n***\nafter", ["before", "after"]],
    ["<b>bold</b> and <i>it</i> <br/> fine", ["bold and it fine"]],
    ["<img src=x onerror=alert(1)> safe", ["safe"]],
    ["😀 hello 👋🏽 world 🇰🇷", ["hello world"]],
    ["[joy] 신나요! [sad:0.5] 슬퍼요.", ["신나요!", "슬퍼요."]],
    ["(웃음)\n*고개를 끄덕이며*\n네, 알겠어요.", ["네, 알겠어요."]],
    ["~~지운 글~~ 남은 글", ["~~지운 글~~", "남은 글"]], // (~ ends a Korean sentence; ~~ is no strikethrough)
  ];
  for (const [text, want] of cases) assert.deepEqual(said(splitSentences(text)), want, text);
  const e = splitSentences("[joy] 신나요! [sad:0.5] 슬퍼요.");
  assert.deepEqual(e.map((s) => [s.emotion, s.intensity]), [["joy", 1], ["sad", 0.5]]);
});

test("what came before a code block is said before it (not held for coalescing)", () => {
  const s = new SentenceStream({ minChars: 8 });
  const text = "Here:\n```\ncode\n```\nDone now, that was it.";
  const first = s.push(text.slice(0, 12));
  assert.deepEqual(said(first), ["Here:"]);
  assert.deepEqual(said(s.flush(text)), ["Done now, that was it."]);
});

// ── plain chat: exactly as before ─────────────────────────────────────

const PLAIN = [
  "[smile] 안녕하세요! 오늘 기분은 어떠세요? 저는 아주 좋아요~ 날씨도 맑고요.",
  "네, 알겠습니다. 바로 확인해 볼게요… 잠시만요!",
  "Mr. Kim이 말했어요. e.g. 이런 식으로요. 1. 첫째 2. 둘째",
  "그렇구나... 정말? 대박!! 진짜요?! 와~~ 신기하다",
  "Hello there! How are you doing today? I'm fine, thanks. Let's get started.",
  "(웃음) 좋아요.\n*smiles* 그럼 시작할게요.\n[thinking] 음... 잠깐만요.",
  "「좋아요」라고 했어요。그리고 \"정말?\" 하고 물었죠! 'OK.' 라고 답했어요.",
  "숫자 3.14와 버전 v1.2.3, 시간 10:30, 가격 1,000원이에요.",
  "이모지도 있어요 😀 👍 ❤️ 하트! 그리고 끝.",
  "[joy] 와! [surprised] 정말요? [sad:0.3] 아쉽네요.",
  "줄 하나\n줄 둘\n\n빈 줄 다음 줄",
  "A very long sentence without any punctuation that keeps going and going so that it is longer than the maximum number of characters allowed in a single spoken piece and must be cut somewhere sensible, like after a comma",
  "끝에 공백   \n  앞에 공백",
  "(괄호 안의 설명입니다.) 그리고 다음 문장이에요.",
  "OK~ 좋아~ 그래～ 알았어！ 정말？ 응。",
];

test("plain chat: the same sentences, speech and emotions as the previous version (one chunk, char by char, chunks)", () => {
  for (const text of PLAIN) {
    for (const opts of [{ minChars: 8 }, {}]) {
      const was = (xs: Sentence[]) => xs.map((s) => ({ speech: s.speech, emotion: s.emotion, intensity: s.intensity }));
      // (one difference on purpose: the old flush did not cut an over-long run where its streaming did — now both
      // cut as streaming does, so the old streaming result is the reference)
      assert.deepEqual(was(splitSentences(text, opts)), was(charByChar(() => new v1.SentenceStream(opts), text)), `flush: ${text}`);
      if (text.length < 160) assert.deepEqual(was(splitSentences(text, opts)), was(v1.splitSentences(text, opts)), `flush: ${text}`);
      assert.deepEqual(was(charByChar(() => new SentenceStream(opts), text)), was(charByChar(() => new v1.SentenceStream(opts), text)), `char by char: ${text}`);
      // (the old version was not chunk-independent for over-long runs; for normal chat it was)
      if (text.length < 160) assert.deepEqual(was(randomChunks(() => new SentenceStream(opts), text, 3)), was(randomChunks(() => new v1.SentenceStream(opts), text, 3)), `chunks: ${text}`);
      // captions: the old text, without the markdown (a *stage direction*'s stars, a list number at a line's start)
      const caps = (xs: Sentence[]) => xs.map((s) => s.text.replace(/\*([^*]+)\*/g, "$1").replace(/^\d{1,3}[.)]\s+/, "").replace(/\s+/g, " "));
      assert.deepEqual(caps(charByChar(() => new SentenceStream(opts), text)), caps(charByChar(() => new v1.SentenceStream(opts), text)), `captions: ${text}`);
    }
  }
});

test("speakable: plain chat sounds exactly as before", () => {
  const lines = PLAIN.flatMap((t) => t.split(/(?<=[.!?~。])\s+|\n/)).concat([
    "괜찮아요 :) 정말로요 ;)",
    "50% 할인 & 무료 배송 + 적립",
    "\"인용\" 'single' (괄호) {중괄호}",
    "e-mail: me@example.com",
    "C++ 와 C# 그리고 F#",
  ]);
  for (const l of lines) assert.equal(speakable(l), v1.speakable(l), l);
});
