// Admin -> System: live host / container monitoring (docs/monitoring.md).
//
// Live data arrives over /ws/admin/system (a sample every 2 s, only while
// this tab is on screen); history ranges are fetched once and then extended
// by the same live samples. The static sections (runtime, providers, data,
// storage) load once, with a refresh button — nothing polls.
import { useCallback, useEffect, useState } from "react";
import { systemInfo, type SystemInfo } from "../../api/admin";
import type { Snapshot } from "../../api/system";
import { formatBytes } from "../attachments/fileMeta";
import Icon from "../ui/Icon";
import { absTime, duration } from "./format";
import Charts, { ChartCard } from "./system/Charts";
import EventsTimeline, { AlertBanner } from "./system/Events";
import { useFeed, useSystemFeed, type FeedStatus } from "./system/feed";
import { bytes, C1, DANGER, OK, pct, WARN } from "./system/fmt";
import Processes from "./system/Processes";
import { Meter } from "./system/Spark";
import Tiles from "./system/Tiles";
import { useView, type ViewRange } from "./system/view";
import { useT, type MsgKey } from "../../i18n";
import { fmtNum } from "../../i18n/format";

const RANGES: { id: ViewRange; label: MsgKey }[] = [
  { id: "live", label: "admin.rangeLive" },
  { id: "1h", label: "admin.range1h" },
  { id: "6h", label: "admin.range6h" },
  { id: "24h", label: "admin.range24h" },
  { id: "7d", label: "admin.range7d" },
  { id: "30d", label: "admin.range30d" },
];

const COUNT: Record<string, MsgKey> = {
  sessions: "admin.countSessions",
  messages: "admin.countMessages",
  events: "admin.countEvents",
  attachments: "admin.countAttachments",
  connections: "admin.countConnections",
  error_logs: "admin.countErrorLogs",
};

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-[12px] text-content-faint shrink-0">{k}</span>
      <span className={`text-[12.5px] text-content text-right truncate ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}

function StatusPill({ status, paused, lastAt }: { status: FeedStatus; paused: boolean; lastAt: number }) {
  const t = useT();
  const [, tick] = useState(0);
  useEffect(() => {
    const tm = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(tm);
  }, []);
  const stale = status === "live" && lastAt && Date.now() - lastAt > 8000;
  const [color, label, pulse] = paused
    ? [WARN, t("admin.statusPaused"), false]
    : status === "live" && !stale
      ? [OK, t("admin.statusLive"), true]
      : status === "hidden"
        ? ["#5e6676", t("admin.statusHidden"), false]
        : status === "connecting"
          ? [C1, t("admin.statusConnecting"), true]
          : [DANGER, stale ? t("admin.statusNoData") : t("admin.statusReconnecting"), false];
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2/70 px-2.5 py-1 text-[11.5px] text-content-dim" role="status">
      <span className={`h-2 w-2 rounded-full ${pulse ? "animate-pulse-dot" : ""}`} style={{ background: color }} />
      {label}
    </span>
  );
}

function Toolbar({ range, setRange, now }: { range: ViewRange; setRange: (r: ViewRange) => void; now: Snapshot | null }) {
  const status = useFeed((s) => s.status);
  const paused = useFeed((s) => s.paused);
  const lastAt = useFeed((s) => s.lastAt);
  const setPaused = useFeed((s) => s.setPaused);
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg border border-border bg-surface-2/70 p-0.5" role="tablist" aria-label={t("admin.timeRange")}>
        {RANGES.map((r) => (
          <button key={r.id} role="tab" aria-selected={range === r.id} onClick={() => setRange(r.id)}
            className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition sm:px-3 ${
              range === r.id ? "bg-surface-3 text-content shadow-card" : "text-content-dim hover:text-content"}`}>
            {t(r.label)}
          </button>
        ))}
      </div>
      <button onClick={() => setPaused(!paused)} className="btn-ghost px-2.5 py-1 text-[12px]" title={paused ? t("admin.resumeTitle") : t("admin.pauseTitle")}>
        <Icon name={paused ? "play" : "pause"} size={13} /> {paused ? t("admin.resume") : t("admin.pause")}
      </button>
      <StatusPill status={status} paused={paused} lastAt={lastAt} />
      {now && (
        <span className="ml-auto hidden md:inline text-[11.5px] text-content-faint truncate">
          {t("admin.hostLine", { host: now.host.hostname, cpu: now.cpu.model || "CPU", ram: bytes(now.mem.total, 0), kernel: now.host.kernel })}
          {now.host.in_container ? t("admin.inContainer") : ""}
        </span>
      )}
    </div>
  );
}

