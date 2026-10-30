import { useState } from "react";
import type { LogStats } from "../../api/admin";
import Icon from "../ui/Icon";

// Status job: error / warning use the app's reserved status tokens and always
// travel with an icon + label (legend, tooltip) — never color alone.
const ERR = "#f87171";
const WARN = "#fbbf24";
const H = 120; // plot height (px)
const GAP = 2; // surface gap between stacked segments

export default function HourlyChart({ hourly }: { hourly: LogStats["hourly"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...hourly.map((b) => b.error + b.warning));
  const top = niceMax(max);
  const label = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const hb = hover !== null ? hourly[hover] : null;

  return (
    <div>
      <div className="flex items-center gap-4 mb-3 text-[11px] text-content-dim">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: ERR }} />
          <Icon name="alert-circle" size={11} /> Errors
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: WARN }} />
          <Icon name="warning" size={11} /> Warnings
        </span>
        <span className="ml-auto text-content-faint">per hour · last 24h</span>
      </div>

      <div className="relative flex gap-2">
        {/* y ticks */}
        <div className="flex flex-col justify-between text-[10px] text-content-faint tabular-nums text-right w-6 shrink-0" style={{ height: H }}>
          <span>{top}</span>
          <span>{top / 2}</span>
          <span>0</span>
        </div>
        <div className="relative flex-1 min-w-0">
          <div className="absolute inset-x-0 top-0 border-t border-border/60" />
          <div className="absolute inset-x-0 border-t border-border/60" style={{ top: H / 2 }} />
          <div className="relative flex items-end" style={{ height: H }} onMouseLeave={() => setHover(null)}>
            {hourly.map((b, i) => {
              const eh = (b.error / top) * H;
              const wh = (b.warning / top) * H;
              const empty = b.error + b.warning === 0;
              return (
                <div
                  key={b.hour}
                  className="relative flex-1 h-full flex items-end justify-center cursor-default"
                  onMouseEnter={() => setHover(i)}
                >
                  {hover === i && <span className="absolute inset-y-0 inset-x-[1px] rounded bg-surface-3/60" />}
                  <div className="relative flex flex-col-reverse items-stretch w-[70%] max-w-[24px]">
                    {b.error > 0 && (
                      <span
                        style={{ height: Math.max(2, eh), background: ERR }}
                        className={b.warning > 0 ? "" : "rounded-t-[4px]"}
                      />
                    )}
                    {b.warning > 0 && (
                      <span
                        style={{ height: Math.max(2, wh), background: WARN, marginBottom: b.error > 0 ? GAP : 0 }}
                        className="rounded-t-[4px]"
                      />
                    )}
                    {empty && <span className="h-px bg-border" />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t border-border-strong" />
          <div className="flex justify-between pt-1 text-[10px] text-content-faint tabular-nums">
            <span>{label(hourly[0]?.hour)}</span>
            <span>{label(hourly[12]?.hour)}</span>
            <span>now</span>
          </div>

          {hb && hover !== null && (
            <div
              className="pointer-events-none absolute z-10 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] shadow-float whitespace-nowrap"
              style={{ left: `${((hover + 0.5) / hourly.length) * 100}%`, top: -8, transform: "translate(-50%, -100%)" }}
            >
              <div className="font-medium text-content mb-0.5">
                {label(hb.hour)} – {label(new Date(Date.parse(hb.hour) + 3600_000).toISOString())}
              </div>
              <div className="flex items-center gap-1.5 text-content-dim">
                <span className="w-2 h-2 rounded-sm" style={{ background: ERR }} /> Errors
                <span className="ml-auto pl-3 font-mono text-content">{hb.error}</span>
              </div>
              <div className="flex items-center gap-1.5 text-content-dim">
                <span className="w-2 h-2 rounded-sm" style={{ background: WARN }} /> Warnings
                <span className="ml-auto pl-3 font-mono text-content">{hb.warning}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function niceMax(n: number): number {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const v = m * pow;
    if (v >= n && (v / 2) % 1 === 0) return v;
  }
  return Math.ceil(n / pow) * pow;
}
