/**
 * Voice Studio → 개요: the GPU now and over the last half hour, whose its memory is, the models on it, the GPU queue
 * (running, waiting, done — for whom: a mate, a call, the studio, a batch), the engines' events, the host.
 * Polled every 2 s while shown (the server samples the GPU every 5 s while someone looks, else every 30 s).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { getOverview, unloadModel, loadModelFrom, type GpuJob, type GpuOverview, type GpuSample, type Overview, type ResidentEx } from "../../api/voice";
import { useLang, useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";
import { ErrorLine, ProgressBar, Segmented, StatusBadge } from "../mate/settings/ui";
import { Card, clock, gb, gateText, secs, sourceLabel, useStudio } from "./shared";

const OUR_COLORS = ["#8b5cf6", "#22d3ee", "#f59e0b", "#10b981", "#ef4444"];

export default function OverviewPage() {
  const lang = useLang();
  const t = useT();
  const { reloadStatus } = useStudio();
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setO(await getOverview(lang));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [lang]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 2000);
    return () => clearInterval(timer);
  }, [load]);
  if (!o) return err ? <ErrorLine text={err} /> : <ProgressBar indeterminate />;
  const after = async () => {
    await load();
    await reloadStatus();
  };
  return (
    <div className="space-y-3" data-testid="vs-overview">
      {!o.gate.ok && (
        <Card testId="vs-overview-gate">
          <p className="text-[12.5px] text-warning">{gateText(t, o.gate)}</p>
        </Card>
      )}
      {o.gpus.map((g) => (
        <GpuCard key={g.index} g={g} series={o.series.filter((s) => s.gpu === g.index)} residents={o.residents} />
      ))}
      <div className="grid gap-3 lg:grid-cols-2">
        <Residents residents={o.residents} onChange={after} />
        <Queue q={o.queue} />
      </div>
      <RecentJobs jobs={o.queue.recent} />
      <div className="grid gap-3 lg:grid-cols-2">
        <Events o={o} />
        <Host o={o} />
      </div>
      <ErrorLine text={err} />
      <p className="text-[11px] text-content-faint">{t("voiceStudio.ovRefresh")}</p>
    </div>
  );
}

function Tile({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface/50 px-3 py-2" data-testid={testId}>
      <div className="text-[11px] text-content-faint">{label}</div>
      <div className="text-[17px] font-semibold tabular-nums text-content">{value}</div>
      {sub && <div className="text-[11px] tabular-nums text-content-faint">{sub}</div>}
    </div>
  );
}

function GpuCard({ g, series, residents }: { g: GpuOverview; series: GpuSample[]; residents: ResidentEx[] }) {
  const t = useT();
  const apple = g.kind === "apple";
  const ours = g.usage.ours.reduce((a, b) => a + (b.bytes ?? 0), 0);
  const pct = (n: number | null) => `${Math.max(0, ((n ?? 0) / g.total) * 100)}%`;
  const color = (i: number) => OUR_COLORS[i % OUR_COLORS.length];
  const unseen = apple ? t("voiceStudio.ovUnseenApple") : t("voiceStudio.ovUnseen");
  // (a process' executable with its folder: bin/python3, Games/x.exe)
  const exe = (path: string) => path.split(/[\\/]/).slice(-2).join("/");
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-x-2">
          <Icon name="cpu" size={14} /> {g.name}
          <span className="text-[11.5px] font-normal text-content-faint">
            {apple ? t("voiceStudio.ovDriverApple", { driver: g.driver }) : t("voiceStudio.ovDriver", { driver: g.driver, cap: g.capability || "?" })}
          </span>
        </span>
      }
      testId={`vs-gpu-${g.index}`}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label={t("voiceStudio.ovUtil")} value={g.util != null ? `${g.util}%` : "–"} sub={g.mem_util != null ? t("voiceStudio.ovMemUtil", { n: g.mem_util }) : undefined} testId="vs-gpu-util" />
        <Tile label={apple ? t("voiceStudio.ovUnified") : t("voiceStudio.ovVram")} value={`${gb(g.used)} / ${gb(g.total)} GB`} sub={t("voiceStudio.ovVramOurs", { gb: gb(ours, 2) })} testId="vs-gpu-vram" />
        <Tile label={t("voiceStudio.ovTemp")} value={g.temperature != null ? `${g.temperature}°C` : "–"} sub={g.fan != null ? t("voiceStudio.ovFan", { n: g.fan }) : undefined} />
        <Tile
          label={t("voiceStudio.ovPower")}
          value={g.power != null ? `${g.power.toFixed(0)} W` : "–"}
          sub={[g.power_limit != null ? `/ ${g.power_limit.toFixed(0)} W` : "", g.clock != null ? `${g.clock} MHz` : "", g.pstate ?? ""].filter(Boolean).join(" · ")}
        />
      </div>

      {/* whose the memory is */}
      <div className="mt-3">
        <div className="flex h-4 w-full overflow-hidden rounded-md bg-surface-3/70" data-testid="vs-gpu-bar">
          {g.usage.ours.map((m, i) => (
            <span key={m.pid} style={{ width: pct(m.bytes), background: color(i) }} title={t("voiceStudio.ovOwnerTitle", { name: m.name, gb: gb(m.bytes, 2) })} />
          ))}
          {g.usage.others.filter((m) => m.bytes).map((m) => (
            <span key={m.pid} className="bg-content-faint/60" style={{ width: pct(m.bytes) }} title={t("voiceStudio.ovOwnerTitle", { name: m.name, gb: gb(m.bytes, 2) })} />
          ))}
          {g.usage.unseen > 0 && <span className="bg-content-faint/30" style={{ width: pct(g.usage.unseen) }} title={unseen} />}
        </div>
        <ul className="mt-2 grid gap-x-4 gap-y-1 text-[12px] sm:grid-cols-2" data-testid="vs-gpu-owners">
          {g.usage.ours.map((m, i) => {
            const r = residents.find((x) => x.model_id === m.model_id);
            return (
              <li key={m.pid} className="flex items-center gap-1.5" data-testid={`vs-owner-${m.model_id}`}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color(i) }} />
                <span className="min-w-0 flex-1 truncate text-content">{t("voiceStudio.ovOurs", { name: m.name })}</span>
                <span className="tabular-nums text-content-dim">{gb(m.bytes, 2)} GB</span>
                {r?.pinned && <span className="pill border border-accent/30 bg-accent-soft text-accent">{t("localVoice.pinned")}</span>}
              </li>
            );
          })}
          {g.usage.others.map((m) => (
            <li key={m.pid} className="flex items-center gap-1.5" data-testid="vs-owner-other">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-content-faint/60" />
              <span className="min-w-0 flex-1 truncate text-content" title={m.name}>{t("voiceStudio.ovOther", { name: exe(m.name), pid: String(m.pid) })}</span>
              {m.bytes != null ? (
                <span className="tabular-nums text-content-dim">{gb(m.bytes, 2)} GB</span>
              ) : (
                <span className="text-content-faint" title={t("voiceStudio.ovUnknownBytes")}>?</span>
              )}
            </li>
          ))}
          {g.usage.unseen > 64 * 1024 ** 2 && (
            <li className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-content-faint/30" />
              <span className="min-w-0 flex-1 truncate text-content-dim">{unseen}</span>
              <span className="tabular-nums text-content-dim">{gb(g.usage.unseen, 2)} GB</span>
            </li>
          )}
          <li className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-surface-3" />
            <span className="min-w-0 flex-1 truncate text-content-dim">{t("voiceStudio.ovFree")}</span>
            <span className="tabular-nums text-content-dim">{gb(g.free, 2)} GB</span>
          </li>
        </ul>
        {g.usage.ours.length === 0 && g.usage.others.length === 0 && <p className="mt-1 text-[11.5px] text-content-faint">{t("voiceStudio.ovIdle")}</p>}
      </div>
      <History series={series} total={g.total} />
    </Card>
  );
}

