import { useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { connectionStatus } from "../../api/connections";
import ConnectionForm from "./ConnectionForm";
import GitAccounts from "./GitAccounts";
import Icon from "../ui/Icon";
import { tr, useT } from "../../i18n";

export default function ConnectionsView() {
  const t = useT();
  const [tab, setTab] = useState<"ssh" | "git">("ssh");

  return (
    // (Settings → Connections: the tab's title and intro are Settings')
    <div className="max-w-2xl">
      <div>
        <div className="flex gap-1.5 mb-5 border-b border-border">
          {([
            { id: "ssh", label: "connections.tabSsh", icon: "server" },
            { id: "git", label: "connections.tabGit", icon: "file" },
          ] as const).map((x) => (
            <button
              key={x.id}
              onClick={() => setTab(x.id)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition inline-flex items-center gap-2 ${
                tab === x.id ? "border-accent text-content" : "border-transparent text-content-dim hover:text-content"
              }`}
            >
              <Icon name={x.icon} size={15} className={tab === x.id ? "text-accent" : "text-content-faint"} />
              {t(x.label)}
            </button>
          ))}
        </div>

        {tab === "ssh" ? <SshTab /> : <GitAccounts />}
      </div>
    </div>
  );
}

function SshTab() {
  const t = useT();
  const connections = useConnectionStore((s) => s.connections);
  const remove = useConnectionStore((s) => s.remove);
  const [status, setStatus] = useState<Record<string, { ok?: boolean; text: string }>>({});

  const check = async (id: string) => {
    setStatus((s) => ({ ...s, [id]: { text: tr("connections.checking") } }));
    try {
      const r = await connectionStatus(id);
      setStatus((s) => ({ ...s, [id]: { ok: !!r.reachable, text: r.reachable ? tr("connections.reachable") : `${r.error || tr("connections.unreachable")}` } }));
    } catch (e: any) {
      setStatus((s) => ({ ...s, [id]: { ok: false, text: String(e.message) } }));
    }
  };

  return (
    <div>
      <p className="text-sm text-content-dim mb-3">
        {t("connections.sshIntro")}
      </p>
      <ConnectionForm />
      <div className="mt-4 space-y-2">
        {connections.length === 0 && <p className="text-xs text-content-faint">{t("connections.noConnections")}</p>}
        {connections.map((c) => {
          const st = status[c.id];
          return (
            <div key={c.id} className="card flex items-center gap-3 p-3">
              <div className="grid place-items-center w-9 h-9 rounded-lg bg-surface-3">
                <Icon name="server" size={17} className="text-cyan" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  {c.name}
                  <span className="pill bg-surface-3 text-content-faint">{c.has_key ? t("connections.hasKey") : t("connections.noKey")}</span>
                </div>
                <div className="text-xs text-content-faint font-mono truncate">
                  {c.username}@{c.host}:{c.port} · {c.default_path}
                </div>
                {st && (
                  <div className={`text-[11px] mt-0.5 flex items-center gap-1 ${st.ok ? "text-success" : st.ok === false ? "text-danger" : "text-content-faint"}`}>
                    {st.ok === true && <Icon name="check" size={11} />}
                    {st.ok === false && <Icon name="x" size={11} />}
                    {st.text}
                  </div>
                )}
              </div>
              <button onClick={() => check(c.id)} className="btn-ghost">{t("connections.test")}</button>
              <button onClick={() => remove(c.id)} className="btn-ghost text-danger hover:text-danger" title={t("connections.deleteConnection")} aria-label={t("connections.deleteConnection")}>
                <Icon name="trash" size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
