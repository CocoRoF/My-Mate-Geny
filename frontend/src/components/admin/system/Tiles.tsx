// KPI tiles: the headline number, a status (icon + label, never color alone),
// a meter or detail line and a 15-minute sparkline from the live ring.
import type { ReactNode } from "react";
import type { Snapshot, Thresholds } from "../../../api/system";
import Icon, { type IconName } from "../../ui/Icon";
import type { LiveCols } from "./feed";
import { bytes, C1, C2, pct, rate, toneColor, toneOf, type Tone } from "./fmt";
import { Meter, Sparkline } from "./Spark";
import { useT, type MsgKey } from "../../../i18n";

const STATUS: Record<Tone, { icon: IconName; label: MsgKey }> = {
  ok: { icon: "check", label: "admin.statusOk" },
  warn: { icon: "warning", label: "admin.statusHigh" },
  danger: { icon: "alert-circle", label: "admin.statusCritical" },
};

function Tile({ label, icon, value, sub, tone, children, spark }: {
  label: string; icon: IconName; value: ReactNode; sub?: ReactNode; tone?: Tone; children?: ReactNode; spark?: ReactNode;
}) {
  const t = useT();
  const st = tone ? STATUS[tone] : null;
  return (
    <div className="card relative overflow-hidden p-3 sm:p-3.5 min-w-0">
      {tone && tone !== "ok" && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: toneColor(tone) }} />}
      <div className="flex items-center gap-1.5 text-[11px] text-content-faint">
        <Icon name={icon} size={12} className="text-accent" />
        <span className="truncate">{label}</span>
        {st && (
          <span className="ml-auto inline-flex items-center gap-1 text-content-dim" title={t("admin.statusTitle", { label: t(st.label) })}>
            <span className="inline-flex" style={{ color: toneColor(tone!) }}><Icon name={st.icon} size={11} /></span>
            <span className="hidden sm:inline">{t(st.label)}</span>
          </span>
        )}
      </div>
      <div className="mt-1 text-[20px] sm:text-[22px] font-semibold leading-tight text-content truncate">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-content-dim">{sub}</div>}
      {children && <div className="mt-2">{children}</div>}
      {spark && <div className="mt-2 -mx-1">{spark}</div>}
    </div>
  );
}

export default function Tiles({ now, live, th }: { now: Snapshot | null; live: LiveCols; th: Thresholds | null }) {
  const t = useT();
  if (!now) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card h-[118px] animate-pulse" />
        ))}
      </div>
    );
  }
  const m = now.m;
  const s = (k: string) => live.s[k] || [];
  const memPct = (now.mem.used * 100) / (now.mem.total || 1);
  const memTone = toneOf(memPct, th?.mem_warn ?? 85, th?.mem_crit ?? 95);
  const cpuTone = toneOf(m.cpu, th?.cpu_sat ?? 95, 101);
  const swapPct = now.mem.swap_total ? (now.mem.swap_used * 100) / now.mem.swap_total : 0;
  const swapTone = now.mem.swap_total ? toneOf(swapPct, th?.swap_warn ?? 80, 95) : "ok";
  const disk = [...now.disks].sort((a, b) => b.pct - a.pct)[0];
  const diskTone = disk ? toneOf(disk.pct, th?.disk_warn ?? 90, th?.disk_crit ?? 97) : "ok";
  const gpu = now.gpus[0];
  const gpuTone = gpu?.temp != null ? toneOf(gpu.temp, th?.gpu_temp ?? 85, (th?.gpu_temp ?? 85) + 7) : "ok";
  const netSum = s("net_rx").map((x, i) => (x ?? 0) + (s("net_tx")[i] ?? 0));
  const ioSum = s("disk_read").map((x, i) => (x ?? 0) + (s("disk_write")[i] ?? 0));

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <Tile label="CPU" icon="cpu" tone={cpuTone} value={pct(m.cpu)}
        sub={t("admin.cpuSub", { load: m.load1?.toFixed(2), cores: now.cpu.count })}
        spark={<Sparkline values={s("cpu")} max={100} />} />
      <Tile label={t("admin.memory")} icon="server" tone={memTone}
        value={<>{bytes(now.mem.used)} <span className="text-[13px] font-normal text-content-faint">/ {bytes(now.mem.total, 0)}</span></>}
        sub={t("admin.memSub", { pct: pct(memPct), free: bytes(now.mem.available) })}
        spark={<Sparkline values={s("mem_used")} max={now.mem.total} />} />
      <Tile label={t("admin.swap")} icon="rotate" tone={swapTone}
        value={now.mem.swap_total ? bytes(now.mem.swap_used) : t("admin.swapOff")}
        sub={now.mem.swap_total ? t("admin.swapSub", { pct: pct(swapPct), total: bytes(now.mem.swap_total, 0) }) : t("admin.noSwap")}
        spark={<Sparkline values={s("swap_used")} max={now.mem.swap_total || undefined} color={C2} />} />
      <Tile label={disk ? t("admin.diskLabel", { label: disk.label }) : t("admin.disk")} icon="disk" tone={diskTone}
        value={disk ? pct(disk.pct) : "–"}
        sub={disk ? t("admin.diskSub", { free: bytes(disk.free), io: rate(now.io.read + now.io.write) }) : undefined}
        spark={<Sparkline values={ioSum} color={C2} />}>
        {disk && <Meter value={disk.pct} color={diskTone === "ok" ? C1 : toneColor(diskTone)} label={t("admin.diskUsedAria", { label: disk.label })} />}
      </Tile>
      <Tile label={t("admin.network")} icon="activity" value={<span className="text-[17px] sm:text-[19px]">↓ {rate(m.net_rx)}</span>}
        sub={`↑ ${rate(m.net_tx)}`}
        spark={<Sparkline values={netSum} />} />
      {gpu ? (
        <Tile label={now.gpus.length > 1 ? `GPU ×${now.gpus.length}` : "GPU"} icon="monitor" tone={gpuTone} /* i18n-ignore */
          value={pct(gpu.util)}
          sub={[gpu.temp != null ? `${gpu.temp.toFixed(0)}°C` : null, gpu.mem_used != null ? `${bytes(gpu.mem_used)} VRAM` : null,
            gpu.power != null ? `${gpu.power.toFixed(0)} W` : null].filter(Boolean).join(" · ")}
          spark={<Sparkline values={s(`g${gpu.index}_util`)} max={100} />} />
      ) : (
        <Tile label="GPU" icon="monitor" value={<span className="text-[15px] font-medium text-content-dim">{t("admin.noGpu")}</span>}
          sub={now.gpu_error || (now.gpu_source === "off" ? t("admin.gpuOff") : t("admin.noGpuTool"))} />
      )}
    </div>
  );
}
