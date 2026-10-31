// The time-series cards: CPU (+ per-core heat), memory, Geny's processes,
// network, disk IO, pressure, GPUs. Every card: legend with current values,
// one y-axis, crosshair tooltip, event markers.
import type { ReactNode } from "react";
import type { Snapshot, Thresholds } from "../../../api/system";
import Icon, { type IconName } from "../../ui/Icon";
import { useFeed } from "./feed";
import { axisBytes, bytes, C1, C2, C3, C4, niceBytes, niceMax, pct, rate } from "./fmt";
import { CoreHeat, rampColor } from "./Spark";
import TimeChart, { type ChartSeries, type RefLine } from "./TimeChart";
import type { Ser, View } from "./view";

function Legend({ items }: { items: { label: string; color: string; value?: string; kind?: "area" | "line" }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-dim">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {it.kind === "line" ? (
            <span className="h-[2px] w-3 rounded" style={{ background: it.color }} />
          ) : (
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: it.color }} />
          )}
          {it.label}
          {it.value !== undefined && <span className="font-medium text-content tabular-nums">{it.value}</span>}
        </span>
      ))}
    </div>
  );
}

export function ChartCard({ title, icon, legend, children, right, dim, wide }: {
  title: string; icon: IconName; legend?: ReactNode; children: ReactNode; right?: ReactNode; dim?: boolean; wide?: boolean;
}) {
  return (
    <section className={`card p-3.5 sm:p-4 min-w-0 ${wide ? "lg:col-span-2" : ""}`}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="inline-flex items-center gap-2 text-[13px] font-semibold text-content">
          <Icon name={icon} size={14} className="text-accent" /> {title}
        </h3>
        {right && <div className="ml-auto text-[11px] text-content-faint">{right}</div>}
      </div>
      {legend && <div className="mb-2">{legend}</div>}
      <div className={`transition-opacity duration-300 ${dim ? "opacity-50" : ""}`}>{children}</div>
    </section>
  );
}

const last = (s: Ser) => {
  for (let i = s.avg.length - 1; i >= 0; i--) if (s.avg[i] !== null && s.avg[i] !== undefined) return s.avg[i] as number;
  return null;
};

const ser = (v: View, key: string, label: string, color: string, extra: Partial<ChartSeries> = {}): ChartSeries => {
  const s = v.get(key);
  return { key, label, color, values: s.avg, min: s.min, max: s.max, ...extra };
};

/** Derived series (a - b - c …) on the same time base. */
function minus(v: View, key: string, ...sub: string[]): Ser {
  const base = v.get(key).avg;
  const subs = sub.map((k) => v.get(k).avg);
  return {
    avg: base.map((x, i) => (x === null ? null : Math.max(0, x - subs.reduce((acc, s) => acc + (s[i] ?? 0), 0)))),
  };
}

function ratio(v: View, a: string, b: string): Ser {
  const x = v.get(a);
  const y = v.get(b).avg;
  const r = (arr?: (number | null)[]) => arr?.map((n, i) => (n === null || !y[i] ? null : (n * 100) / (y[i] as number)));
  return { avg: r(x.avg)!, min: r(x.min), max: r(x.max) };
}

const H = typeof window !== "undefined" && window.innerWidth < 640 ? 132 : 150;

