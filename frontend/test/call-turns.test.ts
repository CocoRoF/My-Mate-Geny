// Taking turns on a call (src/mate/call/turns.ts): when they have finished (the words say), when they only paused, when
// they went on after she began, and when what they say while she talks is for her at all. Timelines on a fake clock.
import assert from "node:assert/strict";
import test from "node:test";
import { addressed, backchannel, endState, noiseOnly, substantive, TurnTaker, CONTINUE_MS } from "../src/mate/call/turns.ts";

test("the words say whether a sentence is finished (Korean endings, the recognizer's punctuation a weak sign)", () => {
  const complete = ["오늘 날씨 어때?", "나 방금 집에 도착했어.", "알았어", "응!", "그래", "밥 먹었지", "내일 갈게", "이거 맞습니까",
    "진짜 재밌었다", "좋아요", "그건 아닌 것 같아", "뭐 해", "빨리 와", "그거 해 줘", "몰라", "괜찮아요", "어디야?", "고마워"];
  const open = ["그래서 내가 어제 친구를 만났는데", "생리가 지금 생겨서", "근데 있잖아 그거", "그래서", "음", "내가 생각하기에는 그게",
    "밥 먹고", "가니까", "그거 하려고", "친구를", "집에서", "회사까지", "재미-", "그러니까…", "and then", "그리고", "아니 근데 진짜 그거를"];
  const unsure = ["내일 날씨", "어", "그랬다고", "엄마가"];
  for (const s of complete) assert.equal(endState(s), "complete", s);
  for (const s of open) assert.equal(endState(s), "open", s);
  for (const s of unsure) assert.equal(endState(s), "unsure", s);
});

test("backchannels, substance, noise", () => {
  for (const s of ["응", "응응", "맞아 맞아", "아 진짜", "ㅋㅋㅋ", "하하하", "그렇구나", "헐", "오케이", "음.", "네네", "uh-huh"]) assert.ok(backchannel(s), s);
  for (const s of ["아 근데 잠깐만", "그거 말고 다른 거", "엄마 나 통화 중이야", "내일 몇 시에 와"]) {
    assert.ok(!backchannel(s), s);
    assert.ok(substantive(s), s);
  }
  for (const s of ["응", "맞아 맞아", "그거", "아 진짜"]) assert.ok(!substantive(s), s);
  for (const s of ["(웃음)", "[음악]", "...", "♪", "시청해주셔서 감사합니다", "구독과 좋아요 부탁드려요"]) assert.ok(noiseOnly(s), s);
  for (const s of ["응", "감사합니다", "오늘 날씨 어때?"]) assert.ok(!noiseOnly(s), s);
});

/** a call's turn-taking on a fake clock: her voice and what she said so far are set by the test. The recognizer: a
 *  commit asked for comes back 250 ms later with the segment's words as they were (unless the test commits itself) */
function harness() {
  const log: string[] = [];
  const st = { her: false, heard: 0 };
  const sent: { text: string; at: number; amend: boolean; aside: boolean; endAt: number }[] = [];
  let now = 0;
  let shown = ""; // the open segment's words (the last partial)
  // (a commit asked for: back at `at` with the segment's words then — those its partials showed before it came back)
  let back: { at: number; text: string | null } | null = null;
  const tt = new TurnTaker(
    {
      send: (text, endAt, amend, aside) => {
        sent.push({ text, at: now, amend, aside, endAt });
        log.push(`send${amend ? "+" : ""}${aside ? "~" : ""}@${now}:${text}`);
      },
      confirm: () => log.push(`confirm@${now}`),
      hold: () => log.push(`hold@${now}`),
      resumed: () => log.push(`resumed@${now}`),
      barge: () => log.push(`barge@${now}`),
      duck: () => log.push(`duck@${now}`),
      commit: () => {
        log.push(`commit@${now}`);
        back = { at: now + 250, text: null };
      },
      ignored: (text, why) => log.push(`ignored@${now}:${why}:${text}`),
    },
    { herVoice: () => st.her, heardMs: () => st.heard },
  );
  /** advance to `t`, ticking every 50 ms (with the microphone `lvl` loud) */
  const until = (t: number, lvl = 0.01) => {
    while (now < t) {
      now = Math.min(t, now + 50);
      if (back && now >= back.at) {
        const b = back;
        back = null;
        const text = b.text ?? shown;
        shown = "";
        tt.committed(text, now);
      }
      tt.level(lvl, now);
      tt.tick(now);
    }
  };
  const say = (t: number, text: string, lvl = 0.2) => {
    until(t, lvl);
    shown = text;
    tt.partial(text, now);
  };
  /** the recognizer's commit: the one asked for, back at `t` with these words — or, none asked, one of its own */
  const commit = (t: number, text: string) => {
    if (back) {
      back = { at: t, text };
      until(t);
      return;
    }
    until(t);
    shown = "";
    tt.committed(text, now);
  };
  return { tt, log, st, sent, until, say, commit, at: () => now };
}

