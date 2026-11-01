// Time and number formatting used across the app — in the UI's language (i18n/format.ts).
import { fmtDateTime, fmtDuration, fmtNum, relTime as relTimeI18n } from "../../i18n/format";

/** "5m ago" / "5분 전" */
export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return iso;
  return relTimeI18n(t);
}

export const absTime = (iso: string) => fmtDateTime(iso);

/** a span of seconds, two units: "2d 3h", "4h 5m", "6m 7s", "8s" */
export function duration(sec: number): string {
  return fmtDuration(sec);
}

export const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}K` : fmtNum(n);
