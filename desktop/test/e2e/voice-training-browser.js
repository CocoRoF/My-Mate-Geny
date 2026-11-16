// Voice Studio → 학습 (docs/local-voice.md "Training a voice") in a browser against a throwaway server whose voice engine
// and training run are the stand-ins (VOICE_ENGINE_MODE=fake: the same stages and events in a moment, no GPU):
//
//   NODE_PATH=<playwright-core> CHROME=<chromium> \
//     node desktop/test/e2e/voice-training-browser.js <server url> <password> <shots dir> <the server's VOICE_HOME>
//
// (a fresh voice home on this machine: OmniVoice is marked installed in it after the first check, as the backend's
// tests do — a stand-in install would still download the real weights.)
//
// Checks: with OmniVoice missing the page says so and can't start; installed, a new profile from one recording picked
// with 파일 고르기 (the list shows it), start only once what it fetches is accepted; the run's card through its steps to
// done — the report (with a long clip / a short one / none), A/B samples playing, the adapter on; 프로필 marks it
// 학습됨; 생성 makes a line with it ("omnivoice (학습됨)", the history too) and without it once it is off; deleting the
// run takes the adapter off. Screenshots: ko / en, light / dark, phone (no sideways scroll).
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS, VOICE_HOME] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !SHOTS || !VOICE_HOME) {
  console.error("usage: node voice-training-browser.js <server url> <password> <shots dir> <the server's VOICE_HOME>");
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

/** a speech-like recording: bursts of a voice (2–6 s) with pauses between, 24 kHz mono PCM16 */
function recording(seconds, file) {
  const sr = 24000;
  const parts = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let total = 0;
  parts.push(new Float32Array(sr / 2));
  while (total < seconds) {
    const d = 2 + 4 * rnd();
    const f = 150 + 100 * rnd();
    const n = Math.floor(d * sr);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.25 * Math.sin((2 * Math.PI * f * i) / sr) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / sr));
    parts.push(x, new Float32Array(Math.floor(sr * (0.4 + 0.6 * rnd()))));
    total += d;
  }
  const len = parts.reduce((a, p) => a + p.length, 0);
  const buf = Buffer.alloc(44 + len * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + len * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(len * 2, 40);
  let o = 44;
  for (const p of parts) for (const v of p) { buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v + 0.001 * (rnd() - 0.5))) * 32767), o); o += 2; }
  fs.writeFileSync(file, buf);
}

const PHONE = { width: 390, height: 844 };
async function device(browser, { lang = "ko", theme = "light", phone = false } = {}) {
  const ctx = await browser.newContext({
    viewport: phone ? PHONE : { width: 1360, height: 1000 },
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
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: body ? { "Content-Type": "application/json" } : {} });
  const t = await r.text();
  return { status: r.status(), body: t ? JSON.parse(t) : null };
}

const shot = async (page, name, el) => {
  const file = path.join(SHOTS, `${name}.png`);
  if (el) await page.locator(el).first().screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  console.log(`  shot ${name}`);
};

const open = async (page, p) => {
  await page.goto(`${SERVER}/?view=settings&tab=voice-studio&page=${p}`);
  await page.waitForSelector(`[data-testid="voice-studio"][data-page="${p}"]`);
};