const bare = (s: string) => s.replace(/[.,?!]/g, "");

test("a finished question goes to her a quarter second after they stop — no fixed long pause", () => {
  const h = harness();
  h.say(300, "오늘");
  h.say(700, "오늘 날씨");
  h.say(1000, "오늘 날씨 어때?");
  h.until(2000);
  assert.deepEqual(h.log.slice(0, 3), ["commit@1200", "send@1200:오늘 날씨 어때?", "confirm@1250"]);
  assert.equal(h.sent[0].endAt, 1000, "the end of their speech is when they stopped");
});

test("they paused mid-thought and went on: her answer waits, then the whole sentence is answered once", () => {
  const h = harness();
  h.say(500, "그래서 내가");
  h.say(1500, "그래서 내가 어제 친구를 만났는데");
  // 1.2 s of breath: the words say more is coming — sent early (she starts thinking), but her voice waits
  h.until(2400);
  assert.deepEqual(h.log, ["commit@2300", "send@2300:그래서 내가 어제 친구를 만났는데"]);
  h.commit(2550, "그래서 내가 어제 친구를 만났는데.");
  h.say(2700, "생각보다");
  assert.ok(h.log.includes("resumed@2700"), h.log.join(" | "));
  assert.ok(!h.log.some((x) => x.startsWith("confirm")), "her voice never played for the half");
  h.say(3400, "생각보다 너무 재밌었어.");
  h.until(4200);
  const last = h.sent.at(-1)!;
  assert.equal(bare(last.text), bare("그래서 내가 어제 친구를 만났는데 생각보다 너무 재밌었어."));
  assert.ok(last.amend, "the earlier half is replaced, not answered on its own");
  assert.ok(h.log.includes("confirm@3650"), h.log.join(" | "));
});

test("in between (a noun phrase): sent soon, her voice a little later", () => {
  const h = harness();
  h.say(400, "내일 날씨");
  h.until(1500);
  assert.deepEqual(h.log, ["commit@800", "send@800:내일 날씨", "confirm@1000"]);
});

test("she had only just begun when they went on: she stops, and answers all of it", () => {
  const h = harness();
  h.say(500, "오늘 뭐 해?");
  h.until(1050);
  // her answer starts playing
  h.until(2500);
  h.st.her = true;
  h.st.heard = 300;
  h.say(2600, "아니 내 말은 저녁에");
  assert.ok(h.log.includes("resumed@2600"), h.log.join(" | "));
  h.st.her = false;
  h.until(3800);
  const last = h.sent.at(-1)!;
  assert.equal(last.text, "오늘 뭐 해? 아니 내 말은 저녁에");
  assert.ok(last.amend);
});

test("while she is well into talking: a backchannel or a laugh leaves her talking — nothing is sent", () => {
  const h = harness();
  h.say(200, "응 알았어");
  h.until(800);
  h.st.her = true;
  h.st.heard = 3000;
  h.say(CONTINUE_MS + 2000, "응");
  h.say(CONTINUE_MS + 2300, "응 맞아 맞아");
  h.until(CONTINUE_MS + 3500);
  h.say(CONTINUE_MS + 4000, "ㅋㅋㅋ");
  h.until(CONTINUE_MS + 5500);
  assert.ok(!h.log.some((x) => x.startsWith("barge")), h.log.join(" | "));
  assert.equal(h.sent.length, 1, "only their first line was a turn");
  assert.ok(h.log.some((x) => x.startsWith("ignored") && x.endsWith("응 맞아 맞아")), h.log.join(" | "));
});

