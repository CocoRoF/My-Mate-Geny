import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearLogs, listLogs, logStats, type LogEntry, type LogFilter, type LogStats } from "../../api/admin";
import { useSessionStore } from "../../stores/sessionStore";
import { useUIStore } from "../../stores/uiStore";
import Icon, { type IconName } from "../ui/Icon";
import HourlyChart from "./HourlyChart";
import { absTime, compact, relTime } from "./format";

const SOURCES = ["provider", "tool", "workspace", "account", "upload", "http", "ws", "auth", "client", "system", "monitor"];

const LEVEL: Record<string, { icon: IconName; cls: string; label: string }> = {
  error: { icon: "alert-circle", cls: "text-danger bg-danger/12", label: "Error" },
  warning: { icon: "warning", cls: "text-warning bg-warning/12", label: "Warning" },
  info: { icon: "info", cls: "text-accent bg-accent/12", label: "Info" },
};

function useOpenSession() {
  const setActive = useSessionStore((s) => s.setActive);
  const sessions = useSessionStore((s) => s.sessions);
  const setView = useUIStore((s) => s.setView);
  return {
    exists: (id: string) => sessions.some((s) => s.id === id),
    title: (id: string) => sessions.find((s) => s.id === id)?.title,
    open: (id: string) => {
      setActive(id);
      setView("chat");
    },
  };
}

