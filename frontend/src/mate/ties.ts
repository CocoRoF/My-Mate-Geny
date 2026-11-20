/**
 * What the two of them are, in her own view (app/mate/gss/ties.py): each label in the user's words, its look, and a change of it
 * in one line. Pure; tested in test/ties.test.ts.
 */
import type { TieBy, TieChange, TieLabel } from "../api/ties";
import type { MsgKey, TFunction } from "../i18n";

export const TIE_LABELS: TieLabel[] = ["stranger", "indifferent", "acquaintance", "friend", "close_friend", "crush", "flirting", "lovers", "ex", "estranged", "rivals", "love_hate", "loathing"];
export const TIE_LABEL = Object.fromEntries(TIE_LABELS.map((l) => [l, `ties.label_${l}`])) as Record<TieLabel, MsgKey>;
export const TIE_DESC = Object.fromEntries(TIE_LABELS.map((l) => [l, `ties.desc_${l}`])) as Record<TieLabel, MsgKey>;
/** how she came to it, in words (as it began: nothing to say) */
export const TIE_BY: Partial<Record<TieBy, MsgKey>> = { moment: "ties.by_moment", night: "ties.by_night", first: "ties.by_first" };
export const TIE_EMOJI: Record<TieLabel, string> = {
  stranger: "❔",
  indifferent: "😶",
  acquaintance: "🙂",
  friend: "😊",
  close_friend: "🫶",
  crush: "💗",
  flirting: "💞",
  lovers: "❤️",
  ex: "💔",
  estranged: "🌫️",
  rivals: "⚡",
  love_hate: "🥀",
  loathing: "🚫",
};

/** how it reads: warm, romantic, sour, against them, or neither */
export type TieTone = "warm" | "romantic" | "sour" | "against" | "neutral";
const TONE: Record<TieLabel, TieTone> = {
  stranger: "neutral",
  indifferent: "neutral",
  acquaintance: "neutral",
  friend: "warm",
  close_friend: "warm",
  crush: "romantic",
  flirting: "romantic",
  lovers: "romantic",
  ex: "sour",
  estranged: "sour",
  rivals: "sour",
  love_hate: "romantic",
  loathing: "against",
};
export const tieTone = (l: TieLabel): TieTone => TONE[l] ?? "neutral";
export const TONE_CLASS: Record<TieTone, string> = {
  warm: "bg-accent-soft text-accent",
  romantic: "bg-violet/15 text-violet",
  sour: "bg-warning/15 text-warning",
  against: "bg-danger/10 text-danger",
  neutral: "bg-content/10 text-content-dim",
};

export const isTie = (x: unknown): x is TieLabel => typeof x === "string" && (TIE_LABELS as string[]).includes(x);
export const tieName = (t: TFunction, l: unknown): string => (isTie(l) ? t(TIE_LABEL[l]) : String(l ?? ""));

/** "친구 → 연인" (from her first view: just what she came to) */
export function tieChangeText(t: TFunction, c: Pick<TieChange, "from" | "to">): string {
  if (!isTie(c.to)) return "";
  return !isTie(c.from) || c.from === "stranger" ? tieName(t, c.to) : t("ties.changed", { from: tieName(t, c.from), to: tieName(t, c.to) });
}

/** a journal entry of hers about it (layer "tie"): what changed, or what stayed and what she felt about it */
export function tieEntryText(t: TFunction, kind: string, d: Record<string, unknown>): string {
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const who = str(d.with_name);
  const head = kind === "changed" ? tieChangeText(t, { from: d.from as TieLabel, to: d.to as TieLabel }) : t("ties.kept", { label: tieName(t, d.to) });
  const words = kind === "changed" ? str(d.why) : str(d.thought);
  return [who ? `${who}: ${head}` : head, words ? `“${words}”` : ""].filter(Boolean).join(" · ");
}
