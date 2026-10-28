import { useState } from "react";
import { useProviderStore } from "../../stores/providerStore";
import Icon from "../ui/Icon";
import ProviderOAuthModal from "./ProviderOAuthModal";

export default function ProvidersView() {
  const providers = useProviderStore((s) => s.providers);
  const connect = useProviderStore((s) => s.connect);
  const disconnect = useProviderStore((s) => s.disconnect);
  const load = useProviderStore((s) => s.load);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [oauth, setOauth] = useState<string | null>(null);

  const saveKey = async (provider: string) => {
    if (!keys[provider]) return;
    setBusy(provider);
    try {
      await connect(provider, "api_key", keys[provider]);
      setKeys({ ...keys, [provider]: "" });
      setShowKey({ ...showKey, [provider]: false });
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
          Connect an agent engine with its own account — sign in right here in the browser, or store an API key.
        </p>

        <div className="space-y-3">
          {providers.map((p) => {
            const open = showKey[p.provider];
            return (
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
                        {p.connected ? "connected" : "disconnected"}
                      </span>
                      {p.connected && <span className="pill bg-surface-3 text-content-dim">{p.auth_mode}</span>}
                    </div>
                    <p className="text-xs text-content-faint mt-0.5">{p.detail}</p>
                  </div>
                  {p.connected ? (
                    <button
                      onClick={() => disconnect(p.provider)}
                      className="btn-ghost text-danger hover:text-danger"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button onClick={() => setOauth(p.provider)} className="btn-primary">
                      <Icon name="key" size={15} /> Sign in
                    </button>
                  )}
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => setShowKey({ ...showKey, [p.provider]: !open })}
                    className="text-[11px] text-content-faint hover:text-content-dim flex items-center gap-1"
                  >
                    <Icon name={open ? "chevron-down" : "chevron"} size={12} />
                    Use an API key instead
                  </button>
                </div>
                {open && (
                  <div className="mt-2 flex gap-2">
                    <input
                      type="password"
                      placeholder={`${p.provider === "codex" ? "OpenAI" : "Anthropic"} API key`}
                      value={keys[p.provider] || ""}
                      onChange={(e) => setKeys({ ...keys, [p.provider]: e.target.value })}
                      className="field flex-1 font-mono text-xs"
                    />
                    <button onClick={() => saveKey(p.provider)} disabled={busy === p.provider} className="btn-soft">
                      {busy === p.provider ? <Icon name="spinner" size={15} spin /> : "Save key"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {oauth && (
        <ProviderOAuthModal provider={oauth} onClose={() => setOauth(null)} onConnected={load} />
      )}
    </div>
  );
}
