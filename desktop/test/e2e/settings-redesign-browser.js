// Where each setting lives (docs/settings.md) in a browser against a throwaway server, no real engine:
//
//   python3 desktop/test/e2e/session-rewind-server.py 18982 <frontend dist> <workspace> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/settings-redesign-browser.js http://127.0.0.1:18982 rewind-test-only <shots dir>
//
// Checks: Settings has 일반 / 메이트 / 에이전트와 서비스; Settings → 메이트 holds the default mate, this device's sound and
// speaking first, Live2D and the built-in mates; 화면 공유 only what is set once (no "when to capture"; not on a phone); 계정 the name
// every mate knows you by (and her 대화 방식 shows it, read-only, with a link); 언어 the time zone. The Mate view has no
// second "Global settings"; Mate settings' tabs are profile · style · avatar · voice · model · 관계와 기억 · 삭제, the
// ♥ panel's 설정 opens 관계와 기억, and her links ("Settings", the volume) open Settings at the right tab. The share
// dialog in the message box has what a share shows, and a link for the rest. English and Korean, light and dark,
// desktop and phone (screenshots).
"use strict";
const assert = require("assert/strict");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !SHOTS) {
  console.error("usage: node settings-redesign-browser.js <server url> <password> <shots dir>");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);

async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(200);
  }
}

async function context(browser, { lang, theme, phone = false }) {
  const ctx = await browser.newContext(
    phone
      ? {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        }
      : { viewport: { width: 1440, height: 900 } },
  );
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.request.put(`${SERVER}/api/preferences`, { data: { language: null, theme: null } }).catch(() => {});
  await ctx.addInitScript(
    ([l, th]) => {
      try {
        localStorage.setItem("hrh_lang", l);
        localStorage.setItem("hrh_theme", th);
        localStorage.setItem("hrh_setup_seen_v2", "1");
      } catch {}
    },
    [lang, theme],
  );
  return ctx;
}

