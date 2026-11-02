// The conversation style as the one place for how the mate talks, and the mate changing it herself
// (docs/mate.md "Prompt composition"), in a browser against a real server (backend with
// CLAUDE_BINARY=desktop/test/e2e/fake-claude.py, the frontend build as STATIC_DIR):
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node test/e2e/mate-style-browser.js <server url> <password> [<screenshot dir>]
//
// Profile holds the character only; Conversation style holds everything about how she talks (with her own speech
// level shown as "As her character (…)"). "앞으로 반말로 해" → the fake CLI calls update_conversation_style through
// the real MCP bridge → the change shows live in a second window's Conversation style tab and as a chip in the
// conversation; Undo there puts it back (both windows follow); "Ask me first" makes her change a proposal the user
// applies; a memory that is really a style rule is flagged in the Memory tab. Screenshots: en + ko, light + dark.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD) {
  console.error("usage: node test/e2e/mate-style-browser.js <server url> <password> [<shots dir>]");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
async function until(what, fn, ms = 25000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

async function context(browser, { lang, mateId, theme = "light" }) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: theme });
  await ctx.addInitScript(
    ([l, id, th]) => {
      localStorage.setItem("hrh_lang", l);
      localStorage.setItem("hrh_mate_muted", "1");
      localStorage.setItem("hrh_theme", th);
      if (id) localStorage.setItem("hrh_mate_active", id);
    },
    [lang, mateId, theme],
  );
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.request.put(`${SERVER}/api/preferences`, { data: { language: null } }).catch(() => {});
  return ctx;
}

async function api(ctx, method, url, body) {
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function openMate(ctx) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.error(`  [pageerror] ${e.message}`));
  await p.goto(`${SERVER}/?view=mate`);
  await p.waitForSelector('[data-testid="mate-settings-open"]', { timeout: 30000 });
  return p;
}

async function settingsTab(p, tab) {
  if (!(await p.locator('[data-testid="mate-settings"]').count())) await p.click('[data-testid="mate-settings-open"]');
  await p.click(`[data-testid="mate-tab-${tab}"]`);
  await sleep(300);
}

async function closeSettings(p) {
  if (await p.locator('[data-testid="mate-settings"]').count()) await p.click('[data-testid="mate-settings-close"]');
  await sleep(200);
}

async function shot(p, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  console.log(`  screenshot ${name}.png`);
}

