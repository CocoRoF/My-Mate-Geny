import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeechDraft, joinTranscript, type SpeechPacket } from "../src/mate/stt/draft.ts";
import { browserResults } from "../src/mate/stt/browser.ts";
function setup(options = {}) {
  let box = "",
    now = 0,
    id = 0,
    nextGroup = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: { at: number; text: string; packet: SpeechPacket }[] = [],
    touches: SpeechPacket[] = [];
  const draft = createSpeechDraft({
    read: () => box,
    write: (t) => {
      box = t;
    },
    send: (text, packet) => {
      sent.push({ at: now, text, packet });
    },
    touch: (p) => touches.push(p),
    now: () => now,
    id: () => `voice-${++nextGroup}`,
    later: (fn, ms) => {
      const key = ++id;
      timers.set(key, { at: now + ms, fn });
      return key as any;
    },
    cancel: (key) => {
      timers.delete(key as any);
    },
  });
  draft.configure({ autoSend: true, merge: true, silence: 1.8, grace: 4, ignoreShort: false, ...options });
  const tick = (ms: number) => {
    const end = now + ms;
    let guard = 0;
    for (;;) {
      const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > end) break;
      if (++guard > 100) throw Error("timer loop");
      now = entry[1].at;
      timers.delete(entry[0]);
      entry[1].fn();
    }
    now = end;
  };
  const speech = (text: string) => {
    draft.activity();
    draft.partial(text);
  };
  return {
    draft,
    sent,
    touches,
    tick,
    speech,
    get box() {
      return box;
    },
    get now() {
      return now;
    },
    edit: (text: string) => {
      box = text;
      draft.edit();
    },
  };
}
test("receive at 1.8 seconds, parallel response deadline 4 seconds, never 5.8", () => {
  const s = setup();
  s.speech("첫 문장");
  s.tick(1799);
  assert.equal(s.sent.length, 0);
  s.tick(1);
  assert.equal(s.sent[0].at, 1800);
  assert.equal(s.sent[0].packet.window_ms, 4000);
  assert.equal(s.sent[0].packet.idle_ms, 1800);
  assert.equal(s.sent[0].at + s.sent[0].packet.window_ms - s.sent[0].packet.idle_ms, 4000);
  assert.equal(s.box, "");
  s.draft.segment("첫 문장.");
  s.tick(0);
  assert.equal(new Set(s.sent.map((p) => p.packet.group_id)).size, 1);
  assert.equal(s.sent.at(-1)?.text, "첫 문장.");
});
test("three-second pauses update the already received SAME group, not separate steers", () => {
  const s = setup();
  s.speech("첫 조각");
  s.tick(1800);
  s.draft.segment("첫 조각");
  s.tick(1200);
  s.speech("둘째 조각");
  s.tick(1800);
  s.draft.segment("둘째 조각");
  s.tick(1200);
  s.speech("셋째 조각");
  s.tick(1800);
  s.draft.segment("셋째 조각");
  s.tick(0);
  assert.deepEqual(
    s.sent.map((x) => x.at),
    [1800, 4800, 7800],
  );
  assert.equal(new Set(s.sent.map((x) => x.packet.group_id)).size, 1);
  assert.equal(s.sent.at(-1)?.text, "첫 조각 둘째 조각 셋째 조각");
  assert.equal(s.touches.length, 2);
});
test("continuation immediately after send remains in the group; after four seconds is a new group", () => {
  const s = setup();
  s.speech("처음");
  s.tick(1800);
  s.draft.segment("처음");
  s.tick(100);
  s.speech("계속");
  s.tick(1800);
  s.draft.segment("계속");
  s.tick(0);
  assert.equal(new Set(s.sent.map((x) => x.packet.group_id)).size, 1);
  assert.equal(s.sent.at(-1)?.text, "처음 계속");
  s.tick(2301);
  s.speech("새 요청");
  s.tick(1800);
  assert.equal(new Set(s.sent.map((x) => x.packet.group_id)).size, 2);
  assert.equal(s.sent.at(-1)?.text, "새 요청");
});
test("a late recognizer final does not start another silence timer or duplicate a sent partial", () => {
  const s = setup();
  s.speech("아직 인식 중");
  s.tick(1800);
  s.tick(300);
  s.draft.segment("인식이 끝난 문장.");
  s.tick(0);
  assert.deepEqual(
    s.sent.map((x) => x.at),
    [1800, 2100],
  );
  assert.equal(s.sent[0].packet.group_id, s.sent[1].packet.group_id);
  assert.equal(s.sent[1].text, "인식이 끝난 문장.");
});
test("new speech postpones the next send without waiting for the final result", () => {
  const s = setup();
  s.speech("앞부분");
  s.tick(1500);
  s.draft.activity();
  s.tick(1500);
  assert.equal(s.sent.length, 0);
  s.tick(300);
  assert.equal(s.sent.length, 1);
});
test("typing cancels automatic sending and microphone recording/transcription hold the draft", () => {
  const s = setup();
  s.speech("말하다가");
  s.tick(1000);
  s.edit("직접 고친 내용");
  s.draft.segment("계속된 말");
  s.tick(10000);
  assert.equal(s.sent.length, 0);
  const w = setup();
  w.draft.speaking(true);
  w.draft.busy(true);
  w.tick(1000);
  w.draft.speaking(false);
  w.tick(2000);
  w.draft.segment("Whisper 확정");
  w.draft.busy(false);
  w.tick(0);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].at, 3000);
});
test("manual send forces an existing accepted group immediately; manual-only mode never autosends", () => {
  const s = setup();
  s.speech("이미 보낸 말");
  s.tick(1800);
  s.draft.segment("이미 보낸 말");
  s.edit("직접 추가");
  const text = s.draft.manual(s.box, "");
  assert.equal(text, "이미 보낸 말 직접 추가");
  assert.equal(s.draft.manualDispatch(), true);
  assert.equal(s.sent.at(-1)?.packet.window_ms, 0);
  const off = setup({ autoSend: false });
  off.speech("입력 초안");
  off.draft.segment("입력 초안");
  off.tick(10000);
  assert.equal(off.sent.length, 0);
  assert.equal(off.box, "입력 초안");
});
test("manual sends preserve markdown and later final punctuation cannot create a new message", () => {
  const s = setup();
  assert.equal(s.draft.manual("```\ncode\n```", ""), "```\ncode\n```");
  assert.equal(s.draft.manualDispatch(), undefined);
  s.draft.partial("수동 전송 문장");
  assert.equal(s.draft.manual("", "수동 전송 문장"), "수동 전송 문장");
  s.draft.segment("수동 전송 문장.");
  s.tick(10000);
  assert.equal(s.sent.length, 0);
});
test("short noise filtering optional, disabled merge uses the send pause, dispose cancels timers", () => {
  const noise = setup({ ignoreShort: true });
  noise.draft.segment("음");
  noise.tick(5000);
  assert.equal(noise.sent.length, 0);
  const plain = setup({ merge: false });
  plain.speech("즉시 모드");
  plain.tick(1800);
  assert.equal(plain.sent[0].packet.window_ms, 1800);
  const stopped = setup();
  stopped.speech("전송 금지");
  stopped.draft.dispose();
  stopped.tick(5000);
  assert.equal(stopped.sent.length, 0);
});
test("joins preserve short repetition, substantial overlap, CJK spacing and punctuation", () => {
  assert.equal(joinTranscript("설정을 확인해", "확인해 주세요."), "설정을 확인해 주세요.");
  assert.equal(joinTranscript("응", "응"), "응 응");
  assert.equal(joinTranscript("좋아", ", 이제 해 줘"), "좋아, 이제 해 줘");
  assert.equal(joinTranscript("你好", "世界"), "你好世界");
});
test("browser cumulative finals are delivered once and partial replacements do not append", () => {
  const result = (text: string, isFinal: boolean) => Object.assign([{ transcript: text }], { isFinal });
  const a = browserResults([result("처음", true), result("중간", false)], 0);
  const b = browserResults([result("처음", true), result("마지막", true)], a.delivered);
  assert.deepEqual(a.finals, ["처음"]);
  assert.equal(a.partial, "중간");
  assert.deepEqual(b.finals, ["마지막"]);
  assert.equal(browserResults([result("처음", true), result("마지막", true)], b.delivered).finals.length, 0);
});

