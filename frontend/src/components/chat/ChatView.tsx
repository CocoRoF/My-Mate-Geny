import { useSessionStore } from "../../stores/sessionStore";
import { useChatSocket } from "../../hooks/useChatSocket";
import MessageList from "./MessageList";
import InputBar from "./InputBar";
import NewSessionPanel from "./NewSessionPanel";

export default function ChatView() {
  const activeId = useSessionStore((s) => s.activeId);
  const sessions = useSessionStore((s) => s.sessions);
  const active = sessions.find((s) => s.id === activeId) || null;
  const { send } = useChatSocket(activeId);

  if (!activeId) return <NewSessionPanel />;

  return (
    <div className="h-full flex flex-col">
      {active && (
        <div className="px-4 py-2 border-b border-border text-xs text-gray-400 flex gap-3">
          <span className="text-gray-200">{active.title}</span>
          <span className="px-1.5 rounded bg-black/40">{active.provider}</span>
          {active.model && <span>{active.model}</span>}
          <span className="font-mono truncate">
            {active.connection_id ? "🌐 " : "💻 "}
            {active.workspace_path}
          </span>
        </div>
      )}
      <MessageList />
      <InputBar onSend={send} />
    </div>
  );
}
