// A mate's markdown reply in a real browser against a real server (backend with
// CLAUDE_BINARY=desktop/test/e2e/fake-claude.py, frontend build as STATIC_DIR): the console's Mate view while the
// reply streams (half a bold word, inside the code block, inside the table) and when done, the mate chat window, the
// quick card, a phone; what the voice says (speechSynthesis replaced by a recorder) and what the overlay's caption
// shows. Screenshots go to SHOTS (default ~/.cache/hrh-mate-md-shots).
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node test/e2e/mate-markdown-browser.js <server url> <password>
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD] = process.argv.slice(2);
if (!SERVER || !PASSWORD) {
  console.error("usage: node test/e2e/mate-markdown-browser.js <server url> <password>");
  process.exit(2);
}
const SHOTS = process.env.SHOTS || path.join(os.homedir(), ".cache", "hrh-mate-md-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
async function until(what, fn, ms = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

// a recording speechSynthesis (as in mate-voice-browser.js): window.__spoken = [text…], 150 ms per sentence
const FAKE_TTS = () => {
  window.__spoken = [];
  let cur = null;
  let timer = null;
  const end = () => {
    clearTimeout(timer);
    const u = cur;
    cur = null;
    u?.onend?.(new Event("end"));
  };
  const fake = {
    speaking: false,
    pending: false,
    paused: false,
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
    speak(u) {
      if (cur) end();
      cur = u;
      window.__spoken.push(u.text);
      setTimeout(() => u.onstart?.(new Event("start")), 0);
      timer = setTimeout(end, 150);
    },
    cancel() {
      if (cur) end();
    },
    pause() {},
    resume() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
};

async function context(browser, mateId, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, ...opts });
  await ctx.addInitScript(FAKE_TTS);
  await ctx.addInitScript((id) => {
    localStorage.setItem("hrh_lang", "en");
    if (id) localStorage.setItem("hrh_mate_active", id);
  }, mateId);
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  return ctx;
}

async function send(p, text) {
  const input = p.locator('[data-testid="mate-input"]').first();
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/** what the bubbles show outside code (raw markdown would be a bug) and facts about the DOM */
const inspect = (p) =>
  p.evaluate(() => {
    const bubbles = [...document.querySelectorAll('[data-testid="mate-bubble"]')];
    const textOf = (el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll("pre, code, [data-testid=code-block]").forEach((x) => x.remove());
      return c.innerText;
    };
    const root = document.scrollingElement;
    return {
      blocks: bubbles.map((b) => ({ kind: b.dataset.block, open: b.dataset.open === "true", text: textOf(b) })),
      links: [...document.querySelectorAll('[data-testid="mate-bubble"] a')].map((a) => ({ href: a.getAttribute("href"), target: a.target, rel: a.rel, text: a.innerText })),
      unlinked: [...document.querySelectorAll('[data-testid="mate-md-unlinked"]')].map((x) => x.innerText),
      images: [...document.querySelectorAll('[data-testid="mate-bubble"] img')].map((i) => i.getAttribute("src")),
      hiddenImages: document.querySelectorAll('[data-testid="mate-md-image-hidden"]').length,
      codeLangs: [...document.querySelectorAll('[data-testid="code-lang"]')].map((x) => x.innerText),
      copyButtons: document.querySelectorAll('[data-testid="code-copy"]').length,
      tables: document.querySelectorAll('[data-testid="mate-md-table"] table').length,
      xss: window.__xss ?? null,
      pageScrollsSideways: root.scrollWidth > root.clientWidth + 1,
      wideBubbles: bubbles.filter((b) => b.getBoundingClientRect().right > window.innerWidth + 1).length,
      spoken: window.__spoken,
    };
  });

// (the reply's raw HTML is shown as text on purpose: checked by `xss` and below)
const RAW = [/\*\*/, /`/, /\]\(/, /(^|\n)\s*\|/, /(^|\n)\s*#{1,6}\s/, /!\[/, /\[(?:smile|thinking)\]/];
function assertClean(state, where) {
  for (const b of state.blocks) for (const re of RAW) assert.doesNotMatch(b.text, re, `${where}: a ${b.kind} bubble shows ${re}: ${JSON.stringify(b.text)}`);
  assert.equal(state.xss, null, `${where}: no script ran`);
  assert.equal(state.pageScrollsSideways, false, `${where}: the page never scrolls sideways`);
  assert.equal(state.wideBubbles, 0, `${where}: no bubble sticks out`);
}

async function shot(p, name, opts = {}) {
  const file = path.join(SHOTS, name);
  await p.screenshot({ path: file, ...opts });
  console.log(`  ${file}`);
}

/**
 * The conversation scrolled (by the wheel, like a reader: the list stops following the bottom) so the `index`-th match
 * of `sel` (negative: from the end) is at the top of the scroller.
 */
async function scrollConv(p, sel, index = 0) {
  const at = await p.evaluate(([sel, index]) => {
    const els = document.querySelectorAll(sel);
    const el = index < 0 ? els[els.length + index] : els[index];
    if (!el) return null;
    let sc = el.parentElement;
    while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    if (!sc) return null;
    const r = el.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    return { dy: r.top - s.top - 8, x: s.left + s.width / 2, y: s.top + Math.min(s.height / 2, 200) };
  }, [sel, index]);
  if (!at) return;
  await p.mouse.move(at.x, at.y);
  await p.mouse.wheel(0, at.dy);
  await sleep(500);
}
const TURN = '[data-testid="mate-turn"]';

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--autoplay-policy=no-user-gesture-required"] });
  let mateId = null;
  try {
    const setup = await context(browser, "");
    const mate = await (await setup.request.post(`${SERVER}/api/mates`, { data: { name: `Markdown ${Date.now() % 10000}` } })).json();
    mateId = mate.id;
    assert.ok((await setup.request.patch(`${SERVER}/api/mates/${mate.id}`, { data: { voice: { auto_read: true, tts: { engine: "browser" } } } })).ok());
    await setup.close();

    // ── the console's Mate view, desktop width ──
    const desk = await context(browser, mate.id);
    const view = await desk.newPage();
    await view.goto(`${SERVER}/?view=mate`);
    await view.waitForSelector('[data-testid="mate-settings-open"]', { timeout: 20000 });
    await sleep(1500); // (connected, elected to read)

    step("the reply streams: half a bold word — no ** shows");
    await send(view, "md1 show me everything");
    await until("the first pause", async () => (await inspect(view)).blocks.some((b) => b.text.includes("마크다운 예")), 20000);
    await sleep(300);
    let st = await inspect(view);
    assertClean(st, "mid bold");
    await shot(view, "01-console-stream-bold.png");

    step("inside the code block — a code block in progress, nothing raw");
    await until("inside the code block", async () => (await inspect(view)).blocks.some((b) => b.kind === "code" && b.open), 30000);
    await sleep(400);
    st = await inspect(view);
    assertClean(st, "mid code");
    assert.ok(await view.locator('[data-block="code"][data-open="true"] pre').first().isVisible());
    await scrollConv(view, TURN, -1);
    await shot(view, "02-console-stream-code.png");

    step("inside the table — complete rows only");
    await until("the table", async () => (await inspect(view)).tables > 0, 30000);
    await sleep(400);
    st = await inspect(view);
    assertClean(st, "mid table");
    await scrollConv(view, '[data-block="code"]');
    await shot(view, "03-console-stream-table.png");

    step("done: every element, safe links, images asked first, no script, the page never widens");
    await until("the reply done", async () => (await inspect(view)).blocks.some((b) => b.text.includes("마지막으로")) && !(await view.locator('[data-open="true"]').count()), 30000);
    await sleep(1200);
    st = await inspect(view);
    assertClean(st, "done");
    const kinds = st.blocks.map((b) => b.kind);
    for (const k of ["text", "heading", "list", "code", "table", "quote", "image"]) assert.ok(kinds.includes(k), `a ${k} block (${kinds.join(",")})`);
    assert.equal(await view.locator('[data-testid="mate-md-rule"]').count(), 1, "the --- rule");
    assert.deepEqual(st.codeLangs, ["bash"]);
    assert.equal(st.copyButtons, 1);
    assert.equal(st.tables, 1);
    for (const l of st.links) {
      assert.match(l.href, /^https?:\/\//, `a safe href: ${JSON.stringify(l)}`);
      assert.equal(l.target, "_blank");
      assert.equal(l.rel, "noopener noreferrer");
    }
    assert.ok(st.links.some((l) => l.text === "공식 문서"));
    assert.ok(st.unlinked.includes("링크"), "the javascript: link is only its label");
    assert.equal(st.images.length, 0, "no remote image loads by itself");
    assert.equal(st.hiddenImages, 1);
    const allText = st.blocks.map((b) => b.text).join("\n");
    assert.ok(allText.includes("<script>window.__xss=2</script>"), "raw HTML shows as text");
    // the code block / table scroll inside their bubble
    const scrolls = await view.evaluate(() => ({
      // (highlight.js makes the <code> inside the <pre> the scroller)
      pre: [...document.querySelectorAll('[data-block="code"] pre')].map((p) => [p, p.querySelector("code")].some((e) => e && e.scrollWidth > e.clientWidth && getComputedStyle(e).overflowX === "auto")),
      table: [...document.querySelectorAll('[data-testid="mate-md-table"]')].map((t) => t.scrollWidth > t.clientWidth),
    }));
    assert.deepEqual(scrolls.pre, [true], "the long code line scrolls inside the block");
    console.log(`  table scrolls inside its bubble: ${scrolls.table}`);
    await scrollConv(view, TURN, -1);
    await shot(view, "04-console-done-top.png");
    await scrollConv(view, '[data-block="list"]');
    await shot(view, "05-console-done-middle.png");
    await scrollConv(view, '[data-block="table"]');
    await shot(view, "06-console-done-bottom.png");

    step("the remote image loads when asked");
    await view.locator('[data-testid="mate-md-image-hidden"]').first().click();
    await until("the image element", async () => (await inspect(view)).images.length === 1, 5000);
    st = await inspect(view);
    assert.deepEqual(st.images, ["https://images.example.net/cat.png"]);
    await sleep(800); // (the host doesn't exist: the alt text takes its place)
    await scrollConv(view, '[data-block="quote"]');
    await shot(view, "07-console-image-asked.png");

    step("what the voice said: no code, table, URL, image or symbol");
    await until("the voice done", async () => (await inspect(view)).spoken.some((s) => s.includes("마지막으로")), 20000);
    const spoken = (await inspect(view)).spoken;
    fs.writeFileSync(path.join(SHOTS, "spoken.json"), JSON.stringify(spoken, null, 2));
    console.log(`  spoken (${spoken.length}): ${JSON.stringify(spoken)}`);
    const NEVER = ["npm run build", "echo", "a very long line", "테이블은 읽지", "Mr. Kim", "very-long-cell", "http", "example", "javascript", "__xss", "고양이", "onerror"];
    for (const s of spoken) {
      for (const bad of NEVER) assert.ok(!s.includes(bad), `"${bad}" said: ${s}`);
      assert.doesNotMatch(s, /[*_`#|>[\]<]|\]\(|-{3}|😀/, `a symbol said: ${s}`);
    }
    for (const ok of ["좋아요!", "마크다운 예시를 보여 드릴게요.", "설치는 npm ci 로 해요.", "설치 방법", "인용문이에요.", "마지막으로, 질문 있으면 말씀해 주세요~"])
      assert.ok(spoken.some((s) => s.includes(ok)), `"${ok}" said (${JSON.stringify(spoken)})`);

    // ── the mate chat window ──
    step("the mate chat window (compact) shows the same reply");
    const chat = await desk.newPage();
    await chat.setViewportSize({ width: 460, height: 820 });
    await chat.goto(`${SERVER}/?surface=mate-chat&mate=${mate.id}`);
    await chat.waitForSelector('[data-testid="mate-chat-window"]', { timeout: 20000 });
    await until("history", async () => (await inspect(chat)).blocks.some((b) => b.text.includes("마지막으로")), 15000);
    await sleep(500);
    st = await inspect(chat);
    assertClean(st, "chat window");
    await scrollConv(chat, TURN, -1);
    await shot(chat, "08-chat-window-top.png");
    await scrollConv(chat, '[data-block="list"]');
    await shot(chat, "09-chat-window-middle.png");

    // ── the overlay's caption: plain words only ──
    step("the overlay's caption and the quick card while a second reply streams");
    const overlay = await desk.newPage();
    await overlay.setViewportSize({ width: 360, height: 420 });
    await overlay.goto(`${SERVER}/?surface=mate-overlay&mate=${mate.id}`);
    await overlay.waitForSelector('[data-testid="mate-overlay"]', { timeout: 20000 });
    await overlay.evaluate(() => {
      window.__captions = [];
      setInterval(() => {
        const c = document.querySelector('[data-testid="mate-caption"]')?.innerText;
        if (c && window.__captions[window.__captions.length - 1] !== c) window.__captions.push(c);
      }, 30);
    });
    const quick = await desk.newPage();
    await quick.setViewportSize({ width: 440, height: 640 });
    await quick.goto(`${SERVER}/?surface=mate-quick&mate=${mate.id}`);
    await quick.waitForSelector('[data-testid="mate-quick-card"]', { timeout: 20000 });
    await sleep(1500);
    await send(quick, "md2 a short one");
    await until("the quick card's reply", async () => quick.locator('[data-testid="mate-quick-reply"]').innerText().then((t) => t.includes("끝이에요")), 20000);
    await sleep(1500);
    st = await inspect(quick);
    assertClean(st, "quick card");
    assert.deepEqual(st.codeLangs, ["sh"]);
    await shot(quick, "10-quick-card.png");
    const captions = await overlay.evaluate(() => window.__captions);
    fs.writeFileSync(path.join(SHOTS, "captions.json"), JSON.stringify(captions, null, 2));
    console.log(`  overlay captions: ${JSON.stringify(captions)}`);
    assert.ok(captions.length > 0, "the overlay showed captions");
    for (const c of captions) assert.doesNotMatch(c, /\*\*|`|\]\(|^\s*[-#>|]\s|\[smile\]|make test$/m, `caption: ${c}`);
    await shot(overlay, "11-overlay-caption.png");
    const spoken2 = (await overlay.evaluate(() => window.__spoken)).concat((await inspect(view)).spoken.slice(spoken.length));
    console.log(`  spoken for reply 2: ${JSON.stringify(spoken2)}`);
    assert.ok(!spoken2.some((s) => /make test$|^make/.test(s)), "the sh block is not read");

    // ── a phone ──
    step("a phone: the console's Mate view, compact bubbles");
    const phoneCtx = await context(browser, mate.id, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const phone = await phoneCtx.newPage();
    await phone.goto(`${SERVER}/?view=mate`);
    await until("history on the phone", async () => (await inspect(phone)).blocks.some((b) => b.text.includes("마지막으로")), 20000);
    await sleep(800);
    st = await inspect(phone);
    assertClean(st, "phone");
    await scrollConv(phone, TURN, -2);
    await shot(phone, "12-phone-top.png");
    await scrollConv(phone, '[data-block="list"]');
    await shot(phone, "13-phone-list-code.png");
    await scrollConv(phone, '[data-block="table"]');
    await shot(phone, "14-phone-table-quote.png");
    await phoneCtx.close();
    await desk.close();
    console.log("\nMATE MARKDOWN E2E OK");
  } catch (e) {
    console.error(`\nMATE MARKDOWN E2E FAILED: ${e.stack || e}`);
    process.exitCode = 1;
  } finally {
    if (mateId) {
      try {
        const c = await context(browser, "");
        await c.request.delete(`${SERVER}/api/mates/${mateId}`);
        await c.close();
      } catch {
        /* the server is gone */
      }
    }
    await browser.close();
  }
}

main();
