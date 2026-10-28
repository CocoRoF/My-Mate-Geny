import { useState } from "react";
import { useProviderStore } from "../../stores/providerStore";
import Icon from "../ui/Icon";

export default function ProvidersView() {
  const providers = useProviderStore((s) => s.providers);
  const connect = useProviderStore((s) => s.connect);
  const disconnect = useProviderStore((s) => s.disconnect);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const doConnect = async (provider: string) => {
    setBusy(provider);
    try {
      await connect(provider, keys[provider] ? "api_key" : "oauth", keys[provider] || "");
      setKeys({ ...keys, [provider]: "" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <div className="flex items-center gap-2.5 mb-1">
          <Icon name="plug" size={20} className="text-accent" />
          <h1 className="text-lg font-semibold">Providers</h1>
        </div>
        <p className="text-sm text-content-dim mb-6">
          Claude Code uses your local subscription auth automatically. Codex needs{" "}
          <code className="font-mono text-xs bg-surface-3 px-1.5 py-0.5 rounded">codex login</code> or
          an API key.
        </p>

        <div className="space-y-3">
          {providers.map((p) => (
            <div key={p.provider} className="card p-4">
              <div className="flex items-center gap-3">
                <div
                  className={`grid place-items-center w-10 h-10 rounded-lg ${
                    p.connected ? "bg-gradient-to-br from-accent to-cyan shadow-glow" : "bg-surface-3"
                  }`}
                >
                  <Icon name="cpu" size={19} className={p.connected ? "text-white" : "text-content-faint"} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium capitalize">{p.provider}</span>
                    <span
                      className={`pill ${
                        p.connected ? "bg-success/15 text-success" : "bg-surface-3 text-content-faint"
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${p.connected ? "bg-success" : "bg-content-faint"}`}
                      />
                      {p.connected ? "connected" : "disconnected"}
                    </span>
                    <span className="pill bg-surface-3 text-content-dim">{p.auth_mode}</span>
                  </div>
                  <p className="text-xs text-content-faint mt-0.5">{p.detail}</p>
                </div>
                {p.connected && (
                  <button onClick={() => disconnect(p.provider)} className="btn-ghost text-danger hover:text-danger">
                    Disconnect
                  </button>
                )}
              </div>

              <div className="flex gap-2 mt-3">
                <input
                  type="password"
                  placeholder={`${p.provider === "codex" ? "OpenAI" : "Anthropic"} API key (optional)`}
                  value={keys[p.provider] || ""}
                  onChange={(e) => setKeys({ ...keys, [p.provider]: e.target.value })}
                  className="field flex-1 font-mono text-xs"
                />
                <button onClick={() => doConnect(p.provider)} disabled={busy === p.provider} className="btn-soft">
                  {busy === p.provider ? (
                    <Icon name="spinner" size={15} spin />
                  ) : keys[p.provider] ? (
                    "Save key"
                  ) : (
                    "Use OAuth"
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
