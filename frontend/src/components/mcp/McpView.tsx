import McpTools from "./McpTools";
import { openSettings } from "../../stores/uiStore";
import { requestAdminTab } from "../admin/adminTab";
import { useEffect, useState } from "react";
import { reconnectMcp, removeMcp, saveMcp, type McpEntry } from "../../api/mcp";
import { useMcpStore } from "../../stores/mcpStore";
import { useConfigStore } from "../../stores/configStore";
import { Editor, ImportForm } from "./McpEditor";
import McpCatalog from "./McpCatalog";
import McpIssue from "./McpIssue";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";

import { McpStatus } from "./McpStatus";

export default function McpView() {
  const t = useT(),
    catalog = useMcpStore((s) => s.catalog),
    error = useMcpStore((s) => s.error),
    load = useMcpStore((s) => s.load);
  const local = useConfigStore((s) => s.executionMode) === "local";
  const [success, setSuccess] = useState(false);
  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(false), 5000);
    return () => clearTimeout(timer);
  }, [success]);
  const [tab, setTab] = useState<"manage" | "catalog" | "direct">("manage");
  const [setup, setSetup] = useState<{
    recipe: string;
    existing?: McpEntry;
  } | null>(null);
  const [editor, setEditor] = useState<McpEntry | "new" | null>(null),
    [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(""),
    [err, setErr] = useState(""),
    [deleting, setDeleting] = useState("");
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setErr("");
    try {
      await action();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="space-y-4" data-testid="mcp-settings">
      {success && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 max-w-sm rounded-xl border border-success/30 bg-surface px-4 py-3 text-sm text-success shadow-xl"
        >
          {t("mcp.registrationDone")}
        </div>
      )}
      <div
        role="tablist"
        aria-label={t("mcp.title")}
        className="flex gap-1 border-b border-border overflow-x-auto pb-1"
      >
        {(["manage", "catalog", "direct"] as const).map((id, index, all) => (
          <button
            key={id}
            id={`mcp-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`mcp-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            data-testid={`mcp-tab-${id}`}
            className={`shrink-0 rounded-lg px-4 py-2.5 text-sm font-medium ${tab === id ? "bg-accent-soft text-accent" : "text-content-dim hover:bg-surface-2"}`}
            onClick={() => {
              setTab(id);
              setSetup(null);
            }}
            onKeyDown={(e) => {
              let next = index;
              if (e.key === "ArrowRight") next = (index + 1) % all.length;
              else if (e.key === "ArrowLeft")
                next = (index + all.length - 1) % all.length;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = all.length - 1;
              else return;
              e.preventDefault();
              setTab(all[next]);
              setSetup(null);
              document.getElementById(`mcp-tab-${all[next]}`)?.focus();
            }}
          >
            {t(
              id === "manage"
                ? "mcp.manageTab"
                : id === "catalog"
                  ? "mcp.catalogTab"
                  : "mcp.directTab",
            )}
          </button>
        ))}
      </div>
      <div className="card grid grid-cols-[auto_minmax(0,1fr)] gap-3 p-4 sm:flex sm:flex-wrap sm:items-center">
        <Icon
          name={local ? "monitor" : "server"}
          size={20}
          className="text-accent"
        />
        <div className="min-w-0 flex-1" data-testid="mcp-runtime-scope">
          <p className="text-[13px] font-medium">
            {t(local ? "mcp.localRuntime" : "mcp.serverRuntime")}
          </p>
          <p className="mt-1 text-xs text-content-faint">
            {t("mcp.scopeHint")}
          </p>
        </div>
        <div className="col-span-2 flex flex-wrap gap-2 sm:ml-auto">
          <button
            className="btn-ghost"
            onClick={() => {
              setTab("direct");
              setImporting(!importing);
            }}
            data-testid="mcp-import-open"
          >
            <Icon name="upload" size={14} />
            {t("mcp.import")}
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setTab("direct");
              setEditor("new");
            }}
            data-testid="mcp-add"
          >
            <Icon name="plus" size={14} />
            {t("mcp.add")}
          </button>
        </div>
      </div>
      {(err || error) && (
        <p
          className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger"
          role="alert"
        >
          {err || error}
          <button className="btn-ghost ml-2" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </p>
      )}
      {tab === "catalog" && (
        <div
          role="tabpanel"
          id="mcp-panel-catalog"
          aria-labelledby="mcp-tab-catalog"
        >
          <McpCatalog
            initial={setup}
            onRegistered={() => {
              setSuccess(true);
              setTab("manage");
              setSetup(null);
              void load();
            }}
          />
        </div>
      )}
      {tab === "direct" && (
        <div
          role="tabpanel"
          id="mcp-panel-direct"
          aria-labelledby="mcp-tab-direct"
          className="space-y-4"
        >
          <p className="text-xs text-content-faint">{t("mcp.directHint")}</p>
          {!importing && (
            <Editor
              item={null}
              onDone={() => {
                setSuccess(true);
                setEditor(null);
                setTab("manage");
                void load();
              }}
              onCancel={() => setTab("manage")}
            />
          )}
        </div>
      )}
      {tab === "direct" && importing && (
        <ImportForm
          onDone={() => {
            setImporting(false);
            setTab("manage");
            void load();
          }}
          onCancel={() => setImporting(false)}
        />
      )}
      {tab === "manage" && (
        <div
          role="tabpanel"
          id="mcp-panel-manage"
          aria-labelledby="mcp-tab-manage"
          className="space-y-4"
        >
          {editor && editor !== "new" && (
            <Editor
              key={editor.id}
              item={editor}
              onCancel={() => setEditor(null)}
              onDone={() => {
                setSuccess(true);
                setEditor(null);
                void load();
              }}
            />
          )}
          <div className="flex items-center justify-between text-[12px] text-content-faint">
            <span>
              {t("mcp.catalogCount", { count: catalog?.items.length ?? 0 })}
            </span>
            <button className="btn-ghost !py-1" onClick={() => void load()}>
              <Icon name="refresh" size={13} />
              {t("mcp.refresh")}
            </button>
          </div>
          {catalog?.items.length === 0 && (
            <div className="card px-5 py-10 text-center">
              <Icon
                name="plug"
                size={28}
                className="mx-auto mb-3 text-content-faint"
              />
              <p className="font-medium">{t("mcp.empty")}</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-content-faint">
                {t("mcp.emptyHint")}
              </p>
            </div>
          )}
          {catalog?.items.map((item) => (
            <section
              className="card p-4 sm:p-5"
              key={item.id}
              data-testid={`mcp-entry-${item.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Icon
                  name={item.transport === "stdio" ? "terminal" : "server"}
                  size={17}
                  className="text-accent"
                />
                <h3 className="min-w-0 flex-1 break-words font-semibold">
                  {item.name}
                </h3>
                <McpStatus state={item.state} />
                <button
                  aria-label={t("mcp.toggleConnection", { name: item.name })}
                  aria-pressed={item.enabled}
                  disabled={!!busy}
                  className={`relative h-5 w-9 rounded-full ${item.enabled ? "bg-accent" : "bg-surface-3"}`}
                  onClick={() =>
                    void run(item.id, () =>
                      saveMcp({ enabled: !item.enabled }, item.id),
                    )
                  }
                  data-testid={`mcp-toggle-${item.id}`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${item.enabled ? "left-[18px]" : "left-0.5"}`}
                  />
                </button>
              </div>
              <p
                className="mt-2 truncate font-mono text-xs text-content-faint"
                title={item.transport === "stdio" ? item.command : item.url}
              >
                {item.command === "geny-managed"
                  ? t("mcp.managedPackage")
                  : item.transport === "stdio"
                    ? item.command
                    : item.url}
              </p>
              <McpIssue code={item.error_code} fallback={item.error} />
              {item.repair_recipe && (
                <button
                  className="btn-soft mt-2"
                  onClick={() => {
                    setSetup({ recipe: item.repair_recipe!, existing: item });
                    setTab("catalog");
                  }}
                >
                  {t("mcp.repairWithCatalog")}
                </button>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {item.tools?.slice(0, 8).map((tool) => (
                  <span
                    className="pill bg-surface-3 font-mono text-content-dim"
                    key={tool.name}
                    title={tool.description}
                  >
                    {tool.name}
                  </span>
                ))}
                {(item.tool_count ?? item.tools?.length ?? 0) > 8 && (
                  <span className="pill text-content-faint">
                    +{(item.tool_count ?? item.tools.length) - 8}
                  </span>
                )}
              </div>
              <McpTools
                id={item.id}
                count={item.tool_count ?? item.tools?.length ?? 0}
                revision={`${item.updated_at}:${item.connected_at}`}
              />
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                <button
                  className="btn-soft !py-1.5"
                  disabled={!!busy}
                  onClick={() => {
                    if (item.catalog_id) {
                      setSetup({ recipe: item.catalog_id, existing: item });
                      setTab("catalog");
                    } else setEditor(item);
                  }}
                >
                  {t("mcp.edit")}
                </button>
                {item.enabled && (
                  <button
                    className="btn-ghost !py-1.5"
                    disabled={!!busy}
                    onClick={() =>
                      void run(item.id, () => reconnectMcp(item.id))
                    }
                  >
                    <Icon name="refresh" size={13} spin={busy === item.id} />
                    {t("mcp.reconnect")}
                  </button>
                )}
                <button
                  className="btn-ghost !py-1.5"
                  onClick={() => {
                    requestAdminTab("system");
                    openSettings("admin");
                  }}
                >
                  {t("mcp.logs")}
                </button>
                <button
                  className="btn-ghost ml-auto !py-1.5 text-danger"
                  disabled={!!busy}
                  onClick={() => setDeleting(item.id)}
                >
                  <Icon name="trash" size={13} />
                  {t("mcp.delete")}
                </button>
              </div>
              {deleting === item.id && (
                <div
                  className="mt-3 rounded-lg border border-danger/30 p-3"
                  role="alert"
                >
                  <p className="text-sm">{t("mcp.deleteHint")}</p>
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      className="btn-ghost"
                      onClick={() => setDeleting("")}
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      className="btn-soft text-danger"
                      disabled={!!busy}
                      onClick={() =>
                        void run(item.id, async () => {
                          await removeMcp(item.id);
                          setDeleting("");
                        })
                      }
                    >
                      {t("mcp.delete")}
                    </button>
                  </div>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
