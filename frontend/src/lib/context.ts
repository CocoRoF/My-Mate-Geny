// Context-window meter maths and wording (no React): the composer meter, its
// popover, the session panel and the compaction divider say the same thing.

import type { ContextInfo } from "../types";
import { fmtTokens } from "./usage";
import { tr } from "../i18n";

/** The CLI auto-compacts at window - this (measured on Claude Code 2.1.314;
 * the backend sends the catalog's value, this is the fallback). */
export const COMPACT_BUFFER = 33_000;
export const DEFAULT_PRESETS = [0, 200_000, 400_000, 600_000];

/** The model's full window: `[1m]` variants and the 5.x generation run at 1M. */
export function modelWindow(model: string | null | undefined): number {
  const m = (model || "").toLowerCase();
  if (m.includes("[1m]")) return 1_000_000;
  if (!m || ["default", "opus", "sonnet", "haiku", "fable", "best", "opusplan"].includes(m)) return 1_000_000;
  const hit = /(opus|sonnet|haiku|fable)-(\d+)/.exec(m);
  return hit && Number(hit[2]) >= 5 ? 1_000_000 : 200_000;
}

/** Window + auto-compact point the CLI uses for a model and a configured
 * auto-compact window (0 = the model's full window). ``known``: the model's window when the catalog says it (an
 * API-key model: the vendor reports it). */
export function limitsFor(model: string | null | undefined, autoCompact: number, buffer = COMPACT_BUFFER,
                          known?: number | null) {
  const full = known || modelWindow(model);
  const window = autoCompact > 0 ? Math.min(full, autoCompact) : full;
  return { window, threshold: Math.max(0, window - buffer), full };
}

/** "1M", "200k", "400k". */
export function fmtWindow(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  return `${Math.round(n / 1000)}k`;
}

export const fmtCtx = (n: number | null | undefined) => (n === null || n === undefined ? "—" : fmtTokens(n));

export const presetLabel = (n: number) => (n === 0 ? tr("chat.presetFull") : fmtWindow(n));

export interface Meter {
  tokens: number | null;
  window: number;
  threshold: number | null; // null: auto-compact off
  pct: number | null; // of the window
  toCompact: number | null; // fraction of the way to the compact point
  estimated: boolean; // window/threshold not yet reported by the engine
}

export function meterOf(ctx: ContextInfo | null, fallback: { window: number; threshold: number }): Meter {
  const window = ctx?.window || fallback.window;
  const autoOff = ctx?.auto_compact === false;
  const threshold = autoOff ? null : ctx?.threshold || (ctx?.window ? Math.max(0, ctx.window - COMPACT_BUFFER) : fallback.threshold);
  const tokens = ctx?.tokens ?? null;
  return {
    tokens,
    window,
    threshold,
    pct: tokens === null ? null : Math.min(100, (tokens / window) * 100),
    toCompact: tokens === null || !threshold ? null : tokens / threshold,
    estimated: !ctx?.window || ctx.window_source === "estimate",
  };
}

/** Text colour as the context nears the compact point. */
export function ctxTone(toCompact: number | null): string {
  if (toCompact === null) return "text-content-faint";
  if (toCompact >= 0.9) return "text-danger";
  if (toCompact >= 0.75) return "text-warning";
  return "text-content-dim";
}

export function ctxBar(toCompact: number | null): string {
  if ((toCompact ?? 0) >= 0.9) return "bg-danger";
  if ((toCompact ?? 0) >= 0.75) return "bg-warning";
  return "bg-accent";
}

/** the auto-compact window's explanation, in the UI's language (call while rendering) */
export const windowHint = () => tr("chat.windowHint");
