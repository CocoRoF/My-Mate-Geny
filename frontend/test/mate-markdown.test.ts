// A mate's reply as display blocks (src/mate/markdown.ts segmentReply), rendered with the bubbles' own markdown options
// (src/components/mate/mateMarkdown.ts) through react-dom/server: every element, streaming char by char without raw
// markers, safe links and images, escaped HTML, plain text for captions.   Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import {
  closeInline,
  imageSource,
  plainPreview,
  plainText,
  safeHref,
  segmentReply,
  speechText,
  withoutCode,
  type MateBlock,
} from "../src/mate/markdown.ts";
import { BLOCK_ELEMENTS, INLINE_ELEMENTS, mateUrlTransform, REMARK_PLUGINS } from "../src/components/mate/mateMarkdown.ts";

const ORIGIN = "https://geny.test";

/** a block as the bubble renders it (without the components: links / images / code chrome are MateReply's) */
function html(b: MateBlock): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: REMARK_PLUGINS,
        urlTransform: (u: string, k: string) => mateUrlTransform(u, k, ORIGIN),
        allowedElements: b.kind === "text" ? INLINE_ELEMENTS : BLOCK_ELEMENTS,
        unwrapDisallowed: true,
      },
      b.md,
    ),
  );
}

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
/** the words a reader sees outside code (code is shown as written, on purpose) */
const visible = (h: string) => decode(h.replace(/<pre[\s\S]*?<\/pre>/g, " ").replace(/<code>[\s\S]*?<\/code>/g, " ").replace(/<[^>]+>/g, " "));

const kinds = (blocks: MateBlock[]) => blocks.map((b) => b.type ?? b.kind);

test('empty and emotion-only completed replies have no display blocks or bubble spacing',()=>{
 for(const text of ['', ' \n\t ', '[neutral]', '[smile]','(잠시 생각함)'])assert.deepEqual(segmentReply(text),[]);
 assert.equal(segmentReply('...').length,1);
 assert.equal(segmentReply('```text\n[SILENT]\n```').length,1,'literal code stays visible');
});

// ── one reply with every element ──────────────────────────────────────

const FENCE = "```";
const REPLY = [
  "[smile] 안녕하세요! 오늘은 **굵은 글씨**와 *기울임*, 그리고 `inline code` 를 보여 드릴게요.",
  "자세한 건 [공식 문서](https://example.com/docs?a=1.2) 와 https://example.org/path 를 보세요 😀",
  "",
  "## 설치 방법",
  "",
  "1. 먼저 저장소를 받아요.",
  "2. 의존성을 설치해요:",
  "   - `npm ci`",
  "   - [ ] 테스트 실행",
  "   - [x] 빌드 확인",
  "",
  `${FENCE}bash`,
  "npm ci && npm run build   # 이건 읽으면 안 돼요.",
  'echo "Done. Really!"',
  FENCE,
  "",
  "| 이름 | 값 | 비고 |",
  "|:---|---:|---|",
  "| Mr. Kim | 3.5 | 좋아요. 정말로 |",
  "| **B** | `4` | [링크](https://example.com/b) |",
  "",
  "> 인용문이에요. 두 번째 문장.",
  "> > 중첩된 인용",
  "",
  "---",
  "",
  "![고양이 사진](https://images.example.net/cat.png)",
  "",
  "[thinking] 마지막으로, 질문 있으면 말씀해 주세요~",
].join("\n");

test("every element: conversational lines as their own bubbles, block constructs together", () => {
  const blocks = segmentReply(REPLY);
  assert.deepEqual(kinds(blocks), ["text", "text", "heading", "list", "code", "table", "quote", "rule", "image", "text"]);
  assert.equal(blocks[0].md, "안녕하세요! 오늘은 **굵은 글씨**와 *기울임*, 그리고 `inline code` 를 보여 드릴게요.", "the emotion tag goes");
  assert.equal(blocks[9].md, "마지막으로, 질문 있으면 말씀해 주세요~");
  const code = blocks[4];
  assert.equal(code.lang, "bash");
  assert.equal(code.open, false);
  assert.ok(code.md.includes('echo "Done. Really!"'));
  assert.equal(blocks[3].md.split("\n").length, 5, "the nested items and task items stay in the list");
  // keys: the block's first line
  assert.deepEqual(
    blocks.map((b) => b.key),
    ["L0", "L1", "L3", "L5", "L11", "L16", "L21", "L24", "L26", "L28"],
  );
});

