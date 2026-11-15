/**
 * Her memory network drawn (docs/mate-memory-graph.md "The map"): a force layout (d3-force) on a canvas. Colour is
 * what a thing is, size how much she knows of it, and — with fading on — opacity how readily it comes to her mind now:
 * what she used lately glows, what she hasn't thought of in a long time fades. Links: facts (solid, labelled), her
 * memories of the user (dashed), things that happened together (dotted).
 *
 * Wheel / pinch zooms, dragging the background pans, dragging a node moves it, a click selects. Positions are kept per
 * mate (localStorage), so the map stays where it was between visits.
 */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";
import type { GraphKind, GraphLink, GraphNode } from "../../../api/mates";

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
}>(function MemoryGraph({ mateId, nodes, links, selected, onSelect, highlight, fade = true, height, userLabel, selfLabel, label }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sim = useRef<Simulation<N, L> | null>(null);
  const view = useRef({ x: 300, y: height / 2, k: 1 });
  // (until she pans or zooms, the map keeps itself in view: on open, on a resize, when the layout settles)
  const touched = useRef(false);
  const data = useRef<{ nodes: N[]; links: L[] }>({ nodes: [], links: [] });
  const hover = useRef<string | null>(null);
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
      .force("link", forceLink<N, L>(ls).id((d) => d.id).distance((l) => (l.kind === "fact" ? 70 : 55) + ((l.source as N).r + (l.target as N).r)).strength((l) => (l.kind === "fact" ? 0.5 : 0.25)))
      .force("charge", forceManyBody<N>().strength((d) => (d.kind === "user" ? -500 : -140)).distanceMax(500))
      .force("collide", forceCollide<N>().radius((d) => d.r + 6))
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

  useImperativeHandle(ref, () => ({
    fit: () => {
      touched.current = false;
      fit();
    },
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
    const ranked = [...data.current.nodes].sort((a, b) => b.r - a.r);
    const labelled = new Set(ranked.slice(0, k > 1.4 ? 80 : k > 0.8 ? 35 : 15).map((n) => n.id));
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
    // labels on top
    g.textAlign = "center";
    g.textBaseline = "top";
    for (const n of data.current.nodes) {
      if (n.x == null) continue;
      const show = n.id === focus || n.id === selected || (near && near.has(n.id)) || labelled.has(n.id) || (highlight && highlight.has(n.id));
      if (!show) continue;
      const text = n.kind === "user" ? userLabel : n.kind === "self" ? selfLabel : n.name;
      const size = (n.id === focus ? 12.5 : 11) / Math.max(0.75, k);
      g.font = `${n.id === focus ? "600 " : ""}${size}px ui-sans-serif, system-ui`;
      const w = g.measureText(text).width;
      const y = n.y! + n.r + 3 / k;
      g.globalAlpha = Math.max(0.35, alphaOf(n));
      g.fillStyle = paper;
      g.fillRect(n.x - w / 2 - 3 / k, y - 1 / k, w + 6 / k, size + 3 / k);
      g.fillStyle = ink;
      g.fillText(text, n.x, y);
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
        return;
      }
      const dx = x - drag.x, dy = y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved && !drag.node) touched.current = true;
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
      const r = c.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    const leave = () => {
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
    </div>
  );
});

export default MemoryGraph;
