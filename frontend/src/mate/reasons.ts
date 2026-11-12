/**
 * Reasons in the user's language (docs/mate-memory-affinity.md §5–6): why the relationship changed (a code of her affinity log)
 * and why she feels what she feels (a code of her state, or her own words). A code with no words of its own never shows as
 * the code: a change reads as "another change", a feeling as nothing.
 */
import type { StateWhy } from "../api/mates";
import type { MsgKey, TFunction } from "../i18n";

/** what was done to her (affinity.hostile), by its kind; an entry from before kinds were logged reads as the general one */
const HOSTILE: Record<string, MsgKey> = {
  violence: "mateSettings.relWhyHostileViolence",
  coercion: "mateSettings.relWhyHostileCoercion",
  threat: "mateSettings.relWhyHostileThreat",
  demeaning: "mateSettings.relWhyHostileDemeaning",
};

const WHY: Record<string, MsgKey> = {
  talk: "mateSettings.relWhyTalk",
  lively: "mateSettings.relWhyLively",
  streak: "mateSettings.relWhyStreak",
  streak_week: "mateSettings.relWhyStreakWeek",
  warm: "mateSettings.relWhyWarm",
  smiled: "mateSettings.relWhySmiled",
  gift: "mateSettings.relWhyGift",
  memory: "mateSettings.relWhyMemory",
  rude: "mateSettings.relWhyRude",
  hostile: "mateSettings.relWhyHostile",
  manual: "mateSettings.relWhyManual",
  reset: "mateSettings.relWhyReset",
  recomputed: "mateSettings.relWhyRecomputed",
  paused_on: "mateSettings.relWhyPausedOn",
  paused_off: "mateSettings.relWhyPausedOff",
  enabled_on: "mateSettings.relWhyEnabledOn",
  enabled_off: "mateSettings.relWhyEnabledOff",
};

/** a log reason code → words */
export function whyText(t: TFunction, why: string): string {
  const quiet = /^quiet_(\d+)$/.exec(why);
  if (quiet) return t("mateSettings.relWhyQuiet", { days: Number(quiet[1]) });
  const anniversary = /^anniversary_(\d+)$/.exec(why); // (talking on their 7th, 30th … day together)
  if (anniversary) return t("mateSettings.relWhyAnniversary", { days: Number(anniversary[1]) });
  if (why.startsWith("timezone ")) return t("mateSettings.relWhyTimezone"); // (the days counted again in the user's zone)
  if (why.startsWith("hostile_")) return t(HOSTILE[why.slice(8)] ?? WHY.hostile);
  return t(WHY[why] ?? "mateSettings.relWhyOther");
}

/** why she feels it: her own words, or what happened in the user's language */
export function stateWhy(t: TFunction, why?: StateWhy | null): string {
  if (why?.text) return why.text;
  if (!why?.code) return "";
  const vars = { name: why.name ?? "", quote: why.quote ?? "" };
  // (what was done to her: by its kind when the words told one)
  const keys = why.code === "hostile" && why.kind ? [`mate.stateWhy_hostile_${why.kind}`, "mate.stateWhy_hostile"] : [`mate.stateWhy_${why.code}`];
  for (const key of keys) {
    const s = t(key as MsgKey, vars);
    if (s !== key) return s;
  }
  return "";
}
