// The wardrobe (docs/mate.md "Outfits", docs/avatar-create.md §12) in a browser against a throwaway server, no credits:
//
//   python3 desktop/test/e2e/mate-outfit-server.py 18974 <frontend dist> [pictures] &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/mate-outfit-browser.js http://127.0.0.1:18974 outfit-test-only <shots dir>
//
// Checks: a mate without bundled outfits starts with her default set; Add outfit makes an empty place that can't
// be worn yet; files go into it like into any avatar, without touching what she has on; wearing swaps the whole set here and
// in a second window; AI opens that outfit's own project (nothing spent) and its finished set is worn from there; rename,
// delete (her default can't be deleted, deleting what she has on puts it back); she changes by herself through the real tool,
// with its chip here and the set following in a second window, and the switch takes that away; every emotion shows with its
// value and reason, they make one state, what the user says moves them, and her crop top makes her shy, on her face too.
// ko dark, en light, desktop, phone.
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
  // (her wardrobe is in 메이트 편집 → 모습 → 옷장·세부 설정)
  // (a phone has it in ⋯)
  await p.waitForSelector('[data-testid="mate-settings-open"]', { timeout: 30000 });
  if (await p.locator('[data-testid="mate-edit"]').first().isVisible()) await p.click('[data-testid="mate-edit"]');
  else {
    await p.click('[data-testid="mate-more"]');
    await p.click('[data-testid="mate-more-menu"] [data-testid="mate-edit"]');
  }
  await p.click('[data-testid="guide-step-look-toggle"]');
  await p.locator('[data-testid="look-wardrobe"], [data-testid="guide-look-wardrobe"]').first().click();
  await p.waitForSelector('[data-testid="outfit-wardrobe"]');
}
/** the wardrobe's window closed and the studio left: back on the Mate view */
async function closeTab(p) {
  await p.click('[data-testid="node-sheet-close"]');
  await p.click('[data-testid="studio-back"]');
  await p.waitForSelector('[data-testid="mate-view"]');
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
    assert.ok(chaerin, "the bundled mate is there");
    const other = await (await boot.request.post(`${SERVER}/api/mates`, { data: { name: "새 메이트" } })).json();
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

    step("크롭탑 waits for her affinity: the card says so, the server refuses, the picture stays away");
    const ctx = await context(browser, { mateId: chaerin.id });
    const p = await ctx.newPage();
    watch(p);
    const GRAY = "builtin-gray-band";
    const grayCard = async () => (await mate()).outfits.items.find((c) => c.id === GRAY);
    const setAffinity = (v) => boot.request.patch(`${SERVER}/api/mates/${chaerin.id}/relation`, { data: { affinity: v } });
    const gray = await grayCard();
    assert.equal(gray.name, "크롭탑");
    assert.deepEqual(gray.locked, { affinity: 60 });
    assert.equal(gray.home, "");
    for (const [what, res] of [
      ["wear", await boot.request.post(`${SERVER}/api/mates/${chaerin.id}/outfits/${GRAY}/wear`)],
      ["read", await boot.request.get(`${SERVER}/api/mates/${chaerin.id}/outfits/${GRAY}`)],
      ["rename", await boot.request.patch(`${SERVER}/api/mates/${chaerin.id}/outfits/${GRAY}`, { data: { name: "x" } })],
      ["delete", await boot.request.delete(`${SERVER}/api/mates/${chaerin.id}/outfits/${GRAY}`)],
      ["studio", await boot.request.post(`${SERVER}/api/avatar/studio`, { data: { mate_id: chaerin.id, language: "ko", outfit: { id: GRAY } } })],
    ]) assert.equal(res.status(), 403, what);
    await openTab(p);
    await until("the locked tile", async () => (await tile(p, GRAY).getAttribute("data-locked")) === "true");
    assert.equal(await tile(p, GRAY).locator("img").count(), 0);
    await tile(p, GRAY).click();
    await p.waitForSelector('[data-testid="outfit-locked-hint"]');
    assert.ok((await p.textContent('[data-testid="outfit-locked-hint"]')).includes("60"));
    for (const id of ["outfit-wear", "outfit-rename", "outfit-delete", "outfit-ai-open"]) assert.equal(await p.locator(`[data-testid="${id}"]`).count(), 0, id);
    await p.screenshot({ path: path.join(SHOTS, "outfit-locked-ko-dark.png") });

    step("at 60 it opens by itself, with word of it, and stays open when the affinity falls");
    assert.ok((await setAffinity(59)).ok());
    await until("59 shown", async () => (await p.textContent('[data-testid="outfit-locked-hint"]')).includes("59"));
    assert.equal(await tile(p, GRAY).getAttribute("data-locked"), "true");
    await closeTab(p);
    assert.ok((await setAffinity(60)).ok());
    await p.waitForSelector('[data-testid="mate-info"]');
    assert.ok((await p.textContent('[data-testid="mate-info"]')).includes("크롭탑"));
    await openTab(p);
    await until("the open tile", async () => (await tile(p, GRAY).getAttribute("data-locked")) === "false");
    assert.equal(await tile(p, GRAY).locator("img").count(), 1);
    await tile(p, GRAY).click();
    await p.waitForSelector('[data-testid="outfit-wear"]');
    await p.click('[data-testid="outfit-wear"]');
    await until("worn", async () => (await mate()).outfits.worn === GRAY);
    assert.ok((await setAffinity(5)).ok());
    assert.equal((await mate()).outfits.worn, GRAY);
    assert.equal((await grayCard()).locked, undefined);

    step("a fresh start closes it again: she goes back to her default set");
    assert.ok((await boot.request.post(`${SERVER}/api/mates/${chaerin.id}/relation/reset`, { data: { mode: "zero" } })).ok());
    await until("back in her default set", async () => (await mate()).outfits.worn === "default");
    assert.deepEqual((await grayCard()).locked, { affinity: 60 });
    assert.equal((await mate()).avatar.rig.home, homeBefore);
    await until("locked again", async () => (await tile(p, GRAY).getAttribute("data-locked")) === "true");

    step("the value set by hand opens it just the same, with word of it over the panel");
    await closeTab(p);
    await p.click('[data-testid=\"mate-status-open\"]'); await p.click('[data-testid=\"stage-status-more\"]');
    await p.click('[data-testid="mate-relation-panel-adjust"]');
    const set = p.locator('[data-testid="mate-relation-set"]');
    await set.waitFor();
    const byHand = async (v) => {
      await p.locator('[data-testid="mate-relation-slider"]').evaluate((el, x) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(x));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, v);
      await set.click();
    };
    await byHand(59);
    await until("59 by hand", async () => (await mate()).relation.affinity === 59);
    assert.deepEqual((await grayCard()).locked, { affinity: 60 });
    assert.equal(await p.locator('[data-testid="mate-info"]').count(), 0);
    await byHand(60);
    await p.waitForSelector('[data-testid="mate-info"]');
    assert.ok((await p.textContent('[data-testid="mate-info"]')).includes("크롭탑"));
    assert.ok(await set.isVisible(), "the panel stays open under it");
    assert.equal((await grayCard()).locked, undefined);
    await byHand(30);
    await until("30 by hand", async () => (await mate()).relation.affinity === 30);
    assert.equal((await grayCard()).locked, undefined, "and it stays open when the value comes down by hand");
    assert.ok((await boot.request.post(`${SERVER}/api/mates/${chaerin.id}/relation/reset`, { data: { mode: "zero" } })).ok());
    await openTab(p);
    await until("locked for the rest", async () => (await tile(p, GRAY).getAttribute("data-locked")) === "true");
    await tile(p, "default").click();

    step("Add outfit: a name makes an empty place, which can't be worn yet");
    await until("her sets", async () => (await p.locator('[data-testid="outfit-tile"]').count()) === initialOutfits);
    assert.equal(await tile(p, "default").getAttribute("data-worn"), "true");
    await p.click('[data-testid="outfit-add"]');
    await p.fill('[data-testid="outfit-add-name"]', "외출복");
    await p.click('[data-testid="outfit-add-ok"]');
    const added = await until("the new outfit", async () => (await mate()).outfits.items.find((c) => c.name === "외출복"));
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
    // (an outfit changes only her clothes: no concept or profile on the canvas, the outfit's node instead)
    assert.equal(await p.locator('[data-testid="sc-node-concept"], [data-testid="sc-node-profile"]').count(), 0);
    await p.waitForSelector('[data-testid="sc-node-outfit"]');

    step("the finished project goes into its outfit, and Wear puts the whole video set on her");
    const made = (await get(boot, "/api/avatar/projects")).find((x) => x.outfit?.id === empty.id);
    await p.goto(`${SERVER}/?view=mate&avatar=${chaerin.id}&project=${made.id}`);
    // (the guide's last step: 입히기 opens the finished set's window)
    await p.click('[data-testid="guide-draw-apply"]', { timeout: 30000 });
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
    await p.click('[data-testid="outfit-delete"]');
    await p.click('[data-testid="confirm-ok"]'); // (the app's confirm dialog: a red Delete)
    await until("default back on", async () => {
      const m = await mate();
      return m.outfits.worn === "default" && m.avatar.rig.home === homeBefore && m.outfits.items.length === initialOutfits;
    });
    await until("default selected", async () => (await tile(p, "default").getAttribute("aria-pressed")) === "true");
    assert.equal(await p.locator('[data-testid="outfit-delete"]').count(), 0, "her default can't be deleted");
    await p.close();
    await second.close();

    step("she changes herself for a reason of her own; the switch takes that away");
    {
      const mine = await context(browser, { mateId: chaerin.id });
      const here = await mine.newPage();
      const watching = await mine.newPage();
      const there = await mine.newPage();
      for (const w of [here, watching, there]) watch(w);
      await openTab(there);
      await there.waitForSelector('[data-testid="outfit-self"]');
      await watching.goto(`${SERVER}/?view=mate`);
      await watching.waitForSelector('[data-mate-kind="video"]', { timeout: 30000 });
      await here.goto(`${SERVER}/?view=mate`);
      const input = here.locator('[data-testid="mate-input"]').first();
      await input.waitFor({ timeout: 30000 });
      const mateNow = async () => (await get(mine, "/api/mates")).find((m) => m.id === chaerin.id);
      const casual = (await mateNow()).outfits.items.find((c) => c.name === "캐주얼");
      const tool = async (name, args) => {
        const seen = await here.getByText(`Done: ${name}`).count();
        await input.fill(`ctool:${name} ${JSON.stringify(args)}`);
        await input.press("Enter");
        await until("her answer", async () => (await here.getByText(`Done: ${name}`).count()) > seen);
      };
      const change = (outfit) => tool("change_outfit", { outfit, reason: "오늘은 이게 입고 싶어서" });
      const chipSays = (text) => until(`chip: ${text}`, async () => (await here.locator('[data-testid="mate-activity"]', { hasText: text }).count()) > 0);
      // (whether she does is hers to decide: the tool has no count to get past)
      await change(casual.id);
      assert.equal((await mateNow()).outfits.worn, casual.id, "she changed");
      await chipSays("“캐주얼” 의상으로 갈아입었어요");
      await watching.waitForSelector('[data-mate-kind="photo"]', { timeout: 15000 });
      await here.screenshot({ path: path.join(SHOTS, "outfit-self-chip-ko-dark.png") });
      await change("default");
      await chipSays("평소 옷으로 갈아입었어요");
      assert.equal((await mateNow()).outfits.worn, "default");
      await watching.waitForSelector('[data-mate-kind="video"]', { timeout: 15000 });
      await there.locator('[data-testid="outfit-self"]').click();
      await until("switched off", async () => (await mateNow()).prefs.self_outfit === "off");
      await change(casual.id);
      await chipSays("옷은 그대로예요");
      assert.equal((await mateNow()).outfits.worn, "default", "not while it is switched off");
      await there.locator('[data-testid="outfit-self"]').click();
      await until("switched on", async () => (await mateNow()).prefs.self_outfit === "auto");

      step("how she feels: every emotion with its value and reason, one state from them; her crop top keeps her getting shyer");
      const stateOf = async () => (await mateNow()).state;
      const felt = async (emotion) => (await stateOf()).top.find((f) => f.emotion === emotion);
      const relation = await mine.request.patch(`${SERVER}/api/mates/${chaerin.id}/relation`, { data: { affinity: 70 } });
      assert.ok(relation.ok(), "affinity set");
      await tile(there, GRAY).click();
      await there.locator('[data-testid="outfit-wardrobe"]').screenshot({ path: path.join(SHOTS, "outfit-self-ko-dark.png") });
      assert.ok(!(await felt("shy")), "not shy in her usual clothes");
      await change(GRAY);
      await chipSays("“크롭탑” 의상으로 갈아입었어요");
      await until("she is shy in it", async () => (await felt("shy"))?.why?.code === "outfit");
      // (a shy clip where video plays; here, without WebGL, the shy still as the face she rests on)
      if ((await stateOf()).label === "shy") {
        await until("her face shows it", () => here.evaluate(() => {
          const body = document.querySelector("[data-mate-body]");
          return body?.getAttribute("data-mate-clip") === "shy" || [...(body?.querySelectorAll("img") ?? [])].some((i) => /\/shy\b/.test(i.src));
        }), 40000);
      }
      await here.locator('[data-testid="mate-status-open"]').click(); await here.locator('[data-testid="stage-status-more"]').click();
      const row = (emotion) => here.locator(`[data-testid="mate-state-feeling"][data-emotion="${emotion}"]`);
      await row("shy").waitFor({ timeout: 15000 });
      assert.equal(await here.locator('[data-testid="mate-state-feeling"]').count(), 8, "every emotion has its value");
      assert.ok((await row("shy").textContent()).includes("“크롭탑” 차림이라서"), "with the reason");
      assert.ok(Number(await row("shy").getAttribute("data-value")) >= 40, "with its value");
      await here.screenshot({ path: path.join(SHOTS, "state-panel-ko-dark.png") });

      step("what the user says moves it, and it comes out as one state");
      await tool("feel", { emotion: "happy", strength: "moderate", reason: "칭찬을 받아서" });
      await chipSays("기쁨: 칭찬을 받아서");
      await until("the panel follows", async () => (await row("happy").textContent()).includes("칭찬을 받아서"));
      await until("the two make one state", async () => (await stateOf()).blend === "happy_shy");
      await until("and its name shows", async () => (await here.locator('[data-testid="mate-state-now"]').textContent()).includes("수줍은 기쁨"));
      await here.screenshot({ path: path.join(SHOTS, "state-blend-ko-dark.png") });
      const say = async (text) => {
        await input.fill(text);
        await input.press("Enter");
        await until("her answer", async () => {
          const all = await get(mine, `/api/sessions/${(await mateNow()).session_id}/messages`);
          return all.some((m) => m.content === text) && all[all.length - 1].role === "assistant";
        });
      };
      for (const insult of ["닥쳐", "진짜 멍청하네", "닥쳐 이 쓸모없는"]) await say(insult);
      await until("keeping it up makes her angry", async () => (await stateOf()).label === "angry" && (await stateOf()).level >= 0.7, 30000);
      await until("the panel says why", async () => (await row("angry").textContent()).includes("거친 말을 들어서"));
      await here.screenshot({ path: path.join(SHOTS, "state-angry-ko-dark.png") });
      // (owning it right after the rude words takes off a part of it, not all: app/mate/state.py TOO_SOON_RUDE_WORTH)
      const angryNow = async () => (await stateOf()).top.find((f) => f.emotion === "angry")?.v ?? 0;
      const before = await angryNow();
      await say("미안해 내가 잘못했어");
      await until("an apology helps", async () => (await angryNow()) < before - 0.1, 30000);
      const poked = await mine.request.post(`${SERVER}/api/mates/${chaerin.id}/state/poke`);
      assert.ok(poked.ok() && (await poked.json()).top, "a tap counts");
      await change("default");
      await until("still a little shy, for having just had it on", async () => (await felt("shy"))?.why?.code === "was_outfit");
      step("a change of clothes dissolves, and she stands in the same place at the same size");
      const wear = async (id) => assert.ok((await mine.request.post(`${SERVER}/api/mates/${chaerin.id}/outfits/${id}/wear`)).ok(), `wearing ${id}`);
      // where her face is on the screen, from the set on her and where it was placed
      const faceOn = async (page) => {
        const { frame } = (await mateNow()).avatar.rig;
        assert.ok(frame?.face, "a set says where her face is");
        return page.evaluate((f) => {
          const set = document.querySelector("[data-mate-set]").getBoundingClientRect();
          const box = document.querySelector("[data-mate-frame]").getBoundingClientRect();
          return { x: set.left + f[0] * set.width, y: set.top + f[1] * set.height, h: f[2] * set.height, box: [box.left, box.top, box.width, box.height] };
        }, frame.face);
      };
      // (in her box's own measure: a wider set widens the box evenly on both sides, and on a narrow stage the whole box —
      // her with it — is a little smaller; her face stays at the same place in it, the same size: mate/avatar/framing.ts)
      const inBox = (f) => ({ x: (f.x - (f.box[0] + f.box[2] / 2)) / f.box[3], y: (f.y - f.box[1]) / f.box[3], h: f.h / f.box[3] });
      const sameSpot = (a, b, where) => {
        const [p, q] = [inBox(a), inBox(b)];
        assert.ok(Math.abs(p.x - q.x) < 0.004 && Math.abs(p.y - q.y) < 0.004, `${where}: her face moved ${JSON.stringify([a, b])}`);
        assert.ok(Math.abs(p.h - q.h) / p.h < 0.02, `${where}: her face changed size ${JSON.stringify([a, b])}`);
        assert.ok(Math.abs(a.box[1] + a.box[3] - (b.box[1] + b.box[3])) < 1.5, `${where}: she stands on the same spot ${JSON.stringify([a.box, b.box])}`);
      };
      const idle = (page) => until("the fade to end", async () => (await page.locator(".mate-outfit-out, .mate-outfit-in").count()) === 0);
      // (her set's still; none while a clip is drawn — upset as she still is, a sad idle)
      const picture = (page) => page.evaluate(() => {
        const set = document.querySelector("[data-mate-set]");
        return set?.querySelector("img")?.src || "";
      });
      const USUAL = /chaerin\/(?!outfits\/)/;
      const CROP_TOP = /crop-top/;
      // (settled in that set: its still on the screen, or — a clip drawn, no still to look at — the set she wears)
      const showing = (page, what) => until(`${what} on the screen`, async () => {
        if ((await page.locator(".mate-outfit-out, .mate-outfit-in").count()) > 0 || !(await page.locator("[data-mate-set]").count())) return false;
        const pic = await picture(page);
        if (/^https?:/.test(pic)) return what.test(pic);
        return (await mateNow()).outfits.worn === (what === CROP_TOP ? GRAY : "default");
      });
      await until("in her usual clothes", async () => (await mateNow()).outfits.worn === "default");
      await showing(here, USUAL);
      const usual = await faceOn(here);
      await here.screenshot({ path: path.join(SHOTS, "frame-usual-ko-dark.png") });
      // (what it looks like over time: which part of the fade, how see-through, which picture)
      await here.bringToFront();
      await here.evaluate(() => {
        window.__fade = [];
        window.__fadeTimer = setInterval(() => {
          const root = document.querySelector("[data-mate-kind]");
          if (root) window.__fade.push({ phase: /mate-outfit-(out|in)/.exec(root.className)?.[1] ?? "idle", opacity: Number(getComputedStyle(root).opacity), pic: root.querySelector("[data-mate-set] img")?.src ?? "" });
        }, 25);
      });
      await wear(GRAY);
      await until("it starts by fading away", async () => (await here.locator(".mate-outfit-out").count()) > 0, 8000);
      await until("and comes back in the new set", async () => (await here.locator(".mate-outfit-in").count()) > 0, 8000);
      await idle(here);
      await sleep(200);
      const fade = await here.evaluate(() => {
        clearInterval(window.__fadeTimer);
        return window.__fade;
      });
      const parts = fade.map((x) => x.phase).filter((x, i, all) => x !== all[i - 1]);
      assert.deepEqual(parts.slice(parts.indexOf("out")), ["out", "in", "idle"], `away, back, done: ${JSON.stringify(parts)}`);
      const during = (part) => fade.filter((x) => x.phase === part);
      assert.ok(during("out").some((x) => x.opacity > 0 && x.opacity < 1), `it fades away: ${JSON.stringify(during("out").map((x) => x.opacity))}`);
      assert.ok(during("in").some((x) => x.opacity > 0 && x.opacity < 1), `it fades in: ${JSON.stringify(during("in").map((x) => x.opacity))}`);
      assert.ok(during("out").every((x) => !/crop-top/.test(x.pic)), "the new set only shows once the old one is gone");
      // (a moment with a clip playing has no still to look at: only the stills shown count)
      const stillsIn = during("in").filter((x) => x.pic);
      assert.ok(stillsIn.length > 0 && stillsIn.every((x) => /crop-top/.test(x.pic)), "and it is there when she comes back");
      assert.equal(await here.evaluate(() => Number(getComputedStyle(document.querySelector("[data-mate-kind]")).opacity)), 1);
      await showing(here, CROP_TOP);
      sameSpot(usual, await faceOn(here), "desktop");
      await here.screenshot({ path: path.join(SHOTS, "frame-crop-top-ko-dark.png") });
      await wear("default");
      await showing(here, USUAL);

      await here.locator('[data-testid="mate-relation-panel-close"]').click();  // (on a phone it would cover her)
      for (const [label, size] of [["a phone", { width: 390, height: 844 }], ["a narrow window", { width: 460, height: 900 }]]) {
        await here.setViewportSize(size);
        await showing(here, USUAL);
        await sleep(300);
        const a = await faceOn(here);
        // (the server has it on at once; the screen a moment later: wait for the change to start, then to end)
        const changeTo = async (id, what) => {
          await wear(id);
          await until("the change starts", async () => (await here.locator(".mate-outfit-out, .mate-outfit-in").count()) > 0 || what.test(await picture(here)), 8000);
          await showing(here, what);
          await sleep(300);
        };
        await changeTo(GRAY, CROP_TOP);
        sameSpot(a, await faceOn(here), label);
        await here.screenshot({ path: path.join(SHOTS, `frame-crop-top-${size.width}.png`) });
        await changeTo("default", USUAL);
      }
      await mine.close();
    }

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
