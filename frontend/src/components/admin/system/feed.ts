// Live system feed: one WebSocket while the System tab is on screen.
// No polling — the server pushes a sample every 2 s; the socket is closed
// while the browser tab is hidden and reopened (fresh "hello") on return.
import { useEffect } from "react";
import { create } from "zustand";
import { wsUrl } from "../../../api/client";
import type { Columns, Hello, MonEvent, Snapshot, Thresholds } from "../../../api/system";

export const LIVE_POINTS = 450; // 15 min at 2 s
const CORE_COLS = 150;
const PROC_POINTS = 150;

export type FeedStatus = "connecting" | "live" | "hidden" | "offline";

export interface LiveCols {
  t: number[];
  s: Record<string, (number | null)[]>;
}

interface FeedState {
  status: FeedStatus;
  paused: boolean;
  now: Snapshot | null;
  live: LiveCols;
  cores: number[][];
  procHist: Record<string, number[]>;
  events: MonEvent[];
  thresholds: Thresholds | null;
  queue: Snapshot[]; // samples that arrived while paused
  lastAt: number; // ms, when the last sample arrived
  setPaused: (p: boolean) => void;
}

const empty: LiveCols = { t: [], s: {} };

export const useFeed = create<FeedState>((set, get) => ({
  status: "connecting",
  paused: false,
  now: null,
  live: empty,
  cores: [],
  procHist: {},
  events: [],
  thresholds: null,
  queue: [],
  lastAt: 0,
  setPaused: (p) => {
    if (p) return set({ paused: true });
    const { queue } = get();
    set({ paused: false, queue: [] });
    queue.forEach(apply);
  },
}));

function fromColumns(c: Columns): LiveCols {
  const s: LiveCols["s"] = {};
  for (const [k, v] of Object.entries(c.series)) s[k] = v.avg.slice(-LIVE_POINTS);
  return { t: c.t.slice(-LIVE_POINTS), s };
}

function apply(snap: Snapshot) {
  const st = useFeed.getState();
  const { live } = st;
  const n = live.t.length;
  const drop = n >= LIVE_POINTS ? n - LIVE_POINTS + 1 : 0;
  const t = [...live.t.slice(drop), snap.ts];
  const s: LiveCols["s"] = {};
  const keys = new Set([...Object.keys(live.s), ...Object.keys(snap.m)]);
  keys.forEach((k) => {
    const prev = live.s[k] || new Array(n).fill(null);
    const v = snap.m[k];
    s[k] = [...prev.slice(drop), v === undefined ? null : v];
  });
  const cores = [...st.cores, snap.cores.map((x) => Math.round(x))].slice(-CORE_COLS);
  const procHist: Record<string, number[]> = {};
  for (const p of snap.procs) {
    const h = st.procHist[p.key] || [];
    procHist[p.key] = [...h, Math.round(p.rss_tree / 1048576)].slice(-PROC_POINTS);
  }
  useFeed.setState({ now: snap, live: { t, s }, cores, procHist, lastAt: Date.now() });
}

function onMessage(raw: string) {
  let msg: { type: string; data: any };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    const h = msg.data as Hello;
    useFeed.setState({
      status: "live",
      now: h.now,
      live: fromColumns(h.ring),
      cores: h.cores.slice(-CORE_COLS),
      procHist: h.proc_hist,
      events: h.events.slice(-50),
      thresholds: h.thresholds,
      queue: [],
      lastAt: Date.now(),
    });
  } else if (msg.type === "sample") {
    const st = useFeed.getState();
    if (st.paused) useFeed.setState({ queue: [...st.queue, msg.data].slice(-LIVE_POINTS), lastAt: Date.now() });
    else apply(msg.data as Snapshot);
  } else if (msg.type === "event") {
    const ev = msg.data as MonEvent;
    useFeed.setState((s) => ({ events: [...s.events, ev].slice(-50) }));
  }
}

/** Keep the live socket open while the caller is mounted and the tab visible. */
export function useSystemFeed() {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let backoff = 1000;

    const close = () => {
      if (ping) clearInterval(ping);
      ping = undefined;
      if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
      }
    };

    const open = () => {
      if (!alive || ws || document.hidden) return;
      useFeed.setState({ status: "connecting" });
      const sock = new WebSocket(wsUrl("/ws/admin/system"));
      ws = sock;
      sock.onmessage = (e) => {
        backoff = 1000;
        onMessage(e.data);
      };
      sock.onopen = () => {
        ping = setInterval(() => sock.readyState === 1 && sock.send('{"type":"ping"}'), 25_000);
      };
      sock.onclose = () => {
        if (ping) clearInterval(ping);
        ws = null;
        if (!alive) return;
        if (document.hidden) return useFeed.setState({ status: "hidden" });
        useFeed.setState({ status: "offline" });
        retry = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };
    };

    const onVisibility = () => {
      if (document.hidden) {
        close();
        useFeed.setState({ status: "hidden" });
      } else {
        clearTimeout(retry);
        open();
      }
    };

    open();
    if (document.hidden) useFeed.setState({ status: "hidden" });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    };
  }, []);
}
