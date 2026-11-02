// Number formatting + chart colors for the System tab.
import { currentLocale, tr } from "../../../i18n";
import { useTheme, type Theme } from "../../../lib/theme";

// The colours follow the theme (lib/theme.ts): each is a live binding re-assigned on a switch, so a chart that
// re-renders (the System tab watches the theme) draws in the new set; `${DANGER}55` hex-alpha suffixes keep working.
//
// Categorical slots, fixed order, each mode its own steps of the same hues (validated with the dataviz skill's
// validate_palette.js — dark on #161a22: adjacent CVD ΔE >= 8.4, normal-vision ΔE >= 19.8, all >= 3:1; light on
// #ffffff: adjacent CVD ΔE >= 9.1, normal-vision ΔE >= 22.9, aqua / yellow under 3:1 → every chart carries a legend
// with its live values, the relief the method asks for).
// Status (reserved: never a series color; always with an icon + label) = the theme's success / warning / danger.
const SETS = {
  dark: { C1: "#3987e5", C2: "#d95926", C3: "#199e70", C4: "#c98500", OK: "#34d399", WARN: "#fbbf24", DANGER: "#f87171", MUTED: "#5e6676", GRID: "#232936", AXIS: "#2f3647", RING: "#161a22", CURSOR: "#9aa3b4" },
  light: { C1: "#2a78d6", C2: "#eb6834", C3: "#1baf7a", C4: "#eda100", OK: "#046644", WARN: "#885000", DANGER: "#b41a22", MUTED: "#606879", GRID: "#e3e7ee", AXIS: "#c2c8d4", RING: "#ffffff", CURSOR: "#474f5f" },
} as const;
export let C1: string = SETS.dark.C1; // blue
export let C2: string = SETS.dark.C2; // orange
export let C3: string = SETS.dark.C3; // aqua
export let C4: string = SETS.dark.C4; // yellow
export let OK: string = SETS.dark.OK;
export let WARN: string = SETS.dark.WARN;
export let DANGER: string = SETS.dark.DANGER;
export let MUTED: string = SETS.dark.MUTED;
export let GRID: string = SETS.dark.GRID;
/** a stronger grid line (the zero line / the threshold) */
export let AXIS: string = SETS.dark.AXIS;
/** the ring around a point (the chart's surface) */
export let RING: string = SETS.dark.RING;
/** the hover cursor line */
export let CURSOR: string = SETS.dark.CURSOR;
/** which set is drawn ("dark" | "light") */
export let CHART_THEME: Theme = "dark";

function useSet(theme: Theme) {
  const c = SETS[theme];
  ({ C1, C2, C3, C4, OK, WARN, DANGER, MUTED, GRID, AXIS, RING, CURSOR } = c);
  CHART_THEME = theme;
}
useSet(useTheme.getState().theme);
useTheme.subscribe((s) => s.theme !== CHART_THEME && useSet(s.theme));

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
  if (d) return tr("common.durDH", { d, h });
  if (h) return tr("common.durHM", { h, m });
  if (m) return tr("admin.durM", { m });
  return tr("common.durS", { s });
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
  const loc = currentLocale();
  if (span > 3 * 86400) return d.toLocaleDateString(loc, { month: "short", day: "numeric" });
  if (span > 86400) return `${d.toLocaleDateString(loc, { weekday: "short" })} ${d.getHours().toString().padStart(2, "0")}h`;
  return d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function tooltipTime(ts: number, span: number): string {
  const d = new Date(ts * 1000);
  const loc = currentLocale();
  if (span > 86400) return d.toLocaleString(loc, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", second: span <= 3600 ? "2-digit" : undefined, hourCycle: "h23" });
}

export type Tone = "ok" | "warn" | "danger";
export const toneColor = (t: Tone) => (t === "danger" ? DANGER : t === "warn" ? WARN : OK);
export const toneOf = (v: number | null | undefined, warn: number, crit: number): Tone =>
  v === null || v === undefined ? "ok" : v >= crit ? "danger" : v >= warn ? "warn" : "ok";