type Metric = "util" | "vram" | "temperature";

function History({ series, total }: { series: GpuSample[]; total: number }) {
  const t = useT();
  const [metric, setMetric] = useState<Metric>("util");
  const pts = useMemo(() => {
    if (series.length < 2) return null;
    const t0 = series[0].t;
    const t1 = series[series.length - 1].t;
    const span = Math.max(1, t1 - t0);
    const val = (s: GpuSample): [number, number | null] => {
      if (metric === "util") return [s.util ?? 0, null];
      if (metric === "temperature") return [s.temperature ?? 0, null];
      return [(s.used / total) * 100, (s.ours / total) * 100];
    };
    const max = metric === "temperature" ? Math.max(90, ...series.map((s) => s.temperature ?? 0)) : 100;
    // (a little inside the box: an idle GPU — 0 % — still shows its line)
    const xy = (s: GpuSample, v: number) => `${((s.t - t0) / span) * 100},${38.5 - (v / max) * 37}`;
    return {
      main: series.map((s) => xy(s, val(s)[0])).join(" "),
      ours: metric === "vram" ? series.map((s) => xy(s, val(s)[1] ?? 0)).join(" ") : null,
      minutes: Math.round(span / 60),
      last: val(series[series.length - 1])[0],
    };
  }, [series, metric, total]);
  return (
    <div className="mt-3" data-testid="vs-gpu-history">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-content-dim">{t("voiceStudio.ovHistory")}</span>
        <Segmented
          value={metric}
          onChange={setMetric}
          options={[
            { id: "util", label: t("voiceStudio.ovUtil") },
            { id: "vram", label: t("voiceStudio.ovVram") },
            { id: "temperature", label: t("voiceStudio.ovTemp") },
          ]}
        />
        {pts && <span className="text-[11px] text-content-faint">{t("voiceStudio.ovHistorySpan", { min: Math.max(1, pts.minutes) })}</span>}
      </div>
      {pts ? (
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="mt-2 h-24 w-full rounded-md bg-surface/50">
          <polyline points={pts.main} fill="none" stroke="rgb(var(--c-accent))" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
          {pts.ours && <polyline points={pts.ours} fill="none" stroke="#22d3ee" strokeWidth="0.6" strokeDasharray="1.5 1" vectorEffect="non-scaling-stroke" />}
        </svg>
      ) : (
        <p className="mt-2 text-[11.5px] text-content-faint">{t("voiceStudio.ovHistoryEmpty")}</p>
      )}
      {pts?.ours && <p className="mt-1 text-[11px] text-content-faint">{t("voiceStudio.ovHistoryVramLegend")}</p>}
    </div>
  );
}

