// The sidebar (Mate and Chat only) and Settings as real tabs, plus the sessions' "Complete" badge — in a browser
// against a real server on THIS machine (backend with CLAUDE_BINARY=desktop/test/e2e/fake-claude.py, the frontend
// build as STATIC_DIR):
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node test/e2e/settings-tabs-browser.js <server url> <password> [shots dir] [tabs|status]
//
// tabs:   the sidebar has only Mate / Chat (+ Settings with the Providers count); every Settings tab shows only its
//         own content; back / forward / reload between tabs; the old screens' links (`/?view=usage`, `downloads`…)
//         open their tab; arrow keys in the tab list; a phone's list → tab → back; English and Korean.
// status: a run that finishes in a chat that isn't open → a green "Complete" in the sidebar, on another device too
//         (a second browser context), still there after a reload, gone once the chat is opened; one finishing in
//         the open chat leaves none.
"use strict";
const assert = require("assert/strict");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS, ONLY] = process.argv.slice(2);
if (!SERVER || !PASSWORD) {
  console.error("usage: node test/e2e/settings-tabs-browser.js <server url> <password> [shots dir] [tabs|status]");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);

async function api(ctx, method, url, body) {
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function newContext(browser, { phone = false, lang = "en" } = {}) {
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
  const r = await ctx.request.post(SERVER + "/api/auth/login", { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.addInitScript((l) => {
    try {
      localStorage.setItem("hrh_lang", l);
    } catch {}
  }, lang);
  await ctx.request.put(SERVER + "/api/preferences", { data: { language: null } }).catch(() => {});
  return ctx;
}

async function shot(page, name) {
  if (!SHOTS) return;
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file });
  console.log(`  shot: ${file}`);
}

const search = (page) => new URL(page.url()).search;
async function at(page, want) {
  await page.waitForFunction((w) => window.location.search === w, want, { timeout: 10000 }).catch(() => {});
  assert.equal(search(page), want);
}
/** the Settings panel on screen: its tab, and that it is the only one */
async function panel(page) {
  return page.evaluate(() => {
    const ps = [...document.querySelectorAll('[data-testid^="settings-panel-"]')];
    return { n: ps.length, tab: ps[0]?.getAttribute("data-testid").replace("settings-panel-", "") ?? null };
  });
}
async function showing(page, tab) {
  await page.waitForSelector(`[data-testid="settings-panel-${tab}"]`, { timeout: 15000 });
  assert.deepEqual(await panel(page), { n: 1, tab });
}
const sidebarNav = (page) =>
  page.evaluate(() => [...document.querySelectorAll("aside nav button")].filter((b) => b.offsetParent).map((b) => b.textContent.trim()));

const TABS = ["updates", "account", "language", "notifications", "mate", "providers", "connections", "usage", "admin"];
// what each tab must show (and what belongs to the others it must not)
const MARK = {
  updates: '[data-testid="settings-updates"]',
  account: '[data-testid="settings-account"]',
  language: '[data-testid="settings-language"]',
  notifications: '[data-testid="settings-notifications"]',
  mate: '[data-testid="settings-mate"]',
};

async function tabsDesktop(browser, lang) {
  const L = lang === "ko" ? { mate: "메이트", chat: "채팅", usage: "사용량" } : { mate: "Mate", chat: "Chat", usage: "Usage" };
  const ctx = await newContext(browser, { lang });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(SERVER + "/");
  await page.waitForSelector('[data-testid="nav-settings"]', { timeout: 20000 });

  step(`${lang} desktop: the sidebar has Mate and Chat only; Settings carries the Providers count`);
  assert.deepEqual(await sidebarNav(page), [L.mate, L.chat]);
  await page.waitForSelector('[data-testid="nav-settings-badge"]', { timeout: 10000 });
  assert.equal((await page.textContent('[data-testid="nav-settings-badge"]')).trim(), "1");
  await shot(page, `${lang}-desktop-sidebar.png`);

  step(`${lang} desktop: Settings → the first tab beside the tab list`);
  await page.click('[data-testid="nav-settings"]');
  await at(page, "?view=settings");
  await showing(page, "updates");
  const tabIds = await page.$$eval('[role="tab"]', (xs) => xs.map((x) => x.id.replace("settings-tab-", "")));
  assert.deepEqual(tabIds, TABS, "the tabs (Desktop app only in the desktop app)");
  assert.equal((await page.textContent('[data-testid="settings-tab-providers"] [data-testid="settings-tab-badge"]')).trim(), "1");

  step(`${lang} desktop: every tab shows only its own content`);
  for (const tab of TABS) {
    await page.click(`[data-testid="settings-tab-${tab}"]`);
    await at(page, `?view=settings&tab=${tab}`);
    await showing(page, tab);
    assert.equal(await page.getAttribute(`[data-testid="settings-tab-${tab}"]`, "aria-selected"), "true");
    for (const [other, sel] of Object.entries(MARK)) {
      const n = await page.locator(sel).count();
      assert.equal(n, other === tab ? 1 : 0, `${tab}: ${other}'s content ${other === tab ? "shown" : "not shown"}`);
    }
    if (tab === "updates") assert.equal(await page.locator('[data-testid="settings-downloads"]').count(), 1, "Download under Updates");
    await sleep(tab === "admin" || tab === "usage" || tab === "providers" ? 800 : 250);
    await shot(page, `${lang}-desktop-tab-${tab}.png`);
  }

  step(`${lang} desktop: back / forward / reload between tabs`);
  await page.goBack();
  await at(page, "?view=settings&tab=usage");
  await showing(page, "usage");
  await page.goBack();
  await at(page, "?view=settings&tab=connections");
  await showing(page, "connections");
  await page.goForward();
  await at(page, "?view=settings&tab=usage");
  await showing(page, "usage");
  await page.reload();
  await at(page, "?view=settings&tab=usage");
  await showing(page, "usage");
  assert.ok((await page.textContent('[data-testid="settings-panel-usage"] h2')).includes(L.usage));

  step(`${lang} desktop: arrow keys move in the tab list, Enter opens`);
  await page.focus('[data-testid="settings-tab-usage"]');
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.id), "settings-tab-admin");
  await page.keyboard.press("Home");
  assert.equal(await page.evaluate(() => document.activeElement.id), "settings-tab-updates");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement.id), "settings-tab-admin");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await at(page, "?view=settings&tab=usage"); // (ArrowUp from Admin = Usage: already open — no new entry)
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await at(page, "?view=settings&tab=connections");
  await showing(page, "connections");

  step(`${lang} desktop: the old screens' links open their tab`);
  for (const [old, tab] of [["usage", "usage"], ["providers", "providers"], ["connections", "connections"], ["admin", "admin"], ["downloads", "updates"]]) {
    await page.goto(`${SERVER}/?view=${old}`);
    await at(page, `?view=settings&tab=${tab}`);
    await showing(page, tab);
  }
  // Download: scrolled to the downloads
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="settings-downloads"]');
    const box = document.querySelector("#settings-panel");
    // (at the top of the panel, or as far as the panel scrolls)
    const top = el && box && el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    return el && box && box.scrollTop > 0 && (top < 120 || box.scrollTop + box.clientHeight >= box.scrollHeight - 2);
  }, null, { timeout: 8000 });
  await shot(page, `${lang}-desktop-old-downloads-link.png`);
  // (a fresh page: back past its first screen stays in the app; what changes while it starts replaces it — lib/nav.ts)
  await sleep(2700);
  await page.click('[data-testid="settings-tab-admin"]');
  await showing(page, "admin");
  await page.goBack();
  await at(page, "?view=settings&tab=updates");
  await showing(page, "updates");
  await page.goBack();
  await at(page, "?view=settings&tab=updates");
  await ctx.close();
}

