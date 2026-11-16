// The State tab's pure parts (frontend/src/mate/gss.ts): times before and after now, the words she is told, a model's
// reading as chips, promises, what is still with her, each journal entry in a line, her temperament (ranges, what of it
// is the user's own) and a simulation as chart series — in both languages, never a key or a code shown as words.
// Run: npm run test:unit
import assert from "node:assert/strict";
import test from "node:test";
import en from "../src/i18n/en/index.ts";
import ko from "../src/i18n/ko/index.ts";
import { fillPlaceholders } from "../src/lib/josa.ts";
import type { TFunction } from "../src/i18n";
import type { GssEntry, GssSimPoint } from "../src/api/mates";
import {
  afterText,
  cleanSteps,
  cleanTemperament,
  CRITERIA,
  criterionText,
  entryText,
  evalReport,
  EVENTS,
  feelingWord,
  filterEntries,
  grudgeParts,
  hoursAgoText,
  isCustom,
  knob,
  LAYER_LABEL,
  LAYERS,
  mergeEntries,
  normalizeLoves,
  overrideOf,
  parseHours,
  PRESETS,
  promiseStatusText,
  promiseTone,
  promiseWhen,
  readingChips,
  sameTemperament,
  scoreText,
  scoreTone,
  simSeries,
  whenText,
  wordText,
} from "../src/mate/gss";

const tOf = (cat: Record<string, Record<string, unknown>>, korean: boolean) =>
  ((key: string, vars?: Record<string, string | number>) => {
    const [ns, k] = key.split(".");
    const m = cat[ns]?.[k];
    if (m === undefined) return key;
    const s = typeof m === "string" ? m : Number(vars?.count ?? 0) === 1 ? (m as { one: string }).one : (m as { other: string }).other;
    return vars ? fillPlaceholders(s, (n) => (n in vars ? String(vars[n]) : undefined), korean) : s;
  }) as unknown as TFunction;
const KO = tOf(ko as never, true);
const EN = tOf(en as never, false);
const LANGS = { ko: KO, en: EN };