test("every element renders as markdown: headings, lists (nested, ordered, tasks), code, table, quote, rule, image", () => {
  const h = segmentReply(REPLY).map(html);
  assert.match(h[0], /<strong>굵은 글씨<\/strong>/);
  assert.match(h[0], /<em>기울임<\/em>/);
  assert.match(h[0], /<code>inline code<\/code>/);
  assert.match(h[1], /<a href="https:\/\/example\.com\/docs\?a=1\.2">공식 문서<\/a>/);
  assert.match(h[1], /<a href="https:\/\/example\.org\/path">https:\/\/example\.org\/path<\/a>/, "bare URLs link too");
  assert.match(h[2], /<h2>설치 방법<\/h2>/);
  assert.match(h[3], /<ol>[\s\S]*<ul[^>]*>[\s\S]*<input type="checkbox" disabled=""\/>[\s\S]*<input type="checkbox" disabled="" checked=""\/>/);
  assert.match(h[4], /<pre><code class="language-bash">npm ci &amp;&amp; npm run build/);
  assert.match(h[5], /<table>[\s\S]*<th style="text-align:left">이름<\/th>[\s\S]*<td style="text-align:right">3\.5<\/td>/);
  assert.match(h[6], /<blockquote>[\s\S]*<blockquote>[\s\S]*중첩된 인용/);
  assert.match(h[8], /<img src="https:\/\/images\.example\.net\/cat\.png" alt="고양이 사진"\/>/);
});

/** visible words that would be raw markdown */
const RAW = [/\*/, /`/, /\]\(/, /\|/, /#/, /\[/, /\]/, /!\[/, /^\s*>/m, /-{3}/, /~{3}/];

test("streaming char by char: no raw markdown ever shows, code is a code block in progress, keys never move", () => {
  const finalKeys = new Map(segmentReply(REPLY).map((b) => [b.key, b.type ?? b.kind]));
  const codeLines = ["npm ci && npm run build", 'echo "Done'];
  for (let i = 1; i <= REPLY.length; i++) {
    const blocks = segmentReply(REPLY.slice(0, i), { streaming: true });
    for (const b of blocks) {
      const h = html(b);
      const v = visible(h);
      for (const re of RAW) assert.doesNotMatch(v, re, `prefix ${i}: block ${b.key} (${b.type ?? b.kind}) shows ${re}: ${JSON.stringify(v)} ← ${JSON.stringify(b.md)}`);
      // code is only ever inside the code block
      if (b.type !== "code") for (const c of codeLines) assert.ok(!b.md.includes(c), `prefix ${i}: code outside the code block: ${b.md}`);
      else assert.match(h, /^<pre><code/, `prefix ${i}: the code block renders as code`);
    }
    // every block but the growing last one already has its final key and kind (bubbles don't remount)
    for (const b of blocks.slice(0, -1)) assert.equal(finalKeys.get(b.key), b.type ?? b.kind, `prefix ${i}: ${b.key}`);
  }
});

test("streaming in chunks gives the same final blocks as the finished text", () => {
  for (const size of [1, 2, 3, 7, 13, 50]) {
    let last: MateBlock[] = [];
    for (let i = size; i < REPLY.length + size; i += size) last = segmentReply(REPLY.slice(0, i), { streaming: i < REPLY.length });
    assert.deepEqual(last.map((b) => [b.key, b.md]), segmentReply(REPLY).map((b) => [b.key, b.md]));
  }
});

test("an unclosed fence: a code block in progress (streaming), still code when the reply ends", () => {
  const s = segmentReply("Here:\n```js\nconst a = 1;\nconsole.log(a", { streaming: true });
  assert.deepEqual(kinds(s), ["text", "code"]);
  assert.equal(s[1].open, true);
  assert.equal(s[1].lang, "js");
  assert.equal(s[1].md, "```js\nconst a = 1;\nconsole.log(a\n```");
  const f = segmentReply("Here:\n```js\nconst a = 1;");
  assert.equal(f[1].open, false);
  assert.equal(f[1].md, "```js\nconst a = 1;\n```");
  // the opening line being typed: nothing yet; the closing fence being typed: not code
  assert.deepEqual(kinds(segmentReply("Hi\n```py", { streaming: true })), ["text"]);
  assert.equal(segmentReply("```py\nx = 1\n``", { streaming: true })[0].md, "```py\nx = 1\n```");
  // tilde fences, longer fences holding a fence, indentation
  assert.equal(segmentReply("~~~\na\n~~~")[0].type, "code");
  assert.equal(segmentReply("````md\n```\ninner\n```\n````")[0].md, "````md\n```\ninner\n```\n````");
  assert.equal(segmentReply("  ```\n  x\n  ```")[0].md, "```\nx\n```");
  // "~~~ 그렇구나" is chat, not a fence
  const tilde = segmentReply("~~~ 그렇구나\n좋아요");
  assert.deepEqual(kinds(tilde), ["text", "text"]);
  assert.match(html(tilde[0]), /^<p>~~~ 그렇구나<\/p>$/);
});

