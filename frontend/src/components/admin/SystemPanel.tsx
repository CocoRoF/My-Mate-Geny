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
import { absTime, duration, relTime } from "./format";
import Charts, { ChartCard } from "./system/Charts";
import EventsTimeline, { AlertBanner } from "./system/Events";
import { useFeed, useSystemFeed, type FeedStatus } from "./system/feed";
import { bytes, C1, DANGER, OK, pct, WARN } from "./system/fmt";
import Processes from "./system/Processes";
import { Meter } from "./system/Spark";
import Tiles from "./system/Tiles";
import { useView, type ViewRange } from "./system/view";

const RANGES: { id: ViewRange; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "1h", label: "1 h" },
  { id: "6h", label: "6 h" },
  { id: "24h", label: "24 h" },
  { id: "7d", label: "7 d" },
  { id: "30d", label: "30 d" },
];

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-[12px] text-content-faint shrink-0">{k}</span>
      <span className={`text-[12.5px] text-content text-right truncate ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}

function StatusPill({ status, paused, lastAt }: { status: FeedStatus; paused: boolean; lastAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const stale = status === "live" && lastAt && Date.now() - lastAt > 8000;
  const [color, label, pulse] = paused
    ? [WARN, "Paused", false]
    : status === "live" && !stale
      ? [OK, "Live · 2 s", true]
      : status === "hidden"
        ? ["#5e6676", "Paused (tab hidden)", false]
        : status === "connecting"
          ? [C1, "Connecting…", true]
          : [DANGER, stale ? "No data" : "Reconnecting…", false];
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg border border-border bg-surface-2/70 p-0.5" role="tablist" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r.id} role="tab" aria-selected={range === r.id} onClick={() => setRange(r.id)}
            className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition sm:px-3 ${
              range === r.id ? "bg-surface-3 text-content shadow-card" : "text-content-dim hover:text-content"}`}>
            {r.label}
          </button>
        ))}
      </div>
      <button onClick={() => setPaused(!paused)} className="btn-ghost px-2.5 py-1 text-[12px]" title={paused ? "Resume live updates" : "Freeze the live view"}>
        <Icon name={paused ? "play" : "pause"} size={13} /> {paused ? "Resume" : "Pause"}
      </button>
      <StatusPill status={status} paused={paused} lastAt={lastAt} />
      {now && (
        <span className="ml-auto hidden md:inline text-[11.5px] text-content-faint truncate">
          {now.host.hostname} · {now.cpu.model || "CPU"} · {bytes(now.mem.total, 0)} RAM · kernel {now.host.kernel}
          {now.host.in_container ? " · in a container" : ""}
        </span>
      )}
    </div>
  );
}

function MonitorCard({ now }: { now: Snapshot | null }) {
  const s = now?.sampler;
  return (
    <ChartCard title="Monitor" icon="activity">
      {!s ? (
        <p className="text-[12px] text-content-faint">Waiting for the first sample…</p>
      ) : (
        <>
          <KV k="Sampler cost" v={`${s.avg_cpu_ms.toFixed(1)} ms CPU / ${s.interval_s}s · ${pct(s.cpu_pct, 2)} of a core`} />
          <KV k="Last tick" v={`${s.last_ms.toFixed(1)} ms`} mono />
          <KV k="Live buffer" v={`${s.ring} / ${s.ring_capacity} samples (${Math.round((s.ring * s.interval_s) / 60)} min)`} />
          <KV k="History rows" v={`${s.rows_1m.toLocaleString()} × 1 min · ${s.rows_15m.toLocaleString()} × 15 min`} />
          <KV k="Live viewers" v={String(s.subscribers)} />
          <KV k="GPU source" v={s.gpu_source} mono />
        </>
      )}
    </ChartCard>
  );
}

function GuardCard({ now }: { now: Snapshot | null }) {
  if (!now) return null;
  const g = now.guard;
  const cg = now.cgroup;
  const avail = now.mem.available;
  const head = g?.avail_min ? avail - g.avail_min : null;
  const headTone = head === null ? C1 : head < 0 ? DANGER : head < 1024 ** 3 ? WARN : OK;
  return (
    <ChartCard title="Memory protection" icon="shield">
      {cg && (
        <>
          <KV k="Geny container" v={`${bytes(cg.working_set)} working set${cg.max ? ` of ${bytes(cg.max)}` : " · no limit"}`} />
          {cg.peak ? <KV k="Container peak" v={bytes(cg.peak)} /> : null}
          <KV k="OOM kills (container)" v={String(cg.events.oom_kill ?? 0)} mono />
          {cg.limit_path && cg.limit_max && cg.limit_path !== cg.path && (
            <KV k={`Limit at ${cg.limit_path}`} v={`${bytes(cg.limit_current)} of ${bytes(cg.limit_max)}`} />
          )}
        </>
      )}
      {g ? (
        <div className="mt-2.5">
          <div className="mb-1.5 flex justify-between text-[11px] text-content-faint">
            <span>Headroom above {g.name}'s kill line</span>
            <span className="tabular-nums text-content">{head !== null ? bytes(head) : "–"}</span>
          </div>
          {head !== null && <Meter value={Math.min(100, (avail / now.mem.total) * 100)} color={headTone} label="Available memory" />}
          <ul className="mt-2.5 space-y-1 text-[11.5px] leading-snug text-content-dim">
            <li>· Kills the fastest-growing big process when available memory &lt; {bytes(g.avail_min)} (hard {bytes(g.avail_hard)}) or PSI full &gt; {g.psi_full}%.</li>
            {g.user_ceiling ? <li>· User processes (VS Code, CLI, builds) are capped at {bytes(g.user_ceiling, 0)} together.</li> : null}
            {now.host.in_container && <li>· This backend and its engines run in a container, outside the user slice — host memory is what counts for them.</li>}
            {g.readme && <li className="font-mono text-[10.5px] text-content-faint truncate" title={g.readme}>{g.readme}</li>}
          </ul>
        </div>
      ) : (
        <p className="mt-2 text-[11.5px] text-content-faint">No host memory guard detected (MONITOR_GUARD=on to draw one).</p>
      )}
    </ChartCard>
  );
}

