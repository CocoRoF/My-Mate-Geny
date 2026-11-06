// The wardrobe (docs/mate.md "Outfits", docs/avatar-create.md §12) in a browser against a throwaway server, no credits:
//
//   python3 desktop/test/e2e/mate-outfit-server.py 18974 <frontend dist> [pictures] &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/mate-outfit-browser.js http://127.0.0.1:18974 outfit-test-only <shots dir>
//
// Checks: Mate settings → Outfits shows her default set and the others; wearing one swaps the avatar here and in a second
// window at once; Avatar settings says which set the edits go to; swimwear is offered only for a mate with a stated adult
// age; a preset opens the studio (nothing is spent); a finished project's Wear puts the whole video set on her; rename,
// delete (her default set can't be deleted, deleting what she has on puts it back). en / ko, light / dark, desktop / phone.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !SHOTS) {
  console.error("usage: node mate-outfit-browser.js <server url> <password> <shots dir>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const step = (s) => console.log(`• ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

async function context(browser, { lang = "ko", theme = "dark", mateId, phone = false }) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, colorScheme: theme, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
  await ctx.addInitScript(
    ([l, id, th]) => {
      localStorage.setItem("hrh_lang", l);
      localStorage.setItem("hrh_mate_muted", "1");
      localStorage.setItem("hrh_theme", th);
      localStorage.setItem("hrh_setup_seen_v2", "1");
      if (id) localStorage.setItem("hrh_mate_active", id);
    },
    [lang, mateId, theme],
  );
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  return ctx;
}
const get = async (ctx, url) => (await ctx.request.get(SERVER + url)).json();

