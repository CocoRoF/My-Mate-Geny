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
import { useT } from "../../../i18n";

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
  const t = useT();
  const cores = useFeed((s) => s.cores);
  const common = { t: v.t, domain: v.domain, step: v.step, live: v.live, markers: v.markers, height: H };
  const total = now?.mem.total || last(v.get("mem_total")) || 1;
  const guard = now?.guard;
  const steal = v.get("cpu_steal").avg.some((x) => (x ?? 0) > 0.5);

  // ---- CPU
  const cpuSeries: ChartSeries[] = [
    ser(v, "cpu_user", t("admin.cpuUser"), C1, { kind: "area", stack: true, fmt: (x) => pct(x, 1) }),
    ser(v, "cpu_system", t("admin.cpuSystem"), C2, { kind: "area", stack: true, fmt: (x) => pct(x, 1) }),
    ser(v, "cpu_iowait", t("admin.cpuIowait"), C3, { kind: "area", stack: true, fmt: (x) => pct(x, 1) }),
    ...(steal ? [ser(v, "cpu_steal", t("admin.cpuSteal"), C4, { kind: "area", stack: true, fmt: (x) => pct(x, 1) })] : []),
  ];

  // ---- memory
  const memSeries: ChartSeries[] = [
    ser(v, "mem_non_cache", t("admin.memNonCache"), C1, { kind: "area", stack: true, fmt: (x) => bytes(x) }),
    // Older history has no physical-occupancy sample. Leave a gap rather than inventing one.
    { key: "mem_cache", label: t("admin.memCache"), color: C2, values: v.get("mem_cache").avg.map((x,i)=>v.get("mem_non_cache").avg[i]==null?null:x), kind: "area", stack: true, fmt: (x) => bytes(x) },
  ];

  // ---- Geny processes
  const procSeries: ChartSeries[] = [
    ser(v, "be_rss", t("admin.backend"), C1, { kind: "area", stack: true, fmt: (x) => bytes(x) }),
    ser(v, "eng_rss", t("admin.engines"), C2, { kind: "area", stack: true, fmt: (x) => bytes(x) }),
    { key: "other", label: t("admin.otherChildren"), color: C3, values: minus(v, "tree_rss", "be_rss", "eng_rss").avg, kind: "area", stack: true, fmt: (x) => bytes(x) },
  ];
  const procRefs: RefLine[] = th ? [{ value: th.engine_rss, label: t("admin.engineAlertLine"), tone: "muted" }] : [];

  // ---- network / disk (mirrored: in above, out below)
  const netSeries: ChartSeries[] = [
    ser(v, "net_rx", t("admin.netIn"), C1, { kind: "area", fmt: rate }),
    ser(v, "net_tx", t("admin.netOut"), C2, { kind: "area", below: true, fmt: rate }),
  ];
  const ioSeries: ChartSeries[] = [
    ser(v, "disk_read", t("admin.diskRead"), C1, { kind: "area", fmt: rate }),
    ser(v, "disk_write", t("admin.diskWrite"), C2, { kind: "area", below: true, fmt: rate }),
  ];

  // ---- pressure
  const psiSeries: ChartSeries[] = [
    ser(v, "psi_mem", t("admin.psiMemSome"), C1, { fmt: (x) => pct(x, 1) }),
    ser(v, "psi_mem_full", t("admin.psiMemFull"), C2, { fmt: (x) => pct(x, 1) }),
    ser(v, "psi_cpu", t("admin.psiCpuSome"), C3, { fmt: (x) => pct(x, 1) }),
    ser(v, "psi_io", t("admin.psiIoSome"), C4, { fmt: (x) => pct(x, 1) }),
  ];
  const hasPsi = v.get("psi_cpu").avg.length > 0;

  const gpus = now?.gpus || [];
  const cur = (k: string) => last(v.get(k));
  const lv = (k: string, f: (x: number) => string) => {
    const x = cur(k);
    return x === null ? "–" : f(x);
  };
  const busyLabel = v.live ? t("admin.busyNow") : t("admin.busyLatest");
  // An odd number of cards: the last one spans both columns (no hole in the grid).
  const nCards = 5 + (hasPsi ? 1 : 0) + gpus.length;
  const lastWide = nCards % 2 === 1;

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <ChartCard title="CPU" icon="cpu" dim={v.loading}
        right={now ? t("admin.cpuRight", { cores: now.cpu.count, l1: now.m.load1?.toFixed(2), l5: now.m.load5?.toFixed(2), l15: now.m.load15?.toFixed(2) }) : undefined}
        legend={<Legend items={cpuSeries.map((s) => ({ label: s.label, color: s.color, value: lv(s.key, (x) => pct(x, 0)) }))} />}>
        <TimeChart {...common} label={t("admin.cpuChart")} series={cpuSeries} yMax={100} yFmt={(x) => `${Math.round(x)}%`}
          extra={(i) => [
            { label: t("admin.busy"), value: pct(v.get("cpu").avg[i], 1) },
            { label: t("admin.load1m"), value: v.get("load1").avg[i]?.toFixed(2) ?? "–" },
          ]} />
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-content-faint">
            <span>{t("admin.perCore5min")}</span>
            <span className="ml-auto inline-flex items-center gap-1">
              0%
              <span className="inline-block h-2 w-16 rounded-sm" style={{ background: `linear-gradient(90deg, ${[0, 25, 50, 75, 100].map(rampColor).join(",")})` }} />
              100%
            </span>
          </div>
          <CoreHeat cols={cores} cores={now?.cpu.count || cores[0]?.length || 1} interval={now?.interval || 2} />
        </div>
      </ChartCard>

      <ChartCard title={t("admin.serverMemory")} icon="server" dim={v.loading}
        right={now ? t("admin.memRight", { used: bytes(now.mem.occupied??now.mem.total-now.mem.free), total: bytes(total), free: bytes(now.mem.free) }) : undefined}
        legend={<Legend items={memSeries.map((s) => ({ label: s.label, color: s.color, kind: "area", value: lv(s.key, (x) => bytes(x)) }))} />}>
        <TimeChart {...common} label={t("admin.memChart")} series={memSeries}
          yMax={total} yFmt={axisBytes}
          extra={(i) => [
            { label: t("admin.memOccupied"), value: bytes(v.get("mem_occupied").avg[i]) },
            { label: t("admin.memFree"), value: bytes(v.get("mem_free").avg[i]) },
            { label: t("admin.available"), value: bytes(v.get("mem_avail").avg[i]) },
          ]} />
        {now&&<div className="mt-3 space-y-2 text-[11px] text-content-dim" data-testid="host-memory-summary">
          <p>{t("admin.memAvailableSummary",{available:bytes(now.mem.available),free:bytes(now.mem.free)})}</p>
          <p className="text-content-faint">{t("admin.memAvailableHint")}</p>
        </div>}
      </ChartCard>

      <ChartCard title={t("admin.genyProcesses")} icon="activity" dim={v.loading}
        right={now ? t("admin.procRight", { count: now.m.eng_n ?? 0, rss: bytes(now.m.tree_rss) }) : undefined}
        legend={<Legend items={procSeries.map((s) => ({ label: s.label, color: s.color, value: s.key === "other" ? bytes(last({ avg: s.values })) : lv(s.key, (x) => bytes(x)) }))} />}>
        {now&&<div className="mb-3 text-[11px] text-content-dim" data-testid="geny-memory-summary">
          {now.host.in_container&&now.cgroup?.current!=null&&<p className="font-medium text-content">{t("admin.genyContainerTotal")}: {bytes(now.cgroup.current)}{now.cgroup.file!=null?` · ${t("admin.memCache")}: ${bytes(now.cgroup.file)}`:""}</p>}
          <p>{t("admin.genyRss")}: {bytes(now.m.tree_rss)}</p>
          <p className="text-content-faint">{t("admin.genyMemoryHint")}</p>
        </div>}
        <TimeChart {...common} label={t("admin.procChart")} series={procSeries}
          refs={procRefs} autoMax={(m) => niceBytes(m, 256 * 1048576)} yFmt={axisBytes}
          extra={(i) => [
            { label: t("admin.engines"), value: String(v.get("eng_n").avg[i] ?? "–") },
            { label: t("admin.engineCpu"), value: pct(v.get("eng_cpu").avg[i], 0) },
          ]} />
      </ChartCard>

      <ChartCard title={t("admin.network")} icon="activity" dim={v.loading}
        right={now ? `${now.net.ifaces.join(", ") || "–"}${now.host.in_container ? t("admin.container") : ""}` : undefined}
        legend={<Legend items={[
          { label: t("admin.netInArrow"), color: C1, value: lv("net_rx", rate) },
          { label: t("admin.netOutArrow"), color: C2, value: lv("net_tx", rate) },
        ]} />}>
        <TimeChart {...common} label={t("admin.netChart")} series={netSeries} mirrored
          autoMax={(m) => niceBytes(m, 16 * 1024)} yFmt={(x) => `${axisBytes(x)}/s`} />
      </ChartCard>

      <ChartCard title={t("admin.diskIo")} icon="disk" dim={v.loading}
        right={t("admin.diskRight", { pct: lv("disk_busy", (x) => pct(x, 0)), when: busyLabel })}
        legend={<Legend items={[
          { label: t("admin.diskRead"), color: C1, value: lv("disk_read", rate) },
          { label: t("admin.diskWrite"), color: C2, value: lv("disk_write", rate) },
        ]} />}>
        <TimeChart {...common} label={t("admin.diskChart")} series={ioSeries} mirrored
          autoMax={(m) => niceBytes(m, 64 * 1024)} yFmt={(x) => `${axisBytes(x)}/s`}
          extra={(i) => [{ label: t("admin.busy"), value: pct(v.get("disk_busy").avg[i], 0) }]} />
      </ChartCard>

      {hasPsi && (
        <ChartCard title={t("admin.pressure")} icon="clock" dim={v.loading} wide={lastWide && gpus.length === 0}
          right={t("admin.pressureRight")}
          legend={<Legend items={psiSeries.map((s) => ({ label: s.label, color: s.color, kind: "line", value: lv(s.key, (x) => pct(x, 1)) }))} />}>
          <TimeChart {...common} label={t("admin.pressureChart")} series={psiSeries}
            refs={guard ? [{ value: guard.psi_full, label: t("admin.memguardFull"), tone: "danger" }] : []}
            autoMax={(m) => niceMax(m, 10)} yFmt={(x) => `${Math.round(x)}%`} />
        </ChartCard>
      )}

      {gpus.map((g, gi) => {
        const i = g.index;
        const memPct = ratio(v, `g${i}_mem`, `g${i}_memt`);
        return (
          <ChartCard key={i} title={t("admin.gpuTitle", { i: String(i), name: g.name })} icon="monitor" dim={v.loading} wide={lastWide && gi === gpus.length - 1}
            right={g.power !== null ? (g.power_limit ? t("admin.powerOf", { w: g.power.toFixed(0), max: g.power_limit.toFixed(0) }) : `${g.power.toFixed(0)} W`) : undefined}
            legend={<Legend items={[
              { label: t("admin.utilization"), color: C1, kind: "line", value: lv(`g${i}_util`, (x) => pct(x, 0)) },
              { label: t("admin.memory"), color: C2, kind: "line", value: g.mem_used !== null ? `${bytes(g.mem_used)} / ${bytes(g.mem_total)}` : "–" },
              { label: t("admin.temperature"), color: C3, kind: "line", value: lv(`g${i}_temp`, (x) => `${x.toFixed(0)}°C`) },
            ]} />}>
            <TimeChart {...common} height={H - 30} label={t("admin.gpuChart", { i: String(i) })}
              series={[
                ser(v, `g${i}_util`, t("admin.utilization"), C1, { fmt: (x) => pct(x, 0) }),
                { key: `g${i}_memp`, label: t("admin.memory"), color: C2, values: memPct.avg, min: memPct.min, max: memPct.max, fmt: (x) => pct(x, 1) },
              ]}
              yMax={100} yFmt={(x) => `${Math.round(x)}%`}
              extra={(idx) => [{ label: t("admin.power"), value: v.get(`g${i}_pwr`).avg[idx] != null ? `${(v.get(`g${i}_pwr`).avg[idx] as number).toFixed(0)} W` : "–" }]} />
            <div className="mt-2">
              <TimeChart {...common} height={96} label={t("admin.gpuTempChart", { i: String(i) })}
                series={[ser(v, `g${i}_temp`, t("admin.temperature"), C3, { fmt: (x) => `${x.toFixed(0)}°C` })]}
                refs={th ? [{ value: th.gpu_temp, label: t("admin.alertTemp", { temp: String(th.gpu_temp) }), tone: "warn" }] : []}
                autoMax={(m) => niceMax(Math.max(m, th?.gpu_temp ?? 90) + 5)} yFmt={(x) => `${Math.round(x)}°`} />
            </div>
          </ChartCard>
        );
      })}
    </div>
  );
}