const NOW = Date.parse("2026-11-16T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();

test("times before and after now, a grudge's age, a simulation's time from its start", () => {
  assert.equal(whenText(KO, ago(3), NOW), "3분 전");
  assert.equal(whenText(KO, ago(-180), NOW), "3시간 후");
  assert.equal(whenText(KO, ago(-60 * 72), NOW), "3일 후");
  assert.equal(whenText(KO, ago(0), NOW), "방금");
  assert.equal(whenText(EN, ago(-30), NOW), "in 30m");
  assert.equal(whenText(EN, ago(120), NOW), "2h ago");
  assert.equal(hoursAgoText(KO, 0.05), "방금");
  assert.equal(hoursAgoText(KO, 0.5), "30분 전");
  assert.equal(hoursAgoText(KO, 3.2), "3시간 전");
  assert.equal(hoursAgoText(EN, 50), "2d ago");
  assert.equal(afterText(KO, 0), "시작");
  assert.equal(afterText(KO, 30), "+30분");
  assert.equal(afterText(KO, 150), "+2시간 30분");
  assert.equal(afterText(KO, 120), "+2시간");
  assert.equal(afterText(KO, 1440 + 360), "+1일 6시간");
  assert.equal(afterText(EN, 2880), "+2d");
});

test("the words she is told, in the user's language; one with no words of its own as it came", () => {
  assert.equal(wordText(KO, "a little"), "조금");
  assert.equal(wordText(KO, "quite"), "꽤");
  assert.equal(wordText(EN, "strongly"), "strongly");
  assert.equal(wordText(KO, "something new"), "something new");
  assert.equal(wordText(KO, ""), "");
  // (no word from the server: the one the value has; below showing, none)
  assert.equal(feelingWord(KO, "", 0.5), "꽤");
  assert.equal(feelingWord(KO, undefined, 0.8), "몹시");
  assert.equal(feelingWord(KO, "", 0.1), "");
  assert.equal(feelingWord(KO, "strongly", 0.1), "몹시");
});

test("a model's reading as chips: what they did, how strongly, at her or not, sarcasm, owning it, promises", () => {
  const chips = readingChips(KO, { message: "다시는 안 그럴게, 미안", acts: ["apology", "putdown", "something_else"], intensity: 0.8, aimed: true, owns: true, sarcastic: false, promise: "다시는 안 그러기" }, "한채린");
  assert.deepEqual(
    chips.map((c) => [c.text, c.tone]),
    [
      ["사과", "ok"],
      ["깔봄", "danger"],
      ["something else", "muted"],
      ["세기 80", "warn"],
      ["한채린에게 한 말", "accent"],
      ["잘못을 인정함", "ok"],
      ["약속: 다시는 안 그러기", "accent"],
    ],
  );
  const en_ = readingChips(EN, { acts: ["Brush-off"], aimed: false, sarcastic: true, her_promise: { what: "call you tonight" }, fulfills: true }, "Seoa");
  assert.deepEqual(en_.map((c) => c.text), ["brush-off", "not at Seoa", "sarcastic", "Seoa's promise: call you tonight", "keeps a promise"]);
  assert.deepEqual(readingChips(KO, {}), []);
});

test("promises: status in words and tone, and when (due, made, settled)", () => {
  for (const [lang, t] of Object.entries(LANGS)) {
    for (const s of ["open", "overdue", "kept", "broken", "lapsed"]) {
      const w = promiseStatusText(t, s);
      assert.ok(w && w !== s && !w.includes("gss."), `${lang} ${s}: ${w}`);
    }
  }
  assert.equal(promiseStatusText(KO, "a_status_from_later"), "a_status_from_later");
  assert.equal(promiseTone("kept"), "ok");
  assert.equal(promiseTone("broken"), "danger");
  assert.equal(promiseTone("overdue"), "warn");
  assert.equal(promiseTone("lapsed"), "muted");
  assert.equal(promiseWhen(KO, { status: "open", due_at: ago(-120), made_at: ago(60) }, NOW).text, "기한 2시간 후");
  assert.equal(promiseWhen(KO, { status: "overdue", due_at: ago(90), made_at: ago(600) }, NOW).text, "기한 2시간 전");
  assert.equal(promiseWhen(KO, { status: "open", due_at: null, made_at: ago(5) }, NOW).text, "5분 전 약속");
  const kept = promiseWhen(EN, { status: "kept", due_at: ago(60), made_at: ago(600), settled_at: ago(30) }, NOW);
  assert.deepEqual([kept.text, kept.key], ["30m ago", null]);
});

test("what is still with her: how much, what, when, and what the apologies so far were", () => {
  const g = { v: 0.6, why: { code: "hostile", kind: "threat" }, hours: 3, sorry: 0, owned: false };
  assert.deepEqual(grudgeParts(KO, g), { strength: "아직 아픔", what: "위협을 받아서", ago: "3시간 전", sorry: "아직 없어요", stings: true });
  assert.equal(grudgeParts(KO, { ...g, v: 0.3, sorry: 2 }).sorry, "2번, 그냥 미안하다는 말만");
  assert.equal(grudgeParts(KO, { ...g, v: 0.3 }).strength, "덜 풀림");
  assert.equal(grudgeParts(EN, { ...g, sorry: 1, owned: true }).sorry, "1, owning what you did");
  assert.equal(grudgeParts(KO, { ...g, why: {} }).what, "내가 한 일");
});

test("each journal entry in a line, by its layer", () => {
  const e = (layer: GssEntry["layer"], data: Record<string, unknown>, kind = "") => ({ layer, kind, data });
  assert.equal(entryText(KO, e("feeling", { emotion: "angry", from: 0.2, to: 0.62, why: { code: "rude" } })), "화남 ↑ 20 → 62 · 거친 말을 들어서");
  assert.equal(entryText(KO, e("feeling", { emotion: "happy", from: 0.6, to: 0.3 })), "기쁨 ↓ 60 → 30");
  assert.equal(entryText(KO, e("grudge", { v: 0.5, why: { code: "dismissed" }, sorry: 1, owned: true })), "마음에 남음: 50 · 차갑게 넘겨서 · 1번, 잘못을 인정하며");
  // (trust, romance, respect as 0 – 1 or 0 – 100; affinity always 0 – 100; a why of the relationship's log)
  assert.equal(entryText(KO, e("bond", { trust: { d: -0.05, v: 0.42 }, affinity: { d: -1.5, v: 31.2 }, why: "rude" })), "신뢰 −5 → 42, 호감도 −1.5 → 31 · 거친 말");
  assert.equal(entryText(EN, e("bond", { axis: "respect", d: 2, v: 55 })), "Respect +2 → 55");
  assert.equal(entryText(KO, e("told", { block: "<context>…</context>", turn: 12 })), "12번째 턴에 전해진 맥락");
  assert.equal(entryText(KO, e("said", { text: "흥." })), "흥.");
  assert.equal(entryText(KO, e("heard", { message: "미안" })), "“미안”");
  assert.equal(entryText(KO, e("promise", { what: "저녁에 전화하기", status: "kept" })), "“저녁에 전화하기” · 지킴");
  assert.equal(entryText(KO, e("episode", { kind: "made_up", text: "첫 화해" })), "화해 · 첫 화해");
  assert.equal(entryText(KO, e("episode", { kind: "a_new_kind" })), "a new kind");
  assert.equal(entryText(EN, e("temperament", { by: "persona" })), "Temperament changed · by persona");
  // (something with no words: nothing, and the screen shows it as it came)
  assert.equal(entryText(KO, e("feeling", {})), "");
});

test("the journal: filtered by layer, the next page after the last without one entry twice", () => {
  const a = [{ id: 3, layer: "heard" as const }, { id: 2, layer: "told" as const }];
  const b = [{ id: 2, layer: "told" as const }, { id: 1, layer: "heard" as const }];
  assert.deepEqual(mergeEntries(a, b).map((x) => x.id), [3, 2, 1]);
  assert.deepEqual(filterEntries(mergeEntries(a, b), "heard").map((x) => x.id), [3, 1]);
  assert.equal(filterEntries(a, "all").length, 2);
});

test("every layer, preset and event has words in both languages", () => {
  for (const [lang, t] of Object.entries(LANGS)) {
    for (const l of LAYERS) assert.ok(!t(LAYER_LABEL[l]).includes("gss."), `${lang} layer ${l}`);
    for (const p of PRESETS) assert.ok(!t(`gss.preset_${p}` as never).includes("gss."), `${lang} preset ${p}`);
    for (const ev of EVENTS) {
      const key = ev === "ignored" ? "gss.eventIgnored" : ev === "declined_call" ? "gss.eventDeclinedCall" : "gss.eventPoke";
      assert.ok(!t(key as never).includes("gss."), `${lang} event ${ev}`);
    }
  }
});

test("her temperament: what lights her up as words, only what it can hold, each within its range", () => {
  // (the bundled ones are written as a pattern)
  assert.deepEqual(normalizeLoves("게임|버그|레이드|\\braid\\b|\\bgame|\\bbug"), ["게임", "버그", "레이드", "raid", "game", "bug"]);
  assert.deepEqual(normalizeLoves([" 떡볶이 ", "떡볶이", "", 3, "주식"]), ["떡볶이", "주식"]);
  assert.deepEqual(normalizeLoves(null), []);
  const c = cleanTemperament({ base: { shy: 0.9, nope: 1 }, rise: { angry: 0.1 }, forgives: 3, holds: 1.4, sweet_until: 0.2, conflict: "sulk", attachment: "anxious", loves: "코드|버그", extra: 1 });
  assert.deepEqual(c, { base: { shy: 0.3 }, rise: { angry: 0.5 }, forgives: 1.6, holds: 1.4, sweet_until: 0.2, attachment: "anxious", loves: ["코드", "버그"] });
  assert.equal(knob(c, "settle", "sad"), 1);
  assert.equal(knob(c, "base", "shy"), 0.3);
  assert.equal(knob({}, "sweet_until"), 0.15);
});

test("what is saved as the user's own: theirs already, and what now differs from what is in effect", () => {
  const effective = cleanTemperament({ base: { shy: 0.15 }, rise: { shy: 1.2, excited: 1.3 }, forgives: 0.8, holds: 1.4, loves: ["게임"] });
  const custom = cleanTemperament({ holds: 1.4 });
  assert.ok(isCustom(custom, "holds"));
  assert.ok(!isCustom(custom, "forgives"));
  assert.ok(!isCustom(custom, "rise", "shy"));
  // nothing touched: only what was theirs
  assert.deepEqual(overrideOf(effective, effective, custom), { holds: 1.4 });
  // forgiving and one feeling changed, a love added
  const draft = { ...effective, forgives: 1.1, rise: { ...effective.rise, angry: 1.5 }, loves: ["게임", "레이드"], conflict: "withdraw" as const };
  assert.deepEqual(overrideOf(draft, effective, custom), { rise: { angry: 1.5 }, forgives: 1.1, holds: 1.4, conflict: "withdraw", loves: ["게임", "레이드"] });
  assert.ok(!sameTemperament(draft, effective));
  assert.ok(sameTemperament({ ...effective, rise: { ...effective.rise, sad: 1 } }, effective)); // (1 is what it is anyway)
  assert.ok(sameTemperament(cleanTemperament({ loves: "게임" }), cleanTemperament({ loves: ["게임"] })));
});

test("a simulation as curves: 0 – 100, the grudge either way it comes, the relationship on one scale", () => {
  const p = (minute: number, extra: Partial<GssSimPoint>): GssSimPoint => ({ minute, label: "", feelings: {}, line: "", bonds: {}, ...extra });
  const s = simSeries([
    p(0, { feelings: { angry: 0.1, happy: 0.4 }, grudge: null, bonds: { trust: 0.5, romance: 0.2, respect: 0.6, affinity: 40 } }),
    p(30, { feelings: { angry: 0.75 }, grudge: 0.6, bonds: { trust: 0.42, romance: 0.2, respect: 0.55, affinity: 34.4 } }),
    p(90, { feelings: { angry: 0.5 }, grudge: { v: 0.45, why: {}, hours: 1, sorry: 1, owned: false }, bonds: { trust: 0.44, affinity: 34.4 } }),
  ]);
  assert.deepEqual(s.t, [0, 1800, 5400]);
  assert.deepEqual(s.feelings.angry, [10, 75, 50]);
  assert.deepEqual(s.feelings.happy, [40, 0, 0]);
  assert.deepEqual(s.grudge, [0, 60, 45]);
  assert.deepEqual(s.bonds.trust, [50, 42, 44]);
  assert.deepEqual(s.bonds.romance, [20, 20, null]);
  assert.deepEqual(s.affinity, [40, 34, 34]);
  // (on 0 – 100 already: as they are)
  assert.deepEqual(simSeries([p(0, { bonds: { trust: 62, affinity: 50 } })]).bonds.trust, [62]);
});

test("a model's judgement of her replies: well-formed, every criterion in words, the journal's line", () => {
  for (const [lang, t] of Object.entries(LANGS)) {
    for (const c of CRITERIA) {
      const w = criterionText(t, c);
      assert.ok(w && w !== c && !w.includes("gss."), `${lang} ${c}: ${w}`);
    }
  }
  assert.equal(criterionText(KO, "a_new_one"), "a new one");
  const r = evalReport({
    scores: { variety: 2, persona: 4.5, limits: 9, own_will: "x", tone: 3 },
    overall: 3.75,
    summary: "말투는 캐릭터답지만 같은 지문을 되풀이해요.",
    findings: [{ turn: 4, criterion: "variety", quote: "(한숨을 쉰다)", issue: "같은 지문이 두 번" }, { turn: 5 }, "nope"],
    exchanges: 20,
  })!;
  assert.deepEqual(r.order, ["persona", "variety", "limits", "tone"]);
  assert.deepEqual(r.scores, { variety: 2, persona: 4.5, limits: 5, tone: 3 });
  assert.equal(r.findings.length, 1);
  assert.equal(scoreText(r.overall!), "3.8");
  assert.equal(scoreText(4), "4");
  assert.equal(scoreTone(2), "warn");
  assert.equal(scoreTone(4.5), "ok");
  assert.equal(evalReport({}), null);
  assert.equal(evalReport(null), null);
  assert.equal(evalReport({ error: "no model" })?.error, "no model");
  assert.equal(entryText(KO, { layer: "eval", kind: "judged", data: { overall: 4, summary: "좋아요", scores: { persona: 4 } } }), "전체 4 / 5 · 좋아요");
  assert.equal(entryText(EN, { layer: "eval", kind: "judged", data: { overall: null, error: "timed out", scores: {} } }), "Couldn't evaluate: timed out");
});

test("the simulator's own steps: hours to look in after, steps that say or do something", () => {
  assert.deepEqual(parseHours("24, 1 6,, 6 / x -2 1000"), [1, 6, 24]);
  assert.deepEqual(parseHours(""), []);
  assert.deepEqual(
    cleanSteps([
      { after_min: 0, say: " 죽고 싶어? ", reply: "" },
      { after_min: 2.6, say: "", reply: "" },
      { after_min: -5, say: "미안", event: "ignored" },
      { after_min: 10, reply: "…" },
      { after_min: 5, event: "nope" as never },
    ]),
    [
      { after_min: 0, say: "죽고 싶어?" },
      { after_min: 0, event: "ignored" },
      { after_min: 10, reply: "…" },
    ],
  );
});
