// Plan usage windows + API-equivalent cost: parsing and formatting only (no
// React), so the composer footer, the account popover, the Providers page and
// the per-message footer all say the same thing the same way.

import type { Account } from "../api/accounts";
import type { UsageWindow } from "../api/usage";
import type { PlanUsage } from "../types";
import { tr } from "../i18n";
import { fmtTime, fmtWeekday } from "../i18n/format";

/** One limit window: percent used (0..100) and when it resets (epoch ms). */
export interface PlanWindow {
  percent: number | null;
  resetsAt: number | null;
  at: number | null; // when this value was observed (epoch ms)
}

export interface PlanWindows {
  five?: PlanWindow; // 5-hour session window
  seven?: PlanWindow; // 7-day window
  models: { label: string; percent: number; resetsAt: number | null }[]; // per-model weekly limits
}

/** Epoch ms from an ISO string, epoch seconds or epoch ms. */
export function toMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null;
  const n = Date.parse(String(v));
  return Number.isNaN(n) ? null : n;
}

const kindOf = (w: UsageWindow): string => {
  if (w.kind) return w.kind;
  const l = w.label.toLowerCase(); // older backends sent labels only
  if (l.includes("5h") || l.includes("5hr") || l.includes("session")) return "five_hour";
  if (l.includes("7 day") || l.includes("weekly")) return "seven_day";
  return "other";
};

/** Windows from an account card (accounts API; percent is 0..100). */
export function fromAccount(a: Pick<Account, "windows" | "model_windows" | "plan_fetched_at">): PlanWindows {
  const at = toMs(a.plan_fetched_at);
  const out: PlanWindows = { models: [] };
  for (const w of a.windows || []) {
    const pw = { percent: Number.isFinite(w.percent) ? w.percent : null, resetsAt: toMs(w.resets_at), at };
    const k = kindOf(w);
    if (k === "five_hour" && !out.five) out.five = pw;
    else if (k === "seven_day" && !out.seven) out.seven = pw;
  }
  out.models = (a.model_windows || []).map((w) => ({ label: w.label, percent: w.percent, resetsAt: toMs(w.resets_at) }));
  return out;
}

/** Windows from the engine's live rate_limit_event (utilization is a 0..1 fraction). */
export function fromLive(u: PlanUsage): PlanWindows {
  const at = toMs(u.at) ?? Date.now();
  const out: PlanWindows = { models: [] };
  const win = (x?: { utilization?: number; resetsAt?: number | string }): PlanWindow | undefined =>
    x && typeof x.utilization === "number" ? { percent: x.utilization * 100, resetsAt: toMs(x.resetsAt), at } : undefined;
  const uw = u.unifiedWindows || {};
  out.five = win(uw.five_hour);
  out.seven = win(uw.seven_day);
  // Older CLIs report one window at a time.
  if (u.rateLimitType === "five_hour" && !out.five) out.five = win(u);
  if (u.rateLimitType === "seven_day" && !out.seven) out.seven = win(u);
  return out;
}

/** Per window, the most recently observed value of the two sources. */
export function mergeWindows(a?: PlanWindows, b?: PlanWindows): PlanWindows {
  const pick = (x?: PlanWindow, y?: PlanWindow) => (!x ? y : !y ? x : (x.at ?? 0) >= (y.at ?? 0) ? x : y);
  return {
    five: pick(a?.five, b?.five),
    seven: pick(a?.seven, b?.seven),
    models: (b?.models.length ? b.models : a?.models) || [],
  };
}

export const fmtPct = (p: number | null | undefined) => (p === null || p === undefined ? "—" : `${Math.round(p)}%`);

/** Text colour for a usage percent. */
export function pctTone(p: number | null | undefined): string {
  if (p === null || p === undefined) return "text-content-faint";
  if (p >= 90) return "text-danger";
  if (p >= 70) return "text-warning";
  return "text-content-dim";
}

export function barTone(p: number | null | undefined): string {
  if ((p ?? 0) >= 90) return "bg-danger";
  if ((p ?? 0) >= 70) return "bg-warning";
  return "bg-accent";
}

/** "resets in 2h 10m" (the 5-hour window), in the UI's language. */
export function resetsIn(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const left = ms - now;
  if (left <= 60_000) return tr("usage.resetsInSoon");
  const m = Math.floor(left / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return tr("usage.resetsInDH", { d, h });
  if (h) return tr("usage.resetsInHM", { h, m: mm });
  return tr("usage.resetsInM", { m: mm });
}

/** "resets Thu 07:00" (weekly windows), in local time and the UI's language. */
export function resetsOn(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  if (ms <= now) return tr("usage.resetsNow");
  const d = new Date(ms);
  const day = fmtWeekday(d);
  const time = fmtTime(d);
  return ms - now > 6 * 86_400_000
    ? tr("usage.resetsOnDate", { day, month: String(d.getMonth() + 1), dom: String(d.getDate()), time })
    : tr("usage.resetsOnDay", { day, time });
}

export const resetLabel = (kind: "five" | "seven", ms: number | null) => (kind === "five" ? resetsIn(ms) : resetsOn(ms));

/** "5h 52% · 7d 7%" (only the windows that are known). */
export function windowsLabel(w: PlanWindows): string {
  return [w.five && `${tr("usage.fiveShort")} ${fmtPct(w.five.percent)}`, w.seven && `${tr("usage.sevenShort")} ${fmtPct(w.seven.percent)}`]
    .filter(Boolean)
    .join(" · ");
}

// ---- API-equivalent cost ------------------------------------------------------

/** Dollar amount at a precision that suits its size. */
export function fmtUsd(n: number): string {
  if (!n) return "$0";
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

export interface TokenBreakdown {
  input: number; // uncached input
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** Token kinds of one turn (summed over all of its model calls). Claude
 * reports cache reads/writes separately; Codex counts cached input inside
 * input_tokens. */
export function tokenBreakdown(usage?: Record<string, unknown> | null): TokenBreakdown | null {
  if (!usage) return null;
  const output = num(usage.output_tokens);
  let input = num(usage.input_tokens);
  let cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  if (!cacheRead && usage.cached_input_tokens !== undefined) {
    cacheRead = num(usage.cached_input_tokens);
    input = Math.max(0, input - cacheRead);
  }
  const total = input + cacheRead + cacheWrite + output;
  return total ? { input, cacheRead, cacheWrite, output, total } : null;
}

export const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

/** What the API-equivalent cost means (a tooltip / footnote), in the UI's language. */
export const apiCostHint = () => tr("usage.apiCostHint");

/** @deprecated English only (read once at load) — use `apiCostHint()`; kept for files not translated yet. */
export const API_COST_HINT =
  "What these tokens would cost at API prices (input, cache and output tokens of every model call). " + // i18n-ignore
  "Informational only — not a charge on your subscription."; // i18n-ignore