test("words meant to stop her stop her at once, and are their next turn", () => {
  const h = harness();
  h.st.her = true;
  h.st.heard = 5000;
  h.say(300, "잠깐만");
  // (still so a moment later: a stream's first guess at a sound is sometimes a word it takes back)
  assert.ok(!h.log.some((x) => x.startsWith("barge")), h.log.join(" | "));
  h.until(450, 0.2);
  assert.ok(h.log.includes("barge@450"), h.log.join(" | "));
  h.st.her = false;
  h.say(1200, "잠깐만 그거 말고 다른 거 얘기해 줘");
  h.until(2200);
  const last = h.sent.at(-1)!;
  assert.equal(last.text, "잠깐만 그거 말고 다른 거 얘기해 줘");
  assert.equal(last.amend, false);
  assert.equal(last.aside, false);
  for (const s of ["잠깐만", "그만", "채린아 잠깐", "응?", "뭐라고?", "아니 그게 아니라", "여보세요?"]) assert.ok(addressed(s, ["한채린", "채린"]), s);
  for (const s of ["엄마 잠깐만 나 통화 중이야", "응", "그 영화 나도 봤어", "아 진짜?", "맞아 맞아"]) assert.ok(!addressed(s, ["한채린", "채린"]), s);
});

test("other words over her only soften her voice, and go to her as an aside — she judges, and goes on if not for her", () => {
  const h = harness();
  h.st.her = true;
  h.st.heard = 5000;
  h.say(300, "엄마");
  h.say(700, "엄마 나 지금 통화 중이야");
  assert.ok(!h.log.some((x) => x.startsWith("barge")), h.log.join(" | "));
  assert.ok(h.log.some((x) => x.startsWith("duck")), h.log.join(" | "));
  h.until(1500);
  const last = h.sent.at(-1)!;
  assert.equal(last.text, "엄마 나 지금 통화 중이야");
  assert.ok(last.aside, "an aside: her voice goes on");
  // (more of it, at once: the same aside, amended — still over her)
  h.say(1700, "이따 갈게");
  h.until(2600);
  assert.equal(bare(h.sent.at(-1)!.text), "엄마 나 지금 통화 중이야 이따 갈게");
  assert.ok(h.sent.at(-1)!.amend && h.sent.at(-1)!.aside, h.log.join(" | "));
});

test("talking over her for long stops her, whatever the words", () => {
  const h = harness();
  h.st.her = true;
  h.st.heard = 5000;
  const words = ["그거", "그", "저기", "있잖아", "그", "사람이", "막", "그"];
  for (let i = 0; i < words.length; i++) {
    h.say(100 + i * 300, words.slice(0, i + 1).join(" "));
    if (i === 2) assert.ok(!h.log.some((x) => x.startsWith("barge")), h.log.join(" | "));
  }
  assert.ok(h.log.some((x) => x.startsWith("barge")), h.log.join(" | "));
  assert.equal(h.sent.length, 0);
});

test("an '응' as she finishes is an answer — it goes to her", () => {
  const h = harness();
  h.st.her = true;
  h.st.heard = 4000;
  h.say(100, "응");
  h.st.her = false; // (she stopped: it answered her)
  h.until(1500);
  assert.equal(h.sent.at(-1)?.text, "응");
});

test("noise, tags and hallucinations are never anyone's words", () => {
  const h = harness();
  h.say(100, "(웃음)");
  h.say(300, "[음악]");
  h.until(2500);
  assert.equal(h.sent.length, 0);
  assert.equal(h.tt.state, "idle");
});

test("the recognizer's final words: more words than were sent amend it; a rewording doesn't; an empty one keeps it", () => {
  const h = harness();
  h.say(400, "오늘 날씨 어떄");
  h.until(900);
  h.commit(1100, "오늘 날씨 어때?");
  assert.equal(h.sent.length, 1, "a rewording is no reason to make her answer again");
  const m = harness();
  m.say(400, "여보세요?");
  m.until(700);
  assert.equal(m.sent.length, 1);
  // (they had said more before the commit: its final words have it, though no partial showed it yet)
  m.commit(900, "여보세요? 내 말 들려?");
  m.until(1600);
  assert.equal(m.sent.at(-1)!.text, "여보세요? 내 말 들려?");
  assert.ok(m.sent.at(-1)!.amend);
  const g = harness();
  g.say(300, "응.");
  g.until(800);
  g.commit(900, "");
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].text, "응.");
});

