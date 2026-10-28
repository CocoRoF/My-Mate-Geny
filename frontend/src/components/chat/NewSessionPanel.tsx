import { useState } from "react";
import { useProviderStore } from "../../stores/providerStore";
import { useSessionStore } from "../../stores/sessionStore";
import WorkspacePicker from "../workspaces/WorkspacePicker";
import Icon from "../ui/Icon";

export default function NewSessionPanel() {
  const providers = useProviderStore((s) => s.providers);
  const createSession = useSessionStore((s) => s.create);

  const [provider, setProvider] = useState("claude");
  const [model, setModel] = useState("sonnet");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = async () => {
    if (!path) {
      setError("Pick a workspace folder first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createSession({
        provider,
        model,
        connection_id: connectionId,
        workspace_path: path,
        title: path.split("/").pop() || "chat",
      });
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto grid place-items-center p-6">
      <div className="w-full max-w-lg card p-6 animate-fade-in">
        <div className="flex items-center gap-2.5 mb-5">
          <div className="grid place-items-center w-9 h-9 rounded-lg bg-gradient-to-br from-accent to-cyan shadow-glow">
            <Icon name="plus" size={18} className="text-white" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Start a new chat</h2>
            <p className="text-xs text-content-faint">Pick an engine, a model, and where it runs.</p>
          </div>
        </div>

        {/* Provider */}
        <label className="text-[11px] font-medium uppercase tracking-wider text-content-faint">
          Provider
        </label>
        <div className="grid grid-cols-2 gap-2 mt-1.5 mb-4">
          {providers.map((p) => {
            const sel = provider === p.provider;
            return (
              <button
                key={p.provider}
                onClick={() => p.connected && setProvider(p.provider)}
                disabled={!p.connected}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition ${
                  sel ? "border-accent/60 bg-accent-soft" : "border-border bg-surface/60 hover:border-border-strong"
                } ${!p.connected ? "opacity-45 cursor-not-allowed" : ""}`}
              >
                <Icon name="cpu" size={18} className={sel ? "text-accent" : "text-content-faint"} />
                <div className="min-w-0">
                  <div className="text-sm font-medium capitalize">{p.provider}</div>
                  <div className={`text-[10px] ${p.connected ? "text-success" : "text-content-faint"}`}>
                    {p.connected ? "connected" : "not connected"}
                  </div>
                </div>
                {sel && <Icon name="check" size={15} className="ml-auto text-accent" />}
              </button>
            );
          })}
        </div>

        {/* Model */}
        <label className="text-[11px] font-medium uppercase tracking-wider text-content-faint">
          Model
        </label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="sonnet"
          className="field mt-1.5 mb-4 font-mono"
        />

        {/* Workspace */}
        <WorkspacePicker
          connectionId={connectionId}
          setConnectionId={setConnectionId}
          path={path}
          setPath={setPath}
        />

        {error && (
          <p className="mt-3 text-xs text-danger flex items-center gap-1.5">
            <Icon name="x" size={13} /> {error}
          </p>
        )}

        <button onClick={start} disabled={busy} className="btn-primary w-full mt-5">
          {busy ? <Icon name="spinner" size={16} spin /> : <Icon name="bolt" size={16} />}
          {busy ? "Starting…" : "Start chat"}
        </button>
      </div>
    </div>
  );
}
