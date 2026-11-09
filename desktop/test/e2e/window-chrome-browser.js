// In the desktop app, full-screen views begin below its title bar (frontend/src/index.css --window-chrome-height): the image
// viewer, a turn's changes, the sidebar of a narrow window. The bar stays usable (moving the window, its buttons) and nothing
// is drawn under the macOS traffic lights. The desktop bridge is faked: macOS, then Windows / Linux; a browser without it
// keeps the whole screen. Against a throwaway server, no real engine:
//
//   python3 desktop/test/e2e/session-rewind-server.py 18976 <frontend dist> <workspace> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/window-chrome-browser.js http://127.0.0.1:18976 rewind-test-only <workspace> <shots dir>
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, WORK, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !WORK || !SHOTS) {
  console.error("usage: node window-chrome-browser.js <server url> <password> <workspace> <shots dir>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const IMAGE = path.resolve(__dirname, "../../../frontend/public/logo.png");
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

/** `chrome`: the desktop app's bridge as its preload gives it (lib/nativeWindow.ts), or none (a browser). */
async function context(browser, { chrome = null, kind = "console" } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: "dark" });
  await ctx.addInitScript(
    ([c, k]) => {
      localStorage.setItem("hrh_lang", "en");
      localStorage.setItem("hrh_setup_seen_v2", "1");
      localStorage.setItem("hrh_session_panel", "0"); // (a narrow window shows the open session panel over the chat)
      if (!c) return;
      window.hrhNative = {
        window: {
          chrome: c,
          kind: k,
          platform: c === "mac" ? "darwin" : "win32",
          initial: { maximized: false, fullscreen: false, focused: true },
          minimize() {},
          toggleMaximize() {},
          close() {},
          getState: async () => null,
          onState: () => () => {},
        },
      };
    },
    [chrome, kind],
  );
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  return ctx;
}
const api = async (ctx, method, url, data) => {
  const r = await ctx.request.fetch(SERVER + url, { method, data, headers: { "Content-Type": "application/json" } });
  assert.ok(r.ok(), `${method} ${url}: ${r.status()}`);
  return r.json();
};
const composer = (p) => p.locator("textarea").first();
const idle = (ctx, sid) => until("the turn to end", async () => !(await api(ctx, "GET", `/api/sessions/${sid}`)).running);
/** where it begins once it has finished appearing (it fades in from a little lower) */
const top = async (locator) => {
  await locator.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))));
  return Math.round((await locator.boundingBox()).y);
};
/** What is at the middle of the title bar (and of its window buttons) is the bar: nothing covers it. */
const barUsable = (p) =>
  p.evaluate(() =>
    ['[data-testid="title-bar"]', '[data-testid="window-controls"]'].every((sel) => {
      const el = document.querySelector(sel);
      if (!el) return sel.includes("window-controls"); // (macOS: the traffic lights, no buttons of ours)
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }),
  );

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox"] });
  const errors = [];
  try {
    step("a chat with a picture and a turn that changed a file");
    const boot = await context(browser);
    const sid = (await api(boot, "POST", "/api/sessions", { provider: "claude", model: "sonnet", workspace_path: WORK, title: "Overlays" })).id;
    const p0 = await boot.newPage();
    p0.on("pageerror", (e) => errors.push(e.message));
    await p0.goto(`${SERVER}/?view=chat&session=${sid}`);
    await composer(p0).waitFor({ timeout: 30000 });
    const uploaded = p0.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/attachments") && r.ok());
    await p0.setInputFiles('[data-testid="composer-file-input"]', IMAGE);
    await uploaded;
    await sleep(300);
    await composer(p0).fill("a picture");
    await composer(p0).press("Enter");
    await idle(boot, sid);
    const starts = async () => (await api(boot, "GET", `/api/sessions/${sid}/events`)).filter((e) => e.type === "session.start").length;
    const started = await starts();
    await composer(p0).fill("a turn that changes a file");
    await composer(p0).press("Enter");
    await until("the engine to start (after the snapshot of the folder)", async () => (await starts()) > started);
    fs.writeFileSync(path.join(WORK, "tracked.txt"), "changed\n");
    await idle(boot, sid);
    await until("the change on record", async () => (await api(boot, "GET", `/api/sessions/${sid}/events`)).some((e) => e.type === "turn.changes"));
    await p0.close();

    for (const chrome of ["mac", "custom", null]) {
      const tag = chrome ?? "browser";
      const bar = chrome ? 36 : 0;
      step(`${tag}: the image viewer begins below the title bar`);
      const ctx = await context(browser, { chrome });
      const p = await ctx.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(`${SERVER}/?view=chat&session=${sid}`);
      await composer(p).waitFor({ timeout: 30000 });
      if (chrome) assert.equal(Math.round((await p.locator('[data-testid="title-bar"]').boundingBox()).height), bar);
      await p.locator('button[title="logo.png"]').first().click();
      const viewer = p.locator('[data-testid="image-lightbox"]');
      await viewer.waitFor();
      assert.equal(await top(viewer), bar);
      if (chrome) assert.ok(await barUsable(p), "the title bar is not covered");
      await p.screenshot({ path: path.join(SHOTS, `viewer-${tag}.png`) });
      await p.keyboard.press("Escape");
      await viewer.waitFor({ state: "detached" });

      step(`${tag}: a turn's changes too`);
      await p.getByRole("button", { name: "View all changes" }).first().click();
      const changes = p.locator('[data-testid="changes-modal"]');
      await changes.waitFor();
      assert.equal(await top(changes), bar);
      if (chrome) assert.ok(await barUsable(p), "the title bar is not covered");
      await p.screenshot({ path: path.join(SHOTS, `changes-${tag}.png`) });
      await p.keyboard.press("Escape");
      await changes.waitFor({ state: "detached" });

      step(`${tag}: and the sidebar of a narrow window`);
      await p.setViewportSize({ width: 600, height: 820 });
      await p.getByRole("button", { name: "Open menu" }).click();
      const drawer = p.locator('[data-testid="sidebar-drawer"]');
      await drawer.waitFor();
      assert.equal(await top(drawer), bar);
      if (chrome) assert.ok(await barUsable(p), "the title bar is not covered");
      await p.screenshot({ path: path.join(SHOTS, `drawer-${tag}.png`) });
      await ctx.close();
    }

    step("the chat window's header is its title bar: 52px there");
    const chat = await context(browser, { chrome: "mac", kind: "chat" });
    const c = await chat.newPage();
    await c.goto(`${SERVER}/`);
    const height = await until("the page to claim the chrome", () =>
      c.evaluate(() => document.documentElement.dataset.hrhChrome && getComputedStyle(document.documentElement).getPropertyValue("--window-chrome-height").trim()),
    );
    assert.equal(height, "52px");
    await chat.close();

    assert.deepEqual(errors, [], "no page errors");
    console.log("OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
