// The realtime mic (ElevenLabs Scribe v2 Realtime) in a real browser against a real server and the real ElevenLabs
// API (docs/mate.md §5). Needs a backend whose Global settings hold a working ElevenLabs key (the fake-key run: one
// with a wrong key), CLAUDE_BINARY=desktop/test/e2e/fake-claude.py, the frontend build as STATIC_DIR, and speech
// clips (16 kHz mono WAV: ko1.wav en1.wav echo.wav + refs.json — the echo clip says the fake engine's first reply):
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node test/e2e/mate-stt-browser.js <server url> <password> <clips dir> [shots dir] [scenario,…|all|fakekey]
//
// Chromium's fake capture device plays a clip as the microphone (--use-file-for-fake-audio-capture). The browser
// voice (speechSynthesis) is a stub that records what it speaks (window.__spoken) for `__ttsMs` per sentence. Every
// realtime socket is watched (window.__stt: frames sent — silent or not —, messages, the token in each URL), the
// box's value is sampled every 30 ms (window.__tl). Prints a JSON line per measurement ("MEASURE {...}").
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, CLIPS, SHOTS, WHICH = "all"] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !CLIPS) {
  console.error("usage: node test/e2e/mate-stt-browser.js <server url> <password> <clips dir> [shots dir] [scenarios|all|fakekey]");
  process.exit(2);
}
const REFS = JSON.parse(fs.readFileSync(path.join(CLIPS, "refs.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
const want = (s) => WHICH === "all" || WHICH.split(",").includes(s);
async function until(what, fn, ms = 20000, every = 50) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}
const DESK = { viewport: { width: 1440, height: 900 } };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
};

const norm = (s) => (s || "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function cer(ref, hyp) {
  const r = [...norm(ref)];
  const h = [...norm(hyp)];
  let d = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const nd = [i];
    for (let j = 1; j <= h.length; j++) nd[j] = Math.min(d[j] + 1, nd[j - 1] + 1, d[j - 1] + (r[i - 1] !== h[j - 1] ? 1 : 0));
    d = nd;
  }
  return Math.round((d[h.length] / Math.max(1, r.length)) * 1000) / 1000;
}

