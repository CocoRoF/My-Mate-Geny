// A call's line in the page (src/mate/call/session.ts) as the turn-taking drives it: words said over her that weren't for
// her leave her talking (an aside: turned down, then on — or stopped by her answer to it), her voice waiting once more
// when they go on, a barge stopping every reply of hers that is on. A fake line, a fake loudspeaker (each clip plays
// for CLIP_MS), the real queue.
import assert from "node:assert/strict";
import test from "node:test";

const CLIP_MS = 250;
const store: Record<string, string> = {};
class Speaker extends EventTarget {
  dataset: Record<string, string> = {};
  src = "";
  paused = true;
  ended = false;
  volume = 1;
  preload = "";
  error = null;
  currentTime = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  setAttribute() {}
  removeAttribute() {
    this.src = "";
  }
  load() {}
  pause() {
    this.paused = true;
    clearTimeout(this.timer);
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.paused = true;
      this.ended = true;
      this.dispatchEvent(new Event("ended"));
    }, CLIP_MS);
    return Promise.resolve();
  }
}
const sent: Record<string, any>[] = [];
class Line {
  static OPEN = 1;
  readyState = 1;
  send(s: string) {
    sent.push(JSON.parse(s));
  }
  close() {}
}
Object.assign(globalThis, {
  window: Object.assign(new EventTarget(), { location: { protocol: "http:", host: "x", origin: "http://x", href: "http://x/" } }),
  document: Object.assign(new EventTarget(), { visibilityState: "visible", hidden: false }),
  localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v), removeItem: (k: string) => delete store[k] },
  Audio: Speaker,
  HTMLMediaElement: Speaker,
  WebSocket: Line,
  // (the app's windows talking to each other: none here — and nothing to keep Node up)
  BroadcastChannel: class {
    onmessage = null;
    postMessage() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
});
const { CallSession } = await import("../src/mate/call/session.ts");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a call on the line, past its first words; `slow`: her voice's clips take this long to make */
function line(slow = 0) {
  sent.length = 0;
  const ev = { connected() {}, speaking() {}, caption() {}, partial() {}, userTalking() {}, level() {}, notice() {}, deaf() {}, reconnecting() {}, ended() {}, server() {} };
  const s = new CallSession(
    { id: "c1", mate_id: "m1", direction: "outgoing", status: "active" } as any,
    { id: "m1", name: "한채린", voice: { tts: { engine: "elevenlabs", language: "ko" } }, persona: { language: "ko" }, prefs: {} } as any,
    { stt: { mode: "realtime" }, tts: { engine: "elevenlabs" } } as any,
    ev as any,
    { muted: false, speaker: true },
  ) as any;
  s.ws = new Line();
  s.lineReady = true;
  s.clicked = true;
  s.through = true;
  const played: string[] = [];
  s.queue.setResolver(async (item: { text?: string }) => {
    if (slow) await wait(slow);
    return `clip:${item.text}`;
  });
  s.queue.onItemStart = (item: any) => {
    played.push(item.text);
    s.onSound(item);
  };
  /** her reply `rid` as the server streams it */
  const reply = (rid: string, text: string) => {
    s.onMessage({ type: "reply", rid });
    s.onMessage({ type: "delta", rid, text });
    s.onMessage({ type: "done", rid, text });
  };
  return { s, played, reply, says: () => sent.filter((m) => m.type === "say"), barges: () => sent.filter((m) => m.type === "barge") };
}

test("words over her not for her: she goes on, turned down, and at her volume again when her answer is [SILENT]", async () => {
  const { s, played, reply, says, barges } = line();
  try {
    reply("r1", "첫 번째 얘기야. 두 번째 얘기야. 세 번째 얘기야.");
    await wait(60);
    assert.ok(s.speakingNow(), "she is talking");
    s.utter("엄마 나 지금 통화 중이야", Date.now(), "realtime", false, true);
    const say = says().at(-1)!;
    assert.equal(say.aside, true);
    assert.equal(say.over, "r1");
    assert.match(say.over_heard, /첫 번째 얘기야/);
    assert.ok(s.ducked, "turned down meanwhile");
    assert.ok(s.speakingNow(), "never stopped");
    s.confirmTurn();
    reply("r2", "[SILENT]");
    assert.equal(s.ducked, false, "her volume back");
    assert.equal(s.current.rid, "r1", "what she was saying is hers again");
    assert.equal(barges().length, 0);
    await wait(CLIP_MS * 3 + 200);
    assert.deepEqual(played, ["첫 번째 얘기야.", "두 번째 얘기야.", "세 번째 얘기야."], "said to its end");
  } finally {
    s.finish("hangup");
  }
});

