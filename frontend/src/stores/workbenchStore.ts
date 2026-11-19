import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fsList, fsResolve, fsStat, type FsEntry, type FsNear } from "../api/fs";
import { dirName } from "../lib/fileView";
import { parsePathRef, resolvePath } from "../lib/paths";
import { folderFor, isQualified, qualify, sessionFolders, strip, unqualify } from "../lib/hosts";
import type { Session } from "../types";
import { tr } from "../i18n";
import { sidePanelPreferences, panelWidth, type SidePanelKind } from "../lib/sidePanel";
import * as L from "../lib/editorLayout";

/**
 * Workbench = the VS Code-like layer around a chat: file tabs in the main
 * area (per session; the chat itself is the fixed first tab) and the right
 * Explorer panel. Tabs follow VS Code's preview rule: a single click opens a
 * *preview* tab that the next single click reuses; double-click (or the tab
 * title) pins it. A tab's position never changes on its own.
 *
 * Tabs can be split into groups side by side or one above the other (lib/editorLayout.ts — the chat a tab too, so
 * it can sit beside a file): `layout` says which group has which tab; a file opens in the focused group, whose shown
 * tab is `active`.
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
  active: string | null; // the focused group's shown tab; null = the chat
  layout?: L.Layout; // the groups (none stored: one group of them all — tabs from before splits)
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
  /** the other files of `id`'s group closed (`id` null: every file of `group`, else of the focused group) */
  closeOthers: (sid: string, id: string | null, group?: string) => void;
  activate: (sid: string, id: string | null) => void;
  /** a tab (a file's path, or L.CHAT) moved into a group, at a place (else at its end) */
  moveTab: (sid: string, tab: string, group: string, index?: number) => void;
  /** a tab dropped on a group's edge: a new group on that side with it */
  splitTab: (sid: string, tab: string, group: string, side: L.Side) => void;
  resizeSplit: (sid: string, split: string, ratio: number) => void;
  focusGroup: (sid: string, group: string) => void;
  unsplit: (sid: string) => void;
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

/** a session's groups, mended for the files open (lib/editorLayout.ts normalize) */
export const layoutOf = (s: SessionTabs): L.Layout => L.normalize(s.layout, s.tabs.map((t) => t.id), s.active);

