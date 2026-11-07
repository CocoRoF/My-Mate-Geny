/** Her needs as the UI shows them: words and a bar, never the numbers (docs/mate-life.md). */
import type { IconName } from "../../ui/Icon";
import type { LifeNames, LifeNeed, LifeStat } from "../../../api/mates";
import type { MsgKey } from "../../../i18n";

export const NEEDS: { need: LifeNeed; icon: IconName; label: MsgKey; words: [MsgKey, MsgKey, MsgKey, MsgKey] }[] = [
  { need: "hunger", icon: "utensils", label: "life.needHunger", words: ["life.hunger0", "life.hunger1", "life.hunger2", "life.hunger3"] },
  { need: "sleep", icon: "moon", label: "life.needSleep", words: ["life.sleep0", "life.sleep1", "life.sleep2", "life.sleep3"] },
  { need: "affection", icon: "heart", label: "life.needAffection", words: ["life.affection0", "life.affection1", "life.affection2", "life.affection3"] },
  { need: "fun", icon: "gamepad", label: "life.needFun", words: ["life.fun0", "life.fun1", "life.fun2", "life.fun3"] },
  { need: "stress", icon: "bolt", label: "life.needStress", words: ["life.stress0", "life.stress1", "life.stress2", "life.stress3"] },
];

export const STATS: { stat: LifeStat; icon: IconName; label: MsgKey }[] = [
  { stat: "work", icon: "terminal", label: "life.statWork" },
  { stat: "gaming", icon: "gamepad", label: "life.statGaming" },
  { stat: "stamina", icon: "bolt", label: "life.statStamina" },
  { stat: "cooking", icon: "utensils", label: "life.statCooking" },
  { stat: "sense", icon: "sparkles", label: "life.statSense" },
  { stat: "courage", icon: "heart", label: "life.statCourage" },
];

/** how badly: 0 fine, 1 a little, 2 quite, 3 badly (the same steps she is told: app/mate/life/sim.py) */
export const needStep = (v: number): 0 | 1 | 2 | 3 => (v >= 0.75 ? 3 : v >= 0.5 ? 2 : v >= 0.3 ? 1 : 0);

/** the colour of a need's bar */
export const needTone = (v: number): string => ["bg-success", "bg-cyan", "bg-warning", "bg-danger"][needStep(v)];

/** a bundled name in the UI's language */
export const lifeName = (names: LifeNames | undefined, locale: string, fallback = ""): string =>
  (locale === "ko" ? names?.ko || names?.en : names?.en || names?.ko) || fallback;
