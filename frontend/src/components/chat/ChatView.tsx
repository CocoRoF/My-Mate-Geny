import { useSessionStore } from "../../stores/sessionStore";
import { useChatSocket } from "../../hooks/useChatSocket";
import MessageList from "./MessageList";
import InputBar from "./InputBar";
import NewSessionPanel from "./NewSessionPanel";
import Icon from "../ui/Icon";

export default function ChatView() {
  const activeId = useSessionStore((s) => s.activeId);
  const sessions = useSessionStore((s) => s.sessions);
  const active = sessions.find((s) => s.id === activeId) || null;
  const { send } = useChatSocket(activeId);

  if (!activeId) return <NewSessionPanel />;

  return (
    <div className="h-full flex flex-col">
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
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-content-faint font-mono truncate">
            {active.connection_id ? "remote" : "local"} · {active.workspace_path}
          </span>
        </div>
      )}
      <MessageList />
      <InputBar onSend={send} session={active} />
    </div>
  );
}
