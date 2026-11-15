/**
 * Her memory network drawn (docs/mate-memory-graph.md "The map"): a force layout (d3-force) on a canvas. Colour is
 * what a thing is, size how much she knows of it, and — with fading on — opacity how readily it comes to her mind now:
 * what she used lately glows, what she hasn't thought of in a long time fades. Links: facts (solid, labelled), her
 * memories of the user (dashed), things that happened together (dotted).
 *
 * Wheel / pinch or the + / − buttons zoom, dragging the background pans, dragging a node moves it, a click selects;
 * hovering shows what a thing is. Names are placed so they never overlap: the selected / hovered / searched ones
 * first, then the bigger and more vivid ones where there is room (zoom in for more). Positions are kept per mate
 * (localStorage), so the map stays where it was between visits.
 */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef, type ReactNode } from "react";
import type { GraphKind, GraphLink, GraphNode } from "../../../api/mates";
import Icon from "../../ui/Icon";

export const KIND_COLOR: Record<GraphKind, string> = {
  user: "#6366f1",
  self: "#ec4899",
  person: "#f59e0b",
  place: "#10b981",
  org: "#3b82f6",
  work: "#8b5cf6",
  game: "#ef4444",
  thing: "#94a3b8",
  concept: "#0ea5e9",
  topic: "#14b8a6",
  event: "#eab308",
};

type N = SimulationNodeDatum & GraphNode & { r: number };
type L = SimulationLinkDatum<N> & GraphLink;

export interface MemoryGraphHandle {
  fit: () => void;
  center: (id: string) => void;
}

type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

const radius = (n: GraphNode) =>
  n.kind === "user" ? 13 : n.kind === "self" ? 11 : Math.min(18, 4.5 + 2.6 * Math.sqrt(n.facts + n.memories + n.degree * 0.5));

function loadPositions(key: string): Record<string, [number, number]> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") as Record<string, [number, number]>;
  } catch {
    return {};
  }
}

