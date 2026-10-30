import { lazy, Suspense, useEffect } from "react";
import Sidebar from "./components/layout/Sidebar";
import ChatView from "./components/chat/ChatView";
import MobileTopBar from "./components/layout/MobileTopBar";
import UpdateBanner from "./components/layout/UpdateBanner";
import { useBackHandler } from "./lib/back";
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

  // Deep link: /?view=downloads (desktop menu, update banners).
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("view");
    if (v && ["chat", "providers", "connections", "usage", "admin", "downloads"].includes(v)) {
      useUIStore.getState().setView(v as any);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    loadProviders();
    loadConnections();
    loadSessions();
    loadConfig();
  }, [loadProviders, loadConnections, loadSessions, loadConfig]);

  const titles: Record<string, string> = {
    chat: "New chat", providers: "Providers", connections: "Connections", usage: "Usage", admin: "Admin", downloads: "Download",
  };

  return (
    <div className="h-[100dvh] flex overflow-hidden text-content">
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
        {/* chat with an open session has its own header */}
        {!(view === "chat" && activeId) && <MobileTopBar title={titles[view] || ""} />}
        <div className="flex-1 min-h-0">
          <Suspense fallback={<div className="grid h-full place-items-center text-sm text-content-faint">Loading…</div>}>
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