async function tabsPhone(browser, lang) {
  const ctx = await newContext(browser, { phone: true, lang });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(SERVER + "/?view=mate");
  await page.waitForSelector('[data-testid="mate-settings-open"]', { timeout: 20000 }).catch(() => {});
  await sleep(2700); // (past the start: screens from here are history entries)

  step(`${lang} phone: the drawer has Mate / Chat, and Settings with the count`);
  await page.click(`button[aria-label="${lang === "ko" ? "메뉴 열기" : "Open menu"}"]`);
  await page.waitForSelector('.fixed [data-testid="nav-settings"]');
  assert.equal((await page.evaluate(() => [...document.querySelectorAll(".fixed aside nav button")].map((b) => b.textContent.trim()))).length, 2);
  await shot(page, `${lang}-phone-drawer.png`);
  await page.click('.fixed [data-testid="nav-settings"]');

  step(`${lang} phone: the list, then one tab with a back button`);
  await at(page, "?view=settings");
  await page.waitForSelector('[data-testid="settings-tabs"]');
  assert.equal((await panel(page)).n, 0, "the list alone");
  await sleep(500);
  await shot(page, `${lang}-phone-list.png`);
  await page.click('[data-testid="settings-tab-usage"]');
  await at(page, "?view=settings&tab=usage");
  await showing(page, "usage");
  assert.equal(await page.locator('[data-testid="settings-tabs"]').count(), 0, "the tab alone");
  await sleep(500);
  await shot(page, `${lang}-phone-tab-usage.png`);
  await page.click('[data-testid="settings-back"]');
  await at(page, "?view=settings");
  await page.waitForSelector('[data-testid="settings-tabs"]');
  await page.goForward();
  await at(page, "?view=settings&tab=usage");
  await showing(page, "usage");
  await page.reload();
  await showing(page, "usage");
  await page.goBack();
  await at(page, "?view=settings");
  await page.goBack();
  await at(page, "?view=mate");

  step(`${lang} phone: a deep link to a tab; back from it → the list`);
  await page.goto(`${SERVER}/?view=providers`);
  await at(page, "?view=settings&tab=providers");
  await showing(page, "providers");
  await sleep(500);
  await shot(page, `${lang}-phone-tab-providers.png`);
  await page.click('[data-testid="settings-back"]');
  await at(page, "?view=settings");
  await page.waitForSelector('[data-testid="settings-tabs"]');
  await page.click('[data-testid="settings-tab-updates"]');
  await showing(page, "updates");
  await shot(page, `${lang}-phone-tab-updates.png`);
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    const setup = await newContext(browser);
    await api(setup, "POST", "/api/providers/claude/connect", { auth_mode: "api_key", api_key: "sk-ant-fake-e2e" });
    await setup.close();
    if (!ONLY || ONLY === "tabs") {
      for (const lang of ["en", "ko"]) {
        await tabsDesktop(browser, lang);
        await tabsPhone(browser, lang);
      }
    }
    if (!ONLY || ONLY === "status") await status(browser);
    console.log("OK");
  } finally {
    await browser.close();
  }
}

