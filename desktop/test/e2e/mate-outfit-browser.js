// The wardrobe (docs/mate.md "Outfits", docs/avatar-create.md §12) in a browser against a throwaway server, no credits:
//
//   python3 desktop/test/e2e/mate-outfit-server.py 18974 <frontend dist> [pictures] &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/mate-outfit-browser.js http://127.0.0.1:18974 outfit-test-only <shots dir>
//
// Checks: a mate without bundled outfits starts with her default set; Add outfit makes an empty place that can't
// be worn yet; files go into it like into any avatar, without touching what she has on; wearing swaps the whole set here and
// in a second window; AI opens that outfit's own project (nothing spent) and its finished set is worn from there; rename,
// delete (her default can't be deleted, deleting what she has on puts it back). ko dark, en light, desktop, phone.
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

async function openTab(p) {
  await p.goto(`${SERVER}/?view=mate`);
  await p.waitForSelector('[data-testid="mate-settings-open"]', { timeout: 30000 });
  await p.click('[data-testid="mate-settings-open"]');
  await p.click('[data-testid="mate-tab-avatar"]');
  await p.waitForSelector('[data-testid="outfit-wardrobe"]');
}
const tile = (p, id) => p.locator(`[data-testid="outfit-tile"][data-outfit="${id}"]`);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const errors = [];
  const watch = (p) => p.on("pageerror", (e) => errors.push(e.message));
  try {
    const boot = await context(browser, {});
    const mates = await get(boot, "/api/mates");
    const chaerin = mates.find((m) => m.builtin === "chaerin");
    const other = mates.find((m) => m.builtin === "seoa");
    assert.ok(chaerin && other, "the bundled mates are there");
    const mate = () => get(boot, `/api/mates/${chaerin.id}`);
    const homeBefore = chaerin.avatar.rig.home;
    const initialOutfits = chaerin.outfits.items.length;

    step("a mate that nobody dressed has only her default outfit, and nothing is offered ready-made");
    assert.deepEqual(other.outfits.items.map((c) => c.id), ["default"]);
    const q = await (await context(browser, { mateId: other.id })).newPage();
    watch(q);
    await openTab(q);
    assert.equal(await q.locator('[data-testid="outfit-tile"]').count(), 1);
    assert.equal(await q.locator('[data-testid^="outfit-preset"]').count(), 0);
    assert.equal(await q.locator('[data-testid="mate-tab-outfit"]').count(), 0);
    await q.close();

    step("Add outfit: a name makes an empty place, which can't be worn yet");
    const ctx = await context(browser, { mateId: chaerin.id });
    const p = await ctx.newPage();
    watch(p);
    await openTab(p);
    await until("her sets", async () => (await p.locator('[data-testid="outfit-tile"]').count()) === initialOutfits);
    assert.equal(await tile(p, "default").getAttribute("data-worn"), "true");
    await p.click('[data-testid="outfit-add"]');
    await p.fill('[data-testid="outfit-add-name"]', "잠옷");
    await p.click('[data-testid="outfit-add-ok"]');
    const added = await until("the new outfit", async () => (await mate()).outfits.items.find((c) => c.name === "잠옷"));
    assert.equal(added.kind, "none");
    await until("selected", async () => (await tile(p, added.id).getAttribute("aria-pressed")) === "true");
    assert.equal(await tile(p, added.id).getAttribute("data-empty"), "true");
    assert.ok(await p.locator('[data-testid="outfit-wear"]').isDisabled());
    const refused = await boot.request.post(`${SERVER}/api/mates/${chaerin.id}/outfits/${added.id}/wear`);
    assert.equal(refused.status(), 400);
    await p.waitForSelector('[data-testid="outfit-ai-open"]');
    assert.equal((await mate()).avatar.rig.home, homeBefore);
    await p.screenshot({ path: path.join(SHOTS, "add-outfit-ko-dark.png") });

    step("a file goes into that outfit like into any avatar, and what she has on doesn't change");
    await p.click('[data-testid="mate-avatar-kind-photo"]');
    const picture = path.join(path.dirname(__filename), "..", "..", "..", "backend/app/mate/builtin/assets/chaerin/smile.webp");
    await p.locator('[data-testid="mate-still-neutral"]').setInputFiles(picture);
    await p.waitForSelector('img[alt="neutral"]', { timeout: 15000 });
    await p.getByRole("button", { name: "저장" }).first().click();
    const filled = await until("filled", async () => {
      const o = await get(boot, `/api/mates/${chaerin.id}/outfits/${added.id}`);
      return o.avatar.kind === "photo" && o.avatar.rig.home && o;
    });
    assert.ok(filled.avatar.rig.home.includes(`/assets/outfits/${added.id}/stills/`), `its own folder: ${filled.avatar.rig.home}`);
    assert.equal((await mate()).avatar.rig.home, homeBefore);
    assert.equal((await mate()).outfits.worn, "default");

    step("wearing swaps the whole set here and in another window");
    const second = await ctx.newPage();
    watch(second);
    await second.goto(`${SERVER}/?view=mate`);
    await second.waitForSelector('[data-mate-kind="video"]', { timeout: 30000 });
    await p.bringToFront();
    await p.click('[data-testid="outfit-wear"]');
    await p.waitForSelector('[data-testid="outfit-is-worn"]');
    const now = await mate();
    assert.equal(now.outfits.worn, added.id);
    assert.equal(now.avatar.rig.home, filled.avatar.rig.home);
    await second.waitForSelector('[data-mate-kind="photo"]', { timeout: 15000 });

    step("her default set can be edited and worn again while another is on");
    await tile(p, "default").click();
    await until("default selected", async () => (await p.locator('[data-testid="outfit-wear"]').count()) === 1);
    await p.waitForSelector('[data-testid="mate-avatar-ai-open"]');
    assert.equal(await p.locator('[data-testid="mate-avatar-kind-video"]').getAttribute("class").then((c) => c.includes("border-accent")), true);

    step("AI: that outfit's own project, nothing spent, her own picture as the reference");
    const empty = (await mate()).outfits.items.find((c) => c.name === "출근복");
    await tile(p, added.id).click();
    await p.waitForSelector('[data-testid="outfit-ai-open"]');
    const before = (await get(boot, "/api/avatar/projects")).length;
    await p.click('[data-testid="outfit-ai-open"]');
    await p.waitForSelector('[data-testid="studio-back"]', { timeout: 20000 });
    const opened = await until("the project", async () => (await get(boot, "/api/avatar/projects")).find((x) => x.outfit?.id === added.id));
    assert.equal((await get(boot, "/api/avatar/projects")).length, before + 1);
    await p.waitForFunction(() => document.body.innerText.includes("새 의상"), null, { timeout: 15000 });
    await p.screenshot({ path: path.join(SHOTS, "studio-outfit-ko-dark.png") });
    const doc = await get(boot, `/api/avatar/projects/${opened.id}`);
    assert.equal(doc.ledger.committed, 0);
    assert.equal(doc.brief.reference.mode, "redraw");
    assert.ok(doc.files.refs[0].url.includes("ref-1.webp"));
    assert.equal(await p.locator('[data-testid="studio-section-concept"], [data-section="concept"]').count(), 0);

    step("the finished project goes into its outfit, and Wear puts the whole video set on her");
    const made = (await get(boot, "/api/avatar/projects")).find((x) => x.outfit?.id === empty.id);
    await p.goto(`${SERVER}/?view=mate&avatar=${chaerin.id}&project=${made.id}`);
    await p.waitForSelector('[data-testid="outfit-finish"]', { timeout: 30000 });
    assert.equal(await p.locator('[data-testid="avatar-new-name"], [data-testid="avatar-apply-mate"], [data-testid="avatar-restore"]').count(), 0);
    await p.click('[data-testid="outfit-wear"]');
    await p.waitForSelector('[data-testid="outfit-worn"]', { timeout: 15000 });
    const dressed = await mate();
    assert.equal(dressed.outfits.worn, empty.id);
    assert.equal(dressed.avatar.kind, "video");
    assert.ok(dressed.avatar.rig.clips.length > 3 && dressed.avatar.rig.home.includes("/assets/pack-"));
    assert.equal(dressed.outfits.items.length, initialOutfits + 1, "it filled its own place");
    await second.waitForSelector('[data-mate-kind="video"]', { timeout: 15000 });

    step("rename, and delete what she has on: her default set comes back");
    await openTab(p);
    await until("selected what she has on", async () => (await tile(p, empty.id).getAttribute("aria-pressed")) === "true");
    await p.click('[data-testid="outfit-rename"]');
    await p.fill('[data-testid="outfit-rename-input"]', "출근 복장");
    await p.keyboard.press("Enter");
    await until("renamed", async () => (await mate()).outfits.items.some((c) => c.name === "출근 복장"));
    await p.screenshot({ path: path.join(SHOTS, "wardrobe-ko-dark.png") });
    p.once("dialog", (d) => d.accept());
    await p.click('[data-testid="outfit-delete"]');
    await until("default back on", async () => {
      const m = await mate();
      return m.outfits.worn === "default" && m.avatar.rig.home === homeBefore && m.outfits.items.length === initialOutfits;
    });
    await until("default selected", async () => (await tile(p, "default").getAttribute("aria-pressed")) === "true");
    assert.equal(await p.locator('[data-testid="outfit-delete"]').count(), 0, "her default can't be deleted");
    await p.close();
    await second.close();

    step("phone, English, light");
    const phone = await context(browser, { lang: "en", theme: "light", mateId: chaerin.id, phone: true });
    const r = await phone.newPage();
    watch(r);
    await openTab(r);
    await r.waitForSelector('[data-testid="outfit-add"]');
    await r.screenshot({ path: path.join(SHOTS, "wardrobe-en-light-phone.png") });
    const overflow = await r.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
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
