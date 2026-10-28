import { useConnectionStore } from "../../stores/connectionStore";
import FileTree from "./FileTree";

interface Props {
  connectionId: string | null;
  setConnectionId: (id: string | null) => void;
  path: string | null;
  setPath: (p: string) => void;
}

export default function WorkspacePicker({
  connectionId,
  setConnectionId,
  path,
  setPath,
}: Props) {
  const connections = useConnectionStore((s) => s.connections);
  const initial = connectionId ? "." : "/home";

  return (
    <div className="space-y-2">
      <label className="text-xs text-gray-400">Workspace location</label>
      <select
        value={connectionId ?? ""}
        onChange={(e) => setConnectionId(e.target.value || null)}
        className="w-full bg-black/40 border border-border rounded px-2 py-1.5 text-sm"
      >
        <option value="">Local (this server · 2223)</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} — {c.username}@{c.host}:{c.port}
          </option>
        ))}
      </select>
      <FileTree
        key={connectionId ?? "local"}
        connectionId={connectionId}
        initialPath={initial}
        onPick={setPath}
        selected={path}
      />
      {path && (
        <p className="text-xs text-gray-400">
          Selected: <span className="font-mono text-accent">{path}</span>
        </p>
      )}
    </div>
  );
}
