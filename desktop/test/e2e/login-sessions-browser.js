// Settings → Providers → login sessions and plan numbers' freshness in a browser, against a throwaway backend seeded
// by login-sessions-seed.py (fake accounts, fake tokens) that runs with CLAUDE_BINARY=fake-claude.py,
// PLAN_USAGE_FETCH=false and a dead HTTPS proxy (nothing leaves the machine):
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node test/e2e/login-sessions-browser.js <server url> <password> <seed.json> [shots dir]
//
// Checks: the host login's card keeps its last 5-hour / 7-day numbers after a 429 and says when they're from and
// when it asks again; the session row (health, expiry) and its details (method, who, plan, refresh token, scopes —
// never a token); "Renew session" succeeding (the CLI renews it), failing (renewal failed → sign in again first),
// "Sign in again" opening the sign-in dialog; the Settings badge only for logins that need the user (not for an
// access token that renews on use); the Codex host login; English and Korean, light and dark.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SEED, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !SEED) {
  console.error("usage: node test/e2e/login-sessions-browser.js <server url> <password> <seed.json> [shots dir]");
  process.exit(2);
}
const { ids, home } = JSON.parse(fs.readFileSync(SEED, "utf8"));
const PID = "__primary__claude";

/** "idle" back to an access token that ran out two hours ago (fake tokens; the seed's shape) */
function expireIdle() {
  const f = path.join(home, ".hr-harnessor", "accounts", "claude", ids.idle, ".claude", ".credentials.json");
  const doc = JSON.parse(fs.readFileSync(f, "utf8"));
  doc.claudeAiOauth.expiresAt = Date.now() - 2 * 3600 * 1000;
  fs.writeFileSync(f, JSON.stringify(doc), { mode: 0o600 });
}
const step = (s) => console.log(`• ${s}`);

