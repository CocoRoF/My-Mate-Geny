import { isApiProvider } from "../../api/apiProviders";
import { useState } from "react";
import { useProviderStore } from "../../stores/providerStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useConfigStore } from "../../stores/configStore";
import LocalWorkspacePicker from "../workspaces/LocalWorkspacePicker";
import WorkspacePicker from "../workspaces/WorkspacePicker";
import Icon from "../ui/Icon";
import { useT } from "../../i18n";

/** a new chat's model per engine until the catalog says otherwise (backend catalog defaults) */
const DEFAULT_CHAT_MODELS: Record<string, string> = { claude: "claude-opus-5-5", codex: "gpt-6.1-sol" };

export default function NewSessionPanel() {
  const t = useT();
  const providers = useProviderStore((s) => s.providers);
  const catalog = useConfigStore((s) => s.catalog);
  const local = useConfigStore((s) => s.executionMode)==="local";
  const createSession = useSessionStore((s) => s.create);

  const firstConnected = providers.find((p) => p.connected)?.provider || "claude";
  const [provider, setProvider] = useState(firstConnected);
  const entry = catalog[provider];
  const models = entry?.models || [];
  // The user's explicit pick; until then (or when it isn't offered) the
  // provider's default — Opus 5.5 for Claude, GPT-6.1-Sol for Codex. The
  // catalog may arrive after this screen mounts, so the default is derived,
  // not captured once.
  const [picked, setPicked] = useState<string | null>(null);
  const model =
    picked && (!models.length || models.some((m) => m.id === picked))
      ? picked
      : entry?.default_model || DEFAULT_CHAT_MODELS[provider] || "";
  const [effort, setEffort] = useState("default");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pickProvider = (id: string) => {
    setProvider(id);
    setPicked(null);
    setEffort("default");
  };

  const start = async () => {
    if (!path) {
      setError(t("chat.pickWorkspace"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createSession({
        provider,
        model,
        effort,
        connection_id: connectionId,
        workspace_path: path,
        title: path.split(/[\\/]/).pop() || "chat",
      });
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const efforts = catalog[provider]?.effort || ["default"];

  return (
    <div className="h-full overflow-y-auto grid place-items-center p-6">
      <div className="w-full max-w-lg card p-6 animate-fade-in">
        <div className="flex items-center gap-2.5 mb-5">
          <div className="grid place-items-center w-9 h-9 rounded-lg bg-gradient-to-br from-accent to-cyan shadow-glow">
            <Icon name="plus" size={18} className="text-white" />
          </div>
          <div>
            <h2 className="text-base font-semibold">{t("chat.newTitle")}</h2>
            <p className="text-xs text-content-faint">{t("chat.newSub")}</p>
          </div>
        </div>

        {/* Provider */}
        <label className="text-[11px] font-medium uppercase tracking-wider text-content-faint">{t("chat.provider")}</label>
        <div className="grid grid-cols-2 gap-2 mt-1.5 mb-4">
          {(Object.keys(catalog).length ? Object.keys(catalog) : ["claude", "codex"]).map((id) => {
            const p = providers.find((x) => x.provider === id);
            const sel = provider === id;
            const connected = p?.connected;
            return (
              <button
                key={id}
                onClick={() => connected && pickProvider(id)}
                disabled={!connected}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition ${
                  sel ? "border-accent/60 bg-accent-soft" : "border-border bg-surface/60 hover:border-border-strong"
                } ${!connected ? "opacity-45 cursor-not-allowed" : ""}`}
              >
                <Icon name="cpu" size={18} className={sel ? "text-accent" : "text-content-faint"} />
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {catalog[id]?.label || id}
                    {isApiProvider(id) && <span className="ml-1.5 text-[10px] font-semibold text-content-faint">API</span>}
                  </div>
                  <div className={`text-[10px] ${connected ? "text-success" : "text-content-faint"}`}>
                    {connected ? t("chat.connectedLower") : t("chat.notConnected")}
                  </div>
                </div>
                {sel && <Icon name="check" size={15} className="ml-auto text-accent" />}
              </button>
            );
          })}
        </div>

        {/* Model + Think */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-content-faint">{t("chat.groupModel")}</label>
            <select value={model} onChange={(e) => setPicked(e.target.value)} className="field mt-1.5">
              {models.length ? (
                models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))
              ) : (
                <option value={model}>{model || t("common.default")}</option>
              )}
            </select>
          </div>
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-content-faint">{t("chat.groupThink")}</label>
            <select value={effort} onChange={(e) => setEffort(e.target.value)} className="field mt-1.5">
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e === "default" ? t("common.default") : e}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Workspace */}
        {local?<LocalWorkspacePicker path={path} onChange={value=>{setPath(value);setConnectionId(null);}} onError={setError}/>:<WorkspacePicker
          connectionId={connectionId}
          setConnectionId={setConnectionId}
          path={path}
          setPath={setPath}
        />}

        {error && (
          <p className="mt-3 text-xs text-danger flex items-center gap-1.5">
            <Icon name="x" size={13} /> {error}
          </p>
        )}

        <button onClick={start} disabled={busy} className="btn-primary w-full mt-5">
          {busy ? <Icon name="spinner" size={16} spin /> : <Icon name="bolt" size={16} />}
          {busy ? t("chat.starting") : t("chat.startChat")}
        </button>
      </div>
    </div>
  );
}