export default function Charts({ v, now, th }: { v: View; now: Snapshot | null; th: Thresholds | null }) {
  const cores = useFeed((s) => s.cores);
  const common = { t: v.t, domain: v.domain, step: v.step, live: v.live, markers: v.markers, height: H };
  const total = now?.mem.total || last(v.get("mem_total")) || 1;
  const guard = now?.guard;
  const steal = v.get("cpu_steal").avg.some((x) => (x ?? 0) > 0.5);

  // ---- CPU
  const cpuSeries: ChartSeries[] = [
    ser(v, "cpu_user", "User", C1, { kind: "area", stack: true, fmt: (x) => pct(x, 1) }),
    ser(v, "cpu_system", "System", C2, { kind: "area", stack: true, fmt: (x) => pct(x, 1) }),
    ser(v, "cpu_iowait", "IO wait", C3, { kind: "area", stack: true, fmt: (x) => pct(x, 1) }),
    ...(steal ? [ser(v, "cpu_steal", "Steal", C4, { kind: "area", stack: true, fmt: (x) => pct(x, 1) })] : []),
  ];

  // ---- memory
  const memRefs: RefLine[] = [];
  if (guard?.avail_min) memRefs.push({ value: total - guard.avail_min, label: `memguard (avail < ${bytes(guard.avail_min)})`, tone: "danger" });
  const cgLimit = now?.cgroup?.max;
  if (cgLimit) memRefs.push({ value: cgLimit, label: "container limit", tone: "warn" });
  const memSeries: ChartSeries[] = [
    ser(v, "mem_used", "Used", C1, { kind: "area", stack: true, fmt: (x) => bytes(x) }),
    { key: "cache", label: "Cache", color: C2, values: v.get("mem_cache").avg, kind: "area", stack: true, fmt: (x) => bytes(x) },
    ser(v, "cg_mem", "Geny container", C3, { fmt: (x) => bytes(x) }),
    ser(v, "swap_used", "Swap", C4, { fmt: (x) => bytes(x) }),
  ];

  // ---- Geny processes
  const procSeries: ChartSeries[] = [
    ser(v, "be_rss", "Backend", C1, { kind: "area", stack: true, fmt: (x) => bytes(x) }),
    ser(v, "eng_rss", "Engines", C2, { kind: "area", stack: true, fmt: (x) => bytes(x) }),
    { key: "other", label: "Other children", color: C3, values: minus(v, "tree_rss", "be_rss", "eng_rss").avg, kind: "area", stack: true, fmt: (x) => bytes(x) },
  ];
  const procRefs: RefLine[] = th ? [{ value: th.engine_rss, label: "1 engine alert line", tone: "muted" }] : [];

  // ---- network / disk (mirrored: in above, out below)
  const netSeries: ChartSeries[] = [
    ser(v, "net_rx", "In", C1, { kind: "area", fmt: rate }),
    ser(v, "net_tx", "Out", C2, { kind: "area", below: true, fmt: rate }),
  ];
  const ioSeries: ChartSeries[] = [
    ser(v, "disk_read", "Read", C1, { kind: "area", fmt: rate }),
    ser(v, "disk_write", "Write", C2, { kind: "area", below: true, fmt: rate }),
  ];

  // ---- pressure
  const psiSeries: ChartSeries[] = [
    ser(v, "psi_mem", "Memory some", C1, { fmt: (x) => pct(x, 1) }),
    ser(v, "psi_mem_full", "Memory full", C2, { fmt: (x) => pct(x, 1) }),
    ser(v, "psi_cpu", "CPU some", C3, { fmt: (x) => pct(x, 1) }),
    ser(v, "psi_io", "IO some", C4, { fmt: (x) => pct(x, 1) }),
  ];
  const hasPsi = v.get("psi_cpu").avg.length > 0;

  const gpus = now?.gpus || [];
  const cur = (k: string) => last(v.get(k));
  const lv = (k: string, f: (x: number) => string) => {
    const x = cur(k);
    return x === null ? "–" : f(x);
  };
  const busyLabel = v.live ? "now" : "latest";
  // An odd number of cards: the last one spans both columns (no hole in the grid).
  const nCards = 5 + (hasPsi ? 1 : 0) + gpus.length;
  const lastWide = nCards % 2 === 1;

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <ChartCard title="CPU" icon="cpu" dim={v.loading}
        right={now ? `${now.cpu.count} cores · load ${now.m.load1?.toFixed(2)} / ${now.m.load5?.toFixed(2)} / ${now.m.load15?.toFixed(2)}` : undefined}
        legend={<Legend items={cpuSeries.map((s) => ({ label: s.label, color: s.color, value: lv(s.key, (x) => pct(x, 0)) }))} />}>
        <TimeChart {...common} label="CPU usage by state, percent" series={cpuSeries} yMax={100} yFmt={(x) => `${Math.round(x)}%`}
          extra={(i) => [
            { label: "Busy", value: pct(v.get("cpu").avg[i], 1) },
            { label: "Load 1m", value: v.get("load1").avg[i]?.toFixed(2) ?? "–" },
          ]} />
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-content-faint">
            <span>Per core · last 5 min</span>
            <span className="ml-auto inline-flex items-center gap-1">
              0%
              <span className="inline-block h-2 w-16 rounded-sm" style={{ background: `linear-gradient(90deg, ${[0, 25, 50, 75, 100].map(rampColor).join(",")})` }} />
              100%
            </span>
          </div>
          <CoreHeat cols={cores} cores={now?.cpu.count || cores[0]?.length || 1} interval={now?.interval || 2} />
        </div>
      </ChartCard>

      <ChartCard title="Memory" icon="server" dim={v.loading}
        right={now ? `${bytes(now.mem.used)} used of ${bytes(total)} · ${bytes(now.mem.available)} available` : undefined}
        legend={<Legend items={memSeries.map((s) => ({ label: s.label, color: s.color, kind: s.kind === "area" ? "area" : "line", value: lv(s.key === "cache" ? "mem_cache" : s.key, (x) => bytes(x)) }))} />}>
        <TimeChart {...common} label="Host memory: used, cache, Geny container, swap" series={memSeries} refs={memRefs}
          yMax={total} yFmt={axisBytes}
          extra={(i) => [
            { label: "Available", value: bytes(v.get("mem_avail").avg[i]) },
            { label: "Used", value: pct(((v.get("mem_used").avg[i] ?? 0) * 100) / total, 1) },
          ]} />
      </ChartCard>

      <ChartCard title="Geny processes" icon="activity" dim={v.loading}
        right={now ? `${now.m.eng_n ?? 0} engine${now.m.eng_n === 1 ? "" : "s"} · ${bytes(now.m.tree_rss)} RSS total` : undefined}
        legend={<Legend items={procSeries.map((s) => ({ label: s.label, color: s.color, value: s.key === "other" ? bytes(last({ avg: s.values })) : lv(s.key, (x) => bytes(x)) }))} />}>
        <TimeChart {...common} label="Memory of the backend, its engines and other child processes" series={procSeries}
          refs={procRefs} autoMax={(m) => niceBytes(m, 256 * 1048576)} yFmt={axisBytes}
          extra={(i) => [
            { label: "Engines", value: String(v.get("eng_n").avg[i] ?? "–") },
            { label: "Engine CPU", value: pct(v.get("eng_cpu").avg[i], 0) },
          ]} />
      </ChartCard>

      <ChartCard title="Network" icon="activity" dim={v.loading}
        right={now ? `${now.net.ifaces.join(", ") || "–"}${now.host.in_container ? " · container" : ""}` : undefined}
        legend={<Legend items={[
          { label: "In ↓", color: C1, value: lv("net_rx", rate) },
          { label: "Out ↑", color: C2, value: lv("net_tx", rate) },
        ]} />}>
        <TimeChart {...common} label="Network throughput, in above and out below the baseline" series={netSeries} mirrored
          autoMax={(m) => niceBytes(m, 16 * 1024)} yFmt={(x) => `${axisBytes(x)}/s`} />
      </ChartCard>

      <ChartCard title="Disk IO" icon="disk" dim={v.loading}
        right={`busy ${lv("disk_busy", (x) => pct(x, 0))} ${busyLabel}`}
        legend={<Legend items={[
          { label: "Read", color: C1, value: lv("disk_read", rate) },
          { label: "Write", color: C2, value: lv("disk_write", rate) },
        ]} />}>
        <TimeChart {...common} label="Disk throughput, read above and write below the baseline" series={ioSeries} mirrored
          autoMax={(m) => niceBytes(m, 64 * 1024)} yFmt={(x) => `${axisBytes(x)}/s`}
          extra={(i) => [{ label: "Busy", value: pct(v.get("disk_busy").avg[i], 0) }]} />
      </ChartCard>

      {hasPsi && (
        <ChartCard title="Pressure (PSI)" icon="clock" dim={v.loading} wide={lastWide && gpus.length === 0}
          right="share of time tasks stalled · 10 s avg"
          legend={<Legend items={psiSeries.map((s) => ({ label: s.label, color: s.color, kind: "line", value: lv(s.key, (x) => pct(x, 1)) }))} />}>
          <TimeChart {...common} label="Pressure stall information: memory, CPU and IO" series={psiSeries}
            refs={guard ? [{ value: guard.psi_full, label: "memguard (memory full)", tone: "danger" }] : []}
            autoMax={(m) => niceMax(m, 10)} yFmt={(x) => `${Math.round(x)}%`} />
        </ChartCard>
      )}

      {gpus.map((g, gi) => {
        const i = g.index;
        const memPct = ratio(v, `g${i}_mem`, `g${i}_memt`);
        return (
          <ChartCard key={i} title={`GPU ${i} · ${g.name}`} icon="monitor" dim={v.loading} wide={lastWide && gi === gpus.length - 1}
            right={g.power !== null ? `${g.power.toFixed(0)} W${g.power_limit ? ` of ${g.power_limit.toFixed(0)} W` : ""}` : undefined}
            legend={<Legend items={[
              { label: "Utilization", color: C1, kind: "line", value: lv(`g${i}_util`, (x) => pct(x, 0)) },
              { label: "Memory", color: C2, kind: "line", value: g.mem_used !== null ? `${bytes(g.mem_used)} / ${bytes(g.mem_total)}` : "–" },
              { label: "Temperature", color: C3, kind: "line", value: lv(`g${i}_temp`, (x) => `${x.toFixed(0)}°C`) },
            ]} />}>
            <TimeChart {...common} height={H - 30} label={`GPU ${i} utilization and memory, percent`}
              series={[
                ser(v, `g${i}_util`, "Utilization", C1, { fmt: (x) => pct(x, 0) }),
                { key: `g${i}_memp`, label: "Memory", color: C2, values: memPct.avg, min: memPct.min, max: memPct.max, fmt: (x) => pct(x, 1) },
              ]}
              yMax={100} yFmt={(x) => `${Math.round(x)}%`}
              extra={(idx) => [{ label: "Power", value: v.get(`g${i}_pwr`).avg[idx] != null ? `${(v.get(`g${i}_pwr`).avg[idx] as number).toFixed(0)} W` : "–" }]} />
            <div className="mt-2">
              <TimeChart {...common} height={96} label={`GPU ${i} temperature, °C`}
                series={[ser(v, `g${i}_temp`, "Temperature", C3, { fmt: (x) => `${x.toFixed(0)}°C` })]}
                refs={th ? [{ value: th.gpu_temp, label: `alert ${th.gpu_temp}°C`, tone: "warn" }] : []}
                autoMax={(m) => niceMax(Math.max(m, th?.gpu_temp ?? 90) + 5)} yFmt={(x) => `${Math.round(x)}°`} />
            </div>
          </ChartCard>
        );
      })}
    </div>
  );
}
