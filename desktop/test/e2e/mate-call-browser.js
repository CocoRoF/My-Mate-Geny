// A phone call with her in a real browser on a phone-sized page, against a throwaway server (docs/mate-calls.md):
//
//   python3 -P desktop/test/e2e/session-rewind-server.py <port> <frontend dist> <workdir>   (fake-claude.py as every engine)
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> node desktop/test/e2e/mate-call-browser.js <server url> <password> [shots dir]
//
// The header's 📞 → the call screen (연결 중.. while it rings back, then 통화 중 00:0x from her first sound), her words as
// captions, what the user says (window.__hrhCall.say: this page has no speech recognition, which the screen says
// plainly) answered, the pill while the chat is read, hanging up → one call card in the conversation (transcript
// folded) and her own engine's note after it. Light and dark, a small phone, her ringing (the incoming screen).
// The browser voice is a stub that "speaks" each sentence for 400 ms. Prints MEASURE lines.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD) {
  console.error("usage: node desktop/test/e2e/mate-call-browser.js <server url> <password> [shots dir]");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
async function until(what, fn, ms = 20000, every = 100) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}
const PHONE = (w = 390, h = 844) => ({
  viewport: { width: w, height: h },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
});

async function context(browser, { theme = "dark", size } = {}) {
  const ctx = await browser.newContext({ ...PHONE(...(size || [])), colorScheme: theme });
  await ctx.addInitScript(([th]) => {
    localStorage.setItem("hrh_setup_seen_v2", "1");
    localStorage.setItem("hrh_lang", "ko");
    localStorage.setItem("hrh_theme", th);
    // no recognition in this page (as in the Android WebView without a server engine)
    delete window.webkitSpeechRecognition;
    delete window.SpeechRecognition;
    // the browser voice: "speaks" each sentence for 400 ms
    window.__spoken = [];
    const synth = {
      speaking: false,
      getVoices: () => [],
      cancel() {},
      speak(u) {
        if (!u.text) return;
        window.__spoken.push({ text: u.text, at: Date.now() });
        setTimeout(() => u.onstart && u.onstart(), 30);
        setTimeout(() => u.onend && u.onend(), 430);
      },
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  }, [theme]);
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.request.put(`${SERVER}/api/preferences`, { data: { language: "ko" } }).catch(() => {});
  return ctx;
}

async function shot(p, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await sleep(350); // (after the screen's fade-in)
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function openMate(ctx) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.error(`  [pageerror] ${e.message}`));
  p.on("console", (m) => m.type() === "error" && console.error(`  [console] ${m.text()}`));
  p.on("websocket", (ws) => {
    if (!ws.url().includes("mate-calls")) return;
    ws.on("framereceived", (f) => process.env.CALL_WS_LOG && console.log(`  [ws<] ${String(f.payload).slice(0, 160)}`));
    ws.on("close", () => console.log("  [ws] call line closed"));
  });
  await p.goto(`${SERVER}/?view=mate`);
  await p.waitForSelector('[data-testid="mate-call"]', { timeout: 30000 });
  return p;
}

