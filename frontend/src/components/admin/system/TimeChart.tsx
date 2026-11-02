// Hand-rolled SVG time-series chart: stacked areas, lines with min/max bands,
// mirrored (in above / out below) series, reference lines, event markers,
// a crosshair shared by every chart on the page, and — in live mode — a
// smooth scroll: paths are laid out against a fixed anchor and the whole
// layer is translated with a 2 s linear CSS transition, so one DOM update
// per sample still reads as continuous motion.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { AXIS, clockLabel, CURSOR, GRID, MUTED, RING, tooltipTime, WARN, DANGER } from "./fmt";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  min?: (number | null)[];
  max?: (number | null)[];
  kind?: "area" | "line";
  stack?: boolean; // stacked with the previous stacked series (areas)
  below?: boolean; // mirrored chart: drawn under the baseline
  fmt?: (v: number) => string;
}

export interface RefLine {
  value: number;
  label: string;
  tone?: "muted" | "warn" | "danger";
  below?: boolean;
}

export interface Marker {
  ts: number;
  level: string;
  message: string;
}

interface Props {
  t: number[];
  series: ChartSeries[];
  domain: [number, number];
  step: number;
  live: boolean;
  yFmt: (v: number) => string;
  yMax?: number; // fixed axis max (e.g. 100 for %)
  autoMax?: (dataMax: number) => number; // otherwise: rounds the data max
  refs?: RefLine[];
  markers?: Marker[];
  height?: number;
  mirrored?: boolean;
  label: string;
  extra?: (i: number) => { label: string; value: string }[];
}

// Crosshair time shared by all charts (hovering one shows the line on all).
export const useHover = create<{ t: number | null; src: string | null; set: (t: number | null, src: string | null) => void }>(
  (set) => ({ t: null, src: null, set: (t, src) => set({ t, src }) }),
);

const PAD_L = 40;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 18;

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function nearest(t: number[], x: number): number {
  let lo = 0;
  let hi = t.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(t[lo] - x) <= Math.abs(t[hi] - x) ? lo : hi;
}

const TICKS: [number, number][] = [
  [900, 300], [1800, 600], [3600, 900], [6 * 3600, 3600], [24 * 3600, 6 * 3600],
  [7 * 86400, 86400], [30 * 86400, 7 * 86400], [Infinity, 14 * 86400],
];

function tickStep(span: number): number {
  for (const [lim, st] of TICKS) if (span <= lim * 1.01) return st;
  return 86400;
}

