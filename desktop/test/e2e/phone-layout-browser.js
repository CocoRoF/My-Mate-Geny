// On a phone: nothing runs off the screen, and what opens from the top or the bottom bar is all there. In a browser against
// a throwaway server, no credits.
//
//   python3 desktop/test/e2e/mate-outfit-server.py 18974 <frontend dist> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/phone-layout-browser.js http://127.0.0.1:18974 outfit-test-only <shots dir>
//
// With the Android app's system bars as safe areas. Every settings tab, at the width of a small phone: no sideways scrolling
// in the page or the panel, nothing past the edge. A chat's bottom bar: its popovers are sheets on the whole screen width that
// go when pulled down, its meters span the message box's width. Its panels: their headers clear the status bar. The Mate's header: the heart is the one way into the relationship, on a phone
// and on a desktop. Her small chat window, at its smallest and usual size with the desktop app's buttons: everything in the
// header fits, her name has room, and what isn't about the conversation is in one menu.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !SHOTS) {
  console.error("usage: node phone-layout-browser.js <server url> <password> <shots dir>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const step = (s) => console.log(`• ${s}`);
const STATUS_BAR = 36;
const NAV_BAR = 48;
const TEST = (id) => `[data-testid="${id}"]`;

// What runs past the screen's edge or makes something scroll sideways. (A table or a code block may scroll on its own.)
const offScreen = (page) =>
  page.evaluate(() => {
    const out = [];
    const name = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""}.${String(el.className).slice(0, 60)}`;
    const own = (el) => el.closest('pre, table, code, .no-scrollbar, [role="tablist"], [data-scrolls-sideways]');
    const vw = innerWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page: ${document.documentElement.scrollWidth} > ${vw}`);
    for (const el of document.querySelectorAll("body *")) {
      if (own(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) {
        out.push(`scrolls sideways by ${el.scrollWidth - el.clientWidth}: ${name(el)}`);
      }
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || (r.right <= vw + 1 && r.left >= -1)) continue;
      let cut = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o !== "visible") {
          const b = p.getBoundingClientRect();
          cut = (b.right <= vw + 1 && b.left >= -1) || o === "auto" || o === "scroll";
          if (cut) break;
        }
      }
      if (!cut) out.push(`past the edge (${Math.round(r.left)}..${Math.round(r.right)}): ${name(el)}`);
    }
    return out;
  });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--no-sandbox"] });
  const problems = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const login = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
    assert(login.ok());
    const mate = (await (await ctx.request.get(`${SERVER}/api/mates`)).json()).find((m) => m.builtin === "chaerin");
    assert(mate, "the bundled mate");
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
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: STATUS_BAR, left: 0, bottom: NAV_BAR, right: 0 } });

    // The throwaway server has no accounts and few versions: what the real ones show
    const account = (id, label, primary) => ({
      id, label, primary, auth_mode: "oauth", enabled: true, weight: 1, max_concurrency: 4, status: "ready", usable: true, in_flight: primary ? 1 : 0,
      primary_mode: "normal", eligible: true, ineligible_reason: null, windows: [], model_windows: [], total_leases: 0, total_failures: 0,
      consecutive_failures: 0, cooldown_until: null, last_used_at: null, last_error: null,
      session: { method: "oauth", email: "", organization: "", plan: "", rate_limit_tier: "", expires_at: "2099-01-01T00:00:00Z", expires_in_s: 6000,
                 has_refresh_token: true, refresh_expires_at: null, updated_at: null, scopes: [], health: "valid", detail: "", actionable: false, renewable: true, checked_at: null },
    });
    await page.route("**/api/providers/claude/pool", async (route) => {
      const json = await (await route.fetch()).json();
      json.pool.enabled = true;
      json.accounts = [account("primary", "Primary · this machine", true), account("a2", "another-account", false)];
      await route.fulfill({ json });
    });
    await page.route("**/api/cli-tools", async (route) => {
      const json = await (await route.fetch()).json();
      for (const tool of json.tools ?? []) tool.channels = ["stable", "latest"];
      await route.fulfill({ json });
    });

    step("every settings tab fits a small phone");
    await page.goto(`${SERVER}/?view=settings`);
    await page.waitForSelector(TEST("settings-view"));
    await page.waitForTimeout(600);
    const tabs = await page.$$eval('[id^="settings-tab-"]', (els) => els.map((el) => el.id.replace("settings-tab-", "")));
    assert(tabs.length >= 5, `the settings list: ${tabs}`);
    for (const tab of tabs) {
      await page.goto(`${SERVER}/?view=settings&tab=${tab}`);
      await page.waitForSelector(TEST(`settings-panel-${tab}`));
      await page.waitForTimeout(1500);
      const bad = await offScreen(page);
      await page.screenshot({ path: path.join(SHOTS, `settings-${tab}.png`), fullPage: false });
      if (tab === "providers") {
        const select = page.locator('[data-testid^="cli-channel-"]').first();
        await select.waitFor({ timeout: 15000 });
        await select.scrollIntoViewIfNeeded();
        const box = await select.boundingBox();
        assert(box.x + box.width <= 360, `the channel's selector stays inside: ${JSON.stringify(box)}`);
        await page.screenshot({ path: path.join(SHOTS, "settings-providers-channel.png") });
        await page.getByText("another-account").first().scrollIntoViewIfNeeded();
        const pills = await page.getByText("another-account").first().locator("..").innerText();
        assert.equal(pills.split("사용 가능").length - 1, 1, `one "ready" per account: ${pills}`);
        await page.screenshot({ path: path.join(SHOTS, "settings-providers-account.png") });
      }
      if (bad.length) {
        problems.push(`settings/${tab}:\n    ${bad.slice(0, 6).join("\n    ")}`);
        console.log(problems.at(-1));
      }
    }

    step("a chat: the panels clear the status bar, the bottom bar's popovers are all on the screen");
    const created = await ctx.request.post(`${SERVER}/api/sessions`, { data: { provider: "claude", workspace_path: process.env.HOME, title: "layout" } });
    assert(created.ok(), `a chat: ${created.status()}`);
    const chat = await created.json();
    await page.goto(`${SERVER}/?view=chat&session=${chat.id}`);
    await page.waitForSelector("button[data-hover-popover]", { timeout: 20000 });
    for (const [n, trigger] of (await page.$$("button[data-hover-popover]")).entries()) {
      if (!(await trigger.isVisible())) continue;
      const label = await trigger.getAttribute("aria-label");
      await trigger.tap();
      await page.waitForSelector(TEST("popover-sheet"));
      const box = await page.locator(`${TEST("popover-sheet")} [role="dialog"]`).boundingBox();
      await page.waitForTimeout(350); // (its fade)
      await page.screenshot({ path: path.join(SHOTS, `chat-popover-${n}.png`) });
      assert(box.x === 0 && box.width === 360, `${label}: the whole width, got ${JSON.stringify(box)}`);
      assert(box.y >= STATUS_BAR, `${label}: under the status bar, got ${box.y}`);
      assert.deepEqual(await offScreen(page), [], `${label}: nothing past the edge`);
      await page.mouse.click(180, 8); // (its backdrop)
      await page.waitForSelector(TEST("popover-sheet"), { state: "detached" });
    }
    step("the meters under the message box: across its width, nothing past the edge, also with a long account name");
    await page.locator("textarea").first().fill("hi");
    await page.locator("button.bg-accent-grad").last().click();
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-meters"]')?.textContent.includes("≈"), null, { timeout: 30000 });
    const meters = () =>
      page.evaluate(() => {
        const row = document.querySelector('[data-testid="chat-meters"]');
        const box = row.getBoundingClientRect();
        const items = [...row.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
        return {
          left: box.left, right: innerWidth - box.right, overflow: row.scrollWidth - row.clientWidth, count: items.length,
          firstGap: items[0].left - box.left, lastGap: box.right - items.at(-1).right, end: items.at(-1).right, vw: innerWidth,
        };
      });
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 780 });
      await page.evaluate(() => {
        const name = document.querySelector('[data-testid="chat-meters"] button span.truncate');
        if (name) name.textContent = "Primary · this machine";
      });
      await page.waitForTimeout(200);
      const m = await meters();
      await page.screenshot({ path: path.join(SHOTS, `chat-meters-${width}.png`), clip: { x: 0, y: 500, width, height: 280 } });
      assert(m.count >= 2, `the meters: ${JSON.stringify(m)}`);
      assert(Math.abs(m.left - m.right) <= 1, `not to one side at ${width}: ${JSON.stringify(m)}`);
      assert(m.overflow <= 4 && m.end <= m.vw, `all inside at ${width}: ${JSON.stringify(m)}`); // (-mx-1: only the hover area)
      assert(Math.abs(m.firstGap) <= 6 && Math.abs(m.lastGap) <= 6, `from edge to edge at ${width}: ${JSON.stringify(m)}`);
    }
    await page.setViewportSize({ width: 360, height: 780 });

    step("a sheet goes when it is pulled down, and comes back when it is only tugged");
    const finger = async (x, from, to, steps = 10) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
      for (let i = 1; i <= steps; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from + ((to - from) * i) / steps }] });
        await page.waitForTimeout(24);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const sheet = TEST("popover-sheet");
    const openSheet = async () => {
      await page.locator("button[data-hover-popover]").first().tap();
      await page.waitForSelector(sheet);
      await page.waitForTimeout(300);
    };
    const handleY = async () => {
      const b = await page.locator(TEST("sheet-handle")).boundingBox();
      return b.y + b.height / 2;
    };
    await openSheet();
    await finger(180, await handleY(), (await handleY()) + 40);
    await page.waitForTimeout(350);
    assert.equal(await page.locator(sheet).count(), 1, "a tug leaves it there");
    assert.equal(await page.locator(`${sheet} [role="dialog"]`).evaluate((el) => el.style.transform), "", "and it comes back");
    await finger(180, await handleY(), (await handleY()) + 260);
    await page.waitForSelector(sheet, { state: "detached", timeout: 2000 });
    await openSheet();
    const body = await page.locator(`${sheet} [role="dialog"]`).boundingBox();
    await finger(180, body.y + 90, body.y + 350);
    await page.waitForSelector(sheet, { state: "detached", timeout: 2000 });

    step("scrolled down, the finger scrolls it back first; the handle always pulls");
    await page.setViewportSize({ width: 360, height: 300 });
    await openSheet();
    const scroller = page.locator(`${sheet} [role="dialog"]`);
    assert(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight), "a sheet that scrolls");
    await scroller.evaluate((el) => (el.scrollTop = 120));
    const low = await scroller.boundingBox();
    await finger(180, low.y + 70, low.y + 170);
    await page.waitForTimeout(350);
    assert.equal(await page.locator(sheet).count(), 1, "still open");
    assert((await scroller.evaluate((el) => el.scrollTop)) < 120, "it scrolled");
    await finger(180, await handleY(), (await handleY()) + 130);
    await page.waitForSelector(sheet, { state: "detached", timeout: 2000 });
    await page.setViewportSize({ width: 360, height: 780 });

    step("the chat's own settings sheet goes the same way");
    await page.getByText("에이전트 ·").first().click();
    await page.waitForSelector(TEST("settings-sheet"));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, "chat-settings-sheet.png") });
    await finger(180, await handleY(), (await handleY()) + 260);
    await page.waitForSelector(TEST("settings-sheet"), { state: "detached", timeout: 2000 });

    const open = async (more, item) => {
      await page.click(more);
      await page.getByText(item, { exact: true }).first().click();
    };
    await open("[data-more-toggle]", "백그라운드 작업");
    const tasks = page.locator(TEST("tasks-list"));
    if (await tasks.count()) {
      const head = await page.getByText("백그라운드 작업", { exact: true }).last().boundingBox();
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(SHOTS, "chat-tasks.png") });
      assert(head.y >= STATUS_BAR, `the tasks panel's title under the status bar: ${head.y}`);
    } else {
      problems.push("the tasks panel didn't open from the chat's menu");
    }

    step("the Mate on a phone: the heart opens her relationship, no ring and no face beside her name");
    await page.goto(`${SERVER}/?view=mate`);
    await page.waitForSelector(TEST("mate-settings-open"));
    assert.equal(await page.locator(TEST("mate-relation-badge")).count(), 0, "no ring");
    assert.equal(await page.locator(TEST("mate-state-badge")).count(), 0, "no face");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, "mate-phone-header.png"), clip: { x: 0, y: 0, width: 360, height: 110 } });
    await page.click(TEST("mate-relation-open"));
    await page.waitForSelector(TEST("mate-relation-panel"));
    await page.click(TEST("mate-relation-panel-close"));
    await page.close();

    step("the Mate on a desktop: the heart, and neither of the two");
    const wide = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wide.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
    await wide.addInitScript(
      (id) => {
        localStorage.setItem("hrh_lang", "ko");
        localStorage.setItem("hrh_theme", "light");
        localStorage.setItem("hrh_setup_seen_v2", "1");
        localStorage.setItem("hrh_mate_muted", "1");
        localStorage.setItem("hrh_mate_active", id);
        // the desktop app's bridge: every call is a no-op
        const bridge = () =>
          new Proxy(
            {},
            {
              get: (_, k) => {
                if (k === "chrome") return window.__chrome || "custom";
                if (k === "kind") return "chat";
                if (k === "then") return undefined;
                return (...args) => {
                  (window.__calls = window.__calls || []).push([k, ...args]);
                  return String(k).startsWith("on") ? () => {} : Promise.resolve({});
                };
              },
            },
          );
        if (location.search.includes("surface=mate-chat")) window.hrhNative = { window: bridge(), mate: bridge() };
      },
      mate.id,
    );
    const desk = await wide.newPage();
    desk.on("pageerror", (e) => errors.push(e.message));
    await desk.goto(`${SERVER}/?view=mate`);
    await desk.waitForSelector(TEST("mate-relation-open"));
    assert.equal(await desk.locator(TEST("mate-relation-badge")).count(), 0, "no ring");
    assert.equal(await desk.locator(TEST("mate-state-badge")).count(), 0, "no face");
    await desk.waitForTimeout(500);
    await desk.screenshot({ path: path.join(SHOTS, "mate-desktop-header.png"), clip: { x: 0, y: 0, width: 1280, height: 70 } });

    step("her small chat window: the header fits, at its usual size and its smallest");
    for (const [width, height] of [[420, 640], [320, 380]]) {
      await desk.setViewportSize({ width, height });
      await desk.goto(`${SERVER}/?surface=mate-chat&mate=${mate.id}`);
      await desk.waitForSelector(TEST("mate-chat-header"));
      await desk.waitForTimeout(500);
      const fit = await desk.evaluate(() => {
        const header = document.querySelector('[data-testid="mate-chat-header"]');
        const buttons = [...header.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
        const name = document.querySelector('[data-testid="mate-chat-name"]');
        const nameBox = name.getBoundingClientRect();
        return {
          right: Math.max(...buttons.map((b) => b.right)),
          left: Math.min(...buttons.map((b) => b.left)),
          name: nameBox.width,
          nameRight: nameBox.right,
          cut: name.scrollWidth > name.clientWidth,
          count: buttons.length,
          vw: innerWidth,
        };
      });
      await desk.screenshot({ path: path.join(SHOTS, `mate-chat-${width}.png`), clip: { x: 0, y: 0, width, height: Math.min(height, 200) } });
      assert(fit.right <= fit.vw, `the buttons fit at ${width}: ${JSON.stringify(fit)}`);
      assert(fit.nameRight <= fit.left, `her name stops before the buttons at ${width}: ${JSON.stringify(fit)}`);
      assert(fit.name >= 40 && !fit.cut, `her name has room at ${width}: ${JSON.stringify(fit)}`);
      assert.equal(await desk.locator(TEST("mate-relation-badge")).count(), 0);
      assert.equal(await desk.locator(TEST("mate-state-badge")).count(), 0);
      assert.equal(await desk.locator(TEST("window-max")).count(), 0, "no maximize in so small a window");
    }
    await desk.click(TEST("mate-chat-more"));
    await desk.waitForSelector(TEST("mate-chat-console"));
    await desk.waitForTimeout(350);
    await desk.screenshot({ path: path.join(SHOTS, "mate-chat-menu.png"), clip: { x: 0, y: 0, width: 320, height: 200 } });
    const menu = await desk.locator(TEST("mate-chat-console")).boundingBox();
    assert(menu.x >= 0 && menu.x + menu.width <= 320, `the menu stays in the window: ${JSON.stringify(menu)}`);
    await desk.click(TEST("mate-chat-console"));
    await desk.waitForFunction(() => (window.__calls || []).some(([k]) => k === "openConsole"));
    assert.equal(await desk.locator(TEST("mate-chat-console")).count(), 0, "the menu closes");
    await desk.click(TEST("mate-chat-relation"));
    await desk.waitForSelector(TEST("mate-chat-relation-panel"));

    assert.deepEqual(errors, [], "no page errors");
    if (problems.length) {
      console.log(`\nproblems:\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
    } else {
      console.log("all good");
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
