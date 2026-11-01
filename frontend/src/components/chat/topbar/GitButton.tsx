import { useEffect, useRef, useState } from "react";
import {
  connectSessionGit,
  detectSessionRepos,
  disconnectSessionGit,
  sessionGitBranches,
  sessionGitCheckout,
  type FoundRepo,
  type GitBranches,
  type GitStatus,
} from "../../../api/sessionGit";
import { useGitStore } from "../../../stores/gitStore";
import { useSessionGit } from "../../../stores/sessionGitStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { openPath, useWorkbench } from "../../../stores/workbenchStore";
import type { Session } from "../../../types";
import { absTime, relTime } from "../../admin/format";
import GitAccounts from "../../connections/GitAccounts";
import Icon from "../../ui/Icon";
import Popover from "../../ui/Popover";
import RepoPicker from "../../workspaces/RepoPicker";

const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
// git's letter → [shown as, colour, name] (untracked shows as U like editors do, so a conflict shows as !)
const STATUS: Record<string, [string, string, string]> = {
  M: ["M", "text-warning", "modified"],
  A: ["A", "text-success", "added"],
  "?": ["U", "text-success", "untracked"],
  D: ["D", "text-danger", "deleted"],
  U: ["!", "text-danger", "conflict"],
  R: ["R", "text-cyan", "renamed"],
  C: ["C", "text-cyan", "copied"],
  T: ["T", "text-warning", "type changed"],
};

/** ↑ahead ↓behind, only what's non-zero. */
function AheadBehind({ s, className = "" }: { s: GitStatus; className?: string }) {
  if (!s.ahead && !s.behind) return null;
  return (
    <span className={`tabular-nums ${className}`} title={`${s.ahead || 0} commit(s) to push, ${s.behind || 0} to pull (vs ${s.upstream})`}>
      {s.ahead ? `↑${s.ahead}` : ""}
      {s.ahead && s.behind ? " " : ""}
      {s.behind ? `↓${s.behind}` : ""}
    </span>
  );
}

/**
 * The top bar's Git button: the chat's repository (the workspace's own, or one picked) — branch and changes on the
 * button; the popover shows repo, remote, branch (switch), changed files, ahead/behind, last commit, refresh and
 * disconnect, or — not connected — repos found in the chat's folders and cloning one with a Git account.
 * Status is read when the chat opens, when a turn ends and when the popover opens — never polled.
 */
