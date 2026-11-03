import { useEffect, useMemo, useRef, useState } from "react";
import { fsRawUrl, type FsEntry } from "../../api/fs";
import { baseName, formatBytes, formatTime } from "../../lib/fileView";
import { displayPath } from "../../lib/paths";
import { useConnectionStore } from "../../stores/connectionStore";
import {
  dirKey,
  explorerRoots,
  openPath,
  useDirCache,
  useSessionTabs,
  useWorkbench,
} from "../../stores/workbenchStore";
import { hostName, qualify, sameHost, sessionFolders, strip, unqualify } from "../../lib/hosts";
import type { Session } from "../../types";
import Icon from "../ui/Icon";
import { fileIcon } from "../viewer/fileIcon";
import { useT, type MsgKey } from "../../i18n";

// Noise hidden unless "show all" is on (dotfiles like .env / .github stay visible).
const NOISE = new Set([".git", ".DS_Store", "Thumbs.db", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hg", ".svn"]);
const INDENT = 12;
const ROOT_KIND: Record<"workspace" | "folder" | "opened", MsgKey> = { workspace: "files.rootWorkspace", folder: "files.rootFolder", opened: "files.rootOpened" };

interface Menu {
  x: number;
  y: number;
  entry: FsEntry;
  key: string; // its workbench key (lib/hosts.ts)
  conn: string | null; // its host
}

/**
 * VS Code-style explorer for the session's host: the workspace, its extra
 * folders and any folder opened here, as lazily loaded trees. Clicking a file
 * opens a preview tab (double-click keeps it); folders expand in place.
 */
export default function ExplorerPanel({ session, onClose, onOpened }: {
  session: Session;
  onClose: () => void;
  onOpened?: () => void; // a file was opened (mobile: close the drawer)
}) {
  const t = useT();
  const sid = session.id;
  const conn = session.connection_id;
  const at = (key: string) => unqualify(session, key);
  const ld = (key: string, force = false) => {
    const x = at(key);
    return load(x.conn, x.path, force);
  };
  const connections = useConnectionStore((s) => s.connections);
  const pinned = useWorkbench((s) => s.pinnedRoots[sid]);
  const roots = useMemo(() => explorerRoots(session, pinned), [session, pinned]);
  const folderRoots = useMemo(
    () => new Set(sessionFolders(session).map((f) => qualify(session, f.connection_id, strip(f.path) || "/"))),
    [session],
  );
  const expandedList = useWorkbench((s) => s.expanded[sid]);
  const expanded = useMemo(() => new Set(expandedList || []), [expandedList]);
  const showHidden = useWorkbench((s) => s.showHidden);
  const selected = useWorkbench((s) => s.selected);
  const reveal = useWorkbench((s) => s.reveal);
  const epoch = useWorkbench((s) => s.epoch);
  const width = useWorkbench((s) => s.explorerWidth);
  const { tabs, active } = useSessionTabs(sid);
  const wb = useWorkbench.getState();
  const dirs = useDirCache((s) => s.dirs);
  const load = useDirCache((s) => s.load);
  const [goto, setGoto] = useState("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const [openRoots, setOpenRoots] = useState<Record<string, boolean>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const gotoRef = useRef<HTMLInputElement>(null);

  const conn_ = connections.find((c) => c.id === conn);
  const host = conn_ ? `${conn_.name} · ${conn_.username}@${conn_.host}` : t("files.thisServer");
  const activePath = tabs.find((t) => t.id === active)?.path;

  // Roots load on open; expanded folders (persisted) reload with them.
  useEffect(() => {
    for (const r of roots) if (openRoots[r] !== false) ld(r);
    for (const d of expanded) ld(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, conn]);

  // A turn ended: refresh what's on screen (the agent may have added/removed files).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(() => {
      const el = scroller.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(reveal.path)}"]`);
      el?.scrollIntoView({ block: "center" });
    }, 60);
    return () => clearTimeout(t);
  }, [reveal, dirs]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const refresh = () => {
    for (const r of roots) ld(r, true);
    for (const d of expanded) ld(d, true);
  };

  const toggleDir = (path: string) => {
    const open = !expanded.has(path);
    wb.setExpanded(sid, path, open);
    if (open) ld(path);
    wb.select(path);
  };

  const openFile = (path: string, pin: boolean) => {
    wb.select(path);
    wb.openFile(sid, path, { preview: !pin });
    onOpened?.();
  };

  const visible = (e: FsEntry) => showHidden || !NOISE.has(e.name);

  const rows = (key: string, depth: number): React.ReactNode => {
    const { conn: here, path } = at(key);
    const st = dirs[dirKey(here, path)];
    if (!st || (!st.entries && st.loading))
      return (
        <div className="py-1 text-[11.5px] text-content-faint" style={{ paddingLeft: depth * INDENT + 22 }}>
          {t("common.loading")}
        </div>
      );
    if (st.error)
      return (
        <div className="py-1 text-[11.5px] text-danger" style={{ paddingLeft: depth * INDENT + 22 }}>
          {st.error}
        </div>
      );
    const list = (st.entries || []).filter(visible);
    if (!list.length)
      return (
        <div className="py-1 text-[11.5px] italic text-content-faint" style={{ paddingLeft: depth * INDENT + 22 }}>
          empty
        </div>
      );
    return (
      <>
        {list.map((e) => {
          const k = qualify(session, here, e.path);
          const open = e.is_dir && expanded.has(k);
          const isSel = selected === k;
          const isActive = !e.is_dir && activePath === k;
          const { icon, tone } = e.is_dir ? { icon: open ? "folder-open" : "folder", tone: "text-warning/80 light:text-warning" } : fileIcon(e.name);
          return (
            <div key={k}>
              <div
                data-path={k}
                data-selected={isSel}
                onClick={() => (e.is_dir ? toggleDir(k) : openFile(k, false))}
                onDoubleClick={() => !e.is_dir && openFile(k, true)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  wb.select(k);
                  setMenu({ x: ev.clientX, y: ev.clientY, entry: e, key: k, conn: here });
                }}
                title={`${e.path}${e.is_dir ? "" : `\n${formatBytes(e.size)}${e.mtime ? ` · ${formatTime(e.mtime)}` : ""}`}`}
                className={`tree-row group relative flex h-[26px] touch:h-9 cursor-pointer select-none items-center gap-1.5 pr-2 text-[12.5px] transition-colors ${
                  isActive ? "bg-surface-3 text-content" : "text-content/80 hover:bg-surface-2"
                } ${NOISE.has(e.name) || e.name.startsWith(".") ? "opacity-70" : ""}`}
                style={{ paddingLeft: depth * INDENT + 6 }}
              >
                {/* indent guides */}
                {Array.from({ length: depth }, (_, i) => (
                  <span key={i} className="absolute top-0 h-full w-px bg-border/70" style={{ left: i * INDENT + 12 }} />
                ))}
                <span className="grid w-3.5 shrink-0 place-items-center text-content-faint">
                  {e.is_dir && <Icon name={open ? "chevron-down" : "chevron"} size={12} />}
                </span>
                <Icon name={icon as any} size={14} className={`shrink-0 ${tone}`} />
                <span className="min-w-0 truncate">{e.name}</span>
                {e.is_link && <span className="shrink-0 text-[10px] text-content-faint">↗</span>}
                {!e.is_dir && (
                  <span className="ml-auto hidden shrink-0 pl-2 text-[10.5px] text-content-faint group-hover:inline">
                    {formatBytes(e.size)}
                  </span>
                )}
              </div>
              {open && rows(k, depth + 1)}
            </div>
          );
        })}
        {st.truncated && (
          <div className="py-1 text-[11px] text-warning" style={{ paddingLeft: depth * INDENT + 22 }}>
            {t("files.first5000")}
          </div>
        )}
      </>
    );
  };

  const menuItems = ({ entry: e, key, conn: where }: Menu): [string, () => void][] => {
    const rel = sameHost(where, conn) ? displayPath(e.path, [session.workspace_path]) : e.path;
    const items: [string, () => void][] = [];
    if (!e.is_dir) items.push([t("common.open"), () => openFile(key, true)]);
    else items.push([t("files.openAsRoot"), () => wb.addRoot(sid, key)], [t("common.refresh"), () => load(where, e.path, true)]);
    items.push(
      [t("files.mentionInChat"), () => {
        wb.insertText(sid, `@${rel.includes(" ") ? `"${rel}"` : rel} `);
        wb.activate(sid, null);
        onOpened?.();
      }],
      [t("files.copyPath"), () => navigator.clipboard?.writeText(e.path)],
      [t("files.copyRelPath"), () => navigator.clipboard?.writeText(rel)],
    );
    if (!e.is_dir)
      items.push([t("common.download"), () => {
        const a = document.createElement("a");
        a.href = fsRawUrl(e.path, where, true);
        a.download = e.name;
        a.click();
      }]);
    return items;
  };

  // drag the left edge to resize (wide screens)
  const startResize = (ev: React.PointerEvent) => {
    ev.preventDefault();
    const x0 = ev.clientX;
    const w0 = width;
    const move = (e: PointerEvent) => wb.setExplorerWidth(w0 + (x0 - e.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside
      className="relative flex h-full max-w-[92vw] shrink-0 flex-col border-l border-border bg-surface/95 backdrop-blur-xl"
      style={{ width }}
    >
      <div
        onPointerDown={startResize}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize hover:bg-accent/30 xl:block"
        title={t("files.dragResize")}
      />
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border/70 pl-4 pr-2">
        <Icon name="files" size={15} className="text-accent" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold leading-tight">{t("files.explorer")}</span>
          <span className="block truncate text-[10.5px] leading-tight text-content-faint">{host}</span>
        </span>
        <button onClick={() => wb.toggleHidden()} className={`rounded-md p-1.5 touch:p-2.5 hover:bg-surface-3 ${showHidden ? "text-accent" : "text-content-faint hover:text-content"}`} title={showHidden ? t("files.hideNoise") : t("files.showAll")}>
          <Icon name={showHidden ? "eye" : "eye-off"} size={14} />
        </button>
        <button onClick={() => wb.collapseAll(sid)} className="rounded-md p-1.5 touch:p-2.5 text-content-faint hover:bg-surface-3 hover:text-content" title={t("files.collapseFolders")}>
          <Icon name="collapse" size={14} />
        </button>
        <button onClick={refresh} className="rounded-md p-1.5 touch:p-2.5 text-content-faint hover:bg-surface-3 hover:text-content" title={t("common.refresh")}>
          <Icon name="refresh" size={14} />
        </button>
        <button onClick={onClose} className="rounded-md p-1.5 touch:p-2.5 text-content-faint hover:bg-surface-3 hover:text-content" title={t("files.closeExplorer")}>
          <Icon name="x" size={16} />
        </button>
      </div>

      {/* go to path: open a file, or reveal / open a folder anywhere on the host */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const p = goto.trim();
          if (!p) return;
          openPath(session, p, { preview: false }).then(() => onOpened?.());
          setGoto("");
        }}
        className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-3 py-1.5 touch:py-1"
      >
        <Icon name="search" size={12} className="text-content-faint" />
        <input
          ref={gotoRef}
          value={goto}
          onChange={(e) => setGoto(e.target.value)}
          placeholder={t("files.gotoPlaceholder")}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-content placeholder:font-sans placeholder:text-content-faint outline-none"
        />
        <button type="submit" className="rounded p-0.5 touch:p-2.5 touch:-mr-2 text-content-faint hover:text-content" title={t("common.open")}>
          <Icon name="arrow-up" size={12} className="rotate-90" />
        </button>
      </form>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-6">
        {roots.map((r, i) => {
          const open = openRoots[r] !== false;
          const kind = i === 0 ? "workspace" : folderRoots.has(r) ? "folder" : "opened";
          const rc = at(r).conn;
          return (
            <section key={r} className="border-b border-border/50">
              <div
                className="group sticky top-0 z-[5] flex h-7 touch:h-10 cursor-pointer select-none items-center gap-1.5 bg-surface/95 px-2 text-[11px] font-semibold uppercase tracking-wide text-content-dim backdrop-blur hover:text-content"
                onClick={() => {
                  setOpenRoots((s) => ({ ...s, [r]: !open }));
                  if (!open) ld(r);
                }}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  setMenu({ x: ev.clientX, y: ev.clientY, entry: { name: baseName(at(r).path), path: at(r).path, is_dir: true, size: 0, mtime: null }, key: r, conn: rc });
                }}
                title={sameHost(rc, conn) ? at(r).path : `${hostName(rc, connections, t("files.thisServer"))} · ${at(r).path}`}
                data-root-host={rc || "local"}
              >
                <Icon name={open ? "chevron-down" : "chevron"} size={12} className="shrink-0" />
                <span className="truncate">{baseName(at(r).path) || "/"}</span>
                <span className="shrink-0 font-normal normal-case tracking-normal text-content-faint">{t(ROOT_KIND[kind])}</span>
                {!sameHost(rc, conn) && (
                  <span
                    className={`pill max-w-[7rem] shrink-0 truncate px-1.5 py-0 text-[10px] font-normal normal-case tracking-normal ${
                      rc ? "bg-cyan/10 text-cyan" : "bg-surface-3 text-content-dim"
                    }`}
                    data-testid="explorer-root-host"
                  >
                    {hostName(rc, connections, t("files.thisServer"))}
                  </span>
                )}
                {kind === "opened" && (
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      wb.removeRoot(sid, r);
                    }}
                    className="ml-auto shrink-0 rounded p-0.5 touch:p-2 text-content-faint can-hover:opacity-0 hover:text-content group-hover:opacity-100"
                    title={t("files.removeFromExplorer")}
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
              {open && <div className="pb-1">{rows(r, 0)}</div>}
            </section>
          );
        })}
        <button
          onClick={() => {
            // (no window.prompt: the Electron app doesn't implement it)
            setGoto(session.workspace_path.replace(/\/[^/]*$/, "/") || "/");
            gotoRef.current?.focus();
          }}
          className="mx-3 mt-3 flex items-center gap-1.5 touch:py-2 text-[12px] text-content-faint hover:text-content"
        >
          <Icon name="folder-plus" size={13} /> {t("files.openAnotherFolder")}
        </button>
      </div>

      {menu && (
        <div
          className="fixed z-[70] min-w-[180px] overflow-hidden rounded-lg border border-border bg-surface-2 py-1 text-[12.5px] shadow-float"
          style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 220) }}
        >
          {menuItems(menu).map(([label, fn]) => (
            <button
              key={label}
              onClick={fn}
              className="block w-full px-3 py-1.5 text-left text-content-dim hover:bg-surface-3 hover:text-content"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
