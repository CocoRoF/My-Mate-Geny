import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fsList, fsResolve, fsStat, type FsEntry } from "../api/fs";
import { dirName } from "../lib/fileView";
import { parsePathRef, resolvePath } from "../lib/paths";
import { folderFor, isQualified, qualify, sessionFolders, strip, unqualify } from "../lib/hosts";
import type { Session } from "../types";
import { tr } from "../i18n";
import { sidePanelPreferences, panelWidth, type SidePanelKind } from "../lib/sidePanel";

/**
 * Workbench = the VS Code-like layer around a chat: file tabs in the main
 * area (per session; the chat itself is the fixed first tab) and the right
 * Explorer panel. Tabs follow VS Code's preview rule: a single click opens a
 * *preview* tab that the next single click reuses; double-click (or the tab
 * title) pins it. A tab's position never changes on its own.
 */

export interface FileTab {
  id: string; // = path (unique per session)
  path: string;
  preview: boolean;
  line?: number;
  endLine?: number;
  nonce?: number; // bumps to re-scroll to `line` when an open tab is re-targeted
}

interface SessionTabs {
  tabs: FileTab[];
  active: string | null; // null = the chat
}

interface Toast {
  msg: string;
  tone: "info" | "error";
  n: number;
}

interface WorkbenchState {
  bySession: Record<string, SessionTabs>;
  explorerOpen: boolean;
  sidePanel: SidePanelKind;
  panelWidth: number;
  showHidden: boolean;
  pinnedRoots: Record<string, string[]>; // folders opened in the explorer beyond the session's own
  expanded: Record<string, string[]>; // per session
  selected: string | null; // highlighted explorer row
  reveal: { path: string; n: number } | null; // scroll this row into view
  epoch: number; // bumps when a turn ends → refresh folders / open file
  toast: Toast | null;
  insert: { sid: string; text: string; n: number } | null; // text for the composer

  setExplorer: (open: boolean) => void;
  setSidePanel: (kind: SidePanelKind) => void;
  setPanelWidth: (w: number) => void;
  toggleHidden: () => void;
  openFile: (sid: string, path: string, opts?: { preview?: boolean; line?: number; endLine?: number }) => void;
  pinTab: (sid: string, id: string) => void;
  closeTab: (sid: string, id: string) => void;
  closeOthers: (sid: string, id: string | null) => void;
  activate: (sid: string, id: string | null) => void;
  moveTab: (sid: string, from: number, to: number) => void;
  setExpanded: (sid: string, path: string, open: boolean) => void;
  collapseAll: (sid: string) => void;
  select: (path: string | null, reveal?: boolean) => void;
  addRoot: (sid: string, path: string) => void;
  removeRoot: (sid: string, path: string) => void;
  bump: () => void;
  notify: (msg: string, tone?: Toast["tone"]) => void;
  insertText: (sid: string, text: string) => void;
}

const initialPanel = (): SidePanelKind => {
  try { return typeof window !== "undefined" && window.innerWidth >= 1100 && localStorage.getItem("hrh_session_panel") !== "0" ? "session" : null; }
  catch { return null; }
};

const empty: SessionTabs = { tabs: [], active: null };

