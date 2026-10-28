import { useEffect, useState } from "react";
import { listDir } from "../../api/workspaces";
import type { DirEntry } from "../../types";

interface Props {
  connectionId: string | null;
  initialPath: string;
  onPick: (path: string) => void;
  selected: string | null;
}

/** Simple one-level directory browser with breadcrumb navigation. */
export default function FileTree({ connectionId, initialPath, onPick, selected }: Props) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setError("");
    listDir(path, connectionId)
      .then((r) => alive && setEntries(r.entries))
      .catch((e) => alive && setError(String(e.message || e)));
    return () => {
      alive = false;
    };
  }, [path, connectionId]);

  const parent = () => {
    const parts = path.replace(/\/+$/, "").split("/");
    parts.pop();
    setPath(parts.join("/") || "/");
  };

  return (
    <div className="border border-border rounded bg-black/30">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border text-xs text-gray-400">
        <button onClick={parent} className="hover:text-gray-200">
          ↑
        </button>
        <span className="truncate flex-1 font-mono">{path}</span>
        <button
          onClick={() => onPick(path)}
          className="px-2 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/30"
        >
          use this
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto">
        {error && <p className="px-2 py-2 text-xs text-red-400">{error}</p>}
        {!error &&
          entries
            .filter((e) => e.is_dir)
            .map((e) => (
              <div
                key={e.path}
                className={`flex items-center gap-2 px-2 py-1 text-sm cursor-pointer hover:bg-white/5 ${
                  selected === e.path ? "text-accent" : ""
                }`}
                onClick={() => setPath(e.path)}
                onDoubleClick={() => onPick(e.path)}
              >
                <span>📁</span>
                <span className="truncate">{e.name}</span>
              </div>
            ))}
        {!error && entries.filter((e) => e.is_dir).length === 0 && (
          <p className="px-2 py-2 text-xs text-gray-500">No subfolders.</p>
        )}
      </div>
    </div>
  );
}
