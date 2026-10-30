import { useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { connectionStatus } from "../../api/connections";
import ConnectionForm from "./ConnectionForm";
import GitAccounts from "./GitAccounts";
import Icon from "../ui/Icon";

export default function ConnectionsView() {
  const [tab, setTab] = useState<"ssh" | "git">("ssh");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 sm:px-6 py-5 sm:py-8">
        <div className="flex items-center gap-2.5 mb-1">
          <Icon name="server" size={20} className="text-cyan" />
          <h1 className="text-lg font-semibold">Connections</h1>
        </div>
        <p className="text-sm text-content-dim mb-5">
          Remote SSH hosts to work on, and Git accounts to clone & push repos.
        </p>

        <div className="flex gap-1.5 mb-5 border-b border-border">
          {([
            { id: "ssh", label: "SSH hosts", icon: "server" },
            { id: "git", label: "Git", icon: "file" },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition inline-flex items-center gap-2 ${
                tab === t.id ? "border-accent text-content" : "border-transparent text-content-dim hover:text-content"
              }`}
            >
              <Icon name={t.icon} size={15} className={tab === t.id ? "text-accent" : "text-content-faint"} />
              {t.label}
            </button>
          ))}
        </div>

        {tab === "ssh" ? <SshTab /> : <GitAccounts />}
      </div>
    </div>
  );
}

function SshTab() {
  const connections = useConnectionStore((s) => s.connections);
  const remove = useConnectionStore((s) => s.remove);
  const [status, setStatus] = useState<Record<string, { ok?: boolean; text: string }>>({});

  const check = async (id: string) => {
    setStatus((s) => ({ ...s, [id]: { text: "checking…" } }));
    try {
      const r = await connectionStatus(id);
      setStatus((s) => ({ ...s, [id]: { ok: !!r.reachable, text: r.reachable ? "reachable" : `${r.error || "unreachable"}` } }));
    } catch (e: any) {
      setStatus((s) => ({ ...s, [id]: { ok: false, text: String(e.message) } }));
    }
  };

  return (
    <div>
      <p className="text-sm text-content-dim mb-3">
        The agent runs on 2223 and operates these remote folders over SSH. Keys are stored encrypted in the vault.
      </p>
      <ConnectionForm />
      <div className="mt-4 space-y-2">
        {connections.length === 0 && <p className="text-xs text-content-faint">No connections yet.</p>}
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
                  <span className="pill bg-surface-3 text-content-faint">{c.has_key ? "🔑 key" : "no key"}</span>
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
              <button onClick={() => check(c.id)} className="btn-ghost">Test</button>
              <button onClick={() => remove(c.id)} className="btn-ghost text-danger hover:text-danger" title="Delete">
                <Icon name="trash" size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
