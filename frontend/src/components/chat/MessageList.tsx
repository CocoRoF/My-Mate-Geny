import { useEffect, useRef } from "react";
import { useChatStore } from "../../stores/chatStore";
import MessageItem from "./MessageItem";

export default function MessageList() {
  const turns = useChatStore((s) => s.turns);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {turns.length === 0 && (
        <p className="text-center text-sm text-gray-500 mt-10">
          Send a message to start working in this workspace.
        </p>
      )}
      {turns.map((t, i) => (
        <MessageItem key={i} turn={t} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
