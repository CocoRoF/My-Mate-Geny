// Image Studio (docs/local-image.md "Image Studio") in a browser against a throwaway server whose image engine is the
// stand-in (IMAGE_ENGINE_MODE=fake: plain pictures and frames on the CPU, through the same finishing as the real one):
//
//   NODE_PATH=<playwright-core> CHROME=<chromium> \
//     node desktop/test/e2e/image-studio-browser.js <server url> <password> <shots dir>
//
// Checks: Settings → 로컬 모델 호스팅 → Image Studio opens (its own address, page in the URL); the overview shows the
// engine, the queue and the avatar maker's stages (none ready yet); 모델: a model's license (summary, files with their
// roles and pinned revisions) must be accepted before Download, then it installs; a use's default; 시험: a draft from
// words (2 pictures) → "cut it out" carries the picture over → a cut-out (on a checkerboard) → "animate it" → a loop
// (a playing clip) → a change by words with the picture from the history; 기록: every result, a filter, a result's
// detail (what it was made from), star; 설정: the avatar maker's engine per stage, a recipe's knob, the idle time; the
// overview then shows every stage ready with its model. Screenshots: en / ko, light / dark, desktop / phone.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !SHOTS) {
  console.error("usage: node image-studio-browser.js <server url> <password> <shots dir>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${new Date().toISOString().slice(11, 19)} ${s}`);

async function until(what, fn, ms = 30000, every = 250) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn().catch(() => null);
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out: ${what}`);
}

const PHONE = { width: 390, height: 844 };
async function device(browser, { lang = "en", theme = "dark", phone = false } = {}) {
  const ctx = await browser.newContext({
    viewport: phone ? PHONE : { width: 1440, height: 960 },
    deviceScaleFactor: phone ? 2 : 1,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: theme,
  });
  const r = await ctx.request.post(SERVER + "/api/auth/login", { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.addInitScript(
    ([l, th]) => {
      try {
        localStorage.setItem("hrh_lang", l);
        localStorage.setItem("hrh_theme", th);
        localStorage.setItem("hrh_setup_completed_v1", "1");
      } catch {}
    },
    [lang, theme],
  );
  return ctx;
}

async function api(ctx, method, url, body) {
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  return { status: r.status(), body: t ? JSON.parse(t) : null };
}

const shot = async (page, name, el) => {
  const file = path.join(SHOTS, `${name}.png`);
  if (el) await page.locator(el).first().screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: false });
  console.log(`  shot ${name}`);
};

const tab = async (page, p) => {
  await page.click(`[data-testid="is-tab-${p}"]`);
  await page.waitForSelector(`[data-testid="image-studio"][data-page="${p}"]`);
  assert.equal(new URL(page.url()).searchParams.get("page"), p, "the page is in the address");
};

/** run the form's job → wait for THAT job's result (the panel keeps showing the previous one until it changes) */
async function run(page, use) {
  const sel = '[data-testid="is-try-state"]';
  const before = (await page.locator(sel).count()) ? await page.getAttribute(sel, "data-job") : null;
  await page.click(`[data-testid="is-try-run-${use}"]`);
  await until(`the ${use} is done`, async () => {
    const [job, state] = [await page.getAttribute(sel, "data-job"), await page.getAttribute(sel, "data-state")];
    if (job !== before && state === "failed") throw new Error(`${use} failed: ${await page.innerText('[data-testid="is-try-error"]')}`);
    return job !== before && state === "done";
  }, 60000);
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    const ctx = await device(browser);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    step("Settings → Image Studio: overview (engine, queue, the avatar maker's stages)");
    await page.goto(`${SERVER}/?view=settings&tab=image-studio`);
    await page.waitForSelector('[data-testid="image-studio"][data-page="overview"]');
    await page.waitForSelector('[data-testid="is-engine"]');
    await page.waitForSelector('[data-testid="is-queue-idle"]');
    for (const st of ["design", "home", "stills", "clips", "matte"])
      assert.equal(await page.getAttribute(`[data-testid="is-avatar-${st}"]`, "data-ready"), "false", `${st}: no model yet`);
    await shot(page, "01-overview-empty-dark-en");

    step("models: the license first (its files, roles, revisions), then Download");
    await tab(page, "models");
    const card = '[data-testid="is-model-anima-turbo"]';
    await page.waitForSelector(card);
    const files = await page.locator('[data-testid="is-model-files-anima-turbo"] li').allInnerTexts();
    assert.equal(files.length, 3, "the model, its text encoder and VAE");
    assert.ok(files.some((f) => /text encoder/.test(f)) && files.some((f) => /VAE/.test(f)), files.join(" | "));
    assert.ok(await page.locator(`${card} a[href*="/tree/6e0b2da211"]`).count(), "the pinned revision is linked");
    assert.ok(await page.isDisabled('[data-testid="is-model-install-anima-turbo"]'), "no download before the license");
    await shot(page, "02-model-license-dark-en", card);
    for (const id of ["anima-turbo", "flux2-klein-4b", "wan22-fun-5b", "lucida"]) {
      await page.check(`[data-testid="is-model-accept-${id}"]`);
      await page.click(`[data-testid="is-model-install-${id}"]`);
      await until(`${id} installed`, async () => (await page.getAttribute(`[data-testid="is-model-${id}"]`, "data-installed")) === "true");
    }
    const st = (await api(ctx, "GET", "/api/image/status")).body;
    assert.deepEqual(st.defaults, { draft: "anima-turbo", edit: "flux2-klein-4b", loop: "wan22-fun-5b", cutout: "lucida" });
    assert.ok(st.models.find((m) => m.id === "anima-turbo").license_accepted, "the acceptance is kept");
    await shot(page, "03-models-installed-dark-en");

    step("try: a draft from words → two pictures");
    await tab(page, "try");
    await page.fill('[data-testid="is-try-prompt-draft"]', "1girl, solo, a cheerful girl with short silver hair, waist-up, grey background");
    await run(page, "draft");
    assert.equal(await page.locator('[data-testid="is-try-result"] button img').count(), 2, "two thumbnails");
    await shot(page, "04-try-draft-dark-en");

    step("→ cut it out: the picture carried over; the cut-out on a checkerboard");
    await page.click('[data-testid="is-try-next-cutout"]');
    await page.waitForSelector('[data-testid="is-try-form-cutout"] [data-testid="is-try-image-cutout"] img');
    await run(page, "cutout");
    assert.ok(await page.locator('[data-testid="is-try-result"] img.is-checker').count(), "the cut-out shows on a checkerboard");
    await shot(page, "05-try-cutout-dark-en");

    step("→ animate it: a loop that plays");
    await tab(page, "history");
    const draftJob = (await api(ctx, "GET", "/api/image/jobs?kind=draft")).body.items[0];
    await tab(page, "try");
    await page.click('[data-testid="is-try-use"] button:has-text("Loops")');
    await page.click('[data-testid="is-try-image-loop-recent"]');
    await page.click(`img[src*="/api/image/jobs/${draftJob.id}/files/1.png"]`);
    await page.fill('[data-testid="is-try-prompt-loop"]', "She breathes quietly and blinks. Static camera.");
    await run(page, "loop");
    await page.waitForSelector('[data-testid="is-try-result"] video');
    await shot(page, "06-try-loop-dark-en");

    step("a change by words, the picture from the history");
    await page.click('[data-testid="is-try-use"] button:has-text("Changes")');
    await page.click('[data-testid="is-try-image-edit-recent"]');
    await page.click(`img[src*="/api/image/jobs/${draftJob.id}/files/2.png"]`);
    await page.fill('[data-testid="is-try-prompt-edit"]', "Make her smile happily with her eyes closed");
    await run(page, "edit");

    step("history: every result, a filter, a result's detail, star");
    await tab(page, "history");
    await until("4 results", async () => (await page.locator('[data-testid^="is-job-img"]').count()) === 4);
    await page.click('[data-testid="is-history-kind"] button:has-text("Loop")');
    await until("only the loop", async () => (await page.locator('[data-testid^="is-job-img"]').count()) === 1);
    await page.locator('[data-testid^="is-job-img"]').first().click();
    await page.waitForSelector('[data-testid="is-job-detail"]');
    assert.ok(await page.locator('[data-testid="is-job-detail"] img[src*="/files/in-image"]').count(), "what it was made from");
    await page.click('[data-testid="is-job-star"]');
    await until("starred", async () => (await api(ctx, "GET", "/api/image/jobs?starred=1")).body.total === 1);
    await shot(page, "07-history-detail-dark-en");
    await page.keyboard.press("Escape");
    await page.click('[data-testid="is-history-kind"] button:has-text("All")');

    step("settings: the avatar maker's engine per stage, a recipe's knob, the idle time");
    await tab(page, "settings");
    await page.click('[data-testid="is-set-avatar-clips"] button:has-text("Higgsfield")');
    await until("saved", async () => (await api(ctx, "GET", "/api/image/settings")).body.avatar.clips === "higgsfield");
    await page.fill('[data-testid="is-set-idle"]', "5");
    await page.locator('[data-testid="is-set-engine"] button:has-text("Save")').first().click();
    await until("idle saved", async () => (await api(ctx, "GET", "/api/image/settings")).body.values.idle_stop_seconds === 300);
    await shot(page, "08-settings-dark-en");

    step("the overview: every stage ready, the clips starting on Higgsfield");
    await tab(page, "overview");
    for (const s of ["design", "home", "stills", "clips", "matte"])
      await until(`${s} ready`, async () => (await page.getAttribute(`[data-testid="is-avatar-${s}"]`, "data-ready")) === "true");
    const av = (await api(ctx, "GET", "/api/image/status")).body.avatar.stages;
    assert.equal(av.clips.default, "higgsfield");
    assert.equal(av.design.default, "local");
    await shot(page, "09-overview-ready-dark-en");
    assert.deepEqual(errors, [], "no page errors");

    step("a reload stays on the page; a link opens one");
    await page.goto(`${SERVER}/?view=settings&tab=image-studio&page=history`);
    await page.waitForSelector('[data-testid="image-studio"][data-page="history"]');
    await ctx.close();

    for (const [lang, theme, phone] of [["ko", "light", false], ["ko", "dark", false], ["en", "light", true], ["ko", "dark", true]]) {
      const c = await device(browser, { lang, theme, phone });
      const p = await c.newPage();
      const tag = `${theme}-${lang}${phone ? "-phone" : ""}`;
      for (const pg of ["overview", "models", "try", "history", "settings"]) {
        await p.goto(`${SERVER}/?view=settings&tab=image-studio&page=${pg}`);
        await p.waitForSelector(`[data-testid="image-studio"][data-page="${pg}"]`);
        await sleep(600);
        await shot(p, `10-${pg}-${tag}`);
      }
      step(`screens: ${tag}`);
      await c.close();
    }
    console.log("OK — Image Studio");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
