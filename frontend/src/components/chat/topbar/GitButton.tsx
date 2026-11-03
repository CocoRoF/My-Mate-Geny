import { useEffect, useMemo, useRef, useState } from "react";
import {
  cloneSessionRepo,
  connectSessionGit,
  detectSessionRepos,
  disconnectSessionGit,
  sessionGitBranches,
  sessionGitCheckout,
  type FoundRepo,
  type GitBranches,
  type GitStatus,
} from "../../../api/sessionGit";
import type { GitRepo } from "../../../api/git";
import { folderKey, hostName, LOCAL, qualify, sessionFolders, thisHostIds, useHosts } from "../../../lib/hosts";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useGitStore } from "../../../stores/gitStore";
import type { Connection } from "../../../types";
import { useSessionGit } from "../../../stores/sessionGitStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { openPath, useWorkbench } from "../../../stores/workbenchStore";
import type { Session } from "../../../types";
import { absTime, relTime } from "../../admin/format";
import GitAccounts from "../../connections/GitAccounts";
import Icon from "../../ui/Icon";
import Popover from "../../ui/Popover";
import RepoPicker from "../../workspaces/RepoPicker";
import { useT, type MsgKey } from "../../../i18n";

const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
// git's letter → [shown as, colour, name] (untracked shows as U like editors do, so a conflict shows as !)
const STATUS: Record<string, [string, string, MsgKey]> = {
  M: ["M", "text-warning", "topbar.stModified"],
  A: ["A", "text-success", "topbar.stAdded"],
  "?": ["U", "text-success", "topbar.stUntracked"],
  D: ["D", "text-danger", "topbar.stDeleted"],
  U: ["!", "text-danger", "topbar.stConflict"],
  R: ["R", "text-cyan", "topbar.stRenamed"],
  C: ["C", "text-cyan", "topbar.stCopied"],
  T: ["T", "text-warning", "topbar.stTypeChanged"],
};

