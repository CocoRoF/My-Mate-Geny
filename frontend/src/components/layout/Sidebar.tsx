import { signOutHere } from "../../lib/authNavigation";
import { providersNeedAttention, sessionsNeedAttention } from "../../lib/attention";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { openSettings, useUIStore, type View } from "../../stores/uiStore";
import { useProviderStore } from "../../stores/providerStore";
import { useChatStore } from "../../stores/chatStore";
import { requestResync } from "../../lib/sync";
import { useNativeVersion } from "../../lib/nativeVersion";
import { APP_VERSION } from "../../version";
import Icon, { type IconName } from "../ui/Icon";
import { useAuthStatus } from "../admin/useAuthStatus";
import { useT, type MsgKey } from "../../i18n";
import { sessionBadge, unseenCount } from "../../lib/sessionStatus";

// Mate and Chat; everything else (Providers, Connections, Usage, Admin, Download…) is a Settings tab, below
// a finished run's badge, until the chat is opened (lib/sessionStatus.ts)
const RESULT: Record<"ok" | "error" | "stopped", { label: MsgKey; title: MsgKey; icon: IconName; cls: string }> = {
  ok: { label: "nav.resultOk", title: "nav.resultOkTitle", icon: "check", cls: "bg-success/15 text-success" },
  error: { label: "nav.resultError", title: "nav.resultErrorTitle", icon: "warning", cls: "bg-danger/15 text-danger" },
  stopped: { label: "nav.resultStopped", title: "nav.resultStoppedTitle", icon: "stop", cls: "bg-surface-3 text-content-dim" },
};

const NAV: { id: View; label: MsgKey; icon: IconName }[] = [
  { id: "mate", label: "nav.mate", icon: "sparkles" },
  { id: "chat", label: "nav.chat", icon: "chat" },
];

// A narrow window (the desktop app, a browser beside something else) has the sidebar as a rail of icons; the user's own
// choice (the toggle) wins and is remembered (uiStore → localStorage). Never the phone's drawer.
const NARROW = "(max-width: 1099px)";
const narrowNow = () => typeof window !== "undefined" && !!window.matchMedia?.(NARROW).matches;
function useSidebarRail(): [boolean, () => void] {
  const narrow = useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia?.(NARROW);
      mq?.addEventListener?.("change", cb);
      return () => mq?.removeEventListener?.("change", cb);
    },
    narrowNow,
    () => false,
  );
  const pref = useUIStore((s) => s.sidebarPref);
  const setPref = useUIStore((s) => s.setSidebarPref);
  const rail = pref ? pref === "rail" : narrow;
  // (back to what this width does by itself: nothing to remember)
  const toggle = () => setPref(!rail === narrow ? null : rail ? "full" : "rail");
  return [rail, toggle];
}

const RAIL_BTN =
  "relative grid h-10 w-10 shrink-0 place-items-center rounded-lg text-content-faint transition hover:bg-surface-2 hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70 data-[active=true]:bg-surface-3 data-[active=true]:text-accent";