export default function GitButton({ session, compact }: { session: Session; compact?: boolean }) {
  const sid = session.id;
  const entry = useSessionGit((s) => s.byId[sid]);
  const refresh = useSessionGit((s) => s.refresh);
  const setStatus = useSessionGit((s) => s.set);
  const patchLocal = useSessionStore((s) => s.patchLocal);
  const epoch = useWorkbench((s) => s.epoch);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const st = entry?.status || null;
  const connected = !!st?.connected;

  // the chat opened / its folders or repo changed / a turn ended (epoch) → read the status again
  const key = `${sid}|${session.git_repo ?? "auto"}|${(session.extra_dirs || []).join(":")}`;
  useEffect(() => {
    refresh(sid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, epoch]);

  const toggle = () =>
    setOpen((v) => {
      if (!v) refresh(sid);
      return !v;
    });

  const changes = st?.changes || 0;
  const label = connected ? st!.branch || "HEAD" : "Git";
  const title = connected
    ? `${st!.repo} · ${st!.branch}${changes ? ` · ${changes} changed` : " · clean"}${st!.ahead ? ` · ${st!.ahead} to push` : ""}${
        st!.behind ? ` · ${st!.behind} to pull` : ""
      }`
    : st?.mode === "off"
      ? "Git — disconnected; click to connect a repository"
      : "Git — connect a repository";

  return (
    <>
      <button
        ref={btn}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="topbar-git"
        data-topbar-item="git"
        data-connected={connected ? "true" : "false"}
        title={title}
        className={`btn-ghost relative h-10 w-10 shrink-0 p-0 sm:h-auto sm:w-auto sm:min-w-0 sm:px-2 sm:py-1 ${
          open ? "bg-surface-3 text-content" : connected ? "" : "text-content-faint"
        }`}
      >
        <Icon name="git-branch" size={14} className={connected ? "shrink-0 text-violet" : "shrink-0"} />
        <span className={`${compact ? "hidden" : "hidden sm:inline"} min-w-0 max-w-[9rem] truncate ${connected ? "font-mono text-[12px]" : ""}`}>
          {label}
        </span>
        {connected && changes > 0 && (
          <span
            className={`${compact ? "hidden" : "hidden sm:inline"} shrink-0 font-mono text-[11.5px] text-warning`}
            data-testid="topbar-git-changes"
          >
            • {changes}
          </span>
        )}
        {connected && <AheadBehind s={st!} className={`${compact ? "hidden" : "hidden sm:inline"} shrink-0 text-[11px] text-content-faint`} />}
        {/* icon-only (phones / a tight bar): a dot says "changes" */}
        {connected && changes > 0 && (
          <span className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warning ${compact ? "" : "sm:hidden"}`} aria-hidden />
        )}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} label="Git" width={420} testId="git-popover">
        {connected ? (
          <Connected
            session={session}
            st={st!}
            loading={!!entry?.loading}
            onRefresh={() => refresh(sid)}
            onStatus={(s) => setStatus(sid, s)}
            onDisconnected={(s) => {
              setStatus(sid, s);
              patchLocal(sid, { git_repo: "" });
            }}
            onClose={() => setOpen(false)}
          />
        ) : (
          <NotConnected
            session={session}
            st={st}
            loading={!!entry?.loading && !st}
            onConnected={(s) => {
              setStatus(sid, s);
              patchLocal(sid, { git_repo: s.root ?? null });
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </Popover>
    </>
  );
}

function Header({ title, sub, onClose, children }: { title: React.ReactNode; sub?: React.ReactNode; onClose: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2.5">
      <Icon name="git-branch" size={14} className="shrink-0 text-violet" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-content">{title}</div>
        {sub && <div className="truncate font-mono text-[10.5px] text-content-faint">{sub}</div>}
      </div>
      {children}
      <button onClick={onClose} className="shrink-0 rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content" aria-label="Close">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function Connected({
  session,
  st,
  loading,
  onRefresh,
  onStatus,
  onDisconnected,
  onClose,
}: {
  session: Session;
  st: GitStatus;
  loading: boolean;
  onRefresh: () => void;
  onStatus: (s: GitStatus) => void;
  onDisconnected: (s: GitStatus) => void;
  onClose: () => void;
}) {
  const sid = session.id;
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState("");
  const running = !!session.running;

  useEffect(() => {
    let alive = true;
    sessionGitBranches(sid)
      .then((b) => alive && setBranches(b))
      .catch(() => alive && setBranches(null));
    return () => {
      alive = false;
    };
  }, [sid, st.branch]);

  const switchTo = async (value: string) => {
    if (!value || value === st.branch) return;
    const track = value.startsWith("remote:");
    const name = track ? value.slice(7) : value;
    setSwitching(name);
    setError("");
    try {
      onStatus(await sessionGitCheckout(sid, name, track));
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setSwitching(null);
    }
  };
  const disconnect = async () => {
    setError("");
    try {
      onDisconnected(await disconnectSessionGit(sid));
    } catch (e: any) {
      setError(String(e.message || e));
    }
  };

  const c = st.counts;
  const files = st.files || [];
  const changes = st.changes || 0;
  const root = st.root || st.path || "";
  const summary = c
    ? [
        c.modified && `${c.modified} modified`,
        c.staged && `${c.staged} staged`,
        c.untracked && `${c.untracked} untracked`,
        c.conflicted && `${c.conflicted} conflicted`,
      ].filter(Boolean)
    : [];

  return (
    <>
      <Header title={st.repo || base(root)} sub={st.remote || "no remote (local repository)"} onClose={onClose}>
        <button
          onClick={onRefresh}
          className="shrink-0 rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content"
          title="Refresh"
          aria-label="Refresh Git status"
          data-testid="git-refresh"
        >
          <Icon name="refresh" size={13} spin={loading} />
        </button>
      </Header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {/* branch */}
        <div>
          <label htmlFor="git-branch-select" className="mb-1 block text-[10.5px] uppercase tracking-wide text-content-faint">
            Branch
          </label>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <select
                id="git-branch-select"
                data-testid="git-branch-select"
                value={st.detached ? "" : st.branch}
                disabled={!!switching || running}
                onChange={(e) => switchTo(e.target.value)}
                className="field appearance-none py-1.5 pr-8 font-mono text-[12.5px]"
                title={running ? "The agent is working — switch after its turn" : "Switch branch"}
              >
                {st.detached && <option value="">detached at {st.branch}</option>}
                {!branches && !st.detached && <option value={st.branch}>{st.branch}</option>}
                {branches && (
                  <>
                    <optgroup label="Local">
                      {branches.local.map((b) => (
                        <option key={b.name} value={b.name}>
                          {b.name}
                        </option>
                      ))}
                    </optgroup>
                    {branches.remote.length > 0 && (
                      <optgroup label="Remote (creates a local branch)">
                        {branches.remote.map((b) => (
                          <option key={b.name} value={`remote:${b.name}`}>
                            {b.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </>
                )}
              </select>
              <Icon
                name={switching ? "spinner" : "chevron-down"}
                spin={!!switching}
                size={13}
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-content-faint"
              />
            </div>
            {st.upstream ? (
              <span className="shrink-0 text-[11.5px] text-content-dim" data-testid="git-ahead-behind">
                {st.ahead || st.behind ? <AheadBehind s={st} /> : "up to date"}
                <span className="text-content-faint"> · {st.upstream}</span>
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-content-faint">no upstream</span>
            )}
          </div>
          {running && <p className="mt-1 text-[11px] text-content-faint">The agent is working in this chat — switch after its turn.</p>}
        </div>

        {/* changes */}
        <div>
          <div className="mb-1 flex items-center gap-2 text-[10.5px] uppercase tracking-wide text-content-faint">
            Changes
            {changes > 0 && <span className="normal-case tracking-normal text-content-dim">{summary.join(" · ")}</span>}
          </div>
          {changes === 0 ? (
            <p className="flex items-center gap-1.5 text-[12px] text-success">
              <Icon name="check" size={13} /> Working tree clean
            </p>
          ) : (
            <ul className="space-y-px" data-testid="git-files">
              {files.slice(0, 8).map((f) => (
                <li key={f.path}>
                  <button
                    onClick={() => {
                      onClose();
                      openPath(session, `${root}/${f.path}`).catch(() => {});
                    }}
                    className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-3"
                    title={`Open ${f.path}`}
                  >
                    <span
                      className={`w-3.5 shrink-0 text-center font-mono text-[11px] ${STATUS[f.status]?.[1] || "text-content-dim"}`}
                      title={STATUS[f.status]?.[2] || f.status}
                    >
                      {STATUS[f.status]?.[0] || f.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-content-dim">{f.path}</span>
                    {f.staged && <span className="shrink-0 text-[10px] text-content-faint">staged</span>}
                  </button>
                </li>
              ))}
              {changes > 8 && <li className="pt-0.5 text-[11px] text-content-faint">+{changes - 8} more</li>}
            </ul>
          )}
        </div>

        {/* last commit */}
        {st.last_commit ? (
          <div>
            <div className="mb-1 text-[10.5px] uppercase tracking-wide text-content-faint">Last commit</div>
            <div className="flex items-baseline gap-2 text-[12px]">
              <span className="shrink-0 font-mono text-[11px] text-violet">{st.last_commit.sha}</span>
              <span className="min-w-0 flex-1 truncate text-content" title={st.last_commit.subject}>
                {st.last_commit.subject}
              </span>
            </div>
            <div className="text-[11px] text-content-faint" title={absTime(st.last_commit.date)}>
              {st.last_commit.author} · {relTime(st.last_commit.date)}
            </div>
          </div>
        ) : (
          st.initial && <p className="text-[12px] text-content-faint">No commits yet.</p>
        )}
        {error && <p className="text-[11.5px] text-danger" data-testid="git-error">{error}</p>}
      </div>
      <div className="flex items-center gap-2 border-t border-border/70 px-3.5 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-content-faint" title={root}>
          {st.mode === "auto" ? "workspace · " : ""}
          {root}
        </span>
        <button
          onClick={disconnect}
          className="btn-ghost shrink-0 py-1 px-2 text-[12px] hover:text-danger"
          title="Stop showing this repository here (nothing on disk changes)"
          data-testid="git-disconnect"
        >
          Disconnect
        </button>
      </div>
    </>
  );
}

function NotConnected({
  session,
  st,
  loading,
  onConnected,
  onClose,
}: {
  session: Session;
  st: GitStatus | null;
  loading: boolean;
  onConnected: (s: GitStatus) => void;
  onClose: () => void;
}) {
  const sid = session.id;
  const accounts = useGitStore((s) => s.accounts);
  const loadAccounts = useGitStore((s) => s.load);
  const [found, setFound] = useState<FoundRepo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [addAccount, setAddAccount] = useState(false);
  const remote = !!session.connection_id;

  useEffect(() => {
    let alive = true;
    detectSessionRepos(sid)
      .then((r) => alive && setFound(r.repos))
      .catch((e) => {
        if (!alive) return;
        setFound([]);
        setError(String(e.message || e));
      });
    if (!remote) loadAccounts().catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);
  useEffect(() => {
    if (!accountId && accounts.length) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const connect = async (path: string, addFolder = false) => {
    setBusy(path);
    setError("");
    try {
      onConnected(await connectSessionGit(sid, path, addFolder));
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Header title="Connect a Git repository" onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        <p className="text-[11.5px] leading-snug text-content-dim">
          {st?.mode === "off"
            ? "Disconnected. Pick the repository this chat works on — its branch and changes show in the top bar."
            : st?.error
              ? `Couldn't read Git here: ${st.error}`
              : "The workspace isn't a Git repository. Pick one this chat works on — its branch and changes show in the top bar."}
        </p>

        <div>
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-content-faint">In this chat's folders</div>
          {found === null || loading ? (
            <p className="flex items-center gap-1.5 py-1 text-[12px] text-content-faint">
              <Icon name="spinner" size={13} spin /> Looking for repositories…
            </p>
          ) : found.length === 0 ? (
            <p className="py-1 text-[12px] text-content-faint">No repositories in the workspace or its folders.</p>
          ) : (
            <ul className="space-y-1" data-testid="git-found">
              {found.map((r) => (
                <li key={r.path} className="flex items-center gap-2 rounded-lg bg-surface/70 px-2.5 py-1.5">
                  <Icon name={r.remote.includes("github") ? "github" : "git-branch"} size={13} className="shrink-0 text-violet" />
                  <span className="min-w-0 flex-1" title={r.path}>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] text-content">{r.repo}</span>
                      {r.branch && <span className="shrink-0 font-mono text-[10.5px] text-content-dim">{r.branch}</span>}
                    </span>
                    <span className="block truncate font-mono text-[10.5px] text-content-faint">{r.path}</span>
                  </span>
                  <button
                    onClick={() => connect(r.path)}
                    disabled={busy !== null}
                    className="pill shrink-0 bg-accent-soft text-accent hover:bg-accent/20"
                    aria-label={`Connect ${r.repo}`}
                  >
                    {busy === r.path ? <Icon name="spinner" size={11} spin /> : "Connect"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border/70 pt-2.5">
          <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-content-faint">Clone with a Git account</div>
          {remote ? (
            <p className="text-[12px] text-content-faint">
              Cloning with an account works for workspaces on this server. On a remote host, clone there (or ask the agent to)
              and connect it from the list above.
            </p>
          ) : accounts.length === 0 || addAccount ? (
            addAccount ? (
              <div className="text-[12px] [&_.card]:p-3">
                <GitAccounts />
                <button onClick={() => setAddAccount(false)} className="btn-ghost mt-2 py-1 px-2 text-[12px]">
                  Done
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <p className="flex-1 text-[12px] text-content-faint">No Git account connected yet.</p>
                <button onClick={() => setAddAccount(true)} className="btn-soft shrink-0 py-1 px-2 text-[12px]">
                  <Icon name="plus" size={12} /> Connect an account
                </button>
              </div>
            )
          ) : (
            <>
              {accounts.length > 1 && (
                <select
                  value={accountId || ""}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="field mb-1.5 py-1.5 text-[12.5px]"
                  aria-label="Git account"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} ({a.provider})
                    </option>
                  ))}
                </select>
              )}
              {accountId && (
                <RepoPicker
                  accountId={accountId}
                  onCloned={(path) => connect(path, true)} // the clone's folder joins the chat; then pick its branch
                />
              )}
              <p className="mt-1 text-[11px] text-content-faint">
                Clones into this server's repositories folder and connects it to the chat; pick the branch next.
              </p>
            </>
          )}
        </div>
        {error && <p className="text-[11.5px] text-danger">{error}</p>}
      </div>
    </>
  );
}
