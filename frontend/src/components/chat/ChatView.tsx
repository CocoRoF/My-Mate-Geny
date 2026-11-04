import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { stopTurn } from "../../api/sessions";
import RightSidebar from "./panel/RightSidebar";
import { MenuButton } from "../layout/MobileTopBar";
import { useBackHandler } from "../../lib/back";
import TasksPanel from "../tasks/TasksPanel";
import { isRunning, useTaskStore } from "../../stores/taskStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useChatSocket } from "../../hooks/useChatSocket";
import MessageList from "./MessageList";
import InputBar from "./InputBar";
import { DropOverlay, useFileDrop } from "../composer/useFileDrop";
import NewSessionPanel from "./NewSessionPanel";
import UsageModal from "../usage/UsageModal";
import Icon, { type IconName } from "../ui/Icon";
import TabBar from "../viewer/TabBar";
import FolderButton from "./topbar/FolderButton";
import GitButton from "./topbar/GitButton";
import { useChatStore } from "../../stores/chatStore";
import { useSessionTabs, useWorkbench } from "../../stores/workbenchStore";
import { useT } from "../../i18n";

// Viewers (and their format libraries) load when a file is first opened.
const FileViewer = lazy(() => import("../viewer/FileViewer"));
const WIDE = 1280; // below this the side panels are drawers

/** An element's width, kept current by a ResizeObserver (no polling). */
function useWidth(el: HTMLElement | null): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

function Toast() {
  const toast = useWorkbench((s) => s.toast);
  const [shown, setShown] = useState<typeof toast>(null);
  useEffect(() => {
    if (!toast) return;
    setShown(toast);
    const t = setTimeout(() => setShown(null), toast.tone === "error" ? 4000 : 1800);
    return () => clearTimeout(t);
  }, [toast]);
  if (!shown) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[80] flex justify-center px-4">
      <div
        className={`max-w-[90vw] truncate rounded-lg border px-3 py-1.5 text-[12.5px] shadow-float animate-fade-in ${
          shown.tone === "error" ? "border-danger/30 bg-surface-2 text-danger" : "border-border bg-surface-2 text-content"
        }`}
      >
        {shown.msg}
      </div>
    </div>
  );
}

