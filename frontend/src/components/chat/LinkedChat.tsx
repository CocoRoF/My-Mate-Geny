/**
 * Another chat above this one's message box (+ → 다른 세션의 대화): its conversation from the latest turn — scroll up for the
 * earlier ones —, live as it goes on; its name opens it; ✕ takes it away. Read-only: nothing is sent to it from here
 * (hooks/useLinkedChat.ts keeps it in a chat store of its own).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLinkedChat } from "../../hooks/useLinkedChat";
import { useLinkedChats } from "../../stores/linkedChatStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUIStore } from "../../stores/uiStore";
import type { Turn } from "../../stores/chatStore";
import { useT } from "../../i18n";
import { relTime } from "../../i18n/format";
import Icon from "../ui/Icon";
import Markdown from "../ui/Markdown";

function TurnLine({ turn }: { turn: Turn }) {
  const t = useT();
  if (turn.role === "system") return null;
  if (turn.role === "user") {
    if (turn.meta?.hidden) return null;
    const files = turn.attachments?.length ?? 0;
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-accent-soft px-2.5 py-1.5 text-[12.5px] text-content line-clamp-6">
          {turn.text || (files ? t("chat.linkedFiles", { count: files }) : "")}
          {turn.text && files > 0 && <span className="ml-1 text-content-faint">· {t("chat.linkedFiles", { count: files })}</span>}
        </div>
      </div>
    );
  }
  const tools = turn.tools.length;
  return (
    <div className="min-w-0 text-[12.5px] leading-relaxed text-content [&_pre]:max-h-48 [&_pre]:overflow-auto">
      {turn.text ? <Markdown>{turn.text}</Markdown> : null}
      {(tools > 0 || turn.status === "running" || turn.status === "error") && (
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-content-faint">
          {turn.status === "running" && <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-dot" />}
          {tools > 0 && t("chat.linkedTools", { count: tools })}
          {turn.status === "error" && <span className="text-danger">{turn.error?.message || t("chat.linkedFailed")}</span>}
        </div>
      )}
    </div>
  );
}

export default function LinkedChat({ sid, other }: { sid: string; other: string }) {
  const t = useT();
  const { store, error } = useLinkedChat(other);
  const turns = store((s) => s.turns);
  const paging = store((s) => s.paging);
  const streaming = store((s) => s.isStreaming);
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === other));
  const unlink = useLinkedChats((s) => s.unlink);
  const [open, setOpen] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);

  // (the latest turn in view, and kept there as it grows — unless they scrolled up to read)
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [turns, open]);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (el.scrollTop < 40 && paging.hasMore && !paging.loading) {
      const before = el.scrollHeight;
      void store.getState().loadOlder(() => {
        requestAnimationFrame(() => {
          if (box.current) box.current.scrollTop += box.current.scrollHeight - before;
        });
      });
    }
  };
  useEffect(() => {
    atEnd.current = true;
  }, [other]);

  const openIt = () => {
    useSessionStore.getState().setActive(other);
    useUIStore.getState().setView("chat");
  };
  const title = session?.title || t("chat.linkedUntitled");
  const shown = turns.filter((x) => x.role !== "system");
  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-border bg-surface-2/70 animate-fade-in" data-testid="linked-chat" data-linked={other}>
      <div className="flex items-center gap-1.5 border-b border-border/70 px-2.5 py-1.5">
        <Icon name="chats" size={13} className="shrink-0 text-accent" />
        <button onClick={openIt} className="min-w-0 truncate text-left text-[12.5px] font-medium text-content hover:underline" title={t("chat.linkedOpen")} data-testid="linked-chat-open">
          {title}
        </button>
        {streaming ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-dot" />
            {t("chat.linkedWorking")}
          </span>
        ) : session?.updated_at ? (
          <span className="shrink-0 text-[11px] text-content-faint">{relTime(session.updated_at)}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center">
          <button onClick={() => setOpen((v) => !v)} className="grid h-7 w-7 place-items-center rounded-lg text-content-faint hover:bg-surface-3 hover:text-content" aria-expanded={open} title={open ? t("chat.linkedFold") : t("chat.linkedUnfold")}>
            <Icon name="chevron-down" size={14} className={open ? "" : "-rotate-90"} />
          </button>
          <button onClick={() => unlink(sid)} className="grid h-7 w-7 place-items-center rounded-lg text-content-faint hover:bg-surface-3 hover:text-content" aria-label={t("chat.linkedClose")} title={t("chat.linkedClose")} data-testid="linked-chat-close">
            <Icon name="x" size={14} />
          </button>
        </span>
      </div>
      {open && (
        <div ref={box} onScroll={onScroll} className="max-h-[min(38vh,320px)] space-y-2.5 overflow-y-auto px-3 py-2.5" data-testid="linked-chat-body">
          {paging.hasMore && (
            <div className="text-center text-[11px] text-content-faint">{paging.loading ? t("common.loading") : t("chat.linkedOlder")}</div>
          )}
          {error && !shown.length ? <div className="text-[12px] text-danger">{error}</div> : null}
          {!error && !shown.length ? <div className="text-[12px] text-content-faint">{t("chat.linkedEmpty")}</div> : null}
          {shown.map((x) => (
            <TurnLine key={x.key} turn={x} />
          ))}
        </div>
      )}
    </div>
  );
}