function Tile({ label, value, icon, tone }: { label: string; value: number; icon: IconName; tone: string }) {
  return (
    <div className="card p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] text-content-faint">
        <Icon name={icon} size={12} className={tone} /> {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-content">{compact(value)}</div>
    </div>
  );
}

function Pre({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-content-faint">{title}</div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg/70 p-2.5 font-mono text-[11px] leading-relaxed text-content-dim">
        {text}
      </pre>
    </div>
  );
}

function Detail({ e }: { e: LogEntry }) {
  const [copied, setCopied] = useState(false);
  const sess = useOpenSession();
  const { traceback, input, output, stack, ...rest } = e.detail || {};
  const meta: [string, string | null][] = [
    ["Time", absTime(e.ts)],
    ["Code", e.code || null],
    ["Session", e.session_id],
    ["Path", e.path],
    ["IP", e.ip],
  ];
  const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  return (
    <div className="space-y-3 border-t border-border/70 px-3.5 py-3">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px]">
        {meta.filter(([, v]) => v).map(([k, v]) => (
          <span key={k} className="text-content-faint">
            {k} <span className="font-mono text-content-dim">{v}</span>
          </span>
        ))}
        <span className="ml-auto flex gap-1.5">
          {e.session_id && sess.exists(e.session_id) && (
            <button onClick={() => sess.open(e.session_id!)} className="btn-soft py-1 px-2 text-[11px]">
              <Icon name="chat" size={12} /> Open session
            </button>
          )}
          <button
            onClick={() => {
              navigator.clipboard?.writeText(JSON.stringify(e, null, 2)).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            className="btn-soft py-1 px-2 text-[11px]"
          >
            <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copied" : "Copy JSON"}
          </button>
        </span>
      </div>
      <Pre title="Message" text={e.message} />
      {traceback && <Pre title="Traceback" text={String(traceback)} />}
      {stack && <Pre title="Stack" text={String(stack)} />}
      {input !== undefined && <Pre title="Tool input" text={fmt(input)} />}
      {output !== undefined && <Pre title="Tool output" text={fmt(output)} />}
      {Object.keys(rest).length > 0 && <Pre title="Context" text={JSON.stringify(rest, null, 2)} />}
    </div>
  );
}

function Row({ e }: { e: LogEntry }) {
  const [open, setOpen] = useState(false);
  const lv = LEVEL[e.level] || LEVEL.error;
  const sess = useOpenSession();
  const title = e.session_id ? sess.title(e.session_id) : undefined;
  return (
    <div className={`rounded-xl border bg-surface/60 transition ${open ? "border-border-strong" : "border-border"}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left">
        <span className={`mt-0.5 grid place-items-center w-6 h-6 shrink-0 rounded-md ${lv.cls}`} title={lv.label}>
          <Icon name={lv.icon} size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="pill bg-surface-3 text-content-dim">{e.source}</span>
            {e.code && <span className="font-mono text-[11px] text-content-dim truncate max-w-[260px]">{e.code}</span>}
            {title && <span className="text-[11px] text-content-faint truncate max-w-[200px]">· {title}</span>}
          </div>
          <div className={`mt-1 text-[13px] text-content ${open ? "whitespace-pre-wrap break-words" : "truncate"}`}>
            {e.message}
          </div>
        </div>
        <span className="shrink-0 pt-0.5 text-[11px] text-content-faint tabular-nums" title={absTime(e.ts)}>
          {relTime(e.ts)}
        </span>
        <Icon name={open ? "chevron-down" : "chevron"} size={14} className="mt-1 shrink-0 text-content-faint" />
      </button>
      {open && <Detail e={e} />}
    </div>
  );
}

export default function LogsPanel() {
  const [stats, setStats] = useState<LogStats | null>(null);
  const [items, setItems] = useState<LogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [live, setLive] = useState(true);
  const reqId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const filter: LogFilter = useMemo(
    () => ({ level, source, q: debouncedQ, limit: 100 }),
    [level, source, debouncedQ],
  );

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const [page, st] = await Promise.all([listLogs(filter), logStats()]);
      if (id !== reqId.current) return;
      setItems(page.items);
      setHasMore(page.has_more);
      setStats(st);
      setError("");
    } catch (e: any) {
      if (id === reqId.current) setError(String(e.message || e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [live, load]);

  const more = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    const page = await listLogs({ ...filter, before_id: last.id });
    setItems((cur) => [...cur, ...page.items]);
    setHasMore(page.has_more);
  };

  const clearAll = async () => {
    if (!window.confirm("Delete all stored logs? This cannot be undone.")) return;
    await clearLogs();
    load();
  };

  const levels: [string, string][] = [["", "All"], ["error", "Errors"], ["warning", "Warnings"], ["info", "Info"]];

  return (
    <div className="space-y-4">
      {stats && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <Tile label="Errors · 24h" value={stats.last_24h.error} icon="alert-circle" tone="text-danger" />
            <Tile label="Warnings · 24h" value={stats.last_24h.warning} icon="warning" tone="text-warning" />
            <Tile label="Errors · 7 days" value={stats.last_7d.error} icon="clock" tone="text-content-faint" />
            <Tile label="Stored entries" value={stats.total} icon="disk" tone="text-content-faint" />
          </div>
          <div className="card p-4">
            <HourlyChart hourly={stats.hourly} />
            {Object.keys(stats.by_source_24h).length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
                <span className="text-[11px] text-content-faint mr-1">By source · 24h</span>
                {Object.entries(stats.by_source_24h).map(([s, n]) => (
                  <button
                    key={s}
                    onClick={() => setSource(source === s ? "" : s)}
                    className={`pill transition ${source === s ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-dim hover:text-content"}`}
                  >
                    {s} <span className="font-mono text-content-faint">{n}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Filters: one row above the list */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border bg-surface p-0.5">
          {levels.map(([id, label]) => (
            <button
              key={id || "all"}
              onClick={() => setLevel(id)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition ${
                level === id ? "bg-surface-3 text-content" : "text-content-faint hover:text-content-dim"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <select value={source} onChange={(e) => setSource(e.target.value)} className="field w-auto py-1.5 text-[12px]">
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="flex flex-1 min-w-[180px] items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5">
          <Icon name="search" size={13} className="text-content-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search message, code, details…"
            className="w-full bg-transparent text-[12.5px] text-content placeholder:text-content-faint outline-none"
          />
        </div>
        <button
          onClick={() => setLive((v) => !v)}
          className={`btn-ghost py-1.5 px-2.5 text-[12px] ${live ? "text-success" : ""}`}
          title={live ? "Auto-refreshing every 10s — click to pause" : "Paused — click to auto-refresh"}
        >
          <Icon name={live ? "pause" : "play"} size={13} /> {live ? "Live" : "Paused"}
        </button>
        <button onClick={load} className="btn-ghost py-1.5 px-2" title="Refresh now">
          <Icon name="refresh" size={14} spin={loading} />
        </button>
        <button onClick={clearAll} className="btn-ghost py-1.5 px-2 text-danger hover:text-danger" title="Delete all logs">
          <Icon name="trash" size={14} />
        </button>
      </div>

      {error && (
        <p className="text-xs text-danger flex items-center gap-1.5">
          <Icon name="alert-circle" size={13} /> {error}
        </p>
      )}

      <div className="space-y-1.5">
        {items.map((e) => (
          <Row key={e.id} e={e} />
        ))}
        {!loading && items.length === 0 && !error && (
          <div className="card grid place-items-center py-12 text-center">
            <Icon name="check" size={22} className="text-success mb-2" />
            <p className="text-sm text-content-dim">
              {level || source || debouncedQ ? "Nothing matches these filters." : "No problems recorded."}
            </p>
          </div>
        )}
        {hasMore && (
          <button onClick={more} className="btn-ghost w-full justify-center py-2 text-[12px]">
            Load older entries
          </button>
        )}
      </div>
    </div>
  );
}
