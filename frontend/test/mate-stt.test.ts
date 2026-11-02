// The realtime mic's pure parts (src/mate/stt): the resampler / chunker / base64 / WAV, the ElevenLabs message
// parsing, joining transcript pieces, the fallback choice, the echo filter and gate (she speaks: muted or barge-in),
// and a whole session against a fake socket + mic (partials, commit, gating, barge-in, reconnect, fallback, stop).
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { Chunker, pcmToBase64, Resampler, wavFromPcm, CHUNK_SAMPLES } from "../src/mate/stt/pcm.ts";
import { audioFrame, closeFailure, fallbackPlan, joinText, parseScribeMessage } from "../src/mate/stt/scribe.ts";
import { echoScore, EchoGate, meaningful, stripEcho, userWords } from "../src/mate/stt/echo.ts";
import { RealtimeStt, TokenError, type RealtimeDeps } from "../src/mate/stt/realtime.ts";

const sine = (rate: number, hz: number, seconds: number, amp = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

function zeroCrossings(x: Int16Array): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return n;
}
const peak = (x: Int16Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test("resampler: 48 kHz and 44.1 kHz → 16 kHz keep the pitch and the level; pieces = whole", () => {
  for (const rate of [48000, 44100, 22050, 16000, 8000]) {
    const x = sine(rate, 440, 1);
    const whole = new Resampler(rate).push(x);
    assert.ok(Math.abs(whole.length - 16000) <= 2, `${rate}: ${whole.length} samples`);
    // 440 Hz: 880 zero crossings a second
    assert.ok(Math.abs(zeroCrossings(whole) - 880) <= 4, `${rate}: ${zeroCrossings(whole)} crossings`);
    assert.ok(Math.abs(peak(whole) - 0.5 * 0x7fff) < 0.03 * 0x7fff, `${rate}: peak ${peak(whole)}`);
    // the same stream in odd-sized pieces (what an AudioWorklet / ScriptProcessor delivers)
    const r = new Resampler(rate);
    const parts: number[] = [];
    for (let i = 0; i < x.length; ) {
      const n = [128, 1024, 333, 4096][i % 4] ?? 128;
      parts.push(...r.push(x.subarray(i, i + n)));
      i += n;
    }
    assert.equal(parts.length, whole.length, `${rate}: streamed length`);
    assert.ok(parts.every((v, i) => Math.abs(v - whole[i]) <= 1), `${rate}: streamed samples`);
  }
  // above the new Nyquist (12 kHz at 48 kHz): damped by the box filter, not passed through at full level
  const hi = new Resampler(48000).push(sine(48000, 12000, 0.5));
  assert.ok(peak(hi) < 0.4 * 0.5 * 0x7fff, `12 kHz leaks at ${peak(hi)}`);
  // clamps instead of wrapping
  const loud = new Resampler(16000).push(Float32Array.from([2, -2, 0.5]));
  assert.deepEqual([...loud], [32767, -32768, 16384]);
});

test("chunker, base64 and WAV", () => {
  const c = new Chunker(4);
  assert.deepEqual(c.push(Int16Array.from([1, 2, 3])), []);
  const out = c.push(Int16Array.from([4, 5, 6, 7, 8, 9]));
  assert.deepEqual(out.map((x) => [...x]), [[1, 2, 3, 4], [5, 6, 7, 8]]);
  assert.deepEqual([...(c.flush() ?? [])], [9]);
  assert.equal(c.flush(), null);
  assert.equal(CHUNK_SAMPLES, 1600); // 100 ms at 16 kHz
  // little-endian int16
  assert.equal(pcmToBase64(Int16Array.from([1, -2])), Buffer.from([1, 0, 0xfe, 0xff]).toString("base64"));
  const wav = wavFromPcm([Int16Array.from([1, 2]), Int16Array.from([3])], 16000);
  const b = Buffer.from(wav);
  assert.equal(b.toString("ascii", 0, 4), "RIFF");
  assert.equal(b.toString("ascii", 8, 12), "WAVE");
  assert.equal(b.readUInt32LE(24), 16000);
  assert.equal(b.readUInt16LE(22), 1);
  assert.equal(b.readUInt32LE(40), 6);
  assert.deepEqual([b.readInt16LE(44), b.readInt16LE(46), b.readInt16LE(48)], [1, 2, 3]);
});

test("ElevenLabs messages: partial / committed / errors with what to do", () => {
  assert.deepEqual(parseScribeMessage('{"message_type":"session_started","session_id":"s1","config":{}}'), { type: "started", sessionId: "s1" });
  assert.deepEqual(parseScribeMessage('{"message_type":"partial_transcript","text":"안녕하세요."}'), { type: "partial", text: "안녕하세요." });
  assert.deepEqual(parseScribeMessage({ message_type: "committed_transcript", text: "안녕하세요. 저는 김민수예요." }), {
    type: "committed",
    text: "안녕하세요. 저는 김민수예요.",
  });
  // (not asked for: would repeat a commit)
  assert.equal(parseScribeMessage('{"message_type":"committed_transcript_with_timestamps","text":"x"}').type, "ignore");
  const e = (t: string) => parseScribeMessage(JSON.stringify({ message_type: t, error: "why" }));
  assert.deepEqual(e("auth_error"), { type: "error", code: "auth", retry: false, message: "why" });
  assert.deepEqual(e("quota_exceeded"), { type: "error", code: "quota", retry: false, message: "why" });
  assert.equal((e("rate_limited") as { retry: boolean }).retry, true);
  assert.equal((e("session_time_limit_exceeded") as { code: string }).code, "expired");
  assert.equal((e("transcriber_error") as { retry: boolean }).retry, true);
  assert.equal((e("chunk_size_exceeded") as { retry: boolean }).retry, false);
  assert.equal(e("commit_throttled").type, "warning");
  assert.equal(e("insufficient_audio_activity").type, "idle");
  assert.equal(parseScribeMessage("not json").type, "ignore");
  assert.deepEqual(JSON.parse(audioFrame("QUJD", true)), { message_type: "input_audio_chunk", audio_base_64: "QUJD", commit: true, sample_rate: 16000 });
  assert.equal(closeFailure(1006, "").code, "network");
  assert.equal(closeFailure(1008, "bad token").code, "auth");
});

test("joining transcript pieces; the fallback choice", () => {
  assert.equal(joinText("안녕하세요.", "저는 민수예요."), "안녕하세요. 저는 민수예요.");
  assert.equal(joinText("", " hi "), "hi ");
  assert.equal(joinText("hello ", ""), "hello");
  assert.equal(joinText("今日は", "いい天気"), "今日はいい天気");
  // a server engine first; ElevenLabs' batch model is no help when the key / credits are the problem
  assert.deepEqual(fallbackPlan("network", "whisper", true), { kind: "server", engine: "whisper" });
  assert.deepEqual(fallbackPlan("network", "elevenlabs", false), { kind: "server", engine: "elevenlabs" });
  assert.deepEqual(fallbackPlan("auth", "elevenlabs", true), { kind: "browser" });
  assert.deepEqual(fallbackPlan("quota", "elevenlabs", false), { kind: "none" });
  assert.deepEqual(fallbackPlan("quota", "openai", false), { kind: "server", engine: "openai" });
  assert.deepEqual(fallbackPlan("mic", "whisper", true), { kind: "none" });
});

test("echo: her words are recognised and dropped, the user's stay", () => {
  const said = ["오늘은 날씨가 정말 좋네요. 산책 어때요?"];
  assert.ok(echoScore("오늘은 날씨가 정말", said) > 0.9);
  assert.ok(echoScore("잠깐만 그거 말고", said) < 0.2);
  // ASR spelling it a little differently is still her
  assert.ok(echoScore("오늘 날씨 정말 좋네요", said) > 0.6);
  assert.equal(stripEcho("오늘은 날씨가 잠깐만 그거 말고 정말 좋네요", said), "잠깐만 그거 말고");
  assert.equal(userWords("오늘은 날씨가 정말", said), "");
  assert.equal(userWords("잠깐만요 그거 말고요", said), "잠깐만요 그거 말고요");
  assert.equal(meaningful("어"), false);
  assert.equal(meaningful("잠깐만"), false); // 3 letters, one word
  assert.equal(meaningful("잠깐만요"), true);
  assert.equal(meaningful("no wait"), true);
  assert.equal(echoScore("anything", []), 0);
});

test("gate: barge-in off mutes the mic while she speaks (+ a tail)", () => {
  const g = new EchoGate({ bargeIn: false, tailMs: 700 });
  assert.equal(g.muted(0), false);
  g.setVoicing(true, 1000);
  assert.equal(g.muted(1500), true);
  g.setVoicing(false, 3000);
  assert.equal(g.muted(3500), true); // the tail
  assert.equal(g.muted(3800), false);
  // (silence was sent: whatever is heard is the user's)
  assert.deepEqual(g.partial("네 알겠어요", ["산책 어때요"], 3500), { show: "네 알겠어요", barge: false });
});

test("gate: barge-in on — her echo hidden, the user's words interrupt her", () => {
  const said = ["오늘은 날씨가 정말 좋네요. 산책 어때요?"];
  const g = new EchoGate({ bargeIn: true });
  g.setVoicing(true, 0);
  assert.equal(g.muted(100), false); // audio goes out
  assert.deepEqual(g.partial("오늘은 날씨가", said, 100), { show: null, barge: false });
  assert.deepEqual(g.partial("오늘은 날씨가 정말 좋네요", said, 200), { show: null, barge: false });
  // the user talks over her: shown without her words, and it is a barge-in (once)
  assert.deepEqual(g.partial("오늘은 날씨가 정말 좋네요 잠깐만요 그거 말고", said, 300), { show: "잠깐만요 그거 말고", barge: true });
  assert.deepEqual(g.partial("오늘은 날씨가 정말 좋네요 잠깐만요 그거 말고 다른 거", said, 400), { show: "잠깐만요 그거 말고 다른 거", barge: false });
  assert.equal(g.committed("오늘은 날씨가 정말 좋네요. 잠깐만요, 그거 말고 다른 거.", said, 500), "잠깐만요, 그거 말고 다른 거.");
  // a segment of only her voice commits nothing
  g.partial("산책 어때요", said, 600);
  assert.equal(g.committed("산책 어때요?", said, 700), null);
  // she is done (past the tail): a clean segment is the user's as heard
  g.setVoicing(false, 800);
  assert.deepEqual(g.partial("좋아요", said, 2000), { show: "좋아요", barge: false });
  assert.equal(g.committed("좋아요.", said, 2100), "좋아요.");
});

// ── a whole session, against a fake socket / mic / clock ──

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 1;
  sent: any[] = [];
  closed: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code = 1000) {
    this.closed = code;
    this.readyState = 3;
  }
  server(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

function harness(over: Partial<RealtimeDeps> = {}, opts: { voicing?: boolean; bargeIn?: boolean } = {}) {
  FakeWs.all = [];
  let clock = 0;
  const timers: { fn: () => void; at: number }[] = [];
  const state = { voicing: opts.voicing ?? false, bargeIn: opts.bargeIn ?? true, spoken: [] as string[] };
  let onFrames: ((s: Float32Array, r: number) => void) | null = null;
  const mic = { closed: false };
  const ev = { partials: [] as string[], segments: [] as [string, string][], states: [] as string[], notices: [] as any[], errors: [] as any[], barges: 0 };
  let tokens = 0;
  const deps: RealtimeDeps = {
    getToken: async () => ({ url: `wss://fake/realtime?token=t${++tokens}`, fallback: "elevenlabs" }),
    transcribe: async () => ({ text: "" }),
    openMic: async (cb) => {
      onFrames = cb;
      return { rate: 48000, close: () => (mic.closed = true), onEnded: null };
    },
    voicing: () => state.voicing,
    spoken: () => state.spoken,
    bargeIn: () => state.bargeIn,
    newSocket: (url) => new FakeWs(url),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as never);
      if (i >= 0) timers.splice(i, 1);
    },
    ...over,
  };
  const s = new RealtimeStt(deps, {
    onPartial: (t) => ev.partials.push(t),
    onSegment: (t, how) => ev.segments.push([t, how]),
    onState: (x) => ev.states.push(x),
    onNotice: (n) => ev.notices.push(n),
    onError: (code, message, fb) => ev.errors.push({ code, message, fb }),
    onBargeIn: () => ev.barges++,
  });
  return {
    s,
    ev,
    mic,
    state,
    get ws() {
      return FakeWs.all[FakeWs.all.length - 1];
    },
    /** 100 ms of a 48 kHz tone → one 16 kHz chunk */
    speak: (amp = 0.3) => {
      onFrames!(sine(48000, 300, 0.1, amp), 48000);
      clock += 100;
    },
    advance: (ms: number) => {
      clock += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= clock && timers.includes(t)) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    },
    tick: () => new Promise((r) => setTimeout(r, 0)),
  };
}

