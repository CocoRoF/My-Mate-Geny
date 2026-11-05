import { useCallback, useEffect, useRef, useState } from "react";
import { listLogs, type LogEntry } from "../../../api/admin";
import { useMcpStore } from "../../../stores/mcpStore";
import { useT } from "../../../i18n";
import { absTime } from "../format";
import Icon from "../../ui/Icon";
import { McpStatus } from "../../mcp/McpStatus";
import McpIssue from "../../mcp/McpIssue";

export default function McpRuntime() {
  const t = useT(),
    catalog = useMcpStore((s) => s.catalog),
    load = useMcpStore((s) => s.load);
  const [mid, setMid] = useState(""),
    [level, setLevel] = useState("");
  const [rows, setRows] = useState<LogEntry[]>([]),
    [more, setMore] = useState(false),
    [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState(""),
    generation = useRef(0);
  const refresh = useCallback(async () => {
    const turn = ++generation.current;
    try {
      const result = await listLogs({
        source: "mcp",
        level,
        q: mid,
        limit: 40,
        before_id: before ?? undefined,
      });
      if (turn === generation.current) {
        setRows(result.items);
        setMore(result.has_more);
        setError("");
      }
    } catch (e) {
      if (turn === generation.current) setError((e as Error).message);
    }
  }, [mid, level, before]);
  useEffect(() => {
    void load();
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden && before === null) {
        void refresh();
        void load();
      }
    }, 5000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [load, refresh, before]);
  return (
    <section className="card space-y-3 p-4 sm:p-5" data-testid="mcp-system">
      <div className="flex items-center gap-2">
        <Icon name="plug" size={17} className="text-accent" />
        <h3 className="flex-1 font-semibold">{t("mcp.systemTitle")}</h3>
        <button
          className="btn-ghost !py-1"
          onClick={() => {
            setBefore(null);
            void load();
            void refresh();
          }}
        >
          <Icon name="refresh" size={13} />
          {t("mcp.refresh")}
        </button>
      </div>
      <p className="text-xs text-content-faint">{t("mcp.systemHint")}</p>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {catalog?.items.map((item) => (
          <div
            key={item.id}
            className="rounded-lg border border-border bg-surface-2/40 p-3"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {item.name}
              </span>
              <McpStatus state={item.state} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-content-faint">
              <span>
                {t("mcp.toolsCount", {
                  count: item.tool_count ?? item.tools?.length ?? 0,
                })}
              </span>
              <span>
                {t("mcp.calls")}{" "}
                <b className="text-content-dim">{item.metrics?.calls ?? 0}</b>
              </span>
              <span>
                {t("mcp.errors")}{" "}
                <b className="text-content-dim">{item.metrics?.errors ?? 0}</b>
              </span>
              <span>
                {t("mcp.cancelled")}{" "}
                <b className="text-content-dim">
                  {item.metrics?.cancelled ?? 0}
                </b>
              </span>
              <span>
                {t("mcp.lastLatency")}{" "}
                <b className="text-content-dim">
                  {item.metrics?.last_ms ?? 0} ms
                </b>
              </span>
            </div>
            <McpIssue code={item.error_code} fallback={item.error} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          className="field min-w-0 max-w-full py-1.5 text-xs"
          value={mid}
          aria-label={t("mcp.allMcp")}
          onChange={(e) => {
            setMid(e.target.value);
            setBefore(null);
          }}
        >
          <option value="">{t("mcp.allMcp")}</option>
          {catalog?.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <select
          className="field py-1.5 text-xs"
          value={level}
          aria-label={t("mcp.allLevels")}
          onChange={(e) => {
            setLevel(e.target.value);
            setBefore(null);
          }}
        >
          <option value="">{t("mcp.allLevels")}</option>
          <option value="info">{t("mcp.levelInfo")}</option>
          <option value="warning">{t("mcp.levelWarning")}</option>
          <option value="error">{t("mcp.levelError")}</option>
        </select>
      </div>
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {!rows.length && (
        <p className="py-3 text-xs text-content-faint">{t("mcp.noLogs")}</p>
      )}
      <div className="space-y-1.5">
        {rows.map((row) => (
          <details
            key={row.id}
            className="rounded-lg border border-border/70 bg-surface-2/40 p-2.5"
          >
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${row.level === "error" ? "bg-danger" : row.level === "warning" ? "bg-warning" : "bg-success"}`}
              />
              <time className="text-[10.5px] text-content-faint">
                {absTime(row.ts)}
              </time>
              <span className="min-w-0 flex-1 break-words font-mono text-content-dim">
                {row.code}
              </span>
              {typeof row.detail?.duration_ms === "number" && (
                <span className="text-content-faint">
                  {row.detail.duration_ms} ms
                </span>
              )}
            </summary>
            <div className="mt-2 space-y-1 text-xs text-content-dim">
              <p className="whitespace-pre-wrap break-words">{row.message}</p>
              {row.detail?.mcp_id && (
                <p>
                  {catalog?.items.find((i) => i.id === row.detail.mcp_id)
                    ?.name ||
                    row.detail.mcp_name ||
                    row.detail.mcp_id}
                </p>
              )}
              {row.detail?.protocol && (
                <p className="font-mono">MCP {row.detail.protocol}</p>
              )}
              {row.detail?.tool && (
                <p className="break-words font-mono">{row.detail.tool}</p>
              )}
              {row.session_id && (
                <a
                  className="block break-all text-accent hover:underline"
                  href={`/?view=chat&session=${encodeURIComponent(row.session_id)}`}
                >
                  {t("mcp.session")}: {row.session_id}
                </a>
              )}
            </div>
          </details>
        ))}
      </div>
      {more && rows.length > 0 && (
        <button
          className="btn-ghost w-full text-xs"
          onClick={() => setBefore(rows[rows.length - 1].id)}
        >
          {t("mcp.moreLogs")}
        </button>
      )}
    </section>
  );
}
