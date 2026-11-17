// node --import ./test/ts-resolve.mjs --test test/call-listen.test.ts
// Listening on a call (src/mate/call/listen.ts, docs/mate-calls.md "Listening"): what they say is theirs as heard unless
// her voice played meanwhile — short answers ("응", "네") included —, and a token refused for a moment or a stream that
// is down never leaves the call deaf: the token is asked again, then each utterance is recorded for the server's engine
// while the stream is tried again. The server, the microphone and the clock are fakes.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { listen, STREAM_RETRY_MS, theirs, TOKEN_RETRY_MS, type ListenCallbacks, type ListenIO } from "../src/mate/call/listen.ts";
import { RealtimeTokenError } from "../src/api/mates.ts";

// ── what is theirs ──

test("theirs: as heard when her voice wasn't on — her words in it, short answers too", () => {
  const said = ["얘기하려고 전화한 거야? 나 지금 게임 중이었어."];
  // (they repeat her words: still theirs — nothing of hers was playing)
  assert.equal(theirs("아니, 얘기하려고 전화했다고.", said, false), "아니, 얘기하려고 전화했다고.");
  assert.equal(theirs("응", said, false), "응");
  assert.equal(theirs("네.", [], true), "네.");
});

test("theirs: while (or just after) her voice played — her echo out, a short answer kept once she stopped", () => {
  const said = ["오늘 뭐 했어? 밥은 먹었고?"];
  assert.equal(theirs("오늘 뭐 했어 밥은 먹었고", said, true, false), "", "only her echo");
  assert.equal(theirs("네", said, true, false), "네", "a quick answer the moment she stopped");
  assert.equal(theirs("응", said, true, true), "", "a short word while she still talks is them listening");
  assert.equal(theirs("잠깐만 그거 말고", said, true, true), "잠깐만 그거 말고", "enough words of theirs talk over her");
  assert.equal(theirs("밥은 먹었고 아니 나 아직", said, true, false), "아니 나 아직");
});

// ── a call's listening against fakes ──

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 1;
  sent: any[] = [];
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
  close() {
    this.readyState = 3;
  }
  server(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function call(tokens: (() => Promise<any>)[], opts: { fallback?: string | null; webSpeech?: boolean } = {}) {
  FakeWs.all = [];
  const got = { utterances: [] as [string, string][], fails: [] as string[], notices: [] as (string | null)[], diag: [] as string[], transcribed: [] as (string | undefined)[], heard: "응" };
  let frames: ((s: Float32Array, rate: number) => void) | null = null;
  const mics = { open: 0, closed: 0 };
  let n = 0;
  const io: ListenIO = {
    token: () => (tokens[Math.min(n++, tokens.length - 1)])(),
    transcribe: async (_id, _wav, engine) => {
      got.transcribed.push(engine);
      return { text: got.heard };
    },
    openMic: async (cb) => {
      frames = cb;
      mics.open++;
      return { rate: 16000, close: () => mics.closed++, onEnded: null };
    },
    webSpeech: () => (opts.webSpeech ? function () {} : null),
    newSocket: (url) => new FakeWs(url) as any,
  };
  const cb: ListenCallbacks = {
    onUtterance: (t, _at, how) => got.utterances.push([t, how]),
    onSpeech: () => {},
    onSilence: () => {},
    onPartial: () => {},
    onLevel: () => {},
    onNotice: (t) => got.notices.push(t),
    onFail: (t) => got.fails.push(t),
    onDiag: (ev) => got.diag.push(ev),
  };
  const l = listen(
    { mateId: "m1", lang: "ko", plan: { mode: "realtime", engine: "elevenlabs", fallback: opts.fallback === undefined ? "elevenlabs" : opts.fallback }, speaking: () => false, spoken: () => ["여보세요, 자기야?"], muted: () => false, io },
    cb,
  );
  /** `ms` of a voice (or of quiet) at 16 kHz into the open mic, the clock with it */
  const voice = (ms: number, level: number) => {
    for (let t = 0; t < ms; t += 30) {
      const f = Float32Array.from({ length: 480 }, (_, i) => level * Math.SQRT2 * Math.sin((2 * Math.PI * 300 * i) / 16000));
      frames!(f, 16000);
      mock.timers.tick(30);
    }
  };
  return { l, got, mics, voice };
}

const ok = async () => ({ url: "wss://fake/realtime?token=t", fallback: "elevenlabs" });
const hiccup = async () => {
  throw new RealtimeTokenError("ElevenLabs: 502 Bad Gateway", "upstream", "elevenlabs");
};

test("a token refused for a moment is asked for again: the call listens on the stream", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { l, got } = call([hiccup, hiccup, ok]);
    void l.start();
    await flush();
    assert.equal(FakeWs.all.length, 0);
    mock.timers.tick(TOKEN_RETRY_MS[0]);
    await flush();
    mock.timers.tick(TOKEN_RETRY_MS[1]);
    await flush();
    assert.equal(FakeWs.all.length, 1, "the stream, on the third token");
    FakeWs.all[0].server({ message_type: "session_started", session_id: "s" });
    FakeWs.all[0].server({ message_type: "committed_transcript", text: "응" });
    assert.deepEqual(got.utterances, [["응", "realtime"]]);
    assert.deepEqual(got.fails, []);
    assert.ok(!got.diag.includes("record"), got.diag.join(","));
    l.stop();
  } finally {
    mock.timers.reset();
  }
});