/** a chat's row in the sidebar: its result badge ("ok" | "error" | "stopped" | null) and text */
const rowBadge = (page, title) =>
  page.evaluate((t) => {
    const rows = [...document.querySelectorAll("aside .cursor-pointer")].filter((r) => r.offsetParent);
    const row = rows.find((r) => r.querySelector(".truncate")?.textContent.trim() === t);
    if (!row) return { found: false };
    const b = row.querySelector('[data-testid="session-result"]');
    return { found: true, result: b ? b.getAttribute("data-result") : null, text: b ? b.textContent.trim() : "" };
  }, title);

async function waitBadge(page, title, want, ms = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await rowBadge(page, title);
    if (last.found && last.result === want) return last;
    await sleep(150);
  }
  throw new Error(`${title}: badge ${JSON.stringify(last)}, wanted ${want}`);
}

async function openChat(ctx, sid) {
  await ctx.addInitScript((id) => {
    if (!sessionStorage.getItem("hrh_e2e_once")) {
      sessionStorage.setItem("hrh_e2e_once", "1");
      localStorage.setItem("hrh_last_session", id);
    }
  }, sid);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(SERVER + "/");
  await page.waitForSelector("textarea", { timeout: 20000 });
  await sleep(2700); // (past the start)
  return page;
}

async function send(page, text) {
  await page.fill("textarea", text);
  await page.click('button[title="Send"], button[title="Send (Enter)"], button[title="보내기"], button[title="보내기 (Enter)"]');
}