export default function TimeChart(p: Props) {
  const { t, series, domain, step, live, yFmt, refs = [], markers = [], mirrored = false } = p;
  const height = p.height ?? 150;
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const id = useId().replace(/:/g, "");
  const hover = useHover();
  const plotW = Math.max(10, width - PAD_L - PAD_R);
  const plotH = height - PAD_T - PAD_B;
  const span = domain[1] - domain[0];
  const pps = plotW / Math.max(1, span);

  // Live: x is laid out against a fixed anchor; the layer slides by `offset`.
  const anchor = useRef<{ t: number; w: number; span: number; v: number }>({ t: domain[1], w: plotW, span, v: 0 });
  if (!live) anchor.current = { t: domain[1], w: plotW, span, v: anchor.current.v };
  else if (anchor.current.w !== plotW || anchor.current.span !== span || (domain[1] - anchor.current.t) * pps > 20000 ||
           domain[1] < anchor.current.t) {
    anchor.current = { t: domain[1], w: plotW, span, v: anchor.current.v + 1 };
  }
  const a = anchor.current;
  const offset = live ? (domain[1] - a.t) * pps : 0;
  const X = (ts: number) => (live ? (ts - a.t) * pps + plotW : (ts - domain[0]) * pps);

  const geo = useMemo(() => {
    let dataMax = 0;
    let dataMaxBelow = 0;
    const base = new Array(t.length).fill(0);
    const baseBelow = new Array(t.length).fill(0);
    const stacks: { s: ChartSeries; lo: number[]; hi: (number | null)[] }[] = [];
    for (const s of series) {
      const b = s.below ? baseBelow : base;
      const lo = s.stack ? [...b] : new Array(t.length).fill(0);
      const hi = s.values.map((v, i) => (v === null || v === undefined ? null : (s.stack ? b[i] : 0) + v));
      if (s.stack) hi.forEach((v, i) => v !== null && (b[i] = v));
      for (let i = 0; i < t.length; i++) {
        const top = Math.max(hi[i] ?? 0, s.max?.[i] ?? 0);
        if (s.below) dataMaxBelow = Math.max(dataMaxBelow, top);
        else dataMax = Math.max(dataMax, top);
      }
      stacks.push({ s, lo, hi });
    }
    const m = mirrored ? Math.max(dataMax, dataMaxBelow) : dataMax;
    const yMax = p.yMax ?? (p.autoMax ? p.autoMax(m) : m || 1);
    return { stacks, yMax };
  }, [t, series, mirrored, p.yMax, p.autoMax]);

  const { yMax } = geo;
  const mid = mirrored ? plotH / 2 : plotH;
  const Y = (v: number, below?: boolean) => {
    const h = mirrored ? plotH / 2 : plotH;
    const y = (Math.min(v, yMax * 1.02) / yMax) * h;
    return below ? mid + y : mid - y;
  };

  // Segments: break on nulls and on gaps longer than 2.5 steps (downtime).
  const gap = Math.max(step * 2.5, 5);
  const paths = useMemo(() => {
    const out: { key: string; color: string; area?: string; line: string; band?: string; kind: string }[] = [];
    for (const { s, lo, hi } of geo.stacks) {
      const segs: number[][] = [];
      let cur: number[] = [];
      for (let i = 0; i < t.length; i++) {
        if (hi[i] === null || (cur.length && t[i] - t[cur[cur.length - 1]] > gap)) {
          if (cur.length) segs.push(cur);
          cur = [];
        }
        if (hi[i] !== null) cur.push(i);
      }
      if (cur.length) segs.push(cur);
      let line = "";
      let area = "";
      let band = "";
      for (const seg of segs) {
        const pts = seg.map((i) => `${X(t[i]).toFixed(1)},${Y(hi[i] as number, s.below).toFixed(1)}`);
        if (seg.length === 1) {
          const [x, y] = pts[0].split(",");
          pts.push(`${(+x + 1.5).toFixed(1)},${y}`);
        }
        line += `M${pts.join("L")}`;
        if (s.kind === "area") {
          const back = [...seg].reverse().map((i) => `${X(t[i]).toFixed(1)},${Y(lo[i], s.below).toFixed(1)}`);
          area += `M${pts.join("L")}L${back.join("L")}Z`;
        }
        if (s.min && s.max && s.kind !== "area") {
          const top = seg.map((i) => `${X(t[i]).toFixed(1)},${Y(s.max![i] ?? (hi[i] as number), s.below).toFixed(1)}`);
          const bot = [...seg].reverse().map((i) => `${X(t[i]).toFixed(1)},${Y(s.min![i] ?? (hi[i] as number), s.below).toFixed(1)}`);
          band += `M${top.join("L")}L${bot.join("L")}Z`;
        }
      }
      out.push({ key: s.key, color: s.color, area: area || undefined, line, band: band || undefined, kind: s.kind || "line" });
    }
    return out;
    // X depends on anchor / pps / domain: recompute when they change.
  }, [geo, t, plotW, plotH, yMax, a.t, a.v, live, domain[0], gap]);

  // x ticks (content coordinates, so they scroll with the data in live mode).
  const ts = tickStep(span);
  const ticks: number[] = [];
  for (let x = Math.ceil((domain[0] - span * 0.05) / ts) * ts; x <= domain[1] + step * 2; x += ts) ticks.push(x);

  // Hover.
  const hoverT = hover.t;
  const idx = hoverT !== null && t.length ? nearest(t, hoverT) : -1;
  const showHover = idx >= 0 && hoverT !== null && hoverT >= domain[0] - step && hoverT <= domain[1] + step &&
    Math.abs(t[idx] - hoverT) <= Math.max(step * 2, span / 200);
  const hx = showHover ? X(t[idx]) - offset : 0;
  const mine = hover.src === id;

  const onMove = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    const tt = live ? a.t + (px + offset - plotW) / pps : domain[0] + px / pps;
    hover.set(tt, id);
  };
  const onLeave = () => hover.set(null, null);

  const [motion, setMotion] = useState(!reducedMotion());
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const f = () => setMotion(!mq.matches);
    mq.addEventListener?.("change", f);
    return () => mq.removeEventListener?.("change", f);
  }, []);
  const transition = live && motion ? `transform ${Math.max(0.5, step)}s linear` : "none";

  const yTicks = mirrored ? [yMax, 0, yMax] : [yMax, yMax / 2, 0];

  return (
    <div ref={wrapRef} className="relative select-none" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={p.label} className="block overflow-visible">
          <defs>
            <clipPath id={`c${id}`}>
              <rect x={0} y={-PAD_T} width={plotW} height={height} />
            </clipPath>
          </defs>
          {/* y grid + labels */}
          <g transform={`translate(${PAD_L},${PAD_T})`}>
            {yTicks.map((v, i) => {
              const y = mirrored ? (i === 0 ? 0 : i === 1 ? mid : plotH) : plotH - (v / yMax) * plotH;
              return (
                <g key={i}>
                  <line x1={0} x2={plotW} y1={y} y2={y} stroke={i === (mirrored ? 1 : 2) ? AXIS : GRID} strokeWidth={1} />
                  <text x={-6} y={y} dy="0.32em" textAnchor="end" className="fill-content-faint text-[10px] tabular-nums">
                    {mirrored && i === 1 ? "0" : yFmt(v)}
                  </text>
                </g>
              );
            })}
            <g clipPath={`url(#c${id})`}>
              <g key={a.v} style={{ transform: `translateX(${-offset}px)`, transition, willChange: live ? "transform" : undefined }}>
                {ticks.filter((x) => X(x) - offset > 22 && X(x) - offset < plotW - 22).map((x) => (
                  <text key={x} x={X(x)} y={plotH + 13} textAnchor="middle" className="fill-content-faint text-[10px] tabular-nums">
                    {clockLabel(x, span)}
                  </text>
                ))}
                {paths.map((pp) => (
                  <g key={pp.key}>
                    {pp.band && <path d={pp.band} fill={pp.color} opacity={0.14} />}
                    {pp.area && <path d={pp.area} fill={pp.color} opacity={0.2} />}
                    <path d={pp.line} fill="none" stroke={pp.color} strokeWidth={pp.kind === "area" ? 1.5 : 2}
                      strokeLinejoin="round" strokeLinecap="round" />
                  </g>
                ))}
                {markers.map((m, i) => {
                  const mx = X(m.ts);
                  const c = m.level === "error" ? DANGER : m.level === "warning" ? WARN : MUTED;
                  return (
                    <g key={`${m.ts}-${i}`} transform={`translate(${mx},${plotH - 1})`}>
                      <circle r={4} fill={c} stroke={RING} strokeWidth={2} />
                    </g>
                  );
                })}
              </g>
            </g>
            {refs.map((r, i) => {
              if (r.value > yMax * 1.02 || r.value <= 0) return null;
              const y = Y(r.value, r.below);
              const c = r.tone === "danger" ? DANGER : r.tone === "warn" ? WARN : MUTED;
              return (
                <g key={i}>
                  <line x1={0} x2={plotW} y1={y} y2={y} stroke={c} strokeWidth={1} strokeDasharray={r.tone === "muted" ? undefined : "4 3"} opacity={0.8} />
                  <text x={plotW - 4} y={y - 3} textAnchor="end" className="fill-content-dim text-[10px]">
                    {r.label}
                  </text>
                </g>
              );
            })}
            {showHover && (
              <g pointerEvents="none">
                <line x1={hx} x2={hx} y1={0} y2={plotH} stroke={CURSOR} strokeWidth={1} opacity={0.6} />
                {geo.stacks.map(({ s, hi }) =>
                  hi[idx] === null ? null : (
                    <circle key={s.key} cx={hx} cy={Y(hi[idx] as number, s.below)} r={4} fill={s.color} stroke={RING} strokeWidth={2} />
                  ),
                )}
              </g>
            )}
            <rect x={0} y={0} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove}
              onPointerDown={onMove} onPointerLeave={onLeave} style={{ touchAction: "pan-y" }} />
          </g>
        </svg>
      )}
      {showHover && mine && (
        <Tooltip x={PAD_L + hx} width={width} time={tooltipTime(t[idx], span)}
          rows={[
            ...[...series].reverse().map((s) => ({ color: s.color, label: s.label, value: s.values[idx] === null || s.values[idx] === undefined ? "–" : (s.fmt || yFmt)(s.values[idx] as number),
              range: s.min && s.max && s.min[idx] !== null && s.max[idx] !== null && s.min[idx] !== s.max[idx]
                ? `${(s.fmt || yFmt)(s.min[idx] as number)} – ${(s.fmt || yFmt)(s.max[idx] as number)}` : undefined })),
            ...(p.extra ? p.extra(idx).map((r) => ({ color: undefined, label: r.label, value: r.value, range: undefined })) : []),
          ]}
          notes={markers.filter((m) => Math.abs(m.ts - t[idx]) <= Math.max(step * 1.5, span / 120)).slice(-3)}
        />
      )}
    </div>
  );
}