test("a table: rows complete only, a header waits for its delimiter row", () => {
  assert.deepEqual(kinds(segmentReply("| a | b |", { streaming: true })), []);
  assert.deepEqual(kinds(segmentReply("| a | b |\n|-", { streaming: true })), [], "a delimiter row with fewer cells: not yet");
  assert.deepEqual(kinds(segmentReply("| a | b |\n|-|-", { streaming: true })), ["table"]);
  assert.deepEqual(kinds(segmentReply("| a | b |\n|---|\nnot a table")), ["text", "text", "text"], "cells must match (GFM)");
  assert.deepEqual(kinds(segmentReply("| a | b |\n|:", { streaming: true })), []);
  const t = segmentReply("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4", { streaming: true })[0];
  assert.equal(t.md, "| a | b |\n|---|---|\n| 1 | 2 |", "the row still arriving is left out");
  assert.equal(segmentReply("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4")[0].md.split("\n").length, 4, "finished: every row");
  // without the outer pipes, and a text line with a pipe that is no table
  assert.deepEqual(kinds(segmentReply("a | b\n--|--\n1 | 2")), ["table"]);
  assert.deepEqual(kinds(segmentReply("A | B 중 하나를 골라요.")), ["text"]);
  // a table then talk
  assert.deepEqual(kinds(segmentReply("| a |\n|---|\n| 1 |\n\nThat's all.")), ["table", "text"]);
  // a very wide table renders (it scrolls inside its bubble: .mate-md-table)
  const wide = `| ${Array.from({ length: 40 }, (_, i) => `col${i}`).join(" | ")} |\n|${"---|".repeat(40)}\n| ${"x | ".repeat(40)}`;
  assert.equal((html(segmentReply(wide)[0]).match(/<th>/g) ?? []).length, 40);
});