async function api(ctx, method, url, data) {
  const r = await ctx.request.fetch(SERVER + url, { method, data, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot: ${file}`);
}

const count = (page, sel) => page.locator(sel).count();
const settingsAt = async (page, tab) => {
  await page.goto(`${SERVER}/?view=settings&tab=${tab}`);
  await page.waitForSelector(`[data-testid="settings-panel-${tab}"]`, { timeout: 20000 });
  await sleep(300);
};
async function openMateSettings(page) {
  await page.goto(`${SERVER}/?view=mate`);
  await page.waitForSelector('[data-testid="mate-settings-open"]', { timeout: 30000 });
  await page.click('[data-testid="mate-settings-open"]');
  await page.waitForSelector('[data-testid="mate-settings"]');
}

async function desktop(browser, lang, theme) {
  const tag = `${lang}-${theme}-desktop`;
  const ko = lang === "ko";
  const ctx = await context(browser, { lang, theme });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mates = await api(ctx, "GET", "/api/mates");
  assert.ok(mates.length >= 1, "a mate to set");

  step(`${tag}: Settings — the groups, and Mate / Screen sharing under 메이트`);
  await settingsAt(page, "mate");
  const tabIds = await page.$$eval('[role="tab"]', (xs) => xs.map((x) => x.id.replace("settings-tab-", "")));
  assert.deepEqual(tabIds, ["updates", "account", "language", "appearance", "notifications", "mate", "providers", "media", "mcp", "connections", "usage", "admin"]);
  assert.equal(await page.textContent('[data-testid="settings-tab-appearance"]').then((s) => s.includes(ko ? "테마" : "Theme")), true, "the look is 테마, not 화면");
  for (const id of ["mate-default-select", "mate-device-voice", "mate-volume-slider", "proactive-enabled", "settings-builtins", "settings-mate-services"])
    assert.equal(await count(page, `[data-testid="${id}"]`), 1, id);
  assert.equal(await count(page, '[data-testid="proactive-mate"]'), 0, "who: only once it is on");
  await shot(page, `${tag}-settings-mate`);

  step(`${tag}: speaking first — on, then which mate (this device's)`);
  await page.click('[data-testid="proactive-enabled"]');
  await until("on", async () => (await page.getAttribute('[data-testid="proactive-enabled"]', "aria-checked")) === "true");
  if (mates.length > 1) assert.equal(await count(page, '[data-testid="proactive-mate"]'), 1);
  await page.click('[data-testid="proactive-enabled"]');
  await until("off", async () => (await page.getAttribute('[data-testid="proactive-enabled"]', "aria-checked")) === "false");

  step(`${tag}: the default mate is chosen here`);
  if (mates.length > 1) {
    const other = mates.find((m) => !m.is_default);
    await page.selectOption('[data-testid="mate-default-select"]', other.id);
    await until("default moved", async () => (await api(ctx, "GET", "/api/mates")).find((m) => m.id === other.id).is_default);
    await page.selectOption('[data-testid="mate-default-select"]', mates.find((m) => m.is_default).id);
    await until("default back", async () => (await api(ctx, "GET", "/api/mates")).find((m) => m.is_default).id === mates.find((m) => m.is_default).id);
  }

  step(`${tag}: Screen sharing — only what is set once`);
  await settingsAt(page, "screen");
  for (const id of ["device-capture-approval", "device-capture-size", "device-capture-format"]) assert.equal(await count(page, `[data-testid="${id}"]`), 1, id);
  for (const id of ["screen-mode", "screen-interval", "device-capture-source", "settings-screen-start"]) assert.equal(await count(page, `[data-testid="${id}"]`), 0, id);
  await shot(page, `${tag}-settings-screen`);

  step(`${tag}: Account — the name every mate knows you by`);
  await settingsAt(page, "account");
  const name = ko ? "현석" : "Alex";
  await page.fill('[data-testid="settings-your-name-input"]', name);
  await page.click('[data-testid="settings-your-name-save"]');
  await until("saved", async () => (await api(ctx, "GET", "/api/mates/settings")).user_name === name);
  for (const m of await api(ctx, "GET", "/api/mates")) assert.equal(m.prefs.user_name, name, `${m.name} knows it`);
  await shot(page, `${tag}-settings-account`);

  step(`${tag}: Language — the time zone`);
  await settingsAt(page, "language");
  assert.equal(await count(page, '[data-testid="mate-timezone-input"]'), 1);
  await shot(page, `${tag}-settings-language`);

  step(`${tag}: the Mate view — no Global settings; Mate settings' tabs`);
  await openMateSettings(page);
  assert.equal(await count(page, '[data-testid="mate-global-settings-open"], [data-testid="mate-global-settings"], [data-testid="mate-open-global"]'), 0);
  const tabs = await page.$$eval('[data-testid="mate-settings"] [role="tab"]', (xs) => xs.map((x) => x.dataset.testid.replace("mate-tab-", "")));
  assert.deepEqual(tabs, ["profile", "style", "avatar", "voice", "model", "bond", "danger"]);
  await shot(page, `${tag}-mate-profile`);

  step(`${tag}: 대화 방식 shows your name, read-only, with a link to Account`);
  await page.click('[data-testid="mate-tab-style"]');
  await page.waitForSelector('[data-testid="mate-user-name"]');
  assert.equal((await page.textContent('[data-testid="mate-user-name"]')).trim(), name);
  assert.equal(await count(page, 'input[data-testid="mate-user-name"]'), 0, "not a second copy to edit");
  await shot(page, `${tag}-mate-style`);

  step(`${tag}: 음성 — the volume is this device's: a line and a link`);
  await page.click('[data-testid="mate-tab-voice"]');
  await page.waitForSelector('[data-testid="mate-volume-settings"]');
  assert.equal(await count(page, '[data-testid="mate-volume-slider"]'), 0);
  await page.click('[data-testid="mate-volume-settings"]');
  await until("Settings → Mate", async () => new URL(page.url()).search === "?view=settings&tab=mate");
  await page.waitForSelector('[data-testid="mate-volume-slider"]');

  step(`${tag}: 관계와 기억 — the relationship, her memory, forgetting`);
  await openMateSettings(page);
  await page.click('[data-testid="mate-tab-bond"]');
  for (const id of ["mate-relation-enabled", "mate-relation-set", "mate-memory-self-save", "mate-memory-recall", "mate-wipe-confirm"])
    await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 10000 });
  const mate = (await api(ctx, "GET", "/api/mates")).find((m) => m.is_default) ?? mates[0];
  const before = mate.prefs.memory.self_save;
  await page.click('[data-testid="mate-memory-self-save"]');
  await until("self-save saved", async () => (await api(ctx, "GET", `/api/mates/${mate.id}`)).prefs.memory.self_save === !before);
  await page.click('[data-testid="mate-memory-self-save"]');
  await until("self-save back", async () => (await api(ctx, "GET", `/api/mates/${mate.id}`)).prefs.memory.self_save === before);
  await shot(page, `${tag}-mate-bond`);

  step(`${tag}: 삭제 — deleting her only`);
  await page.click('[data-testid="mate-tab-danger"]');
  await page.waitForSelector('[data-testid="mate-delete-confirm"]');
  assert.equal(await count(page, '[data-testid="mate-wipe-confirm"], [data-testid="mate-restore-builtins-settings"]'), 0);

  step(`${tag}: her header's Settings button opens the app's Settings → Mate`);
  await page.click('[data-testid="mate-open-app-settings"]');
  await until("Settings → Mate", async () => new URL(page.url()).search === "?view=settings&tab=mate");

  step(`${tag}: the ♥ panel is for looking; its 설정 opens 관계와 기억`);
  await page.goto(`${SERVER}/?view=mate`);
  await page.waitForSelector('[data-testid="mate-relation-open"]', { timeout: 30000 });
  await page.click('[data-testid="mate-relation-open"]');
  await page.waitForSelector('[data-testid="mate-relation-panel"]');
  assert.equal(await count(page, '[data-testid="mate-relation-panel"] [data-testid="mate-relation-set"]'), 0);
  await page.click('[data-testid="bond-tab-memory"]');
  await page.waitForSelector('[data-testid="memory-settings-link"]');
  await page.click('[data-testid="mate-relation-panel-adjust"]');
  await page.waitForSelector('[data-testid="mate-settings"]');
  assert.equal(await page.getAttribute('[data-testid="mate-tab-bond"]', "aria-selected"), "true");

  step(`${tag}: Share screen — no setup dialog: in a browser its own picker is the picker`);
  await page.click('[data-testid="mate-settings-close"]');
  await page.click('[data-testid="mate-attach"]');
  const share = page.locator('[data-testid="attach-share-screen"]');
  if (await share.count()) {
    // (the system picker can't be driven here: count it, and cancel it as a user would)
    await page.evaluate(() => {
      window.__pickers = 0;
      navigator.mediaDevices.getDisplayMedia = async () => {
        window.__pickers++;
        throw new DOMException("cancelled", "NotAllowedError");
      };
    });
    await share.click();
    await until("the browser's picker", async () => (await page.evaluate(() => window.__pickers)) === 1);
    for (const id of ["screen-setup", "screen-mode", "device-capture-settings-link", "share-picker", "screen-sharing"])
      assert.equal(await count(page, `[data-testid="${id}"]`), 0, id);
    await shot(page, `${tag}-share-browser-picker`);
  } else console.log("  (this browser can't share a screen: no Share screen entry)");

  assert.deepEqual(errors, [], "no page errors");
  await ctx.close();
}

async function phone(browser, lang, theme) {
  const tag = `${lang}-${theme}-phone`;
  const ctx = await context(browser, { lang, theme, phone: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  step(`${tag}: Settings → Mate and Screen sharing, Mate settings → 관계와 기억`);
  await settingsAt(page, "mate");
  await shot(page, `${tag}-settings-mate`);
  // (a phone has no screen to share: no Screen sharing tab)
  await page.goto(`${SERVER}/?view=settings`);
  await page.waitForSelector('[data-testid="settings-tab-mate"]', { timeout: 20000 });
  assert.equal(await count(page, '[data-testid="settings-tab-screen"]'), 0, "no Screen sharing on a phone");
  await openMateSettings(page);
  const row = await page.$eval('[data-testid="mate-settings"] [role="tablist"]', (el) => ({ w: el.scrollWidth, c: el.clientWidth }));
  console.log(`  tab row ${row.w}/${row.c}px (scrolls sideways when wider)`);
  await page.click('[data-testid="mate-tab-bond"]');
  await page.waitForSelector('[data-testid="mate-memory-self-save"]');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(over <= 0, `nothing wider than the phone: ${over}`);
  await shot(page, `${tag}-mate-bond`);
  await page.click('[data-testid="mate-settings-close"]');
  await page.click('[data-testid="mate-more"]');
  assert.equal(await count(page, '[data-testid="mate-global-settings-open"]'), 0, "no Global settings in ⋯");
  assert.deepEqual(errors, [], "no page errors");
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    await desktop(browser, "ko", "light");
    await desktop(browser, "en", "dark");
    await phone(browser, "ko", "dark");
    await phone(browser, "en", "light");
    // (leave the server as it was)
    const ctx = await context(browser, { lang: "en", theme: "light" });
    await api(ctx, "PUT", "/api/mates/settings", { user_name: "" });
    await ctx.close();
    console.log("SETTINGS REDESIGN E2E OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
