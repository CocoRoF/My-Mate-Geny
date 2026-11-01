import { useEffect, useMemo, useState } from "react";
import { getRepos, cloneRepo, type GitRepo } from "../../api/git";
import Icon from "../ui/Icon";
import { useT } from "../../i18n";

export default function RepoPicker({
  accountId,
  onCloned,
}: {
  accountId: string;
  onCloned: (localPath: string) => void;
}) {
  const t = useT();
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [cloning, setCloning] = useState<string | null>(null);

  // Repos are tagged with the account they came from: after a quick account
  // switch, a stale list must never be cloned with the other account's token.
  const [reposOf, setReposOf] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setRepos([]);
    setReposOf(null);
    getRepos(accountId)
      .then((r) => {
        if (!alive) return;
        setRepos(r);
        setReposOf(accountId);
      })
      .catch((e) => alive && setError(String(e.message || e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [accountId]);

  const filtered = useMemo(
    () => repos.filter((r) => r.full_name.toLowerCase().includes(query.toLowerCase())),
    [repos, query],
  );

  const use = async (r: GitRepo) => {
    if (reposOf !== accountId) return;
    setCloning(r.full_name);
    setError("");
    try {
      const res = await cloneRepo(accountId, r.full_name, r.clone_url);
      onCloned(res.path);
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setCloning(null);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-surface/40 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border bg-surface-2/40">
        <Icon name="search" size={13} className="text-content-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("workspace.searchRepos")}
          className="flex-1 bg-transparent text-[13px] text-content placeholder:text-content-faint outline-none"
        />
        <span className="text-[11px] text-content-faint">{filtered.length}</span>
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {loading && (
          <p className="px-2 py-3 text-xs text-content-faint flex items-center gap-1.5">
            <Icon name="spinner" size={13} spin /> {t("workspace.loadingRepos")}
          </p>
        )}
        {error && <p className="px-2 py-3 text-xs text-danger flex items-center gap-1.5"><Icon name="x" size={13} /> {error}</p>}
        {!loading &&
          filtered.map((r) => (
            <div key={r.full_name} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-3 transition">
              <Icon name="file" size={14} className="text-violet shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-content/90">
                  {r.full_name}
                  {r.private && <span className="ml-1.5 pill bg-surface-3 text-content-faint">{t("workspace.private")}</span>}
                </div>
                {r.description && <div className="truncate text-[11px] text-content-faint">{r.description}</div>}
              </div>
              <button
                onClick={() => use(r)}
                disabled={cloning === r.full_name}
                className="pill bg-accent-soft text-accent hover:bg-accent/20 shrink-0"
              >
                {cloning === r.full_name ? (
                  <>
                    <Icon name="spinner" size={11} spin /> {t("workspace.cloning")}
                  </>
                ) : (
                  t("workspace.use")
                )}
              </button>
            </div>
          ))}
        {!loading && !error && filtered.length === 0 && (
          <p className="px-2 py-3 text-xs text-content-faint">{query ? t("workspace.noReposMatch") : t("workspace.noRepos")}</p>
        )}
      </div>
    </div>
  );
}