/** Phones: the header's secondary buttons (tasks, usage, session panel) live here. */
function MoreMenu({
  items,
  onClose,
}: {
  items: { icon: IconName; label: string; badge?: string; spin?: boolean; onClick: () => void }[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useBackHandler(true, onClose);
  useEffect(() => {
    const h = (e: MouseEvent | TouchEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest?.("[data-more-toggle]")) return;
      onClose();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", h);
    window.addEventListener("touchstart", h);
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("mousedown", h);
      window.removeEventListener("touchstart", h);
      window.removeEventListener("keydown", k);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute right-2 top-[calc(100%+4px)] z-50 w-56 overflow-hidden rounded-xl border border-border bg-surface-2 py-1 shadow-float animate-fade-in"
    >
      {items.map((it) => (
        <button
          key={it.label}
          onClick={() => {
            onClose();
            it.onClick();
          }}
          className="flex h-11 w-full items-center gap-3 px-3.5 text-[14px] text-content hover:bg-surface-3"
        >
          <Icon name={it.icon} size={16} spin={it.spin} className="text-content-dim" />
          {it.label}
          {it.badge && <span className="ml-auto pill bg-accent-soft text-accent">{it.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export default function ChatView() {
  const t = useT();
  const activeId = useSessionStore((s) => s.activeId);
  const sessions = useSessionStore((s) => s.sessions);
  const active = sessions.find((s) => s.id === activeId) || null;
  const { send, steer, stop: stopWs } = useChatSocket(activeId);
  const [showUsage, setShowUsage] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [more, setMore] = useState(false);
  const runningTasks = useTaskStore((s) => (activeId ? (s.bySession[activeId] || []).filter(isRunning).length : 0));
  const sidePanel = useWorkbench(s => s.sidePanel);
  const setSidePanel = useWorkbench(s => s.setSidePanel);
  const panel = sidePanel === "session";
  const togglePanel = () => setSidePanel(panel ? null : "session");
  const explorer = useWorkbench((s) => s.explorerOpen);
  const setExplorer = useWorkbench((s) => s.setExplorer);
  const { tabs, active: activeTab } = useSessionTabs(activeId);
  const activate = useWorkbench((s) => s.activate);
  // The top bar's density follows its own width (sidebar, explorer, panel and window all take from it): "full" shows
  // every label (and, given room to spare, the workspace path), "medium" drops the view buttons' labels, "tight" also
  // shrinks Folder / Git to their icons. (Phones: the sm: classes below, plus the More menu.)
  const [barEl, setBarEl] = useState<HTMLDivElement | null>(null);
  const barW = useWidth(barEl);
  const density: "full" | "medium" | "tight" = !barW || barW >= 900 ? "full" : barW >= 560 ? "medium" : "tight";
  const showWorkspace = barW >= 1100;
  const labels = density === "full" ? "hidden sm:inline" : "hidden";
  // Narrow screens open on the chat: a drawer left open last time stays closed.
  useEffect(() => {
    if (window.innerWidth < WIDE) setSidePanel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Tabs mount on first view and then stay mounted (scroll, zoom, sheet survive switching).
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (activeId && activeTab) setVisited((v) => (v.has(`${activeId}:${activeTab}`) ? v : new Set(v).add(`${activeId}:${activeTab}`)));
  }, [activeId, activeTab]);
  // A finished turn may have changed files: explorer + open files refresh.
  const streaming = useChatStore((s) => s.isStreaming);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) useWorkbench.getState().bump();
    wasStreaming.current = streaming;
  }, [streaming]);
  useBackHandler(panel && window.innerWidth < WIDE, () => togglePanel());
  useBackHandler(explorer && window.innerWidth < WIDE, () => setExplorer(false));
  useBackHandler(!!activeId && activeTab !== null && window.innerWidth < 768, () => activeId && activate(activeId, null));
  useBackHandler(showUsage, () => setShowUsage(false));
  const stop = useCallback(() => {
    stopWs();
    if (activeId) stopTurn(activeId).catch(() => {}); // also works while the socket is reconnecting
  }, [stopWs, activeId]);
  // drag & drop over the chat, Ctrl/⌘+V anywhere in it (not just in the textarea)
  const { dragging, dropProps } = useFileDrop(activeId);

  if (!activeId) return <NewSessionPanel />;

  return (
    <div className="h-full flex">
    <div className="relative h-full flex flex-1 min-w-0 flex-col" {...dropProps}>
      {dragging && <DropOverlay hint={t("session.dropHint")} />}
      {active && (
        <div className={`relative pt-safe shrink-0 border-b border-border/70 bg-surface/40 backdrop-blur-sm ${more ? "z-30" : ""}`}>
        <div ref={setBarEl} data-testid="topbar" data-density={density} className="flex items-center gap-2 px-3 sm:px-5 h-12 md:h-14">
          <MenuButton />
          <Icon
            name={active.connection_id ? "server" : "cpu"}
            size={16}
            className={`shrink-0 ${active.connection_id ? "text-cyan" : "text-accent"}`}
          />
          <span
            data-topbar-item="title"
            className={`text-[14px] md:text-sm font-medium text-content truncate ${density === "full" ? "min-w-[5rem]" : "min-w-0"}`}
            title={active.title}
          >
            {active.title}
          </span>
          {density === "full" && (
            <span className="pill bg-surface-3 text-content-dim shrink-0 hidden sm:inline-flex">{active.provider}</span>
          )}
          {active.mode === "plan" && <span className="pill bg-violet/15 text-violet shrink-0">{t("nav.plan")}</span>}
          <span className="min-w-0 flex-1" aria-hidden />
          {/* the workspace path gives way first (shrinks 6× faster than the title, down to 4rem), then the title; the
              buttons never shrink */}
          {showWorkspace && (
            <button
              onClick={() => setExplorer(true)}
              data-topbar-item="workspace"
              className="hidden min-w-[7rem] max-w-[260px] shrink-[6] items-center gap-1 font-mono text-[11px] text-content-faint hover:text-content sm:flex"
              title={t(active.connection_id ? "session.remoteWorkspaceTitle" : "session.localWorkspaceTitle", { path: active.workspace_path })}
            >
              <span className="shrink-0">{active.connection_id ? t("nav.remote") : t("nav.local")} ·</span>
              {/* cut at the start: the folder's own name (the end of the path) stays readable */}
              <span className="min-w-0 truncate text-left [direction:rtl]">
                <bdi>{active.workspace_path}</bdi>
              </span>
            </button>
          )}
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">
            <FolderButton session={active} compact={density !== "full"} />
            <GitButton session={active} compact={density === "tight"} />
            <span className="mx-0.5 hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden />
            <button
              onClick={() => setShowTasks(true)}
              data-topbar-item="tasks"
              className={`btn-ghost h-10 w-10 p-0 sm:h-auto sm:w-auto sm:py-1 sm:px-2 shrink-0 ${
                runningTasks ? "text-accent" : "hidden sm:inline-flex"
              }`}
              title={t("tasks.title")}
              aria-label={t("tasks.title")}
            >
              {runningTasks ? <Icon name="spinner" size={14} spin /> : <Icon name="activity" size={14} />}
              <span className={labels}>{t("session.tasks")}</span>
              {runningTasks > 0 && <span className="pill bg-accent-soft text-accent hidden sm:inline-flex">{runningTasks}</span>}
            </button>
            <button
              onClick={() => setShowUsage(true)}
              data-topbar-item="usage"
              className="btn-ghost hidden sm:inline-flex py-1 px-2 shrink-0"
              title={t("session.accountUsage")}
              aria-label={t("session.accountUsage")}
            >
              <Icon name="cpu" size={14} /> <span className={labels}>{t("nav.usage")}</span>
            </button>
            <button
              onClick={() => setExplorer(!explorer)}
              data-topbar-item="explorer"
              className={`btn-ghost h-10 w-10 p-0 sm:h-auto sm:w-auto sm:py-1 sm:px-2 shrink-0 ${explorer ? "bg-surface-3 text-content" : ""}`}
              title={t("session.explorerTitle")}
              aria-label={t("files.explorer")}
              aria-pressed={explorer}
            >
              <Icon name="files" size={14} />
              <span className={labels}>{t("files.explorer")}</span>
            </button>
            <button
              onClick={togglePanel}
              data-topbar-item="panel"
              className={`btn-ghost hidden sm:inline-flex py-1 px-2 shrink-0 ${panel ? "bg-surface-3 text-content" : ""}`}
              title={t("session.panelTitle")}
              aria-label={t("session.sessionPanel")}
              aria-pressed={panel}
            >
              <Icon name="sliders" size={14} />
              <span className={labels}>{t("session.panel")}</span>
            </button>
            <button
              data-more-toggle
              data-topbar-item="more"
              onClick={() => setMore((v) => !v)}
              className={`btn-ghost sm:hidden h-10 w-10 p-0 shrink-0 ${more ? "bg-surface-3 text-content" : ""}`}
              aria-label={t("session.more")}
              title={t("session.moreTitle")}
            >
              <Icon name="more" size={18} />
            </button>
          </div>
        </div>
        {more && (
          <MoreMenu
            onClose={() => setMore(false)}
            items={[
              {
                icon: runningTasks ? "spinner" : "activity",
                spin: runningTasks > 0,
                label: t("tasks.title"),
                badge: runningTasks ? String(runningTasks) : undefined,
                onClick: () => setShowTasks(true),
              },
              { icon: "cpu", label: t("session.accountUsage"), onClick: () => setShowUsage(true) },
              { icon: "sliders", label: t("session.sessionPanel"), onClick: () => !panel && togglePanel() },
            ]}
          />
        )}
        </div>
      )}
      {active && tabs.length > 0 && <TabBar sid={active.id} />}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessageList />
        {active && <InputBar key={active.id} onSend={send} onSteer={steer} onStop={stop} session={active} />}
        {active &&
          tabs
            .filter((t) => t.id === activeTab || visited.has(`${active.id}:${t.id}`))
            .map((t) => (
              <div
                key={`${active.id}:${t.id}`}
                className={`absolute inset-0 z-20 bg-bg ${t.id === activeTab ? "" : "invisible pointer-events-none"}`}
              >
                <Suspense fallback={null}>
                  <FileViewer session={active} tab={t} />
                </Suspense>
              </div>
            ))}
      </div>
      {showUsage && active && <UsageModal provider={active.provider} onClose={() => setShowUsage(false)} />}
      {showTasks && active && <TasksPanel sid={active.id} onClose={() => setShowTasks(false)} />}
    </div>
    {active && <RightSidebar key={active.id} session={active} />}
    <Toast />
    </div>
  );
}
