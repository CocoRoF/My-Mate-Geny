import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import MessageItem from "./MessageItem";
import Icon from "../ui/Icon";

const NEAR_BOTTOM = 120;

export default function MessageList() {
  const turns = useChatStore((s) => s.turns);
  const connection = useChatStore((s) => s.connection);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow new output only while the reader is at the bottom
  const [showJump, setShowJump] = useState(false);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    stick.current = atBottom;
    setShowJump(!atBottom);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // A freshly opened session starts at the latest message.
  const first = turns[0]?.key;
  useEffect(() => {
    stick.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [first]);

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 sm:px-5 py-6 space-y-6">
          {turns.length === 0 && (
            <div className="grid place-items-center pt-24 text-center">
              <div className="grid place-items-center w-12 h-12 rounded-xl bg-surface-2 border border-border mb-3">
                <Icon name="chat" size={22} className="text-content-faint" />
              </div>
              <p className="text-sm text-content-dim">
                {connection === "open" ? "Send a message to start working in this workspace." : "Loading…"}
              </p>
            </div>
          )}
          {turns.map((t) => (
            <MessageItem key={t.key} turn={t} />
          ))}
        </div>
      </div>
      {connection === "reconnecting" && (
        <div className="absolute left-1/2 top-3 -translate-x-1/2 inline-flex items-center gap-2 rounded-full border border-warning/30 bg-surface-2 px-3 py-1 text-[11.5px] text-warning shadow-float">
          <Icon name="spinner" size={12} spin /> Reconnecting — the agent keeps working
        </div>
      )}
      {showJump && (
        <button
          onClick={jump}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-[12px] text-content-dim shadow-float hover:text-content transition animate-fade-in"
        >
          <Icon name="arrow-up" size={13} className="rotate-180" /> Latest
        </button>
      )}
    </div>
  );
}
