/**
 * The Relationship panel's pure parts (components/mate/RelationPanel.tsx): the change filters, the journal grouped by
 * day, the chart's summary (its text alternative), the next anniversary. Tested in test/relation-journal.test.ts.
 */
import type { MoodLabel, RelationChange, RelationJournal } from "../api/mates";

export type ChangeFilter = "all" | "gain" | "loss" | "stage" | "manual";
export const CHANGE_FILTERS: ChangeFilter[] = ["all", "gain", "loss", "stage", "manual"];

/** a small picture for her mood, next to its word */
export const MOOD_EMOJI: Record<MoodLabel, string> = {
  cheerful: "😄",
  content: "😊",
  calm: "😌",
  focused: "🧐",
  sleepy: "😴",
  concerned: "😟",
};

export function filterChanges(changes: RelationChange[], f: ChangeFilter): RelationChange[] {
  return f === "all" ? changes : changes.filter((c) => c.kind === f);
}

/** `YYYY-MM-DD` of a time in this device's zone */
export function localDay(at: string | number | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** newest day first, the order within a day kept (the server sends newest first) */
export function groupByDay(changes: RelationChange[]): { day: string; items: RelationChange[] }[] {
  const out: { day: string; items: RelationChange[] }[] = [];
  for (const c of changes) {
    const day = localDay(c.at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(c);
    else out.push({ day, items: [c] });
  }
  return out;
}

/** the daily values in numbers, for the chart's text alternative; null: no day with a value */
export function chartSummary(series: RelationJournal["series"]): { from: number; to: number; max: number; min: number; talked: number } | null {
  const vs = series.map((x) => x.v).filter((v): v is number => v !== null);
  if (!vs.length) return null;
  return {
    from: Math.round(vs[0]),
    to: Math.round(vs[vs.length - 1]),
    max: Math.round(Math.max(...vs)),
    min: Math.round(Math.min(...vs)),
    talked: series.filter((x) => x.talks > 0).length,
  };
}

export function nextAnniversary(anns: RelationJournal["anniversaries"]): RelationJournal["anniversaries"][number] | null {
  return anns.find((a) => !a.reached) ?? null;
}

/** a delta as the log shows it: "+6.0", "−4.0" (a real minus sign), "·" for none */
export function deltaText(d: number): string {
  if (!d) return "·";
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`;
}