export const useWorkbench = create<WorkbenchState>()(
  persist(
    (set) => {
      const patch = (sid: string, fn: (s: SessionTabs) => SessionTabs) =>
        set((st) => ({ bySession: { ...st.bySession, [sid]: fn(st.bySession[sid] || empty) } }));
      return {
        bySession: {},
        explorerOpen: false,
        sidePanel: initialPanel(),
        panelWidth: 340,
        showHidden: false,
        pinnedRoots: {},
        expanded: {},
        selected: null,
        reveal: null,
        epoch: 0,
        toast: null,
        insert: null,

        setExplorer: (open) => set(s => open ? { explorerOpen: true, sidePanel: "explorer" } : s.sidePanel === "explorer" ? { explorerOpen: false, sidePanel: null } : {}),
        setSidePanel: kind => set({ sidePanel: kind, explorerOpen: kind === "explorer" }),
        setPanelWidth: w => set({ panelWidth: panelWidth(w) }),
        toggleHidden: () => set((s) => ({ showHidden: !s.showHidden })),

        openFile: (sid, path, opts = {}) =>
          patch(sid, (s) => {
            const preview = opts.preview ?? true;
            const target = { line: opts.line, endLine: opts.endLine, nonce: Date.now() };
            const existing = s.tabs.find((t) => t.id === path);
            if (existing) {
              return {
                active: path,
                tabs: s.tabs.map((t) => (t.id === path ? { ...t, ...target, preview: t.preview && preview } : t)),
              };
            }
            const tab: FileTab = { id: path, path, preview, ...target };
            const slot = preview ? s.tabs.findIndex((t) => t.preview) : -1;
            if (slot >= 0) {
              const tabs = [...s.tabs];
              tabs[slot] = tab;
              return { tabs, active: path };
            }
            const at = s.active ? s.tabs.findIndex((t) => t.id === s.active) + 1 : s.tabs.length;
            const tabs = [...s.tabs];
            tabs.splice(at, 0, tab);
            return { tabs, active: path };
          }),
        pinTab: (sid, id) => patch(sid, (s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) })),
        closeTab: (sid, id) =>
          patch(sid, (s) => {
            const i = s.tabs.findIndex((t) => t.id === id);
            const tabs = s.tabs.filter((t) => t.id !== id);
            if (s.active !== id) return { ...s, tabs };
            const next = tabs[i] || tabs[i - 1] || null;
            return { tabs, active: next ? next.id : null };
          }),
        closeOthers: (sid, id) =>
          patch(sid, (s) => ({ tabs: s.tabs.filter((t) => t.id === id), active: id })),
        activate: (sid, id) => patch(sid, (s) => ({ ...s, active: id })),
        moveTab: (sid, from, to) =>
          patch(sid, (s) => {
            const tabs = [...s.tabs];
            const [t] = tabs.splice(from, 1);
            tabs.splice(to, 0, t);
            return { ...s, tabs };
          }),

        setExpanded: (sid, path, open) =>
          set((st) => {
            const cur = new Set(st.expanded[sid] || []);
            if (open) cur.add(path);
            else cur.delete(path);
            return { expanded: { ...st.expanded, [sid]: [...cur] } };
          }),
        collapseAll: (sid) => set((st) => ({ expanded: { ...st.expanded, [sid]: [] } })),
        select: (path, reveal = false) =>
          set({ selected: path, ...(reveal && path ? { reveal: { path, n: Date.now() } } : {}) }),
        addRoot: (sid, path) =>
          set((st) => {
            const cur = st.pinnedRoots[sid] || [];
            return cur.includes(path) ? {} : { pinnedRoots: { ...st.pinnedRoots, [sid]: [...cur, path] } };
          }),
        removeRoot: (sid, path) =>
          set((st) => ({ pinnedRoots: { ...st.pinnedRoots, [sid]: (st.pinnedRoots[sid] || []).filter((p) => p !== path) } })),
        bump: () => set((s) => ({ epoch: s.epoch + 1 })),
        notify: (msg, tone = "info") => set({ toast: { msg, tone, n: Date.now() } }),
        insertText: (sid, text) => set({ insert: { sid, text, n: Date.now() } }),
      };
    },
    {
      name: "hrh_workbench_v1",
      version: 2,
      migrate: (saved) => ({ bySession: {}, showHidden: false, pinnedRoots: {}, expanded: {}, ...(saved as Partial<WorkbenchState>), ...sidePanelPreferences(saved, initialPanel()) }),
      merge: (saved, current) => ({ ...current, ...(saved as object), ...sidePanelPreferences(saved, current.sidePanel) }),
      partialize: (s) => ({
        bySession: s.bySession,
        sidePanel: s.sidePanel,
        panelWidth: s.panelWidth,
        showHidden: s.showHidden,
        pinnedRoots: s.pinnedRoots,
        expanded: s.expanded,
      }),
    },
  ),
);

