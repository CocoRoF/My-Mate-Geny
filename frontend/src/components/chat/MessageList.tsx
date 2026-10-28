import { useEffect, useRef } from "react";
import { useChatStore } from "../../stores/chatStore";
import MessageItem from "./MessageItem";
import Icon from "../ui/Icon";

export default function MessageList() {
  const turns = useChatStore((s) => s.turns);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-6 space-y-5">
        {turns.length === 0 && (
          <div className="grid place-items-center pt-24 text-center">
            <div className="grid place-items-center w-12 h-12 rounded-xl bg-surface-2 border border-border mb-3">
              <Icon name="chat" size={22} className="text-content-faint" />
            </div>
            <p className="text-sm text-content-dim">Send a message to start working in this workspace.</p>
          </div>
        )}
        {turns.map((t, i) => (
          <MessageItem key={i} turn={t} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
