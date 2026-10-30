import { useEffect, useState } from "react";
import { useGitStore } from "../../stores/gitStore";
import Icon from "../ui/Icon";

export default function GitAccounts() {
  const accounts = useGitStore((s) => s.accounts);
  const load = useGitStore((s) => s.load);
  const connect = useGitStore((s) => s.connect);
  const remove = useGitStore((s) => s.remove);
  const [provider, setProvider] = useState("github");
  const [token, setToken] = useState("");
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setError("");
    try {
      await connect({ provider, token: token.trim(), host: host.trim() || undefined });
      setToken("");
      setHost("");
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2.5 mb-1">
        <Icon name="file" size={18} className="text-violet" />
        <h2 className="text-base font-semibold">Git (GitHub / GitLab)</h2>
      </div>
      <p className="text-sm text-content-dim mb-3">
        Connect with a personal access token (scope: <code className="text-xs bg-surface-3 px-1 rounded">repo</code> /{" "}
        <code className="text-xs bg-surface-3 px-1 rounded">read_api</code>). Then start a chat on any repo — the
        agent clones it and can commit &amp; push.
      </p>

      <div className="card p-4">
        <div className="flex gap-2 mb-2">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className="field w-32">
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
          {provider === "gitlab" && (
            <input
              placeholder="gitlab host (optional, e.g. gitlab.company.com)"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="field flex-1 font-mono text-xs"
            />
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            placeholder={`${provider === "github" ? "GitHub" : "GitLab"} personal access token`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            className="field flex-1 font-mono text-xs"
          />
          <button onClick={submit} disabled={busy} className="btn-primary">
            {busy ? <Icon name="spinner" size={15} spin /> : "Connect"}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-danger flex items-center gap-1.5"><Icon name="x" size={13} /> {error}</p>}
      </div>

      <div className="mt-3 space-y-2">
        {accounts.map((a) => (
          <div key={a.id} className="card flex items-center gap-3 p-3">
            <div className="grid place-items-center w-9 h-9 rounded-lg bg-surface-3">
              <Icon name="file" size={16} className="text-violet" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium flex items-center gap-2">
                {a.label}
                <span className="pill bg-surface-3 text-content-faint">{a.provider}</span>
              </div>
              <div className="text-xs text-content-faint font-mono truncate">
                {a.username}
                {a.host ? ` · ${a.host}` : ""}
              </div>
            </div>
            <button onClick={() => remove(a.id)} className="btn-ghost text-danger hover:text-danger" title="Remove">
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))}
        {accounts.length === 0 && <p className="text-xs text-content-faint">No Git accounts connected.</p>}
      </div>
    </div>
  );
}
