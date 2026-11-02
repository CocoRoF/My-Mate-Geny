// Small pieces: sparkline, meter, per-core heat strip.
import { useEffect, useRef, useState } from "react";
import { C1, CHART_THEME, GRID } from "./fmt";
import { useResolvedTheme } from "../../../lib/theme";
import { useT } from "../../../i18n";

/** Trend line for a tile / table row (no axes; the number beside it is the value). */
export function Sparkline({ values, color = C1, max, height = 28, className = "" }: {
  values: (number | null)[]; color?: string; max?: number; height?: number; className?: string;
}) {
  const v = values.filter((x): x is number => x !== null && x !== undefined && isFinite(x));
  if (v.length < 2) return <div className={className} style={{ height }} />;
  const hi = max ?? Math.max(...v) * 1.1;
  const lo = max !== undefined ? 0 : Math.min(0, ...v);
  const n = values.length;
  const pts: string[] = [];
  values.forEach((x, i) => {
    if (x === null || x === undefined || !isFinite(x)) return;
    const px = (i / (n - 1)) * 100;
    const py = 100 - ((x - lo) / (hi - lo || 1)) * 100;
    pts.push(`${px.toFixed(2)},${Math.max(0, Math.min(100, py)).toFixed(2)}`);
  });
  const line = `M${pts.join("L")}`;
  const area = `${line}L100,100L${pts[0].split(",")[0]},100Z`;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={`block w-full ${className}`} style={{ height }} aria-hidden>
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Fill = severity, track = a lighter step of the same hue. */
export function Meter({ value, color, track, label }: { value: number; color: string; track?: string; label: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: track || `${color}26` }}
      role="meter" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
    </div>
  );
}

// Sequential single-hue ramp (blue), each theme its own direction: near-zero recedes into the surface (dark: dark
// steps up to the lightest; light: the lightest steps down to the darkest).
const RAMPS = {
  dark: ["#1a2232", "#13305a", "#104281", "#1c5cab", "#2a78d6", "#5598e7", "#86b6ef", "#cde2fb"],
  light: ["#eef3fa", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
};

export function rampColor(pct: number): string {
  const RAMP = RAMPS[CHART_THEME];
  const x = Math.max(0, Math.min(1, pct / 100)) * (RAMP.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  if (i >= RAMP.length - 1) return RAMP[RAMP.length - 1];
  const a = hex(RAMP[i]);
  const b = hex(RAMP[i + 1]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Per-core CPU heat map: one row per core, one column per sample (canvas). */
export function CoreHeat({ cols, cores, height, interval = 2 }: { cols: number[][]; cores: number; height?: number; interval?: number }) {
  const t = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; r: number; j: number } | null>(null);
  const rows = Math.max(1, cores);
  const h = height ?? Math.min(96, Math.max(32, rows * 5));
  const theme = useResolvedTheme(); // redraw in the new colours on a switch
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = GRID;
    ctx.fillRect(0, 0, w, h);
    const n = 150;
    const cw = w / n;
    const rh = h / rows;
    const start = n - cols.length;
    cols.forEach((col, j) => {
      for (let r = 0; r < rows; r++) {
        ctx.fillStyle = rampColor(col[r] ?? 0);
        ctx.fillRect((start + j) * cw, r * rh, Math.ceil(cw) + 0.5, Math.max(1, rh - (rh > 4 ? 1 : 0)));
      }
    });
  }, [cols, rows, h, theme]);
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const j = Math.floor((x / rect.width) * 150) - (150 - cols.length);
    const r = Math.floor((y / rect.height) * rows);
    setTip(j >= 0 && j < cols.length && r >= 0 && r < rows ? { x, y, r, j } : null);
  };
  const v = tip ? cols[tip.j]?.[tip.r] : undefined;
  return (
    <div className="relative">
      <canvas ref={ref} className="block w-full rounded-md" style={{ height: h }} role="img"
        aria-label={t("admin.perCoreAria", { min: Math.round((cols.length * interval) / 60) })}
        onPointerMove={onMove} onPointerLeave={() => setTip(null)} />
      {tip && v !== undefined && (
        <div className="pointer-events-none absolute z-20 whitespace-nowrap rounded-md border border-border bg-surface-2/95 px-2 py-1 text-[11px] shadow-float"
          style={{ left: Math.min(tip.x + 10, (ref.current?.clientWidth || 300) - 130), top: tip.y + 12 }}>
          <span className="font-medium text-content tabular-nums">{v}%</span>
          <span className="text-content-dim">{t("admin.coreTip", { r: String(tip.r) })}</span>
          <span className="text-content-faint tabular-nums">{t("admin.secondsAgo", { s: Math.round((cols.length - 1 - tip.j) * interval) })}</span>
        </div>
      )}
    </div>
  );
}
