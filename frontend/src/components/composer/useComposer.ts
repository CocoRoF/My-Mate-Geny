/**
 * The composer's brain, shared by the Chat view's InputBar and the Mate composer (they differ only in chrome):
 *
 * - text, attached files and queued messages belong to the conversation (draftStore / composerStore, keyed by its
 *   session id): switching views or reloading keeps them;
 * - files: the + menu pickers (Photos, Camera on touch screens, Files), paste (Ctrl/⌘+V, named like `pasted-<stamp>.png`), drops — each uploads at once;
 * - sending: idle → a new turn; while a turn runs Enter steers it ("Add now"), Queue holds it for after the turn;
 *   a steer the turn could no longer take comes back (bounced) and is queued; queued messages go one per turn end;
 * - keys: Enter sends on a desktop, Shift+Enter is a newline; on touch screens Enter is a newline (lib/device.ts)
 *   and Ctrl/⌘+Enter sends; the Enter that commits an IME composition is never a send; Escape stops the turn;
 * - `/` commands (and `@` file mentions where the conversation has a workspace) through ComposerMenu;
 * - auto-grow of the text field.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTouchFirst } from "../../lib/device";
import type { ChatStoreApi } from "../../stores/chatStore";
import { useComposerStore } from "../../stores/composerStore";
import { useDraftStore, type QueuedMessage } from "../../stores/draftStore";
import type { Attachment } from "../../types";
import { triggerAt, type MenuItem } from "../chat/ComposerMenu";
import type { PickKind } from "./ComposerParts";
import { filesFromClipboard } from "./files";

export type ComposerAction = NonNullable<MenuItem["action"]>;

export interface ComposerOptions {
  /** the conversation's session id: drafts, queue and uploads are keyed by it */
  sid: string;
  /** its live conversation store (streaming state, connection, bounced steers) */
  store: ChatStoreApi;
  onSend: (text: string, attachments: Attachment[]) => boolean;
  onSteer: (text: string, attachments: Attachment[]) => boolean;
  onStop: () => void;
  /** `/name` typed alone (or picked in the menu) runs one of these; returns a notice to show */
  actions?: readonly ComposerAction[];
  runAction?: (action: ComposerAction) => Promise<string | void> | string | void;
  /** the `/` menu is offered (the menu's items come from the caller) */
  slash?: boolean;
  /** `@path` mentions are offered (a conversation with a workspace) */
  mentions?: boolean;
  /** Enter sends (default: on a desktop, not on touch screens) */
  enterSends?: boolean;
  /** auto-grow cap in px (also ≤ 40 % of the window) */
  maxHeight?: number;
  /** after a message went out (sent, steered or queued) */
  onSent?: () => void;
  /** Escape stops the running turn (default true) */
  escapeStops?: boolean;
}

const NO_QUEUE: QueuedMessage[] = [];

