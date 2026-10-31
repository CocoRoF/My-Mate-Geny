import { lazy, Suspense, useEffect } from "react";
import Sidebar from "./components/layout/Sidebar";
import ChatView from "./components/chat/ChatView";
import MobileTopBar from "./components/layout/MobileTopBar";
import UpdateBanner from "./components/layout/UpdateBanner";
import DefaultPasswordBanner from "./components/admin/DefaultPasswordBanner";
import { useBackHandler } from "./lib/back";
import { useSessionSync } from "./hooks/useSessionSync";
import { useUIStore } from "./stores/uiStore";
import { useProviderStore } from "./stores/providerStore";
import { useConnectionStore } from "./stores/connectionStore";
import { useSessionStore } from "./stores/sessionStore";
import { useConfigStore } from "./stores/configStore";

// Secondary views load on demand: the chat (first screen) stays light.
const ProvidersView = lazy(() => import("./components/providers/ProvidersView"));
const ConnectionsView = lazy(() => import("./components/connections/ConnectionsView"));
const UsageView = lazy(() => import("./components/usage/UsageView"));
const AdminView = lazy(() => import("./components/admin/AdminView"));
const DownloadsView = lazy(() => import("./components/downloads/DownloadsView"));
const MateView = lazy(() => import("./components/mate/MateView"));

export default function App() {
  const view = useUIStore((s) => s.view);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebar = useUIStore((s) => s.setSidebar);
  const activeId = useSessionStore((s) => s.activeId);
  const setView = useUIStore((s) => s.setView);
  // Android back: close the drawer, else return to the chat view.
  useBackHandler(view !== "chat", () => setView("chat"));
  useBackHandler(sidebarOpen, () => setSidebar(false));
  const loadProviders = useProviderStore((s) => s.load);
  const loadConnections = useConnectionStore((s) => s.load);
  const loadSessions = useSessionStore((s) => s.load);
  const loadConfig = useConfigStore((s) => s.load);
  useSessionSync(); // every device's session list follows server-pushed changes

  // Deep link: /?view=downloads (desktop menu, update banners), /?view=mate,
  // /?view=chat&session=<id> (a mate's activity chip opened from a desktop window).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const v = q.get("view");
    const sid = q.get("session");
    if (sid) useSessionStore.getState().setActive(sid);
    if (v && ["mate", "chat", "providers", "connections", "usage", "admin", "downloads"].includes(v)) {
      useUIStore.getState().setView(v as any);
    } else if (sid) useUIStore.getState().setView("chat");
    if (v || sid) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  useEffect(() => {
    loadProviders();
    loadConnections();
    loadSessions();
    loadConfig();
  }, [loadProviders, loadConnections, loadSessions, loadConfig]);

  const titles: Record<string, string> = {
    mate: "Mate",
    chat: "New chat", providers: "Providers", connections: "Connections", usage: "Usage", admin: "Admin", downloads: "Download",
  };

  return (
    // the visible height: 100dvh, or what the keyboard leaves where the layout viewport doesn't shrink (lib/keyboard.ts)
    <div className="h-[var(--app-h,100dvh)] flex overflow-hidden text-content">
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-[60] flex">
          <div className="absolute inset-0 bg-black/55 animate-fade-in" onClick={() => setSidebar(false)} />
          <div className="relative h-full w-[min(86vw,300px)] shadow-float animate-fade-in">
            <Sidebar />
          </div>
        </div>
      )}
      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <UpdateBanner />
        <DefaultPasswordBanner />
        {/* chat with an open session has its own header */}
        {/* chat with an open session and the Mate have their own header */}
        {!(view === "chat" && activeId) && view !== "mate" && <MobileTopBar title={titles[view] || ""} />}
        <div className="flex-1 min-h-0">
          <Suspense fallback={<div className="grid h-full place-items-center text-sm text-content-faint">Loading…</div>}>
          {view === "mate" && <MateView />}
          {view === "chat" && <ChatView />}
          {view === "providers" && <ProvidersView />}
          {view === "connections" && <ConnectionsView />}
          {view === "usage" && <UsageView />}
          {view === "admin" && <AdminView />}
          {view === "downloads" && <DownloadsView />}
          </Suspense>
        </div>
      </main>
    </div>
  );
}
