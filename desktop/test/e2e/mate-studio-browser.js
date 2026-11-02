// The Mate Create studio (docs/avatar-create.md §11) in a browser against a throwaway server — no credits spent: the
// agent is fake-claude.py's scripted studio agent driving the REAL avatar MCP bridge (a concepts card, then
// update_mate_draft, then the speech level, then `atool:<name> <json>` lines for the avatar), Higgsfield is
// higgsfield-stub.py + fake-higgsfield.py (the official mates' real pictures and clips) and the processing is the real
// pipeline. Same setup as avatar-create-browser.js:
//
//   NODE_PATH=<playwright-core> CHROME=<chromium> \
//     node desktop/test/e2e/mate-studio-browser.js <server url> <password> <stub url> <shots dir> <jobs log>
//
// Checks: the picker's New mate opens the studio (its own URL; back returns to the Mate, forward and a reload
// resume the same draft) with the agent on the left and the settings on the right; the agent proposes concepts →
// picking one fills the right side (highlighted, "filled by the agent", undo per field) → the user edits a field →
// the agent sees it in its next turn; the avatar flow to the estimate (nothing runs before Confirm: the agent's redo
// and wrong totals are refused, no Higgsfield job) → Confirm → checkpoints → real processing → the avatar plays on
// the right and is on her → Create mate → she is in the picker and the Mate view. The existing mate's ✨ opens the
// same layout. Drafts: listed, discarded. Splitter remembered. Screenshots: en / ko, light / dark, desktop / phone.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, STUB, SHOTS, JOBS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !STUB || !SHOTS || !JOBS) {
  console.error("usage: node mate-studio-browser.js <server url> <password> <stub url> <shots dir> <jobs log>");
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

const liveCard = (kind) => `[data-testid="avatar-question"][data-live="1"][data-kind="${kind}"]`;
const draftIdOf = (page) => new URL(page.url()).searchParams.get("create");
const projectOf = async (ctx, pid) => (await api(ctx, "GET", `/api/avatar/projects/${pid}`)).body;
const lastAgentText = (page) => page.locator('[data-testid="avatar-turn"]').last().innerText();