function ago(t: ReturnType<typeof useT>, ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return t("voiceStudio.agoSec", { n: Math.round(s) });
  if (s < 3600) return t("voiceStudio.agoMin", { n: Math.round(s / 60) });
  return t("voiceStudio.agoHour", { n: Math.round(s / 3600) });
}

function Residents({ residents, onChange }: { residents: ResidentEx[]; onChange: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      await onChange();
    }
  };
  return (
    <Card title={t("voiceStudio.ovResidents")} testId="vs-residents">
      {residents.length === 0 ? (
        <p className="text-[12px] text-content-faint">{t("voiceStudio.ovNoResidents")}</p>
      ) : (
        <ul className="space-y-2">
          {residents.map((r) => (
            <li key={r.model_id} className="rounded-lg border border-border/60 bg-surface/40 px-2.5 py-2" data-testid={`vs-resident-${r.model_id}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-medium text-content">{r.name}</span>
                <StatusBadge status={r.state === "ready" ? "ok" : r.state === "parked" ? "warn" : "checking"}>{t(`localVoice.res_${r.state}` as MsgKey)}</StatusBadge>
                {r.busy && <span className="pill border border-accent/30 bg-accent-soft text-accent">{t("voiceStudio.ovBusy")}</span>}
                {r.pinned && <span className="pill border border-accent/30 bg-accent-soft text-accent">{t("localVoice.pinned")}</span>}
                <span className="flex-1" />
                {r.state === "ready" && (
                  <>
                    <button className="btn-ghost !px-2 !py-0.5 text-[11.5px]" disabled={!!busy || r.busy || r.pinned} onClick={() => act(r.model_id, () => unloadModel(r.model_id, true))} title={t("voiceStudio.ovParkHint")} data-testid={`vs-park-${r.model_id}`}>
                      {t("voiceStudio.ovPark")}
                    </button>
                    <button className="btn-soft !px-2 !py-0.5 text-[11.5px]" disabled={!!busy || r.busy || r.pinned} onClick={() => act(r.model_id, () => unloadModel(r.model_id))} data-testid={`vs-unload-${r.model_id}`}>
                      {busy === r.model_id ? <Icon name="spinner" size={11} spin /> : null} {t("localVoice.unload")}
                    </button>
                  </>
                )}
                {r.state === "parked" && (
                  <button className="btn-soft !px-2 !py-0.5 text-[11.5px]" disabled={!!busy} onClick={() => act(r.model_id, () => loadModelFrom(r.model_id, "studio"))}>
                    {t("localVoice.load")}
                  </button>
                )}
              </div>
              <p className="mt-1 text-[11.5px] tabular-nums text-content-faint">
                {t("voiceStudio.ovResidentLine", {
                  vram: gb(r.vram_used ?? r.vram_reserved, 2),
                  ram: gb(r.host_rss, 1),
                  load: r.load_seconds != null ? secs(r.load_seconds) : "–",
                  used: ago(t, r.last_used),
                })}
                {r.device?.dtype ? ` · ${r.device.dtype}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine text={err} />
    </Card>
  );
}

const kindLabel = (t: ReturnType<typeof useT>, k?: string) => (k ? t(`voiceStudio.kind_${k}` as MsgKey) : "–");

function Queue({ q }: { q: Overview["queue"] }) {
  const t = useT();
  const r = q.running;
  return (
    <Card title={t("voiceStudio.ovQueue")} testId="vs-queue">
      {r ? (
        <div className="rounded-lg border border-accent/30 bg-accent-soft/40 px-2.5 py-2 text-[12.5px]" data-testid="vs-queue-running">
          <div className="flex items-center gap-1.5">
            <Icon name="spinner" size={12} spin />
            <span className="font-medium text-content">{kindLabel(t, r.kind)} · {r.model_id}</span>
            <span className="flex-1" />
            <span className="tabular-nums text-content-dim">{r.started_at ? secs(Date.now() / 1000 - r.started_at) : ""}</span>
          </div>
          <p className="mt-0.5 text-[11.5px] text-content-dim">{t("voiceStudio.ovFor", { who: sourceLabel(t, r.source) })}</p>
        </div>
      ) : (
        <p className="text-[12px] text-content-faint">{t("voiceStudio.ovQueueIdle")}</p>
      )}
      {q.waiting.length > 0 && (
        <ul className="mt-2 space-y-1 text-[12px]" data-testid="vs-queue-waiting">
          {q.waiting.map((w) => (
            <li key={w.id} className="flex items-center gap-1.5 text-content-dim">
              <Icon name="clock" size={11} />
              <span className="min-w-0 flex-1 truncate">{kindLabel(t, w.kind)} · {w.model_id} · {sourceLabel(t, w.source)}</span>
              <span className="tabular-nums">{secs(Date.now() / 1000 - w.queued_at)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-snug text-content-faint">{t("voiceStudio.ovQueueHint")}</p>
    </Card>
  );
}

function RecentJobs({ jobs }: { jobs: GpuJob[] }) {
  const t = useT();
  const [who, setWho] = useState<string>("all");
  const kinds = useMemo(() => {
    const c: Record<string, number> = {};
    for (const j of jobs) {
      const k = (j.source || "").split(":")[0] || "system";
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [jobs]);
  const shown = jobs.filter((j) => who === "all" || ((j.source || "").split(":")[0] || "system") === who);
  return (
    <Card
      title={t("voiceStudio.ovRecent", { n: jobs.length })}
      right={
        <select className="field !w-auto !py-1 text-[12px]" value={who} onChange={(e) => setWho(e.target.value)} data-testid="vs-recent-filter">
          <option value="all">{t("voiceStudio.ovEveryone")}</option>
          {Object.entries(kinds).map(([k, n]) => (
            <option key={k} value={k}>
              {k === "mate" ? t("voiceStudio.srcAnyMate") : k === "call" ? t("voiceStudio.srcAnyCall") : sourceLabel(t, k)} ({n})
            </option>
          ))}
        </select>
      }
      testId="vs-recent"
    >
      {shown.length === 0 ? (
        <p className="text-[12px] text-content-faint">{t("voiceStudio.ovNoJobs")}</p>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-surface-2 text-[11px] text-content-faint">
              <tr>
                <th className="py-1 pr-2 font-medium">{t("voiceStudio.colTime")}</th>
                <th className="py-1 pr-2 font-medium">{t("voiceStudio.colWho")}</th>
                <th className="py-1 pr-2 font-medium">{t("voiceStudio.colWhat")}</th>
                <th className="py-1 pr-2 font-medium">{t("voiceStudio.colModel")}</th>
                <th className="py-1 pr-2 text-right font-medium">{t("voiceStudio.colWait")}</th>
                <th className="py-1 pr-2 text-right font-medium">{t("voiceStudio.colTook")}</th>
                <th className="py-1 pr-2 text-right font-medium">{t("voiceStudio.colAudio")}</th>
                <th className="py-1 text-right font-medium">RTF</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((j) => (
                <tr key={j.id} className="border-t border-border/50" data-testid="vs-recent-row" data-source={j.source}>
                  <td className="py-1 pr-2 tabular-nums text-content-faint">{j.ended_at ? clock(j.ended_at) : ""}</td>
                  <td className="py-1 pr-2 text-content">{sourceLabel(t, j.source)}</td>
                  <td className="py-1 pr-2 text-content-dim">
                    {kindLabel(t, j.kind)}
                    {j.ok === false && <span className="ml-1 text-danger" title={j.error}>{t("voiceStudio.failed")}</span>}
                  </td>
                  <td className="py-1 pr-2 text-content-dim">{j.model_id}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-content-faint">{j.started_at ? secs(j.started_at - j.queued_at) : "–"}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-content-dim">{j.started_at && j.ended_at ? secs(j.ended_at - j.started_at) : "–"}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-content-dim">{j.audio_seconds != null ? secs(j.audio_seconds) : "–"}</td>
                  <td className="py-1 text-right tabular-nums text-content-dim">{j.rtf != null ? j.rtf.toFixed(2) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Events({ o }: { o: Overview }) {
  const t = useT();
  // (a word the catalog doesn't know stays as the engine said it)
  const known = (key: string, raw: string) => {
    const s = t(key as MsgKey);
    return s === key ? raw : s;
  };
  const what = (k: string) => known(`voiceStudio.ev_${k.replace(/ /g, "_")}`, k);
  const why = (k: string) => known(`voiceStudio.why_${k.replace(/ /g, "_")}`, k);
  return (
    <Card title={t("voiceStudio.ovEvents")} testId="vs-events">
      {o.events.length === 0 ? (
        <p className="text-[12px] text-content-faint">{t("voiceStudio.ovNoEvents")}</p>
      ) : (
        <ul className="max-h-64 space-y-0.5 overflow-auto text-[12px]">
          {o.events.map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className="shrink-0 tabular-nums text-content-faint">{clock(e.t)}</span>
              <span className="min-w-0 flex-1 text-content-dim">
                <b className="font-medium text-content">{e.model_id}</b> {what(e.what)}
                {e.why ? ` · ${why(e.why)}` : ""}
                {e.seconds != null ? ` · ${secs(e.seconds)}` : ""}
                {e.error ? <span className="text-danger"> · {e.error}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Host({ o }: { o: Overview }) {
  const t = useT();
  const m = o.host.memory;
  return (
    <Card title={t("voiceStudio.ovHost")} testId="vs-host">
      <div className="grid grid-cols-2 gap-2">
        <Tile label={t("voiceStudio.ovRam")} value={`${gb(m.total - m.available)} / ${gb(m.total, 0)} GB`} sub={m.limited ? t("voiceStudio.ovRamLimited") : undefined} />
        <Tile label={t("voiceStudio.ovCpu")} value={String(o.host.cpu.count)} sub={o.host.cpu.name} />
        <Tile label={t("voiceStudio.ovDiskModels")} value={`${gb(o.host.disk.models.free, 0)} GB`} sub={t("voiceStudio.ovFreeOf", { total: gb(o.host.disk.models.total, 0) })} />
        <Tile label={t("voiceStudio.ovHistoryStore")} value={`${gb(o.history.bytes, 2)} GB`} sub={t("voiceStudio.ovHistoryCount", { n: o.history.count })} />
      </div>
      <p className="mt-2 text-[11px] leading-snug text-content-faint">
        {t("voiceStudio.ovPolicy", {
          budget: Math.round(o.settings.vram_budget_fraction * 100),
          idle: o.settings.idle_unload_seconds
            ? t("voiceStudio.ovIdleAfter", { n: Math.max(1, Math.round(o.settings.idle_unload_seconds / 60)) })
            : t("voiceStudio.ovIdleNever"),
        })}
      </p>
    </Card>
  );
}
