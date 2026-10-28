import { useState } from "react";
import { useProviderStore } from "../../stores/providerStore";

export default function ProvidersView() {
  const providers = useProviderStore((s) => s.providers);
  const connect = useProviderStore((s) => s.connect);
  const disconnect = useProviderStore((s) => s.disconnect);
  const [keys, setKeys] = useState<Record<string, string>>({});

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <h2 className="text-lg font-medium">Providers</h2>
      <p className="text-sm text-gray-400">
        Claude Code uses your local subscription auth automatically. You can also store an API
        key. Codex is interface-only until the <code>codex</code> CLI is installed.
      </p>
      {providers.map((p) => (
        <div key={p.provider} className="p-4 bg-panel border border-border rounded-lg space-y-3">
          <div className="flex items-center gap-2">
            <span className="font-medium capitalize">{p.provider}</span>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                p.connected ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-400"
              }`}
            >
              {p.connected ? "connected" : "disconnected"}
            </span>
            <span className="text-xs text-gray-500">{p.auth_mode}</span>
          </div>
          <p className="text-xs text-gray-400">{p.detail}</p>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="API key (optional)"
              value={keys[p.provider] || ""}
              onChange={(e) => setKeys({ ...keys, [p.provider]: e.target.value })}
              className="flex-1 bg-black/40 border border-border rounded px-2 py-1 text-sm"
            />
            <button
              onClick={() =>
                connect(
                  p.provider,
                  keys[p.provider] ? "api_key" : "oauth",
                  keys[p.provider] || "",
                )
              }
              className="px-3 py-1 rounded bg-accent/20 text-accent text-sm"
            >
              {keys[p.provider] ? "Save key" : "Use OAuth"}
            </button>
            {p.connected && (
              <button
                onClick={() => disconnect(p.provider)}
                className="px-3 py-1 rounded bg-red-500/10 text-red-400 text-sm"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