async function openTab(p, tab = "outfit") {
  await p.goto(`${SERVER}/?view=mate`);
  await p.waitForSelector('[data-testid="mate-settings-open"]', { timeout: 30000 });
  await p.click('[data-testid="mate-settings-open"]');
  await p.click(`[data-testid="mate-tab-${tab}"]`);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const errors = [];
  const watch = (p) => p.on("pageerror", (e) => errors.push(e.message));
  try {
    const boot = await context(browser, {});
    const mates = await get(boot, "/api/mates");
    const chaerin = mates.find((m) => m.builtin === "chaerin");
    const mao = mates.find((m) => m.builtin === "mao");
    assert.ok(chaerin, "the bundled mate is there");
    const mate = () => get(boot, `/api/mates/${chaerin.id}`);
    const homeBefore = chaerin.avatar.rig.home;

    step("the wardrobe: her default set first, on her");
    const ctx = await context(browser, { mateId: chaerin.id });
    const p = await ctx.newPage();
    watch(p);
    await openTab(p);
    await p.waitForSelector('[data-testid="outfit-wardrobe"]');
    const tiles = p.locator('[data-testid="outfit-tile"]');
    await until("three sets", async () => (await tiles.count()) === 3);
    assert.equal(await tiles.nth(0).getAttribute("data-outfit"), "default");
    assert.equal(await tiles.nth(0).getAttribute("data-worn"), "true");
    await p.waitForSelector('[data-testid="outfit-preset-swimwear"]');
    await p.screenshot({ path: path.join(SHOTS, "wardrobe-ko-dark.png") });

    step("the other window, to see the change arrive");
    const other = await ctx.newPage();
    watch(other);
    await other.goto(`${SERVER}/?view=mate`);
    await other.waitForSelector('[data-mate-kind="video"]', { timeout: 30000 });

    step("wearing a set swaps it here and there at once");
    const casual = (await mate()).outfits.items[1];
    await p.click(`[data-testid="outfit-wear-${casual.id}"]`);
    await until("worn", async () => (await tiles.nth(1).getAttribute("data-worn")) === "true");
    assert.equal(await tiles.nth(0).getAttribute("data-worn"), "false");
    const now = await mate();
    assert.equal(now.outfits.worn, casual.id);
    assert.equal(now.avatar.rig.home, casual.home);
    await other.waitForSelector('[data-mate-kind="photo"]', { timeout: 15000 });
    await other.screenshot({ path: path.join(SHOTS, "stage-casual-ko-dark.png") });

    step("avatar settings say which set the edits go to");
    await p.click('[data-testid="mate-tab-avatar"]');
    await p.waitForSelector('[data-testid="mate-avatar-outfit-note"]');
    await p.click('[data-testid="mate-tab-outfit"]');

    step("swimwear is only offered for a mate with a stated adult age");
    const presets = (await get(boot, `/api/mates/${chaerin.id}/outfits`)).presets.map((x) => x.id);
    assert.ok(presets.includes("swimwear") && presets.includes("pajamas"));
    if (mao) {
      const mp = (await get(boot, `/api/mates/${mao.id}/outfits`)).presets.map((x) => x.id);
      assert.ok(!mp.includes("swimwear") && mp.includes("pajamas"));
      const refused = await boot.request.post(`${SERVER}/api/avatar/studio`, { data: { mate_id: mao.id, language: "ko", outfit: { preset: "swimwear" } } });
      assert.equal(refused.status(), 409);
    }

    step("the finished project: Wear puts the whole video set on her");
    const made = (await get(boot, "/api/avatar/projects")).find((x) => x.outfit && x.status === "ready");
    assert.ok(made, "a finished outfit project");
    assert.ok(await p.locator('[data-testid="outfit-making-item"]').count() === 0, "a finished project isn't 'being made'");
    await p.goto(`${SERVER}/?view=mate&avatar=${chaerin.id}&project=${made.id}`);
    await p.waitForSelector('[data-testid="outfit-finish"]', { timeout: 30000 });
    assert.equal(await p.locator('[data-testid="avatar-new-name"], [data-testid="avatar-apply-mate"], [data-testid="avatar-restore"]').count(), 0);
    await p.screenshot({ path: path.join(SHOTS, "studio-finish-ko-dark.png") });
    await p.click('[data-testid="outfit-wear"]');
    await p.waitForSelector('[data-testid="outfit-worn"]', { timeout: 15000 });
    const dressed = await mate();
    assert.equal(dressed.avatar.kind, "video");
    assert.ok(dressed.avatar.rig.clips.length > 3 && dressed.avatar.rig.home.includes("/assets/pack-"));
    assert.equal(dressed.outfits.items.length, 4);
    await other.waitForSelector('[data-mate-kind="video"]', { timeout: 15000 });

    step("a preset opens the studio and spends nothing");
    const balance = await until("a project", async () => get(boot, "/api/avatar/projects"));
    const before = balance.length;
    await openTab(p);
    await p.waitForSelector('[data-testid="outfit-preset-pajamas"]');
    await p.click('[data-testid="outfit-preset-pajamas"]');
    await p.waitForSelector('[data-testid="studio-back"]', { timeout: 20000 });
    const opened = await until("the new project", async () => {
      const all = await get(boot, "/api/avatar/projects");
      return all.length === before + 1 && all.find((x) => x.outfit && x.outfit.preset === "pajamas");
    });
    assert.ok(["interview", "estimate"].includes(opened.status));
    await p.waitForFunction(() => document.body.innerText.includes("새 의상"), null, { timeout: 15000 });
    await p.screenshot({ path: path.join(SHOTS, "studio-preset-ko-dark.png") });
    const doc = await get(boot, `/api/avatar/projects/${opened.id}`);
    assert.equal(doc.ledger.committed, 0);
    assert.equal(doc.brief.reference.mode, "redraw");
    assert.ok(doc.files.refs[0].url.includes("ref-1.webp"));

    step("rename, and delete what she has on: her default set comes back");
    await openTab(p);
    await until("in making", async () => (await p.locator('[data-testid="outfit-making-item"]').count()) === 1);
    const worn = p.locator('[data-testid="outfit-tile"][data-worn="true"]');
    await worn.locator('[data-testid="outfit-rename"]').click();
    await p.fill('[data-testid="outfit-rename-input"]', "출근 복장");
    await p.keyboard.press("Enter");
    await until("renamed", async () => (await mate()).outfits.items.some((c) => c.name === "출근 복장"));
    assert.equal(await tiles.nth(0).locator('[data-testid="outfit-delete"]').count(), 0, "her default set can't be deleted");
    p.once("dialog", (d) => d.accept());
    await worn.locator('[data-testid="outfit-delete"]').click();
    await until("default back on", async () => {
      const m = await mate();
      return m.outfits.worn === "default" && m.avatar.rig.home === homeBefore && m.outfits.items.length === 3;
    });
    await p.close();

    step("phone, English, light");
    const phone = await context(browser, { lang: "en", theme: "light", mateId: chaerin.id, phone: true });
    const q = await phone.newPage();
    watch(q);
    await openTab(q);
    await q.waitForSelector('[data-testid="outfit-preset-swimwear"]');
    await q.screenshot({ path: path.join(SHOTS, "wardrobe-en-light-phone.png"), fullPage: false });
    const overflow = await q.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no sideways scroll (${overflow}px)`);

    assert.deepEqual(errors, [], "no page errors");
    console.log("OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
