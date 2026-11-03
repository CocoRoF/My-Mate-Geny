import { useEffect, useMemo, useRef, useState } from "react";
import { listDir } from "../../../api/workspaces";
import { folderKey, hostKey, LOCAL, qualify, sessionFolders, strip, thisHostIds, useHosts } from "../../../lib/hosts";
import { isCopy } from "../../../lib/localFolder";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useLocalFolders } from "../../../stores/localFolderStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { revealInExplorer, useWorkbench } from "../../../stores/workbenchStore";
import type { Folder, Session } from "../../../types";
import Icon from "../../ui/Icon";
import { useT } from "../../../i18n";
import Popover from "../../ui/Popover";
import FolderPicker from "../panel/FolderPicker";
import { loadRecents, pushRecent } from "../../workspaces/FileTree";
import LocalFolderSection from "./LocalFolderSection";

const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
const parentOf = (p: string) => {
  const s = strip(p);
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : "/";
};

/** Where folders can be added from: this server, each SSH connection (one that is this very machine is folded into
 *  "this server"), and this computer (upload / link). */
type Chip = { key: string; conn: string | null; label: string; sub?: string };

/** A friendly line for an attach error (the server's detail says which folder / host). */
function useFolderError() {
  const t = useT();
  return (e: any): string => {
    const detail = String(e?.message || e);
    const head =
      e?.status === 404
        ? t("topbar.errNotFound")
        : e?.status === 403
          ? t("topbar.errPermission")
          : e?.status === 502
            ? t("topbar.errUnreachable")
            : "";
    return head ? `${head} — ${detail}` : detail;
  };
}

/**
 * The top bar's Folder button: the chat's additional folders — on this server or on any SSH host, whatever the
 * workspace is — listed with their host, opened in the explorer, disconnected; and adding them: pick a host, then
 * folders there (recent, nearby, typed, or browsed). Click one to connect it now, or tick several (on several hosts)
 * and connect them together. "This computer" links or uploads one from the user's machine (LocalFolderSection).
 */
