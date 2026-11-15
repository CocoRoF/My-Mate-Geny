/**
 * Add an SSH host (docs/remote.md "Adding a server"): the host, the user name and the password — the server signs in
 * once with it, puts a key of its own there and keeps only that key (the password is never stored). A private key of
 * their own can be pasted instead. The name and the start folder are optional (the host; the home folder there).
 */
import { useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import Icon from "../ui/Icon";
import { useT, type MsgKey } from "../../i18n";

type Mode = "password" | "key";

/** the server's code for a failed setup → its words here */
export function setupError(t: ReturnType<typeof useT>, e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === "auth" || code === "unreachable" || code === "refused") return t(`connections.err_${code}` as MsgKey);
  return String((e as Error)?.message || e);
}

export default function ConnectionForm() {
  const t = useT();
  const create = useConnectionStore((s) => s.create);
  const [mode, setMode] = useState<Mode>("password");
  const [form, setForm] = useState({ name: "", host: "", port: 22, username: "", password: "", private_key_pem: "", default_path: "" });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  const set = (k: keyof typeof form, v: string | number) => {
    setOk(false);
    setForm({ ...form, [k]: v });
  };
  const ready = !!form.host.trim() && !!form.username.trim() && (mode === "password" ? !!form.password : !!form.private_key_pem.trim());

  const submit = async () => {
    setBusy(true);
    setError("");
    setOk(false);
    try {
      await create({
        name: form.name,
        host: form.host,
        port: form.port || 22,
        username: form.username,
        password: mode === "password" ? form.password : null,
        private_key_pem: mode === "key" ? form.private_key_pem : null,
        default_path: form.default_path,
      });
      setForm({ name: "", host: "", port: 22, username: "", password: "", private_key_pem: "", default_path: "" });
      setOk(true);
    } catch (e) {
      setError(setupError(t, e));
      setForm((f) => ({ ...f, password: "" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void submit();
      }}
      data-testid="connection-form"
    >
      <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Icon name="plus" size={15} className="text-accent" /> {t("connections.addHost")}
      </h3>
      <div className="grid grid-cols-[1fr_88px] gap-2">
        <input placeholder={t("connections.hostPlaceholder")} value={form.host} onChange={(e) => set("host", e.target.value)} className="field font-mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="connection-host" />
        <input type="number" placeholder={t("connections.portPlaceholder")} value={form.port} onChange={(e) => set("port", Number(e.target.value))} className="field font-mono" data-testid="connection-port" />
        <input placeholder={t("connections.usernamePlaceholder")} value={form.username} onChange={(e) => set("username", e.target.value)} className="field col-span-2 font-mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="username" data-testid="connection-username" />
      </div>
      {mode === "password" ? (
        <div className="relative mt-2">
          <input
            type={show ? "text" : "password"}
            placeholder={t("connections.passwordPlaceholder")}
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            className="field pr-16"
            autoComplete="current-password"
            data-testid="connection-password"
          />
          <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-content-dim hover:text-content" onClick={() => setShow((v) => !v)} aria-pressed={show}>
            {show ? t("connections.hidePassword") : t("connections.showPassword")}
          </button>
        </div>
      ) : (
        <textarea placeholder={t("connections.keyPlaceholder")} value={form.private_key_pem} onChange={(e) => set("private_key_pem", e.target.value)} rows={4} className="field mt-2 font-mono text-[11px]" data-testid="connection-key" />
      )}
      <p className="mt-1.5 text-[11.5px] leading-snug text-content-faint">{mode === "password" ? t("connections.passwordHint") : t("connections.keyHint")}</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <input placeholder={t("connections.namePlaceholder")} value={form.name} onChange={(e) => set("name", e.target.value)} className="field" data-testid="connection-name" />
        <input placeholder={t("connections.defaultPathPlaceholder")} value={form.default_path} onChange={(e) => set("default_path", e.target.value)} className="field font-mono" autoCapitalize="off" spellCheck={false} data-testid="connection-path" />
      </div>
      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-danger" data-testid="connection-error">
          <Icon name="x" size={13} className="mt-px shrink-0" /> {error}
        </p>
      )}
      {ok && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-success" data-testid="connection-added">
          <Icon name="check" size={13} /> {t("connections.added")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !ready} className="btn-primary" data-testid="connection-add">
          {busy ? <Icon name="spinner" size={15} spin /> : <Icon name="server" size={15} />}
          {busy && mode === "password" ? t("connections.settingUp") : t("connections.addConnection")}
        </button>
        <button type="button" className="text-[12px] text-link hover:underline" onClick={() => (setMode(mode === "password" ? "key" : "password"), setError(""))} data-testid="connection-mode">
          {mode === "password" ? t("connections.useKey") : t("connections.usePassword")}
        </button>
      </div>
    </form>
  );
}
