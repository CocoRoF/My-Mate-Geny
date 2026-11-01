// One voice for a mate's replies, checked in a browser against a real server (backend with
// CLAUDE_BINARY=desktop/test/e2e/fake-claude.py, frontend build as STATIC_DIR):
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node test/e2e/mate-voice-browser.js <server url> <password>
//
// The browser voice (speechSynthesis) is replaced by a stub that records what each page speaks (and "speaks" a
// sentence in 400 ms). Device 1 = one browser context with three pages of one origin: the overlay surface, the mate
// chat surface and the console's Mate view; device 2 = a second context (another device / browser profile).
"use strict";
const assert = require("assert/strict");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD] = process.argv.slice(2);
if (!SERVER || !PASSWORD) {
  console.error("usage: node test/e2e/mate-voice-browser.js <server url> <password>");
  process.exit(2);
}
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
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

// a recording speechSynthesis: window.__spoken = [{ text, at }], 400 ms per sentence, cancel() ends it
const FAKE_TTS = () => {
  window.__spoken = [];
  window.__cancels = 0;
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
      window.__spoken.push({ text: u.text, at: Date.now() });
      setTimeout(() => u.onstart?.(new Event("start")), 0);
      timer = setTimeout(end, 400);
    },
    cancel() {
      window.__cancels++;
      if (cur) end();
    },
    pause() {},
    resume() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
};

const spoken = (p) => p.evaluate(() => window.__spoken.map((s) => s.text)).catch(() => []);
const idxOf = (t) => Number(/sentence number (\d)/.exec(t)?.[1] ?? -1);
const ofReply = (n) => (t) => t.startsWith(`Reply ${n} `);

async function device(browser, mateId) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  await ctx.addInitScript(FAKE_TTS);
  await ctx.addInitScript((id) => localStorage.setItem("hrh_mate_active", id), mateId);
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  return ctx;
}

async function open(ctx, path, ready) {
  const p = await ctx.newPage();
  await p.goto(`${SERVER}${path}`);
  await p.waitForSelector(ready, { timeout: 20000 });
  return p;
}

