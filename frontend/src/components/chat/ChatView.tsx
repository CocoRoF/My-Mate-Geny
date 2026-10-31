import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { stopTurn } from "../../api/sessions";
import SessionPanel from "./panel/SessionPanel";
import { MenuButton } from "../layout/MobileTopBar";
import { useBackHandler } from "../../lib/back";
import TasksPanel from "../tasks/TasksPanel";
import { isRunning, useTaskStore } from "../../stores/taskStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useChatSocket } from "../../hooks/useChatSocket";
import MessageList from "./MessageList";
import InputBar, { filesFromClipboard } from "./InputBar";
import { useComposerStore } from "../../stores/composerStore";
import NewSessionPanel from "./NewSessionPanel";
import UsageModal from "../usage/UsageModal";
import Icon from "../ui/Icon";
import ExplorerPanel from "../explorer/ExplorerPanel";
import TabBar from "../viewer/TabBar";
import { useChatStore } from "../../stores/chatStore";
import { useSessionTabs, useWorkbench } from "../../stores/workbenchStore";

// Viewers (and their format libraries) load when a file is first opened.
const FileViewer = lazy(() => import("../viewer/FileViewer"));
const WIDE = 1280; // below this the side panels are drawers

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

export default function ChatView() {
  const activeId = useSessionStore((s) => s.activeId);
  const sessions = useSessionStore((s) => s.sessions);
  const active = sessions.find((s) => s.id === activeId) || null;
  const { send, steer, stop: stopWs } = useChatSocket(activeId);
  const [showUsage, setShowUsage] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const runningTasks = useTaskStore((s) => (activeId ? (s.bySession[activeId] || []).filter(isRunning).length : 0));
  const [panel, setPanel] = useState(() => {
    try {
      // one right-side panel at a time: a saved-open explorer wins
      if (useWorkbench.getState().explorerOpen) return false;
      return localStorage.getItem("hrh_session_panel") !== "0" && window.innerWidth >= 1100;
    } catch {
      return false;
    }
  });
  const togglePanel = () =>
    setPanel((v) => {
      try {
        localStorage.setItem("hrh_session_panel", v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  const explorer = useWorkbench((s) => s.explorerOpen);
  const setExplorer = useWorkbench((s) => s.setExplorer);
  const { tabs, active: activeTab } = useSessionTabs(activeId);
  const activate = useWorkbench((s) => s.activate);
  // A side panel takes width: the workspace path in the header waits for a very wide screen.
  const compact = explorer || panel;
  // Narrow screens open on the chat: a drawer left open last time stays closed.
  useEffect(() => {
    if (window.innerWidth < WIDE) setExplorer(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The explorer and the session panel share the right side: one at a time.
  useEffect(() => {
    if (explorer && panel) setPanel(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorer]);
  useEffect(() => {
    if (panel && explorer) setExplorer(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);
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
  const addFiles = useComposerStore((s) => s.add);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // Ctrl/⌘+V anywhere in the chat (not just in the textarea) attaches images.
  useEffect(() => {
    if (!activeId) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("textarea, input, [contenteditable=true]") || t.isContentEditable)) return;
      const files = filesFromClipboard(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        addFiles(activeId, files);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [activeId, addFiles]);

  if (!activeId) return <NewSessionPanel />;

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types || []).includes("Files");

  return (
    <div className="h-full flex">
    <div
      className="relative h-full flex flex-1 min-w-0 flex-col"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(activeId, Array.from(e.dataTransfer.files || []));
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-50 grid place-items-center rounded-2xl border-2 border-dashed border-accent/70 bg-bg/80 backdrop-blur-sm animate-fade-in">
          <div className="text-center">
            <div className="mx-auto mb-3 grid place-items-center w-14 h-14 rounded-2xl bg-accent-soft text-accent">
              <Icon name="upload" size={26} />
            </div>
            <div className="text-base font-semibold text-content">Drop files to attach</div>
            <div className="mt-1 text-xs text-content-faint">Images are shown to the agent · other files are saved for its tools</div>
          </div>
        </div>
      )}
      {active && (
        <div className="pt-safe shrink-0 border-b border-border/70 bg-surface/40 backdrop-blur-sm">
        <div className="flex items-center gap-2 px-3 sm:px-5 h-12 md:h-14">
          <MenuButton />
          <Icon
            name={active.connection_id ? "server" : "cpu"}
            size={16}
            className={`shrink-0 ${active.connection_id ? "text-cyan" : "text-accent"}`}
          />
          <span className="text-[14px] md:text-sm font-medium text-content truncate min-w-0">{active.title}</span>
          <span className="pill bg-surface-3 text-content-dim shrink-0 hidden sm:inline-flex">{active.provider}</span>
          {active.mode === "plan" && <span className="pill bg-violet/15 text-violet shrink-0">plan</span>}
          <div className="ml-auto flex items-center gap-2 min-w-0 shrink-0">
            <button
              onClick={() => setExplorer(true)}
              className={`${compact ? "hidden 2xl:inline" : "hidden lg:inline"} text-[11px] text-content-faint font-mono truncate max-w-[220px] hover:text-content`}
              title="Show in explorer"
            >
              {active.connection_id ? "remote" : "local"} · {active.workspace_path}
            </button>
            <button
              onClick={() => setShowTasks(true)}
              className={`btn-ghost py-1 px-2 shrink-0 ${runningTasks ? "text-accent" : ""}`}
              title="Background tasks"
            >
              {runningTasks ? <Icon name="spinner" size={14} spin /> : <Icon name="activity" size={14} />}
              <span className="hidden sm:inline">Tasks</span>
              {runningTasks > 0 && <span className="pill bg-accent-soft text-accent">{runningTasks}</span>}
            </button>
            <button onClick={() => setShowUsage(true)} className="btn-ghost py-1 px-2 shrink-0" title="Account & usage">
              <Icon name="cpu" size={14} /> <span className="hidden sm:inline">Usage</span>
            </button>
            <button
              onClick={() => setExplorer(!explorer)}
              className={`btn-ghost py-1 px-2 shrink-0 ${explorer ? "bg-surface-3 text-content" : ""}`}
              title="Explorer — browse and open the workspace's files"
            >
              <Icon name="files" size={14} />
              <span className="hidden sm:inline">Explorer</span>
            </button>
            <button
              onClick={togglePanel}
              className={`btn-ghost py-1 px-2 shrink-0 ${panel ? "bg-surface-3 text-content" : ""}`}
              title="Session panel — folders, tasks, changes, agent"
            >
              <Icon name="folder" size={14} />
              <span className="hidden sm:inline">Panel</span>
              {(active.extra_dirs?.length || 0) > 0 && (
                <span className="pill bg-accent-soft text-accent">+{active.extra_dirs.length}</span>
              )}
            </button>
          </div>
        </div>
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
    {explorer && active && (
      <>
        <div className="fixed inset-0 z-30 bg-black/45 xl:hidden animate-fade-in" onClick={() => setExplorer(false)} />
        <div className="fixed inset-y-0 right-0 z-40 pt-safe xl:pt-0 bg-surface xl:static xl:z-auto shadow-float xl:shadow-none">
          <ExplorerPanel
            session={active}
            onClose={() => setExplorer(false)}
            onOpened={() => window.innerWidth < WIDE && setExplorer(false)}
          />
        </div>
      </>
    )}
    {panel && active && (
      <>
        <div className="fixed inset-0 z-30 bg-black/45 xl:hidden animate-fade-in" onClick={togglePanel} />
        <div className="fixed inset-y-0 right-0 z-40 pt-safe xl:pt-0 bg-surface xl:static xl:z-auto shadow-float xl:shadow-none">
          <SessionPanel session={active} onClose={togglePanel} />
        </div>
      </>
    )}
    <Toast />
    </div>
  );
}
