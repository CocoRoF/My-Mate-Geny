// Mate conversation style, memory v2 and the relationship (docs/mate-memory-affinity.md), checked in a browser
// against a real server (backend with CLAUDE_BINARY=desktop/test/e2e/fake-claude.py, frontend build as STATIC_DIR):
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> FAKE_CLAUDE_LOG=<backend HOME>/fake-claude-turns.jsonl \
//     node test/e2e/mate-affinity-browser.js <server url> <password> [<screenshot dir>]
//
// Settings tabs work and persist; a setting changes what the engine receives (system prompt + the per-turn
// <context> block, read back from the fake CLI's log); memories with kinds / importance / dates, edit, search,
// recall test; the mate's own memory tools through the real MCP bridge (the fake CLI runs `tool:<name> {…}`);
// the relationship tab; changes reaching a second window live. Screenshots: en + ko, desktop + phone.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS] = process.argv.slice(2);
const LOG = process.env.FAKE_CLAUDE_LOG;
if (!SERVER || !PASSWORD || !LOG) {
  console.error("usage: FAKE_CLAUDE_LOG=<file> node test/e2e/mate-affinity-browser.js <server url> <password> [<shots dir>]");
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
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}
const turns = () =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

async function context(browser, { lang, phone, mateId }) {
  const ctx = await browser.newContext(
    phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 } },
  );
  await ctx.addInitScript(
    ([l, id]) => {
      localStorage.setItem("hrh_lang", l);
      localStorage.setItem("hrh_mate_muted", "1");
      if (id) localStorage.setItem("hrh_mate_active", id);
    },
    [lang, mateId],
  );
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  return ctx;
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