async function send(p, text) {
  const input = p.locator('[data-testid="mate-input"]').first();
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

const checked = (p, group, value) => p.getAttribute(`[data-testid="${group}"] [data-value="${value}"]`, "aria-checked");

async function round(browser, lang, theme, mate) {
  const tag = `${lang}-${theme}`;
  const ctx = await context(browser, { lang, mateId: mate.id, theme });
  // fresh state for this round: her own style, a clean conversation, no history
  await api(ctx, "PATCH", `/api/mates/${mate.id}`, { prefs: { formality: "auto", address: "", length: "normal", self_edit: "auto", user_name: "장하렴" } });
  await api(ctx, "POST", `/api/mates/${mate.id}/conversation/reset`).catch(() => {});
  const a = await openMate(ctx); // the conversation
  const b = await openMate(ctx); // a second window with the Conversation style tab open

  step(`${tag}: Profile is the character only; Conversation style shows her own speech level and address`);
  await b.bringToFront();
  await settingsTab(b, "profile");
  assert.equal(await b.locator('[data-testid="mate-persona-speech"], [data-testid="mate-persona-address"], [data-testid="mate-user-name"]').count(), 0);
  await b.waitForSelector('[data-testid="mate-profile-character-note"]');
  await shot(b, `${tag}-profile`);
  await settingsTab(b, "style");
  assert.equal(await checked(b, "mate-style-formality", "auto"), "true");
  const autoLabel = await b.textContent('[data-testid="mate-style-formality"] [data-value="auto"]');
  assert.match(autoLabel, lang === "ko" ? /캐릭터대로 \(.*해요체/ : /As her character \(.*해요체/, autoLabel);
  assert.match(await b.getAttribute('[data-testid="mate-address"]', "placeholder"), /장하렴 님/);
  await shot(b, `${tag}-style-before`);

  step(`${tag}: “앞으로 반말로 해” → she changes it herself: chip in the conversation, live in the other window`);
  await a.bringToFront();
  await closeSettings(a);
  await send(a, "앞으로 반말로 해");
  const chip = a.locator('[data-testid="mate-style-change"]').last();
  await until("the chip with Undo", async () => (await chip.getAttribute("data-status")) === "applied", 30000);
  const chipText = await chip.innerText();
  assert.match(chipText, lang === "ko" ? /대화 방식 변경: 말투 높낮이 → 반말/ : /Conversation style: Speech level → Casual \(반말\)/, chipText);
  await until("the other window follows", async () => (await checked(b, "mate-style-formality", "banmal")) === "true");
  await b.waitForSelector('[data-testid="mate-style-history-item"][data-status="applied"]');
  await shot(a, `${tag}-chat-chip`);
  await b.bringToFront();
  await b.locator('[data-testid="mate-style-self"]').scrollIntoViewIfNeeded();
  await shot(b, `${tag}-style-after`);
  const m1 = await api(ctx, "GET", `/api/mates/${mate.id}`);
  assert.equal(m1.prefs.formality, "banmal");

  step(`${tag}: Undo on the chip → back to her own level, in both windows`);
  await a.bringToFront();
  await chip.locator('[data-testid="mate-style-undo"]').click();
  await until("undone", async () => (await chip.getAttribute("data-status")) === "undone");
  await until("the other window follows the undo", async () => (await checked(b, "mate-style-formality", "auto")) === "true");
  await shot(a, `${tag}-chat-undone`);
  assert.equal((await api(ctx, "GET", `/api/mates/${mate.id}`)).prefs.formality, "auto");

  step(`${tag}: “Ask me first” → her change is a proposal; Apply makes it`);
  await b.bringToFront();
  await b.click('[data-testid="mate-style-self-edit"] [data-value="ask"]');
  await b.click('[data-testid="mate-settings-save"]');
  await until("ask saved", async () => (await api(ctx, "GET", `/api/mates/${mate.id}`)).prefs.self_edit === "ask");
  await a.bringToFront();
  await send(a, 'ctool:update_conversation_style {"length": "short", "reason": "keep it short from now on"}');
  const prop = a.locator('[data-testid="mate-style-change"]').last();
  await until("a proposal", async () => (await prop.getAttribute("data-status")) === "proposed", 30000);
  assert.equal((await api(ctx, "GET", `/api/mates/${mate.id}`)).prefs.length, "normal", "nothing changes before Apply");
  await shot(a, `${tag}-chat-proposal`);
  await prop.locator('[data-testid="mate-style-apply"]').click();
  await until("applied", async () => (await api(ctx, "GET", `/api/mates/${mate.id}`)).prefs.length === "short");
  await until("the other window shows it", async () => (await checked(b, "mate-style-length", "short")) === "true");

  step(`${tag}: a memory that is a style rule is flagged in the Memory tab (move / keep)`);
  const mem = await api(ctx, "POST", `/api/mates/${mate.id}/memories`, { text: "사용자는 반말로 대화하는 걸 좋아한다", kind: "preference" });
  await b.bringToFront();
  await settingsTab(b, "memory");
  const item = b.locator(`[data-testid="mate-memory-item"][data-id="${mem.id}"]`);
  await item.locator('[data-testid="mate-memory-style-flag"]').waitFor();
  await shot(b, `${tag}-memory-flag`);
  await item.locator('[data-testid="mate-memory-style-ok"]').click();
  await until("the hint goes", async () => (await item.locator('[data-testid="mate-memory-style-flag"]').count()) === 0);
  await api(ctx, "DELETE", `/api/mates/${mate.id}/memories/${mem.id}`);
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  try {
    const setup = await context(browser, { lang: "en" });
    const mates = await api(setup, "GET", "/api/mates");
    const mate = mates.find((m) => m.builtin === "chaerin");
    assert.ok(mate, "the built-in 한채린");
    assert.equal(mate.prefs.defaults.formality, "haeyo");
    assert.ok(!("speech" in mate.persona) && !("address" in mate.persona), "persona = the character only");
    await setup.close();
    await round(browser, "en", "light", mate);
    await round(browser, "ko", "dark", mate);
    console.log("OK");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