/** `collapsible`: the sidebar beside the screen, which can be a rail (not the phone's drawer) */
export default function Sidebar({ collapsible = false }: { collapsible?: boolean }) {
  const nativeVersion=useNativeVersion();
  const t = useT();
  const view = useUIStore((s) => s.view);
  const setView = useUIStore((s) => s.setView);
  const auth = useAuthStatus();
  // (Local execution: the person's own name, changed in Settings → Account — no sign-in name or password there)
  const user = (auth?.local ? auth.display_name : "") || auth?.username || "";
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setActive = useSessionStore((s) => s.setActive);
  const remove = useSessionStore((s) => s.remove);
  const updateSession = useSessionStore((s) => s.update);
  const patchLocal = useSessionStore((s) => s.patchLocal);
  const copy = useSessionStore((s) => s.copy);
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
  // The chat on screen shows no result (opening it is seeing it); the rest: Complete / Failed / Stopped until opened
  const onScreen = view === "chat";
  const onScreenId = onScreen ? activeId : null;
  const unseen = unseenCount(filtered, onScreenId);
  const [onlyUnseen, setOnlyUnseen] = useState(false);
  const filterUnseen = onlyUnseen && unseen > 0;
  const shown = filterUnseen
    ? filtered.filter((s) => {
        const b = sessionBadge(s, s.id === onScreenId);
        return b !== null && b !== "working";
      })
    : filtered;

  // History loading + live attach is owned by useChatSocket (ChatView); its socket tells the server the chat is on
  // screen, which marks its result seen on every device. Here: at once, so the badge doesn't wait for that.
  const openSession = (id: string) => {
    if (sessions.find((x) => x.id === id)?.result_unseen) patchLocal(id, { result_unseen: false });
    setActive(id);
    setView("chat"); // also closes the mobile drawer
  };

  const newChat = () => {
    setActive(null);
    reset();
    setView("chat");
  };

  const needsProvider = providersNeedAttention(providers);
  const needsSession = sessionsNeedAttention(providers); // an account's login needs a sign-in

  // The list follows server-pushed changes (useSessionSync); this is the
  // manual "make sure": reload the list + providers and resync the open chat.
  const loadSessions = useSessionStore((s) => s.load);
  const loadProviders = useProviderStore((s) => s.load);
  const [refreshing, setRefreshing] = useState(false);
  const [railed, toggleRail] = useSidebarRail();
  const rail = collapsible && railed;
  // (the toggle is another button once flipped: the keyboard's focus moves on to it)
  const flipRail = (e: React.MouseEvent<HTMLButtonElement>) => {
    const focused = document.activeElement === e.currentTarget;
    toggleRail();
    if (focused) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="sidebar-toggle"]')?.focus());
  };
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

  const attention = needsProvider || needsSession;
  const attentionText = t(needsProvider ? "nav.providersNone" : "nav.sessionsNeedLogin");
  const initial = (user || "?").slice(0, 1).toUpperCase();

  if (rail)
    return (
      <aside className="flex h-full w-[60px] shrink-0 flex-col items-center gap-1 border-r border-border bg-surface/80 pb-2 pt-safe backdrop-blur-xl" data-testid="sidebar" data-rail="true">
        <div className="grid h-14 shrink-0 place-items-center">
          <img src="/logo.png" alt="" width={32} height={32} className="h-8 w-8 select-none drop-shadow" draggable={false} />
        </div>
        <button onClick={flipRail} className={RAIL_BTN} title={t("nav.expandSidebar")} aria-label={t("nav.expandSidebar")} aria-expanded={false} data-testid="sidebar-toggle">
          <Icon name="panel-open" size={17} />
        </button>
        <button onClick={newChat} className="btn-primary my-1 h-10 w-10 !p-0" title={t("nav.newChat")} aria-label={t("nav.newChat")} data-testid="rail-new-chat">
          <Icon name="plus" size={17} />
        </button>
        <nav className="flex flex-col items-center gap-1">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setView(n.id)} data-active={view === n.id} className={RAIL_BTN} title={t(n.label)} aria-label={t(n.label)} aria-current={view === n.id ? "page" : undefined}>
              <Icon name={n.icon} size={17} />
              {n.id === "chat" && unseen > 0 && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-success ring-2 ring-surface" title={t("nav.unseenCount", { count: unseen })} data-testid="rail-unseen" />
              )}
            </button>
          ))}
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => openSettings(null)}
          data-active={view === "settings"}
          data-testid="nav-settings"
          className={RAIL_BTN}
          title={attention ? `${t("nav.settings")} — ${attentionText}` : t("nav.settings")}
          aria-label={t("nav.settings")}
          aria-current={view === "settings" ? "page" : undefined}
        >
          <Icon name="settings" size={17} />
          {attention && (
            <span className="absolute right-1 top-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-warning text-[9px] font-bold text-stage-ink" aria-label={attentionText} data-testid="nav-settings-badge">
              !
            </span>
          )}
        </button>
        <div className="my-1 h-px w-8 bg-border/70" />
        {auth?.local ? (
          <button
            type="button"
            onClick={() => openSettings("account")}
            className="grid h-8 w-8 place-items-center rounded-full bg-surface-3 text-[12px] font-semibold text-content-dim transition hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70"
            title={`${user} — ${t("nav.editName")}`}
            aria-label={t("nav.editName")}
            data-testid="nav-local-name"
          >
            {initial}
          </button>
        ) : (
          <span className="grid h-8 w-8 place-items-center rounded-full bg-surface-3 text-[12px] font-semibold text-content-dim" title={t("nav.signedInAs", { user })}>
            {initial}
          </span>
        )}
        <button data-testid="nav-signout" onClick={signOutHere} className={`${RAIL_BTN} hover:!text-danger`} title={t("nav.logOut")} aria-label={t("nav.logOut")}>
          <Icon name="logout" size={16} />
        </button>
      </aside>
    );

  return (
    <aside className="w-full md:w-[268px] [@media(max-height:500px)]:!w-full h-full shrink-0 flex flex-col border-r border-border bg-surface md:bg-surface/80 [@media(max-height:500px)]:!bg-surface backdrop-blur-xl pt-safe pb-safe">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-14">
        <img src="/logo.png" alt="" width={36} height={36} className="w-9 h-9 shrink-0 select-none drop-shadow" draggable={false} />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">
            My Mate <span className="text-gradient">Geny</span>
          </div>
          <div className="text-[10px] text-content-faint">{t("nav.tagline")}</div>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          title={t("nav.refreshTitle")}
          aria-label={t("common.refresh")}
          className="ml-auto grid place-items-center w-8 h-8 touch:w-10 touch:h-10 rounded-lg text-content-faint transition hover:text-content hover:bg-surface-2 disabled:opacity-70"
        >
          <Icon name="refresh" size={15} spin={refreshing} />
        </button>
        {collapsible && (
          <button
            onClick={flipRail}
            title={t("nav.collapseSidebar")}
            aria-label={t("nav.collapseSidebar")}
            aria-expanded
            className="-ml-1.5 grid h-8 w-8 touch:h-10 touch:w-10 place-items-center rounded-lg text-content-faint transition hover:bg-surface-2 hover:text-content"
            data-testid="sidebar-toggle"
          >
            <Icon name="panel-close" size={16} />
          </button>
        )}
      </div>

      {/* New chat */}
      <div className="px-3 pb-2">
        <button onClick={newChat} className="btn-primary w-full">
          <Icon name="plus" size={16} /> {t("nav.newChat")}
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
            {t(n.label)}
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
            placeholder={t("nav.searchSessions")}
            className="w-full bg-transparent text-[13px] text-content placeholder:text-content-faint outline-none"
          />
        </div>
      </div>

      {/* Sessions section (+ how many finished unseen: a filter for them) */}
      <div className="flex items-center gap-2 px-3 pb-1 touch:py-1">
        <button
          onClick={() => setShowSessions((v) => !v)}
          aria-expanded={showSessions}
          className="flex items-center gap-1.5 touch:py-1 text-[10px] font-semibold uppercase tracking-wider text-content-faint hover:text-content-dim"
        >
          <Icon name={showSessions ? "chevron-down" : "chevron"} size={12} />
          {t("nav.sessions")}
          <span className="ml-1 text-content-faint/70 light:text-content-faint">{filtered.length}</span>
        </button>
        {unseen > 0 && (
          <button
            onClick={() => {
              setOnlyUnseen((v) => !v);
              setShowSessions(true);
            }}
            aria-pressed={filterUnseen}
            title={filterUnseen ? t("nav.unseenShowAll") : t("nav.unseenOnly")}
            data-testid="sessions-unseen"
            className={`ml-auto pill !py-0.5 text-[10.5px] font-medium transition ${
              filterUnseen ? "bg-success text-white" : "bg-success/15 text-success hover:bg-success/25"
            }`}
          >
            <Icon name="check" size={10} /> {t("nav.unseenCount", { count: unseen })}
          </button>
        )}
      </div>

      {showSessions && (
        <div className="scrollbar-stable flex-1 overflow-y-auto px-2 pb-2 space-y-0.5" onMouseLeave={() => setMenuId(null)}>
          {filtered.length === 0 && (
            <p className="px-2 py-3 text-xs text-content-faint">
              {sessions.length === 0 ? t("nav.noSessions") : t("common.noMatches")}
            </p>
          )}
          {shown.map((s) => {
            const active = activeId === s.id;
            const badge = sessionBadge(s, active && onScreen);
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
                      aria-label={t("nav.chatName")}
                      className="w-full rounded-md border border-accent/50 bg-surface px-1.5 py-0.5 text-[13px] text-content outline-none"
                    />
                  ) : (
                    <div
                      className="truncate text-[13px] text-content/90"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(s.id, s.title);
                      }}
                      title={t("nav.doubleClickRename")}
                    >
                      {s.title}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 truncate text-[10.5px] text-content-faint">
                    {badge && badge !== "working" && (
                      <span
                        className={`pill shrink-0 !px-1.5 !py-0 text-[10px] font-semibold ${RESULT[badge].cls}`}
                        title={t(RESULT[badge].title)}
                        data-testid="session-result"
                        data-result={badge}
                      >
                        <Icon name={RESULT[badge].icon} size={10} /> {t(RESULT[badge].label)}
                      </span>
                    )}
                    {badge === "working" && (
                      <span
                        className="inline-flex items-center gap-1 text-accent"
                        title={
                          s.running ? t("nav.agentWorking") : t("nav.bgTasksRunning", { count: s.background ?? 0 })
                        }
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" /> {t("nav.working")}
                        {!s.running && <span className="text-accent/70 light:text-accent">({t("nav.bgShort", { n: s.background ?? 0 })})</span>} ·
                      </span>
                    )}
                    {s.connection_id ? t("nav.remote") : t("nav.local")} · {s.provider}
                    {s.mode === "plan" && ` · ${t("nav.plan")}`}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuId(menuId === s.id ? null : s.id);
                  }}
                  aria-label={t("nav.chatActions")}
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
                      <Icon name="pencil" size={14} /> {t("common.rename")}
                    </button>
                    <button
                      onClick={() => {
                        setMenuId(null);
                        copy(s.id).catch((e: Error) => window.alert(t("nav.copyFailed", { error: e.message })));
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 touch:py-3 text-[13px] text-content-dim hover:bg-surface-3 hover:text-content"
                      data-testid="session-copy"
                    >
                      <Icon name="copy" size={14} /> {t("nav.copyChat")}
                    </button>
                    <button
                      onClick={() => {
                        remove(s.id);
                        setMenuId(null);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 touch:py-3 text-[13px] text-danger hover:bg-surface-3"
                    >
                      <Icon name="trash" size={14} /> {t("common.delete")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!showSessions && <div className="flex-1" />}

      <button className="mx-3 mb-2 rounded-lg px-3 py-2 text-left text-xs text-content-faint hover:bg-surface-2" onClick={()=>window.dispatchEvent(new Event("geny:setup"))}>{t("setup.title")}</button>
      {/* Settings: always at the bottom, right above the account row */}
      <div className="px-2 pb-1.5 pt-1.5 border-t border-border/60">
        <button
          onClick={() => openSettings(null)}
          data-active={view === "settings"}
          data-testid="nav-settings"
          className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 touch:py-2.5 text-[13px] font-medium text-content-dim transition hover:text-content hover:bg-surface-2 data-[active=true]:bg-surface-3 data-[active=true]:text-content"
        >
          <Icon name="settings" size={16} className="text-content-faint group-hover:text-content-dim group-data-[active=true]:text-accent" />
          {t("nav.settings")}
          {/* only what needs the user (lib/attention.ts) — never a plain count */}
          {attention && (
            <span className="ml-auto pill bg-warning/15 text-warning" title={attentionText} aria-label={attentionText} data-testid="nav-settings-badge">
              !
            </span>
          )}
        </button>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 h-12 border-t border-border/70 text-content-faint">
        <div className="grid place-items-center w-6 h-6 rounded-full bg-surface-3 text-[11px] font-semibold text-content-dim">
          {initial}
        </div>
        {auth?.local ? (
          <button type="button" onClick={() => openSettings("account")} className="min-w-0 truncate text-xs hover:text-content" title={t("nav.editName")} data-testid="nav-local-name">
            {user}
          </button>
        ) : (
          <span className="min-w-0 truncate text-xs" title={t("nav.signedInAs", { user })}>{user}</span>
        )}
        <span className="ml-auto text-[10px]">v{nativeVersion||APP_VERSION}</span>
        <button data-testid="nav-signout" onClick={signOutHere} className="rounded-md p-1 touch:p-2.5 touch:-mr-1.5 hover:text-danger hover:bg-surface-3 transition" title={t("nav.logOut")} aria-label={t("nav.logOut")}>
          <Icon name="logout" size={15} />
        </button>
      </div>
    </aside>
  );
}