export function useComposer(o: ComposerOptions) {
  const { sid, store, onSend, onSteer, onStop } = o;
  const input = useDraftStore((s) => s.drafts[sid]?.text ?? "");
  const queue = useDraftStore((s) => s.queues[sid] ?? NO_QUEUE);
  const setInput = useCallback(
    (v: string | ((prev: string) => string)) => {
      const st = useDraftStore.getState();
      st.setText(sid, typeof v === "function" ? v(st.drafts[sid]?.text ?? "") : v);
    },
    [sid],
  );
  const setQueue = useCallback(
    (v: QueuedMessage[] | ((prev: QueuedMessage[]) => QueuedMessage[])) => {
      const st = useDraftStore.getState();
      st.setQueue(sid, typeof v === "function" ? v(st.queues[sid] ?? NO_QUEUE) : v);
    },
    [sid],
  );
  const [attachOpen, setAttachOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [caret, setCaret] = useState(0);
  const [menuClosedFor, setMenuClosedFor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const touch = useTouchFirst();
  const sendsOnEnter = o.enterSends ?? !touch;
  const maxHeight = o.maxHeight ?? 240;

  const isStreaming = store((s) => s.isStreaming);
  const connection = store((s) => s.connection);
  const bounced = store((s) => s.bounced);
  const allItems = useComposerStore((s) => s.items);
  const add = useComposerStore((s) => s.add);
  const clearSent = useComposerStore((s) => s.clearSent);

  const items = useMemo(() => allItems.filter((i) => i.sessionId === sid), [allItems, sid]);
  const uploading = items.some((i) => i.status === "uploading");
  const ready = items.filter((i) => i.status === "done" && i.attachment);
  const failed = items.filter((i) => i.status === "error").length;
  const hasContent = !!input.trim() || ready.length > 0;

  const raw = triggerAt(input, caret);
  const trigger = raw && ((raw.kind === "slash" && o.slash) || (raw.kind === "mention" && o.mentions)) ? raw : null;
  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}` : null;
  const menuOpen = !!trigger && triggerKey !== menuClosedFor;
  const closeMenu = useCallback(() => setMenuClosedFor(triggerKey), [triggerKey]);

  useEffect(() => setActiveIndex(0), [trigger?.kind, trigger?.query]);

  const grow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    // a short (keyboard-up) phone screen keeps room for the conversation
    ta.style.height = Math.min(ta.scrollHeight, maxHeight, Math.round(window.innerHeight * 0.4)) + "px";
  }, [maxHeight]);

  // A saved draft is back (or the text changed from elsewhere): size the box to it. The placeholder (which the
  // box's height also follows while it is empty) changes with streaming and attachments.
  useEffect(() => {
    requestAnimationFrame(grow);
  }, [input, grow, isStreaming, items.length]);
  useEffect(() => {
    if (input) setCaret(input.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  const setText = useCallback(
    (text: string, pos?: number) => {
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
    },
    [setInput, grow],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      add(sid, files);
      setNotice("");
      // (a touch screen: no keyboard popping up over the conversation — the tray and ↑ are right there)
      if (!touch) taRef.current?.focus();
    },
    [add, sid, touch],
  );

  const runAction = useCallback(
    async (action: ComposerAction) => {
      setText("");
      try {
        let msg: string | void = "";
        if (o.runAction) msg = await o.runAction(action);
        else if (action === "stop") onStop();
        setNotice(msg || "");
      } catch (e: any) {
        setNotice(String(e?.message || e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setText, onStop, o.runAction],
  );

  const pick = (item: MenuItem) => {
    if (item.action) return void runAction(item.action);
    if (!trigger) return;
    const before = input.slice(0, trigger.start);
    const after = input.slice(caret);
    const next = before + item.insert + after;
    setText(next, (before + item.insert).length);
    if (!item.keepOpen) setMenuClosedFor(`${trigger.kind}:${trigger.start}`);
  };

  const enqueue = useCallback(
    (text: string, atts: Attachment[]) => setQueue((q) => [...q, { id: `q${Date.now()}${q.length}`, text, attachments: atts }]),
    [setQueue],
  );

  // While a turn runs, Enter steers it (Claude Code style); "Queue" holds the message until the turn is done.
  const dispatch = (text: string, atts: Attachment[], how: "auto" | "queue" = "auto") => {
    if (store.getState().isStreaming) {
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
    store
      .getState()
      .takeBounced()
      .forEach((b) => enqueue(b.text, b.attachments));
    setNotice("The turn was finishing — your message will be sent as the next one.");
  }, [bounced, store, enqueue]);

  /** send what is in the box (or `spoken`, e.g. a voice transcript) with the ready files */
  const submit = (how: "auto" | "queue" = "auto", spoken?: string): boolean => {
    const text = (spoken ?? input).trim();
    const builtin = spoken === undefined ? /^\/([\w-]+)$/.exec(text) : null;
    if (builtin && o.actions?.includes(builtin[1] as ComposerAction)) {
      void runAction(builtin[1] as ComposerAction);
      return true;
    }
    if (uploading) {
      if (spoken) setInput((v) => (v ? `${v} ${spoken}` : spoken));
      setNotice("Waiting for uploads to finish…");
      return false;
    }
    if (!text && !ready.length) return false;
    if (!dispatch(text, ready.map((i) => i.attachment!), how)) {
      if (spoken) setInput((v) => (v ? `${v} ${spoken}` : spoken));
      setNotice("Not connected — reconnecting. Your message was kept.");
      return false;
    }
    if (spoken === undefined) setInput("");
    setNotice("");
    clearSent(sid);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
    o.onSent?.();
    return true;
  };

  // Deliver queued messages one at a time as each turn finishes.
  useEffect(() => {
    if (isStreaming || !queue.length || connection !== "open") return;
    const [next, ...rest] = queue;
    if (onSend(next.text, next.attachments)) setQueue(rest);
  }, [isStreaming, queue, connection, onSend, setQueue]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME (Korean, Japanese…): the Enter that commits the composition is not a send.
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    const enter = e.key === "Enter" && !e.shiftKey && !composing;
    if (menuOpen && menuItems.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        return setActiveIndex((activeIndex + 1) % menuItems.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        return setActiveIndex((activeIndex - 1 + menuItems.length) % menuItems.length);
      }
      if (e.key === "Tab" || (enter && sendsOnEnter)) {
        e.preventDefault();
        return pick(menuItems[Math.min(activeIndex, menuItems.length - 1)]);
      }
    }
    if (menuOpen && e.key === "Escape") {
      e.preventDefault();
      return setMenuClosedFor(triggerKey);
    }
    if (e.key === "Escape" && o.escapeStops !== false && store.getState().isStreaming) {
      e.preventDefault();
      return onStop();
    }
    // Desktop: Enter sends, Shift+Enter is a newline. Touch: Enter is a newline.
    // Ctrl/⌘+Enter sends on both (a tablet with a hardware keyboard).
    if (enter && (sendsOnEnter || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  const pickFile = (kind: PickKind) => {
    setAttachOpen(false);
    (kind === "photo" ? photoRef : kind === "camera" ? cameraRef : fileRef).current?.click();
  };

  /** spread on the <textarea> */
  const textareaProps = {
    ref: taRef,
    value: input,
    rows: 1,
    enterKeyHint: (sendsOnEnter ? "send" : "enter") as "send" | "enter",
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      setCaret(e.target.selectionStart);
      setMenuClosedFor(null);
      grow();
    },
    onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => setCaret((e.target as HTMLTextAreaElement).selectionStart),
    onKeyDown,
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = filesFromClipboard(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    },
  };

  return {
    sid,
    input,
    setInput,
    setText,
    taRef,
    photoRef,
    cameraRef,
    fileRef,
    items,
    ready,
    uploading,
    failed,
    hasContent,
    notice,
    setNotice,
    queue,
    unqueue: (id: string) => setQueue((all) => all.filter((x) => x.id !== id)),
    isStreaming,
    connection,
    touch,
    sendsOnEnter,
    trigger,
    menuOpen,
    closeMenu,
    activeIndex,
    setActiveIndex,
    setMenuItems,
    pick,
    submit,
    addFiles,
    attachOpen,
    setAttachOpen,
    pickFile,
    runAction,
    textareaProps,
  };
}

export type Composer = ReturnType<typeof useComposer>;