const audioOf = (frame: any) => Buffer.from(frame.audio_base_64, "base64");

test("session: audio before the session starts is kept; partials then the committed text", async () => {
  const h = harness();
  await h.s.start();
  h.speak();
  h.speak();
  assert.equal(h.ws.sent.length, 0); // (not started yet)
  h.ws.server({ message_type: "session_started", session_id: "a" });
  assert.equal(h.ws.sent.length, 2);
  assert.equal(audioOf(h.ws.sent[0]).length, 3200); // 100 ms of 16-bit 16 kHz
  assert.equal(h.ev.states.at(-1), "listening");
  h.speak();
  assert.equal(h.ws.sent.length, 3);
  h.ws.server({ message_type: "partial_transcript", text: "안녕하세요" });
  h.ws.server({ message_type: "partial_transcript", text: "안녕하세요 저는" });
  h.ws.server({ message_type: "committed_transcript", text: "안녕하세요. 저는 민수예요." });
  assert.deepEqual(h.ev.partials, ["안녕하세요", "안녕하세요 저는", ""]);
  assert.deepEqual(h.ev.segments, [["안녕하세요. 저는 민수예요.", "realtime"]]);
  // stop: a commit, then (nothing left) closed; the mic is released
  const p = h.s.stop();
  assert.equal(h.mic.closed, true);
  assert.equal(h.ws.sent.at(-1).commit, true);
  h.ws.server({ message_type: "committed_transcript", text: "" });
  await p;
  assert.equal(h.ev.states.at(-1), "closed");
  assert.equal(h.ws.closed, 1000);
  assert.equal(h.ev.segments.length, 1);
});

