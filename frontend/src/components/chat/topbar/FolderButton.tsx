import { useEffect, useMemo, useRef, useState } from "react";
import { listDir } from "../../../api/workspaces";
import { isCopy } from "../../../lib/localFolder";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useLocalFolders } from "../../../stores/localFolderStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { revealInExplorer, useWorkbench } from "../../../stores/workbenchStore";
import type { Session } from "../../../types";
import Icon from "../../ui/Icon";
import Popover from "../../ui/Popover";
import FolderPicker from "../panel/FolderPicker";
import { loadRecents, pushRecent } from "../../workspaces/FileTree";
import LocalFolderSection from "./LocalFolderSection";

const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const parentOf = (p: string) => {
  const s = strip(p);
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : "/";
};

/**
 * The top bar's Folder button: the chat's additional folders (the agent reads and edits them alongside the
 * workspace) — list, open in the explorer, disconnect — and adding one: a folder on the workspace's host (recent,
 * nearby, typed, or browsed), or one from this computer (LocalFolderSection).
 */
export default function FolderButton({ session, compact }: { session: Session; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"host" | "local">("host");
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const [nearby, setNearby] = useState<{ for: string; dirs: string[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const update = useSessionStore((s) => s.update);
  const sessions = useSessionStore((s) => s.sessions);
  const connections = useConnectionStore((s) => s.connections);
  const job = useLocalFolders((s) => s.jobs[session.id]);
  const notify = useWorkbench((s) => s.notify);

  const conn = connections.find((c) => c.id === session.connection_id);
  const remote = !!session.connection_id;
  const hostName = conn ? conn.name : "the server";
  const hostLabel = conn ? `${conn.name} (${conn.username}@${conn.host})` : "this server";
  const dirs = session.extra_dirs || [];
  const taken = useMemo(() => new Set([strip(session.workspace_path), ...dirs.map(strip)]), [session.workspace_path, dirs]);
  const uploading = job?.phase === "uploading";

  // Nearby: the workspace's sibling folders (e.g. a second repo next to this one) — read when the popover opens.
  const parent = parentOf(session.workspace_path);
  useEffect(() => {
    if (!open || tab !== "host" || nearby?.for === `${session.connection_id}:${parent}`) return;
    let alive = true;
    listDir(parent, session.connection_id)
      .then((r) => alive && setNearby({ for: `${session.connection_id}:${parent}`, dirs: r.entries.filter((e) => e.is_dir).map((e) => e.path) }))
      .catch(() => alive && setNearby({ for: `${session.connection_id}:${parent}`, dirs: [] }));
    return () => {
      alive = false;
    };
  }, [open, tab, parent, session.connection_id, nearby?.for]);

  // Recent: folders picked before on this host + the other chats' workspaces and folders there.
  const recent = useMemo(() => {
    if (!open) return [];
    const out: string[] = [];
    const add = (p: string) => {
      const s = strip(p);
      if (s && !taken.has(s) && !out.includes(s) && !isCopy(s)) out.push(s);
    };
    loadRecents(session.connection_id).forEach(add);
    [...sessions]
      .filter((s) => s.id !== session.id && (s.connection_id || null) === (session.connection_id || null))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .forEach((s) => [s.workspace_path, ...(s.extra_dirs || [])].forEach(add));
    return out.slice(0, 8);
  }, [open, sessions, session.id, session.connection_id, taken]);

  const q = query.trim().toLowerCase();
  const match = (p: string) => !q || p.toLowerCase().includes(q);
  const shownRecent = recent.filter(match);
  const shownNearby = (nearby?.dirs || []).filter((p) => !taken.has(strip(p)) && !recent.includes(strip(p)) && match(p)).slice(0, 12);
  const typed = /^(\/|~)/.test(query.trim()) ? strip(query.trim()) : "";

  const add = async (p: string) => {
    const path = strip(p);
    setError("");
    if (taken.has(path)) return setError("Already connected.");
    setBusy(path);
    try {
      await update(session.id, { extra_dirs: [...dirs, path] });
      pushRecent(session.connection_id, path);
      setQuery("");
    } catch (e: any) {
      setError(String(e.message || e));
      throw e;
    } finally {
      setBusy(null);
    }
  };
  const remove = async (p: string) => {
    setError("");
    try {
      await update(session.id, { extra_dirs: dirs.filter((x) => x !== p) });
    } catch (e: any) {
      setError(String(e.message || e));
    }
  };
  const reveal = (p: string) => {
    setOpen(false);
    useWorkbench.getState().setExplorer(true);
    revealInExplorer(session, strip(p), true).catch(() => {});
  };

  const n = dirs.length;
  const row = (p: string, kind: "recent" | "nearby" | "typed") => (
    <li key={`${kind}:${p}`}>
      <button
        onClick={() => add(p).catch(() => {})}
        disabled={busy !== null}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-3 focus-visible:bg-surface-3 outline-none"
        title={`Connect ${p}`}
      >
        <Icon name={kind === "typed" ? "plus" : "folder"} size={13} className="shrink-0 text-content-faint" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-content">{kind === "typed" ? `Connect ${p}` : base(p)}</span>
          {kind !== "typed" && <span className="block truncate font-mono text-[10.5px] text-content-faint">{p}</span>}
        </span>
        {busy === p ? (
          <Icon name="spinner" size={12} spin className="text-content-faint" />
        ) : (
          <Icon name="plus" size={12} className="shrink-0 text-content-faint opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
        )}
      </button>
    </li>
  );

  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="topbar-folders"
        data-topbar-item="folders"
        title={n ? `${n} additional folder${n === 1 ? "" : "s"} — the agent can use them too` : "Connect more folders to this chat"}
        className={`btn-ghost relative h-10 w-10 shrink-0 p-0 sm:h-auto sm:w-auto sm:px-2 sm:py-1 ${open ? "bg-surface-3 text-content" : ""} ${
          n || uploading ? "" : "text-content-faint"
        }`}
      >
        {uploading ? (
          <Icon name="spinner" size={14} spin className="text-accent" />
        ) : (
          <Icon name={n ? "folder" : "folder-plus"} size={14} className={n ? "text-content-dim" : ""} />
        )}
        {n > 0 ? (
          <span className="pill bg-accent-soft px-1.5 text-accent max-sm:absolute max-sm:right-0.5 max-sm:top-0.5 max-sm:px-1 max-sm:py-0 max-sm:text-[10px]">
            {n}
          </span>
        ) : (
          <span className={compact ? "hidden" : "hidden sm:inline"}>Folder</span>
        )}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} label="Folders" width={400} testId="folders-popover">
        <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2.5">
          <Icon name="folder" size={14} className="text-accent" />
          <span className="text-[13px] font-semibold text-content">Folders</span>
          <span className="truncate text-[11px] text-content-faint">on {hostLabel}</span>
          <button
            onClick={() => setOpen(false)}
            className="ml-auto rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content"
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-3.5 pt-2.5">
            <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-content-faint">Connected {n ? `· ${n}` : ""}</div>
            {n === 0 ? (
              <p className="pb-1 text-[12px] text-content-faint">
                None yet. The agent works in <span className="font-mono text-content-dim">{base(session.workspace_path)}</span>; connect more
                folders it should read and edit too. Applies from the next message.
              </p>
            ) : (
              <ul className="space-y-1" data-testid="folders-connected">
                {dirs.map((d) => {
                  const copy = isCopy(d);
                  return (
                    <li key={d} className="group flex items-center gap-2 rounded-lg bg-surface/70 px-2.5 py-1.5">
                      <Icon name="folder" size={13} className="shrink-0 text-content-faint" />
                      <span className="min-w-0 flex-1" title={d}>
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12.5px] text-content">{base(d)}</span>
                          <span
                            className={`pill shrink-0 px-1.5 py-0 text-[10px] ${remote ? "bg-cyan/10 text-cyan" : "bg-surface-3 text-content-dim"}`}
                            title={remote ? `On ${hostLabel}` : "On the server"}
                          >
                            {remote ? "remote" : "local"}
                          </span>
                          {copy && (
                            <span
                              className="pill shrink-0 bg-warning/15 px-1.5 py-0 text-[10px] text-warning"
                              title="Uploaded copy of a folder from your computer: changes here don't sync back"
                            >
                              copy
                            </span>
                          )}
                        </span>
                        <span className="block truncate font-mono text-[10.5px] text-content-faint">{d}</span>
                      </span>
                      <button
                        onClick={() => reveal(d)}
                        className="shrink-0 rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content"
                        title="Show in Explorer"
                        aria-label={`Show ${base(d)} in Explorer`}
                      >
                        <Icon name="folder-open" size={13} />
                      </button>
                      <button
                        onClick={() => remove(d)}
                        className="shrink-0 rounded p-1 text-content-faint hover:bg-surface-3 hover:text-danger"
                        title={copy ? "Disconnect (the copy stays in the workspace)" : "Disconnect folder"}
                        aria-label={`Disconnect ${base(d)}`}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="mt-2.5 border-t border-border/70 px-3.5 pb-3 pt-2.5">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10.5px] uppercase tracking-wide text-content-faint">Add folder</span>
              <div className="ml-auto flex rounded-lg bg-surface p-0.5 text-[11.5px]" role="tablist" aria-label="Where the folder is">
                {(
                  [
                    ["host", remote ? hostName : "Server", "server"],
                    ["local", "This computer", "monitor"],
                  ] as const
                ).map(([k, label, icon]) => (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={tab === k}
                    onClick={() => setTab(k)}
                    data-testid={`folders-tab-${k}`}
                    className={`flex max-w-[150px] items-center gap-1 rounded-md px-2 py-0.5 transition ${
                      tab === k ? "bg-surface-3 text-content" : "text-content-faint hover:text-content-dim"
                    }`}
                  >
                    <Icon name={icon} size={11} className="shrink-0" />
                    <span className="truncate">{label}</span>
                    {k === "local" && job && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                  </button>
                ))}
              </div>
            </div>

            {tab === "host" ? (
              <>
                <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-2.5 py-1.5 focus-within:border-accent/60">
                  <Icon name="search" size={12} className="shrink-0 text-content-faint" />
                  <input
                    data-autofocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing && typed) add(typed).catch(() => {});
                    }}
                    placeholder="Filter, or type a path (/srv/lib)…"
                    aria-label="Filter folders or type a path"
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] text-content placeholder:text-content-faint outline-none"
                  />
                </div>
                <ul className="mt-1.5 max-h-[38vh] space-y-px overflow-y-auto sm:max-h-64" data-testid="folders-suggestions">
                  {typed && !taken.has(typed) && row(typed, "typed")}
                  {shownRecent.length > 0 && (
                    <li className="px-2 pb-0.5 pt-1.5 text-[10.5px] text-content-faint" aria-hidden>
                      Recent
                    </li>
                  )}
                  {shownRecent.map((p) => row(p, "recent"))}
                  {shownNearby.length > 0 && (
                    <li className="px-2 pb-0.5 pt-1.5 text-[10.5px] text-content-faint" aria-hidden>
                      Next to the workspace
                    </li>
                  )}
                  {shownNearby.map((p) => row(p, "nearby"))}
                  {!typed && shownRecent.length === 0 && shownNearby.length === 0 && (
                    <li className="px-2 py-2 text-[12px] text-content-faint">
                      {nearby || !open ? (q ? "No folder matches." : "No suggestions.") : "Looking around…"}
                    </li>
                  )}
                </ul>
                <button
                  onClick={() => {
                    setOpen(false);
                    setPicker(true);
                  }}
                  className="btn-ghost mt-1.5 w-full justify-center py-1.5 text-[12.5px]"
                  data-testid="folders-browse"
                >
                  <Icon name="folder-open" size={13} /> Browse {hostName}…
                </button>
              </>
            ) : (
              <LocalFolderSection
                session={session}
                onLinked={(p) => notify(`Linked ${p} — the server runs on this computer, so no copy was needed`)}
              />
            )}
            {error && <p className="mt-1.5 text-[11.5px] text-danger">{error}</p>}
          </div>
        </div>
      </Popover>

      {picker && (
        <FolderPicker
          connectionId={session.connection_id}
          hostLabel={hostLabel}
          initialPath={session.workspace_path}
          exclude={[...taken]}
          onAdd={(p) => add(p)}
          onClose={() => setPicker(false)}
        />
      )}
    </>
  );
}
