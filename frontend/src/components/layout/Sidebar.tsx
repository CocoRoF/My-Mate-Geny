import { useSessionStore } from "../../stores/sessionStore";
import { useUIStore } from "../../stores/uiStore";
import { useChatStore } from "../../stores/chatStore";
import { getHistory } from "../../api/sessions";

export default function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setActive = useSessionStore((s) => s.setActive);
  const remove = useSessionStore((s) => s.remove);
  const setView = useUIStore((s) => s.setView);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const reset = useChatStore((s) => s.reset);

  const open = async (id: string) => {
    setActive(id);
    setView("chat");
    reset();
    const h = await getHistory(id);
    loadHistory(h.messages);
  };

  return (
    <aside className="w-64 shrink-0 border-r border-border bg-panel flex flex-col">
      <div className="p-3">
        <button
          onClick={() => {
            setActive(null);
            reset();
            setView("chat");
          }}
          className="w-full py-2 rounded bg-accent/20 text-accent text-sm hover:bg-accent/30"
        >
          + New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 space-y-1">
        {sessions.length === 0 && (
          <p className="px-2 text-xs text-gray-500">No sessions yet.</p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`group flex items-center gap-2 px-2 py-2 rounded cursor-pointer text-sm ${
              activeId === s.id ? "bg-white/5" : "hover:bg-white/5"
            }`}
            onClick={() => open(s.id)}
          >
            <span className="truncate flex-1">{s.title}</span>
            <span className="text-[10px] px-1 rounded bg-black/40 text-gray-400">
              {s.provider}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                remove(s.id);
              }}
              className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