test("session: stop without an answer keeps the live text", async () => {
  const h = harness();
  await h.s.start();
  h.ws.server({ message_type: "session_started", session_id: "a" });
  h.speak();
  h.ws.server({ message_type: "partial_transcript", text: "네 알겠어요" });
  const p = h.s.stop();
  h.advance(3000);
  await p;
  assert.deepEqual(h.ev.segments, [["네 알겠어요", "realtime"]]);
});

test("session: while she speaks — barge-in off sends silence, on hears the user over her", async () => {
  const off = harness({}, { voicing: true, bargeIn: false });
  await off.s.start();
  off.ws.server({ message_type: "session_started", session_id: "a" });
  off.speak(0.5);
  assert.ok(audioOf(off.ws.sent[0]).every((b) => b === 0), "muted while she speaks");
  off.state.voicing = false;
  off.speak(0.5); // (the tail: still muted)
  off.advance(800);
  off.speak(0.5);
  assert.ok(audioOf(off.ws.sent.at(-1)).some((b) => b !== 0), "the mic again after the tail");

  const on = harness({}, { voicing: true, bargeIn: true });
  on.state.spoken = ["오늘은 날씨가 정말 좋네요. 산책 어때요?"];
  await on.s.start();
  on.ws.server({ message_type: "session_started", session_id: "a" });
  on.speak(0.5);
  assert.ok(audioOf(on.ws.sent[0]).some((b) => b !== 0), "barge-in on: the audio goes out");
  on.ws.server({ message_type: "partial_transcript", text: "오늘은 날씨가 정말" });
  assert.deepEqual(on.ev.partials, []); // her echo: nothing shown
  assert.equal(on.ev.barges, 0);
  on.ws.server({ message_type: "partial_transcript", text: "오늘은 날씨가 정말 잠깐만요 그만" });
  assert.equal(on.ev.barges, 1);
  assert.deepEqual(on.ev.partials, ["잠깐만요 그만"]);
  on.ws.server({ message_type: "committed_transcript", text: "오늘은 날씨가 정말, 잠깐만요 그만." });
  assert.deepEqual(on.ev.segments, [["잠깐만요 그만.", "realtime"]]);
});

