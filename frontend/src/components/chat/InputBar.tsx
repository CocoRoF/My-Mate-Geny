import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import { nameClipboardFiles, useComposerStore } from "../../stores/composerStore";
import type { Attachment, Session } from "../../types";
import ChatControls from "./ChatControls";
import AttachmentTray from "../attachments/AttachmentTray";
import Icon from "../ui/Icon";

/** Files on a paste event. Office apps put an image AND tab/newline text on the
 * clipboard for copied cells — that's a text paste, not an attachment. */
export function filesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files = Array.from(dt.files || []);
  const fromItems = Array.from(dt.items || [])
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
  const all = files.length ? files : fromItems;
  if (!all.length) return [];
  const text = dt.getData("text/plain");
  if (text && /[\t\n]/.test(text.trim())) return [];
  return nameClipboardFiles(all);
}

function AttachMenu({ onPick, onClose }: { onPick: (kind: "photo" | "file") => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", h);
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-60 overflow-hidden rounded-xl border border-border bg-surface-2 shadow-float animate-fade-in"
    >
      <button onClick={() => onPick("photo")} className="flex w-full items-center gap-3 px-3 py-2.5 text-[13px] text-content hover:bg-surface-3">
        <span className="grid place-items-center w-7 h-7 rounded-lg bg-violet/12 text-violet">
          <Icon name="image" size={15} />
        </span>
        <span className="text-left">
          <span className="block font-medium">Photos</span>
          <span className="block text-[11px] text-content-faint">PNG, JPG, GIF, WebP…</span>
        </span>
      </button>
      <button onClick={() => onPick("file")} className="flex w-full items-center gap-3 px-3 py-2.5 text-[13px] text-content hover:bg-surface-3">
        <span className="grid place-items-center w-7 h-7 rounded-lg bg-accent/12 text-accent">
          <Icon name="paperclip" size={15} />
        </span>
        <span className="text-left">
          <span className="block font-medium">Files</span>
          <span className="block text-[11px] text-content-faint">PDF, code, docs, archives…</span>
        </span>
      </button>
      <div className="border-t border-border/70 px-3 py-2 text-[11px] text-content-faint">
        You can also paste (Ctrl/⌘+V) or drag & drop.
      </div>
    </div>
  );
}

export default function InputBar({
  onSend,
  session,
}: {
  onSend: (text: string, attachments: Attachment[]) => boolean;
  session?: Session | null;
}) {
  const [input, setInput] = useState("");
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const cost = useChatStore((s) => s.runningCostUsd);
  const allItems = useComposerStore((s) => s.items);
  const add = useComposerStore((s) => s.add);
  const clearSent = useComposerStore((s) => s.clearSent);

  const sid = session?.id || null;
  const items = useMemo(() => allItems.filter((i) => i.sessionId === sid), [allItems, sid]);
  const uploading = items.some((i) => i.status === "uploading");
  const ready = items.filter((i) => i.status === "done" && i.attachment);
  const failed = items.filter((i) => i.status === "error").length;
  const canSend = !!sid && !isStreaming && !uploading && (!!input.trim() || ready.length > 0);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  };

  const addFiles = (files: File[]) => {
    if (!sid || !files.length) return;
    add(sid, files);
    setNotice("");
    taRef.current?.focus();
  };

  const submit = () => {
    if (!canSend) {
      if (uploading) setNotice("Waiting for uploads to finish…");
      return;
    }
    const ok = onSend(input.trim(), ready.map((i) => i.attachment!));
    if (!ok) {
      setNotice("Connection lost — reconnecting. Your message was kept.");
      return;
    }
    setInput("");
    setNotice("");
    if (sid) clearSent(sid);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  };

  const pick = (kind: "photo" | "file") => {
    setMenu(false);
    (kind === "photo" ? photoRef : fileRef).current?.click();
  };

  return (
    <div className="px-3 sm:px-5 pb-4 sm:pb-5">
      <div className="mx-auto max-w-3xl">
        {session && (
          <div className="pb-2">
            <ChatControls session={session} />
          </div>
        )}
        <div className="rounded-2xl border border-border bg-surface-2/80 shadow-card backdrop-blur-sm focus-within:border-accent/50 transition">
          <AttachmentTray items={items} />
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              grow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              const files = filesFromClipboard(e.clipboardData);
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            rows={1}
            placeholder={items.length ? "Add a message (optional)…" : "Message the agent…"}
            className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-content placeholder:text-content-faint outline-none max-h-[240px]"
          />
          <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
            <div className="relative">
              <button
                onClick={() => setMenu((v) => !v)}
                disabled={!sid}
                className={`grid place-items-center w-8 h-8 rounded-lg transition ${
                  menu ? "bg-accent-soft text-accent" : "text-content-dim hover:text-content hover:bg-surface-3"
                }`}
                title="Attach photos or files"
              >
                <Icon name="plus" size={18} />
              </button>
              {menu && <AttachMenu onPick={pick} onClose={() => setMenu(false)} />}
            </div>
            {items.length > 0 && (
              <span className="text-[11px] text-content-faint">
                {items.length} attached
                {uploading && " · uploading…"}
                {failed > 0 && <span className="text-danger"> · {failed} failed</span>}
              </span>
            )}
            <button
              onClick={submit}
              disabled={!canSend}
              className="ml-auto grid place-items-center w-9 h-9 rounded-xl text-white transition disabled:opacity-30"
              style={{ background: "linear-gradient(135deg,#6e8bff,#5b7cff)" }}
              title={uploading ? "Waiting for uploads…" : "Send (Enter)"}
            >
              {isStreaming || uploading ? <Icon name="spinner" size={16} spin /> : <Icon name="arrow-up" size={17} />}
            </button>
          </div>
          <input
            ref={photoRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-3 px-1.5 pt-1.5 text-[10px] text-content-faint">
          <span className="truncate">
            {notice ? (
              <span className="text-warning">{notice}</span>
            ) : isStreaming ? (
              <span className="inline-flex items-center gap-1.5 text-accent">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" /> working…
              </span>
            ) : (
              "Enter to send · Shift+Enter for newline · paste or drop files to attach"
            )}
          </span>
          <span className="font-mono shrink-0">session cost ${cost.toFixed(4)}</span>
        </div>
      </div>
    </div>
  );
}
