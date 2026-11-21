/**
 * The usage bar under the mate and chat conversations (docs/monitoring.md "Usage bar"): how hard the machine Geny runs
 * on is working right now — CPU, memory, each GPU's load, memory and temperature, the network, Geny's own share — every
 * 2 s from the system monitor (lib/systemBar.ts). What fits its width shows; the rest is in its tooltip. A click opens
 * Settings → 관리자 → 시스템 (the whole picture); its ✕ hides it on this device until Settings → 테마 turns it on again.
 */
import { useEffect, useRef, useState } from "react";
import { requestAdminTab } from "../admin/adminTab";
import { useT } from "../../i18n";
import { openAppSettings } from "../../lib/openAppSettings";
import { toast } from "../../lib/toast";
import { gb, level, pct, rate, roomFor, useSystemBar, watchSystem, type BarSample, type Room } from "../../lib/systemBar";
import Icon from "../ui/Icon";


const FILL = { ok: "bg-accent", warn: "bg-warning", high: "bg-danger" } as const;
const TEXT = { ok: "text-content-dim", warn: "text-warning", high: "text-danger" } as const;

function Meter({ label, value, text, wide }: { label: string; value: number | null; text: string; wide?: boolean }) {
  const lv = level(value);
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1.5" data-level={lv}>
      <span className="text-content-faint">{label}</span>
      <span className={`relative h-1.5 overflow-hidden rounded-full bg-surface-3 ${wide ? "w-12" : "w-8"}`} aria-hidden>
        <span
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${FILL[lv]}`}
          style={{ width: `${Math.max(2, Math.min(100, value ?? 0))}%` }}
        />
      </span>
      <span className={`tabular-nums ${TEXT[lv]}`}>{text}</span>
    </span>
  );
}

/** the last minute as a line (CPU / a GPU's load) */
function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 36;
  const h = 12;
  const d = points.map((v, i) => `${(i / (points.length - 1)) * w},${h - (Math.min(100, Math.max(0, v)) / 100) * h}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 text-accent/70" aria-hidden>
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** what the whole bar says, for its tooltip and screen readers */
export function describe(s: BarSample, t: ReturnType<typeof useT>): string {
  const lines = [
    t("sysbar.host", { host: s.host || "–" }),
    `CPU ${s.cpu == null ? "–" : Math.round(s.cpu)}%${s.cores ? ` · ${t("sysbar.cores", { count: s.cores })}` : ""}`,
    `RAM ${gb(s.mem[0])} / ${gb(s.mem[1])} GB`,
    ...(s.swap && s.swap[0] ? [`Swap ${gb(s.swap[0])} / ${gb(s.swap[1])} GB`] : []),
    ...s.gpus.map(
      (g) =>
        `${g.name || "GPU"}: ${g.util == null ? "–" : Math.round(g.util)}% · VRAM ${gb(g.mem[0])} / ${gb(g.mem[1])} GB` +
        `${g.temp == null ? "" : ` · ${Math.round(g.temp)}°C`}${g.power == null ? "" : ` · ${Math.round(g.power)} W`}`,
    ),
    `↓ ${rate(s.net[0])} · ↑ ${rate(s.net[1])}`,
    ...(s.geny?.rss != null ? [t("sysbar.geny", { mem: gb(s.geny.rss), cpu: Math.round(s.geny.cpu ?? 0) })] : []),
  ];
  return lines.join("\n");
}



export default function SystemBar({ safeBottom = false }: { safeBottom?: boolean }) {
  const t = useT();
  const on = useSystemBar((s) => s.on);
  const last = useSystemBar((s) => s.last);
  const status = useSystemBar((s) => s.status);
  const cpuHist = useSystemBar((s) => s.cpuHist);
  const gpuHist = useSystemBar((s) => s.gpuHist);
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Room>("normal");

  useEffect(() => (on ? watchSystem() : undefined), [on]);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      setRoom(roomFor(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [on]);

  if (!on) return null;
  const close = () => {
    useSystemBar.getState().setOn(false);
    toast(t("sysbar.closed"), 3500);
  };
  const details = () => {
    requestAdminTab("system");
    openAppSettings("admin");
  };
  const mem = last ? pct(last.mem[0], last.mem[1]) : null;
  const big = room === "normal" || room === "wide";
  const gpus = last ? last.gpus.slice(0, room === "wide" ? 2 : 1) : [];
  return (
    <div
      ref={box}
      className={`flex h-7 shrink-0 items-center gap-1 border-t border-border/70 bg-surface/80 pl-2 pr-1 text-[11px] text-content-faint backdrop-blur-sm ${safeBottom ? "box-content pb-[env(safe-area-inset-bottom)]" : ""}`}
      data-testid="system-bar"
      data-room={room}
    >
      <button
        type="button"
        onClick={details}
        className={`flex h-full min-w-0 flex-1 items-center overflow-hidden rounded px-1 text-left hover:bg-surface-3/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${big ? "gap-3.5" : "gap-2.5"}`}
        title={last ? `${describe(last, t)}\n\n${t("sysbar.open")}` : t("sysbar.open")}
        aria-label={last ? describe(last, t).replace(/\n/g, ", ") : t("sysbar.title")}
        data-testid="system-bar-open"
      >
        {status === "off" ? (
          <span className="truncate">{t("sysbar.off")}</span>
        ) : !last ? (
          <span className="truncate">{status === "offline" ? t("sysbar.offline") : t("sysbar.connecting")}</span>
        ) : (
          <>
            {room === "wide" && (
              <span className="flex min-w-0 shrink items-center gap-1 truncate text-content-faint">
                <Icon name="server" size={11} className="shrink-0" />
                <span className="truncate">{last.host}</span>
              </span>
            )}
            <span className="flex shrink-0 items-center gap-1.5">
              <Meter label="CPU" value={last.cpu} text={`${last.cpu == null ? "–" : Math.round(last.cpu)}%`} wide={big} />
              {big && <Spark points={cpuHist} />}
            </span>
            <Meter
              label="RAM"
              value={mem}
              text={room === "narrow" ? `${mem == null ? "–" : Math.round(mem)}%` : `${gb(last.mem[0])}/${gb(last.mem[1])} GB`}
              wide={big}
            />
            {gpus.map((g, i) => {
              const vram = pct(g.mem[0], g.mem[1]);
              const name = last.gpus.length > 1 ? `GPU${i}` : "GPU";
              return (
                <span key={i} className={`flex shrink-0 items-center ${big ? "gap-3.5" : "gap-2.5"}`} data-testid="system-bar-gpu">
                  <span className="flex items-center gap-1.5">
                    <Meter label={name} value={g.util} text={`${g.util == null ? "–" : Math.round(g.util)}%`} wide={big} />
                    {room === "wide" && <Spark points={gpuHist[i] ?? []} />}
                  </span>
                  {room !== "narrow" && (
                    <Meter
                      label="VRAM"
                      value={vram}
                      text={big ? `${gb(g.mem[0])}/${gb(g.mem[1])} GB` : `${vram == null ? "–" : Math.round(vram)}%`}
                      wide={big}
                    />
                  )}
                  {room !== "narrow" && g.temp != null && (
                    <span className={`tabular-nums ${g.temp >= 85 ? "text-danger" : g.temp >= 75 ? "text-warning" : ""}`}>{Math.round(g.temp)}°C</span>
                  )}
                </span>
              );
            })}
            {room === "wide" && (
              <span className="shrink-0 tabular-nums">
                ↓ {rate(last.net[0])} ↑ {rate(last.net[1])}
              </span>
            )}
            {room === "wide" && last.geny?.rss != null && (
              <span className="shrink-0 tabular-nums">Geny {gb(last.geny.rss)} GB</span>
            )}
            {last.alerts > 0 && (
              <span className="flex shrink-0 items-center gap-1 text-warning">
                <Icon name="alert-circle" size={11} />
                {big && t("sysbar.alerts", { count: last.alerts })}
              </span>
            )}
            {status === "offline" && <span className="shrink-0 text-content-faint">· {t("sysbar.offline")}</span>}
          </>
        )}
      </button>
      <button
        type="button"
        onClick={close}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-content-faint hover:bg-surface-3 hover:text-content"
        aria-label={t("sysbar.hide")}
        title={t("sysbar.hideHint")}
        data-testid="system-bar-close"
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
