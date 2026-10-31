import { useEffect, useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useGitStore } from "../../stores/gitStore";
import FileTree from "./FileTree";
import RepoPicker from "./RepoPicker";
import Icon from "../ui/Icon";

interface Props {
  connectionId: string | null;
  setConnectionId: (id: string | null) => void;
  path: string | null;
  setPath: (p: string) => void;
}

// Source encoding in the <select>: "" = local, "ssh:<id>" = remote host, "git:<id>" = git repo.
export default function WorkspacePicker({ connectionId, setConnectionId, path, setPath }: Props) {
  const connections = useConnectionStore((s) => s.connections);
  const gitAccounts = useGitStore((s) => s.accounts);
  const loadGit = useGitStore((s) => s.load);
  const [gitId, setGitId] = useState<string | null>(null);

  useEffect(() => {
    loadGit();
  }, [loadGit]);

  const source = gitId ? `git:${gitId}` : connectionId ? `ssh:${connectionId}` : "";

  const onSource = (v: string) => {
    if (v.startsWith("git:")) {
      setGitId(v.slice(4));
      setConnectionId(null);
    } else if (v.startsWith("ssh:")) {
      setGitId(null);
      setConnectionId(v.slice(4));
    } else {
      setGitId(null);
      setConnectionId(null);
    }
  };

  const initial = connectionId ? "." : "/home";

  return (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-content-faint">Workspace</label>
      <select value={source} onChange={(e) => onSource(e.target.value)} className="field mt-1.5 mb-2">
        <option value="">💻  Local — this server</option>
        {connections.map((c) => (
          <option key={c.id} value={`ssh:${c.id}`}>
            🌐  {c.name} — {c.username}@{c.host}:{c.port}
          </option>
        ))}
        {gitAccounts.length > 0 && (
          <optgroup label="Git repositories">
            {gitAccounts.map((g) => (
              <option key={g.id} value={`git:${g.id}`}>
                🔗  {g.label} ({g.provider})
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {gitId ? (
        <RepoPicker accountId={gitId} onCloned={setPath} />
      ) : (
        <FileTree key={connectionId ?? "local"} connectionId={connectionId} initialPath={initial} onPick={setPath} selected={path} />
      )}

      {path && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-content-dim">
          <Icon name="check" size={12} className="text-success" />
          <span className="font-mono text-accent truncate">{path}</span>
        </p>
      )}
    </div>
  );
}
