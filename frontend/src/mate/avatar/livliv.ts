/** What a LivLiv body decides without the player (avatar/LivLivBody.tsx): which expression an emotion plays, and the mouth's
 * shape for the character being said. Kept apart so it can be tested without WebGL. */
import { emotionCandidates } from "../emotion";
import type { LivLiv } from "../types";

/** the mouth's shape for a character being said: -1 round (ㅗ ㅜ o u), +1 wide (ㅣ ㅔ i e), 0 open */
export function vowelOf(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0xac00 && c <= 0xd7a3) {
    const v = Math.floor(((c - 0xac00) % 588) / 28); // 중성 (medial vowel), 0..20
    if ([8, 9, 10, 11, 12, 13, 14, 15, 16, 17].includes(v)) return -1; // ㅗ ㅘ ㅙ ㅚ ㅛ ㅜ ㅝ ㅞ ㅟ ㅠ
    if (v === 18) return 0.4; // ㅡ: unrounded, a little wide
    if ([1, 3, 5, 7, 19, 20].includes(v)) return 1; // ㅐ ㅒ ㅔ ㅖ ㅢ ㅣ
    return 0; // ㅏ ㅑ ㅓ ㅕ
  }
  const l = ch.toLowerCase();
  if ("ouw".includes(l)) return -1;
  if ("iey".includes(l)) return 1;
  return 0;
}

/** the expression this model plays for an emotion: the user's choice, else a standard id of that name or a near one */
export function expressionFor(lv: LivLiv, have: string[], emotion: string): string | null {
  const chosen = lv.emotions?.[emotion];
  if (chosen !== undefined) return chosen && have.includes(chosen) ? chosen : null;
  return emotionCandidates(emotion).find((c) => have.includes(c)) ?? null;
}