function RunsCard({ now }: { now: Snapshot | null }) {
  const runs = now?.runs || [];
  return (
    <ChartCard title={`Running turns (${runs.length})`} icon="activity">
      {runs.length === 0 ? (
        <p className="text-[12px] text-content-faint py-1">No agent turn is running right now.</p>
      ) : (
        <div className="space-y-1.5">
          {runs.map((r) => (
            <div key={r.session_id} className="flex items-center gap-3 rounded-lg bg-surface-2/70 px-3 py-2">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse-dot shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-content">{r.title}</div>
                <div className="truncate text-[11px] text-content-faint font-mono">
                  {r.provider} · {r.model || "default"}
                  {r.account ? ` · ${r.account}` : ""} · {r.connection_id ? "remote" : "local"} {r.workspace}
                </div>
              </div>
              <span className="text-[11px] text-content-dim tabular-nums">{r.tools} tools</span>
              <span className="text-[11px] text-content-faint tabular-nums" title={absTime(r.started_at)}>
                {relTime(r.started_at).replace(" ago", "")}
              </span>
            </div>
          ))}
        </div>
      )}
    </ChartCard>
  );
}

function StaticCards({ info, error, reload, loading }: { info: SystemInfo | null; error: string; reload: () => void; loading: boolean }) {
  if (!info) {
    return error ? <p className="text-xs text-danger">{error}</p> : <Icon name="spinner" size={18} spin className="text-content-faint" />;
  }
  const { storage: st } = info;
  const diskPct = st.disk_total ? (st.disk_used! / st.disk_total) * 100 : 0;
  const diskTone = diskPct > 90 ? DANGER : diskPct > 75 ? WARN : C1;
  const refresh = (
    <button onClick={reload} className="inline-flex items-center gap-1 text-content-faint hover:text-content" title="Reload">
      <Icon name="refresh" size={12} spin={loading} />
    </button>
  );
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ChartCard title="Runtime" icon="server" right={refresh}>
        <KV k="Version" v={info.version} mono />
        <KV k="Host" v={info.hostname} mono />
        <KV k="Uptime" v={duration(info.uptime_s)} />
        <KV k="Started" v={absTime(info.started_at)} />
        <KV k="Python" v={info.python} mono />
        <KV k="Claude CLI" v={info.cli.claude} mono />
        <KV k="Codex CLI" v={info.cli.codex} mono />
      </ChartCard>

      <ChartCard title="Providers" icon="plug">
        {info.providers.map((p) => (
          <div key={p.provider} className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0">
            <Icon name={p.connected ? "check" : "x"} size={13} className={p.connected ? "text-success" : "text-danger"} />
            <span className="text-[12.5px] text-content capitalize">{p.provider}</span>
            <span className="ml-auto text-[11px] text-content-faint truncate">{p.detail}</span>
          </div>
        ))}
        <div className="mt-3 text-[11px] text-content-faint">
          Limits: {info.limits.upload_max_mb} MB/file · {info.limits.upload_max_files} files/message · turn timeout{" "}
          {Math.round(info.limits.turn_timeout_s / 60)} min
        </div>
      </ChartCard>

      <ChartCard title="Data" icon="file">
        {Object.entries(info.counts).map(([k, v]) => (
          <KV key={k} k={k.replace("_", " ")} v={v.toLocaleString()} mono />
        ))}
      </ChartCard>

      <ChartCard title="Storage" icon="disk">
        <KV k="Database" v={formatBytes(st.db_bytes)} mono />
        <KV k="Attachments" v={formatBytes(st.uploads_bytes)} mono />
        {st.disk_total ? (
          <div className="pt-2.5">
            <div className="flex justify-between text-[11px] text-content-faint mb-1.5">
              <span>/home disk</span>
              <span className="tabular-nums">
                {formatBytes(st.disk_used!)} / {formatBytes(st.disk_total)} · {diskPct.toFixed(0)}%
              </span>
            </div>
            <Meter value={diskPct} color={diskTone} label="/home disk used" />
            <div className="mt-1 text-[11px] text-content-faint">{formatBytes(st.disk_free!)} free</div>
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