test("words over her that were for her: her answer to them stops what she was saying, and is said", async () => {
  const { s, played, reply, barges } = line();
  try {
    reply("r1", "첫 번째 얘기야. 두 번째 얘기야. 세 번째 얘기야.");
    await wait(60);
    s.utter("근데 그거 언제 하는 거야?", Date.now(), "realtime", false, true);
    s.confirmTurn();
    reply("r2", "아, 그거 다음 주 토요일이야.");
    const b = barges().at(-1)!;
    assert.equal(b.rid, "r1");
    assert.equal(b.aside, true, "her answer knew what they had heard");
    await wait(CLIP_MS + 200);
    assert.equal(played.at(-1), "아, 그거 다음 주 토요일이야.");
    assert.ok(!played.includes("세 번째 얘기야."), "what she was saying stopped there");
    assert.equal(s.ducked, false);
  } finally {
    s.finish("hangup");
  }
});

test("more of an aside before her answer to it came: she still goes on; a stop word then stops every reply that is on", async () => {
  const { s, reply, says, barges } = line();
  try {
    reply("r1", "첫 번째 얘기야. 두 번째 얘기야. 세 번째 얘기야.");
    await wait(60);
    s.utter("엄마 나 지금", Date.now(), "realtime", false, true);
    s.resumeTurn(); // (they went on — her answer to it not come yet)
    assert.ok(s.speakingNow(), "what she was saying goes on");
    s.utter("엄마 나 지금 통화 중이야", Date.now(), "realtime", true, true);
    const say = says().at(-1)!;
    assert.ok(say.aside && say.amend);
    s.onMessage({ type: "reply", rid: "r2" });
    assert.ok(s.current.aside);
    s.interrupt(); // ("잠깐만" — words meant to stop her)
    assert.deepEqual(barges().map((x) => x.rid).sort(), ["r1", "r2"]);
    assert.ok(!s.speakingNow());
    assert.equal(s.asideFor, null);
  } finally {
    s.finish("hangup");
  }
});

test("their voice again before hers began: her answer goes back to waiting, then the whole turn is answered", async () => {
  const { s, played, reply, says } = line(120);
  try {
    s.utter("근데 있잖아", Date.now(), "realtime");
    reply("r1", "응, 뭔데?");
    s.confirmTurn();
    await wait(40); // (its clip still being made)
    s.holdTurn();
    assert.ok(s.turnOpen, "waiting once more");
    assert.equal(s.waiting.length, 1);
    s.utter("근데 있잖아 나 다음 주에 이사 가", Date.now(), "realtime", true);
    const say = says().at(-1)!;
    assert.ok(say.amend);
    assert.equal(say.heard, "", "nothing of her answer to the half was heard");
    assert.equal(say.rid, "r1");
    s.confirmTurn();
    reply("r2", "진짜? 어디로 가?");
    await wait(700);
    assert.deepEqual(played, ["진짜?", "어디로 가?"], "her answer to the half was never heard");
  } finally {
    s.finish("hangup");
  }
});

test("stopped while her answer to an aside was still to come: that answer goes unheard when it comes", async () => {
  const { s, played, says, barges } = line();
  try {
    s.onMessage({ type: "reply", rid: "r1" });
    s.onMessage({ type: "delta", rid: "r1", text: "첫 번째 얘기야. 두 번째 얘기야." });
    s.onMessage({ type: "done", rid: "r1", text: "첫 번째 얘기야. 두 번째 얘기야." });
    await wait(60);
    s.utter("그 영화 나도 봤는데", Date.now(), "realtime", false, true);
    const seq = says().at(-1)!.seq;
    assert.equal(typeof seq, "number");
    s.interrupt(); // ("잠깐만")
    s.onMessage({ type: "reply", rid: "r2", seq });
    s.onMessage({ type: "delta", rid: "r2", text: "아 진짜? 어땠어?" });
    assert.ok(barges().some((b) => b.rid === "r2"), "the server is told it went unheard");
    s.confirmTurn();
    await wait(400);
    assert.ok(!played.some((x) => x.includes("어땠어")), played.join(" | "));
    // (their next turn's answer is heard as ever)
    s.utter("잠깐만 그거 말고", Date.now(), "realtime");
    s.confirmTurn();
    s.onMessage({ type: "reply", rid: "r3", seq: says().at(-1)!.seq });
    s.onMessage({ type: "delta", rid: "r3", text: "응, 뭐?" });
    s.onMessage({ type: "done", rid: "r3", text: "응, 뭐?" });
    await wait(400);
    assert.equal(played.at(-1), "응, 뭐?");
  } finally {
    s.finish("hangup");
  }
});