export default function FolderButton({ session, compact }: { session: Session; compact?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string | null>(null); // a chip key, "computer", or null = the workspace's host
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const [listing, setListing] = useState<{ for: string; dirs: string[]; error?: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Folder[]>([]); // ticked, not connected yet
  const btn = useRef<HTMLButtonElement>(null);
  const update = useSessionStore((s) => s.update);
  const sessions = useSessionStore((s) => s.sessions);
  const connections = useConnectionStore((s) => s.connections);
  const hosts = useHosts((s) => s.hosts);
  const loadHosts = useHosts((s) => s.load);
  const job = useLocalFolders((s) => s.jobs[session.id]);
  const notify = useWorkbench((s) => s.notify);
  const friendly = useFolderError();

  useEffect(() => {
    if (open) loadHosts().catch(() => {});
  }, [open, loadHosts]);

  const same = useMemo(() => thisHostIds(hosts), [hosts]);
  // a connection that is this machine counts as this server (no duplicates, no SSH hop)
  const canon = (conn: string | null | undefined) => (conn && !same.has(conn) ? conn : LOCAL);
  const ckey = (conn: string | null | undefined, path: string) => `${canon(conn)}::${strip(path)}`;
  const nameOf = (conn: string | null | undefined) =>
    canon(conn) === LOCAL ? t("topbar.thisServer") : connections.find((c) => c.id === conn)?.name || String(conn);

  const folders = sessionFolders(session);
  const wsChip = canon(session.connection_id);
  const chips: Chip[] = useMemo(
    () => [
      { key: LOCAL, conn: null, label: t("topbar.thisServer") },
      ...connections
        .filter((c) => !same.has(c.id))
        .map((c) => ({ key: c.id, conn: c.id, label: c.name, sub: `${c.username}@${c.host}` })),
    ],
    [connections, same, t],
  );
  const cur = tab === "computer" ? null : chips.find((c) => c.key === (tab ?? wsChip)) || chips[0];
  const curConn = cur?.conn ?? null;
  const onWsHost = !!cur && cur.key === wsChip;
  const taken = useMemo(
    () => new Set([ckey(session.connection_id, session.workspace_path), ...folders.map((f) => ckey(f.connection_id, f.path))]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.workspace_path, session.connection_id, folders, same],
  );
  const pickedKeys = new Set(picked.map((f) => ckey(f.connection_id, f.path)));
  const uploading = job?.phase === "uploading";

  // Nearby: next to the workspace (its host), or the connection's home folder (another host) — read on open.
  const listAt = cur ? (onWsHost ? parentOf(session.workspace_path) : connections.find((c) => c.id === curConn)?.default_path || "~") : "";
  const listingFor = `${hostKey(curConn)}:${listAt}`;
  const listConn = onWsHost && session.connection_id && same.has(session.connection_id) ? null : curConn;
  useEffect(() => {
    if (!open || !cur || listing?.for === listingFor) return;
    let alive = true;
    listDir(listAt, listConn)
      .then((r) => alive && setListing({ for: listingFor, dirs: r.entries.filter((e) => e.is_dir).map((e) => e.path) }))
      .catch((e) => alive && setListing({ for: listingFor, dirs: [], error: String(e?.message || e) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listingFor]);
  const nearby = listing?.for === listingFor ? listing : null;

  // Recent: picked before on this host + the other chats' workspaces and folders there.
  const recent = useMemo(() => {
    if (!open || !cur) return [];
    const out: string[] = [];
    const add = (p: string) => {
      const s = strip(p);
      if (s && !taken.has(ckey(curConn, s)) && !out.includes(s) && !isCopy(s)) out.push(s);
    };
    loadRecents(curConn).forEach(add);
    [...sessions]
      .filter((s) => s.id !== session.id)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .forEach((s) => {
        if (canon(s.connection_id) === cur.key) add(s.workspace_path);
        sessionFolders(s).forEach((f) => canon(f.connection_id) === cur.key && add(f.path));
      });
    return out.slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessions, session.id, cur?.key, taken, same]);

  const q = query.trim().toLowerCase();
  const match = (p: string) => !q || p.toLowerCase().includes(q);
  const shownRecent = recent.filter(match);
  const shownNearby = (nearby?.dirs || [])
    .filter((p) => !taken.has(ckey(curConn, p)) && !recent.includes(strip(p)) && match(p))
    .slice(0, 12);
  const typed = /^(\/|~)/.test(query.trim()) ? strip(query.trim()) : "";

  const save = async (next: Folder[], label: string) => {
    setError("");
    setBusy(label);
    try {
      await update(session.id, { folders: next });
      return true;
    } catch (e: any) {
      setError(friendly(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const add = async (conn: string | null, p: string) => {
    const path = strip(p);
    if (taken.has(ckey(conn, path))) return setError(t("topbar.alreadyConnected"));
    if (await save([...folders, { path, connection_id: conn }], path)) {
      pushRecent(conn, path);
      setQuery("");
    } else throw new Error("not connected"); // i18n-ignore (internal: the picker stays open; the error shows below)
  };
  const toggle = (conn: string | null, p: string) => {
    const k = ckey(conn, p);
    setError("");
    setPicked((cur) => (cur.some((f) => ckey(f.connection_id, f.path) === k) ? cur.filter((f) => ckey(f.connection_id, f.path) !== k) : [...cur, { path: strip(p), connection_id: conn }]));
  };
  const connectPicked = async () => {
    const fresh = picked.filter((f) => !taken.has(ckey(f.connection_id, f.path)));
    if (!fresh.length) return setPicked([]);
    if (await save([...folders, ...fresh], "picked")) {
      fresh.forEach((f) => pushRecent(f.connection_id, f.path));
      setPicked([]);
      setQuery("");
    }
  };
  const remove = (f: Folder) => save(folders.filter((x) => folderKey(x) !== folderKey(f)), `rm:${folderKey(f)}`);
  const reveal = (f: Folder) => {
    setOpen(false);
    useWorkbench.getState().setExplorer(true);
    revealInExplorer(session, qualify(session, f.connection_id, strip(f.path)), true).catch(() => {});
  };

  const n = folders.length;
  const selecting = picked.length > 0;
  const row = (p: string, kind: "recent" | "nearby" | "typed") => {
    const ticked = pickedKeys.has(ckey(curConn, p));
    return (
      <li key={`${kind}:${p}`} className="group flex items-center rounded-md hover:bg-surface-3 focus-within:bg-surface-3">
        <button
          onClick={() => toggle(curConn, p)}
          className={`grid h-8 w-7 shrink-0 place-items-center rounded-md outline-none ${ticked ? "text-accent" : "text-content-faint"}`}
          role="checkbox"
          aria-checked={ticked}
          aria-label={t("topbar.selectX", { name: p })}
          title={t("topbar.selectX", { name: p })}
          data-testid="folders-tick"
        >
          <span className={`grid h-3.5 w-3.5 place-items-center rounded border ${ticked ? "border-accent bg-accent text-surface" : "border-border-strong"}`}>
            {ticked && <Icon name="check" size={10} />}
          </span>
        </button>
        <button
          onClick={() => (selecting ? toggle(curConn, p) : add(curConn, p).catch(() => {}))}
          disabled={busy !== null}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left outline-none"
          title={t("topbar.connectX", { name: p })}
        >
          <Icon name={kind === "typed" ? "plus" : "folder"} size={13} className="shrink-0 text-content-faint" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] text-content">{kind === "typed" ? t("topbar.connectX", { name: p }) : base(p)}</span>
            {kind !== "typed" && <span className="block truncate font-mono text-[10.5px] text-content-faint">{p}</span>}
          </span>
          {busy === p ? (
            <Icon name="spinner" size={12} spin className="text-content-faint" />
          ) : (
            !selecting && <Icon name="plus" size={12} className="shrink-0 text-content-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />
          )}
        </button>
      </li>
    );
  };

  const badge = (conn: string | null) => {
    const here = canon(conn) === LOCAL;
    return (
      <span
        className={`pill max-w-[9rem] shrink-0 truncate px-1.5 py-0 text-[10px] ${here ? "bg-surface-3 text-content-dim" : "bg-cyan/10 text-cyan"}`}
        title={here ? t("topbar.onServer") : t("topbar.onHostTitle", { host: nameOf(conn) })}
        data-testid="folder-host-badge"
      >
        {here ? t("topbar.thisServer") : nameOf(conn)}
      </span>
    );
  };

  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="topbar-folders"
        data-topbar-item="folders"
        title={n ? t("topbar.foldersTitle", { count: n }) : t("topbar.foldersTitleNone")}
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
          <span className={compact ? "hidden" : "hidden sm:inline"}>{t("topbar.folder")}</span>
        )}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} label={t("topbar.folders")} width={420} testId="folders-popover">
        <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2.5">
          <Icon name="folder" size={14} className="text-accent" />
          <span className="text-[13px] font-semibold text-content">{t("topbar.folders")}</span>
          <span className="truncate text-[11px] text-content-faint">
            {t("topbar.workspaceOn", { host: nameOf(session.connection_id) })}
          </span>
          <button
            onClick={() => setOpen(false)}
            className="ml-auto rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content"
            aria-label={t("common.close")}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-3.5 pt-2.5">
            <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-content-faint">
              {t("common.connected")} {n ? `· ${n}` : ""}
            </div>
            {n === 0 ? (
              <p className="pb-1 text-[12px] text-content-faint">
                {t.rich("topbar.noneYet", { ws: <span className="font-mono text-content-dim">{base(session.workspace_path)}</span> })}
              </p>
            ) : (
              <ul className="space-y-1" data-testid="folders-connected">
                {folders.map((f) => {
                  const copy = isCopy(f.path);
                  return (
                    <li key={folderKey(f)} className="group flex items-center gap-2 rounded-lg bg-surface/70 px-2.5 py-1.5" data-host={hostKey(f.connection_id)}>
                      <Icon name={canon(f.connection_id) === LOCAL ? "folder" : "server"} size={13} className="shrink-0 text-content-faint" />
                      <span className="min-w-0 flex-1" title={`${nameOf(f.connection_id)} · ${f.path}`}>
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12.5px] text-content">{base(f.path)}</span>
                          {badge(f.connection_id)}
                          {copy && (
                            <span className="pill shrink-0 bg-warning/15 px-1.5 py-0 text-[10px] text-warning" title={t("topbar.copyTitle")}>
                              {t("topbar.copy")}
                            </span>
                          )}
                        </span>
                        <span className="block truncate font-mono text-[10.5px] text-content-faint">{f.path}</span>
                      </span>
                      <button
                        onClick={() => reveal(f)}
                        className="shrink-0 rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content"
                        title={t("topbar.showInExplorer")}
                        aria-label={t("topbar.showXInExplorer", { name: base(f.path) })}
                      >
                        <Icon name="folder-open" size={13} />
                      </button>
                      <button
                        onClick={() => remove(f)}
                        disabled={busy !== null}
                        className="shrink-0 rounded p-1 text-content-faint hover:bg-surface-3 hover:text-danger"
                        title={copy ? t("topbar.disconnectCopy") : t("topbar.disconnectFolder")}
                        aria-label={t("topbar.disconnectX", { name: base(f.path) })}
                      >
                        {busy === `rm:${folderKey(f)}` ? <Icon name="spinner" size={13} spin /> : <Icon name="x" size={13} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="mt-2.5 border-t border-border/70 px-3.5 pb-3 pt-2.5">
            <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-content-faint">{t("topbar.addFolder")}</div>
            {/* where: this server, each SSH host, this computer */}
            <div
              className="-mx-1 mb-2 flex gap-1 overflow-x-auto px-1 pb-0.5 text-[11.5px] [scrollbar-width:none]"
              role="tablist"
              aria-label={t("topbar.whereFolder")}
              data-testid="folders-hosts"
            >
              {chips.map((c) => {
                const on = tab !== "computer" && cur?.key === c.key;
                return (
                  <button
                    key={c.key}
                    role="tab"
                    aria-selected={on}
                    onClick={() => setTab(c.key)}
                    data-testid={c.key === wsChip ? "folders-tab-host" : `folders-host-${c.key}`}
                    data-host={c.key}
                    title={c.sub ? `${c.label} · ${c.sub}` : t("topbar.onServer")}
                    className={`flex max-w-[11rem] shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 transition ${
                      on ? "border-accent/50 bg-accent-soft text-accent" : "border-border text-content-dim hover:border-border-strong hover:text-content"
                    }`}
                  >
                    <Icon name={c.conn ? "server" : "cpu"} size={11} className="shrink-0" />
                    <span className="truncate">{c.label}</span>
                    {c.key === wsChip && (
                      <span className="shrink-0 text-[9.5px] uppercase tracking-wide opacity-70" title={t("topbar.workspaceHost")}>
                        {t("topbar.wsShort")}
                      </span>
                    )}
                    {picked.some((f) => canon(f.connection_id) === c.key) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                  </button>
                );
              })}
              <button
                role="tab"
                aria-selected={tab === "computer"}
                onClick={() => setTab("computer")}
                data-testid="folders-tab-local"
                className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 transition ${
                  tab === "computer" ? "border-accent/50 bg-accent-soft text-accent" : "border-border text-content-dim hover:border-border-strong hover:text-content"
                }`}
              >
                <Icon name="monitor" size={11} className="shrink-0" />
                <span className="truncate">{t("topbar.thisComputer")}</span>
                {job && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
              </button>
            </div>

            {cur ? (
              <>
                <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-2.5 py-1.5 focus-within:border-accent/60">
                  <Icon name="search" size={12} className="shrink-0 text-content-faint" />
                  <input
                    data-autofocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing && typed)
                        selecting ? toggle(curConn, typed) : add(curConn, typed).catch(() => {});
                    }}
                    placeholder={t("topbar.filterOnHost", { host: cur.label })}
                    aria-label={t("topbar.filterAria")}
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] text-content placeholder:text-content-faint outline-none"
                  />
                </div>
                <ul className="mt-1.5 max-h-[34vh] space-y-px overflow-y-auto sm:max-h-60" data-testid="folders-suggestions">
                  {typed && !taken.has(ckey(curConn, typed)) && row(typed, "typed")}
                  {shownRecent.length > 0 && (
                    <li className="px-2 pb-0.5 pt-1.5 text-[10.5px] text-content-faint" aria-hidden>
                      {t("topbar.recent")}
                    </li>
                  )}
                  {shownRecent.map((p) => row(p, "recent"))}
                  {shownNearby.length > 0 && (
                    <li className="px-2 pb-0.5 pt-1.5 text-[10.5px] text-content-faint" aria-hidden>
                      {onWsHost ? t("topbar.nextToWorkspace") : t("topbar.inFolder", { path: listAt })}
                    </li>
                  )}
                  {shownNearby.map((p) => row(p, "nearby"))}
                  {nearby?.error && (
                    <li className="px-2 py-1.5 text-[11.5px] text-danger" data-testid="folders-host-error">
                      {t("topbar.cantListHost", { host: cur.label })}
                      <span className="block truncate font-mono text-[10.5px] text-content-faint" title={nearby.error}>
                        {nearby.error}
                      </span>
                    </li>
                  )}
                  {!typed && shownRecent.length === 0 && shownNearby.length === 0 && !nearby?.error && (
                    <li className="px-2 py-2 text-[12px] text-content-faint">
                      {nearby ? (q ? t("topbar.noFolderMatches") : t("topbar.noSuggestions")) : t("topbar.lookingAround")}
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
                  <Icon name="folder-open" size={13} /> {t("topbar.browseHost", { host: cur.label })}
                </button>
              </>
            ) : (
              <LocalFolderSection session={session} onLinked={(p) => notify(t("topbar.linkedNotice", { path: p }))} />
            )}

            {picked.length > 0 && (
              <div className="mt-2 rounded-lg border border-accent/30 bg-accent-soft/40 p-2" data-testid="folders-picked">
                <div className="flex flex-wrap gap-1">
                  {picked.map((f) => (
                    <span key={folderKey(f)} className="pill flex max-w-full items-center gap-1 bg-surface px-1.5 py-0.5 text-[11px] text-content">
                      <Icon name={canon(f.connection_id) === LOCAL ? "folder" : "server"} size={10} className="shrink-0 text-content-faint" />
                      <span className="truncate" title={`${nameOf(f.connection_id)} · ${f.path}`}>
                        {base(f.path)} <span className="text-content-faint">· {nameOf(f.connection_id)}</span>
                      </span>
                      <button onClick={() => toggle(f.connection_id, f.path)} className="shrink-0 text-content-faint hover:text-danger" aria-label={t("topbar.unselectX", { name: base(f.path) })}>
                        <Icon name="x" size={10} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="mt-1.5 flex items-center justify-end gap-1.5">
                  <button onClick={() => setPicked([])} className="btn-ghost py-1 px-2 text-[12px]">
                    {t("common.cancel")}
                  </button>
                  <button onClick={connectPicked} disabled={busy !== null} className="btn-primary py-1 px-2.5 text-[12px]" data-testid="folders-connect-picked">
                    {busy === "picked" ? <Icon name="spinner" size={12} spin /> : <Icon name="plus" size={12} />}{" "}
                    {t("topbar.connectN", { count: picked.length })}
                  </button>
                </div>
              </div>
            )}
            {error && (
              <p className="mt-1.5 break-words text-[11.5px] text-danger" data-testid="folders-error">
                {error}
              </p>
            )}
          </div>
        </div>
      </Popover>

      {picker && cur && (
        <FolderPicker
          connectionId={listConn}
          hostLabel={cur.sub ? `${cur.label} (${cur.sub})` : cur.label}
          initialPath={onWsHost ? session.workspace_path : listAt || "~"}
          exclude={[...taken].filter((k) => k.startsWith(`${cur.key}::`)).map((k) => k.slice(cur.key.length + 2))}
          onAdd={(p) => add(curConn, p)}
          onPick={(p) => {
            toggle(curConn, p);
            setOpen(true);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </>
  );
}