function Tooltip({ x, width, time, rows, notes }: {
  x: number; width: number; time: string;
  rows: { color?: string; label: string; value: string; range?: string }[];
  notes: Marker[];
}) {
  const right = x > width * 0.6;
  return (
    <div
      className="pointer-events-none absolute top-0 z-20 min-w-[150px] rounded-lg border border-border bg-surface-2/95 px-2.5 py-1.5 text-[11px] shadow-float backdrop-blur"
      style={right ? { right: width - x + 12 } : { left: x + 12 }}
    >
      <div className="mb-1 text-content-faint tabular-nums">{time}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2 leading-5">
          {r.color ? <span className="h-[2px] w-3 rounded" style={{ background: r.color }} /> : <span className="w-3" />}
          <span className="text-content-dim">{r.label}</span>
          <span className="ml-auto pl-3 text-right font-medium text-content tabular-nums">
            {r.value}
            {r.range && <span className="ml-1 font-normal text-content-faint">({r.range})</span>}
          </span>
        </div>
      ))}
      {notes.map((n, i) => (
        <div key={`n${i}`} className="mt-1 flex max-w-[260px] items-start gap-1.5 border-t border-border/60 pt-1 text-content-dim">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: n.level === "error" ? DANGER : n.level === "warning" ? WARN : MUTED }} />
          <span className="whitespace-normal">{n.message}</span>
        </div>
      ))}
    </div>
  );
}