const MemoryGraph = forwardRef<MemoryGraphHandle, {
  mateId: string;
  nodes: GraphNode[];
  links: GraphLink[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  highlight?: Set<string>;
  fade?: boolean;
  height: number;
  userLabel: string;
  selfLabel: string;
  label: string;
  /** what hovering a node shows */
  tooltip?: (n: GraphNode) => ReactNode;
  /** the zoom buttons' labels, and more buttons after them (full screen) */
  controls?: { zoomIn: string; zoomOut: string; fit: string; extra?: ReactNode };
}>(function MemoryGraph({ mateId, nodes, links, selected, onSelect, highlight, fade = true, height, userLabel, selfLabel, label, tooltip, controls }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sim = useRef<Simulation<N, L> | null>(null);
  const view = useRef({ x: 300, y: height / 2, k: 1 });
  // (until she pans or zooms, the map keeps itself in view: on open, on a resize, when the layout settles)
  const touched = useRef(false);
  const data = useRef<{ nodes: N[]; links: L[] }>({ nodes: [], links: [] });
  const hover = useRef<string | null>(null);
  const [tip, setTip] = useState<{ node: GraphNode; x: number; top: number; bottom: number } | null>(null);
  const [width, setWidth] = useState(600);
  const size = useRef({ width, height });
  size.current = { width, height };
  const [, setTick] = useState(0);
  const storeKey = `hrh_mem_pos_${mateId}`;
  const draw = useRef<() => void>(() => {});

  // (the size of the box: the canvas follows it)
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of links) {
      if (!m.has(l.source)) m.set(l.source, new Set());
      if (!m.has(l.target)) m.set(l.target, new Set());
      m.get(l.source)!.add(l.target);
      m.get(l.target)!.add(l.source);
    }
    return m;
  }, [links]);

  // the layout: kept positions first, the rest placed by the forces
  useEffect(() => {
    const kept = loadPositions(storeKey);
    const old = new Map(data.current.nodes.map((n) => [n.id, n]));
    const ns: N[] = nodes.map((n) => {
      const prev = old.get(n.id);
      const p = prev ? [prev.x ?? 0, prev.y ?? 0] : kept[n.id];
      return { ...n, r: radius(n), x: p?.[0] ?? (Math.random() - 0.5) * 200, y: p?.[1] ?? (Math.random() - 0.5) * 200 };
    });
    const ids = new Set(ns.map((n) => n.id));
    const ls: L[] = links.filter((l) => ids.has(l.source) && ids.has(l.target)).map((l) => ({ ...l }));
    data.current = { nodes: ns, links: ls };
    const known = ns.filter((n) => kept[n.id] || old.has(n.id)).length;
    sim.current?.stop();
    const s = forceSimulation<N, L>(ns)
      .force("link", forceLink<N, L>(ls).id((d) => d.id).distance((l) => (l.kind === "fact" ? 80 : 64) + ((l.source as N).r + (l.target as N).r)).strength((l) => (l.kind === "fact" ? 0.5 : 0.22)))
      .force("charge", forceManyBody<N>().strength((d) => (d.kind === "user" ? -560 : -190)).distanceMax(560))
      .force("collide", forceCollide<N>().radius((d) => d.r + 10))
      .force("x", forceX<N>(0).strength(0.04))
      .force("y", forceY<N>(0).strength(0.04))
      .force("center", forceCenter(0, 0))
      .alpha(known >= ns.length * 0.8 ? 0.15 : 1)
      .alphaDecay(0.035);
    s.on("tick", () => draw.current());
    s.on("end", () => {
      if (!touched.current) fit();
      const out: Record<string, [number, number]> = { ...loadPositions(storeKey) };
      for (const n of ns) out[n.id] = [Math.round(n.x ?? 0), Math.round(n.y ?? 0)];
      try {
        localStorage.setItem(storeKey, JSON.stringify(out));
      } catch {
        /* (full: the next visit lays it out again) */
      }
    });
    sim.current = s;
    fit();
    const later = known ? null : setTimeout(() => !touched.current && fit(), 900);
    return () => {
      s.stop();
      if (later) clearTimeout(later);
    };
  }, [nodes, links, storeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const fit = () => {
    const ns = data.current.nodes;
    const { width, height } = size.current;
    if (!ns.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) {
      // (room for its name under it, roughly: a wide Hangul syllable, a narrower Latin letter at 11px)
      const text = n.kind === "user" ? userLabel : n.kind === "self" ? selfLabel : n.name;
      const half = Math.max(n.r, [...text].reduce((w, ch) => w + (ch > "\u1100" ? 11 : 6.2), 0) / 2 + 3);
      x0 = Math.min(x0, (n.x ?? 0) - half);
      y0 = Math.min(y0, (n.y ?? 0) - n.r);
      x1 = Math.max(x1, (n.x ?? 0) + half);
      y1 = Math.max(y1, (n.y ?? 0) + n.r + 17);
    }
    const k = Math.min(2.2, Math.max(0.15, Math.min(width / (x1 - x0 + 40), height / (y1 - y0 + 40))));
    view.current = { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
    draw.current();
  };

  const zoomBy = (f: number) => {
    touched.current = true;
    const v = view.current;
    const { width, height } = size.current;
    const k = Math.min(4, Math.max(0.12, v.k * f));
    v.x = width / 2 - ((width / 2 - v.x) / v.k) * k;
    v.y = height / 2 - ((height / 2 - v.y) / v.k) * k;
    v.k = k;
    draw.current();
  };
  const refit = () => {
    touched.current = false;
    fit();
  };

  useImperativeHandle(ref, () => ({
    fit: refit,
    center: (id: string) => {
      const n = data.current.nodes.find((x) => x.id === id);
      if (!n) return;
      touched.current = true;
      const k = Math.max(view.current.k, 1.1);
      view.current = { k, x: width / 2 - (n.x ?? 0) * k, y: height / 2 - (n.y ?? 0) * k };
      draw.current();
    },
  }));

  // drawing
  draw.current = () => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    const g = c.getContext("2d");
    if (!g) return;
    const css = getComputedStyle(c);
    const ink = css.getPropertyValue("--graph-ink").trim() || "#cbd5e1";
    const faint = css.getPropertyValue("--graph-faint").trim() || "rgba(148,163,184,0.35)";
    const paper = css.getPropertyValue("--graph-paper").trim() || "rgba(15,17,23,0.85)";
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const { x: tx, y: ty, k } = view.current;
    g.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    const focus = hover.current || selected;
    const near = focus ? neighbours.get(focus) ?? new Set<string>() : null;
    const alphaOf = (n: N) => {
      let a = fade ? 0.22 + 0.78 * n.strength : 1;
      if (near && n.id !== focus && !near.has(n.id)) a *= 0.25;
      if (highlight && highlight.size && !highlight.has(n.id)) a *= 0.35;
      return a;
    };
    // links
    for (const l of data.current.links) {
      const s = l.source as N, t = l.target as N;
      if (s.x == null || t.x == null) continue;
      const on = focus && (s.id === focus || t.id === focus);
      g.globalAlpha = Math.min(alphaOf(s), alphaOf(t)) * (on ? 0.95 : 0.45);
      g.strokeStyle = on ? KIND_COLOR[(s.id === focus ? t : s).kind] : faint;
      g.lineWidth = (on ? 1.8 : 1) / Math.sqrt(k) * Math.min(2.2, 0.8 + 0.25 * l.count);
      g.setLineDash(l.kind === "memory" ? [4, 3] : l.kind === "episode" ? [1.5, 3] : []);
      g.beginPath();
      g.moveTo(s.x, s.y!);
      g.lineTo(t.x, t.y!);
      g.stroke();
      if (on && l.label && k > 0.55) {
        g.setLineDash([]);
        g.globalAlpha = 0.95;
        g.font = `${10 / Math.max(0.8, k)}px ui-sans-serif, system-ui`;
        const mx = (s.x + t.x) / 2, my = (s.y! + t.y!) / 2;
        const w = g.measureText(l.label).width;
        g.fillStyle = paper;
        g.fillRect(mx - w / 2 - 3, my - 7, w + 6, 13);
        g.fillStyle = ink;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(l.label, mx, my);
      }
    }
    g.setLineDash([]);
    // nodes
    for (const n of data.current.nodes) {
      if (n.x == null) continue;
      const a = alphaOf(n);
      g.globalAlpha = a;
      if (fade && n.strength > 0.85) {
        // (used lately: a glow)
        g.globalAlpha = a * 0.35;
        g.fillStyle = KIND_COLOR[n.kind];
        g.beginPath();
        g.arc(n.x, n.y!, n.r + 5, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = a;
      }
      g.fillStyle = KIND_COLOR[n.kind];
      g.beginPath();
      g.arc(n.x, n.y!, n.r, 0, Math.PI * 2);
      g.fill();
      if (n.id === selected || (highlight && highlight.has(n.id))) {
        g.lineWidth = 2.5 / k;
        g.strokeStyle = ink;
        g.stroke();
      }
      if (n.pinned) {
        g.fillStyle = paper;
        g.beginPath();
        g.arc(n.x, n.y!, Math.max(2, n.r * 0.32), 0, Math.PI * 2);
        g.fill();
      }
    }
    // names on top, never over each other: the ones that matter now first (always shown), then the bigger and more
    // vivid where there is room — below the dot, else above, right or left of it
    const must = (n: N) => n.id === focus || n.id === selected || !!(near && near.has(n.id)) || !!(highlight && highlight.size && highlight.has(n.id));
    const rank = (n: N) => (n.id === focus ? 1e9 : n.id === selected ? 1e8 : must(n) ? 1e7 : 0) + (n.kind === "user" || n.kind === "self" ? 1e6 : 0) + n.r * 10 + n.strength * 8;
    const order = data.current.nodes.filter((n) => n.x != null).sort((a, b) => rank(b) - rank(a));
    const taken: Box[] = [];
    const dots: Box[] = data.current.nodes.filter((n) => n.x != null).map((n) => [n.x! - n.r, n.y! - n.r, n.x! + n.r, n.y! + n.r]);
    const pad = 3 / k;
    g.textBaseline = "top";
    for (const n of order) {
      const text = n.kind === "user" ? userLabel : n.kind === "self" ? selfLabel : n.name;
      const size = (n.id === focus ? 12.5 : 11) / Math.max(0.75, k);
      g.font = `${n.id === focus || n.id === selected ? "600 " : ""}${size}px ui-sans-serif, system-ui`;
      const w = g.measureText(text).width;
      const h = size + 2 / k;
      const x = n.x!, y = n.y!;
      const spots: Box[] = [
        [x - w / 2 - pad, y + n.r + pad, x + w / 2 + pad, y + n.r + pad + h],
        [x - w / 2 - pad, y - n.r - pad - h, x + w / 2 + pad, y - n.r - pad],
        [x + n.r + pad, y - h / 2, x + n.r + pad * 3 + w, y + h / 2],
        [x - n.r - pad * 3 - w, y - h / 2, x - n.r - pad, y + h / 2],
      ];
      const forced = must(n);
      const free = (b: Box) => !taken.some((t) => overlaps(b, t)) && !dots.some((d, i) => data.current.nodes[i] !== n && overlaps(b, d));
      const spot = spots.find(free) ?? (forced ? spots[0] : null);
      if (!spot) continue;
      taken.push(spot);
      g.globalAlpha = Math.max(forced ? 0.85 : 0.4, alphaOf(n));
      g.fillStyle = paper;
      g.fillRect(spot[0], spot[1], spot[2] - spot[0], spot[3] - spot[1]);
      g.fillStyle = ink;
      g.textAlign = "left";
      g.fillText(text, spot[0] + pad, spot[1] + 1 / k);
    }
    g.globalAlpha = 1;
  };

  useEffect(() => draw.current(), [selected, highlight, fade]); // eslint-disable-line react-hooks/exhaustive-deps
  // a new size: fit again, or (once she has moved the map) keep its middle in the middle
  const lastSize = useRef({ width, height });
  useEffect(() => {
    const was = lastSize.current;
    lastSize.current = { width, height };
    if (!touched.current) fit();
    else {
      view.current.x += (width - was.width) / 2;
      view.current.y += (height - was.height) / 2;
      draw.current();
    }
  }, [width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  // interaction
  const toWorld = (cx: number, cy: number) => {
    const { x, y, k } = view.current;
    return [(cx - x) / k, (cy - y) / k];
  };
  const hit = (cx: number, cy: number): N | null => {
    const [wx, wy] = toWorld(cx, cy);
    let best: N | null = null, bd = Infinity;
    for (const n of data.current.nodes) {
      const d = Math.hypot((n.x ?? 0) - wx, (n.y ?? 0) - wy);
      if (d < n.r + 6 / view.current.k && d < bd) {
        best = n;
        bd = d;
      }
    }
    return best;
  };
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    let drag: { node: N | null; x: number; y: number; moved: boolean } | null = null;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch: number | null = null;
    const pos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const down = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      pts.set(e.pointerId, { x, y });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        drag = null;
        return;
      }
      const n = hit(x, y);
      drag = { node: n, x, y, moved: false };
      if (n) {
        n.fx = n.x;
        n.fy = n.y;
      }
    };
    const move = (e: PointerEvent) => {
      const [x, y] = pos(e);
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x, y });
      if (pinch != null && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch);
        pinch = d;
        return;
      }
      if (!drag) {
        const n = hit(x, y);
        const id = n ? n.id : null;
        if (id !== hover.current) {
          hover.current = id;
          c.style.cursor = id ? "pointer" : "grab";
          draw.current();
        }
        if (n) {
          const v = view.current;
          const cy = (n.y ?? 0) * v.k + v.y;
          setTip({ node: n, x: (n.x ?? 0) * v.k + v.x, top: cy - n.r * v.k, bottom: cy + n.r * v.k });
        } else setTip(null);
        return;
      }
      const dx = x - drag.x, dy = y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved && !drag.node) touched.current = true;
      if (drag.moved) setTip(null);
      if (drag.node) {
        const [wx, wy] = toWorld(x, y);
        drag.node.fx = wx;
        drag.node.fy = wy;
        sim.current?.alphaTarget(0.15).restart();
      } else {
        view.current.x += dx;
        view.current.y += dy;
        drag.x = x;
        drag.y = y;
        draw.current();
      }
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!drag) return;
      if (drag.node) {
        drag.node.fx = null;
        drag.node.fy = null;
        sim.current?.alphaTarget(0);
      }
      if (!drag.moved) onSelect(drag.node ? drag.node.id : null);
      drag = null;
    };
    const zoomAt = (cx: number, cy: number, f: number) => {
      touched.current = true;
      const v = view.current;
      const k = Math.min(4, Math.max(0.12, v.k * f));
      v.x = cx - ((cx - v.x) / v.k) * k;
      v.y = cy - ((cy - v.y) / v.k) * k;
      v.k = k;
      draw.current();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setTip(null);
      const r = c.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    const leave = () => {
      setTip(null);
      if (hover.current) {
        hover.current = null;
        draw.current();
      }
    };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", leave);
    c.addEventListener("wheel", wheel, { passive: false });
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
      c.removeEventListener("pointerleave", leave);
      c.removeEventListener("wheel", wheel);
    };
  }, [onSelect, width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setTick((n) => n + 1), [nodes]);

  return (
    <div ref={wrap} className="mem-graph relative w-full overflow-hidden rounded-xl border border-border bg-surface/60" style={{ height }} data-testid="memory-graph">
      <canvas ref={canvas} style={{ width, height, touchAction: "none", cursor: "grab" }} aria-label={label} role="img" />
      {controls && (
        <div className="absolute right-2 top-2 flex flex-col gap-1" data-testid="memory-graph-controls">
          {([["plus", controls.zoomIn, () => zoomBy(1.3), "memory-graph-zoom-in"], ["minus", controls.zoomOut, () => zoomBy(1 / 1.3), "memory-graph-zoom-out"],
            ["crosshair", controls.fit, refit, "memory-graph-fit"]] as const).map(([icon, title, act, id]) => (
            <button key={id} type="button" className="mem-graph-btn" onClick={act} title={title} aria-label={title} data-testid={id}>
              <Icon name={icon} size={14} />
            </button>
          ))}
          {controls.extra}
        </div>
      )}
      {tip && tooltip && (
        // (above the dot; below it when the dot is near the top)
        <div className={`pointer-events-none absolute z-10 w-max max-w-[15rem] -translate-x-1/2 rounded-lg border border-border bg-surface-2/95 px-2.5 py-1.5 text-[11.5px] shadow-lg backdrop-blur ${tip.top > 96 ? "-translate-y-full" : ""}`}
          style={{ left: Math.min(width - 100, Math.max(100, tip.x)), top: tip.top > 96 ? tip.top - 8 : tip.bottom + 8 }} data-testid="memory-graph-tooltip">
          {tooltip(tip.node)}
        </div>
      )}
    </div>
  );
});

export default MemoryGraph;
