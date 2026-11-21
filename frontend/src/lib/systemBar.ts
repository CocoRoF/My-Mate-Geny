/**
 * The usage bar under the mate and chat conversations (components/layout/SystemBar.tsx, docs/monitoring.md "Usage bar"):
 * whether it shows on this device, and its numbers.
 *
 * - On / off: this device only (localStorage `hrh_system_bar`, every tab and desktop window of this browser at once;
 *   Settings → 테마). On by default; its ✕ turns it off until it is turned on there again.
 * - The numbers: one WebSocket for every bar on the page (`/ws/system/bar`: a few numbers every 2 s), open only while a
 *   bar is on screen and the page is visible; closed when hidden, reopened on return.
 */
import { create } from "zustand";
import { wsUrl } from "../api/client";

export const SYSTEM_BAR_KEY = "hrh_system_bar";

export interface BarGpu {
  name: string;
  util: number | null;
  /** [used, total] bytes */
  mem: [number | null, number | null];
  temp: number | null;
  power: number | null;
}

export interface BarSample {
  ts: number;
  interval: number;
  host: string;
  cpu: number | null;
  cores: number | null;
  /** [used, total] bytes — used = total − available */
  mem: [number | null, number | null];
  swap: [number | null, number | null] | null;
  gpus: BarGpu[];
  /** [rx, tx] bytes/s */
  net: [number | null, number | null];
  /** Geny's own process tree: memory (bytes), CPU % of one core */
  geny: { rss: number | null; cpu: number | null } | null;
  alerts: number;
}

/** the last minute, for the little graphs */
export const HISTORY = 30;

const GB = 1024 ** 3;

export const pct = (used: number | null, total: number | null) => (used != null && total ? (used / total) * 100 : null);

/** bytes as GB with one decimal (none from 100 GB) */
export const gb = (n: number | null) => (n == null ? "–" : (n / GB).toFixed(n >= 100 * GB ? 0 : 1));

/** bytes/s, the unit following the size */
export function rate(n: number | null): string {
  if (n == null) return "–";
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB/s`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB/s`;
  return `${Math.round(n)} B/s`;
}

/** how loaded a meter reads: calm below 75 %, a warning from 75, alarming from 90 */
export function level(p: number | null): "ok" | "warn" | "high" {
  return p == null || p < 75 ? "ok" : p < 90 ? "warn" : "high";
}

/** what fits: narrow — CPU, RAM, GPU as %; medium — + RAM in GB, VRAM %, temperature; normal — + the CPU line, VRAM in
 *  GB; wide — + the machine's name, a second GPU, the network, Geny's own memory */
export type Room = "narrow" | "medium" | "normal" | "wide";

export function roomFor(width: number): Room {
  return width < 460 ? "narrow" : width < 760 ? "medium" : width < 1000 ? "normal" : "wide";
}

function readOn(): boolean {
  try {
    return localStorage.getItem(SYSTEM_BAR_KEY) !== "0";
  } catch {
    return true;
  }
}

interface BarState {
  /** shown on this device */
  on: boolean;
  setOn: (on: boolean) => void;
  status: "connecting" | "live" | "off" | "offline";
  last: BarSample | null;
  /** CPU and each GPU's load over the last minute */
  cpuHist: number[];
  gpuHist: number[][];
}

export const useSystemBar = create<BarState>((set) => ({
  on: typeof localStorage !== "undefined" ? readOn() : true,
  setOn: (on) => {
    try {
      localStorage.setItem(SYSTEM_BAR_KEY, on ? "1" : "0");
    } catch {
      /* private mode: this page only */
    }
    set({ on });
  },
  status: "connecting",
  last: null,
  cpuHist: [],
  gpuHist: [],
}));

if (typeof window !== "undefined") {
  // (another tab or desktop window turned it on or off)
  window.addEventListener("storage", (e) => {
    if (e.key === SYSTEM_BAR_KEY) useSystemBar.setState({ on: readOn() });
  });
}

const push = (xs: number[], v: number | null) => (v == null ? xs : [...xs.slice(-(HISTORY - 1)), v]);

export function applySample(s: BarSample) {
  const st = useSystemBar.getState();
  const gpuHist = s.gpus.map((g, i) => push(st.gpuHist[i] ?? [], g.util));
  useSystemBar.setState({ last: s, status: "live", cpuHist: push(st.cpuHist, s.cpu), gpuHist });
}

// ── the one socket, shared by every bar on screen ──

let users = 0;
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let ping: ReturnType<typeof setInterval> | undefined;
let backoff = 1000;

function open() {
  if (ws || users === 0 || document.hidden) return;
  useSystemBar.setState((s) => ({ status: s.last ? s.status : "connecting" }));
  const sock = new WebSocket(wsUrl("/ws/system/bar"));
  ws = sock;
  sock.onmessage = (e) => {
    let msg: { type?: string; data?: BarSample };
    try {
      msg = JSON.parse(e.data as string);
    } catch {
      return;
    }
    if (msg.type === "bar" && msg.data) {
      backoff = 1000;
      applySample(msg.data);
    } else if (msg.type === "off") {
      useSystemBar.setState({ status: "off", last: null });
    }
  };
  sock.onopen = () => {
    ping = setInterval(() => sock.readyState === 1 && sock.send('{"type":"ping"}'), 25_000);
  };
  sock.onclose = () => {
    clearInterval(ping);
    if (ws === sock) ws = null;
    if (users === 0 || document.hidden || useSystemBar.getState().status === "off") return;
    useSystemBar.setState({ status: "offline" });
    retry = setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 15_000);
  };
}

function close() {
  clearTimeout(retry);
  clearInterval(ping);
  const sock = ws;
  ws = null;
  if (sock) {
    sock.onclose = null;
    sock.close();
  }
}

function onVisibility() {
  if (document.hidden) close();
  else {
    // (a minute away: the little graphs would draw a jump across it)
    useSystemBar.setState({ cpuHist: [], gpuHist: [] });
    open();
  }
}

/** a bar came on screen: the socket opens with the first one; returns its goodbye (closes with the last one) */
export function watchSystem(): () => void {
  users += 1;
  if (users === 1) {
    document.addEventListener("visibilitychange", onVisibility);
    open();
  }
  return () => {
    users -= 1;
    if (users === 0) {
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    }
  };
}
