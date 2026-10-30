import { useEffect, useState } from "react";
import { getGitInfo, type GitInfo } from "../../api/workspaces";
import Icon from "../ui/Icon";

// Compact git context for a workspace that is a repo (repo · branch · changes).
export default function GitContext({ path, connectionId }: { path: string; connectionId: string | null }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [spinning, setSpinning] = useState(false);

  const refresh = () => {
    setSpinning(true);
    getGitInfo(path, connectionId)
      .then(setInfo)
      .catch(() => {})
      .finally(() => setSpinning(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, connectionId]);

  if (!info?.is_repo) return null;

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="pill bg-violet/12 text-violet" title={info.remote}>
        <Icon name="github" size={11} /> {info.repo || "repo"}
      </span>
      <span className="pill bg-surface-3 text-content-dim">
        <Icon name="git-branch" size={11} /> {info.branch}
      </span>
      {info.changes ? (
        <span className="pill bg-warning/15 text-warning">{info.changes} changed</span>
      ) : (
        <span className="pill bg-success/10 text-success">clean</span>
      )}
      {(info.ahead || info.behind) ? (
        <span className="text-[10px] text-content-faint tabular-nums">↑{info.ahead} ↓{info.behind}</span>
      ) : null}
      <button onClick={refresh} className="text-content-faint hover:text-content transition" title="Refresh git status">
        <Icon name="refresh" size={11} spin={spinning} />
      </button>
    </div>
  );
}