test("steady noise can't hold a turn open", () => {
  const h = harness();
  h.say(300, "그래서");
  // a loud room: the microphone never quiet, no more words
  h.until(4000, 0.08);
  assert.ok(h.log.some((x) => x.startsWith("confirm")), h.log.join(" | "));
});

test("a stream that commits by itself (the fallback's 700 ms pause): its commit is the turn, after the quiet it waited for", () => {
  const h = harness();
  h.tt.commitSilenceMs = 700;
  // (a short "응" the stream showed no partial for)
  h.until(200, 0.2);
  h.commit(900, "응");
  assert.deepEqual(h.sent.map((s) => s.text), ["응"]);
  assert.ok(h.log.includes("confirm@900"), h.log.join(" | "));
  // a pause mid-thought the stream cut: the halves are one turn
  const g = harness();
  g.tt.commitSilenceMs = 700;
  g.say(500, "그래서 내가 어제 친구를 만났는데");
  g.commit(1200, "그래서 내가 어제 친구를 만났는데");
  g.say(1300, "생각보다 재밌었어");
  g.until(2500);
  assert.equal(g.sent.at(-1)!.text, "그래서 내가 어제 친구를 만났는데 생각보다 재밌었어");
});

test("words with no sound behind them (the stream just opened, a hum read as her name) are nobody's", () => {
  const h = harness();
  h.until(600);
  h.tt.partial("채린.", h.at());
  h.until(2500);
  assert.equal(h.sent.length, 0, h.log.join(" | "));
  assert.ok(h.log.some((x) => x.startsWith("ignored") && x.includes("unvoiced")), h.log.join(" | "));
  // then they speak: heard
  h.say(3000, "채린아");
  h.say(3400, "채린아 오늘 날씨 어때?");
  h.until(4200);
  assert.equal(h.sent.at(-1)?.text, "채린아 오늘 날씨 어때?");
  // right after her voice the microphone can't tell: an answer then is heard
  const g = harness();
  g.until(1000);
  g.st.her = true;
  g.until(3000);
  g.st.her = false;
  g.tt.level(-1, 3050);
  g.tt.partial("응", 3100);
  g.until(4000);
  assert.equal(g.sent.at(-1)?.text, "응");
});

test("measured on the live stream: a re-punctuated partial is no more words; the sent segment's partial isn't repeated", () => {
  // (J) "…가야 돼." then "…가야 돼" then "…가야 돼." — nothing said
  const h = harness();
  h.say(500, "다섯 시에는 병원 가야 돼.");
  h.say(650, "다섯 시에는 병원 가야 돼");
  h.until(900);
  assert.equal(h.sent.length, 1);
  // (the sent segment's partials, its commit not back: the same words; then its words dropped from the end a moment)
  h.say(950, "다섯 시에는 병원 가야 돼.", 0.01);
  h.say(1000, "다섯 시에는 병원", 0.01);
  h.until(2500);
  assert.equal(h.sent.length, 1, h.log.join(" | "));
  assert.ok(!h.log.some((x) => x.startsWith("resumed")), h.log.join(" | "));
  // (G) sent at "여보세요?", the same segment's next partial has more — her commit not back: the whole, once
  const g = harness();
  g.say(300, "여보세요?");
  g.until(560);
  assert.equal(g.sent.length, 1);
  g.say(650, "여보세요? 내 말 들려?");
  assert.ok(g.log.includes("resumed@650"), g.log.join(" | "));
  g.until(2000);
  assert.equal(g.sent.at(-1)!.text, "여보세요? 내 말 들려?");
  assert.ok(g.sent.at(-1)!.amend);
  // (no commit asked for a segment that showed no words: the recognizer would only echo the last one)
  assert.equal(g.log.filter((x) => x.startsWith("commit")).length, 1, g.log.join(" | "));
});

