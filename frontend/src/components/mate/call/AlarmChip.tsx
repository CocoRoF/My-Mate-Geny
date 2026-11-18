/**
 * Her alarms waiting (docs/mate-calls.md "Alarms") on the Mate view's header: the next one's time; a tap lists them all,
 * each with ✕ to call it off. Set and changed by talking to her ("9시에 깨워 줘"); this only shows and cancels.
 */
import { useEffect, useRef, useState } from "react";
import { useAlarmStore } from "../../../stores/alarmStore";
import { useT } from "../../../i18n";
import Icon from "../../ui/Icon";

/** "09:00" today, "11-19 09:00" another day (their time, as the server keeps it) */
export function alarmWhen(local: string, today = new Date()): string {
  const [day, time] = local.split(" ");
  const p = (n: number) => String(n).padStart(2, "0");
  const here = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  return day === here ? time : `${day.slice(5)} ${time}`;
}

export default function AlarmChip({ mateId, className = "" }: { mateId: string; className?: string }) {
  const t = useT();
  const all = useAlarmStore((s) => s.alarms);
  const loaded = useAlarmStore((s) => s.loaded);
  const cancel = useAlarmStore((s) => s.cancel);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!loaded) void useAlarmStore.getState().load();
  }, [loaded]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);
  const mine = all.filter((a) => a.mate_id === mateId && a.kind === "alarm");
  if (!mine.length) return null;
  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost !px-2 gap-1 text-[12px] tabular-nums"
        title={t("mate.alarmsTitle", { count: mine.length })}
        aria-expanded={open}
        data-testid="mate-alarm-chip"
      >
        <Icon name="alarm-clock" size={14} className="text-warning" />
        {alarmWhen(mine[0].local)}
        {mine.length > 1 && <span className="text-content-faint">+{mine.length - 1}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-64 overflow-hidden rounded-xl border border-border bg-surface-2 shadow-float animate-fade-in" data-testid="mate-alarm-list">
          <div className="border-b border-border/70 px-3 py-2 text-[11.5px] text-content-faint">{t("mate.alarmsHint")}</div>
          {mine.map((a) => (
            <div key={a.id} className="flex items-center gap-2 px-3 py-2 text-[12.5px]" data-testid="mate-alarm-row">
              <span className="shrink-0 font-medium tabular-nums">{alarmWhen(a.local)}</span>
              <span className="min-w-0 flex-1 truncate text-content-dim">{a.about || t("mate.alarmNoNote")}</span>
              <button onClick={() => void cancel(a.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-content-faint hover:bg-danger/15 hover:text-danger" aria-label={t("mate.alarmCancel")} title={t("mate.alarmCancel")} data-testid="mate-alarm-cancel">
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