/** the session with `layout`, its shown tab in step (the explorer, the back button follow `active`) */
function withLayout(s: SessionTabs, layout: L.Layout, tabs: FileTab[] = s.tabs): SessionTabs {
  const shown = L.focused(layout).active;
  return { tabs, layout, active: shown === L.CHAT ? null : shown };
}

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
            const layout = layoutOf(s);
            const existing = s.tabs.find((t) => t.id === path);
            if (existing) {
              // (open already — in whichever group: shown there, that group focused)
              const tabs = s.tabs.map((t) => (t.id === path ? { ...t, ...target, preview: t.preview && preview } : t));
              return withLayout(s, L.activate(layout, path), tabs);
            }
            const tab: FileTab = { id: path, path, preview, ...target };
            // a preview opens in place of the focused group's preview tab
            const group = L.focused(layout);
            const slot = preview ? s.tabs.find((t) => t.preview && group.tabs.includes(t.id)) : undefined;
            if (slot) return withLayout(s, L.addTab(layout, path, slot.id), s.tabs.map((t) => (t.id === slot.id ? tab : t)));
            return withLayout(s, L.addTab(layout, path), [...s.tabs, tab]);
          }),
        pinTab: (sid, id) => patch(sid, (s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) })),
        closeTab: (sid, id) =>
          patch(sid, (s) => (id === L.CHAT ? s : withLayout(s, L.removeTab(layoutOf(s), id), s.tabs.filter((t) => t.id !== id)))),
        closeOthers: (sid, id, group) =>
          patch(sid, (s) => {
            let layout = layoutOf(s);
            const g = (id && L.groupOf(layout, id)) || (group && L.findGroup(layout, group)) || L.focused(layout);
            const gone = g.tabs.filter((t) => t !== id && t !== L.CHAT);
            for (const t of gone) layout = L.removeTab(layout, t);
            if (id) layout = L.activate(layout, id);
            return withLayout(s, layout, s.tabs.filter((t) => !gone.includes(t.id)));
          }),
        activate: (sid, id) => patch(sid, (s) => withLayout(s, L.activate(layoutOf(s), id ?? L.CHAT))),
        moveTab: (sid, tab, group, index) => patch(sid, (s) => withLayout(s, L.moveTab(layoutOf(s), tab, group, index))),
        splitTab: (sid, tab, group, side) => patch(sid, (s) => withLayout(s, L.splitWith(layoutOf(s), tab, group, side))),
        resizeSplit: (sid, split, ratio) => patch(sid, (s) => ({ ...s, layout: L.resize(layoutOf(s), split, ratio) })),
        focusGroup: (sid, group) => patch(sid, (s) => withLayout(s, L.focusGroup(layoutOf(s), group))),
        unsplit: (sid) => patch(sid, (s) => withLayout(s, L.unsplit(layoutOf(s)))),

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
      version: 3, // (3: split groups — a session's `layout`; one stored before is one group: layoutOf mends it)
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
  const mainRoots = [session.workspace_path, ...folders.filter((f) => (f.connection_id || null) === main).map((f) => f.path)];
  const roots = [...(opts.base && !isQualified(opts.base) ? [opts.base] : []), ...mainRoots,
    ...(wb.pinnedRoots[session.id] || []).filter((p) => !isQualified(p))];
  if (relative && !exact && lastErr === "not found") {
    // Not under the first root: the agent may have meant a folder it was
    // working in (a chat on "/" that edited /home/x/repo prints "docs/a.md").
    try {
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
  if (lastErr === "not found") {
    // Nothing there: the agent named it before making it ("when the run ends I'll write out/x.docx"), made it again
    // under another name, or the name stands for several files (report_V3-xx.docx). Its folder, and what in it was
    // most likely meant, instead of a bare "not found".
    const conn = exact ? exact.conn : relative ? main : (tries[0]?.conn ?? main);
    try {
      const { near } = await fsResolve(ref.path, conn, session.id, relative && !exact ? roots : [], true);
      if (near && (await showNear(session, conn, ref.path, near))) return;
    } catch {
      /* the plain message below */
    }
  }
  wb.notify(lastErr === "not found" ? tr("files.notFound", { path: ref.path }) : `${ref.path}: ${lastErr}`, "error");
}

const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** Show what a missing path most likely meant (`openPath`): the one file made again under a near-identical name —
 *  opened, saying so; several (a name standing for many, or a few alike) — their folder, the first one selected;
 *  none yet — the folder it belongs in (or the nearest one there is). */
async function showNear(session: Session, conn: string | null, raw: string, near: FsNear): Promise<boolean> {
  const wb = useWorkbench.getState();
  const name = baseName(raw);
  if (near.sure && near.similar.length === 1) {
    wb.openFile(session.id, qualify(session, conn, near.similar[0]), { preview: true });
    wb.notify(tr("files.openedSimilar", { name, similar: baseName(near.similar[0]) }), "info");
    return true;
  }
  wb.setExplorer(true);
  if (near.similar.length) {
    await revealInExplorer(session, qualify(session, conn, near.similar[0]));
    wb.notify(
      near.how === "pattern"
        ? tr("files.patternFolder", { name, count: near.similar.length })
        : tr("files.similarFolder", { name, similar: near.similar.map(baseName).slice(0, 3).join(", ") }),
      "info",
    );
    return true;
  }
  await revealInExplorer(session, qualify(session, conn, near.folder), true);
  wb.notify(tr(near.own_folder ? "files.notYetFolder" : "files.notYetNearest", { name, folder: baseName(near.folder) }), "info");
  return true;
}
