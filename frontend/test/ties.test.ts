// What the two of them are, in her own view (frontend/src/mate/ties.ts): every label named and described in both languages,
// a change of it in one line, her journal entries about it — never a key or a code shown as words.
// Run: npm run test:unit
import assert from "node:assert/strict";
import test from "node:test";
import en from "../src/i18n/en/index.ts";
import ko from "../src/i18n/ko/index.ts";
import { fillPlaceholders } from "../src/lib/josa.ts";
import type { TFunction } from "../src/i18n";
import { entryText, LAYER_LABEL, LAYERS } from "../src/mate/gss";
import { isTie, TIE_BY, TIE_DESC, TIE_EMOJI, TIE_LABEL, TIE_LABELS, tieChangeText, tieEntryText, tieName, tieTone } from "../src/mate/ties";

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

test("every label has a name, a description, a look and a tone, in both languages", () => {
  assert.equal(TIE_LABELS.length, 13);
  for (const [lang, t] of [["ko", KO], ["en", EN]] as const) {
    for (const l of TIE_LABELS) {
      assert.ok(!t(TIE_LABEL[l]).startsWith("ties."), `${lang} ${l} name`);
      assert.ok(!t(TIE_DESC[l]).startsWith("ties."), `${lang} ${l} description`);
      assert.ok(TIE_EMOJI[l], `${l} emoji`);
    }
    for (const by of ["moment", "night", "first"] as const) assert.ok(!t(TIE_BY[by]!).startsWith("ties."), `${lang} ${by}`);
    assert.equal(TIE_BY.start, undefined);
  }
  assert.equal(tieName(KO, "rivals"), "앙숙");
  assert.equal(tieName(KO, "love_hate"), "애증");
  assert.equal(tieName(KO, "loathing"), "혐오");
  assert.equal(tieName(EN, "close_friend"), "Best friends");
  assert.equal(tieTone("lovers"), "romantic");
  assert.equal(tieTone("friend"), "warm");
  assert.equal(tieTone("loathing"), "against");
  assert.ok(isTie("ex") && !isTie("soulmate") && !isTie(undefined));
});

test("a change in one line; her first view is just what she came to", () => {
  assert.equal(tieChangeText(KO, { from: "friend", to: "lovers" }), "친구 → 연인");
  assert.equal(tieChangeText(KO, { from: "stranger", to: "acquaintance" }), "지인");
  assert.equal(tieChangeText(EN, { from: "lovers", to: "ex" }), "Lovers → Exes");
});

test("her journal: what changed with her words, what stayed with what she felt, about whom", () => {
  assert.ok(LAYERS.includes("tie") && !KO(LAYER_LABEL.tie).startsWith("gss."));
  const changed = entryText(KO, { layer: "tie", kind: "changed", data: { from: "flirting", to: "lovers", why: "사귀기로 했어.", with: "user" } });
  assert.equal(changed, "썸 → 연인 · “사귀기로 했어.”");
  const kept = entryText(KO, { layer: "tie", kind: "kept", data: { from: "lovers", to: "lovers", thought: "요즘 좀 서운해.", why: "x" } });
  assert.equal(kept, "여전히 연인 · “요즘 좀 서운해.”");
  const mate = tieEntryText(EN, "changed", { from: "acquaintance", to: "rivals", why: "", with_name: "Seoa" });
  assert.equal(mate, "Seoa: Acquaintances → Rivals");
});
