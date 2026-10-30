import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useChatSocket } from "../../hooks/useChatSocket";
import MessageList from "./MessageList";
import InputBar, { filesFromClipboard } from "./InputBar";
import { useComposerStore } from "../../stores/composerStore";
import NewSessionPanel from "./NewSessionPanel";
import UsageModal from "../usage/UsageModal";
import GitContext from "./GitContext";
import Icon from "../ui/Icon";

export default function ChatView() {
  const activeId = useSessionStore((s) => s.activeId);
  const sessions = useSessionStore((s) => s.sessions);
  const active = sessions.find((s) => s.id === activeId) || null;
  const { send } = useChatSocket(activeId);
  const [showUsage, setShowUsage] = useState(false);
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
    <div
      className="relative h-full flex flex-col"
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
        <div className="flex items-center gap-2 px-5 h-14 border-b border-border/70 bg-surface/40 backdrop-blur-sm">
          <Icon
            name={active.connection_id ? "server" : "cpu"}
            size={16}
            className={active.connection_id ? "text-cyan" : "text-accent"}
          />
          <span className="text-sm font-medium text-content truncate max-w-[40%]">{active.title}</span>
          <span className="pill bg-surface-3 text-content-dim">{active.provider}</span>
          {active.model && <span className="pill bg-surface-3 text-content-dim">{active.model}</span>}
          <div className="ml-auto flex items-center gap-2.5 min-w-0">
            <GitContext path={active.workspace_path} connectionId={active.connection_id} />
            <span className="text-[11px] text-content-faint font-mono truncate max-w-[200px]">
              {active.connection_id ? "remote" : "local"} · {active.workspace_path}
            </span>
            <button
              onClick={() => setShowUsage(true)}
              className="btn-ghost py-1 px-2 shrink-0"
              title="Account & usage"
            >
              <Icon name="cpu" size={14} /> Usage
            </button>
          </div>
        </div>
      )}
      <MessageList />
      <InputBar onSend={send} session={active} />
      {showUsage && active && <UsageModal provider={active.provider} onClose={() => setShowUsage(false)} />}
    </div>
  );
}
