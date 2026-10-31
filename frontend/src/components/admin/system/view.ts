// What the charts draw: the live ring (from the feed) or a history range
// (fetched once per range, then extended with each live sample — no polling).
import { useEffect, useMemo, useState } from "react";
import { systemMetrics, type MetricsRange, type MonEvent, type RangeId, type Snapshot } from "../../../api/system";
import { useFeed } from "./feed";

export type ViewRange = "live" | Exclude<RangeId, "15m" | "30m">;

export interface Ser {
  avg: (number | null)[];
  min?: (number | null)[];
  max?: (number | null)[];
}

export interface View {
  t: number[];
  get: (key: string) => Ser;
  step: number;
  domain: [number, number];
  live: boolean;
  markers: { ts: number; level: string; message: string }[];
  loading: boolean;
  error: string;
}

const SPAN: Record<ViewRange, number> = {
  live: 900, "1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400,
};

const isoToTs = (iso: string) => Date.parse(iso) / 1000;
const NONE: Ser = { avg: [] };

/** Extend a history range with one live sample (same bucket: fold in; new bucket: append). */
function fold(d: MetricsRange, snap: Snapshot, span: number): MetricsRange {
  const step = d.step;
  const b = Math.floor(snap.ts / step) * step;
  const last = d.t.length ? d.t[d.t.length - 1] : -1;
  if (b < last) return d;
  const append = b > last;
  const cut = Math.max(0, d.t.findIndex((x) => x >= snap.ts - span));
  const series: MetricsRange["series"] = {};
  const keys = new Set([...Object.keys(d.series), ...Object.keys(snap.m)]);
  // Weight of the bucket so far ≈ samples since its start.
  const n = Math.max(1, (snap.ts - b) / (snap.interval || 2));
  keys.forEach((k) => {
    const s = d.series[k] || { avg: new Array(d.t.length).fill(null), min: new Array(d.t.length).fill(null), max: new Array(d.t.length).fill(null) };
    const v = snap.m[k];
    const avg = s.avg.slice(cut);
    const min = (s.min || s.avg).slice(cut);
    const max = (s.max || s.avg).slice(cut);
    if (append) {
      avg.push(v ?? null);
      min.push(v ?? null);
      max.push(v ?? null);
    } else if (v !== undefined) {
      const i = avg.length - 1;
      const a = avg[i];
      avg[i] = a === null ? v : (a * (n - 1) + v) / n;
      min[i] = min[i] === null ? v : Math.min(min[i] as number, v);
      max[i] = max[i] === null ? v : Math.max(max[i] as number, v);
    }
    series[k] = { avg, min, max };
  });
  const t = d.t.slice(cut);
  if (append) t.push(b);
  return { ...d, t, series, to: snap.ts, from: snap.ts - span };
}

export function useView(range: ViewRange): View {
  const live = useFeed((s) => s.live);
  const events = useFeed((s) => s.events);
  const [hist, setHist] = useState<MetricsRange | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (range === "live") return;
    let alive = true;
    setLoading(true);
    setError("");
    systemMetrics(range)
      .then((d) => alive && setHist(d))
      .catch((e) => alive && setError(String(e.message || e)))
      .finally(() => alive && setLoading(false));
    // Then follow the feed: every sample extends the current bucket.
    const unsub = useFeed.subscribe((s, prev) => {
      if (s.now && s.now !== prev.now) {
        const snap = s.now;
        setHist((d) => (d && d.range === range ? fold(d, snap, SPAN[range]) : d));
      }
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [range]);

  return useMemo<View>(() => {
    const span = SPAN[range];
    const evMarkers = (list: MonEvent[]) =>
      list.map((e) => ({ ts: isoToTs(e.ts), level: e.level, message: e.message })).filter((m) => isFinite(m.ts));
    if (range === "live") {
      const last = live.t.length ? live.t[live.t.length - 1] : Date.now() / 1000;
      const from = last - span;
      return {
        t: live.t,
        get: (k) => (live.s[k] ? { avg: live.s[k] } : NONE),
        step: 2,
        domain: [from, last],
        live: true,
        markers: evMarkers(events).filter((m) => m.ts >= from - 2),
        loading: false,
        error: "",
      };
    }
    const d = hist && hist.range === range ? hist : null;
    const seen = new Set((d?.events || []).map((e) => e.id));
    const all = [...(d?.events || []), ...events.filter((e) => e.id === null || !seen.has(e.id))];
    const to = d ? d.to : Date.now() / 1000;
    return {
      t: d?.t || [],
      get: (k) => (d?.series[k] as Ser) || NONE,
      step: d?.step || 60,
      domain: [to - span, to],
      live: false,
      markers: evMarkers(all).filter((m) => m.ts >= to - span),
      loading: loading || !d,
      error,
    };
  }, [range, live, events, hist, loading, error]);
}
