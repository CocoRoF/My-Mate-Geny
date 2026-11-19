import { useState } from "react";
import { useI18n } from "../../i18n";
import { clockTime, dayKey, dayLabel, fullDateTime } from "../../lib/messageTime";
import { useUserTimezone } from "../../lib/userTimezone";

/**
 * When a message was said, under or beside it (a chat's and a mate's — lib/messageTime.ts): its clock time ("오후
 * 10:41"); the whole date and time on hover (the tooltip) and on a tap or a click (in place, until tapped again — a
 * phone has no hover). The user's timezone.
 */
export function MessageTime({ at, className = "", testId = "message-time" }: { at?: number; className?: string; testId?: string }) {
  const lang = useI18n((s) => s.lang);
  const tz = useUserTimezone();
  const [full, setFull] = useState(false);
  if (at === undefined || !Number.isFinite(at)) return null;
  const whole = fullDateTime(at, lang, tz);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation(); // (a mate's bubble toggles its actions on a tap: not this one)
        setFull((v) => !v);
      }}
      title={whole}
      aria-label={whole}
      aria-expanded={full}
      className={`shrink-0 whitespace-nowrap rounded px-0.5 text-[10.5px] leading-4 tabular-nums text-content-faint transition hover:text-content-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${className}`}
      data-testid={testId}
    >
      <time dateTime={new Date(at).toISOString()}>{full ? whole : clockTime(at, lang, tz)}</time>
    </button>
  );
}

/** Where the day changes in a conversation: "2026년 11월 19일 목요일" between two lines (as the notices are drawn). */
export function DayDivider({ at, compact = false }: { at: number; compact?: boolean }) {
  const lang = useI18n((s) => s.lang);
  const tz = useUserTimezone();
  const label = dayLabel(at, lang, tz);
  return (
    <div
      role="separator"
      aria-label={label}
      className={`flex select-none items-center gap-3 text-content-faint ${compact ? "py-0.5 text-[10.5px]" : "py-1 text-[11.5px]"}`}
      data-testid="day-divider"
    >
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 rounded-full border border-border/70 bg-surface-2/70 px-2.5 py-0.5 font-medium">
        <time dateTime={dayKey(at, tz)}>{label}</time>
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
