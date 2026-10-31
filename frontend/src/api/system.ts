// System monitor (Admin -> System): snapshot, history ranges, live feed.
// Backend: backend/app/services/sysmon, docs/monitoring.md.
import { apiFetch } from "./client";

export type RangeId = "15m" | "30m" | "1h" | "6h" | "24h" | "7d" | "30d" | "90d";

/** Flat metrics of one sample (bytes, bytes/s, %, °C, W). GPU keys are
 * per index: g0_util, g0_mem, g0_memt, g0_temp, g0_pwr. */
export type Metrics = Record<string, number>;

export interface MonProc {
  key: string;
  kind: "backend" | "engine" | "run" | "child";
  pid: number;
  name: string;
  cmd: string;
  state: string;
  title?: string;
  rss: number;
  rss_tree: number;
  cpu: number;
  cpu_tree: number;
  threads: number;
  nprocs: number;
  uptime_s: number;
  session_id?: string;
  session_kind?: string;
  provider?: string;
  model?: string | null;
  mode?: string | null;
  account?: string | null;
  working?: boolean;
  idle_s?: number | null;
  tasks?: number;
  tools?: number | null;
  cost_usd?: number | null;
}

export interface MonGpu {
  index: number;
  name: string;
  vendor: "nvidia" | "amd";
  util: number | null;
  mem_used: number | null;
  mem_total: number | null;
  temp: number | null;
  power: number | null;
  power_limit: number | null;
}

export interface MonDisk {
  label: string;
  path: string;
  total: number;
  used: number;
  free: number;
  pct: number;
}

export interface MonAlert {
  key: string;
  level: "warn" | "crit";
  since: number;
  value: number;
  peak: number;
  warn: number;
  crit: number | null;
}

export interface MonEvent {
  id: number | null;
  ts: string;
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  source?: string;
}

export interface MonRun {
  session_id: string;
  title: string;
  provider: string;
  model: string;
  started_at: string;
  tools: number;
  attachments: number;
  account?: string;
  connection_id: string | null;
  workspace: string;
}

export interface Guard {
  name: string;
  path: string | null;
  avail_min: number | null;
  avail_hard: number | null;
  psi_full: number;
  user_ceiling: number | null;
  readme: string | null;
}

export interface SamplerStats {
  ticks: number;
  interval_s: number;
  last_ms: number;
  avg_cpu_ms: number;
  avg_wall_ms: number;
  push_cpu_ms: number;
  cpu_pct: number;
  ring: number;
  ring_capacity: number;
  subscribers: number;
  rows_1m: number;
  rows_15m: number;
  gpu_source: string;
}

export interface Snapshot {
  ts: number;
  interval: number;
  m: Metrics;
  cores: number[];
  cpu: { count: number; model: string; runnable: number; threads: number; blocked: number | null; btime: number | null; quota: number | null };
  mem: {
    total: number; available: number; used: number; free: number; cache: number; shmem: number; dirty: number;
    swap_total: number; swap_used: number; swap_cached: number;
  };
  cgroup: {
    path: string; version: number; current: number | null; max: number | null; peak: number | null;
    working_set: number | null; anon: number | null; file: number | null; swap: number | null;
    events: Record<string, number>; cpu_quota: number | null; limit_path: string | null;
    limit_max: number | null; limit_current: number | null;
  } | null;
  pressure: Record<string, Record<string, Record<string, number>>> | null;
  disks: MonDisk[];
  io: { read: number; write: number; busy: number };
  net: { rx: number; tx: number; ifaces: string[]; rx_total: number; tx_total: number };
  gpus: MonGpu[];
  gpu_source: string;
  gpu_error: string | null;
  procs: MonProc[];
  zombies: number;
  runs: MonRun[];
  engines: Record<string, unknown>[];
  host: { hostname: string; kernel: string; cpu_model: string; in_container: boolean };
  guard: Guard | null;
  uptime_s: number;
  alerts: MonAlert[];
  sampler: SamplerStats;
}

export interface Thresholds {
  mem_warn: number;
  mem_crit: number;
  disk_warn: number;
  disk_crit: number;
  engine_rss: number;
  cpu_sat: number;
  cpu_sat_s: number;
  gpu_temp: number;
  swap_growth: number;
  swap_warn: number;
  psi_full_warn: number;
}

/** Columnar series: t[i] (epoch s) with series[key].avg[i] (min/max on history). */
export interface Columns {
  t: number[];
  series: Record<string, { avg: (number | null)[]; min?: (number | null)[]; max?: (number | null)[] }>;
}

export interface MetricsRange extends Columns {
  range: RangeId;
  source: string;
  step: number;
  from: number;
  to: number;
  events: MonEvent[];
  thresholds: Thresholds;
}

export interface Hello {
  now: Snapshot | null;
  ring: Columns;
  cores: number[][];
  proc_hist: Record<string, number[]>;
  events: MonEvent[];
  ranges: RangeId[];
  thresholds: Thresholds;
}

export const systemNow = () => apiFetch<Snapshot>("/api/admin/system/now");
export const systemMetrics = (range: RangeId) =>
  apiFetch<MetricsRange>(`/api/admin/system/metrics?range=${range}`);
export const monitorEvents = (limit = 40) =>
  apiFetch<{ items: MonEvent[]; has_more: boolean }>(`/api/admin/logs?source=monitor&limit=${limit}`);