test("lists: nested, ordered, tasks, loose; a sentence that starts with a year is no list", () => {
  const l = segmentReply("- a\n  - b\n    - c\n- d\n\n- e\n\nAfter the list.");
  assert.deepEqual(kinds(l), ["list", "text"]);
  assert.match(html(l[0]), /<ul>[\s\S]*<ul>[\s\S]*<ul>/);
  assert.deepEqual(kinds(segmentReply("1) one\n2) two")), ["list"]);
  assert.deepEqual(kinds(segmentReply("+ plus item")), ["list"]);
  const year = segmentReply("2024. 정말 좋은 해였죠");
  assert.deepEqual(kinds(year), ["text"]);
  assert.match(html(year[0]), /^<p>2024\. 정말 좋은 해였죠<\/p>$/);
  // a fence inside an item stays in the list
  assert.deepEqual(kinds(segmentReply("1. Run:\n   ```sh\n   make\n   ```\n2. Done")), ["list"]);
  // deep nesting renders (indentation is capped in CSS)
  const deep = Array.from({ length: 60 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
  const d = segmentReply(deep);
  assert.deepEqual(kinds(d), ["list"]);
  assert.ok(html(d[0]).includes("level 59"));
});

test("quotes, headings, rules, setext-free lines", () => {
  assert.deepEqual(kinds(segmentReply("> a\n> b\nc")), ["quote", "text"]);
  assert.deepEqual(kinds(segmentReply("# H1\n###### H6\n####### seven")), ["heading", "heading", "text"]);
  assert.deepEqual(kinds(segmentReply("***\n___\n- - -")), ["rule", "rule", "rule"]);
  const deep = segmentReply(">".repeat(200) + " deep");
  assert.deepEqual(kinds(deep), ["quote"]);
  assert.ok(html(deep[0]).includes("deep"));
});

test("conversational lines: one bubble per line, stage directions dropped, tags dropped (not in code)", () => {
  const b = segmentReply("[joy] 안녕!\n(웃음)\n*smiles*\n（끄덕）\n\n[sad:0.4]\nOh. [sad] No.\n`[ok]` stays in code\n[1] stays, it is no tag");
  assert.deepEqual(b.map((x) => x.md), ["안녕!", "Oh. No.", "`[ok]` stays in code", "[1] stays, it is no tag"]);
  // a line that starts with emphasis, a hashtag, a minus or a code span is still formatted (no escaping)
  const starts = segmentReply("**굵게** 시작\n*웃으며* 네\n#해시태그 그대로\n-5도래요\n`npm` 먼저\n```inline```");
  assert.deepEqual(kinds(starts), ["text", "text", "text", "text", "text", "text"]);
  const sh = starts.map(html);
  assert.match(sh[0], /^<p><strong>굵게<\/strong> 시작<\/p>$/);
  assert.match(sh[1], /^<p><em>웃으며<\/em> 네<\/p>$/);
  assert.match(sh[2], /^<p>#해시태그 그대로<\/p>$/);
  assert.match(sh[3], /^<p>-5도래요<\/p>$/);
  assert.match(sh[4], /^<p><code>npm<\/code> 먼저<\/p>$/);
  assert.match(sh[5], /^<p><code>inline<\/code><\/p>$/);
  // half a tag at the end while streaming: hidden
  assert.deepEqual(segmentReply("Hi.\n[jo", { streaming: true }).map((x) => x.md), ["Hi."]);
  assert.deepEqual(segmentReply("Hi [smile:0.", { streaming: true }).map((x) => x.md), ["Hi"]);
});

test("Korean, emoji and special characters stay as written; ~~ is no strikethrough", () => {
  const b = segmentReply("좋아~~진짜~~ 대박 😂👍🏽 🇰🇷\n가격은 1,000원 & 50% 할인 <3\n\"따옴표\" 'quote' — 대시 … 끝");
  const h = b.map(html);
  assert.match(h[0], /^<p>좋아~~진짜~~ 대박 😂👍🏽 🇰🇷<\/p>$/);
  assert.ok(!h[0].includes("<del>"));
  assert.equal(visible(h[1]).trim(), "가격은 1,000원 & 50% 할인 <3");
  assert.ok(visible(h[2]).includes("\"따옴표\" 'quote' — 대시 … 끝"));
});

test("very long lines, words, URLs and code: one block each, no crash, quick", () => {
  const word = "가".repeat(3000) + "a".repeat(3000);
  const url = `https://example.com/${"x".repeat(4000)}`;
  const code = "```\n" + "y".repeat(20000) + "\n```";
  const t0 = performance.now();
  const b = segmentReply(`${word}\n${url}\n${code}`);
  assert.deepEqual(kinds(b), ["text", "text", "code"]);
  for (const x of b) html(x);
  // a 30 000-character reply streamed in 300 steps
  const big = Array.from({ length: 300 }, (_, i) => `줄 ${i}: **굵게** \`code\` [link](https://e.com/${i}) 끝.`).join("\n");
  for (let i = 100; i <= big.length; i += 100) segmentReply(big.slice(0, i), { streaming: true });
  assert.ok(performance.now() - t0 < 4000, "fast enough");
});

// ── streaming tails ───────────────────────────────────────────────────

test("closeInline: half-typed markers are closed or hidden", () => {
  const cases: [string, string][] = [
    ["**bo", "**bo**"],
    ["*it", "*it*"],
    ["_it", "_it_"],
    ["__bo", "__bo__"],
    ["***both", "***both***"],
    ["`co", "`co`"],
    ["``a ` b", "``a ` b``"],
    ["hello **", "hello "],
    ["hello *", "hello "],
    ["`", ""],
    ["see [lab", "see lab"],
    ["see [label]", "see label"],
    ["see [label](https://exa", "see label"],
    ["an ![alt](https://x", "an "],
    ["**bold** and *it", "**bold** and *it*"],
    ["**bo *it", "**bo *it***"],
    ["**bold  ", "**bold**"],
    ["file_na", "file_na"],
    ["2 * 3", "2 * 3"],
    ["done **ok** `x`", "done **ok** `x`"],
    ["`a **b` c **d", "`a **b` c **d**"],
    ["escaped \\*not", "escaped \\*not"],
  ];
  for (const [i, o] of cases) assert.equal(closeInline(i), o, JSON.stringify(i));
});

test("streaming a line with every inline marker: never a raw marker at any prefix", () => {
  const line = "Use **bold**, *italic*, __strong__, _em_, `code`, [a link](https://example.com/x?y=1) and ![pic](https://example.com/p.png) now.";
  for (let i = 1; i <= line.length; i++) {
    for (const b of segmentReply(line.slice(0, i), { streaming: true })) {
      const v = visible(html(b));
      for (const re of [/\*/, /`/, /\[/, /\]/, /\(/, /\)/, /(?<![\w])_|_(?![\w])/]) assert.doesNotMatch(v, re, `prefix ${i}: ${JSON.stringify(v)} ← ${b.md}`);
    }
  }
});

// ── security ──────────────────────────────────────────────────────────

test("safeHref: absolute http(s) and mailto only", () => {
  const ok = ["https://example.com/a?b=1#c", "http://example.com", "HTTPS://EXAMPLE.COM/x", "mailto:me@example.com", "  https://padded.example  "];
  for (const u of ok) assert.ok(safeHref(u), u);
  const bad = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0000javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "blob:https://x/1",
    "//evil.example/x",
    "/relative/path",
    "#anchor",
    "relative",
    "https://user:pass@evil.example/",
    "",
    null,
    undefined,
  ];
  for (const u of bad) assert.equal(safeHref(u as string), null, String(u));
});

test("imageSource: this server's own files load at once, anything else is asked first, the rest is no image", () => {
  assert.deepEqual(imageSource("/api/mates/m1/assets/a.png", ORIGIN), { src: `${ORIGIN}/api/mates/m1/assets/a.png`, ask: false, host: "geny.test" });
  assert.equal(imageSource(`${ORIGIN}/api/sessions/s1/attachments/att_1/shot.png`, ORIGIN)?.ask, false);
  assert.equal(imageSource(`${ORIGIN}/x.png`, ORIGIN)?.ask, true, "another path of this server: asked first");
  assert.equal(imageSource("/api/auth/status", ORIGIN)?.ask, true);
  assert.equal(imageSource("/api/mates/m1/assets/../../auth/x", ORIGIN)?.ask, true, "no climbing out");
  assert.deepEqual(imageSource("https://img.example/cat.png", ORIGIN), { src: "https://img.example/cat.png", ask: true, host: "img.example" });
  assert.equal(imageSource("//evil.example/x.png", ORIGIN)?.ask, true);
  for (const u of ["data:image/png;base64,AAAA", "javascript:alert(1)", "blob:x", "file:///x.png", "https://u:p@x.example/a.png", ""]) assert.equal(imageSource(u, ORIGIN), null, u);
});

test("rendered: unsafe links lose their href, raw HTML is text, unsafe images lose their src", () => {
  const cases = [
    "[click](javascript:alert(1))",
    "[click](JAVASCRIPT:alert(1))",
    "[click](&#106;avascript:alert(1))",
    "[click](java%0ascript:alert(1))",
    "[click](vbscript:msgbox)",
    "[click](data:text/html;base64,PHNjcmlwdD4=)",
    "<javascript:alert(1)>",
    "[ref]\n\n[ref]: javascript:alert(1)",
    "![x](javascript:alert(1))",
    "![x](data:image/svg+xml,<svg onload=alert(1)>)",
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    "<iframe src=https://evil.example></iframe>",
    '<div onclick="alert(1)">hi</div>',
    "- <script>alert(2)</script> in a list",
    "> <img src=x onerror=alert(3)> in a quote",
    "| <b onmouseover=alert(4)>x</b> |\n|---|",
  ];
  for (const c of cases) {
    const all = (segmentReply(c).length ? segmentReply(c) : [{ key: "x", kind: "text", md: c } as MateBlock]).map(html).join("\n");
    assert.doesNotMatch(all, /href="(?!https?:|mailto:)[^"]+"/i, `${c} → ${all}`);
    assert.doesNotMatch(all, /src="(?!https?:)[^"]+"/i, `${c} → ${all}`);
    assert.doesNotMatch(all, /<(script|iframe|div|b)\b/i, `${c} → ${all}`);
    assert.doesNotMatch(all, /<img[^>]*onerror/i, `${c} → ${all}`);
    assert.doesNotMatch(all, /\son\w+="/i, `${c} → ${all}`);
  }
  // the HTML shows as the characters it is
  assert.match(html(segmentReply("<script>alert(1)</script>")[0]), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// ── plain text (captions, notifications) ──────────────────────────────

test("plainText: the words without markdown", () => {
  assert.equal(
    plainText("## 제목\n- **굵게** 그리고 *기울임*\n> 인용 `code` [링크](https://e.com) ![img](https://e.com/i.png)\n```js\nconst x = 1;\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n---\n1. 끝 ~~그대로~~"),
    "제목\n굵게 그리고 기울임\n인용 code 링크  \n끝 ~~그대로~~",
  );
  assert.equal(plainText("<b>bold</b> <script>x()</script>tail").replace(/\s+/g, " ").trim(), "bold tail");
  assert.equal(plainText("**cut in the mid"), "cut in the mid", "a marker without its partner goes");
  assert.equal(plainText("snake_case_name and __init__"), "snake_case_name and init");
});

test("plainPreview: the first line with words, cut", () => {
  assert.equal(plainPreview("```bash\nls\n```\n\n## **Done** — all `3` tests pass"), "Done — all 3 tests pass");
  assert.equal(plainPreview("x".repeat(300), 50).length, 50);
  assert.equal(plainPreview("```\nonly code\n```"), "");
});

test("speechText: no markdown, URLs, emoji, stage directions", () => {
  assert.equal(speechText("**Hello** *smiles* there 😀 https://x.com/a?b. See [docs](https://e.com)!"), "Hello there See docs!");
  assert.equal(speechText("- [ ] task one"), "task one");
  assert.equal(speechText("### Heading ###"), "Heading");
  assert.equal(speechText("> > nested quote"), "nested quote");
  assert.equal(speechText("| a | b |"), "a b");
  assert.equal(speechText("---"), "");
  assert.equal(speechText("(웃음)"), "");
  assert.equal(speechText("```\ncode\n```"), "");
  assert.equal(speechText("<script>alert(1)</script>"), "");
  assert.equal(speechText("Run `npm test` now"), "Run npm test now");
  assert.equal(speechText("visit www.example.com today"), "visit today");
  assert.equal(speechText("![a cat](https://e.com/cat.png)"), "");
  assert.equal(speechText("Keycap 1️⃣ flag 🇰🇷 family 👨‍👩‍👧 ok"), "Keycap 1 flag family ok");
});

test("withoutCode: fenced code goes (an unclosed fence to the end)", () => {
  assert.equal(withoutCode("a [joy]\n```\n[sad]\n```\nb"), "a [joy]\n\nb");
  assert.equal(withoutCode("a\n```\n[sad] still code"), "a\n");
  assert.equal(withoutCode("no code [joy]"), "no code [joy]");
});
