import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resetContext } from "../../api/sessions";
import { useChatStore } from "../../stores/chatStore";
import { nameClipboardFiles, useComposerStore } from "../../stores/composerStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useTaskStore } from "../../stores/taskStore";
import type { Attachment, Session } from "../../types";
import AttachmentTray from "../attachments/AttachmentTray";
import Icon from "../ui/Icon";
import ChatControls from "./ChatControls";
import ComposerMenu, { triggerAt, type MenuItem } from "./ComposerMenu";
import { useWorkbench } from "../../stores/workbenchStore";

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

interface Queued {
  id: string;
  text: string;
  attachments: Attachment[];
}

export default function InputBar({
  onSend,
  onSteer,
  onStop,
  session,
}: {
  onSend: (text: string, attachments: Attachment[]) => boolean;
  onSteer: (text: string, attachments: Attachment[]) => boolean;
  onStop: () => void;
  session: Session;
}) {
  const [input, setInput] = useState("");
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState("");
  const [queue, setQueue] = useState<Queued[]>([]);
  const [caret, setCaret] = useState(0);
  const [menuClosedFor, setMenuClosedFor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isStreaming = useChatStore((s) => s.isStreaming);
  const connection = useChatStore((s) => s.connection);
  const cost = useChatStore((s) => s.runningCostUsd);
  const info = useChatStore((s) => s.info);
  const bounced = useChatStore((s) => s.bounced);
  const planUsage = useTaskStore((s) => s.usage);
  const windows = planUsage?.unifiedWindows || {};
  const pct = (w?: { utilization?: number }) => (w?.utilization !== undefined ? `${Math.round(w.utilization * 100)}%` : null);
  const usageLabel =
    session.provider === "claude" && (windows.five_hour || windows.seven_day)
      ? [pct(windows.five_hour) && `5h ${pct(windows.five_hour)}`, pct(windows.seven_day) && `7d ${pct(windows.seven_day)}`]
          .filter(Boolean)
          .join(" · ")
      : null;
  const takeBounced = useChatStore((s) => s.takeBounced);
  const allItems = useComposerStore((s) => s.items);
  const add = useComposerStore((s) => s.add);
  const clearSent = useComposerStore((s) => s.clearSent);
  const updateSession = useSessionStore((s) => s.update);

  const sid = session.id;
  // "Mention in chat" from the explorer appends `@path ` here.
  const insert = useWorkbench((s) => s.insert);
  useEffect(() => {
    if (!insert || insert.sid !== sid) return;
    setInput((v) => (v && !/\s$/.test(v) ? `${v} ` : v) + insert.text);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insert?.n]);
  const items = useMemo(() => allItems.filter((i) => i.sessionId === sid), [allItems, sid]);
  const uploading = items.some((i) => i.status === "uploading");
  const ready = items.filter((i) => i.status === "done" && i.attachment);
  const failed = items.filter((i) => i.status === "error").length;
  const hasContent = !!input.trim() || ready.length > 0;

  const trigger = triggerAt(input, caret);
  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}` : null;
  const menuOpen = !!trigger && triggerKey !== menuClosedFor;

  useEffect(() => setActiveIndex(0), [trigger?.kind, trigger?.query]);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  };

  const setText = (text: string, pos?: number) => {
    setInput(text);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      const p = pos ?? text.length;
      ta.focus();
      ta.setSelectionRange(p, p);
      setCaret(p);
      grow();
    });
  };

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    add(sid, files);
    setNotice("");
    taRef.current?.focus();
  };

  const runAction = useCallback(
    async (action: NonNullable<MenuItem["action"]>) => {
      setText("");
      try {
        if (action === "clear") {
          await resetContext(sid);
          setNotice("Context cleared — the next message starts a fresh agent conversation.");
        } else if (action === "plan" || action === "agent") {
          await updateSession(sid, { mode: action });
          setNotice(action === "plan" ? "Plan mode: read-only, the agent will propose a plan." : "Agent mode: full autonomy.");
        } else if (action === "stop") {
          onStop();
        }
      } catch (e: any) {
        setNotice(String(e.message || e));
      }
    },
    [sid, updateSession, onStop],
  );

  const pick = (item: MenuItem) => {
    if (item.action) return runAction(item.action);
    if (!trigger) return;
    const before = input.slice(0, trigger.start);
    const after = input.slice(caret);
    const next = before + item.insert + after;
    setText(next, (before + item.insert).length);
    if (!item.keepOpen) setMenuClosedFor(`${trigger.kind}:${trigger.start}`);
  };

  const enqueue = (text: string, atts: Attachment[]) =>
    setQueue((q) => [...q, { id: `q${Date.now()}${q.length}`, text, attachments: atts }]);

  // While the agent works, Enter steers the running turn (Claude Code style);
  // "Queue" holds the message until the turn is done.
  const dispatch = (text: string, atts: Attachment[], how: "auto" | "queue" = "auto") => {
    if (isStreaming) {
      if (how === "queue") {
        enqueue(text, atts);
        return true;
      }
      return onSteer(text, atts);
    }
    return onSend(text, atts);
  };

  // A steer the turn could no longer take (it was finishing): send it next.
  useEffect(() => {
    if (!bounced.length) return;
    const items = takeBounced();
    items.forEach((b) => enqueue(b.text, b.attachments));
    setNotice("The turn was finishing — your message will be sent as the next one.");
  }, [bounced, takeBounced]);

  const submit = (how: "auto" | "queue" = "auto") => {
    const text = input.trim();
    const builtin = /^\/(clear|plan|agent|stop)$/.exec(text);
    if (builtin) return runAction(builtin[1] as NonNullable<MenuItem["action"]>);
    if (uploading) return setNotice("Waiting for uploads to finish…");
    if (!hasContent) return;
    if (!dispatch(text, ready.map((i) => i.attachment!), how)) {
      setNotice("Not connected — reconnecting. Your message was kept.");
      return;
    }
    setInput("");
    setNotice("");
    clearSent(sid);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  };

  // Retry from a failed/stopped turn's footer re-sends that message.
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (!isStreaming) onSend(String(d.text || ""), d.attachments || []);
    };
    window.addEventListener("hrh:resend", h);
    return () => window.removeEventListener("hrh:resend", h);
  }, [isStreaming, onSend]);

  // Deliver queued messages one at a time as each turn finishes.
  useEffect(() => {
    if (isStreaming || !queue.length || connection !== "open") return;
    const [next, ...rest] = queue;
    if (onSend(next.text, next.attachments)) setQueue(rest);
  }, [isStreaming, queue, connection, onSend]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && menuItems.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        return setActiveIndex((activeIndex + 1) % menuItems.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        return setActiveIndex((activeIndex - 1 + menuItems.length) % menuItems.length);
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        return pick(menuItems[Math.min(activeIndex, menuItems.length - 1)]);
      }
    }
    if (menuOpen && e.key === "Escape") {
      e.preventDefault();
      return setMenuClosedFor(triggerKey);
    }
    if (e.key === "Escape" && isStreaming) {
      e.preventDefault();
      return onStop();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const pickFile = (kind: "photo" | "file") => {
    setMenu(false);
    (kind === "photo" ? photoRef : fileRef).current?.click();
  };

  return (
    <div className="px-3 sm:px-5 pb-3 sm:pb-5 pb-safe">
      <div className="mx-auto max-w-3xl">
        <div className="pb-2">
          <ChatControls session={session} />
        </div>

        {queue.length > 0 && (
          <div className="mb-2 space-y-1">
            {queue.map((q) => (
              <div key={q.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-1.5 text-[12px]">
                <Icon name="clock" size={12} className="shrink-0 text-content-faint" />
                <span className="text-content-faint shrink-0">Queued</span>
                <span className="truncate text-content-dim">
                  {q.text || `${q.attachments.length} attachment(s)`}
                  {q.text && q.attachments.length ? ` · +${q.attachments.length} file(s)` : ""}
                </span>
                <button
                  onClick={() => setQueue((all) => all.filter((x) => x.id !== q.id))}
                  className="ml-auto shrink-0 text-content-faint hover:text-danger"
                  title="Remove from queue"
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="relative rounded-2xl border border-border bg-surface-2/80 shadow-card backdrop-blur-sm focus-within:border-accent/50 transition">
          {menuOpen && trigger && (
            <ComposerMenu
              trigger={trigger}
              session={session}
              info={info}
              onPick={pick}
              onClose={() => setMenuClosedFor(triggerKey)}
              activeIndex={activeIndex}
              setActiveIndex={setActiveIndex}
              setItems={setMenuItems}
            />
          )}
          <AttachmentTray items={items} />
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setCaret(e.target.selectionStart);
              setMenuClosedFor(null);
              grow();
            }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = filesFromClipboard(e.clipboardData);
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            rows={1}
            placeholder={
              isStreaming
                ? "Add instructions while it works — Enter adds them to this turn…"
                : items.length
                  ? "Add a message (optional)…"
                  : window.innerWidth < 640
                    ? "Message the agent…"
                    : "Message the agent…   / for commands · @ for files"
            }
            className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-content placeholder:text-content-faint outline-none max-h-[240px]"
          />
          <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
            <div className="relative">
              <button
                onClick={() => setMenu((v) => !v)}
                className={`grid place-items-center w-10 h-10 sm:w-8 sm:h-8 rounded-lg transition ${
                  menu ? "bg-accent-soft text-accent" : "text-content-dim hover:text-content hover:bg-surface-3"
                }`}
                title="Attach photos or files"
              >
                <Icon name="plus" size={18} />
              </button>
              {menu && <AttachMenu onPick={pickFile} onClose={() => setMenu(false)} />}
            </div>
            {items.length > 0 && (
              <span className="text-[11px] text-content-faint">
                {items.length} attached
                {uploading && " · uploading…"}
                {failed > 0 && <span className="text-danger"> · {failed} failed</span>}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {isStreaming && hasContent && (
                <>
                  <button
                    onClick={() => submit("queue")}
                    disabled={uploading}
                    className="h-9 rounded-xl border border-border px-3 text-[12px] text-content-dim hover:text-content hover:bg-surface-3 transition disabled:opacity-40"
                    title="Send after the current turn finishes"
                  >
                    Queue
                  </button>
                  <button
                    onClick={() => submit()}
                    disabled={uploading}
                    className="h-9 inline-flex items-center gap-1.5 rounded-xl px-3 text-[12px] font-medium text-white transition disabled:opacity-40"
                    style={{ background: "linear-gradient(135deg,#6e8bff,#5b7cff)" }}
                    title={
                      session.provider === "codex"
                        ? "Add to the running turn now (Enter) — Codex pauses its current step and continues with this"
                        : "Add to the running turn now (Enter) — the agent picks it up at its next step"
                    }
                  >
                    <Icon name="arrow-up" size={14} /> Add now
                  </button>
                </>
              )}
              {isStreaming ? (
                <button
                  onClick={onStop}
                  className="grid place-items-center w-10 h-10 sm:w-9 sm:h-9 rounded-xl bg-content text-bg hover:bg-white transition"
                  title="Stop (Esc)"
                >
                  <span className="block w-3 h-3 rounded-[3px] bg-bg" />
                </button>
              ) : (
                <button
                  onClick={() => submit()}
                  disabled={!hasContent || uploading}
                  className="grid place-items-center w-10 h-10 sm:w-9 sm:h-9 rounded-xl text-white transition disabled:opacity-30"
                  style={{ background: "linear-gradient(135deg,#6e8bff,#5b7cff)" }}
                  title={uploading ? "Waiting for uploads…" : "Send (Enter)"}
                >
                  {uploading ? <Icon name="spinner" size={16} spin /> : <Icon name="arrow-up" size={17} />}
                </button>
              )}
            </div>
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
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" /> working… · Enter adds to this
                turn · Queue sends after · Esc stops · keeps running if you close this tab
              </span>
            ) : (
              <span className="hidden sm:inline">Enter to send · Shift+Enter newline · / commands · @ files · paste or drop files</span>
            )}
          </span>
          <span className="font-mono shrink-0" title="Plan usage reported by the provider on the last turn">
            {usageLabel && <span className="mr-2 text-content-dim">plan {usageLabel}</span>}
            session ${cost.toFixed(4)}
          </span>
        </div>
      </div>
    </div>
  );
}