async function status(browser) {
  const ws = path.join(process.env.HOME || "/tmp", ".cache", "hrh-st-run", "ws");
  require("fs").mkdirSync(ws, { recursive: true });
  const one = await newContext(browser); // device 1 (desktop, English)
  const two = await newContext(browser, { lang: "ko" }); // device 2 (desktop, Korean)
  const stamp = Date.now().toString(36);
  const A = await api(one, "POST", "/api/sessions", { provider: "claude", model: "", connection_id: null, workspace_path: ws, title: `Alpha ${stamp}` });
  const B = await api(one, "POST", "/api/sessions", { provider: "claude", model: "", connection_id: null, workspace_path: ws, title: `Beta ${stamp}` });
  const ta = `Alpha ${stamp}`;
  const tb = `Beta ${stamp}`;

  step("status: a run in Alpha; the user moves to Beta before it ends → Alpha shows a green Complete");
  const p1 = await openChat(one, A.id);
  await send(p1, "first job");
  await p1.waitForFunction(() => document.body.innerText.includes("Reply 1 sentence number 1"), null, { timeout: 30000 }).catch(() => {});
  assert.equal((await rowBadge(p1, ta)).result, null, "no badge while working");
  await p1.click(`aside .cursor-pointer:has-text("${tb}")`);
  const done = await waitBadge(p1, ta, "ok", 30000);
  assert.equal(done.text, "Complete");
  const pill = await p1.textContent('[data-testid="sessions-unseen"]');
  assert.match(pill, /1 complete/);
  await shot(p1, "status-1-complete-device1.png");

  step("status: the other device (Korean) shows it too — 완료");
  const p2 = await openChat(two, B.id);
  const k = await waitBadge(p2, ta, "ok");
  assert.equal(k.text, "완료");
  await shot(p2, "status-2-complete-device2-ko.png");

  step("status: the filter shows only the finished chats");
  await p1.click('[data-testid="sessions-unseen"]');
  assert.equal((await rowBadge(p1, tb)).found, false, "Beta hidden by the filter");
  assert.equal((await rowBadge(p1, ta)).result, "ok");
  await shot(p1, "status-3-filter.png");
  await p1.click('[data-testid="sessions-unseen"]');
  assert.equal((await rowBadge(p1, tb)).found, true);

  step("status: still there after a reload");
  await p1.reload();
  await p1.waitForSelector("textarea", { timeout: 20000 });
  await waitBadge(p1, ta, "ok");

  step("status: opening Alpha clears it — here and on the other device");
  await p1.click(`aside .cursor-pointer:has-text("${ta}")`);
  await waitBadge(p1, ta, null, 3000);
  await waitBadge(p2, ta, null, 10000);
  assert.equal(await p1.locator('[data-testid="sessions-unseen"]').count(), 0);
  await sleep(300);
  await shot(p2, "status-4-cleared-device2-ko.png");
  const row = (await api(one, "GET", "/api/sessions")).find((x) => x.id === A.id);
  assert.equal(row.result_unseen, false);
  assert.equal(row.last_result, "ok");

  step("status: a run that ends in the chat on screen leaves no badge (on either device)");
  await send(p1, "second job");
  let row2;
  for (let i = 0; i < 200; i++) {
    row2 = (await api(one, "GET", "/api/sessions")).find((x) => x.id === A.id);
    if (!row2.running && row2.last_result_at !== row.last_result_at) break;
    await sleep(150);
  }
  assert.notEqual(row2.last_result_at, row.last_result_at, "the second run ended");
  assert.equal(row2.result_unseen, false, "seen as it ended");
  await sleep(800);
  assert.equal((await rowBadge(p1, ta)).result, null);
  assert.equal((await rowBadge(p2, ta)).result, null);

  step("status: phone (Korean): the drawer shows 완료 for a chat that finished elsewhere");
  const phone = await newContext(browser, { phone: true, lang: "ko" });
  const p3 = await openChat(phone, B.id);
  await send(p1, "third job"); // device 1 runs Alpha…
  await p1.waitForFunction(() => document.body.innerText.includes("sentence number 1"), null, { timeout: 30000 }).catch(() => {});
  await p1.click(`aside .cursor-pointer:has-text("${tb}")`); // …and looks away
  await waitBadge(p1, ta, "ok", 30000);
  await p3.click('button[aria-label="메뉴 열기"]');
  await p3.waitForSelector('.fixed [data-testid="nav-settings"]');
  const onPhone = await waitBadge(p3, ta, "ok", 10000);
  assert.equal(onPhone.text, "완료");
  await sleep(400);
  await shot(p3, "status-5-phone-drawer-ko.png");
  step("status: opening it from the phone's drawer clears it on device 1 too");
  await p3.click(`.fixed aside .cursor-pointer:has-text("${ta}")`);
  await waitBadge(p1, ta, null, 10000);
  await phone.close();
  await one.close();
  await two.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
