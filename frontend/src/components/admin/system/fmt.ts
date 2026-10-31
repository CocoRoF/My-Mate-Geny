// Number formatting + chart colors for the System tab.

// Categorical slots, fixed order (validated for the dark surface #161a22:
// adjacent CVD ΔE >= 8.4, normal-vision ΔE >= 19.8, all >= 3:1 contrast).
export const C1 = "#3987e5"; // blue
export const C2 = "#d95926"; // orange
export const C3 = "#199e70"; // aqua
export const C4 = "#c98500"; // yellow
// Status (reserved: never a series color; always with an icon + label).
export const OK = "#34d399";
export const WARN = "#fbbf24";
export const DANGER = "#f87171";
export const MUTED = "#5e6676";
export const GRID = "#232936";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= TB) return `${(n / TB).toFixed(digits)} TB`;
  if (a >= GB) return `${(n / GB).toFixed(digits)} GB`;
  if (a >= MB) return `${(n / MB).toFixed(a >= 100 * MB ? 0 : digits)} MB`;
  if (a >= KB) return `${(n / KB).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}

export const rate = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `${bytes(n)}/s`);

export function pct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !isFinite(n)) return "–";
  return `${n.toFixed(digits)}%`;
}

export function dur(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "–";
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/** A round axis maximum >= n (1, 2, 2.5, 5 × 10^k). */
export function niceMax(n: number, floor = 0): number {
  const v = Math.max(n, floor);
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

/** Same, for byte quantities: powers of two-ish steps in the right unit. */
export function niceBytes(n: number, floor = 0): number {
  const v = Math.max(n, floor);
  if (!(v > 0)) return KB;
  let unit = v >= TB ? TB : v >= GB ? GB : v >= MB ? MB : KB;
  let x = niceMax(v / unit);
  if (x >= 1000 && unit < TB) {
    unit *= 1024;
    x = niceMax(v / unit);
  }
  return x * unit;
}

export function axisBytes(n: number): string {
  if (n === 0) return "0";
  const a = Math.abs(n);
  const [u, s] = a >= TB ? [TB, "T"] : a >= GB ? [GB, "G"] : a >= MB ? [MB, "M"] : a >= KB ? [KB, "K"] : [1, ""];
  const v = n / u;
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${s}`;
}

export function clockLabel(ts: number, span: number): string {
  const d = new Date(ts * 1000);
  if (span > 3 * 86400) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (span > 86400) return `${d.toLocaleDateString([], { weekday: "short" })} ${d.getHours().toString().padStart(2, "0")}h`;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function tooltipTime(ts: number, span: number): string {
  const d = new Date(ts * 1000);
  if (span > 86400) return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: span <= 3600 ? "2-digit" : undefined });
}

export type Tone = "ok" | "warn" | "danger";
export const toneColor = (t: Tone) => (t === "danger" ? DANGER : t === "warn" ? WARN : OK);
export const toneOf = (v: number | null | undefined, warn: number, crit: number): Tone =>
  v === null || v === undefined ? "ok" : v >= crit ? "danger" : v >= warn ? "warn" : "ok";