test("session: a dropped socket reconnects with a fresh token, keeping the words so far", async () => {
  const h = harness();
  await h.s.start();
  const first = h.ws;
  first.server({ message_type: "session_started", session_id: "a" });
  h.speak();
  first.server({ message_type: "partial_transcript", text: "안녕하세요 저는" });
  first.drop(1006);
  assert.equal(h.ev.states.at(-1), "reconnecting");
  h.speak(); // buffered meanwhile
  h.advance(400);
  await h.tick();
  const second = h.ws;
  assert.notEqual(second, first);
  assert.match(second.url, /token=t2/);
  second.server({ message_type: "session_started", session_id: "b" });
  assert.equal(second.sent.length, 1, "the buffered audio goes to the new session");
  assert.deepEqual(h.ev.notices, [{ kind: "reconnected" }]);
  second.server({ message_type: "partial_transcript", text: "민수예요" });
  assert.equal(h.ev.partials.at(-1), "안녕하세요 저는 민수예요");
  second.server({ message_type: "committed_transcript", text: "민수예요." });
  assert.deepEqual(h.ev.segments, [["안녕하세요 저는 민수예요.", "realtime"]]);
});

test("session: no token (key rejected) → the server's recording fallback, or an error", async () => {
  let sent: { blob: Blob; engine: string } | null = null;
  const h = harness({
    getToken: async () => {
      throw new TokenError("ElevenLabs rejected the key", "auth", "whisper");
    },
    transcribe: async (blob, engine) => {
      sent = { blob, engine };
      return { text: "녹음으로 받아쓴 말" };
    },
  });
  await h.s.start();
  assert.equal(h.ev.states.at(-1), "recording");
  assert.equal(h.ev.notices[0].kind, "fallback");
  assert.equal(h.ev.notices[0].engine, "whisper");
  for (let i = 0; i < 10; i++) h.speak();
  await h.s.stop();
  assert.ok(sent);
  assert.equal(sent!.engine, "whisper");
  assert.equal(sent!.blob.type, "audio/wav");
  assert.ok(sent!.blob.size > 44 + 16000 * 2 * 0.9, `${sent!.blob.size} bytes`);
  assert.deepEqual(h.ev.segments, [["녹음으로 받아쓴 말", "fallback"]]);
  assert.equal(h.mic.closed, true);

  // the same key's batch model can't help with a rejected key; nothing else here → the error (useMic: browser / message)
  const h2 = harness({
    getToken: async () => {
      throw new TokenError("ElevenLabs rejected the key", "auth", "elevenlabs");
    },
  });
  await h2.s.start();
  assert.deepEqual(h2.ev.errors, [{ code: "auth", message: "ElevenLabs rejected the key", fb: "elevenlabs" }]);
  assert.equal(h2.mic.closed, true);
});

test("session: credits running out mid-way end it (no fallback with that key); a quiet stretch stops it", async () => {
  const h = harness({ transcribe: async () => ({ text: "나머지" }) });
  await h.s.start();
  h.ws.server({ message_type: "session_started", session_id: "a" });
  h.speak();
  h.ws.server({ message_type: "quota_exceeded", error: "no credits" });
  // (the token said "elevenlabs" can transcribe recordings, but not with no credits) → the end
  assert.equal(h.ev.errors[0].code, "quota");

  const idle = harness();
  idle.s.idleMs = 5000;
  await idle.s.start();
  idle.ws.server({ message_type: "session_started", session_id: "a" });
  idle.advance(1000);
  idle.advance(1000);
  for (let i = 0; i < 6; i++) idle.advance(1000);
  assert.deepEqual(idle.ev.notices, [{ kind: "idle" }]);
  assert.equal(idle.ev.states.at(-1), "finishing");
});
