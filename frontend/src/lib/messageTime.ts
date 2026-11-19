/**
 * When each message of a conversation was said — a chat's and a mate's (components/chat/MessageTime.tsx): its clock
 * time ("오후 10:41"), the whole date and time on hover / tap, and a divider where the day changes ("2026년 11월 19일
 * 목요일"). In the user's timezone (Settings → 언어 → 시간대, lib/userTimezone.ts; this device's when none is set),
 * from the times the server stored — older messages included. Pure: no React, no store.
 */
import type { Turn } from "../stores/chatStore";

export type TimeLang = "ko" | "en";

const LOCALE: Record<TimeLang, string> = { ko: "ko-KR", en: "en-US" };
const cache = new Map<string, Intl.DateTimeFormat>();

/** a valid IANA zone: `tz` itself, else this device's, else UTC (a typo in the setting never breaks a chat) */
export function safeZone(tz: string | undefined | null): string {
  for (const z of [tz, deviceZone()]) {
    if (!z) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: z });
      return z;
    } catch {
      /* not a zone */
    }
  }
  return "UTC";
}

export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

function fmt(kind: "clock" | "full" | "day" | "key", lang: TimeLang, tz: string): Intl.DateTimeFormat {
  const zone = safeZone(tz);
  const id = `${kind}|${lang}|${zone}`;
  let f = cache.get(id);
  if (!f) {
    const base = { timeZone: zone };
    f =
      kind === "clock"
        ? new Intl.DateTimeFormat(LOCALE[lang], { ...base, hour: "numeric", minute: "2-digit" })
        : kind === "full"
          ? new Intl.DateTimeFormat(LOCALE[lang], {
              ...base, year: "numeric", month: "long", day: "numeric", weekday: "long",
              hour: "numeric", minute: "2-digit", second: "2-digit",
            })
          : kind === "day"
            ? new Intl.DateTimeFormat(LOCALE[lang], { ...base, year: "numeric", month: "long", day: "numeric", weekday: "long" })
            : new Intl.DateTimeFormat("en-CA", { ...base, year: "numeric", month: "2-digit", day: "2-digit" });
    cache.set(id, f);
  }
  return f;
}

/** "오후 10:41" / "10:41 PM" */
export const clockTime = (ms: number, lang: TimeLang, tz: string) => fmt("clock", lang, tz).format(ms);

/** "2026년 11월 19일 목요일 오후 10:41:05" / "Thursday, November 19, 2026 at 10:41:05 PM" */
export const fullDateTime = (ms: number, lang: TimeLang, tz: string) => fmt("full", lang, tz).format(ms);

/** the day divider's words: "2026년 11월 19일 목요일" / "Thursday, November 19, 2026" */
export const dayLabel = (ms: number, lang: TimeLang, tz: string) => fmt("day", lang, tz).format(ms);

/** which day it is there ("2026-11-19"): where the dividers go */
export const dayKey = (ms: number, tz: string) => fmt("key", "en", tz).format(ms);

/** A server timestamp (ISO) → ms; undefined when there is none (or it isn't one). */
export function parseTime(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** When a turn was said: the user's message when it was sent, a reply when it came (its end; while it is still
 * coming, its start). Undefined: not known (it doesn't move the day). */
export function turnTime(t: Pick<Turn, "role" | "at" | "startedAt" | "endedAt">): number | undefined {
  if (t.role === "assistant") return t.endedAt ?? t.startedAt;
  return t.at;
}

/**
 * The turns a day divider goes before (their keys → the divider's time): the first one with a time, and each one
 * whose day (in `tz`) isn't the day of the last one before it with a time. `shown(t)`: whether the turn is drawn at
 * all (a divider over nothing is left out; it goes before the next drawn one of that day).
 */
export function dayBreaks(
  turns: readonly Turn[],
  tz: string,
  shown: (t: Turn) => boolean = () => true,
): Map<string, number> {
  const out = new Map<string, number>();
  let day: string | null = null;
  let pending: number | undefined; // a new day began on a turn not drawn: the next drawn one carries it
  for (const t of turns) {
    const at = turnTime(t);
    if (at !== undefined) {
      const k = dayKey(at, tz);
      if (k !== day) {
        day = k;
        pending = at;
      }
    }
    if (pending !== undefined && shown(t)) {
      out.set(t.key, pending);
      pending = undefined;
    }
  }
  return out;
}
