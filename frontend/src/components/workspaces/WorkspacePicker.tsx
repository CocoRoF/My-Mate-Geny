import { useConnectionStore } from "../../stores/connectionStore";
import FileTree from "./FileTree";
import Icon from "../ui/Icon";

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
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-content-faint">
        Workspace
      </label>
      <select
        value={connectionId ?? ""}
        onChange={(e) => setConnectionId(e.target.value || null)}
        className="field mt-1.5 mb-2"
      >
        <option value="">💻  Local — this server (2223)</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            🌐  {c.name} — {c.username}@{c.host}:{c.port}
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
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-content-dim">
          <Icon name="check" size={12} className="text-success" />
          <span className="font-mono text-accent truncate">{path}</span>
        </p>
      )}
    </div>
  );
}
