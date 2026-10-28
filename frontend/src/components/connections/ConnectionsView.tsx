import { useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { connectionStatus } from "../../api/connections";
import ConnectionForm from "./ConnectionForm";

export default function ConnectionsView() {
  const connections = useConnectionStore((s) => s.connections);
  const remove = useConnectionStore((s) => s.remove);
  const [status, setStatus] = useState<Record<string, string>>({});

  const check = async (id: string) => {
    setStatus({ ...status, [id]: "checking…" });
    try {
      const r = await connectionStatus(id);
      setStatus({
        ...status,
        [id]: r.reachable ? "✓ reachable" : `✗ ${r.error || "unreachable"}`,
      });
    } catch (e: any) {
      setStatus({ ...status, [id]: `✗ ${e.message}` });
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <h2 className="text-lg font-medium">Remote connections</h2>
      <p className="text-sm text-gray-400">
        Register SSH hosts (e.g. 2222 / 2224). Folders there can be used as workspaces — mounted
        via sshfs with commands proxied over SSH. The runtime stays on 2223.
      </p>
      <ConnectionForm />
      <div className="space-y-2">
        {connections.length === 0 && (
          <p className="text-xs text-gray-500">No connections yet.</p>
        )}
        {connections.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-3 p-3 bg-panel border border-border rounded"
          >
            <div className="flex-1">
              <div className="text-sm">{c.name}</div>
              <div className="text-xs text-gray-500 font-mono">
                {c.username}@{c.host}:{c.port} · {c.default_path} · {c.has_key ? "🔑" : "no key"}
              </div>
              {status[c.id] && <div className="text-xs mt-0.5">{status[c.id]}</div>}
            </div>
            <button
              onClick={() => check(c.id)}
              className="px-2 py-1 rounded bg-white/5 text-xs hover:bg-white/10"
            >
              Test
            </button>
            <button
              onClick={() => remove(c.id)}
              className="px-2 py-1 rounded bg-red-500/10 text-red-400 text-xs"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