const status = (p) => p.locator('[data-testid="call-status"]').innerText();

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    // ── calling her (dark) ──
    let ctx = await context(browser, { theme: "dark" });
    let p = await openMate(ctx);
    step("the 📞 in the header opens the call screen; it rings back until her first sound");
    const t0 = Date.now();
    await p.tap('[data-testid="mate-call"]');
    await p.waitForSelector('[data-testid="call-screen"]');
    assert.match(await status(p), /연결 중/);
    await shot(p, "call-dialing-dark");
    await until("통화 중", async () => /통화 중 \d\d:\d\d/.test(await status(p)), 30000).catch(async (e) => {
      const s = await p.evaluate(() => {
        const x = window.__hrhCall.store.getState();
        return { phase: x.phase, call: x.call, plan: x.plan, caption: x.caption, notice: x.notice, deaf: x.deaf, error: x.error, spoken: window.__spoken };
      });
      console.error("state:", JSON.stringify(s));
      throw e;
    });
    console.log(`MEASURE ${JSON.stringify({ dial_to_first_sound_ms: Date.now() - t0 })}`);
    await until("her greeting caption", async () => (await p.locator('[data-testid="call-caption"]').count()) > 0);
    const notice = await p.locator('[data-testid="call-notice"]').innerText().catch(() => "");
    assert.match(notice, /음성 인식/, "no recognition here: said plainly");
    await shot(p, "call-active-dark");

    step("what the user says is answered: her reply streams, sentence by sentence");
    // (after her hello, as on a phone: the fake engine says 5 sentences, 0.7 s apart)
    await until("her hello said", async () => (await p.evaluate(() => window.__spoken.length)) >= 5, 15000);
    await sleep(500);
    const asked = Date.now();
    await p.evaluate(() => window.__hrhCall.say("오늘 뭐 했어?"));
    const first = await until("her answer", async () => {
      const s = await p.evaluate(() => window.__spoken.map((x) => x.text));
      return s.find((x) => /Reply 2/.test(x)) ? Date.now() : null;
    });
    console.log(`MEASURE ${JSON.stringify({ say_to_first_sound_ms: first - asked, engine: "fake-claude (0.7 s to its first sentence)" })}`);

    step("the call folds into a pill while the chat is read, and comes back");
    await p.tap('[data-testid="call-minimize"]');
    await p.waitForSelector('[data-testid="call-pill"]');
    await shot(p, "call-pill-dark");
    await p.tap('[data-testid="call-pill"] button >> nth=0');
    await p.waitForSelector('[data-testid="call-screen"]');

    step("mute and speaker toggle");
    await p.tap('[data-testid="call-mute"]');
    assert.equal(await p.getAttribute('[data-testid="call-mute"]', "aria-pressed"), "true");
    await p.tap('[data-testid="call-speaker"]');
    assert.equal(await p.getAttribute('[data-testid="call-speaker"]', "aria-pressed"), "false");
    await p.tap('[data-testid="call-mute"]');

    step("hanging up: the end shows, then one call card in her conversation and her note after it");
    const cardsBefore = await p.locator('[data-testid="mate-call-card"]').count();
    const turnsBefore = await p.locator('[data-testid="mate-turn"]').count();
    await p.tap('[data-testid="call-end"]');
    await until("the end", async () => /통화 종료/.test(await status(p).catch(() => "")) || (await p.locator('[data-testid="call-screen"]').count()) === 0, 5000);
    await p.waitForSelector('[data-testid="call-screen"]', { state: "detached", timeout: 6000 });
    await until("the call's card", async () => (await p.locator('[data-testid="mate-call-card"]').count()) > cardsBefore, 15000);
    assert.equal(await p.locator('[data-testid="mate-call-card"]').last().getAttribute("data-status"), "talked");
    await until("her note after the call", async () => (await p.locator('[data-testid="mate-turn"]').count()) > turnsBefore, 25000);
    await p.locator('[data-testid="mate-call-transcript-toggle"]').last().tap();
    const lines = await p.locator('[data-testid="mate-call-transcript"]').last().locator('p').allInnerTexts();
    assert.ok(lines.some((l) => /오늘 뭐 했어/.test(l)), "the user's words are in the transcript");
    await shot(p, "call-card-dark");
    await ctx.close();

    // ── light, a small phone; her ringing ──
    ctx = await context(browser, { theme: "light", size: [360, 640] });
    p = await openMate(ctx);
    step("light theme, a small phone");
    await p.tap('[data-testid="mate-call"]');
    await until("통화 중 (light)", async () => /통화 중/.test(await status(p)), 30000);
    const box = await p.locator('[data-testid="call-end"]').boundingBox();
    assert.ok(box && box.y + box.height <= 640, "the buttons fit a small phone");
    await shot(p, "call-active-light-small");
    await p.tap('[data-testid="call-end"]');
    await p.waitForSelector('[data-testid="call-screen"]', { state: "detached", timeout: 6000 });

    step("her ringing: the incoming screen (accept / decline)");
    const mate = await p.evaluate(async () => (await (await fetch("/api/mates")).json())[0]);
    await p.evaluate((m) => window.__hrhCall.store.getState().incoming({
      id: "call_preview", mate_id: m.id, name: m.name, session_id: m.session_id, direction: "incoming", status: "ringing",
      device: "", reason: "lonely", created_at: new Date().toISOString(), answered_at: null, ended_at: null, end_reason: "",
      error: "", model: "claude-haiku-5-5", engine: "",
    }), mate);
    await p.waitForSelector('[data-testid="call-incoming"]');
    await shot(p, "call-incoming-light-small");
    await p.tap('[data-testid="call-decline"]');
    await p.waitForSelector('[data-testid="call-incoming"]', { state: "detached", timeout: 6000 });
    await ctx.close();
    console.log("OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