test("the quiet right after their last word: an '음.' the recognizer 'hears' there is nobody's", () => {
  const h = harness();
  h.say(300, "생각보다 너무 재밌었어.");
  h.until(800);
  assert.equal(h.sent.length, 1);
  // (no sound after the turn ended — only its last word's tail)
  h.say(1000, "음.", 0.01);
  h.say(1300, "응.", 0.01);
  h.until(2500);
  assert.equal(h.sent.length, 1, h.log.join(" | "));
  // a word of theirs after it (her answer heard), with their voice: a turn
  h.st.heard = 2000;
  h.say(3000, "아 그리고", 0.2);
  h.say(3400, "아 그리고 내일 시간 돼?", 0.2);
  h.until(4200);
  assert.equal(h.sent.at(-1)?.text, "아 그리고 내일 시간 돼?");
});

test("a key term alone (her name at the start of any sound) is no words yet", () => {
  const h = harness();
  h.tt.keyterms = ["한채린", "채린"];
  h.say(300, "채린.");
  h.say(400, "한채린.");
  h.until(2000);
  assert.equal(h.sent.length, 0, h.log.join(" | "));
  h.say(2300, "채린아 오늘 뭐 해?");
  h.until(3000);
  assert.equal(h.sent.at(-1)?.text, "채린아 오늘 뭐 해?");
  // (after a turn, in a hum: never "more")
  h.say(3500, "채린.", 0.05);
  h.until(5000);
  assert.ok(!h.log.some((x) => x.startsWith("resumed")), h.log.join(" | "));
});

test("a long stretch far quieter than their turns (a TV behind them) is nobody's turn", () => {
  const h = harness();
  h.say(300, "응 나 왔어", 0.3);
  h.until(1200);
  assert.equal(h.sent.length, 1);
  // the TV: long, quiet
  h.until(8000);
  h.say(8300, "오늘 서울은", 0.05);
  h.say(9200, "오늘 서울은 대체로 맑겠고", 0.05);
  h.say(10100, "오늘 서울은 대체로 맑겠고 낮 최고 기온은 십이 도로 예상됩니다.", 0.05);
  h.until(12000);
  assert.equal(h.sent.length, 1, h.log.join(" | "));
  assert.ok(h.log.some((x) => x.includes("background")), h.log.join(" | "));
  // their own voice again: heard
  h.say(12500, "채린아 저녁 뭐 먹을까?", 0.3);
  h.until(13500);
  assert.equal(h.sent.at(-1)?.text, "채린아 저녁 뭐 먹을까?");
});

test("the TV was heard first, then their own voice, far louder: theirs takes the TV's place", () => {
  const h = harness();
  h.say(300, "오늘 서울은 대체로", 0.06);
  h.say(1200, "오늘 서울은 대체로 맑겠고 낮 최고 기온은 십이 도로 예상됩니다.", 0.06);
  h.until(1700);
  assert.equal(h.sent.length, 1, "nothing to tell the TV by yet");
  h.say(2300, "채린아 저녁 뭐 먹을까?", 0.4);
  h.until(3200);
  const last = h.sent.at(-1)!;
  assert.equal(last.text, "채린아 저녁 뭐 먹을까?");
  assert.ok(last.amend, "in place of the TV's");
  assert.ok(h.log.some((x) => x.includes("background")), h.log.join(" | "));
});

test("ends: a one-syllable verb said last is an end, a pronoun said last begins more", () => {
  assert.equal(endState("나 다음 주에 이사 가"), "complete");
  assert.equal(endState("빨리 와"), "complete");
  assert.equal(endState("응 나"), "open");
  assert.equal(endState("그래서 우리"), "open");
});

test("their voice again right after the end seemed sure, before hers began: her answer waits once more", () => {
  const h = harness();
  h.say(300, "근데 있잖아");
  h.until(1700);
  assert.ok(h.log.some((x) => x.startsWith("confirm")), h.log.join(" | "));
  // (a breath, then words — before her voice began)
  h.until(1900, 0.2);
  assert.ok(h.log.some((x) => x.startsWith("hold")), h.log.join(" | "));
  h.say(2300, "나 다음 주에 이사 가", 0.2);
  assert.ok(h.log.some((x) => x.startsWith("resumed")), h.log.join(" | "));
  h.until(3500);
  assert.equal(bare(h.sent.at(-1)!.text), "근데 있잖아 나 다음 주에 이사 가");
  // (once a turn: a noisy room can't keep her quiet)
  const n = harness();
  n.say(300, "알았어");
  n.until(800);
  n.until(4000, 0.2);
  assert.equal(n.log.filter((x) => x.startsWith("hold")).length, 1, n.log.join(" | "));
  assert.ok(n.log.filter((x) => x.startsWith("confirm")).length >= 2, n.log.join(" | "));
});

