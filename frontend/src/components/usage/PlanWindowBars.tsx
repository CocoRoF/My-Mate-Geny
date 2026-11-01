import { barTone, fmtPct, pctTone, resetLabel, resetsOn, type PlanWindow, type PlanWindows } from "../../lib/usage";
import { useT } from "../../i18n";

function Bar({ name, w, kind }: { name: string; w?: PlanWindow; kind: "five" | "seven" }) {
  const t = useT();
  const pct = w?.percent ?? null;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-content-faint">{name}</span>
        <span className={`font-mono font-semibold tabular-nums ${pctTone(pct)}`}>{fmtPct(pct)}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-surface-3 overflow-hidden">
        {pct !== null && (
          <div className={`h-full rounded-full ${barTone(pct)}`} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
        )}
      </div>
      <div className="mt-0.5 truncate text-[10.5px] text-content-faint">
        {w ? resetLabel(kind, w.resetsAt) || " " : t("usage.notReported")}
      </div>
    </div>
  );
}

/** 5-hour and 7-day usage side by side (+ per-model weekly limits). */
export default function PlanWindowBars({ windows, showModels = true }: { windows: PlanWindows; showModels?: boolean }) {
  const t = useT();
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <Bar name={t("usage.fiveHour")} w={windows.five} kind="five" />
        <Bar name={t("usage.sevenDay")} w={windows.seven} kind="seven" />
      </div>
      {showModels && windows.models.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {windows.models.map((m) => (
            <div key={m.label} className="flex items-baseline gap-2 text-[10.5px] text-content-faint">
              <span className="truncate">{/week/i.test(m.label) ? m.label : t("usage.weekly", { label: m.label })}</span>
              <span className={`font-mono tabular-nums ${pctTone(m.percent)}`}>{fmtPct(m.percent)}</span>
              <span className="ml-auto shrink-0">{resetsOn(m.resetsAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
