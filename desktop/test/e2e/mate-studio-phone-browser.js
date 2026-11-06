// The studio on a phone in a browser against a throwaway server, no credits: an outfit's project waiting at the pick,
// with a redo waiting for the user's OK.
//
//   OUTFIT_E2E_WAITING=1 python3 desktop/test/e2e/mate-outfit-server.py 18974 <frontend dist> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/mate-studio-phone-browser.js http://127.0.0.1:18974 outfit-test-only <shots dir>
//
// Checks, with the Android app's system bars as safe areas. The studio: the steps stay on one line, scroll sideways and
// show the current one; the message box clears the navigation bar (and comes down to the keyboard); the redo's card is on
// the Agent tab, in the user's language, and its OK works from there. The Mate: her name stays in the header and what
// doesn't fit is in one menu; the switcher stays on the screen; a panel takes the whole screen, under the status bar; the
// Save bar appears with something to save and sits on the bottom edge, nothing showing below it; another tab starts at
// its top; a choice of many has even columns and big enough targets. A phone on its side: nothing cut off, nothing
// under its side bar, the message box on the screen.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !SHOTS) {
  console.error("usage: node mate-studio-phone-browser.js <server url> <password> <shots dir>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const step = (s) => console.log(`• ${s}`);
const NAV_BAR = 48;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" });
    const login = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
    assert(login.ok());
    const mate = (await (await ctx.request.get(`${SERVER}/api/mates`)).json()).find((m) => m.builtin === "chaerin");
    const outfit = mate.outfits.items.find((o) => o.name === "여행복");
    assert(outfit, "start the server with OUTFIT_E2E_WAITING=1");
    await ctx.addInitScript(
      (id) => {
        localStorage.setItem("hrh_lang", "ko");
        localStorage.setItem("hrh_theme", "light");
        localStorage.setItem("hrh_setup_seen_v2", "1");
        localStorage.setItem("hrh_mate_muted", "1");
        localStorage.setItem("hrh_mate_active", id);
      },
      mate.id,
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 36, left: 0, bottom: NAV_BAR, right: 0 } });

    step("the outfit's studio opens on the Agent tab");
    await page.goto(`${SERVER}/?view=mate`);
    await page.waitForSelector('[data-testid="mate-settings-open"]');
    await page.click('[data-testid="mate-settings-open"]');
    await page.click('[data-testid="mate-tab-avatar"]');
    await page.click(`[data-testid="outfit-tile"][data-outfit="${outfit.id}"]`);
    await page.click('[data-testid="outfit-ai-open"]');
    await page.waitForSelector('[data-testid="mate-studio"][data-layout="tabs"]', { timeout: 20000 });
    await page.waitForSelector('[data-testid="avatar-steps"]');

    step("the steps: one line each, sideways, the current one in view");
    const steps = await page.$eval('[data-testid="avatar-steps"]', (ol) => {
      const items = [...ol.children].map((li) => li.getBoundingClientRect());
      const cur = ol.querySelector('[data-active="true"]').getBoundingClientRect();
      const box = ol.getBoundingClientRect();
      return {
        count: items.length,
        heights: items.map((r) => Math.round(r.height)),
        tops: new Set(items.map((r) => Math.round(r.top))).size,
        scrolls: ol.scrollWidth > ol.clientWidth,
        overflow: getComputedStyle(ol).overflowX,
        curInView: cur.left >= box.left && cur.right <= box.right,
        text: ol.querySelector('[data-active="true"]').textContent,
      };
    });
    assert.equal(steps.count, 8);
    assert.equal(steps.tops, 1, "the steps sit on one line");
    assert(Math.max(...steps.heights) <= 26, `each step is one line of text: ${steps.heights}`);
    assert.equal(steps.overflow, "auto");
    assert(steps.scrolls, "they are wider than the screen and scroll");
    assert(steps.curInView, "the current step is in view");
    assert.equal(steps.text, "후보");
    const moved = await page.$eval('[data-testid="avatar-steps"]', (ol) => {
      const before = ol.scrollLeft;
      ol.scrollLeft = before + 60;
      const after = ol.scrollLeft;
      ol.scrollLeft = before;
      return after - before;
    });
    assert(moved > 0, "the row moves sideways");

    step("the message box clears the navigation bar");
    await page.waitForSelector('[data-testid="avatar-input"]');
    const box = async () =>
      page.evaluate(() => {
        const r = document.querySelector('[data-testid="avatar-send"], [data-testid="avatar-stop"]').getBoundingClientRect();
        const c = document.querySelector('[data-testid="avatar-composer"]').getBoundingClientRect();
        return { send: r.bottom, composer: c.bottom, height: innerHeight };
      });
    const b = await box();
    assert(b.composer <= b.height - NAV_BAR + 1, `the composer ends at ${b.composer}, the bar starts at ${b.height - NAV_BAR}`);
    assert(b.send <= b.height - NAV_BAR, "the send button is above the bar");
    await page.evaluate(() => document.documentElement.setAttribute("data-keyboard", "open"));
    assert((await box()).composer > b.composer + NAV_BAR - 2, "with the keyboard up it comes down to the keyboard");
    await page.evaluate(() => document.documentElement.removeAttribute("data-keyboard"));

    step("the redo's card is on the Agent tab, in Korean, right above the message box");
    await page.waitForSelector('[data-testid="avatar-chat-extras"] [data-testid="avatar-extra"]');
    const card = page.locator('[data-testid="avatar-chat-extras"] [data-testid="avatar-extra"]');
    assert(await card.isVisible());
    const said = await card.textContent();
    assert(said.includes("후보 3장 새로 만들기"), said);
    assert(!said.includes("3 new candidates"), said);
    assert((await page.textContent('[data-testid="studio-run"]')).includes("크레딧 사용을 확인해 주세요"));
    const gap = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="avatar-chat-extras"]').getBoundingClientRect();
      const m = document.querySelector('[data-testid="avatar-composer"]').getBoundingClientRect();
      return { fits: c.top >= 0 && c.bottom <= innerHeight, gap: m.top - c.bottom };
    });
    assert(gap.fits && gap.gap >= 0 && gap.gap < 4, JSON.stringify(gap));
    await page.screenshot({ path: path.join(SHOTS, "studio-phone.png") });

    step("its OK works from there");
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/extras/x_e2e/confirm")),
      card.locator('[data-testid="avatar-extra-confirm"]').click(),
    ]);
    assert(res.ok(), `confirm: ${res.status()}`);
    await page.waitForSelector('[data-testid="avatar-chat-extras"]', { state: "detached" });
    await page.screenshot({ path: path.join(SHOTS, "studio-phone-after.png") });

    await page.goto(`${SERVER}/?view=mate`);
    await page.waitForSelector('[data-testid="mate-settings-open"]');
    step("the header: her name shows, the rest is one menu away");
    for (const [width, height] of [[360, 800], [412, 915]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);
      const name = await page.$eval('[data-testid="mate-switcher"] span.truncate', (el) => ({ shown: el.clientWidth, full: el.scrollWidth }));
      assert(name.shown > 0 && name.full <= name.shown, `her name isn't cut at ${width}: ${JSON.stringify(name)}`);
      const over = await page.$eval('[data-testid="mate-settings-open"]', (el) => el.getBoundingClientRect().right - innerWidth);
      assert(over <= 0, `the header fits at ${width}: ${over}`);
    }
    step("her ring opens the panel the heart would; the heart comes back when the ring is hidden");
    assert.equal(await page.locator('[data-testid="mate-relation-open"]').count(), 0);
    await page.click('[data-testid="mate-relation-badge"]');
    await page.waitForSelector('[data-testid="mate-relation-panel"]');
    await page.click('[data-testid="mate-relation-panel-close"]');
    const hide = (on) => ctx.request.patch(`${SERVER}/api/mates/${mate.id}/relation`, { data: { show_indicator: on } });
    const hidden = await hide(false);
    assert(hidden.ok(), `hide the ring: ${hidden.status()}`);
    await page.reload();
    await page.waitForSelector('[data-testid="mate-relation-open"]');
    await page.click('[data-testid="mate-relation-open"]');
    await page.waitForSelector('[data-testid="mate-relation-panel"]');
    await page.click('[data-testid="mate-relation-panel-close"]');
    assert((await hide(true)).ok());
    await page.reload();
    await page.waitForSelector('[data-testid="mate-relation-badge"]');

    step("a value set by hand opens the locked outfit, with word of it on the screen");
    await page.click('[data-testid="mate-relation-badge"]');
    await page.click('[data-testid="mate-relation-panel-adjust"]');
    const set = page.locator('[data-testid="mate-relation-set"]');
    await set.waitFor();
    await page.locator('[data-testid="mate-relation-slider"]').evaluate((el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "60");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await set.scrollIntoViewIfNeeded();
    await set.click();
    await page.waitForSelector('[data-testid="mate-info"]');
    const word = await page.$eval('[data-testid="mate-info"]', (el) => { const r = el.getBoundingClientRect(); return { text: el.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight }; });
    assert(word.text.includes("크롭탑"), word.text);
    assert(word.left >= 0 && word.right <= word.vw && word.top >= 36 && word.bottom <= word.vh - NAV_BAR, JSON.stringify(word));
    await page.screenshot({ path: path.join(SHOTS, "unlock-by-hand-phone.png") });
    const opened = (await (await ctx.request.get(`${SERVER}/api/mates/${mate.id}`)).json()).outfits.items.find((c) => c.id === "builtin-gray-band");
    assert.equal(opened.locked, undefined);
    assert((await ctx.request.post(`${SERVER}/api/mates/${mate.id}/relation/reset`, { data: { mode: "zero" } })).ok());
    await page.goto(`${SERVER}/?view=mate`);
    await page.waitForSelector('[data-testid="mate-settings-open"]');
    assert.equal(await page.locator('[data-testid="mate-reset"]').count(), 0);
    await page.click('[data-testid="mate-more"]');
    for (const id of ["mate-avatar-toggle", "mate-avatar-create", "mate-global-settings-open", "mate-reset"]) assert(await page.locator(`[data-testid="${id}"]`).isVisible(), id);
    await page.click('[data-testid="mate-more"]');
    await page.waitForSelector('[data-testid="mate-more-menu"]', { state: "detached" });

    step("the switcher stays on the screen");
    await page.waitForTimeout(300);
    await page.click('[data-testid="mate-switcher"]');
    const menu = await page.$eval('[data-testid="mate-switcher-menu"]', (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, vw: innerWidth }; });
    assert(menu.left >= 0 && menu.right <= menu.vw, JSON.stringify(menu));
    await page.click('[data-testid="mate-switcher"]');

    step("a panel takes the whole screen, under the status bar");
    await page.waitForTimeout(300);
    await page.click('[data-testid="mate-settings-open"]');
    await page.waitForSelector('[data-testid="mate-settings"]');
    assert.equal(await page.locator('[data-testid="mate-switcher"]').count(), 0, "her header gives its room to the panel");
    const top = await page.$eval('[data-testid="mate-settings-close"]', (el) => el.getBoundingClientRect().top);
    assert(top >= 36, `the close button is under the status bar: ${top}`);

    step("the Save bar: only with something to save, on the bottom edge");
    await page.click('[data-testid="mate-tab-style"]');
    assert.equal(await page.locator('[data-testid="mate-settings-savebar"]').count(), 0);
    const seg = await page.$eval('[role="radiogroup"]', (el) => ({ display: getComputedStyle(el).display, h: el.querySelector('[role="radio"]').offsetHeight }));
    assert.equal(seg.display, "grid");
    assert(seg.h >= 40, `a choice is big enough to press: ${seg.h}`);
    const input = page.locator('[data-testid="mate-settings"] input').first();
    await input.fill("현석");
    await page.waitForSelector('[data-testid="mate-settings-savebar"]');
    const bar = await page.$eval('[data-testid="mate-settings-savebar"]', (el) => {
      const r = el.getBoundingClientRect();
      const save = el.querySelector('[data-testid="mate-settings-save"]').getBoundingClientRect();
      const s = getComputedStyle(el);
      return { bottom: r.bottom, vh: innerHeight, saveBottom: save.bottom, background: s.backgroundColor };
    });
    assert(Math.abs(bar.bottom - bar.vh) <= 1, `the bar reaches the edge: ${bar.bottom} of ${bar.vh}`);
    assert(bar.saveBottom <= bar.vh - NAV_BAR, `its button clears the navigation bar: ${bar.saveBottom}`);
    assert(!/rgba\(.*, 0(\.\d+)?\)$/.test(bar.background), `nothing shows through it: ${bar.background}`);
    await page.locator('[data-testid="mate-settings-savebar"] .btn-ghost').click();
    await page.waitForSelector('[data-testid="mate-settings-savebar"]', { state: "detached" });

    step("another tab starts at its top");
    const scroller = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="mate-settings"] *')].find((e) => getComputedStyle(e).overflowY === "auto" && e.scrollHeight > e.clientHeight + 40)?.scrollTop ?? -1);
    await page.evaluate(() => { [...document.querySelectorAll('[data-testid="mate-settings"] *')].find((e) => getComputedStyle(e).overflowY === "auto" && e.scrollHeight > e.clientHeight + 40).scrollTop = 500; });
    assert((await scroller()) > 0);
    await page.click('[data-testid="mate-tab-profile"]');
    await page.waitForTimeout(150);
    assert.equal(await scroller(), 0);
    await page.screenshot({ path: path.join(SHOTS, "settings-phone.png") });
    await page.click('[data-testid="mate-settings-close"]');

    step("a phone on its side");
    await page.setViewportSize({ width: 800, height: 360 });
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 24, left: NAV_BAR, bottom: 0, right: 0 } });
    await page.goto(`${SERVER}/?view=mate`);
    await page.waitForSelector('[data-testid="mate-settings-open"]');
    await page.waitForTimeout(400);
    const side = await page.evaluate(() => {
      const box = (id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
      const send = box("mate-send"), gear = box("mate-settings-open"), burger = document.querySelector('[data-testid="mate-view"] button').getBoundingClientRect();
      return { send: send.bottom, gearRight: gear.right, burgerLeft: burger.left, vw: innerWidth, vh: innerHeight, over: document.documentElement.scrollWidth - innerWidth };
    });
    assert(side.over <= 0, `nothing runs off the page: ${side.over}`);
    assert(side.gearRight <= side.vw && side.send <= side.vh, JSON.stringify(side));
    assert(side.burgerLeft >= NAV_BAR, `nothing under the side bar: ${side.burgerLeft}`);
    await page.screenshot({ path: path.join(SHOTS, "mate-landscape.png") });
    await page.click('[data-testid="mate-settings-open"]');
    await page.waitForSelector('[data-testid="mate-settings"]');
    assert.equal(await page.locator('[data-testid="mate-switcher"]').count(), 0, "a panel takes the little height there is");
    await page.screenshot({ path: path.join(SHOTS, "settings-landscape.png") });

    assert.deepEqual(errors, []);
    console.log("OK: the Mate on a phone");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