export const useSessionTabs = (sid: string | null | undefined) =>
  useWorkbench((s) => (sid ? s.bySession[sid] : undefined) || empty);

/** Roots the explorer shows for a session: workspace, its extra folders (on any host: qualified keys, lib/hosts.ts),
 *  then folders opened here. */
export function explorerRoots(session: Session, pinned: string[] = []): string[] {
  const out: string[] = [];
  const add = (q: string) => {
    if (q && !out.includes(q)) out.push(q);
  };
  add(strip(session.workspace_path) || "/");
  for (const f of sessionFolders(session)) add(qualify(session, f.connection_id, strip(f.path) || "/"));
  for (const p of pinned) {
    const { conn, path } = unqualify(session, p);
    add(qualify(session, conn, strip(path) || "/"));
  }
  return out;
}

const insidePath = (p: string, root: string) => p === root || p.startsWith(root === "/" ? "/" : root + "/");
/** `q` (a workbench key) is inside root `r` — the same host and under its path. */
export function insideKey(session: Session, q: string, r: string): boolean {
  const a = unqualify(session, q);
  const b = unqualify(session, r);
  return (a.conn || null) === (b.conn || null) && insidePath(a.path, b.path);
}
/** The parent folder of a workbench key, on the same host. */
export function dirKeyOf(session: Session, q: string): string {
  const { conn, path } = unqualify(session, q);
  return qualify(session, conn, dirName(path));
}

// ---- folder contents cache (not persisted) ------------------------------

interface DirState {
  entries?: FsEntry[];
  truncated?: boolean;
  loading: boolean;
  error?: string;
}

interface DirCache {
  dirs: Record<string, DirState>;
  load: (conn: string | null, path: string, force?: boolean) => Promise<FsEntry[] | undefined>;
  forget: () => void;
}

export const dirKey = (conn: string | null, path: string) => `${conn || "local"}::${path}`;

export const useDirCache = create<DirCache>((set, get) => ({
  dirs: {},
  load: async (conn, path, force = false) => {
    const key = dirKey(conn, path);
    const cur = get().dirs[key];
    if (cur && !force && (cur.entries || cur.loading)) return cur.entries;
    // keep showing the old list while a refresh runs
    set((s) => ({ dirs: { ...s.dirs, [key]: { ...cur, loading: true, error: undefined } } }));
    try {
      const r = await fsList(path, conn);
      set((s) => ({ dirs: { ...s.dirs, [key]: { entries: r.entries, truncated: r.truncated, loading: false } } }));
      return r.entries;
    } catch (e: any) {
      set((s) => ({ dirs: { ...s.dirs, [key]: { ...get().dirs[key], loading: false, error: String(e.message || e) } } }));
      return undefined;
    }
  },
  forget: () => set({ dirs: {} }),
}));

/** Expand every folder from the nearest root down to `path`'s parent and select it. `path` is a workbench key
 *  (a plain path on the workspace's host, `@host:path` on another — lib/hosts.ts). */
export async function revealInExplorer(session: Session, path: string, isDir = false) {
  const wb = useWorkbench.getState();
  const { conn } = unqualify(session, path);
  let roots = explorerRoots(session, wb.pinnedRoots[session.id]);
  let root = roots.filter((r) => insideKey(session, path, r)).sort((a, b) => b.length - a.length)[0];
  if (!root) {
    // outside every root: open its folder as a new explorer root (VS Code "Open Folder")
    root = isDir ? path : dirKeyOf(session, path);
    wb.addRoot(session.id, root);
    roots = [...roots, root];
  }
  const chain: string[] = [];
  for (let p = isDir ? path : dirKeyOf(session, path); insideKey(session, p, root); p = dirKeyOf(session, p)) {
    chain.unshift(p);
    if (p === root || unqualify(session, p).path === "/") break;
  }
  for (const dir of chain) {
    wb.setExpanded(session.id, dir, true);
    await useDirCache.getState().load(conn, unqualify(session, dir).path);
  }
  wb.select(path, true);
}