async function send(p, text) {
  await p.bringToFront();
  const input = p.locator('[data-testid="mate-input"]').first();
  await until("the composer connected", async () => !(await p.locator('[data-testid="mate-send"]').first().isDisabled().catch(() => true)) || true);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

let dump = async () => {};

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    // a mate with the browser voice, reading aloud
    const setup = await device(browser, "");
    const mate = await (await setup.request.post(`${SERVER}/api/mates`, { data: { name: `Voice test ${Date.now() % 10000}` } })).json();
    const patched = await setup.request.patch(`${SERVER}/api/mates/${mate.id}`, { data: { voice: { auto_read: true, tts: { engine: "browser" } } } });
    assert.ok(patched.ok());
    await setup.close();

    const d1 = await device(browser, mate.id);
    step("device 1: the overlay, the mate chat window and the console's Mate view, all on one mate");
    const overlay = await open(d1, `/?surface=mate-overlay&mate=${mate.id}`, '[data-testid="mate-overlay"]');
    const chat = await open(d1, `/?surface=mate-chat&mate=${mate.id}`, '[data-testid="mate-chat-window"]');
    const view = await open(d1, `/?view=mate`, '[data-testid="mate-settings-open"]');
    await sleep(1500); // (connected, elected)
    const pages = { overlay, chat, view };
    dump = async () => {
      for (const [k, p] of Object.entries(pages)) {
        const info = await p.evaluate(() => ({ spoken: window.__spoken.map((x) => x.text), cancels: window.__cancels, text: document.body.innerText.slice(-300), speaks: document.querySelector("[data-speaks]")?.getAttribute("data-speaks") })).catch((e) => String(e));
        console.error(`  [${k}] ${JSON.stringify(info)}`);
      }
    };

    step("a reply is read exactly once, by the overlay (it is on screen)");
    await send(chat, "q1 first question");
    await until("reply 1 read", async () => (await spoken(overlay)).filter(ofReply(1)).length >= 5, 15000);
    await sleep(1200);
    const c1 = {};
    for (const [k, p] of Object.entries(pages)) c1[k] = (await spoken(p)).filter(ofReply(1)).map(idxOf);
    console.log(`  spoken per page: ${JSON.stringify(c1)}`);
    assert.deepEqual(c1.overlay, [1, 2, 3, 4, 5]);
    assert.deepEqual(c1.chat, []);
    assert.deepEqual(c1.view, []);

    step("the overlay closes mid-reply → the most recently used surface goes on from the next sentence");
    await send(chat, "q2 second question");
    await until("2 sentences read", async () => (await spoken(overlay)).filter(ofReply(2)).length >= 2, 15000);
    const before = (await spoken(overlay)).filter(ofReply(2)).map(idxOf);
    await overlay.close();
    delete pages.overlay;
    await until("the rest read", async () => {
      const all = [...(await spoken(chat)), ...(await spoken(view))].filter(ofReply(2)).map(idxOf);
      return all.includes(5);
    }, 15000);
    await sleep(800);
    const after = { chat: (await spoken(chat)).filter(ofReply(2)).map(idxOf), view: (await spoken(view)).filter(ofReply(2)).map(idxOf) };
    console.log(`  overlay read ${JSON.stringify(before)} then closed; then ${JSON.stringify(after)}`);
    const rest = [...after.chat, ...after.view];
    assert.ok(after.chat.length > 0 && after.view.length === 0, "the chat window (used last) took over, alone");
    assert.equal(new Set([...before, ...rest]).size, before.length + rest.length, "no sentence twice");
    assert.ok(rest[0] > before[before.length - 1], "it went on after the last sentence started, not from the start");
    assert.equal(rest[rest.length - 1], 5);

    step("mute in another window (the console) stops the reading where it plays");
    await send(chat, "q3 third question");
    await until("reading", async () => (await spoken(chat)).filter(ofReply(3)).length >= 1, 15000);
    await view.bringToFront();
    await view.locator('[data-testid="mate-read-toggle"]').first().click();
    const at = (await spoken(chat)).filter(ofReply(3)).length;
    await sleep(3500);
    const n3 = (await spoken(chat)).filter(ofReply(3)).length + (await spoken(view)).filter(ofReply(3)).length;
    console.log(`  reply 3: ${at} sentence(s) before the mute, ${n3} in all`);
    assert.ok(n3 <= at + 1, "nothing more read after the mute");
    await view.locator('[data-testid="mate-read-toggle"]').first().click(); // unmute
    await sleep(500);

    step("another device: a reply is read on the device that asked, never on both");
    const d2 = await device(browser, mate.id);
    const other = await open(d2, `/?view=mate`, '[data-testid="mate-settings-open"]');
    await sleep(1500);
    await send(chat, "q4 from device 1");
    await until("reply 4 read on device 1", async () => (await spoken(chat)).filter(ofReply(4)).length >= 5, 15000);
    await sleep(800);
    assert.equal((await spoken(other)).filter(ofReply(4)).length, 0, "device 2 stays quiet");
    assert.equal((await spoken(view)).filter(ofReply(4)).length, 0, "the console of device 1 too (the chat window speaks)");
    await send(other, "q5 from device 2");
    await until("reply 5 read on device 2", async () => (await spoken(other)).filter(ofReply(5)).length >= 5, 15000);
    await sleep(800);
    const d1n = (await spoken(chat)).filter(ofReply(5)).length + (await spoken(view)).filter(ofReply(5)).length;
    assert.equal(d1n, 0, "device 1 stays quiet");
    console.log(`  reply 4 → device 1 only, reply 5 → device 2 only`);

    await d2.close();
    await d1.close();
    await (await device(browser, "")).request.delete(`${SERVER}/api/mates/${mate.id}`);
    console.log("\nMATE VOICE E2E OK");
  } catch (e) {
    console.error(`\nMATE VOICE E2E FAILED: ${e.stack || e}`);
    await dump();
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
