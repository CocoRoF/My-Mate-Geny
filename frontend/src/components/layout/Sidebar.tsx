import { useSessionStore } from "../../stores/sessionStore";
import { useUIStore, type View } from "../../stores/uiStore";
import { useProviderStore } from "../../stores/providerStore";
import { useChatStore } from "../../stores/chatStore";
import { getHistory } from "../../api/sessions";
import { apiFetch } from "../../api/client";
import { APP_VERSION } from "../../version";
import Icon from "../ui/Icon";

const NAV: { id: View; label: string; icon: "chat" | "plug" | "server" }[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "providers", label: "Providers", icon: "plug" },
  { id: "connections", label: "Connections", icon: "server" },
];

export default function Sidebar() {
  const view = useUIStore((s) => s.view);
  const setView = useUIStore((s) => s.setView);
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setActive = useSessionStore((s) => s.setActive);
  const remove = useSessionStore((s) => s.remove);
  const providers = useProviderStore((s) => s.providers);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const reset = useChatStore((s) => s.reset);

  const openSession = async (id: string) => {
    setActive(id);
    setView("chat");
    reset();
    const h = await getHistory(id);
    loadHistory(h.messages);
  };

  const newChat = () => {
    setActive(null);
    reset();
    setView("chat");
  };

  const logout = async () => {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  };

  const connectedCount = providers.filter((p) => p.connected).length;

  return (
    <aside className="w-[264px] shrink-0 flex flex-col border-r border-border bg-surface/80 backdrop-blur-xl">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border/70">
        <div className="grid place-items-center w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-cyan shadow-glow">
          <Icon name="bolt" size={17} className="text-white" />
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">
            hr<span className="text-gradient">·</span>harnessor
          </div>
          <div className="text-[10px] text-content-faint">agent console</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="px-2.5 pt-3 space-y-0.5">
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setView(n.id)}
            data-active={view === n.id}
            className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-content-dim transition hover:text-content hover:bg-surface-3 data-[active=true]:bg-surface-3 data-[active=true]:text-content"
          >
            <Icon name={n.icon} size={17} className="text-content-faint group-hover:text-accent group-data-[active=true]:text-accent" />
            {n.label}
            {n.id === "providers" && connectedCount > 0 && (
              <span className="ml-auto pill bg-success/15 text-success">{connectedCount}</span>
            )}
          </button>
        ))}
      </nav>

      {/* New chat */}
      <div className="px-2.5 pt-3 pb-2">
        <button onClick={newChat} className="btn-primary w-full">
          <Icon name="plus" size={16} /> New chat
        </button>
      </div>

      {/* Sessions */}
      <div className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-faint">
        Sessions
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {sessions.length === 0 && (
          <p className="px-2 py-3 text-xs text-content-faint">No sessions yet.</p>
        )}
        {sessions.map((s) => {
          const active = activeId === s.id;
          return (
            <div
              key={s.id}
              onClick={() => openSession(s.id)}
              className={`group relative flex items-center gap-2 rounded-lg px-2.5 py-2 cursor-pointer transition ${
                active ? "bg-surface-3" : "hover:bg-surface-2"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-gradient-to-b from-accent to-cyan" />
              )}
              <Icon
                name={s.connection_id ? "server" : "cpu"}
                size={15}
                className={active ? "text-accent" : "text-content-faint"}
              />
              <span className="flex-1 truncate text-[13px] text-content/90">{s.title}</span>
              <span className="pill bg-surface text-content-faint opacity-70">{s.provider}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  remove(s.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-content-faint hover:text-danger transition"
                title="Delete"
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 h-12 border-t border-border/70 text-content-faint">
        <div className="grid place-items-center w-6 h-6 rounded-full bg-surface-3 text-[11px] font-semibold text-content-dim">
          A
        </div>
        <span className="text-xs">admin</span>
        <span className="ml-auto text-[10px]">v{APP_VERSION}</span>
        <button onClick={logout} className="text-content-faint hover:text-danger transition" title="Log out">
          <Icon name="logout" size={15} />
        </button>
      </div>
    </aside>
  );
}
