// Korean particles (src/lib/josa.ts): the cases shared with the backend (test/fixtures/josa-cases.json, also read by
// backend/tests/test_mate_josa.py), `{name:이}` placeholders, and the emotion level's gating (src/mate/emotion.ts).
//   Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addressForms, fillPlaceholders, finalSound, isBareKoreanName, josa, particle } from "../src/lib/josa.ts";
import { reactsAt, voiceEmotionAt } from "../src/mate/emotion.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(fs.readFileSync(path.join(here, "fixtures/josa-cases.json"), "utf-8")) as {
  josa: [string, string, string][];
  forms: [string, boolean, Record<string, string>][];
};

test("josa: the shared cases", () => {
  for (const [word, p, expected] of CASES.josa) assert.equal(josa(word, p), expected, `${word} + ${p}`);
});

test("address forms: the shared cases", () => {
  for (const [address, casual, expected] of CASES.forms) assert.deepEqual({ ...addressForms(address, casual) }, expected, address);
  assert.equal(addressForms("  ", false), null);
});

test("final sounds and bare names", () => {
  assert.equal(finalSound("현석"), "batchim");
  assert.equal(finalSound("서울"), "rieul");
  assert.equal(finalSound("지수"), "none");
  assert.equal(finalSound(""), null);
  assert.equal(particle("x", "까지"), "까지");
  assert.ok(isBareKoreanName("현석", "현석"));
  assert.ok(!isBareKoreanName("현석님", "현석"));
  assert.ok(!isBareKoreanName("Sam", "Sam"));
});

test("{name:이} placeholders pick the particle in Korean only", () => {
  const v = (vars: Record<string, string>) => (n: string) => vars[n];
  assert.equal(fillPlaceholders("{name:이} 답하는 중", v({ name: "한채린" }), true), "한채린이 답하는 중");
  assert.equal(fillPlaceholders("{name:이} 답하는 중", v({ name: "Geny" }), true), "Geny가 답하는 중");
  assert.equal(fillPlaceholders("{name:은} {n}개", v({ name: "세아", n: "3" }), true), "세아는 3개");
  assert.equal(fillPlaceholders("{name:을} 가져왔어요", v({ name: "Estelle" }), true), "Estelle를 가져왔어요");
  assert.equal(fillPlaceholders("{name:이} {missing}", v({ name: "현석" }), true), "현석이 {missing}");
  assert.equal(fillPlaceholders("{name} is typing", v({ name: "Geny" }), false), "Geny is typing");
  assert.equal(fillPlaceholders("{name:이}", v({ name: "Geny" }), false), "Geny");
});

test("emotion level: which tags move the avatar and colour the voice", () => {
  // 0 off: never; 1 subtle: a clear feeling once per reply; 2/3: every tag
  assert.equal(reactsAt(0, 1, 0), false);
  assert.equal(reactsAt(1, 0.3, 0), false);
  assert.equal(reactsAt(1, 0.9, 0), true);
  assert.equal(reactsAt(1, 0.9, 1), false);
  assert.equal(reactsAt(2, 0.1, 5), true);
  assert.equal(reactsAt(3, 0.1, 5), true);
  assert.equal(voiceEmotionAt(0, "joy"), undefined);
  assert.equal(voiceEmotionAt(1, "joy"), "joy");
  assert.equal(voiceEmotionAt(2, null), undefined);
});
