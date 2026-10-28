import { useState } from "react";
import { useProviderStore } from "../../stores/providerStore";
import { useSessionStore } from "../../stores/sessionStore";
import WorkspacePicker from "../workspaces/WorkspacePicker";

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
    <div className="max-w-xl mx-auto mt-10 p-5 bg-panel border border-border rounded-lg space-y-4">
      <h2 className="text-lg font-medium">Start a new chat</h2>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full bg-black/40 border border-border rounded px-2 py-1.5 text-sm"
          >
            {providers.map((p) => (
              <option key={p.provider} value={p.provider} disabled={!p.connected}>
                {p.provider} {p.connected ? "" : "(not connected)"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400">Model</label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="sonnet"
            className="w-full bg-black/40 border border-border rounded px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      <WorkspacePicker
        connectionId={connectionId}
        setConnectionId={setConnectionId}
        path={path}
        setPath={setPath}
      />

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={start}
        disabled={busy}
        className="w-full py-2 rounded bg-accent text-black font-medium disabled:opacity-50"
      >
        {busy ? "Starting…" : "Start chat"}
      </button>
    </div>
  );
}
