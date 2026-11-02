// Higgsfield (docs/higgsfield.md) in a browser against a real server on THIS machine, with Higgsfield itself faked by
// desktop/test/e2e/higgsfield-stub.py (OAuth + account gateway + skills archive) and the agent by fake-claude.py:
//
//   python3 -P desktop/test/e2e/higgsfield-stub.py 18968 &
//   backend with CLAUDE_BINARY=desktop/test/e2e/fake-claude.py HIGGSFIELD_BINARY=<a real higgsfield CLI>
//     HIGGSFIELD_AUTHORIZE_URL=<stub>/oauth/authorize HIGGSFIELD_TOKEN_URL=<stub>/oauth/token
//     HIGGSFIELD_API_BASE=<stub>/fnf/developer/v2alpha HIGGSFIELD_SKILLS_URL=<stub>/skills.tar.gz
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium> \
//     node desktop/test/e2e/higgsfield-browser.js <server url> <password> <stub url> <shots dir> <workspace dir>
//
// Checks: the Providers tab's Higgsfield tab (empty → connect); the connect dialog's error states (not a callback
// address, a stale state, a bad credentials.json); the paste flow end to end (link → stub sign-in → pasted localhost
// address → account with email, plan, credits, workspaces); installing the skills; a chat whose agent (fake CLI)
// runs the real `higgsfield auth token` with the server's access-only credentials file, the spend notice after it;
// the chat's switch turning that off (the next turn has no credentials); Usage's Higgsfield card. Screenshots in
// light and dark, English and Korean.
"use strict";
const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, STUB, SHOTS, WORKSPACE] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !STUB || !SHOTS || !WORKSPACE) {
  console.error("usage: node higgsfield-browser.js <server url> <password> <stub url> <shots dir> <workspace dir>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);

async function until(what, fn, ms = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out: ${what}`);
}

async function device(browser, { lang = "en", theme = "dark" } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  const r = await ctx.request.post(SERVER + "/api/auth/login", { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.addInitScript(
    ([l, th]) => {
      try {
        localStorage.setItem("hrh_lang", l);
        localStorage.setItem("hrh_theme", th);
        localStorage.setItem("hrh_session_panel", "1");
      } catch {}
      // the sign-in link opens in a new tab: keep its address instead (the test plays the browser)
      window.open = (u) => {
        window.__hfOpened = String(u);
        return null;
      };
    },
    [lang, theme],
  );
  return ctx;
}

async function api(ctx, method, url, body) {
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${t}`);
  return t ? JSON.parse(t) : null;
}

const shot = async (page, name, el) => {
  const file = path.join(SHOTS, `${name}.png`);
  if (el) await page.locator(el).first().screenshot({ path: file });
  else await page.screenshot({ path: file });
  console.log(`  shot ${name}`);
};

async function openHiggsfieldTab(page) {
  await page.goto(`${SERVER}/?view=settings&tab=providers`);
  await page.waitForSelector('[data-testid="providers-tab-higgsfield"]', { timeout: 20000 });
  await page.click('[data-testid="providers-tab-higgsfield"]');
  await page.waitForSelector('[data-testid="higgsfield-panel"]');
  await sleep(500);
}

/** the stub's sign-in: the address the browser would end on (http://localhost:8765/callback?code=…&state=…) */
async function signInAtStub(authorizeUrl) {
  assert.ok(authorizeUrl.startsWith(STUB + "/oauth/authorize?"), authorizeUrl);
  const q = new URL(authorizeUrl).searchParams;
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("redirect_uri"), "http://localhost:8765/callback");
  assert.equal(q.get("client_id"), "sRGCQJvvJkPrrtRj");
  const r = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(r.status, 302);
  return r.headers.get("location");
}

