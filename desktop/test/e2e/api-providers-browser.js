// API-key providers in a browser (docs/api-engines.md), against a throwaway server whose vendors are fakes:
//
//   python3 desktop/test/e2e/api-providers-server.py 18977 18978 <frontend dist> <workspace> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/api-providers-browser.js http://127.0.0.1:18977 http://127.0.0.1:18978 api-test-only <workspace> <shots>
//
// Checks: Settings → Providers → Anthropic: a key is added and tested, a refused key says so, the model list comes from
// the API with the main models on, a model can be switched on and priced; New chat offers the provider; a chat on it runs
// a tool and answers, with the tool card, the context meter and the turn's cost. English light and Korean dark, desktop
// and phone.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, FAKE, PASSWORD, WORK, SHOTS] = process.argv.slice(2);
if (!SERVER || !FAKE || !PASSWORD || !WORK || !SHOTS) {
  console.error("usage: node api-providers-browser.js <server> <fake vendors> <password> <workspace> <shots dir>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const step = (s) => console.log(`• ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30000) {
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
async function context(browser, { lang = "en", theme = "light", phone = false } = {}) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 },
    colorScheme: theme, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(([l, th]) => {
    localStorage.setItem("hrh_lang", l);
    localStorage.setItem("hrh_theme", th);
    localStorage.setItem("hrh_setup_seen_v2", "1");
    localStorage.setItem("hrh_session_panel", "0");
  }, [lang, theme]);
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  return ctx;
}
const api = async (ctx, method, url, data) => {
  const r = await ctx.request.fetch(SERVER + url, { method, data, headers: { "Content-Type": "application/json" } });
  assert.ok(r.ok(), `${method} ${url}: ${r.status()}`);
  return r.json();
};
const fake = async (ctx, url, data) => (await ctx.request.post(FAKE + url, { data })).json();

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox"] });
  const errors = [];
  try {
    const ctx = await context(browser);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));

    step("Settings → Providers → Anthropic: no key yet");
    await p.goto(`${SERVER}/?view=settings&tab=providers`);
    await p.getByRole("button", { name: /Anthropic/ }).first().click();
    const panel = p.locator('[data-testid="api-provider-anthropic"]');
    await panel.waitFor();
    assert.match(await panel.textContent(), /No Anthropic key yet/);

    step("a key is added and tested; the model list comes from the API, the main models on");
    await p.click('[data-testid="api-key-add"]');
    await p.fill('input[placeholder^="Name"]', "Work");
    await p.fill('[data-testid="api-key-input"]', "sk-ant-e2e-good");
    await p.click('[data-testid="api-key-save"]');
    await until("the key row", async () => (await p.locator('[data-testid="api-key-row"]').count()) === 1);
    await p.locator('[data-testid="key-check-ok"]').waitFor();
    await until("the models", async () => (await p.locator('[data-testid="api-model-row"]').count()) === 4);
    const pressed = await p.locator('[data-testid="api-model-toggle"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed")));
    assert.deepEqual(pressed, ["true", "true", "true", "false"]);
    assert.match(await p.locator('[data-testid="api-models"]').textContent(), /3 of 4 on/);

    step("a refused key says so");
    await fake(ctx, "/__bad_key", { key: "sk-ant-e2e-bad" });
    await p.click('[data-testid="api-key-add"]');
    await p.fill('[data-testid="api-key-input"]', "sk-ant-e2e-bad");
    await p.click('[data-testid="api-key-save"]');
    await p.locator('[data-testid="key-check-error"]').first().waitFor();
    assert.match(await p.locator('[data-testid="key-check-error"]').first().textContent(), /refused/);
    await p.getByRole("button", { name: "Cancel" }).click();

    step("a model is switched on and given a price");
    await p.locator('[data-testid="api-model-toggle"]').nth(3).click();
    await until("it is on", async () => (await p.locator('[data-testid="api-model-toggle"]').nth(3).getAttribute("aria-pressed")) === "true");
    await p.locator('[data-testid="api-model-row"]').nth(3).getByRole("button", { name: /Edit name, price/ }).click();
    const editor = p.locator('[data-testid="api-model-row"]').nth(3);
    await editor.getByLabel("Input $", { exact: true }).fill("6");
    await editor.getByLabel("Output $", { exact: true }).fill("30");
    await editor.getByRole("button", { name: "Save" }).click();
    await until("the price", async () => /\$6 \/ \$30/.test(await editor.textContent()));
    await p.screenshot({ path: path.join(SHOTS, "settings-en-light.png"), fullPage: true });

    step("New chat offers Anthropic");
    await p.goto(`${SERVER}/`);
    const anthropic = p.getByRole("button", { name: /Anthropic/ }).first();
    await anthropic.waitFor();
    assert.equal(await anthropic.isDisabled(), false);
    await p.screenshot({ path: path.join(SHOTS, "new-chat-en-light.png") });

    step("a chat on it runs a tool and answers, with its card, context and cost");
    const s = await api(ctx, "POST", "/api/sessions", { provider: "anthropic", model: "claude-opus-5-5", workspace_path: WORK, title: "API chat" });
    await fake(ctx, "/__script/anthropic", [
      { blocks: [{ type: "thinking", text: "I'll check the folder." }, { type: "text", text: "Checking." },
                 { type: "tool_use", name: "Bash", input: { command: "echo hello-from-bash", description: "Say hello" } }],
        usage: { input: 3000, cached: 1000, output: 80 } },
      { blocks: [{ type: "text", text: "All done: hello-from-bash" }], usage: { input: 200, cached: 4000, output: 20 } },
    ]);
    await p.goto(`${SERVER}/?view=chat&session=${s.id}`);
    const box = p.locator("textarea").first();
    await box.waitFor();
    await box.fill("say hello from bash");
    await box.press("Enter");
    await p.getByText("All done: hello-from-bash").waitFor({ timeout: 30000 });
    await p.getByText("Say hello").first().waitFor();
    const meters = await p.locator('[data-testid="chat-meters"]').textContent();
    assert.match(meters, /ctx/);
    const turn = await until("the turn's cost", async () => {
      const events = await api(ctx, "GET", `/api/sessions/${s.id}/events`);
      return events.find((e) => e.type === "turn.complete");
    });
    assert.equal(turn.data.cost_kind, "turn");
    assert.ok(turn.data.cost_usd > 0);
    await p.screenshot({ path: path.join(SHOTS, "chat-en-light.png") });

    step("Korean, dark, phone: the provider panel fits");
    const ko = await context(browser, { lang: "ko", theme: "dark", phone: true });
    const q = await ko.newPage();
    q.on("pageerror", (e) => errors.push(e.message));
    await q.goto(`${SERVER}/?view=settings&tab=providers`);
    await q.getByRole("button", { name: /Anthropic/ }).first().click();
    await q.locator('[data-testid="api-provider-anthropic"]').waitFor();
    await until("the models", async () => (await q.locator('[data-testid="api-model-row"]').count()) === 4);
    const overflow = await q.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no sideways scroll (${overflow}px)`);
    await q.screenshot({ path: path.join(SHOTS, "settings-ko-dark-phone.png"), fullPage: true });

    assert.deepEqual(errors, [], "no page errors");
    console.log("OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
