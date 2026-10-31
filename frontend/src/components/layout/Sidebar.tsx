import { useMemo, useState } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useUIStore, type View } from "../../stores/uiStore";
import { useProviderStore } from "../../stores/providerStore";
import { useChatStore } from "../../stores/chatStore";
import { apiFetch } from "../../api/client";
import { requestResync } from "../../lib/sync";
import { APP_VERSION } from "../../version";
import Icon, { type IconName } from "../ui/Icon";
import { useAuthStatus } from "../admin/useAuthStatus";

const NAV: { id: View; label: string; icon: IconName }[] = [
  { id: "mate", label: "Mate", icon: "sparkles" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "providers", label: "Providers", icon: "plug" },
  { id: "connections", label: "Connections", icon: "server" },
  { id: "usage", label: "Usage", icon: "cpu" },
  { id: "admin", label: "Admin", icon: "shield" },
  { id: "downloads", label: "Download", icon: "download" },
];

export default function Sidebar() {
  const view = useUIStore((s) => s.view);
  const setView = useUIStore((s) => s.setView);
  const user = useAuthStatus()?.username ?? "";
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setActive = useSessionStore((s) => s.setActive);
  const remove = useSessionStore((s) => s.remove);
  const updateSession = useSessionStore((s) => s.update);
  const providers = useProviderStore((s) => s.providers);
  const reset = useChatStore((s) => s.reset);

  const [query, setQuery] = useState("");
  const [showSessions, setShowSessions] = useState(true);
  const [menuId, setMenuId] = useState<string | null>(null);
  // Inline rename: the row's title becomes a field (Enter / blur saves, Esc cancels).
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const startRename = (id: string, title: string) => {
    setMenuId(null);
    setRenaming({ id, title });
  };
  const saveRename = () => {
    const r = renaming;
    setRenaming(null);
    if (!r) return;
    const title = r.title.trim();
    const cur = sessions.find((x) => x.id === r.id);
    if (title && cur && title !== cur.title) updateSession(r.id, { title }).catch(() => {});
  };

  const filtered = useMemo(
    () => sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase())),
    [sessions, query],
  );

  // History loading + live attach is owned by useChatSocket (ChatView).
  const openSession = (id: string) => {
    setActive(id);
    setView("chat"); // also closes the mobile drawer
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

  // The list follows server-pushed changes (useSessionSync); this is the
  // manual "make sure": reload the list + providers and resync the open chat.
  const loadSessions = useSessionStore((s) => s.load);
  const loadProviders = useProviderStore((s) => s.load);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    requestResync();
    try {
      await Promise.all([loadSessions(), loadProviders()]);
    } catch {
      /* the next push / refresh retries */
    } finally {
      setTimeout(() => setRefreshing(false), 400); // let the spin read as feedback
    }
  };

  return (
    <aside className="w-full md:w-[268px] h-full shrink-0 flex flex-col border-r border-border bg-surface md:bg-surface/80 backdrop-blur-xl pt-safe pb-safe">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-14">
        <img src="/logo.png" alt="" width={36} height={36} className="w-9 h-9 shrink-0 select-none drop-shadow" draggable={false} />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">
            My Mate <span className="text-gradient">Geny</span>
          </div>
          <div className="text-[10px] text-content-faint">your mate + agent console</div>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          title="Refresh — reload chats and resync this one"
          aria-label="Refresh"
          className="ml-auto grid place-items-center w-8 h-8 touch:w-10 touch:h-10 rounded-lg text-content-faint transition hover:text-content hover:bg-surface-2 disabled:opacity-70"
        >
          <Icon name="refresh" size={15} spin={refreshing} />
        </button>
      </div>

      {/* New chat */}
      <div className="px-3 pb-2">
        <button onClick={newChat} className="btn-primary w-full">
          <Icon name="plus" size={16} /> New chat
        </button>
      </div>

      {/* Nav */}
      <nav className="px-2 space-y-0.5">
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setView(n.id)}
            data-active={view === n.id}
            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 touch:py-2.5 text-[13px] font-medium text-content-dim transition hover:text-content hover:bg-surface-2 data-[active=true]:bg-surface-3 data-[active=true]:text-content"
          >
            <Icon
              name={n.icon}
              size={16}
              className="text-content-faint group-hover:text-content-dim group-data-[active=true]:text-accent"
            />
            {n.label}
            {n.id === "providers" && connectedCount > 0 && (
              <span className="ml-auto pill bg-success/15 text-success">{connectedCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="mx-3 my-3 border-t border-border/60" />

      {/* Session search */}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 touch:py-2">
          <Icon name="search" size={14} className="text-content-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions"
            className="w-full bg-transparent text-[13px] text-content placeholder:text-content-faint outline-none"
          />
        </div>
      </div>

      {/* Sessions section */}
      <button
        onClick={() => setShowSessions((v) => !v)}
        className="flex items-center gap-1.5 px-3 pb-1 touch:py-2 text-[10px] font-semibold uppercase tracking-wider text-content-faint hover:text-content-dim"
      >
        <Icon name={showSessions ? "chevron-down" : "chevron"} size={12} />
        Sessions
        <span className="ml-1 text-content-faint/70">{filtered.length}</span>
      </button>

      {showSessions && (
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5" onMouseLeave={() => setMenuId(null)}>
          {filtered.length === 0 && (
            <p className="px-2 py-3 text-xs text-content-faint">
              {sessions.length === 0 ? "No sessions yet." : "No matches."}
            </p>
          )}
          {filtered.map((s) => {
            const active = activeId === s.id;
            return (
              <div
                key={s.id}
                onClick={() => openSession(s.id)}
                className={`group relative flex items-center rounded-lg pl-3 pr-1.5 py-2 touch:py-1 cursor-pointer transition ${
                  active ? "bg-surface-3" : "hover:bg-surface-2"
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-2 bottom-2 w-[2.5px] rounded-full bg-gradient-to-b from-accent to-cyan" />
                )}
                <div className="min-w-0 flex-1">
                  {renaming?.id === s.id ? (
                    <input
                      autoFocus
                      value={renaming.title}
                      maxLength={200}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME (Korean…)
                        if (e.key === "Enter") {
                          e.preventDefault();
                          saveRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setRenaming(null);
                        }
                      }}
                      onBlur={saveRename}
                      aria-label="Chat name"
                      className="w-full rounded-md border border-accent/50 bg-surface px-1.5 py-0.5 text-[13px] text-content outline-none"
                    />
                  ) : (
                    <div
                      className="truncate text-[13px] text-content/90"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(s.id, s.title);
                      }}
                      title="Double-click to rename"
                    >
                      {s.title}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 truncate text-[10.5px] text-content-faint">
                    {(s.running || (s.background ?? 0) > 0) && (
                      <span
                        className="inline-flex items-center gap-1 text-accent"
                        title={
                          s.running
                            ? "Agent is working"
                            : `${s.background} background task${s.background === 1 ? "" : "s"} running (subagents / background commands)`
                        }
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" /> working
                        {!s.running && <span className="text-accent/70">({s.background} bg)</span>} ·
                      </span>
                    )}
                    {s.connection_id ? "remote" : "local"} · {s.provider}
                    {s.mode === "plan" && " · plan"}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuId(menuId === s.id ? null : s.id);
                  }}
                  className="md:can-hover:opacity-0 group-hover:opacity-100 rounded-md p-1.5 md:can-hover:p-1 touch:p-3 text-content-faint hover:text-content hover:bg-surface-3 transition"
                >
                  <Icon name="more" size={15} />
                </button>
                {menuId === s.id && (
                  <div
                    className="absolute right-2 top-9 touch:top-12 z-20 w-32 overflow-hidden rounded-lg border border-border bg-surface-2 shadow-float animate-fade-in"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => startRename(s.id, s.title)}
                      className="flex w-full items-center gap-2 px-3 py-2 touch:py-3 text-[13px] text-content-dim hover:bg-surface-3 hover:text-content"
                    >
                      <Icon name="pencil" size={14} /> Rename
                    </button>
                    <button
                      onClick={() => {
                        remove(s.id);
                        setMenuId(null);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 touch:py-3 text-[13px] text-danger hover:bg-surface-3"
                    >
                      <Icon name="trash" size={14} /> Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!showSessions && <div className="flex-1" />}

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 h-12 border-t border-border/70 text-content-faint">
        <div className="grid place-items-center w-6 h-6 rounded-full bg-surface-3 text-[11px] font-semibold text-content-dim">
          {(user || "?").slice(0, 1).toUpperCase()}
        </div>
        <span className="min-w-0 truncate text-xs" title="Signed in as">{user}</span>
        <span className="ml-auto text-[10px]">v{APP_VERSION}</span>
        <button onClick={logout} className="rounded-md p-1 touch:p-2.5 touch:-mr-1.5 hover:text-danger hover:bg-surface-3 transition" title="Log out">
          <Icon name="logout" size={15} />
        </button>
      </div>
    </aside>
  );
}
