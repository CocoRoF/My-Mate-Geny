// Voice Studio → 학습 (docs/local-voice.md "Training a voice") in a browser against a throwaway server whose voice engine
// and training run are the stand-ins (VOICE_ENGINE_MODE=fake: the same stages and events in a moment, no GPU):
//
//   NODE_PATH=<playwright-core> CHROME=<chromium> \
//     node desktop/test/e2e/voice-training-browser.js <server url> <password> <shots dir> <the server's VOICE_HOME>
//
// (a fresh voice home on this machine: the models are marked installed in it after the first check, as the backend's
// tests do — a stand-in install would still download the real weights.)
//
// Checks: with no model that learns the page says so and can't start; with three installed, a new profile from one
// recording picked with 파일 고르기 (the list shows it), every model ticked to begin with (one unticked), start only once
// what it fetches is accepted; a run per model through its steps to done — the report (with a long clip / a short one /
// none), A/B samples playing, each adapter on; 프로필 shows a LoRA chip for both models; 생성 makes a line with each
// model's own ("… · LoRA", the history too) and without one once it is off (the other stays on); deleting a run takes
// only its adapter off; CosyVoice3 alone (no "none": it can't speak without a clip). Screenshots: ko / en, light /
// dark, phone (no sideways scroll).
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

    step("학습 with no model that learns: says so, can't start");
    await open(page, "train");
    await page.waitForSelector('[data-testid="vs-train-needs-model"]');
    await page.selectOption('[data-testid="vs-train-voice"]', "__new");
    await page.fill('[data-testid="vs-train-name"]', NAME);
    assert.ok(await page.isDisabled('[data-testid="vs-train-start"]'), "no start without a model");

    step("three models installed → a new profile from one recording picked with the button, two of them chosen");
    for (const [id, repo] of [["omnivoice", "k2-fsa/OmniVoice"], ["qwen3-tts-0.6b-base", "Qwen/Qwen3-TTS-12Hz-0.6B-Base"], ["cosyvoice3-0.5b", "FunAudioLLM/Fun-CosyVoice3-0.5B-2512"]]) {
      const marked = path.join(VOICE_HOME, "models", id);
      fs.mkdirSync(marked, { recursive: true });
      fs.writeFileSync(path.join(marked, ".complete.json"), JSON.stringify({ bytes: 123, revisions: { [repo]: "e2e" } }));
    }
    await until("installed", async () => (await api(ctx, "GET", "/api/voice/status")).body.models.filter((m) => m.installed).length >= 3, 60000);
    await open(page, "train");
    await until("the page knows", async () => !(await page.locator('[data-testid="vs-train-needs-model"]').count()), 15000);
    await page.selectOption('[data-testid="vs-train-voice"]', "__new");
    await page.fill('[data-testid="vs-train-name"]', NAME);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-testid="vs-train-drop"] button')]);
    await chooser.setFiles(rec);
    await page.waitForSelector('[data-testid="vs-train-list"] li');
    assert.match(await page.innerText('[data-testid="vs-train-list"]'), /인터뷰 녹음\.wav/, "the picked file is listed");
    for (const id of ["omnivoice", "qwen3-tts-0.6b-base", "cosyvoice3-0.5b"])
      assert.ok(await page.isChecked(`[data-testid="vs-train-model-${id}"]`), `${id}: every installed model, to begin with`);
    await page.uncheck('[data-testid="vs-train-model-cosyvoice3-0.5b"]');
    assert.ok(await page.isDisabled('[data-testid="vs-train-start"]'), "no start before what it fetches is accepted");
    await page.check('[data-testid="vs-train-accept"]');
    await shot(page, "01-new-light-ko");
    await page.click('[data-testid="vs-train-start"]');

    step("a run per model: through its steps to done, the report, samples, each adapter on");
    const card = (model) => `[data-testid="vs-train-run"]:has([data-testid="vs-train-model"][data-model="${model}"])`;
    for (const model of ["omnivoice", "qwen3-tts-0.6b-base"]) {
      await page.waitForSelector(card(model));
      await until(`${model} done`, async () => {
        const s = await page.getAttribute(`${card(model)} [data-state]`, "data-state");
        if (s === "failed") throw new Error(`failed: ${await page.innerText(card(model))}`);
        return s === "done";
      }, 90000);
      await page.waitForSelector(`${card(model)} [data-testid="vs-train-result"]`);
      assert.equal(await page.locator(`${card(model)} [data-testid="vs-train-table"] tbody tr`).count(), 3, "a long clip, a short one, none");
      await page.waitForSelector(`${card(model)} [data-testid="vs-train-applied"]`);
      assert.ok(await page.isChecked(`${card(model)} [data-testid="vs-train-apply"]`));
      assert.match(await page.innerText(`${card(model)} [data-testid="vs-train-data"]`), /\d/, "how much was kept");
    }
    assert.equal(await page.locator(card("cosyvoice3-0.5b")).count(), 0, "the unticked model isn't trained");
    await page.click(`${card("omnivoice")} [data-testid="vs-train-play-tuned-none-0"]`);
    await sleep(500);
    const runs = (await api(ctx, "GET", "/api/voice/trainings")).body.runs;
    const run = runs.find((r) => r.voice_name === NAME && r.model_id === "omnivoice");
    const qrun = runs.find((r) => r.voice_name === NAME && r.model_id === "qwen3-tts-0.6b-base");
    assert.ok(run && qrun && run.group_id === qrun.group_id, "one group: the recordings shared");
    const sample = await ctx.request.get(`${SERVER}/api/voice/trainings/${run.id}/samples/base-long-0.wav`);
    assert.ok(sample.ok() && /audio/.test(sample.headers()["content-type"]), "a sample plays");
    await shot(page, "02-done-light-ko");

    step("프로필 shows a LoRA chip for each model, a new profile got a clip");
    await open(page, "profiles");
    await page.waitForSelector('[data-testid="vs-profile-trained"]');
    const chips = await page.locator('[data-testid="vs-profile-trained"] [data-testid="vs-profile-lora"]').allInnerTexts();
    assert.deepEqual(chips.sort(), ["LoRA · OmniVoice", "LoRA · Qwen3-TTS 0.6B (Base)"], "a LoRA chip for each model");
    const v = (await api(ctx, "GET", "/api/voice/voices")).body.voices.find((x) => x.id === run.voice_id);
    assert.deepEqual(v.adapters, { omnivoice: run.id, "qwen3-tts-0.6b-base": qrun.id }, "the profile speaks with each");
    assert.ok(v.references.length >= 1, "a new profile got a clip");
    await shot(page, "03-profiles-light-ko");

    step("생성: each model with its adapter (marked), and OmniVoice without it once off");
    const gen = async (model) => {
      await open(page, "generate");
      await page.selectOption('[data-testid="vs-gen-voice"]', run.voice_id);
      await page.selectOption('[data-testid="vs-gen-model"]', model);
      await page.fill('[data-testid="vs-gen-text"]', "다음 주에 다시 만나요.");
      const before = await page.locator('[data-testid="vs-gen-result"]').count();
      await page.click('[data-testid="vs-gen-go"]');
      await until("a line", async () => (await page.locator('[data-testid="vs-gen-result"]').count()) > before, 60000);
      return page.innerText('[data-testid="vs-gen-stats"]');
    };
    assert.match(await gen("qwen3-tts-0.6b-base"), /Qwen3-TTS 0\.6B \(Base\) · LoRA/, "Qwen made with its own");
    assert.match(await gen("omnivoice"), /OmniVoice · LoRA/, "OmniVoice made with its own");
    await shot(page, "04-generate-trained-light-ko");
    await open(page, "train");
    await page.uncheck(`${card("omnivoice")} [data-testid="vs-train-apply"]`);
    await until("off", async () => !(await page.locator(`${card("omnivoice")} [data-testid="vs-train-applied"]`).count()), 10000);
    assert.ok(await page.locator(`${card("qwen3-tts-0.6b-base")} [data-testid="vs-train-applied"]`).count(), "the other model's stays on");
    assert.doesNotMatch(await gen("omnivoice"), /LoRA/, "made without it");
    const h = (await api(ctx, "GET", "/api/voice/history?limit=3")).body;
    const lines = h.entries ?? h.items ?? [];
    assert.deepEqual(lines.map((e) => e.adapter), ["", run.id, qrun.id], "the history knows which");

    step("on again; delete the OmniVoice run → its adapter comes off, Qwen's stays");
    await open(page, "train");
    await page.check(`${card("omnivoice")} [data-testid="vs-train-apply"]`);
    await page.waitForSelector(`${card("omnivoice")} [data-testid="vs-train-applied"]`);
    await page.click(`${card("omnivoice")} [data-testid="vs-train-delete"]`);
    await page.click('[data-testid="confirm-ok"]');
    await until("deleted", async () => !(await page.locator(card("omnivoice")).count()), 10000);
    assert.deepEqual((await api(ctx, "GET", "/api/voice/voices")).body.voices.find((x) => x.id === run.voice_id).adapters, { "qwen3-tts-0.6b-base": qrun.id });

    step("CosyVoice3 alone, by the API (to show it: no \"none\" row) → en / dark, phone");
    const form = { multipart: { voice_id: run.voice_id, language: "ko", accept_licenses: "1", models: "cosyvoice3-0.5b", files: { name: "voice.wav", mimeType: "audio/wav", buffer: fs.readFileSync(rec) } } };
    const made = await ctx.request.post(`${SERVER}/api/voice/trainings`, form);
    assert.ok(made.ok(), "a CosyVoice3 run");
    assert.deepEqual((await made.json()).runs.map((r) => r.model_id), ["cosyvoice3-0.5b"]);
    await until("done again", async () => (await api(ctx, "GET", "/api/voice/trainings")).body.runs.every((r) => r.state === "done"), 90000);
    await open(page, "train");
    await page.waitForSelector(`${card("cosyvoice3-0.5b")} [data-testid="vs-train-result"]`);
    assert.equal(await page.locator(`${card("cosyvoice3-0.5b")} [data-testid="vs-train-table"] tbody tr`).count(), 2, "a long clip, a short one");
    for (const [lang, theme, phone, name] of [["en", "dark", false, "05-done-dark-en"], ["ko", "dark", true, "06-done-dark-ko-phone"]]) {
      const c = await device(browser, { lang, theme, phone });
      const p = await c.newPage();
      await open(p, "train");
      await p.waitForSelector('[data-testid="vs-train-result"]');
      if (phone) assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll on a phone");
      await shot(p, name, phone ? card("cosyvoice3-0.5b") : undefined);
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