function MonitorCard({ now }: { now: Snapshot | null }) {
  const t = useT();
  const s = now?.sampler;
  return (
    <ChartCard title={t("admin.monitor")} icon="activity">
      {!s ? (
        <p className="text-[12px] text-content-faint">{t("admin.waitingSample")}</p>
      ) : (
        <>
          <KV k={t("admin.samplerCost")} v={t("admin.samplerCostValue", { ms: s.avg_cpu_ms.toFixed(1), interval: String(s.interval_s), pct: pct(s.cpu_pct, 2) })} />
          <KV k={t("admin.lastTick")} v={`${s.last_ms.toFixed(1)} ms`} mono />
          <KV k={t("admin.liveBuffer")} v={t("admin.liveBufferValue", { ring: s.ring, cap: s.ring_capacity, min: Math.round((s.ring * s.interval_s) / 60) })} />
          <KV k={t("admin.historyRows")} v={t("admin.historyRowsValue", { m1: s.rows_1m, m15: s.rows_15m })} />
          <KV k={t("admin.liveViewers")} v={String(s.subscribers)} />
          <KV k={t("admin.gpuSource")} v={s.gpu_source} mono />
        </>
      )}
    </ChartCard>
  );
}

function GuardCard({ now }: { now: Snapshot | null }) {
  const t = useT();
  if (!now) return null;
  const g = now.guard;
  const cg = now.cgroup;
  const avail = now.mem.available;
  const head = g?.avail_min ? avail - g.avail_min : null;
  const headTone = head === null ? C1 : head < 0 ? DANGER : head < 1024 ** 3 ? WARN : OK;
  return (
    <ChartCard title={t("admin.memProtection")} icon="shield">
      {cg && (
        <>
          <KV k={t("admin.genyContainer")} v={cg.max ? t("admin.workingSetOf", { ws: bytes(cg.working_set), max: bytes(cg.max) }) : t("admin.workingSetNoLimit", { ws: bytes(cg.working_set) })} />
          {cg.peak ? <KV k={t("admin.containerPeak")} v={bytes(cg.peak)} /> : null}
          <KV k={t("admin.oomKills")} v={String(cg.events.oom_kill ?? 0)} mono />
          {cg.limit_path && cg.limit_max && cg.limit_path !== cg.path && (
            <KV k={t("admin.limitAt", { path: cg.limit_path })} v={t("admin.usedOf", { used: bytes(cg.limit_current), max: bytes(cg.limit_max) })} />
          )}
        </>
      )}
      {g ? (
        <div className="mt-2.5">
          <div className="mb-1.5 flex justify-between text-[11px] text-content-faint">
            <span>{t("admin.headroom", { name: g.name })}</span>
            <span className="tabular-nums text-content">{head !== null ? bytes(head) : "–"}</span>
          </div>
          {head !== null && <Meter value={Math.min(100, (avail / now.mem.total) * 100)} color={headTone} label={t("admin.availableMemory")} />}
          <ul className="mt-2.5 space-y-1 text-[11.5px] leading-snug text-content-dim">
            <li>{t("admin.guardKills", { min: bytes(g.avail_min), hard: bytes(g.avail_hard), psi: String(g.psi_full) })}</li>
            {g.user_ceiling ? <li>{t("admin.guardCeiling", { ceiling: bytes(g.user_ceiling, 0) })}</li> : null}
            {now.host.in_container && <li>{t("admin.guardContainer")}</li>}
            {g.readme && <li className="font-mono text-[10.5px] text-content-faint truncate" title={g.readme}>{g.readme}</li>}
          </ul>
        </div>
      ) : (
        <p className="mt-2 text-[11.5px] text-content-faint">{t("admin.noGuard")}</p>
      )}
    </ChartCard>
  );
}

function RunsCard({ now }: { now: Snapshot | null }) {
  const t = useT();
  const runs = now?.runs || [];
  return (
    <ChartCard title={t("admin.runningTurns", { n: runs.length })} icon="activity">
      {runs.length === 0 ? (
        <p className="text-[12px] text-content-faint py-1">{t("admin.noTurnRunning")}</p>
      ) : (
        <div className="space-y-1.5">
          {runs.map((r) => (
            <div key={r.session_id} className="flex items-center gap-3 rounded-lg bg-surface-2/70 px-3 py-2">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse-dot shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-content">{r.title}</div>
                <div className="truncate text-[11px] text-content-faint font-mono">
                  {r.provider} · {r.model || t("admin.modelDefault")}
                  {r.account ? ` · ${r.account}` : ""} · {r.connection_id ? t("admin.remote") : t("admin.local")} {r.workspace}
                </div>
              </div>
              <span className="text-[11px] text-content-dim tabular-nums">{t("admin.toolsCount", { count: r.tools })}</span>
              <span className="text-[11px] text-content-faint tabular-nums" title={absTime(r.started_at)}>
                {duration(Math.max(0, (Date.now() - Date.parse(r.started_at)) / 1000))}
              </span>
            </div>
          ))}
        </div>
      )}
    </ChartCard>
  );
}

