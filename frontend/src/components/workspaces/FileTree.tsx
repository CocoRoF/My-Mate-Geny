import { useEffect, useState } from "react";
import { listDir } from "../../api/workspaces";
import type { DirEntry } from "../../types";
import Icon from "../ui/Icon";

interface Props {
  connectionId: string | null;
  initialPath: string;
  onPick: (path: string) => void;
  selected: string | null;
}

export default function FileTree({ connectionId, initialPath, onPick, selected }: Props) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setError("");
    setLoading(true);
    listDir(path, connectionId)
      .then((r) => alive && setEntries(r.entries))
      .catch((e) => alive && setError(String(e.message || e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, connectionId]);

  const parent = () => {
    const parts = path.replace(/\/+$/, "").split("/");
    parts.pop();
    setPath(parts.join("/") || "/");
  };

  const isSelected = selected === path;
  const dirs = entries.filter((e) => e.is_dir);

  return (
    <div className="rounded-lg border border-border bg-surface/50 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border bg-surface-2/50">
        <button onClick={parent} className="text-content-faint hover:text-content transition" title="Up">
          <Icon name="arrow-up" size={14} />
        </button>
        <span className="flex-1 truncate font-mono text-[12px] text-content-dim">{path}</span>
        <button
          onClick={() => onPick(path)}
          className={`pill transition ${
            isSelected ? "bg-accent text-white" : "bg-accent-soft text-accent hover:bg-accent/20"
          }`}
        >
          {isSelected ? (
            <>
              <Icon name="check" size={11} /> selected
            </>
          ) : (
            "use this"
          )}
        </button>
      </div>
      <div className="max-h-52 overflow-y-auto p-1">
        {loading && <p className="px-2 py-3 text-xs text-content-faint">Loading…</p>}
        {error && (
          <p className="px-2 py-3 text-xs text-danger flex items-center gap-1.5">
            <Icon name="x" size={13} /> {error}
          </p>
        )}
        {!loading && !error && dirs.length === 0 && (
          <p className="px-2 py-3 text-xs text-content-faint">No subfolders.</p>
        )}
        {!error &&
          dirs.map((e) => (
            <div
              key={e.path}
              onClick={() => setPath(e.path)}
              onDoubleClick={() => onPick(e.path)}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-surface-3 transition"
            >
              <Icon name="folder" size={15} className="text-warning/80" />
              <span className="truncate text-content/85">{e.name}</span>
              <Icon
                name="chevron"
                size={13}
                className="ml-auto text-content-faint opacity-0 group-hover:opacity-100"
              />
            </div>
          ))}
      </div>
    </div>
  );
}