import { saveSpeech, pendingSpeech, ackSpeech } from "../src/mate/stt/outbox.ts";
test("unacknowledged speech survives reconnect; stale acknowledgements cannot erase new text", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) },
  });
  const packet: SpeechPacket = {
    group_id: "v1",
    client_msg_id: "v1",
    revision: 1,
    op: "submit",
    input: "first",
    window_ms: 4000,
    idle_ms: 1800,
    activity_at: 0,
  };
  assert.equal(saveSpeech("sid", packet, []), true);
  assert.equal(pendingSpeech("sid").length, 1);
  saveSpeech("sid", { ...packet, revision: 2, input: "first second" }, []);
  ackSpeech("sid", "v1", 1);
  assert.equal(pendingSpeech("sid")[0].packet.revision, 2);
  assert.equal(ackSpeech("sid", "v1", 1, "first"), "second");
  assert.equal(pendingSpeech("sid").length, 0);
  Reflect.deleteProperty(globalThis, "localStorage");
});

test("a final correction after the response window is kept for review instead of silently disappearing", () => {
  const s = setup();
  s.speech("잠정 문장");
  s.tick(4100);
  s.draft.segment("수정된 최종 문장");
  s.tick(5000);
  assert.equal(s.sent.length, 1);
  assert.equal(s.box, "수정된 최종 문장");
});
