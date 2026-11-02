// Avatar Create (docs/avatar-create.md) in a browser against a throwaway server on THIS machine — no credits spent:
// Higgsfield's account API is desktop/test/e2e/higgsfield-stub.py (quotes, balance, plans, the result files), the
// `higgsfield` CLI is fake-higgsfield.py (its "results" are the official mates' real pictures and Kling clips), the
// agent is fake-claude.py driving the REAL avatar MCP bridge (`atool:<name> <json>` lines), and the processing
// (cut-out, stills, alpha recovery, encoding, checks, export) is the real pipeline.
//
//   python3 -P desktop/test/e2e/higgsfield-stub.py 18973 <files dir> &
//   backend with CLAUDE_BINARY=desktop/test/e2e/fake-claude.py HIGGSFIELD_BINARY=desktop/test/e2e/fake-higgsfield.py
//     HIGGSFIELD_*_URL / HIGGSFIELD_API_BASE=<stub>… AVATAR_VENV=<a ready processing venv>,
//     and $HOME/.fake-higgsfield.json {masters, files_dir, files_url: <stub>/fake-files, log}
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium> \
//     node desktop/test/e2e/avatar-create-browser.js <server url> <password> <stub url> <shots dir> <jobs log>
//
// Checks: the interview cards (upload, choice, slider) answer the agent; the estimate card has Higgsfield's prices;
// before Confirm nothing is generated — the agent's redo is refused by the server and wrong / stale confirmations get
// 409; Confirm runs the plan: candidates → pick → base picture → approve → stills → approve → clips → real
// processing → check → export; the finished avatar plays in the panel (talking picks a talk clip); Apply puts it on
// the mate (the Mate view plays it), Restore puts the old one back. Screenshots: en / ko, light / dark, desktop /
// phone.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, STUB, SHOTS, JOBS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !STUB || !SHOTS || !JOBS) {
  console.error("usage: node avatar-create-browser.js <server url> <password> <stub url> <shots dir> <jobs log>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${new Date().toISOString().slice(11, 19)} ${s}`);
const jobs = () => (fs.existsSync(JOBS) ? fs.readFileSync(JOBS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function until(what, fn, ms = 30000, every = 250) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out: ${what}`);
}

const PHONE = { width: 390, height: 844 };
async function device(browser, { lang = "en", theme = "dark", phone = false } = {}) {
  const ctx = await browser.newContext({
    viewport: phone ? PHONE : { width: 1440, height: 900 },
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
  else await page.screenshot({ path: file });
  console.log(`  shot ${name}`);
};

async function connectHiggsfield(ctx) {
  const accounts = (await api(ctx, "GET", "/api/higgsfield")).body.accounts || [];
  if (accounts.length) return;
  const start = (await api(ctx, "POST", "/api/higgsfield/login/start", {})).body;
  const r = await fetch(start.authorize_url, { redirect: "manual" });
  const done = await api(ctx, "POST", "/api/higgsfield/login/complete", { callback: r.headers.get("location") });
  assert.equal(done.status, 200, JSON.stringify(done.body));
}

async function idle(page) {
  await until("agent idle", async () => (await page.locator('[data-testid="avatar-stop"]').count()) === 0, 60000);
  await sleep(300);
}

async function say(page, text) {
  await idle(page);
  const before = await page.locator('[data-testid="avatar-user-message"]').count();
  await page.fill('[data-testid="avatar-input"]', text);
  await page.click('[data-testid="avatar-send"]');
  await until("message shown", async () => (await page.locator('[data-testid="avatar-user-message"]').count()) > before);
  await idle(page);
}

const project = (page) => page.evaluate(async () => {
  const list = await (await fetch("/api/avatar/projects")).json();
  return list[0] ? await (await fetch(`/api/avatar/projects/${list[0].id}`)).json() : null;
});

async function openAvatarCreate(page, { pick = null } = {}) {
  await page.goto(`${SERVER}/?view=mate`);
  await page.waitForSelector('[data-testid="mate-avatar-create"]', { timeout: 30000 });
  await page.click('[data-testid="mate-avatar-create"]');
  await page.waitForSelector('[data-testid="avatar-create"]');
  if (pick !== null) {
    await page.waitForSelector('[data-testid="avatar-project-item"]');
    await page.locator('[data-testid="avatar-project-item"]').nth(pick).click();
    await page.waitForSelector('[data-testid="avatar-panel"], [data-testid="avatar-tab-chat"]');
    await sleep(1200);
  }
}

const Q_UPLOAD = { question: "Do you have a picture of the character?", kind: "upload", options: [{ value: "none", label: "No reference — design from a description" }] };
const Q_MOTIONS = {
  question: "How much should she move?",
  kind: "choice",
  options: [
    { value: "minimal", label: "Minimal — 6 clips", description: "idle ×2, talk ×2, listen, think · 6 stills" },
    { value: "standard", label: "Standard — 15 clips (like 한채린)", description: "+ 7 reactions and doze · 11 stills" },
    { value: "rich", label: "Rich — 21 clips", description: "+ more idle/talk/listen/think, angry, sleepy" },
  ],
};
const Q_COUNT = { question: "How many candidates to choose from?", kind: "slider", min: 1, max: 4, step: 1, default: 2, unit: "" };

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const setup = await device(browser);
  await connectHiggsfield(setup);
  const env = (await api(setup, "GET", "/api/avatar/env")).body;
  assert.ok(env.higgsfield.connected && env.higgsfield.cli, "higgsfield ready " + JSON.stringify(env.higgsfield));
  assert.ok(env.deps.ready, "processing venv ready (AVATAR_VENV)");
  const mates = (await api(setup, "GET", "/api/mates")).body;
  const chaerin = mates.find((m) => m.builtin === "chaerin") || mates[0];
  const oldAvatar = JSON.stringify(chaerin.avatar);

  // ── the main run: English, dark, desktop ──
  const ctx = await device(browser, { lang: "en", theme: "dark" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("  pageerror:", e.message));
  step("open Avatar Create from the Mate view");
  await page.goto(`${SERVER}/?view=mate`);
  await page.waitForSelector('[data-testid="mate-avatar-create"]', { timeout: 30000 });
  await shot(page, "00-mate-view-button-dark-en");
  await page.click('[data-testid="mate-avatar-create"]');
  await page.waitForSelector('[data-testid="avatar-intro"]');
  await shot(page, "01-intro-dark-en");
  await page.click('[data-testid="avatar-start"]');
  await page.waitForSelector('[data-testid="avatar-panel"]');
  await until("the agent's first turn", async () => (await page.locator('[data-testid="avatar-turn"]').count()) > 0, 30000);
  await idle(page);

  step("interview: upload card → no reference");
  await say(page, `atool:ask_user ${JSON.stringify(Q_UPLOAD)}`);
  await page.waitForSelector('[data-testid="avatar-question"][data-live="1"][data-kind="upload"]');
  await shot(page, "02-interview-upload-dark-en");
  await page.locator('[data-testid="avatar-question"][data-live="1"] [data-testid="avatar-q-option"]').first().click();
  await until("answer sent", async () => (await page.locator('[data-testid="avatar-user-message"]').last().innerText()).includes("No reference"));
  await idle(page);

  step("interview: motions card → minimal; candidates slider");
  await say(page, `atool:ask_user ${JSON.stringify(Q_MOTIONS)}`);
  await page.waitForSelector('[data-testid="avatar-question"][data-live="1"][data-kind="choice"]');
  await shot(page, "03-interview-motions-dark-en");
  await page.click('[data-testid="avatar-question"][data-live="1"] [data-value="minimal"]');
  await idle(page);
  await say(page, `atool:ask_user ${JSON.stringify(Q_COUNT)}`);
  await page.waitForSelector('[data-testid="avatar-question"][data-live="1"][data-kind="slider"]');
  await page.click('[data-testid="avatar-question"][data-live="1"] [data-testid="avatar-q-send"]');
  await idle(page);
  assert.equal(await page.locator('[data-testid="avatar-question"][data-live="1"]').count(), 0, "answered cards close");

  step("brief + estimate (real quote calls to the account API)");
  const brief = {
    patch: {
      reference: { mode: "none" },
      design: { prompt: "A quiet young woman with long black hair in an oversized black hoodie and white cat-ear headphones; anime illustration." },
      preset: "minimal",
      candidates: 2,
      target: { mode: "existing", mate_id: chaerin.id },
    },
  };
  await say(page, `atool:update_brief ${JSON.stringify(brief)}\natool:estimate {}`);
  await page.waitForSelector('[data-testid="avatar-estimate"]');
  await page.waitForSelector('[data-testid="avatar-estimate-inline"]');
  let p = await project(page);
  assert.equal(p.status, "estimate");
  assert.ok(p.plan.complete, JSON.stringify(p.plan.errors));
  // 2 candidates·2 + cut-out 0.5 + 6 stills·2 + 6 clips·9 + 6 mattes·1 (the stub's per-job prices)
  assert.equal(p.plan.total, 4 + 0.5 + 12 + 54 + 6);
  assert.equal(p.plan.usd, Number((p.plan.total * 0.033).toFixed(2)));
  const quotes = await (await fetch(STUB + "/e2e/quotes")).json();
  assert.deepEqual([...new Set(quotes.map((q) => q.job_type))].sort(), ["image_background_remover", "kling_o3_flf", "nano_banana_pro", "video_background_remover"]);
  await shot(page, "05-estimate-dark-en");
  await shot(page, "05b-estimate-card-dark-en", '[data-testid="avatar-estimate"]');

  step("the gate: nothing runs before Confirm");
  assert.equal(jobs().length, 0, "no Higgsfield job before the confirmation");
  await say(page, 'atool:regenerate {"item":"design"}');
  const redo = page.locator('[data-testid="avatar-tool-regenerate"]').last();
  assert.equal(await redo.getAttribute("data-error"), "1", "the agent's redo is refused");
  assert.match(await page.locator('[data-testid="avatar-turn"]').last().innerText(), /regenerate=error/);
  let r = await api(ctx, "POST", `/api/avatar/projects/${p.id}/confirm`, { plan_id: p.plan.id, total: p.plan.total - 1 });
  assert.equal(r.status, 409, "a wrong total is refused");
  r = await api(ctx, "POST", `/api/avatar/projects/${p.id}/confirm`, { plan_id: "plan_old", total: p.plan.total });
  assert.equal(r.status, 409, "another plan is refused");
  r = await api(ctx, "POST", `/api/avatar/projects/${p.id}/redo`, { item: "design" });
  assert.equal(r.status, 409, "a user redo before the confirmation is refused");
  assert.equal(jobs().length, 0, "still no job");
  await shot(page, "06-gate-refused-dark-en");

  step("Confirm → candidates");
  await page.click('[data-testid="avatar-estimate-confirm"]');
  await page.waitForSelector('[data-testid="avatar-checkpoint-pick"]', { timeout: 120000 });
  assert.equal(jobs().filter((j) => j.job_type === "nano_banana_pro").length, 2);
  await idle(page);
  await say(page, 'atool:look {"target":"candidates"}');
  await shot(page, "07-pick-dark-en");
  await page.click('[data-testid="avatar-pick-c1"]');
  step("base picture");
  await page.waitForSelector('[data-testid="avatar-checkpoint-home"]', { timeout: 180000 });
  await sleep(800);
  await shot(page, "08-home-dark-en");
  await page.click('[data-testid="avatar-approve-home"]');
  step("stills");
  await page.waitForSelector('[data-testid="avatar-checkpoint-stills"]', { timeout: 300000 });
  await sleep(800);
  await shot(page, "09-stills-dark-en");
  await page.click('[data-testid="avatar-approve-stills"]');

  step("clips + real processing (minutes)");
  await until("processing visible", async () => (await page.locator('[data-testid="avatar-processing"]').count()) > 0, 300000, 1000);
  await shot(page, "10-progress-dark-en");
  const t0 = Date.now();
  await page.waitForSelector('[data-testid="avatar-finish"]', { timeout: 40 * 60000 });
  console.log(`  processing took ${Math.round((Date.now() - t0) / 1000)} s`);
  p = await project(page);
  assert.equal(p.status, "ready", p.error);
  assert.equal(jobs().filter((j) => j.job_type === "kling_o3_flf").length, 6);
  assert.equal(jobs().filter((j) => j.job_type === "video_background_remover").length, 6);
  assert.ok(p.ledger.committed <= p.confirmation.cap);
  console.log("  check:", JSON.stringify(p.check));
  assert.ok(p.check.passed, "the official clips loop: " + JSON.stringify(p.check.redo));

  step("the avatar plays in the panel");
  const clipOf = () => page.locator('[data-testid="avatar-preview"] [data-mate-clip]').first().getAttribute("data-mate-clip").catch(() => null);
  await until("a clip on screen", clipOf, 30000);
  await sleep(1500);
  await shot(page, "11-ready-dark-en");
  await page.click('[data-testid="avatar-try-talking"]');
  await until("talking plays a talk clip", async () => /^talk/.test((await clipOf()) || ""), 30000);
  await shot(page, "11b-ready-talking-dark-en", '[data-testid="avatar-finish"]');

  step("apply to the mate, then restore");
  await page.selectOption('[data-testid="avatar-apply-mate"]', chaerin.id);
  await page.click('[data-testid="avatar-apply"]');
  await page.waitForSelector('[data-testid="avatar-applied"]');
  let m = (await api(ctx, "GET", `/api/mates/${chaerin.id}`)).body;
  assert.equal(m.avatar.kind, "video");
  assert.ok(m.avatar.rig.clips.every((c) => c.src.includes(`/api/mates/${chaerin.id}/assets/pack-`)), "the new clips");
  assert.equal(m.avatar.rig.clips.length, 6);
  await page.click('[data-testid="avatar-close"]');
  await page.waitForSelector('[data-testid="mate-split"]');
  await until("the mate plays the new avatar", async () => {
    const src = await page.evaluate(() => document.querySelector("[data-mate-clip]")?.getAttribute("data-mate-clip"));
    return !!src;
  }, 30000);
  await sleep(2000);
  await shot(page, "12-mate-with-new-avatar-dark-en");
  await page.click('[data-testid="mate-avatar-create"]');
  await page.locator('[data-testid="avatar-project-item"]').first().click();
  await page.waitForSelector('[data-testid="avatar-restore"]');
  await page.click('[data-testid="avatar-restore"]');
  await until("restored", async () => JSON.stringify((await api(ctx, "GET", `/api/mates/${chaerin.id}`)).body.avatar) === oldAvatar, 20000);
  await page.selectOption('[data-testid="avatar-apply-mate"]', chaerin.id);
  await page.click('[data-testid="avatar-apply"]');
  await page.waitForSelector('[data-testid="avatar-applied"]');

  step("a second project, left at the estimate (for the other screenshots)");
  await page.click('[data-testid="avatar-projects"]');
  await page.click('[data-testid="avatar-start"]');
  await page.waitForSelector('[data-testid="avatar-panel"]');
  await until("first turn", async () => (await page.locator('[data-testid="avatar-turn"]').count()) > 0, 30000);
  await say(page, `atool:update_brief ${JSON.stringify({ patch: { ...brief.patch, preset: "standard", candidates: 4 } })}\natool:estimate {}\natool:ask_user ${JSON.stringify(Q_MOTIONS)}`);
  await page.waitForSelector('[data-testid="avatar-estimate"]');
  const p2 = await project(page);
  assert.equal(p2.plan.total, 8 + 0.5 + 22 + 150, "standard: 15 clips, 11 stills, 4 candidates");
  await ctx.close();

  // ── the other looks: ko / en, light / dark, desktop / phone ──
  for (const lang of ["en", "ko"]) {
    for (const theme of ["light", "dark"]) {
      for (const phone of [false, true]) {
        if (lang === "en" && theme === "dark" && !phone) continue;
        const tag = `${theme}-${lang}${phone ? "-phone" : ""}`;
        step(`screens: ${tag}`);
        const c = await device(browser, { lang, theme, phone });
        const pg = await c.newPage();
        pg.on("dialog", (d) => d.accept());
        // the estimate project (newest first in the list)
        await openAvatarCreate(pg, { pick: 0 });
        if (phone) {
          await shot(pg, `20-estimate-chat-${tag}`);
          await pg.click('[data-testid="avatar-tab-project"]');
          await sleep(500);
          await shot(pg, `21-estimate-panel-${tag}`);
        } else {
          await shot(pg, `20-estimate-${tag}`);
        }
        // the finished project
        await pg.click('[data-testid="avatar-projects"]');
        await pg.waitForSelector('[data-testid="avatar-project-item"]');
        await shot(pg, `22-projects-${tag}`);
        await pg.locator('[data-testid="avatar-project-item"]').nth(1).click();
        if (phone) await pg.click('[data-testid="avatar-tab-project"]');
        await pg.waitForSelector('[data-testid="avatar-finish"]');
        await until("preview clip", async () => pg.locator('[data-testid="avatar-preview"] [data-mate-clip]').count(), 30000);
        await sleep(1500);
        await shot(pg, `23-ready-${tag}`);
        await c.close();
      }
    }
  }
  await browser.close();
  console.log(`OK — ${jobs().length} fake jobs, no credits spent`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
