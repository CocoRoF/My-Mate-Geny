import { useEffect, useState } from "react";
import { useMcpStore } from "../../../stores/mcpStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { openSettings } from "../../../stores/uiStore";
import { useT } from "../../../i18n";
import type { Session } from "../../../types";
import { McpStatus } from "../../mcp/McpStatus";
import Icon from "../../ui/Icon";

export default function McpControls({ session }: { session: Session }) {
  const t = useT(),
    catalog = useMcpStore((s) => s.catalog),
    load = useMcpStore((s) => s.load),
    error = useMcpStore((s) => s.error);
  const [busy, setBusy] = useState(""),
    [err, setErr] = useState("");
  const update = useSessionStore((s) => s.update);
  useEffect(() => {
    void load();
  }, [load]);
  const toggle = async (id: string, value: boolean) => {
    setBusy(id);
    setErr("");
    try {
      await update(session.id, { mcp: { [id]: value } });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="space-y-2 text-xs" data-testid="session-mcp">
      <p className="text-[11px] text-content-faint">{t("mcp.sessionHint")}</p>
      {catalog?.items.map((item) => (
        <div className="rounded-lg border border-border p-2.5" key={item.id}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">
              {item.name}
            </span>
            <button
              className={`relative h-5 w-9 shrink-0 rounded-full ${session.mcp?.[item.id] && item.enabled ? "bg-accent" : "bg-surface-3"}`}
              aria-label={t("mcp.useInSession", { name: item.name })}
              aria-pressed={!!session.mcp?.[item.id]}
              disabled={!!busy || (!item.enabled && !session.mcp?.[item.id])}
              onClick={() => void toggle(item.id, !session.mcp?.[item.id])}
              data-testid={`session-mcp-toggle-${item.id}`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ${session.mcp?.[item.id] ? "left-[18px]" : "left-0.5"}`}
              />
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <McpStatus state={item.state} />
            <span className="text-[10.5px] text-content-faint">
              {t("mcp.toolsCount", {
                count: item.tool_count ?? item.tools?.length ?? 0,
              })}
            </span>
          </div>
        </div>
      ))}
      {catalog?.items.length === 0 && (
        <p className="py-2 text-content-dim">{t("mcp.empty")}</p>
      )}
      {(err || error) && (
        <p className="text-danger" role="alert">
          {err || error}
        </p>
      )}
      <button
        className="flex items-center gap-1 pt-1 text-accent hover:underline"
        onClick={() => openSettings("mcp")}
      >
        <Icon name="settings" size={12} />
        {t("mcp.manage")}
      </button>
    </div>
  );
}
