/**
 * Dates, times, numbers and short durations in the UI's language (Intl with "en-US" / "ko-KR"). Called while a
 * component renders: that component must use `useT()` (or `useLang()`) so it re-renders when the language changes.
 */
import { currentLocale, tr } from ".";

type D = Date | string | number;
const toDate = (d: D) => (d instanceof Date ? d : new Date(d));

export const fmtNum = (n: number, opts?: Intl.NumberFormatOptions) => n.toLocaleString(currentLocale(), opts);

/** "Nov 1, 2026, 14:05" / "2026. 11. 1. 오후 2:05" */
export const fmtDateTime = (d: D, opts?: Intl.DateTimeFormatOptions) => toDate(d).toLocaleString(currentLocale(), opts);
export const fmtDate = (d: D, opts?: Intl.DateTimeFormatOptions) => toDate(d).toLocaleDateString(currentLocale(), opts);
/** "14:05" (24 h in both languages, like the rest of the console) */
export const fmtTime = (d: D, opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) =>
  toDate(d).toLocaleTimeString(currentLocale(), opts);
/** "Thu" / "목" */
export const fmtWeekday = (d: D) => toDate(d).toLocaleDateString(currentLocale(), { weekday: "short" });

/** "just now", "5m ago", "3h ago", "2d ago" / "방금", "5분 전" … (an ISO string or ms) */
export function relTime(when: string | number): string {
  const t = typeof when === "number" ? when : Date.parse(when);
  if (!t) return String(when);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return tr("common.justNow");
  if (s < 60) return tr("common.secondsAgo", { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return tr("common.minutesAgo", { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return tr("common.hoursAgo", { n: h });
  return tr("common.daysAgo", { n: Math.round(h / 24) });
}

/** a span of seconds, two units: "2d 3h", "4h 5m", "6m 7s", "8s" / "2일 3시간" … */
export function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return tr("common.durDH", { d, h });
  if (h) return tr("common.durHM", { h, m });
  if (m) return tr("common.durMS", { m, s: sec % 60 });
  return tr("common.durS", { s: sec });
}