/** ↑ahead ↓behind, only what's non-zero. */
function AheadBehind({ s, className = "" }: { s: GitStatus; className?: string }) {
  const t = useT();
  if (!s.ahead && !s.behind) return null;
  return (
    <span className={`tabular-nums ${className}`} title={t("topbar.aheadBehindTitle", { ahead: s.ahead || 0, behind: s.behind || 0, upstream: s.upstream || "" })}>
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
  const t = useT();
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
  const key = `${sid}|${session.git_repo ?? "auto"}|${session.git_repo_host ?? ""}|${sessionFolders(session).map(folderKey).join(":")}`;
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
    ? [
        st!.repo,
        st!.branch,
        changes ? t("topbar.tChanged", { n: changes }) : t("topbar.tClean"),
        st!.ahead ? t("topbar.tToPush", { n: st!.ahead }) : "",
        st!.behind ? t("topbar.tToPull", { n: st!.behind }) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : st?.mode === "off"
      ? t("topbar.gitOffTitle")
      : t("topbar.gitConnectTitle");

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
              patchLocal(sid, { git_repo: s.root ?? null, git_repo_host: s.connection_id ?? null });
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </Popover>
    </>
  );
}

function Header({ title, sub, onClose, children }: { title: React.ReactNode; sub?: React.ReactNode; onClose: () => void; children?: React.ReactNode }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2.5">
      <Icon name="git-branch" size={14} className="shrink-0 text-violet" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-content">{title}</div>
        {sub && <div className="truncate font-mono text-[10.5px] text-content-faint">{sub}</div>}
      </div>
      {children}
      <button onClick={onClose} className="shrink-0 rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content" aria-label={t("common.close")}>
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
  const t = useT();
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
  const repoHost = st.connection_id === undefined ? session.connection_id : st.connection_id;
  const connections = useConnectionStore((s) => s.connections);
  const summary = c
    ? [
        c.modified && t("topbar.sumModified", { n: c.modified }),
        c.staged && t("topbar.sumStaged", { n: c.staged }),
        c.untracked && t("topbar.sumUntracked", { n: c.untracked }),
        c.conflicted && t("topbar.sumConflicted", { n: c.conflicted }),
      ].filter(Boolean)
    : [];

  return (
    <>
      <Header title={st.repo || base(root)} sub={st.remote || t("topbar.noRemote")} onClose={onClose}>
        <button
          onClick={onRefresh}
          className="shrink-0 rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content"
          title={t("common.refresh")}
          aria-label={t("topbar.refreshGit")}
          data-testid="git-refresh"
        >
          <Icon name="refresh" size={13} spin={loading} />
        </button>
      </Header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {/* branch */}
        <div>
          <label htmlFor="git-branch-select" className="mb-1 block text-[10.5px] uppercase tracking-wide text-content-faint">
            {t("topbar.branch")}
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
                title={running ? t("topbar.agentBusyTitle") : t("topbar.switchBranch")}
              >
                {st.detached && <option value="">{t("topbar.detachedAt", { ref: st.branch })}</option>}
                {!branches && !st.detached && <option value={st.branch}>{st.branch}</option>}
                {branches && (
                  <>
                    <optgroup label={t("topbar.optLocal")}>
                      {branches.local.map((b) => (
                        <option key={b.name} value={b.name}>
                          {b.name}
                        </option>
                      ))}
                    </optgroup>
                    {branches.remote.length > 0 && (
                      <optgroup label={t("topbar.optRemote")}>
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
                {st.ahead || st.behind ? <AheadBehind s={st} /> : t("topbar.upToDate")}
                <span className="text-content-faint"> · {st.upstream}</span>
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-content-faint">{t("topbar.noUpstream")}</span>
            )}
          </div>
          {running && <p className="mt-1 text-[11px] text-content-faint">{t("topbar.agentBusy")}</p>}
        </div>

        {/* changes */}
        <div>
          <div className="mb-1 flex items-center gap-2 text-[10.5px] uppercase tracking-wide text-content-faint">
            {t("topbar.changes")}
            {changes > 0 && <span className="normal-case tracking-normal text-content-dim">{summary.join(" · ")}</span>}
          </div>
          {changes === 0 ? (
            <p className="flex items-center gap-1.5 text-[12px] text-success">
              <Icon name="check" size={13} /> {t("topbar.clean")}
            </p>
          ) : (
            <ul className="space-y-px" data-testid="git-files">
              {files.slice(0, 8).map((f) => (
                <li key={f.path}>
                  <button
                    onClick={() => {
                      onClose();
                      openPath(session, qualify(session, repoHost, `${root}/${f.path}`)).catch(() => {});
                    }}
                    className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-3"
                    title={t("topbar.openX", { path: f.path })}
                  >
                    <span
                      className={`w-3.5 shrink-0 text-center font-mono text-[11px] ${STATUS[f.status]?.[1] || "text-content-dim"}`}
                      title={STATUS[f.status] ? t(STATUS[f.status][2]) : f.status}
                    >
                      {STATUS[f.status]?.[0] || f.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-content-dim">{f.path}</span>
                    {f.staged && <span className="shrink-0 text-[10px] text-content-faint">{t("topbar.staged")}</span>}
                  </button>
                </li>
              ))}
              {changes > 8 && <li className="pt-0.5 text-[11px] text-content-faint">{t("topbar.moreN", { n: changes - 8 })}</li>}
            </ul>
          )}
        </div>

        {/* last commit */}
        {st.last_commit ? (
          <div>
            <div className="mb-1 text-[10.5px] uppercase tracking-wide text-content-faint">{t("topbar.lastCommit")}</div>
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
          st.initial && <p className="text-[12px] text-content-faint">{t("topbar.noCommits")}</p>
        )}
        {error && <p className="text-[11.5px] text-danger" data-testid="git-error">{error}</p>}
      </div>
      <div className="flex items-center gap-2 border-t border-border/70 px-3.5 py-2">
        {(repoHost || session.connection_id) && <HostBadge conn={repoHost} connections={connections} />}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-content-faint" title={root}>
          {st.mode === "auto" ? `${t("topbar.workspace")} · ` : ""}
          {root}
        </span>
        <button
          onClick={disconnect}
          className="btn-ghost shrink-0 py-1 px-2 text-[12px] hover:text-danger"
          title={t("topbar.disconnectTitle")}
          data-testid="git-disconnect"
        >
          {t("topbar.disconnect")}
        </button>
      </div>
    </>
  );
}

/** Which host a repo is on: this server or an SSH connection (cyan). */
function HostBadge({ conn, connections }: { conn: string | null | undefined; connections: Connection[] }) {
  const t = useT();
  return (
    <span
      className={`pill max-w-[8rem] shrink-0 truncate px-1.5 py-0 text-[10px] ${conn ? "bg-cyan/10 text-cyan" : "bg-surface-3 text-content-dim"}`}
      title={conn ? t("topbar.onHostTitle", { host: hostName(conn, connections, t("topbar.thisServer")) }) : t("topbar.onServer")}
      data-testid="git-host-badge"
    >
      {hostName(conn, connections, t("topbar.thisServer"))}
    </span>
  );
}

function gitError(t: ReturnType<typeof useT>, e: any): string {
  const detail = String(e?.message || e);
  const head = e?.status === 502 ? t("topbar.errUnreachable") : e?.status === 403 ? t("topbar.errPermission") : "";
  return head && !detail.startsWith("can't reach") ? `${head} — ${detail}` : detail;
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
  const t = useT();
  const sid = session.id;
  const connections = useConnectionStore((s) => s.connections);
  const [found, setFound] = useState<FoundRepo[] | null>(null);
  const [hostErrors, setHostErrors] = useState<{ connection_id: string | null; error: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const multiHost = new Set([session.connection_id || null, ...sessionFolders(session).map((f) => f.connection_id || null)]).size > 1;

  useEffect(() => {
    let alive = true;
    detectSessionRepos(sid)
      .then((r) => {
        if (!alive) return;
        setFound(r.repos);
        setHostErrors(r.errors || []);
      })
      .catch((e) => {
        if (!alive) return;
        setFound([]);
        setError(gitError(t, e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  const connect = async (r: FoundRepo) => {
    setBusy(r.path);
    setError("");
    try {
      onConnected(await connectSessionGit(sid, r.path, false, r.connection_id === undefined ? undefined : r.connection_id));
    } catch (e: any) {
      setError(gitError(t, e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Header title={t("topbar.connectRepo")} onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        <p className="text-[11.5px] leading-snug text-content-dim">
          {st?.mode === "off"
            ? t("topbar.offHint")
            : st?.error
              ? t("topbar.cantReadGit", { error: st.error })
              : t("topbar.notARepo")}
        </p>

        <div>
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-content-faint">{t("topbar.inFolders")}</div>
          {found === null || loading ? (
            <p className="flex items-center gap-1.5 py-1 text-[12px] text-content-faint">
              <Icon name="spinner" size={13} spin /> {t("topbar.lookingRepos")}
            </p>
          ) : found.length === 0 ? (
            <p className="py-1 text-[12px] text-content-faint">{t("topbar.noRepos")}</p>
          ) : (
            <ul className="space-y-1" data-testid="git-found">
              {found.map((r) => (
                <li key={`${r.connection_id ?? "ws"}:${r.path}`} className="flex items-center gap-2 rounded-lg bg-surface/70 px-2.5 py-1.5">
                  <Icon name={r.remote.includes("github") ? "github" : "git-branch"} size={13} className="shrink-0 text-violet" />
                  <span className="min-w-0 flex-1" title={r.path}>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] text-content">{r.repo}</span>
                      {r.branch && <span className="shrink-0 font-mono text-[10.5px] text-content-dim">{r.branch}</span>}
                      {(multiHost || r.connection_id) && r.connection_id !== undefined && <HostBadge conn={r.connection_id} connections={connections} />}
                    </span>
                    <span className="block truncate font-mono text-[10.5px] text-content-faint">{r.path}</span>
                  </span>
                  <button
                    onClick={() => connect(r)}
                    disabled={busy !== null}
                    className="pill shrink-0 bg-accent-soft text-accent hover:bg-accent/20"
                    aria-label={t("topbar.connectX", { name: r.repo })}
                  >
                    {busy === r.path ? <Icon name="spinner" size={11} spin /> : t("common.connect")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hostErrors.map((h) => (
            <p key={h.connection_id ?? LOCAL} className="mt-1 text-[11.5px] text-danger" data-testid="git-host-error">
              {t("topbar.cantListHost", { host: hostName(h.connection_id, connections, t("topbar.thisServer")) })}
              <span className="block truncate font-mono text-[10.5px] text-content-faint" title={h.error}>
                {h.error}
              </span>
            </p>
          ))}
        </div>

        <CloneSection session={session} onConnected={onConnected} />
        {error && <p className="text-[11.5px] text-danger">{error}</p>}
      </div>
    </>
  );
}

/**
 * Clone a repository onto a host — this server or any SSH connection (the workspace's preselected) — with a Git
 * account's token (picked from its repos) or anonymously by URL (a public repo), then connect it to the chat. On an
 * SSH host the token is handed to that one git run and is not stored there (backend services/session_git.py).
 */
function CloneSection({ session, onConnected }: { session: Session; onConnected: (s: GitStatus) => void }) {
  const t = useT();
  const sid = session.id;
  const accounts = useGitStore((s) => s.accounts);
  const loadAccounts = useGitStore((s) => s.load);
  const connections = useConnectionStore((s) => s.connections);
  const hosts = useHosts((s) => s.hosts);
  const loadHosts = useHosts((s) => s.load);
  const same = useMemo(() => thisHostIds(hosts), [hosts]);
  const wsHost = session.connection_id && !same.has(session.connection_id) ? session.connection_id : LOCAL;
  const [host, setHost] = useState<string>(wsHost);
  const [source, setSource] = useState<string | null>(null); // an account id, or "url"
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [addAccount, setAddAccount] = useState(false);
  const conn = host === LOCAL ? null : host;

  useEffect(() => {
    loadAccounts().catch(() => {});
    loadHosts().catch(() => {});
  }, [loadAccounts, loadHosts]);
  useEffect(() => setHost(wsHost), [wsHost]);
  useEffect(() => {
    if (!source) setSource(accounts.length ? accounts[0].id : "url");
  }, [accounts, source]);

  const clone = async (body: { clone_url: string; full_name?: string; account_id?: string | null }) => {
    setBusy(true);
    setError("");
    try {
      onConnected(await cloneSessionRepo(sid, { ...body, connection_id: conn, ...(parent.trim() ? { parent: parent.trim() } : {}) }));
    } catch (e: any) {
      setError(gitError(t, e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const hostChoices = [
    { key: LOCAL, label: t("topbar.thisServer") },
    ...connections.filter((c) => !same.has(c.id)).map((c) => ({ key: c.id, label: c.name })),
  ];

  return (
    <div className="border-t border-border/70 pt-2.5" data-testid="git-clone">
      <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-content-faint">{t("topbar.cloneRepo")}</div>
      <div className="mb-1.5 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-[12px]">
        <label htmlFor="git-clone-host" className="text-content-faint">
          {t("topbar.cloneWhere")}
        </label>
        <select
          id="git-clone-host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          className="field py-1 text-[12.5px]"
          data-testid="git-clone-host"
        >
          {hostChoices.map((h) => (
            <option key={h.key} value={h.key}>
              {h.label}
              {h.key === wsHost ? ` · ${t("topbar.workspaceHost")}` : ""}
            </option>
          ))}
        </select>
        <label htmlFor="git-clone-source" className="text-content-faint">
          {t("topbar.cloneFrom")}
        </label>
        <select
          id="git-clone-source"
          value={source || "url"}
          onChange={(e) => setSource(e.target.value)}
          className="field py-1 text-[12.5px]"
          data-testid="git-clone-source"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} ({a.provider})
            </option>
          ))}
          <option value="url">{t("topbar.cloneByUrl")}</option>
        </select>
        {(conn || source === "url") && (
          <>
            <label htmlFor="git-clone-parent" className="text-content-faint">
              {t("topbar.cloneInto")}
            </label>
            <input
              id="git-clone-parent"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              placeholder={conn ? "~/repos" : t("topbar.cloneIntoDefault")}
              className="field py-1 font-mono text-[12px]"
              data-testid="git-clone-parent"
            />
          </>
        )}
      </div>

      {source === "url" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) clone({ clone_url: url.trim(), account_id: null }).catch(() => {});
          }}
          className="flex items-center gap-1.5"
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
            aria-label={t("topbar.cloneUrlAria")}
            className="field min-w-0 flex-1 py-1.5 font-mono text-[12px]"
            data-testid="git-clone-url"
          />
          <button type="submit" disabled={busy || !url.trim()} className="btn-primary shrink-0 py-1.5 px-2.5 text-[12px]" data-testid="git-clone-go">
            {busy ? <Icon name="spinner" size={12} spin /> : <Icon name="download" size={12} />} {t("topbar.clone")}
          </button>
        </form>
      ) : source && accounts.some((a) => a.id === source) ? (
        <RepoPicker
          accountId={source}
          onUse={(r: GitRepo) => clone({ clone_url: r.clone_url, full_name: r.full_name, account_id: source })}
        />
      ) : null}
      {accounts.length === 0 &&
        (addAccount ? (
          <div className="mt-2 text-[12px] [&_.card]:p-3">
            <GitAccounts />
            <button onClick={() => setAddAccount(false)} className="btn-ghost mt-2 py-1 px-2 text-[12px]">
              {t("common.done")}
            </button>
          </div>
        ) : (
          <div className="mt-1.5 flex items-center gap-2">
            <p className="flex-1 text-[11.5px] text-content-faint">{t("topbar.noGitAccountUrl")}</p>
            <button onClick={() => setAddAccount(true)} className="btn-soft shrink-0 py-1 px-2 text-[12px]">
              <Icon name="plus" size={12} /> {t("topbar.connectAccount")}
            </button>
          </div>
        ))}
      <p className="mt-1 text-[11px] leading-snug text-content-faint">
        {conn ? t("topbar.cloneNoteRemote", { host: hostName(conn, connections, "") }) : source === "url" ? t("topbar.cloneNoteUrl") : t("topbar.cloneNote")}
      </p>
      {busy && (
        <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-content-dim" data-testid="git-cloning">
          <Icon name="spinner" size={12} spin /> {t("topbar.cloningOn", { host: hostName(conn, connections, t("topbar.thisServer")) })}
        </p>
      )}
      {error && (
        <p className="mt-1 break-words text-[11.5px] text-danger" data-testid="git-clone-error">
          {error}
        </p>
      )}
    </div>
  );
}