async function main() {
  fs.writeFileSync(LOG, ""); // (the fake CLI logs what it receives once the file exists)
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  try {
    const setup = await context(browser, { lang: "en" });
    const mates = await (await setup.request.get(`${SERVER}/api/mates`)).json();
    const mate = mates.find((m) => m.is_default) ?? mates[0];
    assert.ok(mate.relation && mate.prefs, "the mate document carries prefs and the relationship summary");
    await setup.close();

    // ---------- English, desktop ----------
    const en = await context(browser, { lang: "en", mateId: mate.id });
    const a = await openMate(en);
    const b = await openMate(en); // a second window of the same browser (and the server's push for other devices)

    step("Conversation style → How she calls you: your name, an address chip, the Korean forms preview; saved and kept");
    await a.bringToFront();
    await settingsTab(a, "style");
    await a.fill('[data-testid="mate-user-name"]', "현석");
    await a.locator('[data-testid="mate-address-chips"] button', { hasText: /^현석$/ }).click();
    const forms = await a.textContent('[data-testid="mate-address-forms"]');
    assert.match(forms, /현석이|현석은/, forms);
    await a.click('[data-testid="mate-settings-save"]');
    await until("profile saved", async () => (await (await a.request.get(`${SERVER}/api/mates/${mate.id}`)).json()).prefs.user_name === "현석");

    step("Conversation style: casual speech, short replies, expressive emotion → saved; the forms follow the level");
    await settingsTab(a, "style");
    await a.click('[data-testid="mate-style-formality"] [data-value="banmal"]');
    await a.click('[data-testid="mate-style-length"] [data-value="short"]');
    await a.click('[data-testid="mate-style-emotion"] [data-value="3"]');
    await a.click('[data-testid="mate-style-humor"] [data-value="high"]');
    await a.click('[data-testid="mate-style-try"]');
    assert.match(await a.textContent('[data-testid="mate-style-tried"]'), /3/);
    await shot(a, "en-desktop-style");
    await a.click('[data-testid="mate-settings-save"]');
    await until("style saved", async () => (await (await a.request.get(`${SERVER}/api/mates/${mate.id}`)).json()).prefs.formality === "banmal");
    await a.reload();
    await a.waitForSelector('[data-testid="mate-settings-open"]');
    await settingsTab(a, "style");
    assert.equal(await a.getAttribute('[data-testid="mate-style-formality"] [data-value="banmal"]', "aria-checked"), "true", "kept after a reload");
    assert.match(await a.textContent('[data-testid="mate-address-forms"]'), /현석이가 · 현석이는 · 현석이를/);

    step("Memory: add with kinds, importance and a date; similar → merge banner; edit in place; search; pin");
    await settingsTab(a, "memory");
    const addMem = async (text, kind, imp, due) => {
      await a.fill('[data-testid="mate-memory-input"]', text);
      await a.selectOption('[data-testid="mate-memory-kind"]', kind);
      await a.locator('[data-testid="mate-memory-importance"] button').nth(imp - 1).click();
      if (due) await a.fill('[data-testid="mate-memory-due"]', due);
      await a.click('[data-testid="mate-memory-add"]');
      await sleep(400);
    };
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await addMem("Dentist appointment at 3 pm", "plan", 4, tomorrow);
    await addMem("Likes reports as three bullet points", "preference", 5);
    await addMem("The cat is called Nabi", "fact", 3);
    await addMem("Likes reports as three short bullet points", "preference", 3);
    await a.waitForSelector('[data-testid="mate-memory-merged"], [data-testid="mate-memory-similar"]');
    if (await a.locator('[data-testid="mate-memory-similar"]').count()) await a.click('[data-testid="mate-memory-merge"]');
    await until("three memories", async () => (await a.locator('[data-testid="mate-memory-item"]').count()) === 3);
    const cat = a.locator('[data-testid="mate-memory-item"]', { hasText: "Nabi" });
    await cat.locator('[data-testid="mate-memory-text"]').click();
    await a.fill('[data-testid="mate-memory-edit"]', "The cat is called Nabi; she is three");
    await a.press('[data-testid="mate-memory-edit"]', "Enter");
    await until("edited", async () => (await a.locator('[data-testid="mate-memory-item"]', { hasText: "she is three" }).count()) === 1);
    await a.locator('[data-testid="mate-memory-item"]', { hasText: "bullet" }).locator('[data-testid="mate-memory-item-pin"]').click();
    await until("pinned", async () => (await a.locator('[data-testid="mate-memory-item"]', { hasText: "bullet" }).locator('[data-testid="mate-memory-item-pin"]').getAttribute("aria-pressed")) === "true");
    await a.fill('[data-testid="mate-memory-search"]', "dentist");
    await until("search", async () => (await a.locator('[data-testid="mate-memory-item"]').count()) === 1);
    await a.fill('[data-testid="mate-memory-search"]', "");
    await a.click('[data-testid="mate-memory-kinds"] [data-kind="plan"]');
    await until("kind filter", async () => (await a.locator('[data-testid="mate-memory-item"]').count()) === 1);
    assert.match(await a.textContent('[data-testid="mate-memory-due-chip"]'), new RegExp(tomorrow));
    await a.click('[data-testid="mate-memory-kinds"] [data-kind="all"]');
    await until("all kinds", async () => (await a.locator('[data-testid="mate-memory-item"]').count()) === 3);

    step("Test recall shows the exact context block");
    await a.fill('[data-testid="mate-memory-probe"]', "when is the dentist?");
    await a.click('[data-testid="mate-memory-probe-run"]');
    const block = await a.textContent('[data-testid="mate-memory-preview"] pre', { timeout: 10000 });
    assert.match(block, /^<context>\nNow: /);
    await shot(a, "en-desktop-memory");

    step("the second window followed the memory edits (server push)");
    await b.bringToFront();
    await settingsTab(b, "memory");
    await until("second window sees the edit", async () => (await b.locator('[data-testid="mate-memory-item"]', { hasText: "she is three" }).count()) === 1);

    step("a message: the engine gets the settings in its system prompt and the per-turn context block");
    await a.bringToFront();
    await a.click('[data-testid="mate-settings-close"]');
    const before = turns().length;
    await send(a, "hi there, how was your day?");
    await until("the fake CLI got the turn", async () => turns().length > before, 30000);
    const t1 = turns().at(-1);
    assert.match(t1.system_prompt, /반말/);
    assert.match(t1.system_prompt, /one or two at most/);
    assert.match(t1.system_prompt, /Humor: playful/);
    assert.match(t1.system_prompt, /Call the user “현석”\./); // (no grammar notes: the user's decision)
    assert.doesNotMatch(t1.system_prompt, /현석이가|현석아/);
    assert.equal((t1.system_prompt.match(/## How you talk/g) || []).length, 1, "one How-you-talk section");
    assert.match(t1.system_prompt, /## Between you and the user/);
    assert.match(t1.text, /^<context>\nNow: /);
    console.log(`  context block: ${JSON.stringify(t1.text.split("</context>")[0])}`);

    step("the mate's own memory tools through the real MCP bridge");
    await send(a, `tool:remember {"text": "Prefers tea over coffee", "kind": "preference", "importance": 4}`);
    await until("remembered", async () => (await (await a.request.get(`${SERVER}/api/mates/${mate.id}/memories?q=tea`)).json()).length === 1, 30000);
    const tea = (await (await a.request.get(`${SERVER}/api/mates/${mate.id}/memories?q=tea`)).json())[0];
    assert.equal(tea.kind, "preference");
    assert.equal(tea.source, "mate");
    await sleep(800);
    await send(a, `tool:update_memory {"id": "${tea.id}", "text": "Prefers green tea over coffee"}`);
    await until("updated", async () => (await (await a.request.get(`${SERVER}/api/mates/${mate.id}/memories?q=green`)).json()).length === 1, 30000);
    await sleep(800);
    await send(a, `tool:recall {"query": "dentist"}`);
    await until("recall answered", async () => /Tool recall:[^]*Dentist appointment/.test(await a.textContent("body")), 30000);
    await b.bringToFront();
    await until("second window lists the mate's memory", async () => (await b.locator('[data-testid="mate-memory-item"]', { hasText: "green tea" }).count()) === 1, 15000);
    await sleep(800);
    await a.bringToFront();
    const before2 = turns().length;
    await send(a, "should I have tea or coffee?");
    await until("next turn", async () => turns().length > before2, 30000);
    const t2 = turns().at(-1).text;
    console.log(`  next context: ${JSON.stringify(t2.split("</context>")[0])}`);

    step("Relationship: the tab, set by hand → the server has it and the second window's mate follows");
    await settingsTab(a, "relation");
    await a.waitForSelector('[data-testid="mate-relation-status"]');
    const status = await a.textContent('[data-testid="mate-relation-status"]');
    assert.match(status, /day 1 together/, status);
    await a.$eval('[data-testid="mate-relation-slider"]', (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, "62");
    await a.click('[data-testid="mate-relation-set"]');
    const affinityIn = (page) => page.evaluate(async () => {
      const mates = await (await fetch("/api/mates")).json();
      return mates.find((m) => m.builtin === "chaerin")?.relation?.affinity;
    });
    await until("value set", async () => (await affinityIn(a)) === 62);
    await b.bringToFront();
    await until("second window follows", async () => (await affinityIn(b)) === 62, 15000);
    await a.bringToFront();
    await a.locator('[data-testid="mate-relation-log"] summary').click();
    assert.match(await a.textContent('[data-testid="mate-relation-log"]'), /Set by hand/);
    await shot(a, "en-desktop-relationship");
    await a.click('[data-testid="mate-settings-close"]');
    await shot(a, "en-desktop-header");
    await en.close();

    // ---------- the rest of the screenshots: en phone, ko desktop, ko phone ----------
    for (const [lang, phone, tag] of [["en", true, "en-phone"], ["ko", false, "ko-desktop"], ["ko", true, "ko-phone"]]) {
      step(`screenshots: ${tag}`);
      const ctx = await context(browser, { lang, phone, mateId: mate.id });
      const p = await openMate(ctx);
      await sleep(800);
      await shot(p, `${tag}-header`);
      for (const tab of ["profile", "style", "memory", "relation"]) {
        await settingsTab(p, tab);
        await sleep(500);
        if (tab === "relation") await p.locator('[data-testid="mate-relation-log"] summary').click();
        await shot(p, `${tag}-${tab}`);
      }
      if (lang === "ko") {
        await settingsTab(p, "style");
        const ko = await p.textContent('[data-testid="mate-style-call"]');
        assert.match(ko, /부르는 법/, "Korean UI");
      }
      await ctx.close();
    }
    console.log("OK");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
