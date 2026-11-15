import { useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { connectionStatus, finishWithPassword, updateConnection } from "../../api/connections";
import type { Connection } from "../../types";
import ConnectionForm, { setupError } from "./ConnectionForm";
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
  const [open, setOpen] = useState<string | null>(null);

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
            <div key={c.id} className="card p-3" data-testid={`connection-${c.id}`}>
              <div className="flex items-center gap-3">
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
              <button onClick={() => setOpen(open === c.id ? null : c.id)} className="btn-ghost" title={t("connections.edit")} aria-label={t("connections.edit")} aria-expanded={open === c.id} data-testid={`connection-edit-${c.id}`}>
                <Icon name="pencil" size={14} />
              </button>
              <button onClick={() => remove(c.id)} className="btn-ghost text-danger hover:text-danger" title={t("connections.deleteConnection")} aria-label={t("connections.deleteConnection")}>
                <Icon name="trash" size={15} />
              </button>
              </div>
              {(open === c.id || !c.has_key) && <Fix c={c} editing={open === c.id} onDone={() => setOpen(null)} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Under a connection: with no key (or one that no longer signs in) its password finishes it — the server installs a key
 * of its own there, the password isn't kept; and (editing) its name and start folder.
 */
function Fix({ c, editing, onDone }: { c: Connection; editing: boolean; onDone: () => void }) {
  const t = useT();
  const load = useConnectionStore((s) => s.load);
  const [password, setPassword] = useState("");
  const [name, setName] = useState(c.name);
  const [path, setPath] = useState(c.default_path || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const finish = async () => {
    setBusy(true);
    setError("");
    try {
      await finishWithPassword(c.id, password);
      setPassword("");
      setDone(t("connections.keyInstalled"));
      await load();
    } catch (e) {
      setError(setupError(t, e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await updateConnection(c.id, { name, default_path: path });
      await load();
      onDone();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3" data-testid={`connection-fix-${c.id}`}>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (password && !busy) void finish();
        }}
      >
        <span className="w-full text-[12px] text-content-dim">{c.has_key ? t("connections.replaceKeyHint") : t("connections.noKeyHint")}</span>
        <input type="password" className="field min-w-0 flex-1" placeholder={t("connections.passwordPlaceholder")} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" data-testid={`connection-fix-password-${c.id}`} />
        <button type="submit" className="btn-primary !py-1.5 text-[12.5px]" disabled={busy || !password} data-testid={`connection-fix-go-${c.id}`}>
          {busy ? <Icon name="spinner" size={13} spin /> : <Icon name="key" size={13} />} {t("connections.installKey")}
        </button>
      </form>
      {editing && (
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("connections.namePlaceholder")} />
          <input className="field font-mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder={t("connections.defaultPathPlaceholder")} spellCheck={false} />
          <button className="btn-soft !py-1.5 text-[12.5px]" disabled={busy} onClick={() => void save()}>{t("connections.save")}</button>
        </div>
      )}
      {error && <p className="flex items-start gap-1.5 text-xs text-danger"><Icon name="x" size={13} className="mt-px shrink-0" /> {error}</p>}
      {done && <p className="flex items-center gap-1.5 text-xs text-success"><Icon name="check" size={13} /> {done}</p>}
    </div>
  );
}
