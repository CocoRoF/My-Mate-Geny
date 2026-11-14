// Reasons in the user's language (frontend/src/mate/reasons.ts): every code the backend writes in her affinity log reads as words
// in both languages, what was done to her by its kind, and a code with no words never shows as itself
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import en from "../src/i18n/en/index.ts";
import ko from "../src/i18n/ko/index.ts";
import { fillPlaceholders } from "../src/lib/josa.ts";
import type { TFunction } from "../src/i18n";
import { stateWhy, whyText } from "../src/mate/reasons";

const tOf = (cat: Record<string, Record<string, unknown>>) =>
  ((key: string, vars?: Record<string, string | number>) => {
    const [ns, k] = key.split(".");
    const m = cat[ns]?.[k];
    if (m === undefined) return key;
    const s = typeof m === "string" ? m : (m as { other: string }).other;
    return vars ? fillPlaceholders(s, (n) => (n in vars ? String(vars[n]) : undefined), false) : s;
  }) as unknown as TFunction;
const LANGS = { ko: tOf(ko as never), en: tOf(en as never) };

// (what the backend writes: read from its source, so a new reason without words fails here)
const backend = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../backend/app/mate");
const affinity = fs.readFileSync(path.join(backend, "affinity.py"), "utf8");
const kinds = /What was done to her in this message, as far as the words tell: ([a-z |]+) \(/.exec(affinity)![1].split(" | ");
const codes = [
  ...[...affinity.matchAll(/_(?:gain|bump)\([^)\n]*?"([a-z_]+)"/g)].map((m) => m[1]),
  ...[.../USER_WHYS = \(([^)]*)\)/.exec(affinity)![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
  // (what else she minded: each a code of its own)
  ...[.../LOSSES = \{([^}]*)\}/.exec(affinity)![1].matchAll(/"([a-z_]+)": \(/g)].map((m) => m[1]),
  ...kinds.map((k) => `hostile_${k}`),
  "hostile", // (logged before its kind was)
  "quiet_4",
  "anniversary_30",
  "timezone UTC → Asia/Seoul",
];

test("every reason in her affinity log reads as words, in both languages", () => {
  assert.ok(codes.includes("talk") && codes.includes("rude") && codes.includes("manual") && kinds.length === 4, codes.join(" "));
  for (const [lang, t] of Object.entries(LANGS)) {
    const other = t("mateSettings.relWhyOther");
    for (const code of codes) {
      const s = whyText(t, code);
      assert.ok(s && s !== code && s !== other && !s.includes("mateSettings."), `${lang} ${code}: ${s}`);
    }
  }
  const ko_ = LANGS.ko;
  assert.equal(whyText(ko_, "hostile_violence"), "폭력을 씀");
  assert.equal(whyText(ko_, "hostile_coercion"), "억지로 강요함");
  assert.equal(whyText(ko_, "hostile"), "함부로 대함");
  assert.equal(whyText(ko_, "hostile_something_new"), "함부로 대함");
  assert.equal(whyText(ko_, "quiet_4"), "4일째 대화 없음");
  assert.equal(whyText(ko_, "anniversary_100"), "함께한 지 100일");
  assert.ok(codes.includes("smiled") && codes.includes("gift"), codes.join(" "));
  assert.ok(codes.includes("dismissed") && codes.includes("declined_call"), codes.join(" "));
  assert.equal(whyText(ko_, "ignored"), "말을 걸어도 대답 없음");
  assert.equal(whyText(ko_, "a_code_from_later"), "그 밖의 변화");
});

test("why she feels it: what was done to her by its kind, and a code with no words is no reason shown", () => {
  for (const [lang, t] of Object.entries(LANGS)) {
    const general = stateWhy(t, { code: "hostile" });
    assert.ok(general && !general.includes("stateWhy"), `${lang}: ${general}`);
    for (const kind of kinds) {
      const s = stateWhy(t, { code: "hostile", kind, quote: "(때린다)" });
      assert.ok(s && s !== general && !s.includes("stateWhy"), `${lang} ${kind}: ${s}`);
    }
  }
  const t = LANGS.ko;
  assert.equal(stateWhy(t, { code: "hostile", kind: "threat" }), "위협을 받아서");
  assert.equal(stateWhy(t, { code: "hostile", kind: "something_new" }), "함부로 대해서");
  assert.equal(stateWhy(t, { code: "rude" }), "거친 말을 들어서");
  assert.equal(stateWhy(t, { code: "said", quote: "안녕" }), "“안녕” 라는 말을 듣고");
  assert.equal(stateWhy(t, { text: "비가 와서" }), "비가 와서");
  // (her off day: a neutral word for it, never why)
  assert.equal(stateWhy(t, { code: "off_day" }), "왠지 기분이 안 좋은 날");
  assert.equal(stateWhy(LANGS.en, { code: "off_day" }), "Just an off day");
  assert.equal(stateWhy(t, { code: "a_code_from_later" }), "");
  assert.equal(stateWhy(t, null), "");
});
