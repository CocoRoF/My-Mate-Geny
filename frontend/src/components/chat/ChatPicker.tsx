/**
 * + → 다른 세션의 대화: which chat to keep beside this one (components/chat/LinkedChat.tsx) — the most recently active first,
 * found by its name or folder.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "../../lib/back";
import { useSessionStore } from "../../stores/sessionStore";
import { useT } from "../../i18n";
import { relTime } from "../../i18n/format";
import Icon from "../ui/Icon";

const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export default function ChatPicker({ current, onPick, onClose }: { current: string; onPick: (sid: string) => void; onClose: () => void }) {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useBackHandler(true, onClose);
  useEffect(() => {
    input.current?.focus();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions
      .filter((s) => s.id !== current)
      .filter((s) => !needle || (s.title || "").toLowerCase().includes(needle) || (s.workspace_path || "").toLowerCase().includes(needle))
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
      .slice(0, 80);
  }, [sessions, current, q]);
  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-start justify-center bg-black/40 px-3 pt-[12vh] animate-fade-in" onMouseDown={onClose} data-testid="chat-picker">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-surface shadow-float" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t("chat.linkPickTitle")}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Icon name="search" size={14} className="text-content-faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("chat.linkPickSearch")}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-content-faint"
            data-testid="chat-picker-search"
          />
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg text-content-faint hover:bg-surface-3" aria-label={t("common.close")}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="max-h-[56vh] overflow-y-auto py-1">
          {!rows.length && <div className="px-4 py-6 text-center text-[12.5px] text-content-faint">{t("chat.linkPickNone")}</div>}
          {rows.map((s) => (
            <button
              key={s.id}
              onClick={() => onPick(s.id)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2"
              data-testid="chat-picker-row"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${s.running ? "bg-accent animate-pulse-dot" : "bg-border-strong"}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-content">{s.title || t("chat.linkedUntitled")}</span>
                <span className="block truncate text-[11px] text-content-faint">{base(s.workspace_path || "")}</span>
              </span>
              <span className="shrink-0 text-[11px] text-content-faint">{s.updated_at ? relTime(s.updated_at) : ""}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
