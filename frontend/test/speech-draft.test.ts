import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeechDraft, joinTranscript } from "../src/mate/stt/draft.ts";
function setup(options = {}) {
  let box = "",
    now = 0,
    id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>(),
    sent: string[] = [];
  const draft = createSpeechDraft({
    read: () => box,
    write: (t) => {
      box = t;
    },
    send: (t) => sent.push(t),
    later: (fn, ms) => {
      const key = ++id;
      timers.set(key, { at: now + ms, fn });
      return key as any;
    },
    cancel: (key) => {
      timers.delete(key as any);
    },
  });
  draft.configure({
    autoSend: true,
    merge: true,
    grace: 1.8,
    ignoreShort: false,
    ...options,
  });
  const tick = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > end) break;
      now = entry[1].at;
      timers.delete(entry[0]);
      entry[1].fn();
    }
    now = end;
  };
  return {
    draft,
    sent,
    tick,
    get box() {
      return box;
    },
    edit: (t: string) => {
      box = t;
      draft.edit();
    },
  };
}
test("three interrupted fragments form one live draft and one message", () => {
  const s = setup();
  s.draft.segment("화면 공유를");
  s.tick(1200);
  s.draft.segment("켜 둔 상태로");
  s.tick(1200);
  s.draft.segment("다시 열어 줘.");
  assert.equal(s.box, "화면 공유를 켜 둔 상태로 다시 열어 줘.");
  s.tick(1799);
  assert.deepEqual(s.sent, []);
  s.tick(1);
  assert.deepEqual(s.sent, ["화면 공유를 켜 둔 상태로 다시 열어 줘."]);
  assert.equal(s.box, "");
});
test("a partial or speech activity postpones sending; waiting has no forced timeout", () => {
  const s = setup();
  s.draft.segment("이 설정은");
  s.tick(1500);
  s.draft.partial("앱마다");
  s.tick(15000);
  assert.equal(s.sent.length, 0);
  s.draft.partial("");
  s.draft.segment("앱마다 저장해");
  s.tick(1700);
  s.draft.activity();
  s.tick(1700);
  assert.equal(s.sent.length, 0);
  s.tick(100);
  assert.equal(s.sent.length, 1);
});
test("typing/composition cancels auto-send; more speech joins the edited draft but does not send it", () => {
  const s = setup();
  s.draft.segment("여기를");
  s.tick(1000);
  s.edit("여기를 직접 수정");
  s.draft.segment("그리고 확인해 줘");
  s.tick(20000);
  assert.equal(s.sent.length, 0);
  assert.equal(s.box, "여기를 직접 수정 그리고 확인해 줘");
});
test("manual send is immediate, consumes a visible partial, and its final cannot duplicate it", () => {
  const s = setup();
  s.draft.segment("먼저");
  s.draft.partial("설정을 확인해");
  const text = s.draft.manual(s.box, "설정을 확인해");
  assert.equal(text, "먼저 설정을 확인해");
  s.edit("");
  s.sent.push(text);
  s.draft.partial("");
  s.draft.segment("설정을 확인해");
  s.tick(3000);
  assert.equal(s.sent.length, 1);
  s.draft.segment("다음 작업도 해 줘");
  s.tick(1800);
  assert.equal(s.sent.length, 2);
});
test("follow-up after a sent message is a new send; steering is delegated unchanged", () => {
  const s = setup();
  s.draft.segment("첫 요청");
  s.tick(1800);
  s.draft.segment("이어지는");
  s.tick(1000);
  s.draft.segment("추가 요청");
  s.tick(1800);
  assert.deepEqual(s.sent, ["첫 요청", "이어지는 추가 요청"]);
});
test("all engines hold during recording/transcription; auto-send off waits; enable alone does not send old typed text", () => {
  const s = setup();
  s.draft.busy(true);
  s.draft.segment("Whisper transcript");
  s.tick(10000);
  assert.equal(s.sent.length, 0);
  s.draft.busy(false);
  s.tick(1800);
  assert.equal(s.sent.length, 1);
  const manual = setup({ autoSend: false });
  manual.draft.segment("browser transcript");
  manual.tick(5000);
  assert.equal(manual.box, "browser transcript");
  assert.equal(manual.sent.length, 0);
  const typed = setup({ autoSend: false });
  typed.edit("기존 글");
  typed.draft.configure({
    autoSend: true,
    merge: true,
    grace: 1.8,
    ignoreShort: false,
  });
  typed.tick(10000);
  assert.equal(typed.sent.length, 0);
});
test("manual send preserves markdown/newlines; optional noise filter is off by default", () => {
  const s = setup();
  assert.equal(s.draft.manual("```\ncode\n```", ""), "```\ncode\n```");
  s.draft.segment("네");
  s.tick(1800);
  assert.deepEqual(s.sent, ["네"]);
  const filtered = setup({ ignoreShort: true });
  filtered.draft.segment("음");
  filtered.tick(1800);
  assert.equal(filtered.sent.length, 0);
});
test("cancel/dispose cannot send; disabling merge preserves immediate mode; changed grace is live", () => {
  const s = setup();
  s.draft.segment("전송 금지");
  s.draft.dispose();
  s.tick(10000);
  assert.equal(s.sent.length, 0);
  const old = setup({ merge: false });
  old.draft.segment("바로 전송");
  old.tick(0);
  assert.equal(old.sent.length, 1);
  const live = setup();
  live.draft.segment("대기");
  live.tick(1000);
  live.draft.configure({
    autoSend: true,
    merge: true,
    grace: 3,
    ignoreShort: false,
  });
  live.tick(2999);
  assert.equal(live.sent.length, 0);
  live.tick(1);
  assert.equal(live.sent.length, 1);
});
test("fragment joins normalize spaces, punctuation and substantial overlap without deleting short repetition", () => {
  assert.equal(
    joinTranscript("설정을 확인해", "확인해 주세요."),
    "설정을 확인해 주세요.",
  );
  assert.equal(
    joinTranscript("hello there", "there are things"),
    "hello there are things",
  );
  assert.equal(joinTranscript("응", "응"), "응 응");
  assert.equal(joinTranscript("좋아", ", 이제 해 줘"), "좋아, 이제 해 줘");
});

import { browserResults } from "../src/mate/stt/browser.ts";
test("browser continuous recognition does not wait for onend, repeat finals, or append replaced partials", () => {
  const result = (text: string, isFinal: boolean) =>
    Object.assign([{ transcript: text }], { isFinal });
  const a = browserResults([result("첫 조각", true), result("아직", false)], 0);
  assert.deepEqual(a.finals, ["첫 조각"]);
  assert.equal(a.partial, "아직");
  const b = browserResults(
    [result("첫 조각", true), result("다음 말", true), result("계속", false)],
    a.delivered,
  );
  assert.deepEqual(b.finals, ["다음 말"]);
  assert.equal(b.partial, "계속");
  const c = browserResults(
    [result("첫 조각", true), result("다음 말", true)],
    b.delivered,
  );
  assert.equal(c.finals.length, 0);
  assert.equal(c.partial, "");
});