function StaticCards({ info, error, reload, loading }: { info: SystemInfo | null; error: string; reload: () => void; loading: boolean }) {
  const t = useT();
  if (!info) {
    return error ? <p className="text-xs text-danger">{error}</p> : <Icon name="spinner" size={18} spin className="text-content-faint" />;
  }
  const { storage: st } = info;
  const diskPct = st.disk_total ? (st.disk_used! / st.disk_total) * 100 : 0;
  const diskTone = diskPct > 90 ? DANGER : diskPct > 75 ? WARN : C1;
  const refresh = (
    <button onClick={reload} className="inline-flex items-center gap-1 text-content-faint hover:text-content" title={t("admin.reload")}>
      <Icon name="refresh" size={12} spin={loading} />
    </button>
  );
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ChartCard title={t("admin.runtime")} icon="server" right={refresh}>
        <KV k={t("common.version")} v={info.version} mono />
        <KV k={t("admin.host")} v={info.hostname} mono />
        <KV k={t("admin.uptime")} v={duration(info.uptime_s)} />
        <KV k={t("admin.started")} v={absTime(info.started_at)} />
        <KV k="Python" v={info.python} mono />
        <KV k="Claude CLI" v={info.cli.claude} mono />
        <KV k="Codex CLI" v={info.cli.codex} mono />
      </ChartCard>

      <ChartCard title={t("admin.providers")} icon="plug">
        {info.providers.map((p) => (
          <div key={p.provider} className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0">
            <Icon name={p.connected ? "check" : "x"} size={13} className={p.connected ? "text-success" : "text-danger"} />
            <span className="text-[12.5px] text-content capitalize">{p.provider}</span>
            <span className="ml-auto text-[11px] text-content-faint truncate">{p.detail}</span>
          </div>
        ))}
        <div className="mt-3 text-[11px] text-content-faint">
          {t("admin.limitsLine", { mb: info.limits.upload_max_mb, files: info.limits.upload_max_files, min: Math.round(info.limits.turn_timeout_s / 60) })}
        </div>
      </ChartCard>

      <ChartCard title={t("admin.data")} icon="file">
        {Object.entries(info.counts).map(([k, v]) => (
          <KV key={k} k={COUNT[k] ? t(COUNT[k]) : k.replace("_", " ")} v={fmtNum(v)} mono />
        ))}
      </ChartCard>

      <ChartCard title={t("admin.storage")} icon="disk">
        <KV k={t("admin.database")} v={formatBytes(st.db_bytes)} mono />
        <KV k={t("admin.attachments")} v={formatBytes(st.uploads_bytes)} mono />
        {st.disk_total ? (
          <div className="pt-2.5">
            <div className="flex justify-between text-[11px] text-content-faint mb-1.5">
              <span>{t("admin.homeDisk")}</span>
              <span className="tabular-nums">
                {formatBytes(st.disk_used!)} / {formatBytes(st.disk_total)} · {diskPct.toFixed(0)}%
              </span>
            </div>
            <Meter value={diskPct} color={diskTone} label={t("admin.homeDiskUsed")} />
            <div className="mt-1 text-[11px] text-content-faint">{t("admin.free", { size: formatBytes(st.disk_free!) })}</div>
          </div>
        ) : null}
      </ChartCard>
    </div>
  );
}

export default function SystemPanel() {
  useSystemFeed();
  const [range, setRange] = useState<ViewRange>("live");
  const now = useFeed((s) => s.now);
  const live = useFeed((s) => s.live);
  const th = useFeed((s) => s.thresholds);
  const view = useView(range);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    systemInfo()
      .then((d) => (setInfo(d), setError("")))
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="space-y-3">
      <Toolbar range={range} setRange={setRange} now={now} />
      <AlertBanner now={now} />
      <Tiles now={now} live={live} th={th} />
      {view.error && <p className="text-xs text-danger">{view.error}</p>}
      <Charts v={view} now={now} th={th} />
      <Processes now={now} th={th} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <EventsTimeline />
        <div className="space-y-3">
          <RunsCard now={now} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <GuardCard now={now} />
            <MonitorCard now={now} />
          </div>
        </div>
      </div>
      <StaticCards info={info} error={error} reload={load} loading={loading} />
    </div>
  );
}