/**
 * Open what a path reference points at: a file → a tab (at its line), a
 * folder → the explorer, revealed. Relative references resolve against
 * `base` (a markdown file's folder) or the workspace, then the extra folders;
 * an absolute one is looked up on the host of the folder it is in (the
 * workspace's host first). `raw` may also be a workbench key (`@host:path`).
 */
export async function openPath(session: Session, raw: string, opts: { base?: string; preview?: boolean } = {}) {
  const wb = useWorkbench.getState();
  const exact = isQualified(raw) ? unqualify(session, raw) : null;
  const ref = parsePathRef(exact ? exact.path : raw);
  const relative = !ref.path.startsWith("/") && !ref.path.startsWith("~");
  const main = session.connection_id || null;
  const folders = sessionFolders(session);
  const show = async (conn: string | null, st: { path: string; is_dir: boolean }) => {
    const key = qualify(session, conn, st.path);
    if (st.is_dir) {
      wb.setExplorer(true);
      await revealInExplorer(session, key, true);
    } else {
      wb.openFile(session.id, key, { preview: opts.preview ?? true, line: ref.line, endLine: ref.endLine });
      if (wb.explorerOpen) revealInExplorer(session, key).catch(() => {});
    }
  };
  // where to look, best first: (host, absolute path)
  const tries: { conn: string | null; path: string }[] = [];
  if (exact) tries.push({ conn: exact.conn, path: ref.path });
  else if (relative) {
    const b = opts.base ? unqualify(session, opts.base) : { conn: main, path: session.workspace_path };
    tries.push({ conn: b.conn, path: resolvePath(ref.path, b.path) });
  } else {
    const p = resolvePath(ref.path, "/");
    const f = folderFor(session, p);
    const inWs = insidePath(p, strip(session.workspace_path));
    if (f && !(inWs && strip(session.workspace_path).length >= strip(f.path).length)) tries.push({ conn: f.connection_id, path: p });
    if (!tries.some((x) => (x.conn || null) === main)) tries.push({ conn: main, path: p });
  }
  let lastErr = "";
  for (const x of tries) {
    try {
      return await show(x.conn, await fsStat(x.path, x.conn));
    } catch (e: any) {
      lastErr = String(e.message || e);
    }
  }
  if (relative && !exact && lastErr === "not found") {
    // Not under the first root: the agent may have meant a folder it was
    // working in (a chat on "/" that edited /home/x/repo prints "docs/a.md").
    try {
      const mainRoots = [session.workspace_path, ...folders.filter((f) => (f.connection_id || null) === main).map((f) => f.path)];
      const roots = [...(opts.base && !isQualified(opts.base) ? [opts.base] : []), ...mainRoots,
        ...(wb.pinnedRoots[session.id] || []).filter((p) => !isQualified(p))];
      const { matches } = await fsResolve(ref.path, main, session.id, roots);
      if (matches.length) return await show(main, matches[0]);
    } catch (e: any) {
      lastErr = String(e.message || e);
    }
    // then the folders on the other hosts
    for (const f of folders.filter((f) => (f.connection_id || null) !== main).slice(0, 6)) {
      try {
        return await show(f.connection_id, await fsStat(resolvePath(ref.path, f.path), f.connection_id));
      } catch {
        /* next */
      }
    }
  }
  wb.notify(lastErr === "not found" ? tr("files.notFound", { path: ref.path }) : `${ref.path}: ${lastErr}`, "error");
}
