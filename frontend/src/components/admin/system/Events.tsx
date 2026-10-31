// Active alerts (banner) and the system events timeline (admin log rows with
// source "monitor": thresholds crossed / recovered, OOM kills, restarts).
import { useEffect, useMemo, useState } from "react";
import { monitorEvents, type MonAlert, type MonEvent, type Snapshot } from "../../../api/system";
import Icon, { type IconName } from "../../ui/Icon";
import { absTime, relTime } from "../format";
import { ChartCard } from "./Charts";
import { useFeed } from "./feed";
import { bytes, DANGER, dur, MUTED, OK, pct, WARN } from "./fmt";

const LEVEL: Record<string, { icon: IconName; color: string; label: string }> = {
  error: { icon: "alert-circle", color: DANGER, label: "Critical" },
  warning: { icon: "warning", color: WARN, label: "Warning" },
  info: { icon: "check", color: OK, label: "Recovered" },
};

function alertText(a: MonAlert, now: Snapshot): string {
  const k = a.key;
  if (k === "mem") return `Host memory ${pct(a.value)} used`;
  if (k === "guard") return `Available memory ${bytes(now.mem.available)} — near memguard's kill line`;
  if (k === "cgroup") return `Container memory ${pct(a.value)} of its limit`;
  if (k === "psi") return `Memory pressure ${pct(a.value, 1)} (PSI full)`;
  if (k === "swap") return `Swap ${pct(a.value)} used`;
  if (k === "swap_growth") return `Swap grew ${bytes(a.value)} in 5 min`;
  if (k === "cpu") return `CPU saturated (${pct(a.value)})`;
  if (k === "zombies") return `${a.value} zombie processes`;
  if (k.startsWith("disk:")) return `Disk ${k.slice(5)} ${pct(a.value)} full`;
  if (k.startsWith("engine:")) {
    const p = now.procs.find((x) => `engine:${x.key}` === k);
    return `Engine “${p?.title || k.slice(7)}” ${bytes(a.value)} RSS`;
  }
  if (k.endsWith(":temp")) return `GPU ${k.slice(3, k.indexOf(":"))} at ${a.value.toFixed(0)}°C`;
  if (k.endsWith(":mem")) return `GPU ${k.slice(3, k.indexOf(":"))} memory ${pct(a.value)}`;
  return `${k}: ${a.value}`;
}

export function AlertBanner({ now }: { now: Snapshot | null }) {
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
            <span className="font-medium text-content">{crit ? "Critical" : "Warning"}</span>
            <span className="min-w-0 truncate text-content-dim">{alertText(a, now)}</span>
            <span className="ml-auto shrink-0 text-[11px] text-content-faint tabular-nums">for {dur(now.ts - a.since)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function EventsTimeline() {
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
    <ChartCard title="System events" icon="clock" right={items.length ? `${items.length} recent` : undefined}>
      {items.length === 0 ? (
        <p className="py-2 text-[12px] text-content-faint">
          Nothing notable yet. Memory / swap / disk / CPU / GPU thresholds, OOM kills and backend restarts show up here
          (and in Error logs, source “monitor”).
        </p>
      ) : (
        <ol className="relative ml-1.5 border-l border-border pl-4">
          {shown.map((e) => {
            const lv = LEVEL[e.level] || { icon: "info" as IconName, color: MUTED, label: e.level };
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
          {more ? "Show fewer" : `Show ${items.length - 8} more`}
        </button>
      )}
    </ChartCard>
  );
}
