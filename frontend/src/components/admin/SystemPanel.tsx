import { useEffect, useState } from "react";
import { systemInfo, type SystemInfo } from "../../api/admin";
import { formatBytes } from "../attachments/fileMeta";
import Icon from "../ui/Icon";
import { absTime, duration, relTime } from "./format";

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-[12px] text-content-faint">{k}</span>
      <span className={`text-[12.5px] text-content text-right truncate ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon: Parameters<typeof Icon>[0]["name"]; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2 text-[13px] font-semibold text-content">
        <Icon name={icon} size={14} className="text-accent" /> {title}
      </div>
      {children}
    </div>
  );
}

export default function SystemPanel() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      systemInfo()
        .then((d) => alive && (setInfo(d), setError("")))
        .catch((e) => alive && setError(String(e.message || e)));
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (error && !info) return <p className="text-xs text-danger">{error}</p>;
  if (!info) return <Icon name="spinner" size={18} spin className="text-content-faint" />;

  const { storage: st } = info;
  const diskPct = st.disk_total ? (st.disk_used! / st.disk_total) * 100 : 0;
  const diskTone = diskPct > 90 ? "bg-danger" : diskPct > 75 ? "bg-warning" : "bg-accent";

  return (
    <div className="space-y-3">
      <Card title={`Running turns (${info.active_runs.length})`} icon="activity">
        {info.active_runs.length === 0 ? (
          <p className="text-[12px] text-content-faint py-1">No agent turn is running right now.</p>
        ) : (
          <div className="space-y-1.5">
            {info.active_runs.map((r) => (
              <div key={r.session_id} className="flex items-center gap-3 rounded-lg bg-surface-2/70 px-3 py-2">
                <span className="w-2 h-2 rounded-full bg-accent animate-pulse-dot" />
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
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title="Runtime" icon="server">
          <KV k="Version" v={info.version} mono />
          <KV k="Host" v={info.hostname} mono />
          <KV k="Uptime" v={duration(info.uptime_s)} />
          <KV k="Started" v={absTime(info.started_at)} />
          <KV k="Python" v={info.python} mono />
          <KV k="Claude CLI" v={info.cli.claude} mono />
          <KV k="Codex CLI" v={info.cli.codex} mono />
        </Card>

        <Card title="Providers" icon="plug">
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
        </Card>

        <Card title="Data" icon="file">
          {Object.entries(info.counts).map(([k, v]) => (
            <KV key={k} k={k.replace("_", " ")} v={v.toLocaleString()} mono />
          ))}
        </Card>

        <Card title="Storage" icon="disk">
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
              <div className="h-2 rounded-full bg-accent/15 overflow-hidden">
                <div className={`h-full rounded-full ${diskTone}`} style={{ width: `${diskPct}%` }} />
              </div>
              <div className="mt-1 text-[11px] text-content-faint">{formatBytes(st.disk_free!)} free</div>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