test("a new segment echoing the one just closed ('밥' after '밥 먹었어?') is the recognizer's, not theirs", () => {
  const h = harness();
  h.say(300, "밥 먹었어?");
  h.until(1000);
  assert.equal(h.sent.length, 1);
  h.until(1500, 0.2); // (a clatter)
  h.say(1600, "밥");
  h.say(1800, "밥.");
  h.until(3500);
  assert.equal(h.sent.length, 1, h.log.join(" | "));
  assert.ok(h.log.some((x) => x.includes("echo")), h.log.join(" | "));
});

test("'응?' over her, the recognizer's first guess reworded into it, stops her", () => {
  const h = harness();
  h.st.her = true;
  h.st.heard = 5000;
  h.say(300, "음.");
  h.say(600, "응?");
  h.until(1000);
  assert.ok(h.log.some((x) => x.startsWith("barge")), h.log.join(" | "));
});

test("a word cut where a segment closed, said whole at the next one's start, is one word", () => {
  const h = harness();
  h.say(300, "그래 그럼 내-");
  h.commit(400, "그래, 그럼 내-");
  h.say(500, "내일 저녁에 보자.");
  h.until(1500);
  assert.equal(h.sent.at(-1)!.text, "그래, 그럼 내일 저녁에 보자.");
});

// ── with the server's ear (app/mate/ear.py): their voice itself, and Smart Turn's judgement as it ends ──

/** the harness with an ear: `voice(from, to, p)` — their voice from..to, Smart Turn's p at its end (events at the
 *  times the server would send them: ~0.15 s after each edge) */
function eared() {
  const h = harness();
  const voice = (from: number, to: number, p: number) => {
    h.until(from + 150);
    h.tt.heard(true, from, undefined, h.at());
    h.until(to + 150, 0.2);
    h.tt.heard(false, to, p, h.at());
  };
  return { ...h, voice };
}

test("ear: a real call's '근데 그냥 자꾸…' — the words hang, so she waits, even when the voice is taken for done", () => {
  const h = eared();
  h.voice(0, 1200, 0.95);
  h.say(1300, "근데 그냥 자꾸");
  h.until(2000);
  // (her answer may be made meanwhile — her voice waits)
  assert.ok(!h.log.some((x) => x.startsWith("confirm")), `not cut off at 0.8 s of quiet: ${h.log.join(" | ")}`);
  // they go on after a 0.9 s breath
  h.voice(2100, 3600, 0.9);
  // (the segment was closed when her answer began to be made: the recognizer's next one has the new words)
  h.say(3700, "생각나서 전화했어");
  h.until(4600);
  assert.equal(h.sent.at(-1)?.text, "근데 그냥 자꾸 생각나서 전화했어");
  assert.equal(h.log.filter((x) => x.startsWith("confirm")).length, 1, "one turn, whole, heard once");
});

test("ear: the words and the voice both say done — her turn 0.3 s after their voice stopped", () => {
  const h = eared();
  h.voice(0, 1000, 0.97);
  h.say(1150, "오늘 날씨 어때?");
  h.until(2000);
  assert.ok(h.log.includes("confirm@1300"), h.log.join(" | "));
});

