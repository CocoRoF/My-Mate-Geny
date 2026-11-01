/**
 * Korean particles (josa) that follow the word before them: 이/가, 은/는, 을/를, 과/와, 아/야, 이랑/랑, 이에요/예요, (으)로.
 * The same algorithm as backend/app/mate/josa.py; both are tested against test/fixtures/josa-cases.json.
 *
 * The last pronounced character decides (trailing spaces, quotes, brackets and ~!?.,… are skipped): a Hangul
 * syllable by its final consonant (ㄹ: (으)로 → 로), a digit by its Korean reading, a Latin word by its last letter
 * (l → ㄹ, m / n / ng → final consonant). Anything else → the written-out fallback ("이(가)").
 */

export type Sound = "none" | "batchim" | "rieul";

const SKIP = new Set(Array.from(" \t\n\"'“”‘’「」『』()[]{}<>~!?.,…·-_"));
// 0 영 1 일 2 이 3 삼 4 사 5 오 6 육 7 칠 8 팔 9 구
const DIGITS: Record<string, Sound> = { "0": "batchim", "1": "rieul", "2": "none", "3": "batchim", "4": "none", "5": "none", "6": "batchim", "7": "rieul", "8": "rieul", "9": "none" };
const PAIRS: Record<string, [string, string, string]> = {};
for (const [a, b, fb] of [
  ["이", "가", "이(가)"],
  ["은", "는", "은(는)"],
  ["을", "를", "을(를)"],
  ["과", "와", "과(와)"],
  ["아", "야", ""],
  ["이랑", "랑", "(이)랑"],
  ["이에요", "예요", "(이)에요"],
  ["으로", "로", "(으)로"],
] as const) {
  PAIRS[a] = PAIRS[b] = [a, b, fb];
}
PAIRS["(으)로"] = PAIRS["으로"];

export const isHangul = (ch: string) => ch >= "가" && ch <= "힣";

/** how the word ends: no final consonant, a final consonant, ㄹ — or null (can't tell) */
export function finalSound(word: string): Sound | null {
  const s = Array.from((word ?? "").trimEnd());
  let i = s.length - 1;
  while (i >= 0 && SKIP.has(s[i])) i--;
  if (i < 0) return null;
  const ch = s[i];
  if (isHangul(ch)) {
    const jong = (ch.charCodeAt(0) - 0xac00) % 28;
    return jong === 0 ? "none" : jong === 8 ? "rieul" : "batchim";
  }
  if (ch in DIGITS) return DIGITS[ch];
  if (/^[A-Za-z]$/.test(ch)) {
    let j = i;
    while (j >= 0 && /^[A-Za-z]$/.test(s[j])) j--;
    const w = s.slice(j + 1, i + 1).join("").toLowerCase();
    if (w.endsWith("ng") || /[mn]$/.test(w)) return "batchim";
    if (w.endsWith("l")) return "rieul";
    return "none";
  }
  return null;
}

/** just the particle for `word` (particle("현석", "이") === "이") */
export function particle(word: string, p: string): string {
  const pair = PAIRS[p];
  if (!pair) return p;
  const [withB, withoutB, fallback] = pair;
  const snd = finalSound(word);
  if (snd === null) return fallback;
  if (withB === "으로") return snd === "none" || snd === "rieul" ? "로" : "으로";
  return snd === "none" ? withoutB : withB;
}

/** `word` + its particle (josa("현석", "을") === "현석을") */
export const josa = (word: string, p: string) => `${word}${particle(word, p)}`;

/** a plain Korean personal name without a title (현석, 지수) */
export function isBareKoreanName(address: string, userName: string): boolean {
  const a = (address ?? "").trim();
  const chars = Array.from(a);
  return !!a && a === (userName ?? "").trim() && chars.length <= 5 && chars.every(isHangul) && !a.endsWith("님");
}

/** a message placeholder: `{name}` or `{name:이}` (the value followed by the particle that fits it) */
export const PLACEHOLDER = /\{(\w+)(?::([^{}\s]+))?\}/g;

/**
 * Fill a message's placeholders (src/i18n `translate`): `value(name)` gives a var's text (undefined: left as written);
 * with `korean`, `{name:이}` adds the particle that fits the value (English messages never carry one; ignored anyway).
 */
export function fillPlaceholders(s: string, value: (name: string) => string | undefined, korean: boolean): string {
  return s.replace(PLACEHOLDER, (all, name: string, p?: string) => {
    const v = value(name);
    if (v === undefined) return all;
    return p && korean ? v + particle(v, p) : v;
  });
}

export interface AddressForms {
  subject: string;
  topic: string;
  object: string;
  with: string;
  call: string;
  to?: string;
}

/**
 * The forms of how the mate calls the user. `casual` (반말 + a bare Korean name): the friendly -이 before particles
 * after a final consonant (현석이가 / 현석이는) and 아/야 when calling (현석아, 지수야); otherwise the plain particles
 * on the address and the address itself when calling (+ 께 after 님).
 */
export function addressForms(address: string, casual: boolean): AddressForms | null {
  const a = (address ?? "").trim();
  if (!a) return null;
  if (casual) {
    const snd = finalSound(a);
    const stem = a + (snd === "batchim" || snd === "rieul" ? "이" : "");
    return { subject: josa(stem, "가"), topic: josa(stem, "는"), object: josa(stem, "를"), with: josa(stem, "랑"), call: josa(a, "아") };
  }
  const out: AddressForms = { subject: josa(a, "이"), topic: josa(a, "은"), object: josa(a, "을"), with: josa(a, "과"), call: a };
  if (a.endsWith("님")) out.to = `${a}께`;
  return out;
}
