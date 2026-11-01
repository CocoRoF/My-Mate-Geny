// Active alerts (banner) and the system events timeline (admin log rows with
// source "monitor": thresholds crossed / recovered, OOM kills, restarts).
import { useEffect, useMemo, useState } from "react";
import { monitorEvents, type MonAlert, type MonEvent, type Snapshot } from "../../../api/system";
import Icon, { type IconName } from "../../ui/Icon";
import { absTime, relTime } from "../format";
import { ChartCard } from "./Charts";
import { useFeed } from "./feed";
import { bytes, DANGER, dur, MUTED, OK, pct, WARN } from "./fmt";
import { tr, useT, type MsgKey } from "../../../i18n";

const LEVEL: Record<string, { icon: IconName; color: string; label: MsgKey }> = {
  error: { icon: "alert-circle", color: DANGER, label: "admin.evCritical" },
  warning: { icon: "warning", color: WARN, label: "admin.evWarning" },
  info: { icon: "check", color: OK, label: "admin.evRecovered" },
};

function alertText(a: MonAlert, now: Snapshot): string {
  const k = a.key;
  if (k === "mem") return tr("admin.alMem", { pct: pct(a.value) });
  if (k === "guard") return tr("admin.alGuard", { avail: bytes(now.mem.available) });
  if (k === "cgroup") return tr("admin.alCgroup", { pct: pct(a.value) });
  if (k === "psi") return tr("admin.alPsi", { pct: pct(a.value, 1) });
  if (k === "swap") return tr("admin.alSwap", { pct: pct(a.value) });
  if (k === "swap_growth") return tr("admin.alSwapGrowth", { size: bytes(a.value) });
  if (k === "cpu") return tr("admin.alCpu", { pct: pct(a.value) });
  if (k === "zombies") return tr("admin.alZombies", { n: a.value });
  if (k.startsWith("disk:")) return tr("admin.alDisk", { disk: k.slice(5), pct: pct(a.value) });
  if (k.startsWith("engine:")) {
    const p = now.procs.find((x) => `engine:${x.key}` === k);
    return tr("admin.alEngine", { name: p?.title || k.slice(7), size: bytes(a.value) });
  }
  if (k.endsWith(":temp")) return tr("admin.alGpuTemp", { i: k.slice(3, k.indexOf(":")), temp: a.value.toFixed(0) });
  if (k.endsWith(":mem")) return tr("admin.alGpuMem", { i: k.slice(3, k.indexOf(":")), pct: pct(a.value) });
  return `${k}: ${a.value}`;
}

export function AlertBanner({ now }: { now: Snapshot | null }) {
  const t = useT();
  if (!now?.alerts.length) return null;
  return (
    <div className="space-y-1.5" role="status">
      {now.alerts.map((a) => {
        const crit = a.level === "crit";
        return (
          <div key={a.key} className="flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[12.5px]"
            style={{ borderColor: `${crit ? DANGER : WARN}55`, background: `${crit ? DANGER : WARN}12` }}>
            <span className="inline-flex" style={{ color: crit ? DANGER : WARN }}>
              <Icon name={crit ? "alert-circle" : "warning"} size={15} />
            </span>
            <span className="font-medium text-content">{crit ? t("admin.evCritical") : t("admin.evWarning")}</span>
            <span className="min-w-0 truncate text-content-dim">{alertText(a, now)}</span>
            <span className="ml-auto shrink-0 text-[11px] text-content-faint tabular-nums">{t("admin.forDur", { dur: dur(now.ts - a.since) })}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function EventsTimeline() {
  const t = useT();
  const live = useFeed((s) => s.events);
  const [older, setOlder] = useState<MonEvent[]>([]);
  const [more, setMore] = useState(false);
  useEffect(() => {
    monitorEvents(40).then((r) => setOlder(r.items)).catch(() => {});
  }, []);
  const items = useMemo(() => {
    const byKey = new Map<string, MonEvent>();
    for (const e of [...older, ...live]) byKey.set(e.id !== null ? String(e.id) : `${e.ts}${e.code}`, e);
    return [...byKey.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  }, [older, live]);
  const shown = more ? items : items.slice(0, 8);
  return (
    <ChartCard title={t("admin.systemEvents")} icon="clock" right={items.length ? t("admin.recentCount", { n: items.length }) : undefined}>
      {items.length === 0 ? (
        <p className="py-2 text-[12px] text-content-faint">
          {t("admin.noEvents")}
        </p>
      ) : (
        <ol className="relative ml-1.5 border-l border-border pl-4">
          {shown.map((e) => {
            const lv = LEVEL[e.level] ? { ...LEVEL[e.level], label: t(LEVEL[e.level].label) } : { icon: "info" as IconName, color: MUTED, label: e.level };
            return (
              <li key={e.id ?? `${e.ts}${e.code}`} className="relative pb-3 last:pb-0">
                <span className="absolute -left-[23px] top-0.5 inline-flex h-[14px] w-[14px] items-center justify-center rounded-full bg-surface-2"
                  style={{ color: lv.color }} title={lv.label}>
                  <Icon name={lv.icon} size={13} />
                </span>
                <div className="text-[12.5px] leading-snug text-content">{e.message}</div>
                <div className="mt-0.5 flex gap-2 text-[10.5px] text-content-faint">
                  <span title={absTime(e.ts)}>{relTime(e.ts)}</span>
                  <span className="font-mono truncate">{e.code}</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {items.length > 8 && (
        <button onClick={() => setMore(!more)} className="mt-2 text-[11.5px] text-accent hover:underline">
          {more ? t("admin.showFewer") : t("admin.showNMore", { n: items.length - 8 })}
        </button>
      )}
    </ChartCard>
  );
}