async function hfcheck(page, text) {
  const before = await page.evaluate(() => (document.body.innerText.match(/HFCHECK [^\n]*/g) || []).length);
  await page.fill("textarea", text);
  await page.keyboard.press("Enter");
  return until("HFCHECK reply", async () => {
    const all = await page.evaluate(() => document.body.innerText.match(/HFCHECK [^\n]*/g) || []);
    return all.length > before ? all[all.length - 1] : null;
  }, 60000);
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  const setup = await device(browser);
  // a clean start: no account from an earlier run
  for (const a of (await api(setup, "GET", "/api/higgsfield")).accounts) await api(setup, "DELETE", `/api/higgsfield/accounts/${a.id}`);

  // ── Providers → Higgsfield, empty ──
  step("providers tab: empty");
  const ctx = await device(browser, { lang: "en", theme: "dark" });
  const page = await ctx.newPage();
  await openHiggsfieldTab(page);
  await page.waitForSelector('[data-testid="higgsfield-empty"]');
  assert.match(await page.locator('[data-testid="higgsfield-cli"]').innerText(), /higgsfield CLI found/);
  await shot(page, "01-providers-higgsfield-empty-dark-en");

  // ── connect dialog: errors ──
  step("connect dialog: error states");
  await page.click('[data-testid="higgsfield-add"]');
  await page.waitForSelector('[data-testid="higgsfield-connect"]');
  await until("sign-in link ready", () => page.locator('[data-testid="higgsfield-open-link"]:not([disabled])').count());
  await shot(page, "02-connect-dialog-dark-en", '[data-testid="higgsfield-connect"]');
  await page.fill('[data-testid="higgsfield-callback"]', "https://higgsfield.ai/some/page");
  await page.click('[data-testid="higgsfield-callback-submit"]');
  await page.waitForSelector('[data-testid="higgsfield-error"]');
  assert.match(await page.locator('[data-testid="higgsfield-error"]').innerText(), /isn't the address from the sign-in/);
  await shot(page, "03-connect-error-not-a-callback-dark-en", '[data-testid="higgsfield-connect"]');
  await page.fill('[data-testid="higgsfield-callback"]', "http://localhost:8765/callback?code=abc&state=not-this-one");
  await page.click('[data-testid="higgsfield-callback-submit"]');
  await until("expired error", async () => /expired or was already used/.test(await page.locator('[data-testid="higgsfield-error"]').innerText()));
  await shot(page, "04-connect-error-stale-state-dark-en", '[data-testid="higgsfield-connect"]');
  await page.click('[role="tab"]:has-text("credentials.json")');
  await page.fill('[data-testid="higgsfield-credentials"]', '{"auth_version": 2, "access_token": "oat_revoked", "refresh_token": "x"}');
  await page.click('[data-testid="higgsfield-credentials-submit"]');
  await until("import error", async () => /These credentials don't work/.test(await page.locator('[data-testid="higgsfield-error"]').innerText()));
  await shot(page, "05-import-error-dark-en", '[data-testid="higgsfield-connect"]');

  // ── the paste flow end to end ──
  step("connect: link → stub sign-in → pasted localhost address");
  await page.click('[role="tab"]:has-text("Sign-in link")');
  await page.click('[data-testid="higgsfield-open-link"]');
  const opened = await until("window.open", () => page.evaluate(() => window.__hfOpened || null));
  const callback = await signInAtStub(opened);
  assert.match(callback, /^http:\/\/localhost:8765\/callback\?code=e2e-[0-9a-f]+&state=/);
  await page.fill('[data-testid="higgsfield-callback"]', callback);
  await page.click('[data-testid="higgsfield-callback-submit"]');
  await page.waitForSelector('[data-testid="higgsfield-connected"]');
  assert.match(await page.locator('[data-testid="higgsfield-connected"]').innerText(), /e2e@example\.com/);
  await page.waitForSelector('[data-testid="higgsfield-account"]', { timeout: 10000 });
  const row = await page.locator('[data-testid="higgsfield-account"]').innerText();
  assert.match(row, /e2e@example\.com/);
  assert.match(row, /ultra/i);
  assert.match(row, /250\.5/);
  assert.equal(await page.locator('[data-testid="higgsfield-account"] select option').count(), 2); // two workspaces
  const status = await api(setup, "GET", "/api/higgsfield");
  assert.equal(status.accounts.length, 1);
  assert.ok(!JSON.stringify(status).includes("oat_e2e"), "no token reaches the console");
  await shot(page, "06-connected-account-dark-en");

  step("skills: install from the (stub) archive");
  await page.click('[data-testid="higgsfield-skills-install"]');
  await until("skills installed", async () => /1 Higgsfield skill installed here/.test(await page.locator('[data-testid="higgsfield-skills"]').innerText()));
  await shot(page, "07-skills-installed-dark-en");

  step("price check (a free estimate)");
  await page.click('[data-testid="higgsfield-quote-load"]');
  await page.waitForSelector('[data-testid="higgsfield-quote-model"]');
  await page.click('[data-testid="higgsfield-quote-go"]');
  await until("quote", async () => /2\.5 credits per job/.test(await page.locator('[data-testid="higgsfield-quote"]').innerText()));
  await shot(page, "07b-price-check-dark-en", '[data-testid="higgsfield-quote"]');

  // ── a chat's agent uses it ──
  step("chat: the agent runs the higgsfield CLI");
  const chat = await api(setup, "POST", "/api/sessions", { provider: "claude", model: "", connection_id: null, workspace_path: WORKSPACE, title: "Higgsfield e2e" });
  assert.deepEqual(chat.higgsfield, { enabled: true, max_credits: null });
  await page.goto(`${SERVER}/?view=chat&session=${chat.id}`);
  await page.waitForSelector("textarea", { timeout: 20000 });
  await sleep(1500);
  const on = await hfcheck(page, "please check hfcheck");
  const tokens = await (await fetch(STUB + "/e2e/access")).json();
  const shas = tokens.map((t) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 12));
  const m = /cli=yes creds=yes keys=access_token,auth_version,scope,token_type token=([0-9a-f]{12}) user_file=untouched note=yes/.exec(on);
  assert.ok(m, on);
  assert.ok(shas.includes(m[1]), "the chat's CLI reads the server's current access token");
  await page.waitForSelector('[data-testid="higgsfield-spend"]', { timeout: 20000 });
  assert.match(await page.locator('[data-testid="higgsfield-spend"]').last().innerText(), /2\.5 credits used this turn/);
  await page.waitForSelector('[data-testid="higgsfield-session"]');
  await shot(page, "08-chat-higgsfield-on-dark-en");
  await shot(page, "09-session-panel-higgsfield-dark-en", '[data-testid="higgsfield-session"]');

  step("chat: the launch the agent got (argv / env), without secrets");
  await page.fill("textarea", "show the launch hfdump");
  await page.keyboard.press("Enter");
  // (the stored answer: the rendered markdown would not be JSON any more)
  const dump = await until("HFDUMP", async () => {
    const msgs = await api(setup, "GET", `/api/sessions/${chat.id}/messages`);
    const m = msgs.filter((x) => x.role === "assistant" && x.content.startsWith("HFDUMP ")).pop();
    return m ? m.content.slice("HFDUMP ".length) : null;
  }, 60000);
  const launch = JSON.parse(dump);
  assert.ok(launch.argv.join(" ").includes("--plugin-dir"), "the installed skills come as a plugin");
  assert.ok(/is connected for this chat/.test(launch.argv.join(" ")));
  assert.ok(launch.env.HIGGSFIELD_CREDENTIALS_PATH.includes("/higgsfield/sessions/"));
  assert.ok(launch.env.PATH.split(":")[0].endsWith("/higgsfield/bin"));
  assert.ok(!dump.includes("oat_e2e") && !dump.includes("rt_e2e"), "no token in argv / env");
  fs.writeFileSync(path.join(SHOTS, "launch-dump.json"), JSON.stringify(launch, null, 2));

  step("chat: switched off → the next turn has no credentials");
  await page.click('[data-testid="higgsfield-session-toggle"]');
  await until("toggle off", async () => (await page.getAttribute('[data-testid="higgsfield-session-toggle"]', "aria-pressed")) === "false");
  assert.equal((await api(setup, "GET", `/api/sessions/${chat.id}`)).higgsfield.enabled, false);
  const off = await hfcheck(page, "again hfcheck");
  assert.match(off, /creds=no/);
  assert.match(off, /note=off/);
  assert.ok(!shas.some((s) => off.includes(s)), off);
  await shot(page, "10-chat-higgsfield-off-dark-en");
  await page.click('[data-testid="higgsfield-session-toggle"]'); // (back on for the shots below)
  await until("toggle on", async () => (await page.getAttribute('[data-testid="higgsfield-session-toggle"]', "aria-pressed")) === "true");
  await page.fill('[data-testid="higgsfield-session-limit"]', "20");
  await page.keyboard.press("Enter");
  await until("limit saved", async () => (await api(setup, "GET", `/api/sessions/${chat.id}`)).higgsfield.max_credits === 20);

  step("usage: the Higgsfield card");
  await page.goto(`${SERVER}/?view=settings&tab=usage`);
  await page.waitForSelector('[data-testid="higgsfield-usage"]', { timeout: 20000 });
  const usage = await page.locator('[data-testid="higgsfield-usage"]').innerText();
  assert.match(usage, /250\.5/);
  assert.match(usage, /GPT Image 2\.5/);
  await shot(page, "11-usage-higgsfield-dark-en", '[data-testid="higgsfield-usage"]');
  await ctx.close();

  // ── the other themes / language ──
  for (const [theme, lang] of [["light", "en"], ["light", "ko"], ["dark", "ko"]]) {
    step(`screens: ${theme} ${lang}`);
    const c = await device(browser, { lang, theme });
    const p = await c.newPage();
    await openHiggsfieldTab(p);
    await p.waitForSelector('[data-testid="higgsfield-account"]');
    await shot(p, `20-providers-higgsfield-${theme}-${lang}`);
    await p.click('[data-testid="higgsfield-add"]');
    await p.waitForSelector('[data-testid="higgsfield-connect"]');
    await p.fill('[data-testid="higgsfield-callback"]', "not a callback");
    await p.click('[data-testid="higgsfield-callback-submit"]');
    await p.waitForSelector('[data-testid="higgsfield-error"]');
    await shot(p, `21-connect-error-${theme}-${lang}`, '[data-testid="higgsfield-connect"]');
    await p.keyboard.press("Escape");
    await p.goto(`${SERVER}/?view=chat&session=${chat.id}`);
    await p.waitForSelector('[data-testid="higgsfield-session"]', { timeout: 20000 });
    await sleep(800);
    await shot(p, `22-chat-${theme}-${lang}`);
    await shot(p, `23-session-panel-${theme}-${lang}`, '[data-testid="higgsfield-session"]');
    await p.goto(`${SERVER}/?view=settings&tab=usage`);
    await p.waitForSelector('[data-testid="higgsfield-usage"]', { timeout: 20000 });
    await shot(p, `24-usage-${theme}-${lang}`, '[data-testid="higgsfield-usage"]');
    if (lang === "ko") {
      const text = await p.locator('[data-testid="higgsfield-usage"]').innerText();
      assert.match(text, /크레딧/);
    }
    await c.close();
  }

  // ── disconnect ──
  step("disconnect");
  const c = await device(browser);
  const p = await c.newPage();
  await openHiggsfieldTab(p);
  await p.click('[data-testid="higgsfield-disconnect"]');
  await p.click('[data-testid="higgsfield-disconnect-yes"]');
  await p.waitForSelector('[data-testid="higgsfield-empty"]');
  assert.equal((await api(setup, "GET", "/api/higgsfield")).accounts.length, 0);
  await c.close();
  await setup.close();
  await browser.close();
  console.log("ok: higgsfield browser checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
