/** Small pieces of the State tab (StateTab.tsx): a chip in a tone, a bar, a time before or after now, a box of exact text. */
import { createContext, useContext, type ReactNode } from "react";
import { useT } from "../../../../i18n";
import { fmtDateTime } from "../../../../i18n/format";
import { whenText, type Tone } from "../../../../mate/gss";

/** the tab's clock: relative times move on without a refetch */
export const NowContext = createContext<number>(Date.now());

const TONE: Record<Tone, string> = {
  ok: "bg-success/15 text-success",
  warn: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  accent: "bg-accent-soft text-accent",
  muted: "bg-surface-3 text-content-faint",
};

export function ToneChip({ tone, children, title, testId }: { tone: Tone; children: ReactNode; title?: string; testId?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10.5px] ${TONE[tone]}`} title={title} data-testid={testId}>
      {children}
    </span>
  );
}

/** a value as a bar (0 – 1) */
export function Meter({ ratio, color, label }: { ratio: number; color?: string; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  return (
    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span className={`block h-full rounded-full transition-[width] duration-700 ${color ? "" : "bg-accent"}`} style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}

/** "3분 전" / "3시간 후", the exact time on hover */
export function When({ at, className = "" }: { at: string; className?: string }) {
  const t = useT();
  const now = useContext(NowContext);
  const ok = Number.isFinite(Date.parse(at));
  return (
    <time dateTime={at} title={ok ? fmtDateTime(at) : undefined} className={`tabular-nums ${className}`}>
      {whenText(t, at, now)}
    </time>
  );
}

/** text exactly as it is (what she is told) */
export function Exact({ text, className = "", testId }: { text: string; className?: string; testId?: string }) {
  return (
    <pre className={`overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface px-2.5 py-2 font-mono text-[11px] leading-relaxed text-content-faint ${className}`} data-testid={testId}>
      {text}
    </pre>
  );
}