// ── what every page gets before it runs ──
const INIT = () => {
  // the browser voice: recorded, `__ttsMs` per sentence, cancel() ends it
  window.__spoken = [];
  window.__cancels = 0;
  window.__ttsMs = Number(localStorage.getItem("hrh_test_tts_ms") || 400);
  let cur = null;
  let timer = null;
  const end = () => {
    clearTimeout(timer);
    const u = cur;
    cur = null;
    if (u) window.__spoken[window.__spoken.length - 1].end = Date.now();
    u?.onend?.(new Event("end"));
  };
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      speaking: false,
      pending: false,
      paused: false,
      getVoices: () => [],
      addEventListener() {},
      removeEventListener() {},
      speak(u) {
        if (cur) end();
        cur = u;
        window.__spoken.push({ text: u.text, at: Date.now() });
        setTimeout(() => u.onstart?.(new Event("start")), 0);
        timer = setTimeout(end, u.text ? window.__ttsMs : 0); // (the autoplay unlock speaks "")
      },
      cancel() {
        window.__cancels++;
        // (a cancel with nothing playing — a new message stops her "just in case" — is not an interruption)
        if (cur && cur.text) window.__cut = (window.__cut || 0) + 1;
        if (cur) end();
      },
      pause() {},
      resume() {},
    },
  });
  // barge-ins heard from other windows of this browser (mate/voiceOwner "hush")
  window.__hush = 0;
  window.__hushSent = [];
  const post = BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage = function (m) {
    if (m && m.type === "hush") window.__hushSent.push(Date.now());
    return post.call(this, m);
  };
  try {
    new BroadcastChannel("hrh-mate-voice").addEventListener("message", (e) => e.data?.type === "hush" && window.__hush++);
  } catch {}
  // the realtime sockets: frames (silent or not), messages, tokens; __sttBlock = the network can't reach ElevenLabs
  const Orig = window.WebSocket;
  window.__stt = { sockets: [], frames: [], msgs: [], urls: [] };
  window.WebSocket = function (url, protocols) {
    const isStt = String(url).includes("speech-to-text/realtime");
    if (isStt) window.__stt.urls.push(String(url));
    const ws = isStt && window.__sttBlock ? new Orig("ws://127.0.0.1:9/blocked") : protocols ? new Orig(url, protocols) : new Orig(url);
    if (isStt) {
      window.__stt.sockets.push(ws);
      const send = ws.send.bind(ws);
      ws.send = (d) => {
        try {
          const j = JSON.parse(d);
          const b = atob(j.audio_base_64 || "");
          let loud = 0;
          for (let i = 0; i < b.length; i += 2) {
            const v = (b.charCodeAt(i) | (b.charCodeAt(i + 1) << 8)) << 16 >> 16;
            loud = Math.max(loud, Math.abs(v));
          }
          window.__stt.frames.push({ t: Date.now(), bytes: b.length, peak: loud, commit: !!j.commit, sock: window.__stt.sockets.length });
        } catch {}
        return send(d);
      };
      ws.addEventListener("message", (e) => {
        try {
          const j = JSON.parse(e.data);
          window.__stt.msgs.push({ t: Date.now(), type: j.message_type, text: j.text });
        } catch {}
      });
    }
    return ws;
  };
  window.WebSocket.prototype = Orig.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  // when the mic opened (the clip starts there)
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum)
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await gum(c);
      window.__micOpenedAt = Date.now();
      window.__micConstraints = c;
      return s;
    };
  // the box, sampled
  window.__tl = [];
  setInterval(() => {
    const ta = document.querySelector('[data-testid="mate-input"]');
    const st = document.querySelector('[data-testid="mate-mic-status"]');
    const v = ta ? ta.value : null;
    const live = ta?.getAttribute("data-live") || "";
    const phase = st?.getAttribute("data-phase") || "";
    const gated = st?.getAttribute("data-gated") || "";
    const last = window.__tl[window.__tl.length - 1];
    if (!last || last.v !== v || last.live !== live || last.phase !== phase || last.gated !== gated) window.__tl.push({ t: Date.now(), v, live, phase, gated });
  }, 30);
};