const NAME = "연습 목소리";

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vt-rec-"));
  const rec = path.join(tmp, "인터뷰 녹음.wav");
  recording(100, rec);
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    const ctx = await device(browser);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("response", (res) => res.status() >= 500 && errors.push(`http ${res.status()} ${res.url()}`));

    step("학습 without OmniVoice: says so, can't start");
    await open(page, "train");
    await page.waitForSelector('[data-testid="vs-train-needs-model"]');
    await page.selectOption('[data-testid="vs-train-voice"]', "__new");
    await page.fill('[data-testid="vs-train-name"]', NAME);
    assert.ok(await page.isDisabled('[data-testid="vs-train-start"]'), "no start without OmniVoice");

    step("OmniVoice installed → a new profile from one recording picked with the button");
    const marked = path.join(VOICE_HOME, "models", "omnivoice");
    fs.mkdirSync(marked, { recursive: true });
    fs.writeFileSync(path.join(marked, ".complete.json"), JSON.stringify({ bytes: 123, revisions: { "k2-fsa/OmniVoice": "e2e" } }));
    await until("OmniVoice installed", async () => (await api(ctx, "GET", "/api/voice/status")).body.models.find((m) => m.id === "omnivoice")?.installed, 60000);
    await open(page, "train");
    await until("the page knows", async () => !(await page.locator('[data-testid="vs-train-needs-model"]').count()), 15000);
    await page.selectOption('[data-testid="vs-train-voice"]', "__new");
    await page.fill('[data-testid="vs-train-name"]', NAME);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-testid="vs-train-drop"] button')]);
    await chooser.setFiles(rec);
    await page.waitForSelector('[data-testid="vs-train-list"] li');
    assert.match(await page.innerText('[data-testid="vs-train-list"]'), /인터뷰 녹음\.wav/, "the picked file is listed");
    assert.ok(await page.isDisabled('[data-testid="vs-train-start"]'), "no start before what it fetches is accepted");
    await page.check('[data-testid="vs-train-accept"]');
    await shot(page, "01-new-light-ko");
    await page.click('[data-testid="vs-train-start"]');

    step("the run: its steps to done, the report, samples, the adapter on");
    const card = '[data-testid="vs-train-run"]';
    await page.waitForSelector(card);
    await until("the run is done", async () => {
      const s = await page.getAttribute(`${card} [data-state]`, "data-state");
      if (s === "failed") throw new Error(`failed: ${await page.innerText(card)}`);
      return s === "done";
    }, 90000);
    await page.waitForSelector(`${card} [data-testid="vs-train-result"]`);
    assert.equal(await page.locator(`${card} [data-testid="vs-train-table"] tbody tr`).count(), 3, "a long clip, a short one, none");
    assert.ok(await page.locator(`${card} [data-testid="vs-train-applied"]`).count(), "put on the profile");
    assert.ok(await page.isChecked(`${card} [data-testid="vs-train-apply"]`));
    assert.match(await page.innerText(`${card} [data-testid="vs-train-data"]`), /\d/, "how much was kept");
    await page.click('[data-testid="vs-train-play-tuned-none-0"]');
    await sleep(500);
    const runs = (await api(ctx, "GET", "/api/voice/trainings")).body.runs;
    const run = runs.find((r) => r.voice_name === NAME);
    assert.ok(run && run.state === "done", "the run");
    const sample = await ctx.request.get(`${SERVER}/api/voice/trainings/${run.id}/samples/base-long-0.wav`);
    assert.ok(sample.ok() && /audio/.test(sample.headers()["content-type"]), "a sample plays");
    await shot(page, "02-done-light-ko");

    step("프로필 marks it 학습됨, a new profile got a clip");
    await open(page, "profiles");
    await page.waitForSelector('[data-testid="vs-profile-trained"]');
    const v = (await api(ctx, "GET", "/api/voice/voices")).body.voices.find((x) => x.id === run.voice_id);
    assert.equal(v.adapter, run.id, "the profile speaks with it");
    assert.ok(v.references.length >= 1, "a new profile got a clip");
    await shot(page, "03-profiles-light-ko");

    step("생성: with the adapter (marked), and without it once off");
    const gen = async () => {
      await open(page, "generate");
      await page.selectOption('[data-testid="vs-gen-voice"]', run.voice_id);
      await page.selectOption('[data-testid="vs-gen-model"]', "omnivoice");
      await page.fill('[data-testid="vs-gen-text"]', "다음 주에 다시 만나요.");
      const before = await page.locator('[data-testid="vs-gen-result"]').count();
      await page.click('[data-testid="vs-gen-go"]');
      await until("a line", async () => (await page.locator('[data-testid="vs-gen-result"]').count()) > before, 60000);
      return page.innerText('[data-testid="vs-gen-stats"]');
    };
    assert.match(await gen(), /omnivoice \(학습됨\)/, "made with it");
    await shot(page, "04-generate-trained-light-ko");
    await open(page, "train");
    await page.uncheck(`${card} [data-testid="vs-train-apply"]`);
    await until("off", async () => !(await page.locator(`${card} [data-testid="vs-train-applied"]`).count()), 10000);
    assert.doesNotMatch(await gen(), /학습됨/, "made without it");
    const h = (await api(ctx, "GET", "/api/voice/history?limit=2")).body;
    const lines = h.entries ?? h.items ?? [];
    assert.deepEqual(lines.map((e) => e.adapter), ["", run.id], "the history knows which");

    step("on again; delete the run → the adapter comes off");
    await open(page, "train");
    await page.check(`${card} [data-testid="vs-train-apply"]`);
    await page.waitForSelector(`${card} [data-testid="vs-train-applied"]`);
    await page.click(`${card} [data-testid="vs-train-delete"]`);
    await page.click('[data-testid="confirm-ok"]');
    await until("deleted", async () => !(await page.locator(card).count()), 10000);
    assert.equal((await api(ctx, "GET", "/api/voice/voices")).body.voices.find((x) => x.id === run.voice_id).adapter, "");

    step("a run of the profile again (to show it) → en / dark, phone");
    const form = { multipart: { voice_id: run.voice_id, language: "ko", accept_licenses: "1", files: { name: "voice.wav", mimeType: "audio/wav", buffer: fs.readFileSync(rec) } } };
    assert.ok((await ctx.request.post(`${SERVER}/api/voice/trainings`, form)).ok(), "a second run");
    await until("done again", async () => (await api(ctx, "GET", "/api/voice/trainings")).body.runs.every((r) => r.state === "done"), 90000);
    for (const [lang, theme, phone, name] of [["en", "dark", false, "05-done-dark-en"], ["ko", "dark", true, "06-done-dark-ko-phone"]]) {
      const c = await device(browser, { lang, theme, phone });
      const p = await c.newPage();
      await open(p, "train");
      await p.waitForSelector('[data-testid="vs-train-result"]');
      if (phone) assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll on a phone");
      await shot(p, name, phone ? '[data-testid="vs-train-run"]' : undefined);
      await c.close();
    }

    assert.deepEqual(errors, [], "no page errors");
    console.log("voice training: all good");
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