async function device(browser, { lang, theme }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, colorScheme: theme });
  const r = await ctx.request.post(SERVER + "/api/auth/login", { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.addInitScript(
    ([l, th]) => {
      try {
        localStorage.setItem("hrh_lang", l);
        localStorage.setItem("hrh_theme", th);
      } catch {}
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

async function shot(target, name) {
  if (!SHOTS) return;
  const file = path.join(SHOTS, name);
  await target.screenshot({ path: file });
  console.log(`  shot: ${file}`);
}

const row = (page, id) => page.locator(`[data-testid="session-${id}"]`);
const health = (page, id) => row(page, id).locator('[data-testid="session-health"]').getAttribute("data-health");
const accountsCard = (page) => page.locator(".card", { has: page.locator(`[data-testid="session-${PID}"]`) });

async function open(ctx, tab = "claude") {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(SERVER + "/?view=settings&tab=providers");
  await page.waitForSelector(`[data-testid="session-${PID}"]`, { timeout: 30000 });
  if (tab === "codex") {
    await page.getByRole("button", { name: /^Codex/ }).first().click();
    await page.waitForSelector('[data-testid="session-__primary__codex"]', { timeout: 15000 });
  }
  return page;
}

function noTokens(text) {
  for (const bad of ["fake-access", "fake-refresh", "fake-codex-refresh", "REVOKED", "eyJ"]) assert.ok(!text.includes(bad), `token-ish text in the page: ${bad}`);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    // ---- 1. what the seed shows, in every language / theme (before anything is renewed) ----
    for (const [lang, theme] of [["ko", "dark"], ["en", "light"], ["ko", "light"], ["en", "dark"]]) {
      step(`cards ${lang}/${theme}`);
      const ctx = await device(browser, { lang, theme });
      const page = await open(ctx);
      const card = accountsCard(page);
      const primary = card.locator("div.rounded-lg", { has: row(page, PID) }).first();
      const ptext = await primary.innerText();
      // the 429 case: the last numbers stay, with when they're from and when it asks again
      assert.match(ptext, /37%/);
      assert.match(ptext, /62%/);
      const stale = await primary.locator('[data-testid="plan-stale"]').innerText();
      assert.match(stale, lang === "ko" ? /마지막으로 확인: .*전.*기다려 달래요.*다시 확인해요/ : /Last checked .*ago.*asked to wait.*checking again at/);
      assert.ok(!/정보 없음|not reported/i.test(ptext), "no 'no data' while last numbers are known");
      assert.equal(await health(page, PID), "valid");
      assert.equal(await health(page, ids.work), "valid");
      assert.equal(await health(page, ids.idle), "expired"); // renews on use: information
      assert.equal(await health(page, ids.dead), "needs_login");
      assert.equal(await row(page, ids.dead).locator('[data-testid="session-renew"]').count(), 0);
      assert.equal(await row(page, ids.dead).locator('[data-testid="session-relogin"]').count(), 1);
      assert.equal(await row(page, ids.idle).locator('[data-testid="session-relogin"]').count(), 0); // not first: not stuck
      // the badge: "dead" needs a sign-in
      assert.equal(await page.locator('[data-testid="settings-tab-badge"]').count(), 1);
      // details: the host login
      await row(page, PID).locator('[data-testid="session-details-toggle"]').click();
      const det = await row(page, PID).locator('[data-testid="session-details"]').innerText();
      assert.match(det, /me@example\.com · Example Org/);
      assert.match(det, /Claude Max · default_claude_max_20x/);
      assert.match(det, /user:sessions:claude_code/);
      assert.match(det, lang === "ko" ? /있음 · / : /yes · until/);
      noTokens(await page.content());
      await shot(card, `cards-${lang}-${theme}.png`);
      await shot(primary, `primary-429-details-${lang}-${theme}.png`);
      await ctx.close();
    }

    // ---- 2. renew: succeeds (the CLI renews it), fails (renewal failed), sign in again ----
    for (const [lang, theme] of [["ko", "dark"], ["en", "light"]]) {
      step(`renew ${lang}/${theme}`);
      const ctx = await device(browser, { lang, theme });
      if (lang === "en") expireIdle(); // the seed's expired-but-renewable state again, for the second language
      const page = await open(ctx);
      {
        const idle = row(page, ids.idle);
        assert.equal(await health(page, ids.idle), "expired");
        await idle.locator('[data-testid="session-renew"]').click();
        await idle.locator('[data-testid="session-result"]').waitFor({ timeout: 30000 });
        const msg = await idle.locator('[data-testid="session-result"]').innerText();
        assert.match(msg, lang === "ko" ? /CLI가 직접 갱신했어요 — 이제 .*에 만료돼요/ : /Renewed by the CLI itself — now expires/);
        await page.waitForFunction((id) => document.querySelector(`[data-testid="session-${id}"] [data-testid="session-health"]`)?.getAttribute("data-health") === "valid", ids.idle, { timeout: 15000 });
        await shot(idle, `renew-ok-${lang}-${theme}.png`);
      }
      const flaky = row(page, ids.flaky);
      await flaky.locator('[data-testid="session-renew"]').click();
      await flaky.locator('[data-testid="session-result"]').waitFor({ timeout: 60000 });
      const fail = await flaky.locator('[data-testid="session-result"]').innerText();
      assert.match(fail, lang === "ko" ? /갱신하지 못했어요/ : /Couldn't renew/);
      await page.waitForFunction((id) => document.querySelector(`[data-testid="session-${id}"] [data-testid="session-health"]`)?.getAttribute("data-health") === "refresh_failed", ids.flaky, { timeout: 15000 });
      assert.equal(await flaky.locator('[data-testid="session-relogin"]').count(), 1); // the way out, first
      await shot(flaky, `renew-failed-${lang}-${theme}.png`);
      // sign in again: the account's own sign-in dialog
      await row(page, ids.dead).locator('[data-testid="session-relogin"]').click();
      await page.waitForSelector(lang === "ko" ? "text=로그인 — dead" : "text=Sign in — dead", { timeout: 15000 });
      await shot(page, `relogin-dialog-${lang}-${theme}.png`);
      await page.keyboard.press("Escape");
      noTokens(await page.content());
      await shot(accountsCard(page), `after-renew-${lang}-${theme}.png`);
      await ctx.close();
    }

    // ---- 3. the badge only for what needs the user ----
    step("badge");
    {
      const ctx = await device(browser, { lang: "ko", theme: "dark" });
      await api(ctx, "PATCH", `/api/providers/claude/accounts/${ids.dead}`, { enabled: false });
      await api(ctx, "PATCH", `/api/providers/claude/accounts/${ids.flaky}`, { enabled: false });
      const list = await api(ctx, "GET", "/api/providers");
      const claude = list.find((p) => p.provider === "claude");
      assert.deepEqual(claude.session_attention, []); // "idle" (renews on use) and the rest: nothing to do
      const page = await open(ctx);
      assert.equal(await page.locator('[data-testid="settings-tab-badge"]').count(), 0);
      await api(ctx, "PATCH", `/api/providers/claude/accounts/${ids.dead}`, { enabled: true });
      await page.reload();
      await page.waitForSelector(`[data-testid="session-${PID}"]`);
      await page.waitForSelector('[data-testid="settings-tab-badge"]', { timeout: 15000 });
      await shot(page.locator('[data-testid="settings-tab-providers"]'), "badge-ko-dark.png");
      await ctx.close();
    }

    // ---- 4. Codex: the host login ----
    for (const [lang, theme] of [["ko", "dark"], ["en", "light"]]) {
      step(`codex ${lang}/${theme}`);
      const ctx = await device(browser, { lang, theme });
      const page = await open(ctx, "codex");
      const r = row(page, "__primary__codex");
      assert.equal(await health(page, "__primary__codex"), "valid");
      await r.locator('[data-testid="session-details-toggle"]').click();
      const det = await r.locator('[data-testid="session-details"]').innerText();
      assert.match(det, /ChatGPT/);
      assert.match(det, /me@example\.com/);
      assert.match(det, /offline_access/);
      noTokens(await page.content());
      await shot(r, `codex-${lang}-${theme}.png`);
      await ctx.close();
    }
    console.log("OK login sessions");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