test("the stream can't be had: each utterance is recorded for the server's engine — and the stream comes back", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { l, got, mics, voice } = call([hiccup, hiccup, hiccup, ok]);
    void l.start();
    await flush();
    mock.timers.tick(TOKEN_RETRY_MS[0]);
    await flush();
    mock.timers.tick(TOKEN_RETRY_MS[1]);
    await flush();
    mock.timers.tick(1);
    await flush();
    assert.ok(got.diag.includes("stream.out") && got.diag.includes("record"), got.diag.join(","));
    assert.deepEqual(got.fails, [], "never deaf for a hiccup");
    assert.ok(mics.open >= 2, "the recording's own microphone");
    // a short answer, recorded and transcribed by the server's ElevenLabs
    voice(600, 0.001);
    voice(240, 0.08);
    voice(900, 0.001);
    await flush();
    assert.deepEqual(got.utterances, [["응", "record"]]);
    assert.equal(got.transcribed.at(-1), "elevenlabs");
    // a while later, at a quiet moment: the stream again (the recording stops once it is asked for)
    mock.timers.tick(STREAM_RETRY_MS[0]);
    await flush();
    assert.ok(got.diag.includes("stream.retry"), got.diag.join(","));
    assert.equal(FakeWs.all.length, 1);
    FakeWs.all[0].server({ message_type: "session_started", session_id: "s2" });
    assert.equal(got.notices.at(-1), null, "the notice about the server's engine goes");
    FakeWs.all[0].server({ message_type: "committed_transcript", text: "좋아" });
    assert.deepEqual(got.utterances.at(-1), ["좋아", "realtime"]);
    l.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a key or credits that fail: no retries — another engine if the server has one, else said plainly", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const auth = async () => {
      throw new RealtimeTokenError("invalid api key", "auth", "openai");
    };
    const a = call([auth], { fallback: "openai" });
    void a.l.start();
    await flush();
    mock.timers.tick(1);
    await flush();
    assert.ok(a.got.diag.includes("record"), a.got.diag.join(","));
    assert.deepEqual(a.got.fails, []);
    assert.equal(a.got.diag.filter((x) => x === "token.error").length, 1, "asked once");
    a.l.stop();

    const noKey = async () => {
      throw new RealtimeTokenError("invalid api key", "auth", "elevenlabs");
    };
    const b = call([noKey], { fallback: "elevenlabs" });
    void b.l.start();
    await flush();
    mock.timers.tick(1);
    await flush();
    assert.equal(b.got.fails.length, 1, "ElevenLabs is all there is and it refuses: said");
    assert.ok(b.got.diag.includes("deaf"));
    b.l.stop();
  } finally {
    mock.timers.reset();
  }
});