test("ear: done by the words, not by the voice — a little longer; hanging by both — long", () => {
  const h = eared();
  h.voice(0, 600, 0.02);
  h.say(700, "응.");
  h.until(2000);
  // ("응" may begin more — "응, 그래서…" — and the voice says so: a second)
  assert.ok(h.log.some((x) => x === "confirm@1600"), h.log.join(" | "));
  const d = eared();
  d.voice(0, 600, 0.02);
  d.say(700, "알았어.");
  d.until(2000);
  assert.ok(d.log.some((x) => x === "confirm@1250"), d.log.join(" | "));
  const g = eared();
  g.voice(0, 1500, 0.01);
  g.say(1600, "그래서 내가 어제 친구를 만났는데");
  g.until(2900);
  assert.ok(!g.log.some((x) => x.startsWith("confirm")), g.log.join(" | "));
  g.until(3300);
  assert.ok(g.log.some((x) => x === "confirm@3100"), g.log.join(" | "));
});

test("ear: the recognizer behind their voice — the quiet counts from their voice, the words decide when they come", () => {
  const h = eared();
  h.voice(0, 1000, 0.9);
  h.say(1100, "오늘 날씨");
  h.until(1350);
  assert.ok(!h.log.some((x) => x.startsWith("confirm")), "unsure words: not yet at 0.35 s");
  h.say(1400, "오늘 날씨 어때?");
  h.until(1500);
  assert.equal(h.sent.at(-1)?.text, "오늘 날씨 어때?");
  assert.deepEqual(h.log.filter((x) => x.startsWith("confirm")), ["confirm@1450"], h.log.join(" | "));
});

test("ear: still talking by the ear — nothing goes, however done the words look", () => {
  const h = eared();
  h.until(150);
  h.tt.heard(true, 0, undefined, 150);
  h.say(600, "오늘 날씨 어때?");
  h.until(2500, 0.2);
  assert.equal(h.sent.length, 0, h.log.join(" | "));
  h.tt.heard(false, 2500, 0.9, 2650);
  h.until(3000);
  assert.equal(h.sent.length, 1);
});

test("ear: words with no voice after a turn are nobody's; their voice again before hers began holds her answer", () => {
  const h = eared();
  h.voice(0, 800, 0.95);
  h.say(900, "밥 먹었어?");
  h.until(1300);
  assert.equal(h.sent.length, 1);
  h.say(1600, "음.");
  h.until(2500);
  assert.equal(h.sent.length, 1, h.log.join(" | "));
  // (confirmed; her voice not begun) their voice again → she waits
  h.until(2600);
  h.tt.heard(true, 2600, undefined, 2700);
  assert.ok(h.log.some((x) => x.startsWith("hold")), h.log.join(" | "));
});

test("ear: a voice it says goes on with no words for long is not trusted; a dropped line puts the level back", () => {
  const h = eared();
  h.say(200, "그래서");
  h.tt.heard(true, 100, undefined, 300);
  h.until(9000, 0.01);
  assert.ok(h.sent.length >= 1, "a stuck 'voice' doesn't hold a turn forever");
  const g = eared();
  g.tt.heard(true, 0, undefined, 100);
  g.tt.earGone();
  g.say(300, "알았어");
  g.until(1200);
  assert.equal(g.sent.at(-1)?.text, "알았어");
});

test("words: an adverb said last hangs ('근데 그냥 자꾸', '나 오늘 진짜 너무'); '자꾸나' is '자꾸 나…'", () => {
  for (const s of ["근데 그냥 자꾸", "나 오늘 진짜 너무", "아니 그게 계속", "그래서 그냥", "기다리고 있었는데, 자꾸나"]) assert.equal(endState(s), "open", s);
  for (const s of ["진짜", "정말?", "너무해", "자꾸 왜 그래?"]) assert.notEqual(endState(s), "open", s);
});

test("more of their turn begun with an '아' after she began: a backchannel-like sound, then words — the same turn", () => {
  const h = harness();
  h.say(300, "근데 있잖아");
  h.until(1700);
  assert.ok(h.log.some((x) => x.startsWith("confirm")));
  // her answer began (0.3 s of it heard), then theirs: "아…" then the rest
  h.st.her = true;
  h.st.heard = 300;
  h.say(2000, "아");
  h.say(2400, "나 다음 주에 이사 가");
  assert.ok(h.log.some((x) => x.startsWith("resumed")), h.log.join(" | "));
  h.st.her = false;
  h.until(3500);
  const last = h.sent.at(-1)!;
  assert.ok(last.amend && !last.aside, h.log.join(" | "));
  assert.match(last.text, /^근데 있잖아 .*이사 가$/);
});