async function launch(clip, loop = false) {
  return chromium.launch({
    executablePath: process.env.CHROME,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${path.join(CLIPS, clip)}${loop ? "" : "%noloop"}`,
    ],
  });
}

async function device(browser, { phone = false, lang = "en", theme = "dark", ttsMs = 400 } = {}) {
  const ctx = await browser.newContext({ ...(phone ? PHONE : DESK), colorScheme: theme, permissions: ["microphone"] });
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.addInitScript(([l, th, ms]) => {
    localStorage.setItem("hrh_lang", l);
    localStorage.setItem("hrh_theme", th);
    localStorage.setItem("hrh_test_tts_ms", String(ms));
  }, [lang, theme, ttsMs]);
  await ctx.addInitScript(INIT);
  return ctx;
}

async function api(ctx, method, url, body) {
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function makeMate(browser, name, voice, lang = "ko") {
  const ctx = await device(browser);
  const m = await api(ctx, "POST", "/api/mates", { name, persona: { language: lang } });
  await api(ctx, "PATCH", `/api/mates/${m.id}`, { voice: { auto_read: true, tts: { engine: "browser" }, ...voice } });
  await ctx.close();
  return m;
}

async function openMate(ctx, mate, surface = "view") {
  const p = await ctx.newPage();
  await p.addInitScript((id) => {
    localStorage.setItem("hrh_mate_id", id);
    localStorage.setItem("hrh_mate_active", id);
  }, mate.id);
  const url = surface === "view" ? `/?view=mate&mate=${mate.id}` : `/?surface=${surface}&mate=${mate.id}`;
  await p.goto(SERVER + url);
  await p.waitForSelector('[data-testid="mate-input"]', { timeout: 30000 });
  await p.waitForSelector('[data-testid="mate-composer"]', { timeout: 20000 });
  await sleep(1200); // (the conversation opened, the voice elected)
  return p;
}

const tl = (p) => p.evaluate(() => window.__tl);
const stt = (p) => p.evaluate(() => ({ frames: window.__stt.frames, msgs: window.__stt.msgs, urls: window.__stt.urls.map((u) => u.replace(/token=[^&]+/, "token=…")), tokens: window.__stt.urls.map((u) => /token=([^&]+)/.exec(u)?.[1]), micAt: window.__micOpenedAt, constraints: window.__micConstraints }));
const tap = async (p) => {
  await p.locator('[data-testid="mate-mic"]').first().click();
};
const boxValue = (p) => p.locator('[data-testid="mate-input"]').first().inputValue();
const shot = async (p, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  console.log(`  shot ${name}.png`);
};

/** listen to `clip` (noloop) in the Mate view: partial → committed (VAD) → tap stop; timings */
async function dictation(browser, mate, clip, { surface = "view", phone = false, lang = "en", theme = "dark", shotName = null, stopAfterSpeech = false } = {}) {
  const ctx = await device(browser, { phone, lang, theme });
  const p = await openMate(ctx, mate, surface);
  const tapAt = Date.now();
  await tap(p);
  // first partial in the box
  await until("a partial in the box", async () => (await tl(p)).some((x) => x.live === "partial" && x.v), 20000);
  if (shotName) await shot(p, shotName);
  let stoppedAt = null;
  if (stopAfterSpeech) {
    // tap stop ~0.3 s after the speech ends (the clip: 0.4 s lead, 1.2 s tail)
    const micAt = await p.evaluate(() => window.__micOpenedAt);
    const speechEnd = micAt + (clipSeconds(clip) - 1.2) * 1000;
    await sleep(Math.max(0, speechEnd + 300 - Date.now()));
    stoppedAt = Date.now();
    await tap(p);
    await until("the mic closed", async () => (await tl(p)).at(-1).live === "", 10000);
  } else {
    // the VAD commits after the pause: the text in the box as committed (no live part), then stop
    await until("committed text", async () => (await p.evaluate(() => window.__stt.msgs.some((m) => m.type === "committed_transcript" && m.text))), 20000);
    await sleep(300);
    await tap(p);
    await until("the mic closed", async () => (await tl(p)).at(-1).live === "", 10000);
  }
  const final = await boxValue(p);
  const T = await tl(p);
  const S = await stt(p);
  const firstPartial = T.find((x) => x.live === "partial" && x.v);
  const committedMsg = S.msgs.find((m) => m.type === "committed_transcript" && m.text);
  const micAt = S.micAt;
  const speechStart = micAt + 400;
  const speechEnd = micAt + (clipSeconds(clip) - 1.2) * 1000;
  const finalShown = stoppedAt ? T.find((x) => x.t >= stoppedAt && x.live === "" && x.v) : T.find((x) => committedMsg && x.t >= committedMsg.t - 5 && x.v && x.live !== "partial");
  const m = {
    clip,
    surface,
    phone,
    mode: stoppedAt ? "stop" : "vad",
    final,
    cer: cer(REFS[clip.replace(".wav", "")], final),
    tap_to_mic_ms: micAt - tapAt,
    first_partial_after_speech_start_s: firstPartial ? +((firstPartial.t - speechStart) / 1000).toFixed(2) : null,
    final_after_speech_end_s: finalShown ? +((finalShown.t - speechEnd) / 1000).toFixed(2) : null,
    final_after_stop_s: stoppedAt && finalShown ? +((finalShown.t - stoppedAt) / 1000).toFixed(2) : null,
    partial_updates: T.filter((x) => x.live === "partial").length,
    constraints: S.constraints,
  };
  console.log("MEASURE " + JSON.stringify(m));
  await ctx.close();
  return m;
}

function clipSeconds(clip) {
  const b = fs.readFileSync(path.join(CLIPS, clip));
  return b.readUInt32LE(40) / 32000;
}

let failures = 0;
async function scenario(name, fn) {
  if (!want(name)) return;
  step(name);
  try {
    await fn();
  } catch (e) {
    failures++;
    console.error(`  FAILED ${name}: ${e.stack || e}`);
  }
}

async function main() {
  if (WHICH === "fakekey") return fakeKey();
  const stamp = Date.now() % 100000;
  // ── dictation: partials, committed, auto-send off ──
  await scenario("dictation", async () => {
    const browser = await launch("ko1.wav");
    try {
      const mate = await makeMate(browser, `STT ${stamp}`, { stt: { engine: "elevenlabs", auto_send: false, barge_in: true } });
      const vad = await dictation(browser, mate, "ko1.wav");
      assert.ok(vad.cer < 0.15, `CER ${vad.cer}: ${vad.final}`);
      assert.deepEqual(vad.constraints, { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      const stop = await dictation(browser, mate, "ko1.wav", { stopAfterSpeech: true });
      assert.ok(stop.cer < 0.15, `CER ${stop.cer}: ${stop.final}`);
      // nothing was sent (auto-send off): the text waits in the box
      const ctx = await device(browser);
      const conv = await api(ctx, "POST", `/api/mates/${mate.id}/conversation`);
      const hist = await api(ctx, "GET", `/api/history/${conv.session_id}?turns=5`).catch(() => null);
      assert.ok(!JSON.stringify(hist || {}).includes("김민수"), "auto-send off: nothing sent");
      await ctx.close();
      // the other surfaces: the mate chat window and the quick card, and the phone layout
      for (const surface of ["mate-chat", "mate-quick"]) {
        const m = await dictation(browser, mate, "ko1.wav", { surface });
        assert.ok(m.cer < 0.15, `${surface}: CER ${m.cer}`);
      }
      const ph = await dictation(browser, mate, "ko1.wav", { phone: true });
      assert.ok(ph.cer < 0.15, `phone: CER ${ph.cer}`);
    } finally {
      await browser.close();
    }
  });

  await scenario("english", async () => {
    const browser = await launch("en1.wav");
    try {
      const mate = await makeMate(browser, `STT en ${stamp}`, { stt: { engine: "elevenlabs" } }, "en");
      const m = await dictation(browser, mate, "en1.wav", { stopAfterSpeech: true });
      assert.ok(m.cer < 0.25, `CER ${m.cer}: ${m.final}`);
    } finally {
      await browser.close();
    }
  });

  // ── screenshots: the composer with live text (en/ko × light/dark × desktop/phone) ──
  await scenario("shots", async () => {
    const browser = await launch("ko1.wav");
    try {
      const mate = await makeMate(browser, `Geny STT`, { stt: { engine: "elevenlabs", auto_send: false, barge_in: true } });
      for (const lang of ["en", "ko"])
        for (const theme of ["light", "dark"])
          for (const phone of [false, true]) {
            const ctx = await device(browser, { phone, lang, theme });
            const p = await openMate(ctx, mate);
            await tap(p);
            await until("a partial", async () => (await tl(p)).some((x) => x.live === "partial" && x.v && x.v.length > 8), 20000);
            await shot(p, `composer-live-${lang}-${theme}-${phone ? "phone" : "desktop"}`);
            await tap(p);
            await until("closed", async () => (await tl(p)).at(-1).live === "", 10000);
            await p.locator('[data-testid="mate-input"]').first().fill("");
            // Settings → Voice (the STT part)
            await p.locator('[data-testid="mate-settings-open"]').first().click();
            await p.locator('[data-testid="mate-tab-voice"]').first().click();
            const sec = p.locator('[data-testid="mate-stt-realtime"]').first();
            await sec.waitFor({ timeout: 10000 });
            await sec.scrollIntoViewIfNeeded();
            await p.locator('[data-testid="mate-stt-engine"]').first().scrollIntoViewIfNeeded();
            await sleep(400);
            await shot(p, `settings-voice-${lang}-${theme}-${phone ? "phone" : "desktop"}`);
            await sec.scrollIntoViewIfNeeded();
            await sleep(200);
            await shot(p, `settings-voice-options-${lang}-${theme}-${phone ? "phone" : "desktop"}`);
            await ctx.close();
          }
    } finally {
      await browser.close();
    }
  });

  // ── auto-send + she answers: barge-in off → the mic sends silence while she speaks ──
  await scenario("autosend-muted", async () => {
    const browser = await launch("ko3.wav", true);
    try {
      const mate = await makeMate(browser, `STT auto ${stamp}`, { stt: { engine: "elevenlabs", auto_send: true, barge_in: false } });
      const ctx = await device(browser, { ttsMs: 900 });
      const p = await openMate(ctx, mate);
      await tap(p);
      // the first utterance goes out by itself (no send pressed) and she answers aloud
      await until("sent by itself", async () => p.evaluate(() => document.body.innerText.includes("넷플릭스")), 25000);
      const sentAt = Date.now();
      await until("she speaks", async () => (await p.evaluate(() => window.__spoken.length)) >= 3, 20000);
      await until("her reply done", async () => p.evaluate(() => window.__spoken.length >= 5 && !!window.__spoken[4].end), 20000);
      await sleep(500);
      const S = await stt(p);
      // (the empty utterance is the autoplay unlock on the first tap, not her)
      const spoken = await p.evaluate(() => window.__spoken.filter((s) => s.text));
      // frames sent while she spoke (well inside each sentence): all silent
      const inside = S.frames.filter((f) => spoken.some((s) => f.t > s.at + 250 && f.t < (s.end || s.at + 900) - 50));
      const loudInside = inside.filter((f) => f.peak > 0).length;
      if (loudInside) {
        const t0 = spoken[0].at;
        console.log("  spoken: " + JSON.stringify(spoken.map((s) => [s.at - t0, (s.end || 0) - t0, s.text.slice(0, 24)])));
        console.log("  loud inside: " + JSON.stringify(inside.filter((f) => f.peak > 0).map((f) => [f.t - t0, f.peak])));
        console.log("  timeline: " + JSON.stringify((await tl(p)).filter((x) => x.t > t0 - 1000).map((x) => [x.t - t0, x.phase, x.gated, x.live])));
      }
      const outside = S.frames.filter((f) => f.t > sentAt + 30000);
      void outside;
      const gatedSeen = (await tl(p)).some((x) => x.gated === "1");
      console.log("MEASURE " + JSON.stringify({ scenario: "autosend-muted", frames_while_speaking: inside.length, loud_frames_while_speaking: loudInside, gated_shown: gatedSeen, sentences_read: spoken.length, cut_while_speaking: await p.evaluate(() => window.__cut || 0) }));
      assert.ok(inside.length >= 5, "frames were sent while she spoke");
      assert.equal(loudInside, 0, "barge-in off: only silence while she speaks");
      assert.ok(gatedSeen, "the status said the mic is paused");
      // (the looping clip's next utterance, said before she began, is sent when its pause comes — a new message
      // stops her like a typed one; the muted mic itself never interrupts her)
      assert.ok(spoken.length >= 3, "she read her reply");
      await shot(p, "autosend-gated");
      await tap(p);
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  // ── barge-in on: the user (the looping clip) talks over her → she stops where she plays ──
  await scenario("barge-in", async () => {
    const browser = await launch("ko5.wav", true);
    try {
      const mate = await makeMate(browser, `STT barge ${stamp}`, { stt: { engine: "elevenlabs", auto_send: true, barge_in: true } });
      const ctx = await device(browser, { ttsMs: 1200 });
      // the mic is in the console Mate view; she reads in the mate chat window (used last, after the tap on the mic):
      // the hush crosses windows (mate/voiceOwner)
      const view = await openMate(ctx, mate, "view");
      const chat = await openMate(ctx, mate, "mate-chat");
      await view.bringToFront();
      await tap(view);
      await chat.bringToFront();
      await chat.mouse.click(200, 300);
      await until("sent by itself", async () => view.evaluate(() => document.body.innerText.includes("꽃다발")), 30000);
      const said = (p) => p.evaluate(() => window.__spoken.filter((s) => s.text).length);
      await until("she speaks (somewhere)", async () => (await said(chat)) + (await said(view)) >= 1, 20000);
      const speaker = (await said(chat)) ? chat : view;
      // the mic's window (the view) hushes her when the user's words come in while she speaks
      const hushAt = (await until("a barge-in", async () => (await view.evaluate(() => window.__hushSent))[0], 25000));
      await sleep(4000);
      const sp = await speaker.evaluate(() => window.__spoken.filter((s) => s.text));
      const spoken = sp.map((s) => s.text);
      // (the reply she was reading when the user spoke up: the last one that started before the barge-in)
      const cur = [...sp].reverse().find((x) => x.at <= hushAt)?.text.split(" sentence")[0] ?? "Reply 1";
      const r1 = spoken.filter((t) => t.startsWith(cur + " "));
      const after = sp.filter((s) => s.at > hushAt + 300 && s.text.startsWith(cur + " ")).length;
      assert.equal(after, 0, "nothing of that reply read after the barge-in");
      console.log("MEASURE " + JSON.stringify({ scenario: "barge-in", reader: speaker === chat ? "mate-chat" : "view", reply1_sentences_read: r1.length, spoken: sp.map((x) => [x.at - hushAt, x.text.slice(0, 28)]), cut_while_speaking: await speaker.evaluate(() => window.__cut || 0), hush_received: await speaker.evaluate(() => window.__hush) }));
      if (speaker === chat) assert.ok((await chat.evaluate(() => window.__hush)) > 0, "the mic's window hushed the reader window");
      assert.ok(r1.length < 5, `she stopped (read ${r1.length} of 5 sentences of reply 1)`);
      await tap(view).catch(() => {});
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  // ── echo: her own words coming back through the mic are not the user's (no barge-in, nothing in the box) ──
  await scenario("echo", async () => {
    const browser = await launch("echo.wav");
    try {
      const mate = await makeMate(browser, `STT echo ${stamp}`, { stt: { engine: "elevenlabs", auto_send: false, barge_in: true } }, "en");
      const ctx = await device(browser, { ttsMs: 2050 });
      const p = await openMate(ctx, mate);
      const input = p.locator('[data-testid="mate-input"]').first();
      await input.fill("q1 hello");
      await input.press("Enter");
      await until("she starts reading", async () => (await p.evaluate(() => window.__spoken.length)) >= 1, 20000);
      await tap(p); // the mic hears "her voice" (the clip says her reply) from here on
      await until("reply read", async () => p.evaluate(() => window.__spoken.length >= 5 && !!window.__spoken[4].end), 30000);
      await sleep(2500);
      const S = await stt(p);
      const heard = S.msgs.filter((m) => (m.type === "partial_transcript" || m.type === "committed_transcript") && m.text).map((m) => m.text);
      const box = await boxValue(p);
      const T = await tl(p);
      const cancels = await p.evaluate(() => window.__cut || 0);
      console.log("MEASURE " + JSON.stringify({ scenario: "echo", recognizer_heard: heard.slice(-2), box, shown_partials: T.filter((x) => x.live === "partial").length, cancels, sentences_read: (await p.evaluate(() => window.__spoken.length)) }));
      if (cancels) {
        const sp = await p.evaluate(() => window.__spoken);
        const t0 = sp[0].at;
        console.log("  spoken: " + JSON.stringify(sp.map((x) => [x.at - t0, (x.end || 0) - t0, x.text.slice(0, 30)])));
        console.log("  msgs: " + JSON.stringify(S.msgs.map((m) => [m.t - t0, m.type, (m.text || "").slice(0, 60)])));
        console.log("  tl: " + JSON.stringify(T.map((x) => [x.t - t0, x.phase, x.gated, x.live, (x.v || "").slice(0, 30)])));
      }
      assert.ok(heard.some((t) => /sentence/i.test(t)), "the recognizer did hear her voice");
      assert.equal(cancels, 0, "her echo did not interrupt her");
      assert.ok(!/sentence/i.test(box), `her words are not in the box: ${box}`);
      await tap(p);
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  // ── a dropped socket mid-utterance: reconnect with a fresh token, the text completes ──
  await scenario("drop", async () => {
    const browser = await launch("ko5.wav");
    try {
      const mate = await makeMate(browser, `STT drop ${stamp}`, { stt: { engine: "elevenlabs" } });
      const ctx = await device(browser);
      const p = await openMate(ctx, mate);
      await tap(p);
      await until("a partial", async () => (await tl(p)).some((x) => x.live === "partial" && x.v), 20000);
      await sleep(600);
      const before = await boxValue(p);
      await p.evaluate(() => window.__stt.sockets.at(-1).close()); // the connection drops
      await until("reconnected", async () => (await stt(p)).urls.length >= 2 && (await p.evaluate(() => window.__stt.msgs.filter((m) => m.type === "session_started").length)) >= 2, 15000);
      await until("committed after the drop", async () => p.evaluate(() => window.__stt.msgs.some((m) => m.type === "committed_transcript" && m.text)), 20000);
      await sleep(300);
      await tap(p);
      await until("closed", async () => (await tl(p)).at(-1).live === "", 10000);
      const final = await boxValue(p);
      const S = await stt(p);
      const phases = [...new Set((await tl(p)).map((x) => x.phase))];
      console.log("MEASURE " + JSON.stringify({ scenario: "drop", before_drop: before, final, cer: cer(REFS.ko5, final), sockets: S.urls.length, distinct_tokens: new Set(S.tokens).size, phases }));
      assert.ok(phases.includes("reconnecting"), "it said it reconnects");
      assert.equal(new Set(S.tokens).size, S.urls.length, "a fresh token per connection");
      assert.ok(cer(REFS.ko5, final) < 0.35, `the text completed: ${final}`);
    } finally {
      await browser.close();
    }
  });

  // ── ElevenLabs unreachable from the page (blocked): 3 retries → the recording fallback (ElevenLabs batch) ──
  await scenario("blocked", async () => {
    const browser = await launch("ko3.wav");
    try {
      const mate = await makeMate(browser, `STT blocked ${stamp}`, { stt: { engine: "elevenlabs" } });
      const ctx = await device(browser);
      await ctx.addInitScript(() => (window.__sttBlock = true));
      const p = await openMate(ctx, mate);
      await tap(p);
      await until("the fallback notice", async () => (await tl(p)).some((x) => x.phase === "recording"), 20000);
      await shot(p, "fallback-recording");
      await sleep(Math.max(0, clipSeconds("ko3.wav") * 1000 - 3000));
      await tap(p);
      await until("transcribed", async () => (await boxValue(p)).length > 5, 20000);
      const final = await boxValue(p);
      const notice = await p.evaluate(() => document.querySelector('[data-testid="mate-mic-status"]')?.innerText || "");
      console.log("MEASURE " + JSON.stringify({ scenario: "blocked", final, cer: cer(REFS.ko3, final), notice, attempts: (await stt(p)).urls.length }));
      assert.ok(cer(REFS.ko3, final) < 0.15, final);
    } finally {
      await browser.close();
    }
  });

  console.log(failures ? `\nMATE STT E2E: ${failures} FAILED` : "\nMATE STT E2E OK");
  if (failures) process.exitCode = 1;
}

/** a backend with a wrong ElevenLabs key: the message, and the page offers what it can instead */
async function fakeKey() {
  const browser = await launch("ko1.wav");
  try {
    const mate = await makeMate(browser, `STT fake key`, { stt: { engine: "elevenlabs" } });
    for (const lang of ["en", "ko"]) {
      const ctx = await device(browser, { lang });
      const p = await openMate(ctx, mate);
      const tok = await p.evaluate(async (id) => {
        const r = await fetch(`/api/mates/${id}/stt/realtime`, { method: "POST" });
        return { status: r.status, body: await r.json() };
      }, mate.id);
      await tap(p);
      await until("a message", async () => p.evaluate(() => document.querySelector('[data-testid="mate-mic-status"]')?.innerText), 15000);
      await sleep(800);
      const status = await p.evaluate(() => document.querySelector('[data-testid="mate-mic-status"]')?.innerText);
      const phase = await p.evaluate(() => document.querySelector('[data-testid="mate-mic-status"]')?.getAttribute("data-phase"));
      console.log("MEASURE " + JSON.stringify({ scenario: "fake-key", lang, token: tok, status, phase }));
      assert.equal(tok.body.code, "auth");
      assert.ok(!JSON.stringify(tok).includes("sk_"), "no key in the answer");
      await shot(p, `fake-key-${lang}`);
      await ctx.close();
    }
    console.log("\nMATE STT FAKE-KEY E2E OK");
  } catch (e) {
    console.error(`\nMATE STT FAKE-KEY E2E FAILED: ${e.stack || e}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