/** the picker → New mate → the studio with the agent's concept card */
async function newMate(page) {
  await page.goto(`${SERVER}/?view=mate`);
  await page.waitForSelector('[data-testid="mate-switcher"]', { timeout: 30000 });
  await page.click('[data-testid="mate-switcher"]');
  await page.click('[data-testid="mate-new"]');
  await page.waitForSelector('[data-testid="mate-studio"][data-kind="create"]');
  await until("the draft's address", async () => /create=mate_/.test(page.url()));
  await page.waitForSelector(liveCard("concepts"), { timeout: 30000 });
  await idle(page);
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const setup = await device(browser);
  await connectHiggsfield(setup);
  const env = (await api(setup, "GET", "/api/avatar/env")).body;
  assert.ok(env.higgsfield.connected && env.higgsfield.cli, "higgsfield ready " + JSON.stringify(env.higgsfield));
  assert.ok(env.deps.ready, "processing venv ready (AVATAR_VENV)");
  const matesBefore = (await api(setup, "GET", "/api/mates")).body;

  // ── the main run: English, dark, desktop ──
  const ctx = await device(browser, { lang: "en", theme: "dark" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("  pageerror:", e.message));

  step("picker → New mate → the studio (agent left, settings right)");
  await page.goto(`${SERVER}/?view=mate`);
  await page.waitForSelector('[data-testid="mate-switcher"]', { timeout: 30000 });
  await page.click('[data-testid="mate-switcher"]');
  await page.waitForSelector('[data-testid="mate-new"]');
  await shot(page, "00-picker-new-mate-dark-en");
  await page.click('[data-testid="mate-new"]');
  await page.waitForSelector('[data-testid="mate-studio"][data-kind="create"][data-layout="split"]');
  await until("the draft's address", async () => /\?view=mate&create=mate_/.test(page.url()));
  const draft = draftIdOf(page);
  assert.equal(await page.locator('[data-testid="studio-title"]').innerText(), "New mate");
  // the agent on the left, the settings on the right
  const L = await page.locator('[data-testid="studio-agent"]').boundingBox();
  const R = await page.locator('[data-testid="studio-right"]').boundingBox();
  assert.ok(L.x < R.x && L.width > 500 && R.width > 600, `columns ${JSON.stringify([L, R])}`);
  await page.waitForSelector(liveCard("concepts"), { timeout: 30000 });
  await idle(page);
  assert.equal(await page.locator('[data-testid="studio-concept-option"]').count(), 3);
  // the draft is hidden from the picker
  assert.ok(!(await api(ctx, "GET", "/api/mates")).body.some((m) => m.id === draft), "a draft is not in the mate list");
  await shot(page, "01-studio-concepts-dark-en");

  step("back → the Mate; forward and a reload → the same draft");
  await page.goBack();
  await page.waitForSelector('[data-testid="mate-view"]');
  assert.equal(new URL(page.url()).search, "?view=mate");
  await page.goForward();
  await page.waitForSelector('[data-testid="mate-studio"]');
  assert.equal(draftIdOf(page), draft);
  await page.reload();
  await page.waitForSelector(liveCard("concepts"), { timeout: 30000 });
  assert.equal(draftIdOf(page), draft, "a reload resumes the draft");
  assert.equal((await api(ctx, "GET", "/api/avatar/studio/drafts")).body.filter((d) => d.mate_id === draft).length, 1);
  const pid = (await api(ctx, "GET", "/api/avatar/studio/drafts")).body.find((d) => d.mate_id === draft).project_id;

  step("pick a concept → the agent fills the settings (highlighted, filled by the agent)");
  await page.locator('[data-testid="studio-concept-option"]').first().click();
  await page.waitForSelector('[data-testid="studio-filled-card"]', { timeout: 30000 });
  await until("the name on the right", async () => (await page.inputValue('[data-testid="studio-name"]')) === "Harin", 20000);
  await page.waitForSelector('[data-testid="studio-filled-badge"][data-field="name"]');
  await page.waitForSelector('.studio-glow');
  await sleep(250);
  await shot(page, "02-filled-by-agent-dark-en");
  assert.match(await page.locator('[data-testid="studio-draft-name"]').innerText(), /Harin/);
  assert.equal(await page.inputValue('[data-testid="studio-persona-address"]'), "boss");
  await page.waitForSelector(liveCard("choice"));
  await idle(page);
  let p = await projectOf(ctx, pid);
  assert.equal(p.studio.mate.persona.personality, "Calm, attentive and warm, with a gentle teasing streak.");
  assert.ok(p.studio.filled["persona.description"] && p.studio.filled["concept.pitch"]);
  assert.equal(p.studio.concept.voice, "soft, warm, a little low");
  await page.waitForSelector('[data-testid="studio-steps"] [data-step="concept"][data-state="done"]');

  step("the user edits a field on the right → saved, no badge; the agent sees it next turn");
  await page.fill('[data-testid="studio-persona-personality"]', "Cheerful and blunt, but kind.");
  await until("saved", async () => (await projectOf(ctx, pid)).studio.mate.persona.personality === "Cheerful and blunt, but kind.", 10000);
  await until("badge gone", async () => (await page.locator('[data-testid="studio-filled-badge"][data-field="persona.personality"]').count()) === 0);
  // undo one of the agent's fields: back to what was there (empty)
  await page.click('[data-testid="studio-filled-badge"][data-field="persona.greeting"] [data-testid="studio-undo"]');
  await until("undone", async () => (await projectOf(ctx, pid)).studio.mate.persona.greeting === "", 10000);
  assert.equal(await page.inputValue('[data-testid="studio-persona-greeting"]'), "");
  await shot(page, "03-user-edit-dark-en");
  // answer the speech-level card: the agent's turn starts with what it was told changed
  await page.click(`${liveCard("choice")} [data-value="haeyo"]`);
  await until("the agent's next turn", async () => /SAW studio_update:/.test(await lastAgentText(page)), 30000);
  const seen = await lastAgentText(page);
  assert.match(seen, /persona\.personality/, seen);
  assert.match(seen, /persona\.greeting/, seen);
  assert.doesNotMatch(seen, /persona\.description/, "only what the user changed");
  await page.waitForSelector(liveCard("upload"));
  await idle(page);

  step("the look: no reference → brief + estimate; nothing runs before Confirm");
  await page.locator(`${liveCard("upload")} [data-testid="avatar-q-option"]`).first().click();
  await idle(page);
  const brief = {
    patch: {
      reference: { mode: "none" },
      design: { prompt: "A calm young woman with long dark hair in a low ponytail, a navy cardigan over a white blouse; anime illustration." },
      preset: "minimal",
      candidates: 2,
    },
  };
  await say(page, `atool:update_brief ${JSON.stringify(brief)}\natool:estimate {}`);
  await page.waitForSelector('[data-testid="avatar-estimate-inline"]');
  await page.waitForSelector('[data-testid="studio-right"] [data-testid="avatar-estimate"]');
  p = await projectOf(ctx, pid);
  assert.equal(p.status, "estimate");
  assert.equal(p.brief.target.mate_id, draft, "the avatar is for the draft");
  assert.equal(p.plan.total, 4 + 0.5 + 12 + 54 + 6);
  await page.waitForSelector('[data-testid="studio-credits"]');
  assert.equal(jobs().length, 0, "no Higgsfield job before the confirmation");
  await say(page, 'atool:regenerate {"item":"design"}');
  assert.equal(await page.locator('[data-testid="avatar-tool-regenerate"]').last().getAttribute("data-error"), "1", "the agent's redo is refused");
  let r = await api(ctx, "POST", `/api/avatar/projects/${pid}/confirm`, { plan_id: p.plan.id, total: p.plan.total - 1 });
  assert.equal(r.status, 409, "a wrong total is refused");
  r = await api(ctx, "POST", `/api/avatar/projects/${pid}/redo`, { item: "design" });
  assert.equal(r.status, 409, "a redo before the confirmation is refused");
  assert.equal(jobs().length, 0, "still no job");
  await page.locator('[data-testid="studio-right"] [data-testid="avatar-estimate"]').scrollIntoViewIfNeeded();
  await shot(page, "04-estimate-dark-en");

  step("Confirm → candidates → base → stills → clips + real processing");
  await page.click('[data-testid="studio-right"] [data-testid="avatar-estimate-confirm"]');
  await page.waitForSelector('[data-testid="avatar-checkpoint-pick"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="studio-run"][data-status="waiting"]');
  assert.equal(jobs().filter((j) => j.job_type === "nano_banana_pro").length, 2);
  await sleep(600);
  await shot(page, "05-pick-dark-en");
  await page.click('[data-testid="avatar-pick-c1"]');
  await page.waitForSelector('[data-testid="avatar-checkpoint-home"]', { timeout: 180000 });
  await page.click('[data-testid="avatar-approve-home"]');
  await page.waitForSelector('[data-testid="avatar-checkpoint-stills"]', { timeout: 300000 });
  await sleep(600);
  await shot(page, "06-stills-dark-en");
  await page.click('[data-testid="avatar-approve-stills"]');
  await until("processing", async () => (await page.locator('[data-testid="avatar-processing"]').count()) > 0, 300000, 1000);
  await shot(page, "07-progress-dark-en");
  const t0 = Date.now();
  await page.waitForSelector('[data-testid="avatar-finish"]', { timeout: 40 * 60000 });
  console.log(`  processing took ${Math.round((Date.now() - t0) / 1000)} s`);
  await page.waitForSelector('[data-testid="avatar-applied"]', { timeout: 30000 });
  p = await projectOf(ctx, pid);
  assert.ok(p.check.passed, JSON.stringify(p.check));
  assert.equal(p.applied.mate_id, draft, "the avatar went on the new mate by itself");
  assert.ok(p.ledger.committed <= p.confirmation.cap);
  await until("the preview plays", async () => page.locator('[data-testid="avatar-preview"] [data-mate-clip]').count(), 30000);
  await sleep(1500);
  await shot(page, "08-avatar-ready-dark-en");

  step("Create mate → she is in the picker and the Mate view");
  await page.click('[data-testid="studio-create"]');
  await page.waitForSelector('[data-testid="mate-view"]');
  await until("her name in the header", async () => (await page.locator('[data-testid="mate-switcher"]').innerText()).includes("Harin"));
  const mates = (await api(ctx, "GET", "/api/mates")).body;
  const harin = mates.find((m) => m.id === draft);
  assert.ok(harin && !harin.draft && harin.avatar.kind === "video", "a mate now, with the avatar");
  assert.equal(harin.persona.personality, "Cheerful and blunt, but kind.");
  assert.equal(mates.length, matesBefore.length + 1);
  await page.waitForSelector('[data-testid="mate-info"]');
  await until("she plays", async () => page.evaluate(() => !!document.querySelector("[data-mate-clip]")), 30000);
  await sleep(1500);
  await shot(page, "09-mate-view-harin-dark-en");
  await page.click('[data-testid="mate-switcher"]');
  assert.ok((await page.locator('[data-testid="mate-switcher-item"]').allInnerTexts()).some((x) => x.includes("Harin")));
  await page.keyboard.press("Escape");

  step("the existing mate's ✨ → the same layout, Avatar section open");
  await page.click('[data-testid="mate-avatar-create"]');
  await page.waitForSelector('[data-testid="mate-studio"][data-kind="avatar"][data-layout="split"]');
  assert.match(page.url(), /\?view=mate&avatar=/);
  await page.waitForSelector('[data-testid="studio-section-avatar"][data-open="1"]');
  await page.waitForSelector('[data-testid="avatar-finish"]');
  await sleep(1200);
  await shot(page, "10-existing-avatar-studio-dark-en");
  await page.goBack();
  await page.waitForSelector('[data-testid="mate-view"]');
  // another mate (a built-in): a fresh project, the scripted agent asks for a reference
  const other = mates.find((m) => m.builtin === "chaerin") || mates.find((m) => m.id !== draft);
  await page.evaluate((id) => localStorage.setItem("hrh_mate_active", id), other.id);
  await page.goto(`${SERVER}/?view=mate&avatar=${other.id}`);
  await page.waitForSelector('[data-testid="mate-studio"][data-kind="avatar"]');
  await page.waitForSelector(liveCard("upload"), { timeout: 30000 });
  await idle(page);
  await shot(page, "11-existing-mate-start-dark-en");

  step("the splitter: dragged, remembered");
  const sp = await page.locator('[data-testid="studio-splitter"]').boundingBox();
  await page.mouse.move(sp.x + sp.width / 2, sp.y + 200);
  await page.mouse.down();
  await page.mouse.move(sp.x - 160, sp.y + 200, { steps: 6 });
  await page.mouse.up();
  const saved = Number(await page.evaluate(() => localStorage.getItem("hrh_studio_split")));
  assert.ok(saved > 0.2 && saved < 0.47, `split ${saved}`);
  await page.reload();
  await page.waitForSelector('[data-testid="studio-agent"]');
  const [w, total] = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="studio-agent"]');
    return [el.getBoundingClientRect().width, el.parentElement.getBoundingClientRect().width];
  });
  assert.ok(Math.abs(w - saved * total) < 4, `width ${w} vs ${saved} × ${total}`);
  await page.evaluate(() => localStorage.removeItem("hrh_studio_split"));

  step("drafts: listed in the picker, discarded");
  await newMate(page);
  const d2 = draftIdOf(page);
  await page.locator('[data-testid="studio-concept-option"]').nth(1).click();
  await until("filled", async () => (await page.inputValue('[data-testid="studio-name"]')) === "Bomi", 20000);
  await idle(page);
  await page.click('[data-testid="studio-save-exit"]');
  await page.waitForSelector('[data-testid="mate-view"]');
  await page.click('[data-testid="mate-switcher"]');
  await page.waitForSelector('[data-testid="mate-draft-item"]');
  assert.ok((await page.locator('[data-testid="mate-draft-item"]').allInnerTexts()).some((x) => x.includes("Bomi")));
  await shot(page, "12-picker-drafts-dark-en");
  await page.locator('[data-testid="mate-draft-item"]', { hasText: "Bomi" }).click();
  await page.waitForSelector('[data-testid="mate-studio"]');
  assert.equal(draftIdOf(page), d2);
  await until("resumed", async () => (await page.inputValue('[data-testid="studio-name"]').catch(() => "")) === "Bomi", 20000);
  await page.click('[data-testid="studio-more"]');
  await page.click('[data-testid="studio-discard"]');
  await page.waitForSelector('[data-testid="mate-view"]');
  assert.equal((await api(ctx, "GET", `/api/mates/${d2}`)).status, 404, "the discarded draft is gone");
  assert.ok(!(await api(ctx, "GET", "/api/avatar/studio/drafts")).body.some((d) => d.mate_id === d2));
  await ctx.close();

  // ── the other looks: ko / en, light / dark, desktop / phone ──
  for (const lang of ["en", "ko"]) {
    for (const theme of ["light", "dark"]) {
      for (const phone of [false, true]) {
        const tag = `${theme}-${lang}${phone ? "-phone" : ""}`;
        step(`screens: ${tag}`);
        const c = await device(browser, { lang, theme, phone });
        const pg = await c.newPage();
        pg.on("dialog", (d) => d.accept());
        pg.on("pageerror", (e) => console.log("  pageerror:", e.message));
        await newMate(pg);
        const dd = draftIdOf(pg);
        if (phone) {
          await pg.waitForSelector('[data-testid="mate-studio"][data-layout="tabs"]');
          await shot(pg, `20-concepts-${tag}`);
          await pg.locator('[data-testid="studio-concept-option"]').first().click();
          await pg.waitForSelector('[data-testid="studio-settings-badge"]', { timeout: 30000 });
          await idle(pg);
          await shot(pg, `21-agent-filled-badge-${tag}`);
          await pg.click('[data-testid="studio-tab-settings"]');
          await sleep(500);
          await shot(pg, `22-settings-${tag}`);
          assert.equal(await pg.locator('[data-testid="studio-settings-badge"]').count(), 0, "seen");
        } else {
          await shot(pg, `20-concepts-${tag}`);
          await pg.locator('[data-testid="studio-concept-option"]').first().click();
          await pg.waitForSelector('[data-testid="studio-filled-badge"][data-field="name"]', { timeout: 30000 });
          await idle(pg);
          await sleep(300);
          await shot(pg, `21-filled-${tag}`);
          // the right side scrolled to the style and voice sections
          await pg.click('[data-testid="studio-section-toggle-style"]');
          await pg.click('[data-testid="studio-section-toggle-voice"]');
          await pg.locator('[data-testid="studio-section-style"]').scrollIntoViewIfNeeded();
          await sleep(400);
          await shot(pg, `22-style-voice-${tag}`);
        }
        await api(c, "DELETE", `/api/avatar/studio/${(await api(c, "GET", "/api/avatar/studio/drafts")).body.find((d) => d.mate_id === dd).project_id}`);
        // the finished mate's avatar studio (Harin)
        await pg.goto(`${SERVER}/?view=mate&avatar=${draft}`);
        await pg.waitForSelector('[data-testid="mate-studio"][data-kind="avatar"]');
        if (phone) await pg.click('[data-testid="studio-tab-settings"]');
        await pg.waitForSelector('[data-testid="avatar-finish"]');
        await until("preview clip", async () => pg.locator('[data-testid="avatar-preview"] [data-mate-clip]').count(), 30000);
        await sleep(1200);
        await shot(pg, `23-avatar-studio-${tag}`);
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
